/**
 * The ledger is the one place a mistake is permanent.
 *
 * Roots are cumulative, so a period written twice is paid twice in every root
 * that follows, forever, and a total that goes down invalidates a proof
 * somebody is holding. These tests are the guarantees that stop both:
 *
 *   - running the same period again changes nothing
 *   - a period that overlaps one already written is refused outright
 *   - totals only ever rise
 */

import { describe, expect, it } from 'vitest';
import { getPrisma } from '@offcut/core';
import { cumulativeFor, cumulativeTotals, recordAccruals } from '../ledger';
import { ONE_TOKEN } from '../config';
import { address, windowOf } from './helpers';

const FIRST = windowOf(new Date('2026-09-15T12:00:00.000Z'));
const SECOND = windowOf(new Date('2026-09-15T12:10:00.000Z'));

async function rowCount(): Promise<number> {
  return getPrisma().rewardAccrual.count();
}

// ---------------------------------------------------------------------------
describe('Running a period again', () => {
  it('writes nothing the second time', async () => {
    const amounts = [
      { address: address(1), amount: 2n * ONE_TOKEN },
      { address: address(2), amount: 3n * ONE_TOKEN },
    ];

    const first = await recordAccruals(getPrisma(), FIRST, amounts);
    const again = await recordAccruals(getPrisma(), FIRST, amounts);

    expect(first.recorded).toHaveLength(2);
    expect(again.recorded).toHaveLength(0);
    expect(again.alreadyRecorded).toHaveLength(2);
    expect(await rowCount()).toBe(2);
  });

  it('does not double the totals', async () => {
    const amounts = [{ address: address(1), amount: 7n * ONE_TOKEN }];

    await recordAccruals(getPrisma(), FIRST, amounts);
    await recordAccruals(getPrisma(), FIRST, amounts);
    await recordAccruals(getPrisma(), FIRST, amounts);

    expect(await cumulativeFor(getPrisma(), address(1))).toBe(7n * ONE_TOKEN);
  });

  it('refuses a period already settled at a different figure', async () => {
    await recordAccruals(getPrisma(), FIRST, [{ address: address(1), amount: 2n * ONE_TOKEN }]);

    await expect(
      recordAccruals(getPrisma(), FIRST, [{ address: address(1), amount: 3n * ONE_TOKEN }])
    ).rejects.toThrow(/already settled at a different figure/);
  });

  it('refuses to add an address to a period that is already settled', async () => {
    // The owner connected a wallet after the period closed. They earn from now
    // on; a closed period is not reopened to pay them.
    await recordAccruals(getPrisma(), FIRST, [{ address: address(1), amount: 2n * ONE_TOKEN }]);

    await expect(
      recordAccruals(getPrisma(), FIRST, [
        { address: address(1), amount: 2n * ONE_TOKEN },
        { address: address(2), amount: 5n * ONE_TOKEN },
      ])
    ).rejects.toThrow(/already settled/);
  });
});

