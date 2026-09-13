/**
 * Verified AI spend — the basis rewards are paid on.
 *
 * The brief fixes this: an account's weight follows CONFIRMED model spend by its
 * subagents. Not records written, not agents created, not $OFFCUT held. A
 * hundred idle agents earn nothing.
 *
 * Why this metric and not the one that was here before (memory another agent
 * retrieved): everything inside this product is free to produce. An agent is a
 * row; a record is a row; a retrieval is a query. No formula over free actions
 * survives someone willing to write a script. Model spend is the first quantity
 * in the system that costs the person doing it real money — so farming it costs
 * more than it pays, by construction rather than by vigilance.
 *
 * Two rules the brief states and this file enforces:
 *
 *   One request is counted once. The provider's own id for a request is a
 *   unique key, so a replayed report writes nothing.
 *
 *   Spend is confirmed, never claimed. An agent reports a generation id; the
 *   provider is asked what it actually cost. Only the provider's answer pays.
 *   A report that cannot be confirmed earns zero and says why.
 *
 * And one the brief is careful about, which the console repeats: this rewards
 * usage, it does not reimburse it. Nothing here promises that spend comes back.
 */

import type { Db } from './db';
import { errors } from './errors';
import { inTransaction, isUniqueViolation } from './store';
import type { AccessContext } from './access';
import type { CreditWindow, EarnedByWorkspace } from './credits';

/** Providers whose spend we can actually confirm. */
export const SUPPORTED_USAGE_PROVIDERS = ['openrouter'] as const;
export type UsageProvider = (typeof SUPPORTED_USAGE_PROVIDERS)[number];

export type UsageStatus = 'pending' | 'verified' | 'rejected';

export interface UsageReport {
  /** The provider's id for one request. */
  generationId: string;
  provider?: UsageProvider;
  /** What the agent believes it spent. Kept for comparison; never paid on. */
  reportedTokens?: number;
  reportedCostMicros?: number;
  model?: string;
}

export interface ReportUsageResult {
  accepted: number;
  /**
   * Ids that are counted already — on file before this call, or earlier in this
   * same batch. It means settled, not retry: a caller told this never sends the
   * id again, so nothing that has yet to be written may be named here.
   */
  duplicates: string[];
  rejected: { generationId: string; reason: string }[];
}

/** What a provider adapter must answer. Nothing else is trusted. */
export interface VerifiedUsage {
  generationId: string;
  totalTokens: number;
  /** Integer millionths of a dollar. Floats never touch a payable amount. */
  costMicros: number;
}

export interface UsageVerifier {
  provider: UsageProvider;
  /**
   * Asks the provider about one request.
   *
   * Returning null means "this provider does not recognise it" — a rejection.
   * Throwing means "I could not ask" — the report stays pending and is retried,
   * because an outage must not destroy someone's earnings.
   */
  verify(generationId: string): Promise<VerifiedUsage | null>;
}

/**
 * Where a verifier comes from for one workspace.
 *
 * Needed because the credential is per workspace, not per server — see the note
 * on verifyPendingUsage. Returning null means this workspace has nothing to ask
 * with yet; its rows wait rather than being rejected.
 */
export interface UsageVerifierSource {
  provider: UsageProvider;
  forWorkspace(workspaceId: string): Promise<UsageVerifier | null>;
}

const GENERATION_ID = /^[\w:.-]{6,200}$/;

/**
 * An agent's own figure, made storable.
 *
 * Non-negative, because a negative "spend" would subtract from a comparison
 * that exists to catch inflation. Bounded, because these columns are a 32-bit
 * integer on PostgreSQL and a bigger number is refused by the driver rather
 * than truncated — one absurd report would fail the insert for every other
 * report travelling with it, and the caller would be told they were duplicates.
 * Nothing is lost by the ceiling: this figure is kept for comparison and is
 * never paid on, and a claim that large is already only evidence of a claim.
 */
function countable(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(2_147_483_647, Math.max(0, Math.trunc(value as number)));
}

/**
 * Records what an agent says it spent.
 *
 * Nothing here is payable yet. Reports land as `pending` and earn only once a
 * provider confirms them, which is the entire point: an agent that could make
 * itself rich by reporting large numbers would make the metric worthless.
 */
