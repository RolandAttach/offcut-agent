/**
 * Fixtures for the accrual suite.
 *
 * Rows are written straight through Prisma rather than through the memory API.
 * The usage suite in @offcut/core already proves that a report becomes a
 * verified row only when a provider confirms it; what is under test here is the
 * arithmetic that runs afterwards, and driving an agent through a fake provider
 * to obtain one integer would hide the number being tested behind a hundred
 * lines of unrelated machinery.
 *
 * Two writers, because the suite has to be able to tell them apart: `spend`
 * writes the spend layer's unit — a millionth of a dollar a provider confirmed
 * — and `credit` writes the memory layer's — one record an agent that did not
 * write it retrieved. Both are paid, out of separate pools, and the whole point
 * of keeping the fixtures apart is that a test can show one without the other.
 */

import { randomUUID } from 'node:crypto';
import { getPrisma } from '@offcut/core';

let counter = 0;

/** A deterministic, distinct, lowercase address. Index 1 sorts before index 2. */
export function address(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

export interface EarnerFixture {
  workspaceId: string;
  ownerId: string;
  wallet: string | null;
}

/**
 * A workspace whose owner has the given wallet, or none at all.
 *
 * Pass the same `ownerId` twice to give one person two workspaces, which is the
 * case the per-address cap exists for.
 */
export async function makeEarner(
  wallet: string | null,
  ownerId?: string
): Promise<EarnerFixture> {
  counter += 1;
  const db = getPrisma();

  const existing = ownerId
    ? await db.user.findUniqueOrThrow({ where: { id: ownerId }, select: { id: true, walletAddress: true } })
    : await db.user.create({
        data: {
          email: `owner${counter}-${randomUUID()}@offcut.test`,
          passwordHash: 'not-a-real-hash',
          displayName: `Owner ${counter}`,
          walletAddress: wallet,
          walletLinkedAt: wallet ? new Date() : null,
        },
        select: { id: true, walletAddress: true },
      });

  const owner = existing.id;

  const workspace = await db.workspace.create({
    data: {
      slug: `workspace-${counter}-${randomUUID().slice(0, 8)}`,
      name: `Workspace ${counter}`,
      ownerId: owner,
    },
  });

  // The wallet reported back is the OWNER's, which is not the argument when an
  // existing owner was named - the second workspace of a connected owner is
  // connected whatever this call passed.
  return { workspaceId: workspace.id, ownerId: owner, wallet: existing.walletAddress };
}

/**
 * The most confirmed spend one ModelUsage row can hold, in millionths of a
 * dollar.
 *
 * `verifiedCostMicros` is a Prisma `Int`, which is 32 bits on Postgres — about
 * $2,147 in one request. No single model call costs that, so the schema is
 * fine; a workspace that spent thousands of dollars in a period spent it across
 * many requests, and `spend` below writes it the same way rather than writing
 * one impossible row that would overflow on Postgres and pass on SQLite.
 */
const MAX_MICROS_PER_ROW = 2_000_000_000;

/**
 * A total, as the per-request rows that could actually have produced it.
 *
 * Not a convenience: Prisma refuses a value over 2^31 in an Int column outright,
 * on SQLite as well as on Postgres, so `$50,000 of spend` is not expressible as
 * one row at all. That is the schema being right rather than in the way — the
 * total belongs to a workspace, never to a request, and no single model call
 * costs two thousand dollars.
 */
function asRows(points: number): number[] {
  const rows: number[] = [];
  let left = points;
  while (left > MAX_MICROS_PER_ROW) {
    rows.push(MAX_MICROS_PER_ROW);
    left -= MAX_MICROS_PER_ROW;
  }
  rows.push(left);
  return rows;
}

/**
 * Gives a workspace `points` of CONFIRMED spend inside the window.
 *
 * A point is one millionth of a dollar, so `spend(ws, 3)` is three millionths
 * and `spend(ws, dollars(500))` is five hundred dollars.
 *
 * Written as verified rows dated at `at`: spendInWindow selects on `verifiedAt`
 * and on `status`, so a fixture that set only `reportedAt` would earn nothing
 * and the test would be passing for the wrong reason.
 */
export async function spend(workspaceId: string, points: number, at: Date): Promise<void> {
  await getPrisma().modelUsage.createMany({
    data: asRows(points).map((cost) => ({
      workspaceId,
      provider: 'openrouter',
      generationId: `gen-${randomUUID()}`,
      reportedByAgentId: `agent-${randomUUID()}`,
      model: 'test/model',
      status: 'verified',
      verifiedCostMicros: cost,
      verifiedTokens: cost,
      reportedAt: at,
      verifiedAt: at,
    })),
  });
}

/** Whole dollars of spend, in points. Keeps six zeroes out of the tests. */
export function dollars(amount: number): number {
  return amount * 1_000_000;
}

/**
 * Spend an agent CLAIMED but no provider has confirmed.
 *
 * `status` is what separates a claim from money, so the suite needs a way to
 * write one that looks payable in every respect except the only one that counts.
 */
export async function claimSpend(
  workspaceId: string,
  points: number,
  at: Date,
  status: 'pending' | 'rejected' = 'pending'
): Promise<void> {
  await getPrisma().modelUsage.createMany({
    data: asRows(points).map((cost) => ({
      workspaceId,
      provider: 'openrouter',
      generationId: `gen-${randomUUID()}`,
      reportedByAgentId: `agent-${randomUUID()}`,
      model: 'test/model',
      status,
      reportedCostMicros: cost,
      // A rejected row carries the timestamp of the moment it was settled, and
      // it is settled INSIDE the window: a filter on dates alone would let it
      // through, which is exactly the mistake worth having a fixture for.
      reportedAt: at,
      verifiedAt: status === 'rejected' ? at : null,
    })),
  });
}

/**
 * Gives a workspace `records` credits of USED memory inside the window.
 *
 * One row per record, points 1 each, as creditRetrieval writes them: a credit
 * is one record, written by one agent, retrieved once ever by another. Writing
 * n rows rather than one row worth n also exercises the shape the unique
 * constraint guards, so a fixture cannot accidentally credit one record twice
 * in a way the real path could not.
 */
export async function credit(workspaceId: string, records: number, at: Date): Promise<void> {
  await getPrisma().rewardCredit.createMany({
    data: Array.from({ length: records }, () => ({
      workspaceId,
      recordId: randomUUID(),
      authorAgentId: `author-${randomUUID()}`,
      usedByAgentId: `reader-${randomUUID()}`,
      points: 1,
      createdAt: at,
    })),
  });
}

/**
 * The same thing as one row worth `points`.
 *
 * Kept beside `credit` for the blocks that want a large figure without a large
 * number of rows — the memory layer's denominator is a SUM of points, not a
 * row count, and a test that only ever wrote ones could not tell the two apart.
 */
export async function retrieve(workspaceId: string, points: number, at: Date): Promise<void> {
  await getPrisma().rewardCredit.create({
    data: {
      workspaceId,
      recordId: randomUUID(),
      authorAgentId: `author-${randomUUID()}`,
      usedByAgentId: `reader-${randomUUID()}`,
      points,
      createdAt: at,
    },
  });
}

/** A ten-minute window, and an instant inside it. */
export const WINDOW_START = new Date('2026-09-15T12:00:00.000Z');
export const WINDOW_END = new Date('2026-09-15T12:10:00.000Z');
export const INSIDE = new Date('2026-09-15T12:05:00.000Z');

export function windowOf(start: Date, minutes = 10) {
  return { since: start, until: new Date(start.getTime() + minutes * 60_000) };
}
