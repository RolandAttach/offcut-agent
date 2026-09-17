/**
 * The acceptance table of SS7.1, plus the primary acceptance check.
 *
 * SS7.1 closes with a requirement about HOW these are proven: the primary check
 * "must be demonstrated in an integration example, not merely by exposing MCP
 * tools". So this suite runs across package boundaries - the SDK for one caller,
 * the MCP dispatch for another, the core underneath both - rather than calling
 * internal functions that a shipped integration would never touch.
 *
 * The MCP tools are imported from source rather than from the built package so
 * the suite tests what is written, not what was last compiled.
 */

import { describe, expect, it } from 'vitest';
import {
  Memory,
  authenticateAgent,
  createAgent,
  createUser,
  createWorkspace,
  disconnectPrisma,
  getPrisma,
  revokeAgent,
  type Permissions,
  type Principal,
} from '@offcut/core';
import { connect } from '@offcut/sdk';
import { callTool } from '../../../apps/mcp-server/src/tools';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let counter = 0;

async function makeWorkspace() {
  counter += 1;
  const user = await createUser({
    email: `acceptance${counter}-${Date.now()}@offcut.test`,
    password: 'correct-horse-battery',
    displayName: 'Owner',
  });

  const principal: Principal = {
    kind: 'user',
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
  };

  const workspace = await createWorkspace({
    ownerId: user.id,
    name: `Acceptance ${counter}`,
  });

  return {
    id: workspace.id,
    ownerPrincipal: principal,
    ownerMemory: new Memory(principal),
  };
}

async function mintAgent(
  workspace: { id: string; ownerPrincipal: Principal },
  name: string,
  permissions?: Partial<Permissions>
) {
  const created = await createAgent(workspace.ownerPrincipal, workspace.id, {
    name,
    ...(permissions ? { permissions } : {}),
  });
  return created.apiKey;
}

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ---------------------------------------------------------------------------
describe('Check 1 - two subagents save different results; a new lead agent queries the task', () => {
  it('returns one context with both results and source references', async () => {
    const workspace = await makeWorkspace();

    // Two subagents work in separate sessions and never meet.
    const researcherKey = await mintAgent(workspace, 'Researcher');
    const testerKey = await mintAgent(workspace, 'Tester');

    const researcher = await connect(researcherKey);
    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      source: 'product brief, section 2',
      idempotencyKey: `r-${uid()}`,
    });

    const tester = await connect(testerKey);
    await tester.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'One saved record disappears after a restart.',
      topic: 'release-1',
      source: 'regression run #148',
      idempotencyKey: `t-${uid()}`,
    });

    // A lead agent created afterwards, which took part in neither session.
    const leadKey = await mintAgent(workspace, 'Lead');
    const lead = await connect(leadKey);

    const context = await lead.memory.recall({
      workspaceId: workspace.id,
      query: 'what remains before release?',
    });

    const texts = context.items.map((item) => item.text);
    expect(texts).toContain('The application must work offline.');
    expect(texts).toContain('One saved record disappears after a restart.');

    // Every item cites where it came from.
    for (const item of context.items) {
      expect(item.refs.length).toBeGreaterThan(0);
      for (const ref of item.refs) {
        expect(ref.recordId).toMatch(/^rec_/);
        expect(ref.version).toBeGreaterThanOrEqual(1);
        expect(ref.agentName).toBeTruthy();
      }
    }

    const authors = new Set(context.items.flatMap((item) => item.refs.map((ref) => ref.agentName)));
    expect(authors).toContain('Researcher');
    expect(authors).toContain('Tester');
  });
});