export async function reportUsage(
  db: Db,
  context: AccessContext,
  reports: UsageReport[]
): Promise<ReportUsageResult> {
  if (context.principal.kind !== 'agent') {
    // Only a connected subagent spends model tokens on a task. A human in the
    // console is not the thing being measured.
    throw errors.accessDenied('report model usage');
  }

  if (reports.length === 0) return { accepted: 0, duplicates: [], rejected: [] };
  if (reports.length > 200) {
    throw errors.validation('At most 200 usage reports may be submitted at once.');
  }

  const agentId = context.principal.agentId;
  const result: ReportUsageResult = { accepted: 0, duplicates: [], rejected: [] };

  // Validate first, so one malformed id in a batch does not cost a round trip.
  const usable: { generationId: string; provider: string; report: UsageReport }[] = [];
  const seen = new Set<string>();
  for (const report of reports) {
    const generationId = report.generationId?.trim() ?? '';
    const provider = report.provider ?? 'openrouter';

    if (!GENERATION_ID.test(generationId)) {
      result.rejected.push({ generationId, reason: 'not a usable generation id' });
      continue;
    }
    if (!(SUPPORTED_USAGE_PROVIDERS as readonly string[]).includes(provider)) {
      result.rejected.push({ generationId, reason: `unsupported provider: ${provider}` });
      continue;
    }

    // Deduped against the batch itself, not only against the database below.
    // The write is one multi-row statement, so an id that collides with its own
    // batch fails every row in it — and the catch then called two hundred good
    // reports duplicates, which to an agent means counted, so it never sends
    // them again. Repeating an id in one call is the likeliest client mistake
    // there is, and it destroyed real spend silently. Keyed on the pair, for
    // the same reason the read below is.
    const key = `${provider}:${generationId}`;
    if (seen.has(key)) {
      result.duplicates.push(generationId);
      continue;
    }
    seen.add(key);

    usable.push({ generationId, provider, report });
  }

  if (usable.length === 0) return result;

  // Known ids are read first rather than discovered by failed inserts: Prisma
  // logs every rejected insert at error level before throwing, and a replayed
  // batch is the normal case, not an incident. The unique key still settles a
  // race — this only decides which path is quiet.
  //
  // Scoped by provider as well as id, because the unique key is the pair. Two
  // providers are free to hand out the same string, and matching on the id
  // alone would refuse the second one as a duplicate of a request it has
  // nothing to do with — silently, as spend that earns nothing.
  const existing = await db.modelUsage.findMany({
    where: {
      provider: { in: [...new Set(usable.map((entry) => entry.provider))] },
      generationId: { in: usable.map((entry) => entry.generationId) },
    },
    select: { id: true, provider: true, generationId: true, workspaceId: true, status: true },
  });
  const already = new Map(existing.map((row) => [`${row.provider}:${row.generationId}`, row]));

  // A row that can never become money does not own the id.
  //
  // Found by testing it: one workspace reports an id belonging to another, its
  // key does not recognise it, and the row settles as rejected — under the
  // wrong workspace. It earns the reporter nothing, so there is no theft. But
  // the id is now taken, and the workspace that really paid gets `duplicate`
  // forever. Its real spend is destroyed, permanently and without a word.
  //
  // The same loss happens with nobody to blame: link the wrong key, watch a
  // day of genuine spend settle as rejected, fix the key, and the money is
  // still gone. That one is likely rather than adversarial.
  //
  // Rejected was only half of it, and `pending` is the easier half to park in.
  // A workspace with no credential linked never has its rows fetched at all —
  // see the note on verifyPendingUsage — so they are never asked about, never
  // rejected, and therefore never releasable: an id held for the price of one
  // request and no spend whatsoever. Two workspaces sharing one key reach the
  // same dead end with nobody to blame, whenever the keyless one reports first.
  //
  // So the rule is the state both halves share: an id is released when the
  // workspace holding it cannot settle it — its key has already refused the
  // request, or it has no key to ask with. Safe in the only direction that
  // matters: a `verified` row is never released, so nothing that has been paid
  // can be claimed twice, and because only the key that paid can confirm a
  // generation, releasing can only ever return spend to whoever really made it.
  // A workspace's own row stays put, and a workspace WITH a key keeps its
  // pending rows against all comers — re-asking is what linking a key does,
  // rather than something an agent can drive in a loop, and a report that is
  // merely waiting its turn to be asked cannot be bounced out of the way.
  const keyless = new Set(
    [...already.values()]
      .filter((row) => row.status === 'pending' && row.workspaceId !== context.workspaceId)
      .map((row) => row.workspaceId)
  );

  if (keyless.size > 0) {
    // Ids only. Whether a credential exists is answerable without reading one,
    // and a ciphertext that is never loaded is one that can never leak.
    const linked = await db.workspace.findMany({
      where: { id: { in: [...keyless] }, usageKeyCipher: { not: null } },
      select: { id: true },
    });
    for (const row of linked) keyless.delete(row.id);
  }

  /** A report to write, with the stranded row it takes the id back from. */
  type Claim = (typeof usable)[number] & { replaces?: string };

  const fresh: Claim[] = [];
  for (const entry of usable) {
    const found = already.get(`${entry.provider}:${entry.generationId}`);
    if (!found) {
      fresh.push(entry);
      continue;
    }

    const stranded =
      found.status === 'rejected' || (found.status === 'pending' && keyless.has(found.workspaceId));

    if (stranded && found.workspaceId !== context.workspaceId) {
      fresh.push({ ...entry, replaces: found.id });
      continue;
    }

    result.duplicates.push(entry.generationId);
  }

  if (fresh.length === 0) return result;

  const rowFor = ({ generationId, provider, report }: Claim) => ({
    workspaceId: context.workspaceId,
    provider,
    generationId,
    reportedByAgentId: agentId,
    model: report.model?.slice(0, 120) ?? '',
    reportedTokens: countable(report.reportedTokens),
    reportedCostMicros: countable(report.reportedCostMicros),
  });

  /**
   * The release and the insert are ONE write.
   *
   * The row a release deletes belongs to ANOTHER workspace, and as two
   * statements a failed insert left that workspace's rows deleted with nothing
   * in their place — a settlement's rejectedReason destroyed, or a pending
   * report that was still owed an answer — for a call that then reported
   * `duplicate`, which to an agent means counted. Any failed insert did it, the
   * ids it deleted were the caller's to choose, and an agent key in an
   * unrelated workspace was enough to ask. Rolled back, the foreign row stays
   * exactly where it was.
   */
  const write = (claims: Claim[]) =>
    inTransaction(db, async (tx) => {
      const replaced = claims
        .map((claim) => claim.replaces)
        .filter((id): id is string => id !== undefined);

      if (replaced.length > 0) {
        // Still matched on status: a row confirmed between the read above and
        // this delete has been paid for, and a paid row is never released.
        await tx.modelUsage.deleteMany({
          where: { id: { in: replaced }, status: { in: ['pending', 'rejected'] } },
        });
      }

      await tx.modelUsage.createMany({ data: claims.map(rowFor) });
    });

  try {
    await write(fresh);
    result.accepted = fresh.length;
  } catch (error) {
    // A concurrent report claimed one of these between the read and the write.
    // The multi-row insert is all-or-nothing, so the batch is written again one
    // claim at a time — each still its own release-and-insert — rather than
    // condemned wholesale: only the id that actually collided is a duplicate,
    // and the rest is spend that really happened and that nobody else is going
    // to report.
    //
    // Only a lost race is answered that way. `duplicate` tells an agent the id
    // is on file and counted, so a store that could not be written to must not
    // borrow the word: an agent told its spend was counted never sends it
    // again, which is the loss this whole file is arranged to prevent.
    if (!isUniqueViolation(error)) throw error;

    for (const claim of fresh) {
      try {
        await write([claim]);
        result.accepted += 1;
      } catch (collision) {
        if (!isUniqueViolation(collision)) throw collision;
        result.duplicates.push(claim.generationId);
      }
    }
  }

  return result;
}

