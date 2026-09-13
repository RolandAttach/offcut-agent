/**
 * The account-wide reads behind "where do I stand".
 *
 * Both helpers answer for a SET of workspaces, which is the whole reason they
 * exist: the per-workspace calls they replace were made in a loop, once per
 * workspace, by a surface that then added the results up. Two things have to
 * hold for the replacement to be safe, and they are what is tested here - the
 * set is honoured exactly (no workspace outside it contributes a millionth),
 * and the figures match what the per-workspace call says.
 */

import { describe, expect, it } from 'vitest';
import {
  agentActivity,
  reportUsage,
  spendByWorkspace,
  spendEver,
  verifyPendingUsage,
  type UsageVerifier,
  type VerifiedUsage,
} from '../usage';
import { getPrisma } from '../db';
import { authorize } from '../access';
import { makeAgent, makeWorkspace, key, type AgentFixture, type WorkspaceFixture } from './helpers';

/** Confirms whatever it is asked about, at the cost it was told to. */
function provider(costs: Record<string, number>): UsageVerifier {
  return {
    provider: 'openrouter',
    async verify(generationId: string): Promise<VerifiedUsage | null> {
      const costMicros = costs[generationId];
      if (costMicros === undefined) return null;
      return { generationId, costMicros, totalTokens: 100 };
    },
  };
}

async function contextFor(workspace: WorkspaceFixture, agent: AgentFixture) {
  return authorize(agent.principal, workspace.id, 'recall');
}

/** Reports one generation and settles it through the real verification path. */
async function spend(
  workspace: WorkspaceFixture,
  agent: AgentFixture,
  generationId: string,
  micros: number
): Promise<void> {
  const db = getPrisma();
  await reportUsage(db, await contextFor(workspace, agent), [{ generationId }]);
  await verifyPendingUsage(db, provider({ [generationId]: micros }));
}

// ---------------------------------------------------------------------------
describe('spendByWorkspace', () => {
  it('answers for a set of workspaces and agrees with spendEver on each', async () => {
    const owner = (await makeWorkspace()).owner;
    const first = await makeWorkspace(owner);
    const second = await makeWorkspace(owner);
    const stranger = await makeWorkspace();

    const a = await makeAgent(first, 'A');
    const b = await makeAgent(second, 'B');
    const c = await makeAgent(stranger, 'C');

    await spend(first, a, 'gen-set-0001', 1_200_000);
    await spend(second, b, 'gen-set-0002', 340_000);
    await spend(stranger, c, 'gen-set-0003', 999_000_000);

    const db = getPrisma();
    const rows = await spendByWorkspace(db, [first.id, second.id]);
    const byId = new Map(rows.map((row) => [row.workspaceId, row.micros]));

    expect(byId.get(first.id)).toBe(await spendEver(db, first.id));
    expect(byId.get(second.id)).toBe(await spendEver(db, second.id));
    expect(byId.get(first.id)).toBe(1_200_000);
    expect(byId.get(second.id)).toBe(340_000);
    // The one that matters: a workspace nobody asked about pays nobody.
    expect(byId.has(stranger.id)).toBe(false);
    expect(rows.reduce((total, row) => total + row.micros, 0)).toBe(1_540_000);
  });

  it('narrows to a window on when the provider confirmed, not when it was reported', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Worker');
    const db = getPrisma();

    await spend(workspace, agent, 'gen-old-0001', 500_000);
    await spend(workspace, agent, 'gen-new-0001', 70_000);

    // Pushed back beyond the window on the column the window reads, not on
    // reportedAt: a request confirmed late belongs to the moment it could
    // first have been paid on.
    await db.modelUsage.update({
      where: { provider_generationId: { provider: 'openrouter', generationId: 'gen-old-0001' } },
      data: { verifiedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });

    const thirtyDays = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const windowed = await spendByWorkspace(db, [workspace.id], { since: thirtyDays });
    const ever = await spendByWorkspace(db, [workspace.id]);

    expect(windowed[0]!.micros).toBe(70_000);
    expect(ever[0]!.micros).toBe(570_000);
  });

  it('answers with nothing when there are no workspaces', async () => {
    expect(await spendByWorkspace(getPrisma(), [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('agentActivity', () => {
  it('counts what each agent wrote and what it reported, in its own workspaces only', async () => {
    const owner = (await makeWorkspace()).owner;
    const mine = await makeWorkspace(owner);
    const stranger = await makeWorkspace();

    const writer = await makeAgent(mine, 'Writer');
    const reporter = await makeAgent(mine, 'Reporter');
    const idle = await makeAgent(mine, 'Idle');
    const outsider = await makeAgent(stranger, 'Outsider');

    for (const text of [
      'The migration runs before the deploy.',
      'The staging database is reset nightly.',
    ]) {
      await writer.memory.add({
        workspaceId: mine.id,
        type: 'decision',
        text,
        topic: 'release-3',
        idempotencyKey: key('standing'),
      });
    }

    await outsider.memory.add({
      workspaceId: stranger.id,
      type: 'fact',
      text: 'Nothing here belongs to the other account.',
      topic: 'release-3',
      idempotencyKey: key('standing'),
    });

    const db = getPrisma();
    // One confirmed, one refused: both are reports, and only one is money.
    await reportUsage(db, await contextFor(mine, reporter), [
      { generationId: 'gen-act-0001' },
      { generationId: 'gen-act-0002' },
    ]);
    await verifyPendingUsage(db, provider({ 'gen-act-0001': 60_000 }));

    const activity = await agentActivity(db, [mine.id]);
    const byAgent = new Map(activity.map((row) => [row.agentId, row]));

    expect(byAgent.get(writer.id)).toEqual({ agentId: writer.id, records: 2, usageReports: 0 });
    expect(byAgent.get(reporter.id)).toEqual({ agentId: reporter.id, records: 0, usageReports: 2 });
    // A hundred idle agents earn nothing, and this is what that looks like.
    expect(byAgent.has(idle.id)).toBe(false);
    expect(byAgent.has(outsider.id)).toBe(false);
  });

  it('stops counting a record once it is forgotten', async () => {
    // What a person sees in the workspace and what they see beside the agent
    // have to be the same number, or one of the two is lying about a deletion.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Author', { canForget: true });

    const kept = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      idempotencyKey: key('kept'),
    });
    const doomed = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'A note nobody needed after all.',
      topic: 'release-1',
      idempotencyKey: key('doomed'),
    });

    const db = getPrisma();
    expect((await agentActivity(db, [workspace.id]))[0]!.records).toBe(2);

    await agent.memory.forget({
      workspaceId: workspace.id,
      recordId: doomed.recordId,
      reason: 'written in error',
      idempotencyKey: key('forget'),
    });

    const after = await agentActivity(db, [workspace.id]);
    expect(after[0]!.records).toBe(1);
    expect(kept.recordId).not.toBe(doomed.recordId);
  });
});
