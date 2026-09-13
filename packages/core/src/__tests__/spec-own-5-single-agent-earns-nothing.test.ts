/**
 * The owner's accepted consequence, written down on 2026-09-15: a user running
 * ONE agent earns nothing, because nobody else is there to retrieve what it
 * saved. SS1 treats that as the normal case - the product is about several
 * agents sharing memory - rather than as a defect to be papered over with a
 * participation payout.
 *
 * credits.test.ts pins the two halves separately: writing earns nothing, and
 * reading your own records back earns nothing. This runs the consequence as the
 * scenario it actually is - one agent, a week of records, every one of them
 * read back - and requires the total to be zero. If a "solo bonus" were ever
 * added to make the number less discouraging, this is what would go red.
 */

import { describe, expect, it } from 'vitest';
import { getPrisma } from '../db';
import { earnedEver } from '../credits';
import { key, makeAgent, makeWorkspace } from './helpers';

describe('The accepted consequence - one agent earns nothing', () => {
  it('earns nothing however much the single agent writes and reads back', async () => {
    const workspace = await makeWorkspace();
    const solo = await makeAgent(workspace, 'Solo', { canExport: true });

    for (let index = 0; index < 5; index += 1) {
      await solo.memory.add({
        workspaceId: workspace.id,
        type: 'result',
        text: `Day ${index}: the import path still passes.`,
        topic: 'release-1',
        source: `regression run #${index}`,
        idempotencyKey: key(`solo-${index}`),
      });
    }

    await solo.memory.merge({ workspaceId: workspace.id, idempotencyKey: key('solo-merge') });

    // Read it all back, repeatedly - a loop is not a salary.
    for (const query of ['import path', 'release', 'regression']) {
      const recalled = await solo.memory.recall({ workspaceId: workspace.id, query });
      expect(recalled.items.length).toBeGreaterThan(0);
    }

    const db = getPrisma();
    expect(await earnedEver(db, workspace.id)).toBe(0);
    expect(await db.rewardCredit.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('starts earning the moment a second agent uses that memory', async () => {
    // The control. Without it the test above could be satisfied by a product
    // that never credits anyone, which is a different claim entirely.
    const workspace = await makeWorkspace();
    const first = await makeAgent(workspace, 'Researcher');
    const second = await makeAgent(workspace, 'Lead');

    await first.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      source: 'product brief, section 2',
      idempotencyKey: key('solo-ctrl'),
    });

    await second.memory.recall({ workspaceId: workspace.id, query: 'offline' });

    const db = getPrisma();
    expect(await earnedEver(db, workspace.id)).toBeGreaterThan(0);
  });
});