export interface VerificationRun {
  verified: number;
  rejected: number;
  /** Left pending because the provider could not be reached. Retried later. */
  deferred: number;
}

/** A single verifier for every row, as opposed to one resolved per workspace. */
function isFixedVerifier(
  candidate: UsageVerifier | UsageVerifierSource
): candidate is UsageVerifier {
  return typeof (candidate as UsageVerifier).verify === 'function';
}

/**
 * Asks the provider about everything still pending, and settles it.
 *
 * Run by the publisher before it accrues a period, so a report made moments ago
 * has a chance to become payable before the window it belongs to is closed.
 *
 * WHY THE SECOND ARGUMENT TAKES TWO SHAPES. This took one verifier for every
 * row, and that is wrong for the integration the brief actually requires:
 * OpenRouter answers about a generation only to the key that PAID for it, and
 * each workspace links its own key. One verifier for all rows would confirm one
 * workspace's spend and see every other workspace's reports come back unknown —
 * rejected, permanently, for spend that really happened. So the work is done per
 * workspace. A plain UsageVerifier is still accepted and used for every row,
 * because a single-tenant deployment has exactly one key and should not have to
 * wrap it to say so.
 *
 * The two shapes differ in one more way, deliberately. Given a source, only rows
 * whose workspace HAS a linked credential are fetched. Without that filter the
 * oldest unverifiable rows would fill every batch: a workspace that never links
 * a key would hold `take` slots forever and starve the workspaces that did.
 * Nothing is lost — those rows stay pending and are picked up by the first run
 * after their owner links a key, and reportUsage releases the id in the meantime
 * if another workspace turns out to be the one that paid for it: a row nobody
 * can ask about has to stay out of the way, not out of reach.
 */
