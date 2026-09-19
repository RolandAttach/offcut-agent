/**
 * The cumulative ledger: what each address has been owed, period by period.
 *
 * Published roots are cumulative — a leaf carries the total an address has ever
 * earned, so a recipient can ignore a hundred roots and claim once — and that
 * total cannot be recomputed from reward_credits. It depends on the pool, the
 * rate and the cap in force in each past period, and those are allowed to
 * change the moment a farm appears. So each period's decision is written down
 * once, here, and the cumulative figure is the sum of the rows.
 *
 * Which makes this the one place where a mistake is permanent: a period written
 * twice is paid twice, forever, in every root that follows. Two defences:
 *
 *   - the unique key on (address, periodStart), so re-running a period writes
 *     nothing new even if two schedulers fire at once;
 *   - an explicit refusal of any window that OVERLAPS one already recorded,
 *     which the key cannot see because the starts differ.
 *
 * Both of them prefer refusing to guessing. An accrual job that stops with a
 * loud error is an hour of missing rewards; one that guesses is a permanent
 * hole in the supply.
 */

import { OffcutError, type CreditWindow, type Db } from '@offcut/core';

export interface RecordedAmount {
  /** Lowercase 0x address. */
  address: string;
  /** What the period decided, in base units. The sum of the two below. */
  amount: bigint;
  /**
   * The same amount, split by the layer that earned it: confirmed AI spend, and
   * memory another agent used.
   *
   * Optional because `amount` is the figure a root is built from and the only
   * one that has to be right; a caller that does not care about the split omits
   * it and the row reads as all spend, which is what every period settled
   * before the memory layer existed was. Given both, they must add up to
   * `amount` — a row whose parts disagree with its total is a row nobody can
   * explain to the person it pays.
   */
  spend?: bigint;
  memory?: bigint;
}