// ---------------------------------------------------------------------------
describe('Check 2 - retry a request; submit identical text from another agent', () => {
  it('writes no duplicate on retry and preserves the second note\'s provenance', async () => {
    const workspace = await makeWorkspace();
    const aliceKey = await mintAgent(workspace, 'Alice');
    const bobKey = await mintAgent(workspace, 'Bob');

    const alice = await connect(aliceKey);
    const payload = {
      workspaceId: workspace.id,
      type: 'result' as const,
      text: 'Token refresh fails after 24 hours.',
      topic: 'auth',
      source: 'session log',
      idempotencyKey: `retry-${uid()}`,
    };

    const first = await alice.memory.add(payload);
    const retry = await alice.memory.add(payload);

    expect(retry.replayed).toBe(true);
    expect(retry.recordId).toBe(first.recordId);

    // The same sentence from a different agent is a different observation.
    const bob = await connect(bobKey);
    await bob.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'Token refresh fails after 24 hours.',
      topic: 'auth',
      source: 'automated suite',
      idempotencyKey: `bob-${uid()}`,
    });

    const stored = await getPrisma().memoryRecord.count({
      where: { workspaceId: workspace.id, deletedAt: null },
    });
    expect(stored).toBe(2);

    const context = await alice.memory.recall({ workspaceId: workspace.id, query: 'token refresh' });
    const item = context.items.find((candidate) => candidate.text.includes('Token refresh'))!;

    expect(item.merged).toBe(true);
    expect(item.refs.map((ref) => ref.agentName).sort()).toEqual(['Alice', 'Bob']);
    expect(item.refs.map((ref) => ref.source).sort()).toEqual(['automated suite', 'session log']);
  });
});

// ---------------------------------------------------------------------------
describe('Check 3 - two values of one structured fact', () => {
  it('surfaces a visible conflict and overwrites neither version', async () => {
    const workspace = await makeWorkspace();
    const devKey = await mintAgent(workspace, 'Developer');
    const archKey = await mintAgent(workspace, 'Architect');

    const developer = await connect(devKey);
    const local = await developer.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'Project data is stored locally.',
      topic: 'release-1',
      source: 'architecture call',
      factKey: 'storage.location',
      factValue: 'local',
      factContext: 'release-1',
      idempotencyKey: `d-${uid()}`,
    });

    const architect = await connect(archKey);
    const cloud = await architect.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'Project data is stored in the cloud.',
      topic: 'release-1',
      source: 'review meeting',
      factKey: 'storage.location',
      factValue: 'cloud',
      factContext: 'release-1',
      idempotencyKey: `a-${uid()}`,
    });

    const conflicts = await developer.conflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.status).toBe('open');
    expect(conflicts[0]!.sides.map((side) => side.value).sort()).toEqual(['cloud', 'local']);

    // Both records are still current and intact.
    const inspected = await developer.memory.inspect({ workspaceId: workspace.id });
    const ids = inspected.records.map((record) => record.recordId);
    expect(ids).toContain(local.recordId);
    expect(ids).toContain(cloud.recordId);

    // And recall reports the disagreement rather than picking a winner.
    const context = await developer.memory.recall({
      workspaceId: workspace.id,
      query: 'where is data stored',
    });
    expect(context.conflicts).toHaveLength(1);
    expect(context.conflicts[0]!.resolution).toBeNull();
  });

  it('keeps both sides visible even when the budget is far too small', async () => {
    const workspace = await makeWorkspace();
    const aKey = await mintAgent(workspace, 'A');
    const bKey = await mintAgent(workspace, 'B');

    const a = await connect(aKey);
    await a.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'A long explanation of why storage should be local. '.repeat(20),
      topic: 'storage',
      source: 's',
      factKey: 'storage.location',
      factValue: 'local',
      idempotencyKey: `a-${uid()}`,
    });

    const b = await connect(bKey);
    await b.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'A long explanation of why storage should be in the cloud. '.repeat(20),
      topic: 'storage',
      source: 's',
      factKey: 'storage.location',
      factValue: 'cloud',
      idempotencyKey: `b-${uid()}`,
    });

    const context = await a.memory.recall({
      workspaceId: workspace.id,
      query: 'storage',
      limit: 300,
    });

    // SS3.4 step 3: an explicit flag and references, never one "correct" side.
    expect(context.incomplete).toBe(true);
    expect(context.conflicts).toHaveLength(1);
    expect(context.conflicts[0]!.sides).toHaveLength(2);
    expect(context.conflicts[0]!.sides.map((side) => side.value).sort()).toEqual(['cloud', 'local']);
    expect(context.notes.join(' ')).toMatch(/No side was chosen/i);
  });
});