export async function verifyPendingUsage(
  db: Db,
  verifier: UsageVerifier | UsageVerifierSource,
  options: { limit?: number } = {}
): Promise<VerificationRun> {
  const source = isFixedVerifier(verifier) ? null : verifier;

  const pending = await db.modelUsage.findMany({
    where: {
      status: 'pending',
      provider: verifier.provider,
      ...(source ? { workspace: { usageKeyCipher: { not: null } } } : {}),
    },
    orderBy: { reportedAt: 'asc' },
    take: options.limit ?? 200,
  });

  const run: VerificationRun = { verified: 0, rejected: 0, deferred: 0 };

  // Resolved once per workspace per run: a batch of two hundred rows from one
  // workspace should cost one credential lookup, and a workspace whose key
  // cannot be resolved should cost one failure rather than two hundred.
  const resolved = new Map<string, UsageVerifier | null>();

  for (const row of pending) {
    let active: UsageVerifier | null;

    if (!source) {
      active = verifier as UsageVerifier;
    } else if (resolved.has(row.workspaceId)) {
      active = resolved.get(row.workspaceId) ?? null;
    } else {
      try {
        active = await source.forWorkspace(row.workspaceId);
      } catch {
        // The credential could not be resolved — a changed OFFCUT_SECRET_KEY,
        // an edited row. Same rule as an outage: defer, never reject. A server
        // misconfiguration must not delete what somebody spent.
        active = null;
      }
      resolved.set(row.workspaceId, active);
    }

    if (!active) {
      run.deferred += 1;
      continue;
    }

    let answer: VerifiedUsage | null;
    try {
      answer = await active.verify(row.generationId);
    } catch {
      // Could not ask. Leave it pending: an outage at the provider must not
      // quietly delete what somebody actually spent.
      run.deferred += 1;
      continue;
    }

    if (!answer) {
      await db.modelUsage.update({
        where: { id: row.id },
        data: {
          status: 'rejected',
          rejectedReason: 'the provider does not recognise this request',
          verifiedAt: new Date(),
        },
      });
      run.rejected += 1;
      continue;
    }

    await db.modelUsage.update({
      where: { id: row.id },
      data: {
        status: 'verified',
        verifiedTokens: Math.max(0, Math.trunc(answer.totalTokens)),
        verifiedCostMicros: Math.max(0, Math.trunc(answer.costMicros)),
        verifiedAt: new Date(),
      },
    });
    run.verified += 1;
  }

  return run;
}

