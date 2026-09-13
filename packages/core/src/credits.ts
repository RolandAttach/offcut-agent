/**
 * Recording that someone else's memory was actually used.
 *
 * NOTE ON WHAT THIS IS NOW. This was the original basis for rewards, then it
 * was not, and since 2026-09-21 it is one of two. Rewards have two layers that
 * pay into one ledger: SPEND, confirmed model spend from usage.ts, and MEMORY,
 * the credits written below. Each layer has its own daily ceiling and its own
 * rate, and both are added into the same accrual — see accrueWindow in
 * @offcut/rewards, which reads spendInWindow and creditsInWindow side by side.
 *
 * Which is what makes this layer possible at all: everything inside this
 * product is free to produce — an agent is a row, a record is a row, a
 * retrieval is a query — so the farming defence cannot be vigilance. It is the
 * unique constraint below (a record earns ONCE, ever), the requirement that the
 * retriever be a different agent, and a ceiling an order of magnitude under the
 * spend layer's. Somebody who runs Claude Code on a subscription spends nothing
 * this service can see and earns nothing from the spend layer; what they have
 * is memory other agents use, and this is the file that counts it.
 *
 * It remains, as well, the single most honest statement this product can make
 * about whether it is working: how much of the memory a workspace produced was
 * actually used by another agent. The console shows it under that name.
 *
 * A record earns ONCE, ever — enforced by a unique constraint rather than by
 * this code, so two concurrent recalls cannot both credit it. Retrieving the
 * same record a thousand times pays for one, which is what stops a loop from
 * being a salary.
 *
 * What this deliberately does not do:
 *
 *   - It never credits a user. Only an agent retrieving another agent's record
 *     counts. An owner reading their own workspace in the console is using the
 *     product, not contributing to it.
 *   - It never throws into the caller. Recall is a memory operation and its
 *     contract is §3.4's; a rewards table being unavailable, locked, or absent
 *     must not turn a retrieval into an error. Money is downstream of memory,
 *     never the other way round.
 */

import type { AccessContext } from './access';
import type { Db } from './db';
import type { ContextResult } from './types';

/**
 * Credits every record in a recall result whose author is not the caller.
 *
 * Call after the result is built and after access filtering, so nothing is
 * credited that the caller was not allowed to see.
 */
export async function creditRetrieval(
  db: Db,
  context: AccessContext,
  result: ContextResult
): Promise<void> {
  // Only agents earn. A user is the owner of the workspace; crediting their own
  // reads would make the whole thing a loop with one participant.
  if (context.principal.kind !== 'agent') return;

  const readerId = context.principal.agentId;

  // One entry per record id, even if several items cite it.
  const candidates = new Map<string, string>();
  for (const item of result.items) {
    for (const ref of item.refs) {
      if (ref.agentId === readerId) continue;
      if (!candidates.has(ref.recordId)) candidates.set(ref.recordId, ref.agentId);
    }
  }

  if (candidates.size === 0) return;

  // Existing rows are read first, then the rest are written in one batch.
  //
  // The obvious shape — insert each and swallow the duplicate — works, but
  // Prisma prints every rejected insert at error level before it throws, so a
  // busy workspace fills the log with failures that are the normal case. A
  // read-then-write can race; the unique constraint still settles that, and a
  // race is rare enough to be worth one noisy line where the common path is
  // silent.
  const recordIds = [...candidates.keys()];

  try {
    const existing = await db.rewardCredit.findMany({
      where: { recordId: { in: recordIds } },
      select: { recordId: true },
    });
    const already = new Set(existing.map((row) => row.recordId));

    const fresh = recordIds.filter((recordId) => !already.has(recordId));
    if (fresh.length === 0) return;

    await db.rewardCredit.createMany({
      data: fresh.map((recordId) => ({
        workspaceId: context.workspaceId,
        recordId,
        authorAgentId: candidates.get(recordId)!,
        usedByAgentId: readerId,
      })),
    });
  } catch {
    // A concurrent recall won the race, or the table is unavailable. Either
    // way: see the header — a retrieval must never fail because of this.
  }
}

export interface CreditWindow {
  /** Inclusive. */
  since: Date;
  /** Exclusive, so consecutive windows cannot double-count a boundary row. */
  until: Date;
}

export interface EarnedByWorkspace {
  workspaceId: string;
  points: number;
}

/** Credits earned in a window, per workspace. The memory layer's unit. */
export interface CreditsByWorkspace {
  workspaceId: string;
  /** One record, used once by an agent that did not write it, is one credit. */
  credits: number;
}

/**
 * Credits per workspace inside a window — the memory layer's denominator.
 *
 * Named for credits rather than points because the two layers are priced
 * differently and a shared word would be the first step to pricing one at the
 * other's rate: a point is a millionth of a dollar of confirmed spend, a credit
 * is one record somebody else used.
 *
 * The workspace here is the one that OWNS the record, never the reader's.
 * creditRetrieval writes context.workspaceId and recall cannot cross a
 * workspace, so the author and the reader are always inside the same one —
 * which is exactly why the row is safe to pay the author's owner on.
 *
 * `workspaceIds` narrows it for the console, which asks about one account's
 * workspaces and has no business reading a groupBy over everybody's.
 */
export async function creditsInWindow(
  db: Db,
  window: CreditWindow,
  options: { workspaceIds?: string[] } = {}
): Promise<CreditsByWorkspace[]> {
  const rows = await db.rewardCredit.groupBy({
    by: ['workspaceId'],
    where: {
      createdAt: { gte: window.since, lt: window.until },
      ...(options.workspaceIds ? { workspaceId: { in: options.workspaceIds } } : {}),
    },
    _sum: { points: true },
  });

  return rows
    .map((row) => ({ workspaceId: row.workspaceId, credits: row._sum.points ?? 0 }))
    .filter((row) => row.credits > 0);
}

/**
 * The same window, under the older name and the older word.
 *
 * Kept because the console reads it, and delegating rather than repeating the
 * query: two groupBys over one table drift apart the first time one of them
 * gains a filter, and a rewards layer counting different rows from the figure
 * on the screen is the bug this product can least afford.
 */
export async function earnedInWindow(
  db: Db,
  window: CreditWindow
): Promise<EarnedByWorkspace[]> {
  const rows = await creditsInWindow(db, window);
  return rows.map((row) => ({ workspaceId: row.workspaceId, points: row.credits }));
}

/**
 * Total credits a workspace has ever earned. Shown in the console.
 *
 * Still named points, and still returning them, because points is what the
 * column is called and what every caller passes on. A credit is a point of
 * memory; the layers are told apart by which reader was asked, not by renaming
 * a column under live callers.
 */
export async function earnedEver(db: Db, workspaceId: string): Promise<number> {
  const result = await db.rewardCredit.aggregate({
    where: { workspaceId },
    _sum: { points: true },
  });
  return result._sum.points ?? 0;
}