// ---------------------------------------------------------------------------
describe('Check 4 - concurrent writes and a restart', () => {
  it('keeps every acknowledged record and makes version conflicts explicit', async () => {
    const workspace = await makeWorkspace();
    // canExport is off by default; this check reads everything back after a
    // restart, so the grant is part of the fixture rather than the assertion.
    const agentKey = await mintAgent(workspace, 'Worker', { canExport: true });
    const agent = await connect(agentKey);

    // Twelve concurrent independent writes.
    const writes = Array.from({ length: 12 }, (_, index) =>
      agent.memory.add({
        workspaceId: workspace.id,
        type: 'result' as const,
        text: `Concurrent finding number ${index}.`,
        topic: 'load',
        source: `worker-${index}`,
        idempotencyKey: `w-${index}-${uid()}`,
      })
    );

    const settled = await Promise.allSettled(writes);
    const acknowledged = settled
      .filter((outcome): outcome is PromiseFulfilledResult<{ recordId: string }> =>
        outcome.status === 'fulfilled'
      )
      .map((outcome) => outcome.value.recordId);

    expect(acknowledged.length).toBeGreaterThan(0);

    // Simulate a restart: drop the client entirely and reconnect from disk.
    await disconnectPrisma();
    const reconnected = await connect(agentKey);

    const exported = await reconnected.memory.export({ workspaceId: workspace.id });
    const survivors = new Set(exported.records.map((record) => record.recordId));

    // Every acknowledged write survived the restart.
    for (const recordId of acknowledged) {
      expect(survivors.has(recordId)).toBe(true);
    }

    // And a stale correction is refused loudly, not applied silently.
    const base = acknowledged[0]!;
    await reconnected.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'Corrected once.',
      topic: 'load',
      source: 'fix',
      correctsRecordId: base,
      expectedVersion: 1,
      idempotencyKey: `fix1-${uid()}`,
    });

    await expect(
      reconnected.memory.add({
        workspaceId: workspace.id,
        type: 'result',
        text: 'Corrected from a stale read.',
        topic: 'load',
        source: 'fix',
        correctsRecordId: base,
        expectedVersion: 1,
        idempotencyKey: `fix2-${uid()}`,
      })
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});

// ---------------------------------------------------------------------------
describe('Check 5 - querying another workspace, or querying after revocation', () => {
  it('returns no content, no summary and no metadata', async () => {
    const insider = await makeWorkspace();
    const outsider = await makeWorkspace();

    const insiderKey = await mintAgent(insider, 'Insider');
    const inside = await connect(insiderKey);
    await inside.memory.add({
      workspaceId: insider.id,
      type: 'fact',
      text: 'Confidential: the launch date is March.',
      topic: 'launch',
      source: 'board deck',
      idempotencyKey: `i-${uid()}`,
    });

    const outsiderKey = await mintAgent(outsider, 'Outsider');
    const outside = await connect(outsiderKey);

    // Cross-workspace: every operation is refused, and none of them leak a count.
    for (const attempt of [
      () => outside.memory.recall({ workspaceId: insider.id, query: 'launch' }),
      () => outside.memory.inspect({ workspaceId: insider.id }),
      () => outside.memory.export({ workspaceId: insider.id }),
      () => outside.memory.merge({ workspaceId: insider.id }),
    ]) {
      const error = await attempt().catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error.message)).not.toContain('March');
      expect(String(error.message)).not.toContain('launch');
      expect(error.code).toBe('ACCESS_DENIED');
    }

    // Revocation: a key that worked a moment ago now yields nothing.
    const revokedKey = await mintAgent(insider, 'Contractor');
    const contractor = await connect(revokedKey);

    const before = await contractor.memory.recall({ workspaceId: insider.id, query: 'launch' });
    expect(before.items.length).toBeGreaterThan(0);

    await revokeAgent(insider.ownerPrincipal, insider.id, (await getPrisma().agent.findFirstOrThrow({
      where: { workspaceId: insider.id, name: 'Contractor' },
    })).id);

    const after = await contractor.memory
      .recall({ workspaceId: insider.id, query: 'launch' })
      .catch((error) => error);

    expect(after).toBeInstanceOf(Error);
    expect(after.code).toBe('REVOKED');
    expect(String(after.message)).not.toContain('March');
  });
});