/**
 * Confirmed spend per workspace inside a window, as reward points.
 *
 * A point is one millionth of a dollar of confirmed spend. The unit is
 * arbitrary and deliberately small: it keeps the arithmetic in integers, and
 * the pool maths downstream only ever works in ratios, so the scale cancels.
 *
 * Windowed on `verifiedAt`, not on when the agent reported: a request confirmed
 * an hour late belongs to the period it was confirmed in, because the period it
 * was made in has already been paid and reopening a closed period is how a
 * ledger stops being one.
 */
export async function spendInWindow(
  db: Db,
  window: CreditWindow
): Promise<EarnedByWorkspace[]> {
  const rows = await db.modelUsage.groupBy({
    by: ['workspaceId'],
    where: {
      status: 'verified',
      verifiedAt: { gte: window.since, lt: window.until },
    },
    _sum: { verifiedCostMicros: true },
  });

  return rows
    .map((row) => ({ workspaceId: row.workspaceId, points: row._sum.verifiedCostMicros ?? 0 }))
    .filter((row) => row.points > 0);
}

/** Confirmed spend a workspace has ever had, in millionths of a dollar. */
export async function spendEver(db: Db, workspaceId: string): Promise<number> {
  const result = await db.modelUsage.aggregate({
    where: { workspaceId, status: 'verified' },
    _sum: { verifiedCostMicros: true },
  });
  return result._sum.verifiedCostMicros ?? 0;
}

/** Everything reported that is not paying, and what is keeping it from paying. */
export interface UnconfirmedUsage {
  /** Reported, nobody has answered yet. Earns nothing so far, and loses nothing. */
  pending: { requests: number; reportedMicros: number };
  /**
   * Answered for and refused. Earns nothing, ever.
   *
   * `reasons` carries the refusals that have one on file, commonest first. A
   * row whose reason is empty is counted in `requests` and absent from the
   * list: the total is a fact about the rows, while a reason invented here to
   * keep the two adding up would be this process putting words in a provider's
   * mouth. Whoever renders it accounts for the difference.
   */
  rejected: { requests: number; reasons: { reason: string; requests: number }[] };
}

/**
 * What an account reported and is not being paid for, across its workspaces.
 *
 * The companion to spendEver, and it exists for the reason the credential
 * travels beside a workspace's figure: on its own, a confirmed total cannot
 * distinguish "your agents spent nothing" from "everything they reported was
 * refused". Both are zero, they mean opposite things, and only one of them is
 * the reader's to fix.
 *
 * Every workspace at once rather than one call per workspace: the surfaces
 * above answer for a whole account, and an account with forty workspaces should
 * not cost forty round trips to be told that nothing is waiting.
 *
 * Not windowed, unlike spendInWindow. A report waits until a provider answers,
 * however long that takes, so a window would hide the oldest ones first - the
 * reports somebody is most likely to be asking about.
 */
export async function unconfirmedUsage(
  db: Db,
  workspaceIds: string[]
): Promise<UnconfirmedUsage> {
  if (workspaceIds.length === 0) {
    return { pending: { requests: 0, reportedMicros: 0 }, rejected: { requests: 0, reasons: [] } };
  }

  const where = { workspaceId: { in: workspaceIds } };

  const pending = await db.modelUsage.aggregate({
    where: { ...where, status: 'pending' },
    _count: { _all: true },
    _sum: { reportedCostMicros: true },
  });

  const rejected = await db.modelUsage.groupBy({
    by: ['rejectedReason'],
    where: { ...where, status: 'rejected' },
    _count: { _all: true },
  });

  return {
    pending: {
      requests: pending._count._all,
      // What the AGENT claimed - the one figure in this module no provider has
      // vouched for. It is reported so a reader can see what is at stake in the
      // answer, and it keeps `reported` in its name everywhere it travels so
      // that nothing downstream can mistake it for money.
      reportedMicros: pending._sum.reportedCostMicros ?? 0,
    },
    rejected: {
      requests: rejected.reduce((total, row) => total + row._count._all, 0),
      reasons: rejected
        .filter((row) => row.rejectedReason !== '')
        .map((row) => ({ reason: row.rejectedReason, requests: row._count._all }))
        // Commonest first, then alphabetical, so two databases holding the same
        // rows answer in the same order and a surface can be tested against it.
        .sort((a, b) => b.requests - a.requests || a.reason.localeCompare(b.reason)),
    },
  };
}

