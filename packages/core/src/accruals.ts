/**
 * The reward ledger, read back for the person it belongs to.
 *
 * The writing half lives in @offcut/rewards (recordAccruals, cumulativeTotals):
 * the publisher closes a period, prices the confirmed spend inside it, and
 * writes one row per address per period. Nothing in that package is importable
 * here - core is the layer the publisher itself sits on - and the API cannot
 * reach it either, so the read the console needs would otherwise have to be a
 * hand-written query in a controller. It is here instead, next to the other
 * reads of the same database, for the reason every read in this package is:
 * one place to change when the columns change.
 *
 * BASE UNITS, AS STRINGS, ALL THE WAY OUT. An 18-decimal token amount does not
 * fit in a JavaScript number and does not fit in the 64-bit integer SQLite
 * would sum with, so the amounts are stored as text, summed as BigInt here, and
 * handed on as decimal strings. Nothing in this file divides by 1e18: the
 * figure a person reads is formatted at the edge, and a float that crossed this
 * boundary would be a rounding error in a payable amount that nobody
 * downstream could audit or even see.
 *
 * WHAT THIS IS NOT. An accrual is what a period decided an address was owed -
 * the basis of a claim, not a claim and not a balance. What has actually been
 * claimed lives on the chain, and what is claimable now lives in the published
 * proof; both are read by the browser, from the contract and from /rewards/proof,
 * because both can change without this database hearing about it.
 */

import type { Db } from './db';

/** One closed period, as it was written down. */
export interface AccrualPeriod {
  /** Inclusive, ISO. */
  periodStart: string;
  /** Exclusive, ISO. */
  periodEnd: string;
  /** Token base units, decimal. Never a float. */
  amountBaseUnits: string;
  /**
   * The same amount, split by the layer that earned it.
   *
   * Two layers pay into one accrual: confirmed AI spend, and memory another
   * agent used. They always sum to `amountBaseUnits`, and they are carried
   * rather than derived because nothing downstream can work them out — the
   * pool, the rate and the ceiling in force when a period closed are not
   * recoverable afterwards. Periods settled before the memory layer existed
   * read as all spend, which is what they were.
   */
  spendBaseUnits: string;
  memoryBaseUnits: string;
}

export interface AccrualHistory {
  /** Lowercase 0x, as the ledger stores it. */
  address: string;
  /** Every period ever recorded for this address, summed. */
  cumulativeBaseUnits: string;
  /** That total, split the same way. The two sum to cumulativeBaseUnits. */
  cumulativeSpendBaseUnits: string;
  cumulativeMemoryBaseUnits: string;
  /** How many periods that sum is made of. */
  periods: number;
  /** Newest first, at most `limit`. */
  recent: AccrualPeriod[];
}

/** Enough history to show a person how their earning has gone, not a full export. */
const DEFAULT_LIMIT = 48;
const MAX_LIMIT = 500;

/**
 * What one address has been accrued, and the most recent periods it came from.
 *
 * The cumulative total counts EVERY period, not the ones returned: a person
 * whose console lists the last two days must still be told the whole figure,
 * because the whole figure is what a proof will pay on. So the rows are summed
 * before they are sliced, which also means this reads one address's rows rather
 * than counting them in SQL - the amounts are text, and text cannot be summed
 * by the database without losing its low digits.
 */
export async function accrualsFor(
  db: Db,
  address: string,
  options: { limit?: number } = {}
): Promise<AccrualHistory> {
  const normalized = address.trim().toLowerCase();
  const limit = Math.max(
    0,
    Math.min(MAX_LIMIT, Math.trunc(options.limit ?? DEFAULT_LIMIT))
  );

  const empty: AccrualHistory = {
    address: normalized,
    cumulativeBaseUnits: '0',
    cumulativeSpendBaseUnits: '0',
    cumulativeMemoryBaseUnits: '0',
    periods: 0,
    recent: [],
  };
  if (!normalized) return empty;

  const rows = await db.rewardAccrual.findMany({
    where: { address: normalized },
    // Newest first here rather than in JavaScript, so `recent` is a slice of an
    // ordering the database did and two databases holding the same rows answer
    // in the same order.
    orderBy: { periodStart: 'desc' },
    select: {
      periodStart: true,
      periodEnd: true,
      amount: true,
      spendAmount: true,
      memoryAmount: true,
    },
  });

  /**
   * The split of one row, with the columns' own history allowed for.
   *
   * Both columns default to "0", so a period settled before the memory layer
   * existed carries a total and no parts. Those periods were spend and nothing
   * else — the memory layer did not exist to earn from — so they are read as
   * spend here rather than as a breakdown that does not add up. The condition
   * is deliberately "no parts at all": a real row always has parts, because an
   * accrual of nothing is never written down.
   */
  const splitOf = (row: { amount: string; spendAmount: string; memoryAmount: string }) => {
    const amount = BigInt(row.amount);
    const spend = BigInt(row.spendAmount);
    const memory = BigInt(row.memoryAmount);
    if (spend === 0n && memory === 0n && amount > 0n) return { amount, spend: amount, memory: 0n };
    return { amount, spend, memory };
  };

  let cumulative = 0n;
  let cumulativeSpend = 0n;
  let cumulativeMemory = 0n;
  for (const row of rows) {
    const split = splitOf(row);
    cumulative += split.amount;
    cumulativeSpend += split.spend;
    cumulativeMemory += split.memory;
  }

  return {
    address: normalized,
    cumulativeBaseUnits: cumulative.toString(),
    cumulativeSpendBaseUnits: cumulativeSpend.toString(),
    cumulativeMemoryBaseUnits: cumulativeMemory.toString(),
    periods: rows.length,
    recent: rows.slice(0, limit).map((row) => {
      const split = splitOf(row);
      return {
        periodStart: row.periodStart.toISOString(),
        periodEnd: row.periodEnd.toISOString(),
        amountBaseUnits: split.amount.toString(),
        spendBaseUnits: split.spend.toString(),
        memoryBaseUnits: split.memory.toString(),
      };
    }),
  };
}
