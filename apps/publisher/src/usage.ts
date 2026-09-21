/**
 * The seam onto confirmation in @offcut/core.
 *
 * Kept apart from rewards.ts because the two answer different questions.
 * rewards decides what confirmed spend is worth; this decides what is confirmed
 * at all, and nothing is worth anything until it is. reportUsage writes a row as
 * `pending` and spendInWindow only ever sums `verified`, so a period accrued
 * without this having run pays nobody, however much was really spent.
 *
 * Bound once here for the same reasons as the rewards seam: a tick can be driven
 * in a test without reaching OpenRouter, and the one third-party call this
 * service makes on somebody else's account is a line in a file rather than an
 * import three levels down.
 */

import {
  openRouterUsageSource,
  verifyPendingUsage,
  type Db,
  type VerificationRun,
} from '@offcut/core';

export interface UsageApi {
  /** Asks the provider about pending reports and settles what it answers for. */
  settlePending(db: Db, options: { limit: number }): Promise<VerificationRun>;
}

export const usage: UsageApi = {
  // A fresh source per run rather than one held for the life of the process.
  // The source remembers each workspace's resolved key for as long as it exists,
  // and a workspace that had no key when this service started must not be
  // remembered as keyless until somebody restarts it - linking a key has to
  // start earning on the next tick, which is what the console promises.
  settlePending: (db, options) => verifyPendingUsage(db, openRouterUsageSource(db), options),
};
