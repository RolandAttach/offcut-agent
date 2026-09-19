/**
 * @offcut/rewards — the accounting between confirmed AI spend and a payment.
 *
 * Three steps, in order, each with its own file:
 *
 *   config.ts   every number that decides how much may be emitted
 *   accrual.ts  one window of confirmed spend AND of memory other agents used
 *               -> amounts owed per address, the two layers added into one
 *   ledger.ts   those amounts, written down once, and summed into a cumulative
 *               total per address
 *   merkle.ts   that total, as a root the distributor will verify
 *
 * Nothing here signs, sends or publishes anything. The publisher key lives on a
 * server and this package is imported by things that run in the API process, so
 * the split is deliberate: the part that decides amounts has no way to move
 * money, and the part that moves money makes no decisions.
 */

export {
  DEFAULT_REWARD_CONFIG,
  ONE_TOKEN,
  POINTS_PER_DOLLAR,
  TOKEN_DECIMALS,
  assertUsableConfig,
  capBasisPoints,
  capForPool,
  ceilingPerPeriod,
  memoryCeilingPerPeriod,
  periodsPerDay,
  resolveRewardConfig,
  type RewardConfig,
} from './config';

export {
  accrueWindow,
  type AccrualSummary,
  type AddressAmount,
  type LayerName,
  type LayerSummary,
  type SkipReason,
  type SkippedWorkspace,
  type WindowAccrual,
  type WorkspaceShare,
} from './accrual';

export {
  cumulativeFor,
  cumulativeTotals,
  recordAccruals,
  type CumulativeOptions,
  type LedgerWriteResult,
  type RecordedAmount,
} from './ledger';

export { buildTree, leafOf, type RewardEntry, type RewardTree } from './merkle';