/** Confirmed spend for a set of workspaces, optionally narrowed to a window. */
export interface SpendByWorkspace {
  workspaceId: string;
  /** Integer millionths of a dollar. */
  micros: number;
}

/**
 * Confirmed spend for the workspaces given, in one query.
 *
 * spendEver answers for a single workspace, and the account surfaces call it in
 * a loop: an account with forty workspaces costs forty round trips to be shown
 * one total. This is the same figure asked for a whole account at once.
 *
 * `since` narrows it to a rolling window on `verifiedAt` — the same timestamp
 * spendInWindow uses, and for the same reason: a request confirmed an hour late
 * belongs to the moment it was confirmed, because that is the moment it could
 * first have been paid on. A window is therefore never a subset that can shrink
 * the total below what the ledger already settled.
 *
 * Workspaces with no confirmed spend are absent rather than zero. The caller
 * knows which workspaces it asked about and is the only one that can say
 * whether a missing row means "spent nothing" or "no key linked to ask with" —
 * a distinction this function has no way to draw and must not appear to.
 */
export async function spendByWorkspace(
  db: Db,
  workspaceIds: string[],
  options: { since?: Date } = {}
): Promise<SpendByWorkspace[]> {
  if (workspaceIds.length === 0) return [];

  const rows = await db.modelUsage.groupBy({
    by: ['workspaceId'],
    where: {
      workspaceId: { in: workspaceIds },
      status: 'verified',
      ...(options.since ? { verifiedAt: { gte: options.since } } : {}),
    },
    _sum: { verifiedCostMicros: true },
  });

  return rows
    .map((row) => ({ workspaceId: row.workspaceId, micros: row._sum.verifiedCostMicros ?? 0 }))
    .filter((row) => row.micros > 0);
}

/** What one agent has actually done, in the two quantities that are countable. */
export interface AgentActivity {
  agentId: string;
  /** Records in the store this agent is the author of. */
  records: number;
  /** Usage reports it has made, in any state — counted, waiting or refused. */
  usageReports: number;
}

/**
 * Per-agent activity across an account's workspaces.
 *
 * It lives beside the spend it half describes because the console asks about
 * both in one breath: a person connecting a second agent wants to know which of
 * their keys is doing anything, and "wrote nothing, reported nothing" is the
 * answer that tells them a key never connected. Two grouped queries rather than
 * two per agent.
 *
 * `records` counts the CURRENT, undeleted version of each record the agent
 * authored — what its work amounts to in the store today, which is the only
 * figure that matches what the same person sees when they open the workspace.
 * Superseded versions and forgotten records are not counted twice and not
 * counted at all; authorship of a version that has been edited by somebody else
 * follows the edit, because the store attributes a version to whoever wrote it.
 *
 * `usageReports` counts every row, including rejected ones, and is deliberately
 * NOT a figure about money: a refused report is still evidence that this agent
 * is wired up and reporting, which is exactly what someone checking a new
 * connection is looking for. What pays is confirmed spend, and that is counted
 * by workspace, above.
 */
export async function agentActivity(
  db: Db,
  workspaceIds: string[]
): Promise<AgentActivity[]> {
  if (workspaceIds.length === 0) return [];

  const where = { workspaceId: { in: workspaceIds } };

  const [authored, reported] = await Promise.all([
    db.memoryRecord.groupBy({
      by: ['agentId'],
      where: { ...where, isCurrent: true, deletedAt: null },
      _count: { _all: true },
    }),
    db.modelUsage.groupBy({
      by: ['reportedByAgentId'],
      where,
      _count: { _all: true },
    }),
  ]);

  const activity = new Map<string, AgentActivity>();
  const row = (agentId: string): AgentActivity => {
    const existing = activity.get(agentId);
    if (existing) return existing;
    const fresh = { agentId, records: 0, usageReports: 0 };
    activity.set(agentId, fresh);
    return fresh;
  };

  for (const group of authored) row(group.agentId).records = group._count._all;
  for (const group of reported) row(group.reportedByAgentId).usageReports = group._count._all;

  return [...activity.values()];
}