// ---------------------------------------------------------------------------
describe('Check 6 - delete a source after creating a summary', () => {
  it('returns neither the source nor its dependent block', async () => {
    const workspace = await makeWorkspace();
    const ownerMemory = workspace.ownerMemory;

    const agentKey = await mintAgent(workspace, 'Tester');
    const tester = await connect(agentKey);

    await tester.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'Keeps working after deletion of its neighbour.',
      topic: 'release-1',
      source: 'note',
      idempotencyKey: `keep-${uid()}`,
    });

    const doomed = await tester.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'SECRET-MARKER one saved record disappears after a restart.',
      topic: 'release-1',
      source: 'regression run #148',
      idempotencyKey: `doom-${uid()}`,
    });

    // Create the summary FIRST, so deletion has a dependent block to clean up.
    const merged = await ownerMemory.merge({
      workspaceId: workspace.id,
      idempotencyKey: `m-${uid()}`,
    });
    expect(JSON.stringify(merged.blocks)).toContain('SECRET-MARKER');

    await ownerMemory.forget({
      workspaceId: workspace.id,
      recordId: doomed.recordId,
      purge: true,
      reason: 'acceptance check 6',
      idempotencyKey: `f-${uid()}`,
    });

    // Neither the source...
    const recalled = await ownerMemory.recall({ workspaceId: workspace.id, query: 'restart' });
    expect(JSON.stringify(recalled)).not.toContain('SECRET-MARKER');

    const exported = await ownerMemory.export({ workspaceId: workspace.id });
    expect(JSON.stringify(exported)).not.toContain('SECRET-MARKER');

    // ...nor the block that was built from it.
    const blocks = await ownerMemory.blocks(workspace.id);
    expect(JSON.stringify(blocks)).not.toContain('SECRET-MARKER');

    const inspected = await ownerMemory.inspect({ workspaceId: workspace.id });
    expect(JSON.stringify(inspected)).not.toContain('SECRET-MARKER');

    // The surviving record is untouched.
    expect(JSON.stringify(recalled)).toContain('Keeps working after deletion');
  });
});

