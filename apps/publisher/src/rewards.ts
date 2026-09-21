/**
 * The seam onto @offcut/rewards.
 *
 * The accrual rules - the fixed pool, the per-earner cap, the pro-rata split -
 * live in that package because they are the part most likely to change the week
 * a farm appears, and a rule that has to change in a hurry should not require
 * redeploying the thing that signs transactions. This service decides WHEN a
 * period is settled and whether a root reaches the chain. It decides nothing
 * about who is owed what, and it recomputes none of it.
 *
 * Narrowed to the four functions used, and bound once here, so that the tests
 * can drive the schedule and the skip logic against a stand-in without a
 * database - and so that anything this service starts relying on shows up as a
 * line in this file rather than as an import buried three levels down.
 */

import type { CreditWindow, Db } from '@offcut/core';
import {
  accrueWindow,
  buildTree,
  cumulativeTotals,
  recordAccruals,
  type LedgerWriteResult,
  type RecordedAmount,
  type RewardConfig,
  type RewardEntry,
  type RewardTree,
  type WindowAccrual,
} from '@offcut/rewards';

export interface RewardsApi {
  /** Computes one period's amounts. Writes nothing. */
  accrueWindow(db: Db, window: CreditWindow, config: RewardConfig): Promise<WindowAccrual>;
  /** Writes them, or establishes that an earlier run already did. */
  recordAccruals(db: Db, window: CreditWindow, amounts: RecordedAmount[]): Promise<LedgerWriteResult>;
  /** What every address has ever been owed, sorted by address. */
  cumulativeTotals(db: Db, options?: { through?: Date }): Promise<RecordedAmount[]>;
  buildTree(entries: RewardEntry[]): RewardTree;
}

export const rewards: RewardsApi = { accrueWindow, recordAccruals, cumulativeTotals, buildTree };
