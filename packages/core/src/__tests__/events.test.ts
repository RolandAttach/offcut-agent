/**
 * The live feed's half of the store.
 *
 * The console watches a workspace work: records, conflicts and resolutions
 * landing as the agents write them. Everything it sees comes from the
 * append-only trail, read forward from a cursor, and the whole of the design is
 * in that one word - append-only. Nothing here rewrites history, so the only
 * thing that can go wrong is the reading: an entry delivered twice, or an entry
 * never delivered at all.
 *
 * So these tests are about the seam. A cursor that re-sends what the caller
 * already has makes the feed a liar; a cursor that steps over an entry makes it
 * a worse one, because the console then shows a workspace as quieter than it
 * was. Both failures live in the same place - the millisecond two writes share.
 */

import { describe, expect, it } from 'vitest';
import { getPrisma } from '../db';
import { key, makeAgent, makeOwner, makeWorkspace } from './helpers';

/**
 * Appends a trail entry at an exact instant.
 *
 * Written straight to the table on purpose: the point of these tests is what
 * happens when two entries share a millisecond, and no public operation lets a
 * test ask for that. The shape matches what store.audit() writes.
 */
async function appendAt(workspaceId: string, action: string, at: Date, targetId = '') {
  return getPrisma().auditEvent.create({
    data: {
      workspaceId,
      actorType: 'system',
      actorId: 'suite',
      actorName: 'Suite',
      action,
      targetId,
      detail: JSON.stringify({ written: 'by the suite' }),
      createdAt: at,
    },
  });
}

