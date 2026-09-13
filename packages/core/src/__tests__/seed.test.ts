/**
 * The demo workspace, and the two promises it has to keep.
 *
 * THE FIRST IS THE CLOCK. The seed used to write its whole story inside a
 * couple of hundred milliseconds, which made every surface that reads time lie:
 * three sessions that happened at once, a conflict resolved before the record
 * it disagreed with was a second old, a feed of thirty entries all saying "just
 * now". The story is now told over nearly three days, and what is proved here
 * is not that the dates are pretty but that they are CONSISTENT: an agent's
 * writes go forwards, nothing is written before its author had a key, and no
 * two records share a second — which is the exact condition the bench uses to
 * decide whether it may draw a time axis at all.
 *
 * THE SECOND IS THE BLAST RADIUS. --reset deletes a workspace. A seed that got
 * that wrong would delete somebody's memory, so the suite puts three other
 * workspaces in its way — one of the demo owner's, and one of another account's
 * carrying the very same name — and insists they are all still there afterwards.
 *
 * And one structural check: the backdating this file does must be reachable
 * from nowhere else. It is the one thing in the product that can say when a
 * record was written, and a caller that could reach it could forge provenance.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createUser, createWorkspace } from '../admin';
import { getPrisma } from '../db';
import {
  DEMO_EMAIL,
  WORKSPACE_NAME,
  WORKSPACE_SLUG,
  resetDemoWorkspace,
  seedDemo,
} from '../seed';

/** A fixed noon, so every expectation below is arithmetic and not a race. */
const NOW = new Date('2026-09-16T12:00:00');
const DAY = 86_400_000;

/** The seed is chatty by design; the suite is not. */
const quiet = { log: () => undefined };

const seed = () => seedDemo({ ...quiet, now: NOW });

