/**
 * SS3.3 row 5 - "An uncertain semantic relationship -> keeps records separate;
 * nothing is discarded for a cleaner summary." And SS7's first risk, which is
 * the same sentence read as a danger: "combining different facts because the
 * wording is similar".
 *
 * merge.ts says the engine needs an explicit signal before it groups anything -
 * an identical content hash, a shared topic, a declared link, or a matching
 * fact key. That is a claim about what the code does NOT do, and until now it
 * was only readable in the comments. These tests feed it pairs that a similarity
 * model would happily fold together and require that it leaves them alone.
 *
 * The last test is the control, and it is the reason the others mean anything:
 * give the same pair an explicit signal and the engine DOES act. Without it,
 * every assertion below could be satisfied by an engine that merges nothing at
 * all.
 */

import { describe, expect, it } from 'vitest';
import { key, makeAgent, makeWorkspace } from './helpers';

describe('SS3.3 row 5 - an uncertain relationship leaves records separate', () => {
  it('keeps two near-identical sentences as two items, collapsing neither', async () => {
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');
    const developer = await makeAgent(workspace, 'Developer');

    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      source: 'product brief, section 2',
      idempotencyKey: key('near-a'),
    });

    // Same idea in other words. No shared fact key, no link: the relationship
    // is a guess, and a guess is not a signal.
    await developer.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The app should keep working without a network connection.',
      topic: 'release-1',
      source: 'architecture call 2026-09-02',
      idempotencyKey: key('near-b'),
    });

    const merged = await researcher.memory.merge({
      workspaceId: workspace.id,
      idempotencyKey: key('near-merge'),
    });

    const block = merged.blocks.find((entry) => entry.topic === 'release-1');
    expect(block).toBeDefined();
    expect(block!.items).toHaveLength(2);
    expect(merged.duplicatesCollapsed).toBe(0);
    expect(block!.items.every((item) => item.merged === false)).toBe(true);

    // Both sentences survive verbatim - nothing was rewritten into one tidier one.
    expect(block!.items.map((item) => item.text).sort()).toEqual([
      'The app should keep working without a network connection.',
      'The application must work offline.',
    ]);
  });

  it('flags no conflict between two contradictory sentences in free text', async () => {
    const workspace = await makeWorkspace();
    const developer = await makeAgent(workspace, 'Developer');
    const tester = await makeAgent(workspace, 'Tester');

    await developer.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'The release goes out on Friday.',
      topic: 'release-1',
      source: 'planning call',
      idempotencyKey: key('prose-a'),
    });

    await tester.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'The release goes out on Monday.',
      topic: 'release-1',
      source: 'standup notes',
      idempotencyKey: key('prose-b'),
    });

    const merged = await developer.memory.merge({
      workspaceId: workspace.id,
      idempotencyKey: key('prose-merge'),
    });

    // SS3.3: "Detecting every contradiction in free text is not promised."
    // Announcing one here would be an invented finding, and the next one would
    // be a false one.
    expect(merged.conflicts).toEqual([]);

    const recalled = await tester.memory.recall({
      workspaceId: workspace.id,
      query: 'when does the release go out',
    });
    expect(recalled.conflicts).toEqual([]);
    // Both remain readable, so a human can see the disagreement the engine did
    // not claim to have detected.
    const texts = recalled.items.map((item) => item.text);
    expect(texts).toContain('The release goes out on Friday.');
    expect(texts).toContain('The release goes out on Monday.');
  });

  it('counts unrelated records as kept-separate instead of joining them', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Solo', { canExport: true });

    await agent.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'Latency dropped after the cache change.',
      topic: 'performance',
      source: 'benchmark run',
      idempotencyKey: key('sep-a'),
    });

    await agent.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'Latency of the import path is unchanged.',
      topic: 'import',
      source: 'benchmark run',
      idempotencyKey: key('sep-b'),
    });

    const merged = await agent.memory.merge({
      workspaceId: workspace.id,
      idempotencyKey: key('sep-merge'),
    });

    // Two topics, two blocks, and the engine reports what it declined to do.
    expect(merged.blocks).toHaveLength(2);
    expect(merged.keptSeparate).toBe(2);

    // "Nothing is discarded for a cleaner summary": both are still exportable.
    const exported = await agent.memory.export({ workspaceId: workspace.id });
    expect(exported.counts.records).toBe(2);
  });

  it('does act when the relationship is stated explicitly', async () => {
    const workspace = await makeWorkspace();
    const developer = await makeAgent(workspace, 'Developer');
    const operator = await makeAgent(workspace, 'Operator');

    // The same disagreement as the second test, but now named as one fact.
    await developer.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'Project data is stored locally.',
      topic: 'release-1',
      source: 'architecture call',
      factKey: 'storage.location',
      factValue: 'local',
      factContext: 'release-1',
      idempotencyKey: key('ctrl-a'),
    });

    await operator.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'Project data is stored in the hosted store.',
      topic: 'release-1',
      source: 'operations review',
      factKey: 'storage.location',
      factValue: 'hosted',
      factContext: 'release-1',
      idempotencyKey: key('ctrl-b'),
    });

    const merged = await developer.memory.merge({
      workspaceId: workspace.id,
      idempotencyKey: key('ctrl-merge'),
    });

    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]!.factKey).toBe('storage.location');
    expect(merged.conflicts[0]!.sides.map((side) => side.value).sort()).toEqual([
      'hosted',
      'local',
    ]);
  });
});
