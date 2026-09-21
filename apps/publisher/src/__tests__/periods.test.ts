/**
 * The arithmetic that decides which ten minutes get paid.
 *
 * Everything else in this service is recoverable. A root that fails to publish
 * is republished; a proof file that goes missing is rewritten. A period paid
 * twice is permanent - it is in the ledger, and every cumulative root after it
 * carries the mistake forward. A period never paid is equally permanent and
 * considerably harder to notice.
 *
 * So these are about the boundaries, and each one is a way the ten minutes
 * could go wrong.
 */

import { describe, expect, it } from 'vitest';
import { duePeriods, lastClosedPeriod, msUntilNextTick, periodAt, periodIndexAt } from '../periods';

const PERIOD_MS = 10 * 60_000;
const NOON = Date.UTC(2026, 8, 15, 12, 0, 0);

describe('Which periods are owed', () => {
  it('leaves the period currently running unpaid until it has closed', () => {
    const current = periodIndexAt(NOON + 60_000, PERIOD_MS);

    // Nine minutes into the window, and nothing about it is settled. Paying it
    // now would settle a partial window, and the credits written in the last
    // minute would then belong to a period already closed - the one double-pay
    // the ledger cannot catch, because they are different rows.
    expect(duePeriods(current - 1, NOON + 9 * 60_000, PERIOD_MS)).toEqual([]);

    // A millisecond past the boundary, it is owed.
    expect(duePeriods(current - 1, NOON + PERIOD_MS, PERIOD_MS)).toEqual([current]);
  });

  it('never offers a period that has already been settled', () => {
    const closed = lastClosedPeriod(NOON + PERIOD_MS + 1, PERIOD_MS);

    expect(duePeriods(closed, NOON + PERIOD_MS + 1, PERIOD_MS)).toEqual([]);
    // Even a cursor that has somehow run ahead asks for nothing rather than
    // counting backwards.
    expect(duePeriods(closed + 5, NOON + PERIOD_MS + 1, PERIOD_MS)).toEqual([]);
  });

  it('owes an hour of downtime as six separate whole periods, oldest first', () => {
    const before = lastClosedPeriod(NOON, PERIOD_MS);
    const due = duePeriods(before, NOON + 60 * 60_000, PERIOD_MS);

    expect(due).toHaveLength(6);
    expect(due[0]).toBe(before + 1);
    expect(due).toEqual([...due].sort((a, b) => a - b));
  });

  it('runs windows end to start, so a credit on the boundary belongs to one period only', () => {
    const first = periodAt(1_000_000, PERIOD_MS);
    const second = periodAt(1_000_001, PERIOD_MS);

    expect(second.since.getTime()).toBe(first.until.getTime());
    // Half-open, matching CreditWindow in the core: `until` is exclusive, so
    // the instant they share is counted once, by the later period.
    expect(first.until.getTime() - first.since.getTime()).toBe(PERIOD_MS);
  });

  it('gives every period the same length, whatever the clock was doing', () => {
    // A day chosen because it is one where wall-clock reasoning goes wrong in
    // most of the world: period indexes are derived from epoch milliseconds, so
    // a daylight-saving change is not an event they can see.
    const across = Date.UTC(2026, 9, 25, 0, 30, 0);
    const before = periodAt(periodIndexAt(across - 3_600_000, PERIOD_MS), PERIOD_MS);
    const after = periodAt(periodIndexAt(across + 3_600_000, PERIOD_MS), PERIOD_MS);

    expect(before.until.getTime() - before.since.getTime()).toBe(PERIOD_MS);
    expect(after.until.getTime() - after.since.getTime()).toBe(PERIOD_MS);
  });
});

describe('When the service wakes up', () => {
  it('wakes just after the boundary rather than on it', () => {
    // On the boundary is a race with the database's own clock for rows written
    // in the final milliseconds of the window.
    const lag = 15_000;
    const wake = NOON + 4 * 60_000 + msUntilNextTick(NOON + 4 * 60_000, PERIOD_MS, lag);

    expect(wake).toBe(NOON + PERIOD_MS + lag);
    expect(lastClosedPeriod(wake, PERIOD_MS)).toBe(periodIndexAt(NOON, PERIOD_MS));
  });

  it('puts the next wake-up back on the boundary however long the last tick ran', () => {
    // Recomputed from the clock, not counted from the previous wake-up, so a
    // tick that took eleven minutes does not push every period after it off by
    // a minute forever.
    const late = NOON + PERIOD_MS + 11 * 60_000;
    const wake = late + msUntilNextTick(late, PERIOD_MS, 0);

    expect(wake % PERIOD_MS).toBe(0);
    expect(wake).toBe(NOON + 3 * PERIOD_MS);
  });
});