export interface LedgerWriteResult {
  window: CreditWindow;
  /** Rows this call created. */
  recorded: RecordedAmount[];
  /** Rows an earlier run had already created, with the same figures. */
  alreadyRecorded: RecordedAmount[];
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

function sameInstant(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

/**
 * Writes one window's amounts, or establishes that they are already written.
 *
 * Idempotent on exactly the same window and figures. Anything else — a
 * different amount for a period already settled, an address that was not in the
 * settled period, a window that overlaps one on file — throws, because each of
 * those means the accrual that produced the numbers disagrees with the accrual
 * that produced the rows and only a person can say which is right.
 */
export async function recordAccruals(
  db: Db,
  window: CreditWindow,
  amounts: RecordedAmount[]
): Promise<LedgerWriteResult> {
  if (!(window.since.getTime() < window.until.getTime())) {
    throw new OffcutError('INVARIANT', 'A period must end after it starts.', {
      details: { since: window.since.toISOString(), until: window.until.toISOString() },
    });
  }

  const seen = new Set<string>();
  // A zero row carries no information and would only make the ledger longer, so
  // it is dropped here rather than written and filtered out on every read.
  const payable: RecordedAmount[] = [];

  for (const row of amounts) {
    if (!ADDRESS.test(row.address)) {
      throw new OffcutError('INVARIANT', `Refusing to record an accrual for ${row.address}: not a lowercase 0x address.`, {
        details: { address: row.address },
      });
    }
    if (seen.has(row.address)) {
      throw new OffcutError('INVARIANT', `Two accruals for ${row.address} in one period; they must be summed before recording.`, {
        details: { address: row.address },
      });
    }
    seen.add(row.address);

    // Cumulative totals are published as a running sum, so a negative row would
    // reduce somebody's already-claimable balance and make a previously valid
    // proof worthless. There is no clawback in this design, by choice.
    if (row.amount < 0n) {
      throw new OffcutError('INVARIANT', `Refusing a negative accrual for ${row.address}; cumulative totals only ever rise.`, {
        details: { address: row.address, amount: row.amount.toString() },
      });
    }

    // A split that does not add up is refused rather than rounded into shape:
    // the two columns are what the console tells somebody they were paid FOR,
    // and a total that disagrees with its parts is worse than no breakdown.
    const memory = row.memory ?? 0n;
    const spend = row.spend ?? row.amount - memory;
    if (spend < 0n || memory < 0n || spend + memory !== row.amount) {
      throw new OffcutError(
        'INVARIANT',
        `The layer split for ${row.address} does not add up to the amount being recorded.`,
        {
          details: {
            address: row.address,
            amount: row.amount.toString(),
            spend: spend.toString(),
            memory: memory.toString(),
          },
        }
      );
    }

    if (row.amount > 0n) payable.push({ ...row, spend, memory });
  }

  const overlapping = await db.rewardAccrual.findMany({
    where: { periodStart: { lt: window.until }, periodEnd: { gt: window.since } },
    select: {
      address: true,
      amount: true,
      spendAmount: true,
      memoryAmount: true,
      periodStart: true,
      periodEnd: true,
    },
  });

  const settled = overlapping.filter(
    (row) => sameInstant(row.periodStart, window.since) && sameInstant(row.periodEnd, window.until)
  );

  if (settled.length !== overlapping.length) {
    const other = overlapping.find((row) => !settled.includes(row))!;
    throw new OffcutError(
      'INVARIANT',
      'Refusing to record a period that overlaps one already in the ledger: the credits inside the ' +
        'overlap would be paid for twice. Record whole, non-overlapping periods.',
      {
        details: {
          requested: { since: window.since.toISOString(), until: window.until.toISOString() },
          existing: { since: other.periodStart.toISOString(), until: other.periodEnd.toISOString() },
        },
      }
    );
  }

  if (settled.length > 0) {
    const existing = new Map(settled.map((row) => [row.address, BigInt(row.amount)]));

    for (const row of payable) {
      const before = existing.get(row.address);
      if (before === undefined) {
        throw new OffcutError(
          'INVARIANT',
          `This period is already settled and ${row.address} was not part of it. Re-running a period ` +
            'must reproduce it exactly; paying an address that was not in the original settlement ' +
            'would pay for the same credits a second time.',
          { details: { address: row.address, amount: row.amount.toString() } }
        );
      }
      if (before !== row.amount) {
        throw new OffcutError(
          'INVARIANT',
          `This period is already settled at a different figure for ${row.address}. The ledger is ` +
            'what the published roots are built from and is never rewritten in place.',
          { details: { address: row.address, recorded: before.toString(), recomputed: row.amount.toString() } }
        );
      }
      existing.delete(row.address);
    }

    if (existing.size > 0) {
      throw new OffcutError(
        'INVARIANT',
        'This period is already settled for addresses the recomputed accrual does not include. ' +
          'Something changed behind the ledger; a person has to decide which figure is right.',
        { details: { missing: [...existing.keys()] } }
      );
    }

    return {
      window,
      recorded: [],
      alreadyRecorded: settled.map((row) => ({
        address: row.address,
        amount: BigInt(row.amount),
        spend: BigInt(row.spendAmount),
        memory: BigInt(row.memoryAmount),
      })),
    };
  }

  if (payable.length === 0) return { window, recorded: [], alreadyRecorded: [] };

  // One statement, so a process killed mid-write leaves the period entirely
  // unsettled rather than half-paid — and the unique key turns a concurrent
  // second scheduler into a failure instead of a duplicate.
  await db.rewardAccrual.createMany({
    data: payable.map((row) => ({
      address: row.address,
      periodStart: window.since,
      periodEnd: window.until,
      amount: row.amount.toString(),
      // Written beside the total rather than derived from it later: the pool,
      // the rate and the ceiling in force when this period closed are not
      // recoverable afterwards, so this is the only moment the split exists.
      spendAmount: (row.spend ?? row.amount).toString(),
      memoryAmount: (row.memory ?? 0n).toString(),
    })),
  });

  return { window, recorded: payable, alreadyRecorded: [] };
}

export interface CumulativeOptions {
  /**
   * Count only periods that ended at or before this instant.
   *
   * A root built while a period is still open publishes a total that is about
   * to change, and the next root would have to contradict it. Publishers pass
   * the end of the last closed period.
   */
  through?: Date;
}

/**
 * The total each address has ever been owed, sorted by address.
 *
 * Summed in JavaScript rather than in SQL because the amounts are text: an
 * 18-decimal balance does not fit in the 64-bit integer SQLite would sum with,
 * and a REAL would lose its low digits. Row counts are one per address per
 * period, so this reads a table that grows steadily — if it ever stops being
 * cheap, the answer is a rolled-up snapshot per address, not floats.
 */
export async function cumulativeTotals(
  db: Db,
  options: CumulativeOptions = {}
): Promise<RecordedAmount[]> {
  const rows = await db.rewardAccrual.findMany({
    where: options.through ? { periodEnd: { lte: options.through } } : {},
    select: { address: true, amount: true },
  });

  // The TOTAL only, deliberately, though the rows carry the layer split. A
  // cumulative figure is what a root is built from, and a root pays one number;
  // the breakdown is a per-period fact the console reads through accrualsFor,
  // where it can be shown beside the period it belongs to. Summing it here as
  // well would put the same answer in two places that are free to drift.
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    totals.set(row.address, (totals.get(row.address) ?? 0n) + BigInt(row.amount));
  }

  return [...totals.entries()]
    .map(([address, amount]) => ({ address, amount }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

/** What one address has ever been owed. Shown in the console beside the claim. */
export async function cumulativeFor(
  db: Db,
  address: string,
  options: CumulativeOptions = {}
): Promise<bigint> {
  const rows = await db.rewardAccrual.findMany({
    where: {
      address: address.toLowerCase(),
      ...(options.through ? { periodEnd: { lte: options.through } } : {}),
    },
    select: { amount: true },
  });

  return rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
}
