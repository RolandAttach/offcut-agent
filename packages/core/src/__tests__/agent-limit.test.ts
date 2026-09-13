/**
 * The four numbers OPEN-3 asks for.
 *
 * Section 8 leaves "maximum agents, record size, workspace size and context
 * limit" open. Three of them have had values in LIMITS since the store was
 * written - record text, import batch, retrieval context - but nothing anywhere
 * asserted that they are enforced, and the fourth, the number of agents in one
 * workspace, had no value at all. A limit that exists only as a constant is a
 * comment; these tests are what makes it a rule.
 *
 * The agent cap is the interesting one, because it is the only limit in LIMITS
 * about the state of a workspace rather than the shape of one call. Two things
 * follow from that and both are pinned below: it counts keys that can still
 * connect, and it refuses growth without ever touching what is already there. A
 * workspace that is over the cap - because its rows predate it, or because two
 * mints raced - keeps every agent it has, keeps listing them, and keeps writing
 * and recalling. The cap is a door, not a broom.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createAgent, listAgents, revokeAgent } from '../admin';
import { getPrisma } from '../db';
import { isOffcutError, type OffcutError } from '../errors';
import { CONSOLE_KEY_PREFIX } from '../store';
import { LIMITS } from '../types';
import { key, makeAgent, makeWorkspace, type WorkspaceFixture } from './helpers';

const MAX = LIMITS.agentsPerWorkspaceMax;

/**
 * Fills a workspace with agent rows directly.
 *
 * Minting two hundred keys through createAgent would spend a minute on hashing
 * to prove nothing this file is about, and the rows a real owner leaves behind
 * look exactly like these. The boundary itself is always crossed through
 * createAgent, never faked.
 */
async function fillAgents(workspaceId: string, count: number, label = 'filler'): Promise<void> {
  if (count <= 0) return;
  await getPrisma().agent.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      workspaceId,
      name: `${label}-${index}`,
      kind: 'subagent',
      description: 'Pre-existing agent row',
      keyHash: `offcut_sk_${label}_${workspaceId}_${index}`,
      keyPrefix: 'offcut_sk_fill00',
    })),
  });
}

function liveAgentCount(workspaceId: string): Promise<number> {
  return getPrisma().agent.count({
    where: { workspaceId, revokedAt: null, keyPrefix: { not: CONSOLE_KEY_PREFIX } },
  });
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (error: unknown) => error
  );
}

let workspace: WorkspaceFixture;

beforeEach(async () => {
  workspace = await makeWorkspace();
});

// ---------------------------------------------------------------------------
describe('A workspace holds at most LIMITS.agentsPerWorkspaceMax agents', () => {
  it('mints the agent that reaches the limit and refuses the one after it', async () => {
    await fillAgents(workspace.id, MAX - 1);

    // The last seat, taken through the real path.
    const last = await createAgent(workspace.owner.principal, workspace.id, {
      name: 'The last seat',
      kind: 'subagent',
    });
    expect(last.apiKey).toMatch(/^offcut_sk_/);
    expect(await liveAgentCount(workspace.id)).toBe(MAX);

    const failure = (await failureOf(() =>
      createAgent(workspace.owner.principal, workspace.id, { name: 'One too many' })
    )) as OffcutError;

    expect(isOffcutError(failure)).toBe(true);
    expect(failure.code).toBe('VALIDATION');
    expect(failure.message).toContain(String(MAX));

    // Refused means refused: no row, and no audit event claiming one was made.
    expect(await liveAgentCount(workspace.id)).toBe(MAX);
    expect(
      await getPrisma().agent.count({ where: { workspaceId: workspace.id, name: 'One too many' } })
    ).toBe(0);
    expect(
      await getPrisma().auditEvent.count({
        where: { workspaceId: workspace.id, action: 'agent.create' },
      })
    ).toBe(1);
  });

  it('refuses in the shape every other limit refuses in', async () => {
    await fillAgents(workspace.id, MAX);

    const capped = (await failureOf(() =>
      createAgent(workspace.owner.principal, workspace.id, { name: 'Refused' })
    )) as OffcutError;

    // The oldest limit in LIMITS, rejected through zod, for comparison.
    const other = await makeWorkspace();
    const writer = await makeAgent(other, 'Writer');
    const overlong = (await failureOf(() =>
      writer.memory.add({
        workspaceId: other.id,
        type: 'result',
        text: 'x'.repeat(LIMITS.recordTextMax + 1),
        topic: 'limits',
        idempotencyKey: key('overlong'),
      })
    )) as OffcutError;

    expect(overlong.code).toBe('VALIDATION');
    expect(capped.name).toBe(overlong.name);
    expect(capped.code).toBe(overlong.code);
    expect(capped.status).toBe(overlong.status);
    expect(capped.status).toBe(400);
    // Both are reportable over any surface as the same kind of failure.
    expect(JSON.parse(JSON.stringify(capped)).error.code).toBe('VALIDATION');
  });

  it('counts only keys that can still connect: a revoked one frees its seat', async () => {
    await fillAgents(workspace.id, MAX - 1);
    const doomed = await createAgent(workspace.owner.principal, workspace.id, {
      name: 'Retired integration',
    });

    const blocked = await failureOf(() =>
      createAgent(workspace.owner.principal, workspace.id, { name: 'Blocked' })
    );
    expect(isOffcutError(blocked)).toBe(true);

    await revokeAgent(workspace.owner.principal, workspace.id, doomed.agent.id);

    // The revoked row is still there - authorship survives revocation - but it
    // no longer occupies a seat.
    const replacement = await createAgent(workspace.owner.principal, workspace.id, {
      name: 'Its replacement',
    });
    expect(replacement.agent.id).not.toBe(doomed.agent.id);
    expect(
      await getPrisma().agent.count({ where: { workspaceId: workspace.id, id: doomed.agent.id } })
    ).toBe(1);
  });

  it('does not charge the owner for the console writer the store provisions', async () => {
    await fillAgents(workspace.id, MAX - 1);

    // An owner writing from the console creates the "Console" agent row.
    await workspace.owner.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'Written from the console, which provisions the Console writer row.',
      topic: 'limits',
      idempotencyKey: key('console-write'),
    });
    const consoleRows = await getPrisma().agent.count({
      where: { workspaceId: workspace.id, keyPrefix: CONSOLE_KEY_PREFIX },
    });
    expect(consoleRows).toBe(1);

    // MAX rows exist, but only MAX - 1 of them were minted by anyone, so the
    // owner still has their last seat.
    await expect(
      createAgent(workspace.owner.principal, workspace.id, { name: 'Still allowed' })
    ).resolves.toMatchObject({ agent: { name: 'Still allowed' } });
  });
});