// ---------------------------------------------------------------------------
describe('Periods that would pay for the same credits twice', () => {
  it('refuses a window that overlaps one on file', async () => {
    await recordAccruals(getPrisma(), FIRST, [{ address: address(1), amount: ONE_TOKEN }]);

    const straddling = windowOf(new Date('2026-09-15T12:05:00.000Z'));

    await expect(
      recordAccruals(getPrisma(), straddling, [{ address: address(1), amount: ONE_TOKEN }])
    ).rejects.toThrow(/overlaps one already in the ledger/);
  });

  it('accepts the period that starts where the last one ended', async () => {
    await recordAccruals(getPrisma(), FIRST, [{ address: address(1), amount: ONE_TOKEN }]);
    const next = await recordAccruals(getPrisma(), SECOND, [
      { address: address(1), amount: ONE_TOKEN },
    ]);

    expect(next.recorded).toHaveLength(1);
    expect(await cumulativeFor(getPrisma(), address(1))).toBe(2n * ONE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
describe('Cumulative totals', () => {
  it('only ever increase', async () => {
    const windows = [0, 10, 20, 30, 40].map((offset) =>
      windowOf(new Date(FIRST.since.getTime() + offset * 60_000))
    );

    let previous = 0n;
    for (const window of windows) {
      await recordAccruals(getPrisma(), window, [{ address: address(1), amount: ONE_TOKEN }]);

      const total = await cumulativeFor(getPrisma(), address(1));
      expect(total).toBeGreaterThan(previous);
      previous = total;
    }

    expect(previous).toBe(5n * ONE_TOKEN);
  });

  it('refuse a negative accrual, which would take back money already claimable', async () => {
    await expect(
      recordAccruals(getPrisma(), FIRST, [{ address: address(1), amount: -1n }])
    ).rejects.toThrow(/only ever rise/);
  });

  it('sum every address, sorted so two runs produce one order', async () => {
    await recordAccruals(getPrisma(), FIRST, [
      { address: address(2), amount: 3n * ONE_TOKEN },
      { address: address(1), amount: ONE_TOKEN },
    ]);
    await recordAccruals(getPrisma(), SECOND, [{ address: address(1), amount: 4n * ONE_TOKEN }]);

    expect(await cumulativeTotals(getPrisma())).toEqual([
      { address: address(1), amount: 5n * ONE_TOKEN },
      { address: address(2), amount: 3n * ONE_TOKEN },
    ]);
  });

  it('leave out a period that has not closed yet', async () => {
    await recordAccruals(getPrisma(), FIRST, [{ address: address(1), amount: ONE_TOKEN }]);
    await recordAccruals(getPrisma(), SECOND, [{ address: address(1), amount: ONE_TOKEN }]);

    const throughFirst = await cumulativeTotals(getPrisma(), { through: FIRST.until });

    expect(throughFirst).toEqual([{ address: address(1), amount: ONE_TOKEN }]);
  });

  it('survive the deletion of the workspace that earned them', async () => {
    // A root is published from these rows. If deleting a workspace erased them,
    // the next root would be lower than the last and a proof somebody is
    // holding would stop verifying.
    await recordAccruals(getPrisma(), FIRST, [{ address: address(1), amount: ONE_TOKEN }]);

    await getPrisma().workspace.deleteMany();
    await getPrisma().user.deleteMany();

    expect(await cumulativeFor(getPrisma(), address(1))).toBe(ONE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
describe('Rows the ledger will not hold', () => {
  it('refuses an address that is not canonical, rather than paying a guess', async () => {
    await expect(
      recordAccruals(getPrisma(), FIRST, [
        { address: '0xAbCdEf0000000000000000000000000000000001', amount: ONE_TOKEN },
      ])
    ).rejects.toThrow(/not a lowercase 0x address/);
  });

  it('refuses two rows for one address in one period', async () => {
    await expect(
      recordAccruals(getPrisma(), FIRST, [
        { address: address(1), amount: ONE_TOKEN },
        { address: address(1), amount: ONE_TOKEN },
      ])
    ).rejects.toThrow(/must be summed before recording/);
  });

  it('writes no row for an address owed nothing', async () => {
    const result = await recordAccruals(getPrisma(), FIRST, [
      { address: address(1), amount: 0n },
      { address: address(2), amount: ONE_TOKEN },
    ]);

    expect(result.recorded.map((row) => row.address)).toEqual([address(2)]);
    expect(await rowCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Which layer a period paid on', () => {
  /**
   * The split is written beside the total, once, here.
   *
   * The pool, the rate and the ceiling in force when a period closed are not
   * recoverable afterwards, so this is the only moment at which "what was I
   * paid FOR" exists to be written down. For somebody running Claude Code on a
   * subscription — who confirms no spend this service can see — it is the whole
   * answer to why they were paid anything at all.
   */

  it('records what spend earned and what memory earned, beside the total', async () => {
    await recordAccruals(getPrisma(), FIRST, [
      { address: address(1), amount: 3n * ONE_TOKEN, spend: 2n * ONE_TOKEN, memory: ONE_TOKEN },
      // A subscriber's row: paid entirely by memory another agent used.
      { address: address(2), amount: ONE_TOKEN, spend: 0n, memory: ONE_TOKEN },
    ]);

    const rows = await getPrisma().rewardAccrual.findMany({
      orderBy: { address: 'asc' },
      select: { address: true, amount: true, spendAmount: true, memoryAmount: true },
    });

    expect(rows).toEqual([
      {
        address: address(1),
        amount: (3n * ONE_TOKEN).toString(),
        spendAmount: (2n * ONE_TOKEN).toString(),
        memoryAmount: ONE_TOKEN.toString(),
      },
      {
        address: address(2),
        amount: ONE_TOKEN.toString(),
        spendAmount: '0',
        memoryAmount: ONE_TOKEN.toString(),
      },
    ]);
  });

  it('reads a caller that gives no split as all spend, which is what it was', async () => {
    // Every period settled before the memory layer existed. The columns default
    // to "0", so the alternative is a breakdown that does not add up to the
    // amount printed beside it.
    await recordAccruals(getPrisma(), FIRST, [{ address: address(1), amount: 5n * ONE_TOKEN }]);

    const row = await getPrisma().rewardAccrual.findFirstOrThrow({
      select: { spendAmount: true, memoryAmount: true },
    });

    expect(row.spendAmount).toBe((5n * ONE_TOKEN).toString());
    expect(row.memoryAmount).toBe('0');
  });

  it('refuses a split that does not add up to the amount it is paying', async () => {
    // Refused rather than rounded into shape. The two columns are what the
    // console tells somebody they were paid for, and a total that disagrees
    // with its parts is worse than no breakdown at all.
    await expect(
      recordAccruals(getPrisma(), FIRST, [
        { address: address(1), amount: 3n * ONE_TOKEN, spend: ONE_TOKEN, memory: ONE_TOKEN },
      ])
    ).rejects.toThrow(/does not add up/);

    expect(await rowCount()).toBe(0);
  });

  it('refuses a negative part of a total that is positive', async () => {
    await expect(
      recordAccruals(getPrisma(), FIRST, [
        { address: address(1), amount: ONE_TOKEN, spend: 2n * ONE_TOKEN, memory: -1n * ONE_TOKEN },
      ])
    ).rejects.toThrow(/does not add up/);
  });
});
