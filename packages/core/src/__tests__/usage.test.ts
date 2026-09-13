/**
 * Verified AI spend — the basis rewards are actually paid on.
 *
 * The brief fixes the metric: weight follows CONFIRMED model spend by an
 * account's subagents. So these tests are about the two words that carry it.
 *
 *   CONFIRMED  an agent saying it spent a fortune earns nothing until a
 *              provider agrees. Everything an agent controls is free; a
 *              provider's answer is not.
 *   ONCE       "one request cannot be counted twice" — replay it, report it
 *              from a second agent, send it twice in one batch: one row.
 *
 * And the sentence the brief is careful about, which the arithmetic has to
 * honour: a hundred idle agents earn nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  reportUsage,
  spendEver,
  spendInWindow,
  unconfirmedUsage,
  verifyPendingUsage,
  type UsageVerifier,
  type UsageVerifierSource,
  type VerifiedUsage,
} from '../usage';
import { getPrisma } from '../db';
import type { Db, PrismaClient } from '../db';
import { authorize } from '../access';
import { makeAgent, makeWorkspace, type AgentFixture, type WorkspaceFixture } from './helpers';

/** A provider that answers with whatever it is told to, and counts the asking. */
function fakeProvider(
  answers: Record<string, VerifiedUsage | null>,
  options: { throwOn?: string[] } = {}
): UsageVerifier & { asked: string[] } {
  const asked: string[] = [];
  return {
    provider: 'openrouter',
    asked,
    async verify(generationId: string) {
      asked.push(generationId);
      if (options.throwOn?.includes(generationId)) {
        throw new Error('provider unreachable');
      }
      return answers[generationId] ?? null;
    },
  };
}

function usage(generationId: string, costMicros: number, totalTokens = 1000): VerifiedUsage {
  return { generationId, costMicros, totalTokens };
}

/**
 * Production's shape: one key per workspace, and a key answers only about the
 * generations it paid for. A workspace absent from `keys` has linked nothing,
 * so there is nothing to ask with — exactly what the real source returns.
 */
function perWorkspaceProvider(
  keys: Record<string, Record<string, VerifiedUsage>>
): UsageVerifierSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    provider: 'openrouter',
    asked,
    async forWorkspace(workspaceId: string): Promise<UsageVerifier | null> {
      const answers = keys[workspaceId];
      if (!answers) return null;
      return {
        provider: 'openrouter',
        async verify(generationId: string) {
          asked.push(generationId);
          return answers[generationId] ?? null;
        },
      };
    },
  };
}

/**
 * Marks a workspace as having a credential linked, without one.
 *
 * Linking for real asks OpenRouter whether the key works, and nothing in this
 * file goes near the network. What decides whether a row is fetched for
 * verification is that the column is set, never what is in it, and the fake
 * source above is what answers.
 */
async function linkKey(workspaceId: string): Promise<void> {
  await getPrisma().workspace.update({
    where: { id: workspaceId },
    data: { usageKeyCipher: 'not-a-key', usageKeyHint: 'test', usageLinkedAt: new Date() },
  });
}

async function contextFor(workspace: WorkspaceFixture, agent: AgentFixture) {
  return authorize(agent.principal, workspace.id, 'recall');
}

/**
 * The real store, with only its inserts broken.
 *
 * What is under test is not any particular bad report: it is that a release and
 * the insert meant to replace it either both happen or neither does. So the
 * failure is put where real ones are — a connection dropped, a process killed
 * between the two statements — rather than found in whichever report happens to
 * make an insert fail this month. Reads and deletes stay real, so a release
 * that is not rolled back is visible afterwards.
 */
