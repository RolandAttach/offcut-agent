/**
 * Who earns, and — mostly — who does not.
 *
 * Rewards are the one part of this product where being wrong costs real money,
 * and the owner's first instinct was to pay per agent. That is free to farm: an
 * agent is a row, and a script makes ten thousand in a minute. What is paid for
 * instead is memory that a DIFFERENT agent actually retrieved, credited once
 * per record, ever.
 *
 * So these tests are mostly about refusal. Each one is a way somebody would try
 * to earn without contributing, and the assertion is that it pays nothing.
 *
 * Since 2026-09-21 what is counted here is a LAYER of the reward, not the whole
 * of it: @offcut/rewards prices these credits against their own ceiling and
 * their own rate, and adds the result to what confirmed AI spend earned. The
 * last block below reads them under the name that layer uses.
 */

import { describe, expect, it } from 'vitest';
import { creditsInWindow, earnedEver, earnedInWindow } from '../credits';
import { getPrisma } from '../db';
import { key, makeAgent, makeWorkspace } from './helpers';

async function creditsIn(workspaceId: string) {
  return getPrisma().rewardCredit.findMany({ where: { workspaceId }, orderBy: { recordId: 'asc' } });
}

// ---------------------------------------------------------------------------
describe('Memory another agent used', () => {
  it('credits the author when someone else retrieves their record', async () => {
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');
    const developer = await makeAgent(workspace, 'Developer');

    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      idempotencyKey: key(),
    });

    await developer.memory.recall({ workspaceId: workspace.id, query: 'offline' });

    const credits = await creditsIn(workspace.id);
    expect(credits).toHaveLength(1);
    expect(credits[0]!.authorAgentId).toBe(researcher.id);
    expect(credits[0]!.usedByAgentId).toBe(developer.id);
    expect(await earnedEver(getPrisma(), workspace.id)).toBe(1);
  });

  it('pays once however many times the record is retrieved', async () => {
    // The single most important property here. Without it, a loop is a salary.
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');
    const developer = await makeAgent(workspace, 'Developer');

    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      idempotencyKey: key(),
    });

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await developer.memory.recall({
        workspaceId: workspace.id,
        query: `offline ${attempt}`,
        useCache: false,
      });
    }

    expect(await earnedEver(getPrisma(), workspace.id)).toBe(1);
  });

  it('pays once however many different agents retrieve it', async () => {
    // The obvious next farm: keep the record, add readers.
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');

    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      idempotencyKey: key(),
    });

    for (let index = 0; index < 8; index += 1) {
      const reader = await makeAgent(workspace, `Reader ${index}`);
      await reader.memory.recall({ workspaceId: workspace.id, query: 'offline', useCache: false });
    }

    expect(await earnedEver(getPrisma(), workspace.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('What earns nothing', () => {
  it('writing, however much of it', async () => {
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');

    for (let index = 0; index < 20; index += 1) {
      await researcher.memory.add({
        workspaceId: workspace.id,
        type: 'fact',
        text: `Finding number ${index}.`,
        topic: 'release-1',
        idempotencyKey: key(),
      });
    }

    expect(await earnedEver(getPrisma(), workspace.id)).toBe(0);
  });

  it('reading your own records back', async () => {
    // Write, then read what you wrote. The cheapest farm imaginable.
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');

    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      idempotencyKey: key(),
    });

    await researcher.memory.recall({ workspaceId: workspace.id, query: 'offline' });

    expect(await creditsIn(workspace.id)).toHaveLength(0);
  });

  it('creating agents', async () => {
    const workspace = await makeWorkspace();
    for (let index = 0; index < 30; index += 1) {
      await makeAgent(workspace, `Agent ${index}`);
    }

    expect(await earnedEver(getPrisma(), workspace.id)).toBe(0);
  });

  it('an owner reading their own workspace in the console', async () => {
    // A user is not an agent. Crediting an owner's own reads would make the
    // whole scheme a loop with one participant.
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');
    const { Memory } = await import('../memory');

    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      idempotencyKey: key(),
    });

    const asOwner = new Memory(workspace.owner.principal);
    await asOwner.recall({ workspaceId: workspace.id, query: 'offline' });

    expect(await creditsIn(workspace.id)).toHaveLength(0);
  });

  it('a recall that returned nothing', async () => {
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');
    const developer = await makeAgent(workspace, 'Developer');

    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      idempotencyKey: key(),
    });

    await developer.memory.recall({
      workspaceId: workspace.id,
      query: 'nothing here matches this at all',
      topic: 'a-topic-that-does-not-exist',
    });

    expect(await creditsIn(workspace.id)).toHaveLength(0);
  });

  it('a record the reader was never allowed to see', async () => {
    // Private records never reach another agent, so they can never be credited
    // — the credit is written from the filtered result, not from the store.
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');
    const developer = await makeAgent(workspace, 'Developer');

    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'A private note nobody else may read.',
      topic: 'release-1',
      scope: 'private',
      idempotencyKey: key(),
    });

    await developer.memory.recall({ workspaceId: workspace.id, query: 'private note' });

    expect(await creditsIn(workspace.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('Windows, for paying by period', () => {
  it('counts only what was earned inside the window', async () => {
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');
    const developer = await makeAgent(workspace, 'Developer');

    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      idempotencyKey: key(),
    });
    await developer.memory.recall({ workspaceId: workspace.id, query: 'offline' });

    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const longAgo = new Date(now.getTime() - 7_200_000);
    const soon = new Date(now.getTime() + 60_000);

    const inside = await earnedInWindow(getPrisma(), { since: hourAgo, until: soon });
    expect(inside.find((row) => row.workspaceId === workspace.id)?.points).toBe(1);

    const before = await earnedInWindow(getPrisma(), { since: longAgo, until: hourAgo });
    expect(before.find((row) => row.workspaceId === workspace.id)).toBeUndefined();
  });

  it('never counts a row in two consecutive windows', async () => {
    // `until` is exclusive precisely so a row on the boundary is paid once.
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');
    const developer = await makeAgent(workspace, 'Developer');

    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      idempotencyKey: key(),
    });
    await developer.memory.recall({ workspaceId: workspace.id, query: 'offline' });

    const credit = (await creditsIn(workspace.id))[0]!;
    const boundary = credit.createdAt;
    const before = new Date(boundary.getTime() - 60_000);
    const after = new Date(boundary.getTime() + 60_000);

    const first = await earnedInWindow(getPrisma(), { since: before, until: boundary });
    const second = await earnedInWindow(getPrisma(), { since: boundary, until: after });

    const firstPoints = first.find((row) => row.workspaceId === workspace.id)?.points ?? 0;
    const secondPoints = second.find((row) => row.workspaceId === workspace.id)?.points ?? 0;

    expect(firstPoints + secondPoints).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Credits, as the memory layer reads them', () => {
  /**
   * The same rows under the name the reward layer asks for them by.
   *
   * `creditsInWindow` is what accrueWindow divides the memory pool among, so
   * what it counts and whose it says they are decides who gets paid. The unit
   * is deliberately not called points here: a point is a millionth of a dollar
   * of confirmed spend, a credit is one used record, and the two are priced a
   * million apart.
   */

  it('names the credit in credits, for the workspace that owns the record', async () => {
    const workspace = await makeWorkspace();
    const researcher = await makeAgent(workspace, 'Researcher');
    const developer = await makeAgent(workspace, 'Developer');

    await researcher.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'The application must work offline.',
      topic: 'release-1',
      idempotencyKey: key(),
    });
    await developer.memory.recall({ workspaceId: workspace.id, query: 'offline' });

    const now = new Date();
    const window = { since: new Date(now.getTime() - 3_600_000), until: new Date(now.getTime() + 60_000) };

    const rows = await creditsInWindow(getPrisma(), window);
    const mine = rows.find((row) => row.workspaceId === workspace.id);

    expect(mine?.credits).toBe(1);
    // The author's side earns. The reader is an agent in the same workspace —
    // recall cannot cross one — which is exactly why paying the workspace on
    // this row pays the person whose memory was useful.
    expect((await creditsIn(workspace.id))[0]!.authorAgentId).toBe(researcher.id);
  });

  it('answers about named workspaces only when asked to', async () => {
    // The console asks about one account's workspaces and has no business
    // reading a groupBy over everybody's.
    const mine = await makeWorkspace();
    const theirs = await makeWorkspace();

    for (const workspace of [mine, theirs]) {
      const author = await makeAgent(workspace, 'Researcher');
      const reader = await makeAgent(workspace, 'Developer');
      await author.memory.add({
        workspaceId: workspace.id,
        type: 'fact',
        text: 'The application must work offline.',
        topic: 'release-1',
        idempotencyKey: key(),
      });
      await reader.memory.recall({ workspaceId: workspace.id, query: 'offline' });
    }

    const now = new Date();
    const window = { since: new Date(now.getTime() - 3_600_000), until: new Date(now.getTime() + 60_000) };

    const everybody = await creditsInWindow(getPrisma(), window);
    expect(everybody.map((row) => row.workspaceId)).toEqual(
      expect.arrayContaining([mine.id, theirs.id])
    );

    const narrowed = await creditsInWindow(getPrisma(), window, { workspaceIds: [mine.id] });
    expect(narrowed.map((row) => row.workspaceId)).toEqual([mine.id]);
  });

  it('leaves out a workspace that earned nothing rather than listing a nought', async () => {
    const quiet = await makeWorkspace();
    const author = await makeAgent(quiet, 'Researcher');
    await author.memory.add({
      workspaceId: quiet.id,
      type: 'fact',
      text: 'Nobody else has read this.',
      topic: 'release-1',
      idempotencyKey: key(),
    });

    const now = new Date();
    const rows = await creditsInWindow(getPrisma(), {
      since: new Date(now.getTime() - 3_600_000),
      until: new Date(now.getTime() + 60_000),
    });

    expect(rows.find((row) => row.workspaceId === quiet.id)).toBeUndefined();
  });
});
