/**
 * Period arithmetic.
 *
 * The service pays in fixed ten-minute periods, and the two properties that
 * matter are that no period is ever paid twice and no period is ever missed.
 * Both fall out of one decision: a period is identified by an integer index
 * derived from the wall clock, not by "ten minutes since the last run".
 *
 *   index = floor(epochMs / periodMs)
 *
 * An interval timer would drift, and a restart would begin a fresh ten minutes
 * from whenever the process happened to come up — so the window boundaries
 * after a restart would not line up with the ones before it, and the gap or the
 * overlap would be exactly as long as the outage. Indexes derived from the
 * clock are the same numbers in every process, forever, which is what makes
 * "the last period I finished was 2913921" a durable statement.
 *
 * Windows are half-open, [since, until), matching CreditWindow in the core:
 * a credit written exactly on a boundary belongs to the later period and to
 * only one of them.
 */

export interface Period {
  index: number;
  /** Inclusive. */
  since: Date;
  /** Exclusive. */
  until: Date;
}

/** The index of the period containing `atMs`, which is not yet closed. */
export function periodIndexAt(atMs: number, periodMs: number): number {
  return Math.floor(atMs / periodMs);
}

export function periodAt(index: number, periodMs: number): Period {
  const startMs = index * periodMs;
  return { index, since: new Date(startMs), until: new Date(startMs + periodMs) };
}

/**
 * The newest period whose window has fully elapsed.
 *
 * Paying the period we are standing in would pay a partial window, and the
 * credits written in the remaining minutes would then belong to a period that
 * had already been settled — the one shape of double-pay the unique constraint
 * downstream cannot catch, because they are different records.
 */
export function lastClosedPeriod(atMs: number, periodMs: number): number {
  return periodIndexAt(atMs, periodMs) - 1;
}

/**
 * Every closed period after `lastCompleted`, oldest first.
 *
 * This is the whole catch-up mechanism. Down for an hour is six entries; down
 * for a month is four thousand, and it returns all of them, because a period
 * that is skipped is money somebody earned and will never be offered again.
 */
export function duePeriods(lastCompleted: number, atMs: number, periodMs: number): number[] {
  const newest = lastClosedPeriod(atMs, periodMs);
  const due: number[] = [];
  for (let index = lastCompleted + 1; index <= newest; index += 1) due.push(index);
  return due;
}

/**
 * Milliseconds until the period containing `atMs` closes, plus a small lag.
 *
 * The lag is not politeness. Waking at exactly the boundary means racing the
 * database's own clock for rows written in the final milliseconds of the
 * window; a few seconds later those rows are settled and the window we read is
 * the window that happened.
 */
export function msUntilNextTick(atMs: number, periodMs: number, lagMs: number): number {
  const closesAt = (periodIndexAt(atMs, periodMs) + 1) * periodMs;
  return closesAt - atMs + lagMs;
}
