/**
 * Reading the reward ledger back.
 *
 * The ledger is written by the publisher (@offcut/rewards) and read by one
 * person looking at their own console, so these tests are about the two things
 * that can go wrong on the way back out:
 *
 *   ARITHMETIC  the amounts are 18-decimal token base units kept as text. Summed
 *               as numbers they lose their low digits silently, which is a
 *               wrong payable figure printed with total confidence.
 *   ISOLATION   one row per address per period, and the address is the only
 *               thing separating two accounts. A read that matched loosely
 *               would show a stranger's earnings as yours.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { accrualsFor } from '../accruals';
import { getPrisma } from '../db';

const MINE = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';

/** Ten-minute periods, the width the publisher accrues in. */
function period(index: number): { periodStart: Date; periodEnd: Date } {
  const base = Date.UTC(2026, 8, 20, 12, 0, 0);
  return {
    periodStart: new Date(base + index * 600_000),
    periodEnd: new Date(base + (index + 1) * 600_000),
  };
}

async function accrue(address: string, index: number, amount: string): Promise<void> {
  await getPrisma().rewardAccrual.create({
    data: { address, ...period(index), amount },
  });
}

/** A period settled since the memory layer existed: a total AND its two parts. */
async function accrueSplit(
  address: string,
  index: number,
  spend: string,
  memory: string
): Promise<void> {
  await getPrisma().rewardAccrual.create({
    data: {
      address,
      ...period(index),
      amount: (BigInt(spend) + BigInt(memory)).toString(),
      spendAmount: spend,
      memoryAmount: memory,
    },
  });
}

beforeEach(async () => {
  // Accruals hang off no workspace and no user, so nothing cascades them away
  // and the shared setup does not clear them. A leftover row from another file
  // would be indistinguishable from this account's own earnings.
  await getPrisma().rewardAccrual.deleteMany();
});

describe('accrualsFor', () => {
  it('sums 18-decimal amounts exactly and answers in base units as strings', async () => {
    // Three periods whose total has more significant digits than a double can
    // hold. Added as numbers this comes back as 3000000000000000000 or worse;
    // the last digit is the test.
    await accrue(MINE, 0, '1000000000000000001');
    await accrue(MINE, 1, '1000000000000000001');
    await accrue(MINE, 2, '1000000000000000001');

    const history = await accrualsFor(getPrisma(), MINE);

    expect(history.cumulativeBaseUnits).toBe('3000000000000000003');
    expect(history.periods).toBe(3);
    expect(typeof history.cumulativeBaseUnits).toBe('string');
    for (const row of history.recent) expect(typeof row.amountBaseUnits).toBe('string');
  });

  it('returns the newest periods first', async () => {
    await accrue(MINE, 0, '100');
    await accrue(MINE, 1, '200');
    await accrue(MINE, 2, '300');

    const history = await accrualsFor(getPrisma(), MINE);

    expect(history.recent.map((row) => row.amountBaseUnits)).toEqual(['300', '200', '100']);
    expect(history.recent[0]!.periodStart).toBe(period(2).periodStart.toISOString());
    expect(history.recent[0]!.periodEnd).toBe(period(2).periodEnd.toISOString());
  });

  it('counts and sums every period even when only a few are returned', async () => {
    // The slice is what the console lists; the total is what a proof will pay
    // on. A cumulative figure computed from the slice would quietly shrink the
    // longer somebody earned.
    for (let index = 0; index < 10; index += 1) await accrue(MINE, index, '5');

    const history = await accrualsFor(getPrisma(), MINE, { limit: 3 });

    expect(history.recent).toHaveLength(3);
    expect(history.periods).toBe(10);
    expect(history.cumulativeBaseUnits).toBe('50');
  });

  it('never leaks another address, and is not fooled by case', async () => {
    await accrue(MINE, 0, '7');
    await accrue(STRANGER, 0, '999999');

    const history = await accrualsFor(getPrisma(), MINE.toUpperCase().replace('0X', '0x'));

    expect(history.address).toBe(MINE);
    expect(history.cumulativeBaseUnits).toBe('7');
    expect(history.periods).toBe(1);
  });

  it('answers empty and honest for an address that has never earned', async () => {
    await accrue(STRANGER, 0, '999999');

    const history = await accrualsFor(getPrisma(), MINE);

    // Zeroes on every layer, deliberately listed rather than left out: this
    // object is what the console prints as "no earnings yet", and a missing
    // field there is a blank where a nought belongs.
    expect(history).toEqual({
      address: MINE,
      cumulativeBaseUnits: '0',
      cumulativeSpendBaseUnits: '0',
      cumulativeMemoryBaseUnits: '0',
      periods: 0,
      recent: [],
    });
  });
});

// ---------------------------------------------------------------------------
describe('Which layer earned it', () => {
  /**
   * Rewards have paid on two things since 2026-09-21 — confirmed AI spend, and
   * memory another agent used — and a reader told only a total cannot tell why
   * they were paid. For somebody running Claude Code on a subscription, who
   * confirms no spend this service can see, the memory half IS the answer.
   *
   * The split is carried in two columns rather than derived, because the pool,
   * the rate and the ceiling in force when a period closed are not recoverable
   * afterwards.
   */

  it('carries the two layers beside the total, per period and cumulatively', async () => {
    await accrueSplit(MINE, 0, '1000000000000000000', '500000000000000000');
    await accrueSplit(MINE, 1, '0', '2000000000000000000');

    const history = await accrualsFor(getPrisma(), MINE);

    expect(history.cumulativeBaseUnits).toBe('3500000000000000000');
    expect(history.cumulativeSpendBaseUnits).toBe('1000000000000000000');
    expect(history.cumulativeMemoryBaseUnits).toBe('2500000000000000000');

    // Newest first. A subscriber's period: paid entirely by memory.
    expect(history.recent[0]).toEqual({
      periodStart: period(1).periodStart.toISOString(),
      periodEnd: period(1).periodEnd.toISOString(),
      amountBaseUnits: '2000000000000000000',
      spendBaseUnits: '0',
      memoryBaseUnits: '2000000000000000000',
    });
  });

  it('reads a period settled before the memory layer existed as what it was: spend', async () => {
    // Both columns default to "0", so an old row carries a total and no parts.
    // Printing it as a breakdown that does not add up would be the console
    // telling somebody they were paid for nothing.
    await accrue(MINE, 0, '4000000000000000000');

    const history = await accrualsFor(getPrisma(), MINE);

    expect(history.cumulativeSpendBaseUnits).toBe('4000000000000000000');
    expect(history.cumulativeMemoryBaseUnits).toBe('0');
    expect(history.recent[0]!.spendBaseUnits).toBe('4000000000000000000');
    expect(history.recent[0]!.memoryBaseUnits).toBe('0');
  });

  it('always has the two parts add up to the total it reports', async () => {
    await accrueSplit(MINE, 0, '3', '4');
    await accrue(MINE, 1, '11');

    const history = await accrualsFor(getPrisma(), MINE);

    for (const row of history.recent) {
      expect(BigInt(row.spendBaseUnits) + BigInt(row.memoryBaseUnits)).toBe(
        BigInt(row.amountBaseUnits)
      );
    }
    expect(
      BigInt(history.cumulativeSpendBaseUnits) + BigInt(history.cumulativeMemoryBaseUnits)
    ).toBe(BigInt(history.cumulativeBaseUnits));
  });
});