function storeThatCannotInsert(store: PrismaClient): Db {
  const broken = (handle: object): Db =>
    new Proxy(handle, {
      get(target, property) {
        if (property === 'modelUsage') {
          const model = Reflect.get(target, property, target) as object;
          return new Proxy(model, {
            get(delegate, call) {
              if (call === 'create' || call === 'createMany') {
                return async () => {
                  throw new Error('the store went away mid-write');
                };
              }
              return Reflect.get(delegate, call, delegate);
            },
          });
        }

        // The transaction itself is real — that is the point — but the handle
        // it hands back has the same insert broken, so the failure lands inside.
        if (property === '$transaction') {
          return (run: (tx: Db) => Promise<unknown>, options?: unknown) =>
            store.$transaction((tx) => run(broken(tx as object)), options as never);
        }

        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as Db;

  return broken(store);
}

// ---------------------------------------------------------------------------
describe('Spend is confirmed, never claimed', () => {
  it('earns nothing until a provider agrees', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, agent), [
      { generationId: 'gen-aaa111', reportedCostMicros: 50_000_000 },
    ]);

    // Reported, and worth nothing.
    expect(await spendEver(db, workspace.id)).toBe(0);
  });

  it('pays what the provider says, not what the agent claimed', async () => {
    // The whole defence in one test. An agent that could inflate its own number
    // would make the metric worthless.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, agent), [
      { generationId: 'gen-bbb222', reportedCostMicros: 99_000_000, reportedTokens: 99_000_000 },
    ]);

    await verifyPendingUsage(db, fakeProvider({ 'gen-bbb222': usage('gen-bbb222', 1_234) }));

    expect(await spendEver(db, workspace.id)).toBe(1_234);
  });

  it('rejects a request the provider does not recognise, and says so', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, agent), [{ generationId: 'gen-invented' }]);
    await verifyPendingUsage(db, fakeProvider({}));

    const row = await db.modelUsage.findFirst({ where: { generationId: 'gen-invented' } });
    expect(row?.status).toBe('rejected');
    expect(row?.rejectedReason).toContain('does not recognise');
    expect(await spendEver(db, workspace.id)).toBe(0);
  });

  it('keeps a report pending when the provider cannot be reached', async () => {
    // An outage must not destroy what somebody actually spent. It waits.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, agent), [{ generationId: 'gen-ccc333' }]);

    const down = fakeProvider({}, { throwOn: ['gen-ccc333'] });
    const first = await verifyPendingUsage(db, down);
    expect(first).toMatchObject({ verified: 0, rejected: 0, deferred: 1 });

    const backUp = fakeProvider({ 'gen-ccc333': usage('gen-ccc333', 777) });
    const second = await verifyPendingUsage(db, backUp);
    expect(second.verified).toBe(1);
    expect(await spendEver(db, workspace.id)).toBe(777);
  });

  it('a human in the console cannot report spend', async () => {
    const workspace = await makeWorkspace();
    const db = getPrisma();
    const asOwner = await authorize(workspace.owner.principal, workspace.id, 'recall');

    await expect(
      reportUsage(db, asOwner, [{ generationId: 'gen-ddd444' }])
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});

// ---------------------------------------------------------------------------
describe('One request is counted once', () => {
  it('ignores the same generation reported twice', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();
    const context = await contextFor(workspace, agent);

    const first = await reportUsage(db, context, [{ generationId: 'gen-eee555' }]);
    const second = await reportUsage(db, context, [{ generationId: 'gen-eee555' }]);

    expect(first.accepted).toBe(1);
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toEqual(['gen-eee555']);
    expect(await db.modelUsage.count({ where: { generationId: 'gen-eee555' } })).toBe(1);
  });

  it('ignores it when a second agent claims the same request', async () => {
    // Two agents, one bill. Whoever reported first owns it.
    const workspace = await makeWorkspace();
    const first = await makeAgent(workspace, 'First');
    const second = await makeAgent(workspace, 'Second');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, first), [{ generationId: 'gen-fff666' }]);
    const stolen = await reportUsage(db, await contextFor(workspace, second), [
      { generationId: 'gen-fff666' },
    ]);

    expect(stolen.accepted).toBe(0);
    const rows = await db.modelUsage.findMany({ where: { generationId: 'gen-fff666' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reportedByAgentId).toBe(first.id);
  });

  it('writes one row for an id repeated inside a single batch', async () => {
    // The whole batch used to be lost to this. One multi-row insert, all or
    // nothing: the repeat broke the unique key, every row went down with it,
    // and all three ids came back as duplicates — which tells the agent they
    // are counted, so it never sends them again. Confirmed spend, destroyed by
    // the likeliest client mistake there is.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    const result = await reportUsage(db, await contextFor(workspace, agent), [
      { generationId: 'gen-batch-dup' },
      { generationId: 'gen-batch-dup' },
      { generationId: 'gen-batch-good' },
    ]);

    expect(result.accepted).toBe(2);
    expect(result.duplicates).toEqual(['gen-batch-dup']);
    expect(result.rejected).toEqual([]);

    expect(await db.modelUsage.count({ where: { generationId: 'gen-batch-dup' } })).toBe(1);
    expect(await db.modelUsage.count({ where: { generationId: 'gen-batch-good' } })).toBe(1);
  });

  it('keeps the rest of a batch when one id is claimed between the read and the write', async () => {
    // The same loss by the other route, and the reason the id below is taken by
    // a stand-in rather than by a second writer: the window is between two
    // statements of one call, and SQLite takes one writer at a time, so a real
    // race here would be a coin toss rather than a test. What is real is the
    // rule — a batch that loses one id loses only that id.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const real = getPrisma();

    // The stand-in only opens the window; the collision itself is real, so the
    // error is the one the database raises rather than one written here to
    // resemble it. A hand-made error would pass whatever this file believed a
    // lost race looks like, which is the thing under test.
    let claimed = false;
    const raced = {
      modelUsage: {
        findMany: (args: never) => real.modelUsage.findMany(args),
        deleteMany: (args: never) => real.modelUsage.deleteMany(args),
        create: (args: never) => real.modelUsage.create(args),
        async createMany(args: never) {
          if (!claimed) {
            claimed = true;
            await real.modelUsage.create({
              data: {
                workspaceId: workspace.id,
                provider: 'openrouter',
                generationId: 'gen-raced-lost',
                reportedByAgentId: agent.id,
              },
            });
          }
          return real.modelUsage.createMany(args);
        },
      },
    } as unknown as Db;

    const result = await reportUsage(raced, await contextFor(workspace, agent), [
      { generationId: 'gen-raced-lost' },
      { generationId: 'gen-raced-kept-a' },
      { generationId: 'gen-raced-kept-b' },
    ]);

    expect(result.accepted).toBe(2);
    expect(result.duplicates).toEqual(['gen-raced-lost']);

    expect(await real.modelUsage.count({ where: { generationId: 'gen-raced-kept-a' } })).toBe(1);
    expect(await real.modelUsage.count({ where: { generationId: 'gen-raced-kept-b' } })).toBe(1);
    expect(await real.modelUsage.count({ where: { generationId: 'gen-raced-lost' } })).toBe(1);
  });

  it('pays a verified request once even if verification runs again', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, agent), [{ generationId: 'gen-ggg777' }]);

    const provider = fakeProvider({ 'gen-ggg777': usage('gen-ggg777', 500) });
    await verifyPendingUsage(db, provider);
    await verifyPendingUsage(db, provider);

    // Asked exactly once: a settled row is never re-queried.
    expect(provider.asked).toEqual(['gen-ggg777']);
    expect(await spendEver(db, workspace.id)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
describe('What earns nothing', () => {
  it('a hundred idle agents', async () => {
    // Straight out of the brief. Agents are rows; rows are free.
    const workspace = await makeWorkspace();
    for (let index = 0; index < 100; index += 1) {
      await makeAgent(workspace, `Idle ${index}`);
    }

    expect(await spendEver(getPrisma(), workspace.id)).toBe(0);
  });

  it('a malformed generation id', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    const result = await reportUsage(db, await contextFor(workspace, agent), [
      { generationId: '   ' },
      { generationId: 'x' },
    ]);

    expect(result.accepted).toBe(0);
    expect(result.rejected).toHaveLength(2);
  });

  it('a provider we cannot ask', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    const result = await reportUsage(db, await contextFor(workspace, agent), [
      { generationId: 'gen-hhh888', provider: 'some-other-provider' as never },
    ]);

    expect(result.accepted).toBe(0);
    expect(result.rejected[0]!.reason).toContain('unsupported provider');
  });

  it('a negative cost, which cannot subtract from anyone', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, agent), [
      { generationId: 'gen-iii999', reportedCostMicros: -1_000_000, reportedTokens: -5 },
    ]);

    const row = await db.modelUsage.findFirst({ where: { generationId: 'gen-iii999' } });
    expect(row?.reportedCostMicros).toBe(0);
    expect(row?.reportedTokens).toBe(0);
  });

  it('an impossible token count, which cannot fail the reports sent with it', async () => {
    // The agent's own figure is the one number in the write it fully controls,
    // and a number too large for the column is refused by the driver rather
    // than truncated. Unbounded, one absurd report failed the insert for every
    // honest report in the same call, and each was answered `duplicate`.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    const result = await reportUsage(db, await contextFor(workspace, agent), [
      { generationId: 'gen-absurd-01', reportedTokens: 1e30, reportedCostMicros: 1e30 },
      { generationId: 'gen-ordinary-1', reportedTokens: 120 },
    ]);

    expect(result.accepted).toBe(2);
    expect(result.duplicates).toEqual([]);

    const ordinary = await db.modelUsage.findFirst({ where: { generationId: 'gen-ordinary-1' } });
    expect(ordinary?.reportedTokens).toBe(120);
    // And still worth nothing: no provider has said a word about either.
    expect(await spendEver(db, workspace.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('Windows, for paying by period', () => {
  it('counts confirmed spend inside the window and nothing outside it', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, agent), [{ generationId: 'gen-window-1' }]);
    await verifyPendingUsage(db, fakeProvider({ 'gen-window-1': usage('gen-window-1', 2_500) }));

    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const soon = new Date(now.getTime() + 60_000);
    const longAgo = new Date(now.getTime() - 7_200_000);

    const inside = await spendInWindow(db, { since: hourAgo, until: soon });
    expect(inside.find((row) => row.workspaceId === workspace.id)?.points).toBe(2_500);

    const before = await spendInWindow(db, { since: longAgo, until: hourAgo });
    expect(before.find((row) => row.workspaceId === workspace.id)).toBeUndefined();
  });

  it('windows on when it was confirmed, not when it was reported', async () => {
    // A request confirmed an hour late belongs to the period it was confirmed
    // in. The period it was made in has already been paid, and reopening a paid
    // period is how a ledger stops being one.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, agent), [{ generationId: 'gen-late' }]);

    // Backdate the report far into the past; verification happens now.
    const longAgo = new Date(Date.now() - 86_400_000);
    await db.modelUsage.updateMany({
      where: { generationId: 'gen-late' },
      data: { reportedAt: longAgo },
    });

    await verifyPendingUsage(db, fakeProvider({ 'gen-late': usage('gen-late', 900) }));

    const recent = await spendInWindow(db, {
      since: new Date(Date.now() - 600_000),
      until: new Date(Date.now() + 60_000),
    });
    expect(recent.find((row) => row.workspaceId === workspace.id)?.points).toBe(900);

    const whenReported = await spendInWindow(db, {
      since: new Date(longAgo.getTime() - 600_000),
      until: new Date(longAgo.getTime() + 600_000),
    });
    expect(whenReported.find((row) => row.workspaceId === workspace.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('A rejection does not get to own the id', () => {
  /**
   * Found by probing rather than by reading, and it is the worst kind of bug
   * this file can have: the money is safe and the accounting is silently wrong.
   *
   * Nobody can be paid for somebody else's request — a foreign key is asked and
   * says no. But the row it leaves behind is settled under the wrong workspace,
   * and the id is a global unique key. Every later report from the workspace
   * that actually paid comes back `duplicate`. Real spend, gone, with no error
   * on any surface.
   */
  it('gives the id back to the workspace that actually paid for it', async () => {
    const victim = await makeWorkspace();
    const victimAgent = await makeAgent(victim, 'Victim');
    const other = await makeWorkspace();
    const otherAgent = await makeAgent(other, 'Other');
    const db = getPrisma();

    // Another workspace reports the id first and its key does not know it.
    await reportUsage(db, await contextFor(other, otherAgent), [{ generationId: 'gen-contested' }]);
    await verifyPendingUsage(db, fakeProvider({}));
    expect(await spendEver(db, other.id)).toBe(0);

    // The workspace that really spent it reports it, and is heard.
    const owner = await reportUsage(db, await contextFor(victim, victimAgent), [
      { generationId: 'gen-contested' },
    ]);
    expect(owner.accepted).toBe(1);
    expect(owner.duplicates).toEqual([]);

    await verifyPendingUsage(db, fakeProvider({ 'gen-contested': usage('gen-contested', 4_200) }));

    expect(await spendEver(db, victim.id)).toBe(4_200);
    // And still exactly one row: releasing does not duplicate.
    expect(await db.modelUsage.count({ where: { generationId: 'gen-contested' } })).toBe(1);
    expect(await spendEver(db, other.id)).toBe(0);
  });

  it('never releases a request that has already been paid', async () => {
    // The direction that would actually cost money. A verified row is settled;
    // if a second workspace could displace it, one request would pay twice.
    const payer = await makeWorkspace();
    const payerAgent = await makeAgent(payer, 'Payer');
    const other = await makeWorkspace();
    const otherAgent = await makeAgent(other, 'Other');
    const db = getPrisma();

    await reportUsage(db, await contextFor(payer, payerAgent), [{ generationId: 'gen-settled' }]);
    await verifyPendingUsage(db, fakeProvider({ 'gen-settled': usage('gen-settled', 1_500) }));

    const grab = await reportUsage(db, await contextFor(other, otherAgent), [
      { generationId: 'gen-settled' },
    ]);

    expect(grab.accepted).toBe(0);
    expect(grab.duplicates).toEqual(['gen-settled']);
    expect(await spendEver(db, payer.id)).toBe(1_500);
    expect(await spendEver(db, other.id)).toBe(0);
    expect(await db.modelUsage.count({ where: { generationId: 'gen-settled' } })).toBe(1);
  });

  it('does not let one workspace re-drive verification of its own rejection', async () => {
    // Releasing is for returning spend to whoever made it, not a retry button
    // an agent can hold down: each release costs a provider call.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();
    const context = await contextFor(workspace, agent);

    await reportUsage(db, context, [{ generationId: 'gen-own-reject' }]);
    await verifyPendingUsage(db, fakeProvider({}));

    const again = await reportUsage(db, context, [{ generationId: 'gen-own-reject' }]);
    expect(again.accepted).toBe(0);
    expect(again.duplicates).toEqual(['gen-own-reject']);

    const provider = fakeProvider({});
    await verifyPendingUsage(db, provider);
    expect(provider.asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('The id is unique per provider, not on its own', () => {
  it('does not mistake an identical id from another provider for a duplicate', async () => {
    // The unique key is the pair, and the lookup has to match it. Two providers
    // are free to hand out the same string; reading on the id alone refuses the
    // second one as a replay of a request it has nothing to do with — as spend
    // that silently earns nothing. Only one provider is supported today, so
    // the foreign row is written directly: this guards the seam the file is
    // built to be extended along, before somebody extends it.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await db.modelUsage.create({
      data: {
        workspaceId: workspace.id,
        provider: 'some-future-provider',
        generationId: 'gen-shared-string',
        reportedByAgentId: agent.id,
      },
    });

    const result = await reportUsage(db, await contextFor(workspace, agent), [
      { generationId: 'gen-shared-string' },
    ]);

    expect(result.accepted).toBe(1);
    expect(result.duplicates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('Nor does a pending row nobody can ask about', () => {
  /**
   * The cheaper half of the same attack, and it was left open when the
   * rejected half was closed. A workspace that has linked no key never has its
   * rows fetched — so they are never asked about, never rejected, and never
   * releasable. One unauthenticated report, no OpenRouter account and no spend
   * at all, and the id belongs to nobody forever.
   *
   * It arrives without an adversary too: two workspaces sharing one key, and
   * the one without it linked reports first.
   */
  it('gives the id back when the workspace holding it has no key to answer with', async () => {
    const squatter = await makeWorkspace();
    const squatterAgent = await makeAgent(squatter, 'Squatter');
    const payer = await makeWorkspace();
    const payerAgent = await makeAgent(payer, 'Payer');
    const db = getPrisma();

    await linkKey(payer.id);
    const source = perWorkspaceProvider({
      [payer.id]: { 'gen-real-spend-1': usage('gen-real-spend-1', 9_000) },
    });

    await reportUsage(db, await contextFor(squatter, squatterAgent), [
      { generationId: 'gen-real-spend-1' },
    ]);

    const claim = await reportUsage(db, await contextFor(payer, payerAgent), [
      { generationId: 'gen-real-spend-1' },
    ]);
    expect(claim.accepted).toBe(1);
    expect(claim.duplicates).toEqual([]);

    expect(await verifyPendingUsage(db, source)).toMatchObject({ verified: 1, rejected: 0 });
    expect(await spendEver(db, payer.id)).toBe(9_000);
    expect(await spendEver(db, squatter.id)).toBe(0);
    // Released, not copied: the id is still on exactly one row.
    expect(await db.modelUsage.count({ where: { generationId: 'gen-real-spend-1' } })).toBe(1);
  });

  it('leaves a pending report alone when its workspace can still be asked about it', async () => {
    // The other direction, and the reason the release is not simply "anything
    // not yet verified": a report waiting its turn in the queue must not be
    // takeable out of the hands of the workspace that can actually settle it,
    // or the same trick works again against a workspace that did link a key.
    const payer = await makeWorkspace();
    const payerAgent = await makeAgent(payer, 'Payer');
    const other = await makeWorkspace();
    const otherAgent = await makeAgent(other, 'Other');
    const db = getPrisma();

    await linkKey(payer.id);
    const source = perWorkspaceProvider({
      [payer.id]: { 'gen-in-flight-1': usage('gen-in-flight-1', 3_300) },
    });

    await reportUsage(db, await contextFor(payer, payerAgent), [
      { generationId: 'gen-in-flight-1' },
    ]);

    const grab = await reportUsage(db, await contextFor(other, otherAgent), [
      { generationId: 'gen-in-flight-1' },
    ]);
    expect(grab.accepted).toBe(0);
    expect(grab.duplicates).toEqual(['gen-in-flight-1']);

    await verifyPendingUsage(db, source);

    expect(await spendEver(db, payer.id)).toBe(3_300);
    expect(await spendEver(db, other.id)).toBe(0);
  });
});
// ---------------------------------------------------------------------------
describe('What is not being paid for, and why', () => {
  it('counts a report still waiting on the provider as waiting, not as nothing', async () => {
    // The zero this exists to explain. Confirmed spend says nothing has been
    // paid for; on its own that reads as "your agents spent nothing", which for
    // this account is false and is the reading that makes somebody stop
    // reporting.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, agent), [
      { generationId: 'gen-waiting-1', reportedCostMicros: 400_000 },
      { generationId: 'gen-waiting-2', reportedCostMicros: 600_000 },
    ]);

    expect(await spendEver(db, workspace.id)).toBe(0);
    expect(await unconfirmedUsage(db, [workspace.id])).toEqual({
      pending: { requests: 2, reportedMicros: 1_000_000 },
      rejected: { requests: 0, reasons: [] },
    });
  });

  it('stops calling a report outstanding once the provider has answered for it', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, agent), [
      { generationId: 'gen-settled-1', reportedCostMicros: 900_000 },
    ]);
    await verifyPendingUsage(db, fakeProvider({ 'gen-settled-1': usage('gen-settled-1', 2_500) }));

    expect(await spendEver(db, workspace.id)).toBe(2_500);
    expect(await unconfirmedUsage(db, [workspace.id])).toEqual({
      pending: { requests: 0, reportedMicros: 0 },
      rejected: { requests: 0, reasons: [] },
    });
  });

  it('gives the provider’s reason for every refusal, commonest first', async () => {
    // The reason is written to the row the moment a report is refused and is
    // the only answer to "why did this earn nothing". Counting refusals without
    // it leaves a reader knowing they were refused and not what to do about it.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await reportUsage(db, await contextFor(workspace, agent), [
      { generationId: 'gen-refused-1' },
      { generationId: 'gen-refused-2' },
      { generationId: 'gen-refused-3' },
    ]);
    await verifyPendingUsage(db, fakeProvider({}));

    // A second kind of refusal, on the row where one would be recorded.
    await db.modelUsage.updateMany({
      where: { generationId: 'gen-refused-3' },
      data: { rejectedReason: 'the provider charged nothing for this request' },
    });

    const outstanding = await unconfirmedUsage(db, [workspace.id]);

    expect(outstanding.rejected.requests).toBe(3);
    expect(outstanding.rejected.reasons).toEqual([
      { reason: 'the provider does not recognise this request', requests: 2 },
      { reason: 'the provider charged nothing for this request', requests: 1 },
    ]);
  });

  it('counts a refusal that has no reason on file rather than inventing one', async () => {
    // A reason made up here would be put in a provider's mouth on a screen that
    // exists to be believed. The refusal is still counted, so the total stays
    // true and the surface can say plainly that no reason was recorded.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await db.modelUsage.create({
      data: {
        workspaceId: workspace.id,
        provider: 'openrouter',
        generationId: 'gen-silent-refusal',
        reportedByAgentId: agent.id,
        reportedCostMicros: 1_000_000,
        status: 'rejected',
        verifiedAt: new Date(),
      },
    });

    const outstanding = await unconfirmedUsage(db, [workspace.id]);

    expect(outstanding.rejected).toEqual({ requests: 1, reasons: [] });
  });

  it('answers about the workspaces it was asked about and no others', async () => {
    // Same rule as every other read in this file: one account's reports are not
    // another account's explanation of its own zero.
    const mine = await makeWorkspace();
    const myAgent = await makeAgent(mine, 'Mine');
    const theirs = await makeWorkspace();
    const theirAgent = await makeAgent(theirs, 'Theirs');
    const db = getPrisma();

    await reportUsage(db, await contextFor(mine, myAgent), [
      { generationId: 'gen-mine-0001', reportedCostMicros: 100_000 },
    ]);
    await reportUsage(db, await contextFor(theirs, theirAgent), [
      { generationId: 'gen-theirs-001', reportedCostMicros: 900_000 },
    ]);

    expect(await unconfirmedUsage(db, [mine.id])).toEqual({
      pending: { requests: 1, reportedMicros: 100_000 },
      rejected: { requests: 0, reasons: [] },
    });
  });

  it('says nothing is outstanding for an account with no workspaces at all', async () => {
    // A brand new account asks this question too, and an empty list is not a
    // missing answer: nothing has been reported, so nothing is waiting.
    expect(await unconfirmedUsage(getPrisma(), [])).toEqual({
      pending: { requests: 0, reportedMicros: 0 },
      rejected: { requests: 0, reasons: [] },
    });
  });
});

// ---------------------------------------------------------------------------
describe('Taking an id back is one write', () => {
  /**
   * The release deletes rows belonging to ANOTHER workspace, and the ids it
   * deletes are the ones the caller sent. As two statements, an insert that
   * failed afterwards left that workspace's rows deleted with nothing in their
   * place — and the call answered `duplicate`, which to an agent means counted.
   * One agent key in an unrelated workspace was enough to ask for it.
   */
  it('leaves another workspace’s rows where they were when the insert fails', async () => {
    const victim = await makeWorkspace();
    const victimAgent = await makeAgent(victim, 'Victim');
    const other = await makeWorkspace();
    const otherAgent = await makeAgent(other, 'Other');
    const db = getPrisma();

    await reportUsage(db, await contextFor(victim, victimAgent), [
      { generationId: 'gen-v-0001' },
      { generationId: 'gen-v-0002' },
      { generationId: 'gen-v-0003' },
    ]);
    await verifyPendingUsage(db, fakeProvider({}));

    const settled = await db.modelUsage.findMany({
      where: { workspaceId: victim.id },
      orderBy: { generationId: 'asc' },
    });
    expect(settled.map((row) => row.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(settled.every((row) => row.rejectedReason !== '')).toBe(true);

    await expect(
      reportUsage(storeThatCannotInsert(db), await contextFor(other, otherAgent), [
        { generationId: 'gen-v-0001' },
        { generationId: 'gen-v-0002' },
        { generationId: 'gen-v-0003' },
      ])
    ).rejects.toThrow();

    const after = await db.modelUsage.findMany({
      where: { workspaceId: victim.id },
      orderBy: { generationId: 'asc' },
    });
    expect(after).toEqual(settled);
  });

  it('takes the id back for real when the insert succeeds', async () => {
    // The other half of the same statement: rolling back on failure must not
    // have cost the release its reason to exist.
    const victim = await makeWorkspace();
    const victimAgent = await makeAgent(victim, 'Victim');
    const payer = await makeWorkspace();
    const payerAgent = await makeAgent(payer, 'Payer');
    const db = getPrisma();

    await reportUsage(db, await contextFor(victim, victimAgent), [{ generationId: 'gen-v-0004' }]);
    await verifyPendingUsage(db, fakeProvider({}));

    const taken = await reportUsage(db, await contextFor(payer, payerAgent), [
      { generationId: 'gen-v-0004' },
    ]);
    expect(taken.accepted).toBe(1);

    const rows = await db.modelUsage.findMany({ where: { generationId: 'gen-v-0004' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(payer.id);
  });
});
