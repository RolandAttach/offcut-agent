/**
 * SS1.3 - "It is not a relayer: it stores, merges, and retrieves memory itself
 * rather than only forwarding requests."
 *
 * The clause is a negative, and a negative is only pinnable if you can name the
 * thing that must not happen. Here it is forwarding: a relayer would hand the
 * question to something upstream and pass the answer back. So this file holds
 * the memory path against three separate checks, each of which a relayer would
 * fail.
 *
 *   1. Every outbound call is trapped. The whole cycle - add, import, merge,
 *      recall, inspect, export, forget - has to complete with fetch throwing.
 *   2. The bytes are in OFFCUT's own store. The record is read straight out of
 *      the tables, not through the API that wrote it.
 *   3. The merge is computed here. The client is thrown away and rebuilt, and
 *      two agents' identical note still collapses to one item carrying both
 *      authors - work that no cache and no upstream did for us.
 *
 * What this does not prove: that no OTHER process on the machine is contacted
 * by some means other than fetch. The static check below is what covers the
 * rest of the memory path, by reading the files themselves.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disconnectPrisma, getPrisma } from '../db';
import { authenticateAgent } from '../access';
import { Memory } from '../memory';
import { key, makeAgent, makeLead, makeWorkspace } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..');

/** Replaces fetch with something that records the attempt and then fails. */
function trapNetwork(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (input: unknown) => {
    calls.push(String(input));
    throw new Error('outbound call attempted: OFFCUT is not a relayer (SS1.3)');
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SS1.3 - OFFCUT stores, merges and retrieves memory itself', () => {
  it('runs the whole memory cycle with every outbound call trapped', async () => {
    const trap = trapNetwork();

    const workspace = await makeWorkspace();
    const agent = await makeLead(workspace, 'Lead', {
      canForget: true,
      canExport: true,
      canImport: true,
    });

    const added = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'Context is assembled locally.',
      topic: 'architecture',
      source: 'this test',
      idempotencyKey: key('relay-add'),
    });

    const imported = await agent.memory.import({
      workspaceId: workspace.id,
      records: [
        {
          type: 'fact',
          text: 'Imported straight from a file.',
          topic: 'architecture',
          source: 'legacy export',
        },
      ],
      idempotencyKey: key('relay-import'),
    });
    expect(imported.imported).toBe(1);

    const merged = await agent.memory.merge({
      workspaceId: workspace.id,
      idempotencyKey: key('relay-merge'),
    });
    expect(merged.blocks.length).toBeGreaterThan(0);

    const recalled = await agent.memory.recall({
      workspaceId: workspace.id,
      query: 'context assembled locally',
    });
    expect(recalled.items.length).toBeGreaterThan(0);

    const inspected = await agent.memory.inspect({ workspaceId: workspace.id });
    expect(inspected.returned).toBeGreaterThan(0);

    const exported = await agent.memory.export({ workspaceId: workspace.id });
    expect(exported.counts.records).toBeGreaterThan(0);

    const forgotten = await agent.memory.forget({
      workspaceId: workspace.id,
      recordId: added.recordId,
      idempotencyKey: key('relay-forget'),
    });
    expect(forgotten.deletedRecordIds).toContain(added.recordId);

    // The point of the whole test: nothing was forwarded anywhere.
    expect(trap.calls).toEqual([]);
  });

  it('holds the record in its own store rather than pointing at someone else', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Researcher');

    const added = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The store is ours.',
      topic: 'architecture',
      source: 'this test',
      idempotencyKey: key('relay-store'),
    });

    // Read the row directly. A relayer would have nothing to show here: the
    // text would live wherever it forwarded the write to.
    const rows = await getPrisma().memoryRecord.findMany({
      where: { workspaceId: workspace.id, recordId: added.recordId },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('The store is ours.');
    expect(rows[0]!.agentId).toBe(agent.id);
  });

  it('computes the merge itself, after the client has been thrown away', async () => {
    const workspace = await makeWorkspace();
    const first = await makeAgent(workspace, 'Tester A');
    const second = await makeAgent(workspace, 'Tester B');

    // The same note from two agents: SS3.3 rule 1 says retrieval shows one item
    // while keeping both authors. Somebody has to do that work.
    for (const agent of [first, second]) {
      await agent.memory.add({
        workspaceId: workspace.id,
        type: 'result',
        text: 'The suite passes on a clean checkout.',
        topic: 'release-1',
        source: `run by ${agent.name}`,
        idempotencyKey: key('relay-dupe'),
      });
    }

    // Drop the client, so nothing in process memory can be answering.
    await disconnectPrisma();

    const trap = trapNetwork();
    const principal = await authenticateAgent(first.apiKey);
    const context = await new Memory(principal).recall({
      workspaceId: workspace.id,
      query: 'suite passes clean checkout',
    });

    const item = context.items.find((entry) => entry.text === 'The suite passes on a clean checkout.');
    expect(item).toBeDefined();
    expect(item!.merged).toBe(true);
    expect(item!.refs.map((ref) => ref.agentName).sort()).toEqual(['Tester A', 'Tester B']);
    expect(trap.calls).toEqual([]);
  });

  it('carries no outbound client anywhere in the memory path', async () => {
    // The runtime trap covers what these tests exercise; this covers the rest of
    // the file. SS9's model module is the one place text may leave, with the
    // owner's permission, and it is not in this list.
    const memoryPath = [
      'memory.ts',
      'merge.ts',
      'context.ts',
      'store.ts',
      'access.ts',
      'db.ts',
      'ledger.ts',
      'credits.ts',
    ];

    const offenders: string[] = [];
    for (const file of memoryPath) {
      const source = fs.readFileSync(path.join(srcDir, file), 'utf8');
      if (/\bfetch\s*\(|node:https?|\baxios\b|\bundici\b|XMLHttpRequest/.test(source)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