// ---------------------------------------------------------------------------
describe('Reading the trail forward', () => {
  it('starts at the head, so the console never re-reads its own snapshot', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Researcher');

    await agent.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      idempotencyKey: key('before'),
    });

    // Where the console stands after drawing its list from timeline().
    const head = await workspace.owner.memory.eventsCursor(workspace.id);

    const nothingNew = await workspace.owner.memory.eventsSince(workspace.id, head);
    expect(nothingNew.events).toEqual([]);
    // An empty page must not drift forward, or it steps over whatever was
    // written while the query was in flight.
    expect(nothingNew.cursor).toEqual(head);
  });

  it('carries an entry written after the cursor, and not the one written before it', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Researcher');

    const earlier = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'decision',
      text: 'Project data is stored locally.',
      topic: 'release-1',
      idempotencyKey: key('earlier'),
    });

    const head = await workspace.owner.memory.eventsCursor(workspace.id);

    const later = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'One saved record disappears after a restart.',
      topic: 'release-1',
      idempotencyKey: key('later'),
    });

    const page = await workspace.owner.memory.eventsSince(workspace.id, head);

    expect(page.events.map((event) => event.targetId)).toEqual([later.recordId]);
    expect(page.events.map((event) => event.targetId)).not.toContain(earlier.recordId);
    expect(page.events[0]!.action).toBe('memory.add');
    // The mapping timeline() uses, detail parsed rather than handed over as text.
    expect(page.events[0]!.detail).toMatchObject({ topic: 'release-1', type: 'result' });
    expect(page.cursor).toEqual({ after: page.events[0]!.createdAt, afterId: page.events[0]!.id });
  });

  it('delivers two entries stamped with the same millisecond once each, over two calls', async () => {
    // The failure this guards is silent. A cursor carrying only a timestamp
    // would either hand back the first entry again on the second call, or skip
    // the second entirely - and the console would show a workspace doing less
    // work than it did, with nothing anywhere to say so.
    const workspace = await makeWorkspace();
    const start = await workspace.owner.memory.eventsCursor(workspace.id);

    const sameInstant = new Date(new Date(start.after).getTime() + 1);
    await appendAt(workspace.id, 'memory.add', sameInstant, 'first-write');
    await appendAt(workspace.id, 'memory.add', sameInstant, 'second-write');

    const first = await workspace.owner.memory.eventsSince(workspace.id, start, 1);
    const second = await workspace.owner.memory.eventsSince(workspace.id, first.cursor, 1);
    const third = await workspace.owner.memory.eventsSince(workspace.id, second.cursor, 1);

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(third.events).toEqual([]);

    const delivered = [...first.events, ...second.events];
    expect(delivered.map((event) => event.createdAt)).toEqual([
      sameInstant.toISOString(),
      sameInstant.toISOString(),
    ]);
    // Two distinct entries, each exactly once.
    expect(new Set(delivered.map((event) => event.id)).size).toBe(2);
    expect(new Set(delivered.map((event) => event.targetId))).toEqual(
      new Set(['first-write', 'second-write'])
    );
  });

  it('reads oldest first, which is the order the work happened in', async () => {
    const workspace = await makeWorkspace();
    const start = await workspace.owner.memory.eventsCursor(workspace.id);
    const base = new Date(start.after).getTime();

    await appendAt(workspace.id, 'memory.add', new Date(base + 30), 'third');
    await appendAt(workspace.id, 'memory.add', new Date(base + 10), 'first');
    await appendAt(workspace.id, 'memory.add', new Date(base + 20), 'second');

    const page = await workspace.owner.memory.eventsSince(workspace.id, start);
    expect(page.events.map((event) => event.targetId)).toEqual(['first', 'second', 'third']);
  });

  it('hands back a page rather than the table, and the cursor to ask for the rest', async () => {
    const workspace = await makeWorkspace();
    const start = await workspace.owner.memory.eventsCursor(workspace.id);
    const base = new Date(start.after).getTime();

    for (let index = 0; index < 201; index += 1) {
      await appendAt(workspace.id, 'memory.add', new Date(base + index + 1), `row-${index}`);
    }

    // Asking for a thousand does not get a thousand: a caller polling a busy
    // workspace is handed a page and told, by its fullness, to come back.
    const page = await workspace.owner.memory.eventsSince(workspace.id, start, 1000);
    expect(page.events).toHaveLength(200);
    expect(page.events[0]!.targetId).toBe('row-0');

    const rest = await workspace.owner.memory.eventsSince(workspace.id, page.cursor, 1000);
    expect(rest.events.map((event) => event.targetId)).toEqual(['row-200']);
  });

  it('refuses a cursor that is not a timestamp instead of reading from the beginning', async () => {
    const workspace = await makeWorkspace();
    await expect(
      workspace.owner.memory.eventsSince(workspace.id, { after: 'yesterday' })
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------
describe('Who may watch a workspace work', () => {
  it('refuses an agent, exactly as the timeline does', async () => {
    // An agent writes memory. Watching the owner's console feed is not one of
    // the eight operations, and a read key is not consent to it.
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Curious');
    const head = await workspace.owner.memory.eventsCursor(workspace.id);

    await expect(agent.memory.eventsSince(workspace.id, head)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    await expect(agent.memory.eventsCursor(workspace.id)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });

  it('refuses a signed-in person who does not own the workspace', async () => {
    const workspace = await makeWorkspace();
    const head = await workspace.owner.memory.eventsCursor(workspace.id);
    const stranger = await makeOwner();

    await expect(stranger.memory.eventsSince(workspace.id, head)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    await expect(stranger.memory.eventsCursor(workspace.id)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
  });

  it('answers a workspace that does not exist the same way', async () => {
    // SS7.1: no content, summary or metadata from memory the caller cannot see -
    // and whether it exists at all is metadata. A missing workspace and someone
    // else's are one answer on purpose, so probing learns nothing.
    const stranger = await makeOwner();
    await expect(
      stranger.memory.eventsCursor('ws-that-never-existed')
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});

// ---------------------------------------------------------------------------
describe('The head of an empty trail', () => {
  it('stands where the very next entry still counts as new', async () => {
    // A fresh workspace has written nothing, so there is no last entry to point
    // at. The cursor names this millisecond with an empty tiebreak, which sorts
    // below every cuid: an entry landing in the same millisecond as the console
    // connecting is carried rather than lost.
    const workspace = await makeWorkspace();

    const head = await workspace.owner.memory.eventsCursor(workspace.id);

    await appendAt(workspace.id, 'memory.add', new Date(head.after), 'same-millisecond');

    const page = await workspace.owner.memory.eventsSince(workspace.id, head);
    expect(page.events.map((event) => event.targetId)).toEqual(['same-millisecond']);
    expect(head.afterId).toBe('');
  });

  it('without a tiebreak, takes only what is strictly later', async () => {
    // The other half of the same rule, and the reason afterId is optional: a
    // caller naming a bare instant is asking for what came after it, not for the
    // rest of the millisecond it is standing in.
    const workspace = await makeWorkspace();
    const head = await workspace.owner.memory.eventsCursor(workspace.id);
    const instant = new Date(head.after);

    await appendAt(workspace.id, 'memory.add', instant, 'same-millisecond');
    await appendAt(workspace.id, 'memory.add', new Date(instant.getTime() + 1), 'later');

    const page = await workspace.owner.memory.eventsSince(workspace.id, { after: head.after });
    expect(page.events.map((event) => event.targetId)).toEqual(['later']);
  });
});