// ---------------------------------------------------------------------------
describe('A workspace already over the limit keeps working', () => {
  it('lists every agent, keeps writing and recalling, and only refuses new keys', async () => {
    // One real key first, then a roster that puts the workspace three over.
    const agent = await makeAgent(workspace, 'Early arrival');
    await fillAgents(workspace.id, MAX + 2, 'legacy');
    expect(await liveAgentCount(workspace.id)).toBe(MAX + 3);

    // Nothing is deleted and nothing is hidden.
    const listed = await listAgents(workspace.owner.principal, workspace.id);
    expect(listed.length).toBe(MAX + 3);
    expect(listed.some((row) => row.name === 'Early arrival')).toBe(true);

    // Memory still works in both directions.
    await agent.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The cap refuses new keys and touches nothing that already exists.',
      topic: 'limits',
      idempotencyKey: key('over-limit-write'),
    });
    const recalled = await agent.memory.recall({ workspaceId: workspace.id, query: 'cap refuses' });
    expect(recalled.items.length).toBeGreaterThan(0);

    // Only the door is shut.
    const failure = await failureOf(() =>
      createAgent(workspace.owner.principal, workspace.id, { name: 'Not today' })
    );
    expect((failure as OffcutError).code).toBe('VALIDATION');
  });
});

// ---------------------------------------------------------------------------
describe('The three older OPEN-3 limits are enforced, not just declared', () => {
  it('refuses a record longer than LIMITS.recordTextMax', async () => {
    const agent = await makeAgent(workspace, 'Writer');

    const failure = (await failureOf(() =>
      agent.memory.add({
        workspaceId: workspace.id,
        type: 'result',
        text: 'x'.repeat(LIMITS.recordTextMax + 1),
        topic: 'limits',
        idempotencyKey: key('too-long'),
      })
    )) as OffcutError;

    expect(failure.code).toBe('VALIDATION');
    expect(failure.message).toContain('text');

    // One character under is accepted, so it is the number being tested and not
    // merely "long text fails".
    await expect(
      agent.memory.add({
        workspaceId: workspace.id,
        type: 'result',
        text: 'x'.repeat(LIMITS.recordTextMax),
        topic: 'limits',
        idempotencyKey: key('exactly-max'),
      })
    ).resolves.toBeTruthy();
  });

  it('refuses an import batch larger than LIMITS.importBatchMax', async () => {
    const agent = await makeAgent(workspace, 'Importer', { canImport: true });

    const failure = (await failureOf(() =>
      agent.memory.import({
        workspaceId: workspace.id,
        records: Array.from({ length: LIMITS.importBatchMax + 1 }, (_, index) => ({
          type: 'result' as const,
          text: `Imported record ${index}`,
          topic: 'limits',
        })),
        idempotencyKey: key('big-batch'),
      })
    )) as OffcutError;

    expect(failure.code).toBe('VALIDATION');
    expect(failure.message).toContain('records');
  });

  it('refuses a retrieval budget larger than LIMITS.contextLimitMax', async () => {
    const agent = await makeAgent(workspace, 'Reader');

    const failure = (await failureOf(() =>
      agent.memory.recall({
        workspaceId: workspace.id,
        query: 'anything',
        limit: LIMITS.contextLimitMax + 1,
      })
    )) as OffcutError;

    expect(failure.code).toBe('VALIDATION');
    expect(failure.message).toContain('limit');
  });
});