// ---------------------------------------------------------------------------
describe('Check 7 - the same query through SDK and MCP', () => {
  it('returns the same context for identical permissions, data and settings', async () => {
    const workspace = await makeWorkspace();

    const writerKey = await mintAgent(workspace, 'Writer');
    const writer = await connect(writerKey);

    await writer.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      source: 'brief',
      idempotencyKey: `w1-${uid()}`,
    });
    await writer.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'Project data is stored locally.',
      topic: 'release-1',
      source: 'call',
      factKey: 'storage.location',
      factValue: 'local',
      idempotencyKey: `w2-${uid()}`,
    });
    await writer.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'One saved record disappears after a restart.',
      topic: 'release-1',
      source: 'run #148',
      idempotencyKey: `w3-${uid()}`,
    });

    // ONE key, used through two different surfaces: identical permissions by
    // construction, so any difference in output would be a real divergence.
    const readerKey = await mintAgent(workspace, 'Reader');

    const query = {
      workspaceId: workspace.id,
      query: 'what remains before release?',
      limit: 4000,
      useCache: false,
    };

    // Surface A: the SDK.
    const sdkClient = await connect(readerKey);
    const viaSdk = await sdkClient.memory.recall(query);

    // Surface B: the MCP tool dispatch, exactly as the stdio server calls it.
    const mcpPrincipal = await authenticateAgent(readerKey);
    const mcpMemory = new Memory(mcpPrincipal);
    const viaMcp = await callTool(mcpMemory, 'offcut_memory_recall', query);

    expect(JSON.stringify(viaMcp)).toBe(JSON.stringify(viaSdk));
  });

  it('enforces the same permissions through both surfaces', async () => {
    const workspace = await makeWorkspace();
    const limitedKey = await mintAgent(workspace, 'Limited', {
      canRead: true,
      canWrite: true,
      canExport: false,
    });

    const sdkClient = await connect(limitedKey);
    const sdkError = await sdkClient.memory
      .export({ workspaceId: workspace.id })
      .catch((error) => error);

    const mcpMemory = new Memory(await authenticateAgent(limitedKey));
    const mcpError = await callTool(mcpMemory, 'offcut_memory_export', {
      workspaceId: workspace.id,
    }).catch((error) => error);

    expect(sdkError.code).toBe('ACCESS_DENIED');
    expect(mcpError.code).toBe('ACCESS_DENIED');
    expect(sdkError.message).toBe(mcpError.message);
  });

  it('writes through MCP and reads the result through the SDK', async () => {
    const workspace = await makeWorkspace();
    const agentKey = await mintAgent(workspace, 'Bridge');

    const mcpMemory = new Memory(await authenticateAgent(agentKey));
    await callTool(mcpMemory, 'offcut_memory_add', {
      workspaceId: workspace.id,
      type: 'decision',
      text: 'Written through MCP, read through the SDK.',
      topic: 'parity',
      source: 'acceptance',
      idempotencyKey: `mcp-${uid()}`,
    });

    const sdkClient = await connect(agentKey);
    const context = await sdkClient.memory.recall({
      workspaceId: workspace.id,
      query: 'parity',
    });

    expect(context.items.map((item) => item.text)).toContain(
      'Written through MCP, read through the SDK.'
    );
  });
});

// ---------------------------------------------------------------------------
describe('Check 8 - no token and no external model connected', () => {
  it('still writes, merges, retrieves, deletes and exports', async () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.OFFCUT_TOKEN_ADDRESS).toBeUndefined();
    expect(process.env.OFFCUT_RPC_URL).toBeUndefined();

    const workspace = await makeWorkspace();
    const agentKey = await mintAgent(workspace, 'Offline', {
      canImport: true,
      canExport: true,
      canForget: true,
    });
    const agent = await connect(agentKey);

    const added = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'No wallet was required to save this.',
      topic: 'independence',
      source: 'acceptance',
      idempotencyKey: `a-${uid()}`,
    });

    const imported = await agent.memory.import({
      workspaceId: workspace.id,
      records: [{ type: 'result', text: 'Imported offline.', topic: 'independence', source: 'file' }],
      idempotencyKey: `i-${uid()}`,
    });
    expect(imported.imported).toBe(1);

    const merged = await agent.memory.merge({
      workspaceId: workspace.id,
      idempotencyKey: `m-${uid()}`,
    });
    expect(merged.blocks.length).toBeGreaterThan(0);

    const recalled = await agent.memory.recall({
      workspaceId: workspace.id,
      query: 'independence',
    });
    expect(recalled.items.length).toBeGreaterThan(0);

    const exported = await agent.memory.export({ workspaceId: workspace.id });
    expect(exported.counts.records).toBeGreaterThan(0);

    const forgotten = await agent.memory.forget({
      workspaceId: workspace.id,
      recordId: added.recordId,
      idempotencyKey: `f-${uid()}`,
    });
    expect(forgotten.deletedRecordIds).toContain(added.recordId);
  });
});

