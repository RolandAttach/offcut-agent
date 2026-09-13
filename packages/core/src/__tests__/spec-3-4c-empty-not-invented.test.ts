/**
 * SS3.4 step 4 - "When no data exists, it returns an empty result. Memory is not
 * replaced with an invented answer."
 *
 * The suite already checked this sideways, through rewards: a recall that
 * returned nothing credits nobody. That pins the accounting, not the promise.
 * What the clause is actually about is the moment a product is tempted to be
 * helpful - an empty workspace, a question nothing matches, a caller who may
 * see none of the records - and the only honest output is nothing.
 *
 * Three shapes of "no data", then the line the builder does NOT cross when
 * records do exist but the words miss: it says so in a note and returns stored
 * text, rather than writing an answer of its own.
 */

import { describe, expect, it } from 'vitest';
import { key, makeAgent, makeWorkspace } from './helpers';

describe('SS3.4 step 4 - no data means an empty result', () => {
  it('returns nothing at all from an empty workspace', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Lead');

    const recalled = await agent.memory.recall({
      workspaceId: workspace.id,
      query: 'what remains before release?',
    });

    expect(recalled.items).toEqual([]);
    expect(recalled.conflicts).toEqual([]);
    expect(recalled.consideredRecords).toBe(0);
    expect(recalled.usedCharacters).toBe(0);
    expect(recalled.incomplete).toBe(false);
    // The notes explain the emptiness; they are not an answer to the question.
    expect(recalled.notes).toEqual(['No accessible records matched this query.']);
    expect(recalled.notes.join(' ')).not.toMatch(/release/i);
  });

  it('returns nothing when every record belongs to another agent privately', async () => {
    const workspace = await makeWorkspace();
    const author = await makeAgent(workspace, 'Author');
    const reader = await makeAgent(workspace, 'Reader');

    await author.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'Kept to myself.',
      topic: 'notes',
      source: 'private working notes',
      scope: 'private',
      idempotencyKey: key('empty-private'),
    });

    const recalled = await reader.memory.recall({
      workspaceId: workspace.id,
      query: 'kept to myself',
    });

    // Not a summary of what it cannot show, not a count of it: nothing.
    expect(recalled.items).toEqual([]);
    expect(recalled.consideredRecords).toBe(0);
    expect(JSON.stringify(recalled)).not.toContain('Kept to myself.');
  });

  it('returns nothing after the only record is deleted', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Lead', { canForget: true });

    const added = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'The only thing we knew.',
      topic: 'release-1',
      source: 'regression run',
      idempotencyKey: key('empty-forget'),
    });

    await agent.memory.forget({
      workspaceId: workspace.id,
      recordId: added.recordId,
      idempotencyKey: key('empty-forget-2'),
    });

    const recalled = await agent.memory.recall({
      workspaceId: workspace.id,
      query: 'the only thing we knew',
    });

    expect(recalled.items).toEqual([]);
    expect(recalled.notes).toEqual(['No accessible records matched this query.']);
  });

  it('says so, and returns stored text, when the question matches nothing', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Lead');

    await agent.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'Project data is stored locally.',
      topic: 'architecture',
      source: 'architecture call',
      idempotencyKey: key('empty-miss'),
    });

    const recalled = await agent.memory.recall({
      workspaceId: workspace.id,
      query: 'quarterly revenue forecast',
    });

    // The records exist and the caller may read them, so the builder shows the
    // most recent ones - and labels that it is doing so. What it must never do
    // is answer the question it could not match.
    expect(recalled.notes).toContain(
      'No term matched the query; showing the most recent records instead.'
    );
    expect(recalled.items.map((item) => item.text)).toEqual(['Project data is stored locally.']);
    expect(recalled.items.every((item) => item.refs.length > 0)).toBe(true);
  });
});
