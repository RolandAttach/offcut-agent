/**
 * SS2, the Context row: "the relevant portion of merged memory within the
 * caller's permissions and size limit"; SS3.4 steps 1-3; and SS7's second risk,
 * "losing context through shortening", whose mitigation is to preserve source
 * records and return references plus an incompleteness indicator.
 *
 * The suite already pins the hardest corner of this - a budget too small to
 * hold both sides of a conflict returns a flag and references rather than one
 * supposedly correct side. What was missing is the ordinary case: an answer
 * that has to stop, and stops honestly.
 *
 * Note what is NOT asserted here. No maximum context size, no default, no
 * number of records: the limit is OPEN-3 and a test that fixed one would be
 * inventing the decision. Every budget below is one the CALLER passed in, which
 * is the part of the clause that is about behaviour rather than about a number
 * somebody still has to choose.
 */

import { describe, expect, it } from 'vitest';
import { key, makeAgent, makeWorkspace } from './helpers';

/** Twelve records of roughly equal size, more than a small budget can hold. */
async function seedMany(workspaceId: string, agent: Awaited<ReturnType<typeof makeAgent>>) {
  for (let index = 0; index < 12; index += 1) {
    await agent.memory.add({
      workspaceId,
      type: 'result',
      text: `Regression ${index}: the import path handled a file of ${index} thousand records.`,
      topic: 'release-1',
      source: `regression run #${index}`,
      idempotencyKey: key(`limit-${index}`),
    });
  }
}

describe('SS2/SS3.4 - context comes back inside the budget it was given', () => {
  it('spends no more characters than the caller allowed, and says it stopped', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Lead');
    await seedMany(workspace.id, agent);

    const tight = await agent.memory.recall({
      workspaceId: workspace.id,
      query: 'import path regression',
      limit: 300,
    });

    expect(tight.limit).toBe(300);
    expect(tight.usedCharacters).toBeLessThanOrEqual(300);
    expect(tight.items.length).toBeGreaterThan(0);
    expect(tight.items.length).toBeLessThan(12);

    // The indicator SS7 asks for, and a note that says what was left out.
    expect(tight.incomplete).toBe(true);
    expect(tight.notes.join(' ')).toContain('Source records are unchanged.');

    // Every item that did come back can be traced to the record it came from:
    // shortening loses items, never their provenance.
    for (const item of tight.items) {
      expect(item.refs.length).toBeGreaterThan(0);
      expect(item.refs[0]!.recordId).toBeTruthy();
      expect(item.refs[0]!.source).toBeTruthy();
    }
  });

  it('stops at the number of items the caller asked for', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Lead');
    await seedMany(workspace.id, agent);

    const capped = await agent.memory.recall({
      workspaceId: workspace.id,
      query: 'import path regression',
      limit: 50_000,
      maxItems: 3,
    });

    expect(capped.items).toHaveLength(3);
    expect(capped.incomplete).toBe(true);
    expect(capped.notes.join(' ')).toContain('maxItems');
  });

  it('loses nothing from the store when an answer is shortened', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Lead', { canExport: true });
    await seedMany(workspace.id, agent);

    const tight = await agent.memory.recall({
      workspaceId: workspace.id,
      query: 'import path regression',
      limit: 300,
    });
    expect(tight.incomplete).toBe(true);

    // SS7's mitigation: the sources are preserved. A wider budget reaches them
    // all, and so does an export - the trimming happened to the answer, not to
    // the memory.
    const wide = await agent.memory.recall({
      workspaceId: workspace.id,
      query: 'import path regression',
      limit: 50_000,
      maxItems: 100,
    });
    expect(wide.items).toHaveLength(12);
    expect(wide.incomplete).toBe(false);

    const exported = await agent.memory.export({ workspaceId: workspace.id });
    expect(exported.counts.records).toBe(12);
  });

  it('never spends the budget on records the caller may not see', async () => {
    const workspace = await makeWorkspace();
    const author = await makeAgent(workspace, 'Author');
    const reader = await makeAgent(workspace, 'Reader');

    await seedMany(workspace.id, author);
    await author.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'A private note that must not reach the reader at any budget.',
      topic: 'release-1',
      source: 'private working notes',
      scope: 'private',
      idempotencyKey: key('limit-private'),
    });

    for (const limit of [200, 5_000, 50_000]) {
      const recalled = await reader.memory.recall({
        workspaceId: workspace.id,
        query: 'private note budget',
        limit,
        maxItems: 100,
      });
      // "Within the caller's permissions" comes first: the filter is applied
      // before the budget, so an inaccessible record is not even a candidate.
      expect(JSON.stringify(recalled)).not.toContain('must not reach the reader');
      expect(recalled.consideredRecords).toBe(12);
    }
  });
});