// ---------------------------------------------------------------------------
describe('The demo story has a clock', () => {
  it('spans days, not milliseconds', async () => {
    const result = await seed();
    expect(result.created).toBe(true);

    const records = await getPrisma().memoryRecord.findMany({
      where: { workspaceId: result.workspaceId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    expect(records.length).toBeGreaterThan(10);

    const first = records[0]!.createdAt.getTime();
    const last = records[records.length - 1]!.createdAt.getTime();
    expect(last - first).toBeGreaterThan(DAY);
  });

  it('never writes two records in the same second', async () => {
    // The bench switches to "in order written" when more than half the writes
    // share a second, because at that point a time axis is drawing the speed of
    // the machine. The demo is meant to be the case where it does NOT have to.
    const result = await seed();
    const records = await getPrisma().memoryRecord.findMany({
      where: { workspaceId: result.workspaceId },
      select: { createdAt: true },
    });

    const seconds = new Set(records.map((row) => Math.floor(row.createdAt.getTime() / 1_000)));
    expect(seconds.size).toBe(records.length);
  });

  it('moves each agent forwards and never backwards', async () => {
    const result = await seed();
    const db = getPrisma();

    const agents = await db.agent.findMany({
      where: { workspaceId: result.workspaceId },
      select: { id: true, name: true, createdAt: true },
    });
    expect(agents.length).toBeGreaterThanOrEqual(5);

    for (const agent of agents) {
      // Ordered by row id, which is a cuid: it carries the moment the row was
      // inserted, so this is the order the story was actually told in — the
      // order the timestamps have to agree with.
      const written = await db.memoryRecord.findMany({
        where: { workspaceId: result.workspaceId, agentId: agent.id },
        orderBy: { id: 'asc' },
        select: { createdAt: true },
      });

      for (let index = 1; index < written.length; index += 1) {
        expect(
          written[index]!.createdAt.getTime(),
          `${agent.name} wrote out of order`
        ).toBeGreaterThan(written[index - 1]!.createdAt.getTime());
      }

      // Nobody writes before they have a key.
      if (written.length > 0) {
        expect(written[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(agent.createdAt.getTime());
      }
    }
  });

  it('backdates the trail with the records, so the feed does not say "just now" thirty times', async () => {
    const result = await seed();

    const events = await getPrisma().auditEvent.findMany({
      where: { workspaceId: result.workspaceId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, action: true },
    });
    expect(events.length).toBeGreaterThan(10);

    // Every entry belongs to the story, and the story ended yesterday evening.
    const midnight = new Date(NOW.getTime());
    midnight.setHours(0, 0, 0, 0);
    for (const event of events) {
      expect(event.createdAt.getTime()).toBeLessThan(midnight.getTime());
    }

    const first = events[0]!.createdAt.getTime();
    const last = events[events.length - 1]!.createdAt.getTime();
    expect(last - first).toBeGreaterThan(DAY);
  });

  it('dates the conflict and its resolution, in that order', async () => {
    const result = await seed();

    const conflicts = await getPrisma().conflict.findMany({
      where: { workspaceId: result.workspaceId },
      select: { status: true, detectedAt: true, resolvedAt: true },
    });
    expect(conflicts.length).toBeGreaterThanOrEqual(2);

    const midnight = new Date(NOW.getTime());
    midnight.setHours(0, 0, 0, 0);

    for (const conflict of conflicts) {
      expect(conflict.detectedAt.getTime()).toBeLessThan(midnight.getTime());
      if (conflict.resolvedAt) {
        expect(conflict.resolvedAt.getTime()).toBeGreaterThan(conflict.detectedAt.getTime());
      }
    }
  });

  it('leaves no agent with a revoked key on the bench', async () => {
    // The dev store had twelve, from a summer of MCP self-checks, and they
    // filled twelve of nineteen lanes. A rebuilt workspace starts clean.
    const result = await seed();
    const revoked = await getPrisma().agent.count({
      where: { workspaceId: result.workspaceId, revokedAt: { not: null } },
    });
    expect(revoked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('Re-running the seed', () => {
  it('leaves an existing demo workspace alone unless asked to reset it', async () => {
    const first = await seed();
    const again = await seed();

    expect(again.created).toBe(false);
    expect(again.workspaceId).toBe(first.workspaceId);

    const count = await getPrisma().workspace.count({ where: { slug: first.slug } });
    expect(count).toBe(1);
  });

  it('builds a fresh workspace when reset, and the old one is gone', async () => {
    const first = await seed();
    const second = await seedDemo({ ...quiet, now: NOW, reset: true });

    expect(second.created).toBe(true);
    expect(second.workspaceId).not.toBe(first.workspaceId);

    const survivor = await getPrisma().workspace.findUnique({ where: { id: first.workspaceId } });
    expect(survivor).toBeNull();
    // ...and the slug came back to the new one rather than accreting a suffix.
    expect(second.slug).toBe(WORKSPACE_SLUG);
  });
});

// ---------------------------------------------------------------------------
describe('What the reset is allowed to delete', () => {
  it('deletes the demo workspace and nothing else, however alike the neighbours are', async () => {
    const db = getPrisma();
    const demo = await seed();

    // The demo owner's own second workspace. Nothing about the demo entitles a
    // seed to it.
    const owner = await db.user.findUnique({ where: { email: DEMO_EMAIL }, select: { id: true } });
    const sibling = await createWorkspace({ ownerId: owner!.id, name: 'Field Notes' });

    // Another account's workspace carrying the very same NAME — the trap, since
    // the previous seed matched on name alone.
    const stranger = await createUser({
      email: 'someone@example.test',
      password: 'correct-horse-battery',
      displayName: 'Someone Else',
    });
    const namesake = await createWorkspace({ ownerId: stranger.id, name: WORKSPACE_NAME });

    const deleted = await resetDemoWorkspace();

    expect(deleted.map((row) => row.id)).toEqual([demo.workspaceId]);
    expect(await db.workspace.findUnique({ where: { id: demo.workspaceId } })).toBeNull();
    expect(await db.workspace.findUnique({ where: { id: sibling.id } })).not.toBeNull();
    expect(await db.workspace.findUnique({ where: { id: namesake.id } })).not.toBeNull();

    // And no account was touched.
    expect(await db.user.count()).toBe(2);
  });

  it('does nothing at all when there is no demo account', async () => {
    const stranger = await createUser({
      email: 'nobody@example.test',
      password: 'correct-horse-battery',
      displayName: 'Nobody',
    });
    const theirs = await createWorkspace({ ownerId: stranger.id, name: WORKSPACE_NAME });

    expect(await resetDemoWorkspace()).toEqual([]);
    expect(await getPrisma().workspace.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("Backdating is out of everyone else's reach", () => {
  const root = path.resolve(__dirname, '..', '..');

  it('is not exported from the package', () => {
    const index = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
    expect(index).not.toMatch(/['"]\.\/seed['"]/);
  });

  it('is not even shipped', () => {
    // The exports map offers one entry point and no subpaths, and the tarball
    // leaves the seed out entirely — so there is no specifier an SDK, an MCP
    // server or the HTTP API could write that would reach this file.
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      files: string[];
      exports: Record<string, unknown>;
    };
    expect(manifest.files).toContain('!dist/seed.js');
    expect(Object.keys(manifest.exports)).toEqual(['.', './package.json']);
  });
});