// ---------------------------------------------------------------------------
describe('PRIMARY acceptance check - a new agent continues the task from merged memory', () => {
  /**
   * The scenario of SS3.6, end to end.
   *
   * Three subagents work in three separate sessions. A fourth agent, created
   * afterwards and present for none of them, asks one question. SS7.1 calls this
   * the primary check: it must work "without the user manually repeating" any of
   * the earlier conversations.
   */
  it('answers "what remains before release?" from three sessions it never attended', async () => {
    const workspace = await makeWorkspace();

    // --- Session 1: the researcher -------------------------------------
    const researcher = await connect(await mintAgent(workspace, 'Researcher'));
    const r1 = await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      source: 'product brief, section 2',
      idempotencyKey: `r1-${uid()}`,
    });
    await researcher.close();

    // --- Session 2: the developer --------------------------------------
    const developer = await connect(await mintAgent(workspace, 'Developer'));
    const d1 = await developer.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'Project data is stored locally.',
      topic: 'release-1',
      source: 'architecture call 2026-09-02',
      factKey: 'storage.location',
      factValue: 'local',
      factContext: 'release-1',
      idempotencyKey: `d1-${uid()}`,
    });
    await developer.close();

    // --- Session 3: the tester -----------------------------------------
    const tester = await connect(await mintAgent(workspace, 'Tester'));
    const t1 = await tester.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'One saved record disappears after a restart.',
      topic: 'release-1',
      source: 'regression run #148',
      idempotencyKey: `t1-${uid()}`,
    });
    await tester.close();

    // --- Session 4: a brand new lead agent -----------------------------
    const lead = await connect(await mintAgent(workspace, 'New Lead'));
    const context = await lead.memory.recall({
      workspaceId: workspace.id,
      query: 'What remains before release?',
    });

    const combined = context.items.map((item) => item.text).join(' | ');

    // All three findings arrive in ONE context.
    expect(combined).toContain('must work offline');
    expect(combined).toContain('stored locally');
    expect(combined).toContain('disappears after a restart');

    // Each carries its reference back to R1, D1 and T1.
    const citedRecordIds = new Set(
      context.items.flatMap((item) => item.refs.map((ref) => ref.recordId))
    );
    expect(citedRecordIds.has(r1.recordId)).toBe(true);
    expect(citedRecordIds.has(d1.recordId)).toBe(true);
    expect(citedRecordIds.has(t1.recordId)).toBe(true);

    // And each names the agent who found it.
    const citedAgents = new Set(
      context.items.flatMap((item) => item.refs.map((ref) => ref.agentName))
    );
    expect(citedAgents).toContain('Researcher');
    expect(citedAgents).toContain('Developer');
    expect(citedAgents).toContain('Tester');
  });

  it('does not erase T1 when a later record says the bug was fixed', async () => {
    const workspace = await makeWorkspace();

    const tester = await connect(await mintAgent(workspace, 'Tester'));
    const t1 = await tester.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'One saved record disappears after a restart.',
      topic: 'release-1',
      source: 'regression run #148',
      idempotencyKey: `t1-${uid()}`,
    });

    const developer = await connect(await mintAgent(workspace, 'Developer'));
    await developer.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'The restart recovery bug is fixed.',
      topic: 'release-1',
      source: 'commit a91f2c',
      // SS3.6: the fix "links to T1 as an update with its own source".
      links: [{ kind: 'updates', recordId: t1.recordId, note: 'fix for the restart bug' }],
      idempotencyKey: `fix-${uid()}`,
    });

    // T1 is still there, with its own author and evidence.
    const inspected = await developer.memory.inspect({
      workspaceId: workspace.id,
      recordId: t1.recordId,
    });

    const record = inspected.records[0]!;
    expect(record.text).toBe('One saved record disappears after a restart.');
    expect(record.agentName).toBe('Tester');
    expect(record.source).toBe('regression run #148');

    // And the update points at it explicitly.
    expect(record.linksIn.some((link) => link.kind === 'updates')).toBe(true);
  });
});
