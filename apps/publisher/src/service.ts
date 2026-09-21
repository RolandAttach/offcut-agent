/**
 * One tick: confirm what was spent, settle every period that has closed, then
 * publish the root once.
 *
 * The first step is not bookkeeping and is easy to overlook - see verifyUsage
 * below, which is the only thing in a deployment that turns a report into money.
 *
 * ---------------------------------------------------------------------------
 * Why accrual and publication are separate steps
 * ---------------------------------------------------------------------------
 *
 * Settling a period is bookkeeping and must happen exactly once for that
 * period, ever. Publishing is a transaction that can fail for reasons that have
 * nothing to do with us - a full block, a stalled RPC, an empty gas tank. Tied
 * together, a failed transaction would either roll back a period that genuinely
 * happened or leave the cursor lying about one that did not.
 *
 * Because roots are cumulative they do not need to be tied together. Every root
 * carries the total each address has ever earned, so a publication that never
 * lands is superseded rather than lost: the next one says everything the failed
 * one would have. That is why a failure here waits for the next period instead
 * of retrying immediately - hammering a chain that just refused us buys
 * nothing, and the self-healing is free.
 *
 * The same property is why a long catch-up sends ONE transaction. Draining six
 * missed periods means six ledger writes and then a single root that already
 * accounts for all six; six transactions would pay six times the gas to say
 * five things the sixth also says.
 *
 * ---------------------------------------------------------------------------
 * Why replaying a period is safe
 * ---------------------------------------------------------------------------
 *
 * A crash between writing the ledger and writing the cursor leaves a period
 * that will be settled again on restart. recordAccruals is built for exactly
 * that: the same window with the same figures writes nothing new, and the same
 * window with DIFFERENT figures throws rather than quietly contradicting a root
 * that is already on chain. So this file replays without ceremony, and the one
 * case that needs a person - the figures changed underneath a settled period -
 * arrives as a loud failure instead of as a number nobody can explain later.
 */

import type { Db } from '@offcut/core';
import type { LedgerWriteResult, RewardEntry, WindowAccrual } from '@offcut/rewards';
import type { ChainClient } from './chain';
import type { PublisherConfig } from './config';
import { buildProofDocument, type ProofWriter } from './proofs';
import { duePeriods, lastClosedPeriod, periodAt, type Period } from './periods';
import type { RewardsApi } from './rewards';
import type { PublisherState, StateStore } from './state';
import type { UsageApi } from './usage';

export interface PeriodOutcome {
  period: number;
  since: Date;
  until: Date;
  /**
   * Every point of confirmed spend in the window, payable or not - the
   * denominator of the SPEND split, and nothing to do with the memory one.
   * Memory credits are counted in `memory.credits` and are deliberately not
   * added in here: a millionth of a dollar and a used record cannot be summed.
   */
  points: number;
  /** Addresses owed something for this window, across both layers. */
  addresses: number;
  /** Total owed for this window, in base units. The sum of the two below. */
  amount: bigint;
  /** The spend layer: confirmed millionths of a dollar, and what they accrued. */
  spend: { points: number; amount: bigint };
  /** The memory layer: records another agent used, and what they accrued. */
  memory: { credits: number; amount: bigint };
  /** Workspace-and-layer pairs that earned something and could not be paid. */
  skipped: number;
  /** Whether an earlier run had already written this period. */
  replayed: boolean;
  notes: string[];
}

export type VerificationOutcome =
  | { kind: 'settled'; verified: number; rejected: number; deferred: number }
  | { kind: 'failed'; reason: string };

export type PublishOutcome =
  | { kind: 'published'; root: string; rootIndex: number; hash: string; holders: number }
  | { kind: 'unchanged'; root: string; rootIndex: number }
  | { kind: 'nothing-earned' }
  | { kind: 'paused' }
  | { kind: 'failed'; reason: string };

export interface TickReport {
  /** What confirming reports did before any of it was accrued. */
  verification: VerificationOutcome;
  periods: PeriodOutcome[];
  publish: PublishOutcome;
}

export interface Logger {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

export interface ServiceDeps {
  db: Db;
  chain: ChainClient;
  rewards: RewardsApi;
  usage: UsageApi;
  state: StateStore;
  proofs: ProofWriter;
  config: PublisherConfig;
  now(): number;
  log: Logger;
}

/**
 * Where a first-ever start begins: the period that has just closed, and nothing
 * before it.
 *
 * The alternative - walking back to the first credit ever written - would emit
 * a day's ceiling for every day of history in one burst, which is the opposite
 * of a fixed pool. An operator who genuinely wants a backfill writes the cursor
 * by hand; it is one number, and it is documented for that.
 */
function coldStart(deps: ServiceDeps): PublisherState {
  return { lastCompletedPeriod: lastClosedPeriod(deps.now(), deps.config.periodMs) - 1 };
}

function notesFor(accrual: WindowAccrual, write: LedgerWriteResult): string[] {
  const notes: string[] = [];
  const { summary } = accrual;

  if (summary.totalPoints > 0 || accrual.layers.memory.units > 0) {
    notes.push(
      `pool bound by ${summary.boundBy}; ${summary.undistributed} base units were not allocated and stay in the contract`
    );
  }

  // Grouped by reason AND layer rather than listed per workspace: the reason is
  // what an operator can act on, and "eleven workspaces have no wallet
  // connected" is a different conversation from "one wallet on file is
  // unusable". The layer comes with it because the two units are not the same
  // quantity - "3 earned nothing" is unreadable when it could be three
  // millionths of a dollar or three records somebody else found useful.
  const byReason = new Map<string, number>();
  for (const skip of accrual.skipped) {
    const at = `${skip.layer}:${skip.reason}`;
    byReason.set(at, (byReason.get(at) ?? 0) + skip.units);
  }
  for (const [at, units] of byReason) {
    const [layer, reason] = at.split(':');
    notes.push(`${units} ${layer === 'memory' ? 'credits' : 'points'} earned nothing (${reason})`);
  }

  // Named per layer, because a spender held at the spend cap is not capped on a
  // memory layer they were paid in full on, and an operator reading one list
  // cannot tell which rule fired.
  for (const layer of [accrual.layers.spend, accrual.layers.memory]) {
    if (layer.cappedAddresses.length > 0) {
      notes.push(`held at the per-earner ${layer.layer} cap: ${layer.cappedAddresses.join(', ')}`);
    }
  }

  if (write.recorded.length === 0 && write.alreadyRecorded.length > 0) {
    notes.push('already in the ledger from an earlier run; nothing was written a second time');
  }

  return notes;
}

/**
 * Turns what agents reported into what the provider says they actually spent.
 *
 * This is the step the whole reward metric stands on. Weight follows CONFIRMED
 * spend, `spendInWindow` selects only rows a provider has confirmed, and a
 * report lands as `pending`. Nothing else in a running deployment asks a
 * provider anything - so without this call every report stays pending for the
 * life of the deployment, every window comes back empty, and the pool pays out
 * nothing forever without a single error to show for it. That silence is why it
 * is called here rather than left to an operator to remember.
 *
 * Before the periods below are settled, so a report made moments ago is already
 * confirmed by the time a window that could pay for it is closed.
 *
 * It cannot disturb a period that is already settled. Confirmation stamps
 * `verifiedAt` with the current instant, and the windows settled below have all
 * closed, so a row confirmed here always falls in the period still open - never
 * in one already written, which is what would otherwise make a replay recompute
 * a settled window at a different figure and throw.
 */
async function verifyUsage(deps: ServiceDeps): Promise<VerificationOutcome> {
  try {
    const run = await deps.usage.settlePending(deps.db, { limit: deps.config.usageBatchLimit });
    return { kind: 'settled', ...run };
  } catch (error) {
    // Swallowed so that one unreachable provider cannot stop everyone else
    // being paid. Nothing is lost by carrying on: an unconfirmed report stays
    // pending and is picked up by the next tick, whereas a throw here would
    // hold the cursor still and delay every workspace that did confirm.
    //
    // The message is logged, and it comes from a path that handles workspace
    // OpenRouter keys - but it can never carry one. Every failure that touches
    // a credential is caught per row inside verifyPendingUsage, and the adapter
    // builds its own messages out of status codes precisely so that no response
    // body and no key material can reach a line like this one.
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function settle(deps: ServiceDeps, period: Period): Promise<PeriodOutcome> {
  const window = { since: period.since, until: period.until };

  const accrual = await deps.rewards.accrueWindow(deps.db, window, deps.config.reward);
  const write = await deps.rewards.recordAccruals(
    deps.db,
    window,
    // The split travels with the total. The pool, the rate and the ceiling in
    // force when this period closed are not recoverable afterwards, so this is
    // the only moment at which "what was I paid FOR" can be written down.
    accrual.amounts.map((row) => ({
      address: row.address,
      amount: row.amount,
      spend: row.spend,
      memory: row.memory,
    }))
  );

  // Only now. The ledger is what a root is built from, so the cursor may never
  // run ahead of it: behind it is a replay that costs nothing, ahead of it is a
  // period silently never paid.
  //
  // Spread, not replaced: the file also remembers the root last seen on chain,
  // and dropping that here would send the next tick back to the RPC for an
  // answer it already has.
  deps.state.write({ ...deps.state.read(), lastCompletedPeriod: period.index });

  return {
    period: period.index,
    since: period.since,
    until: period.until,
    points: accrual.summary.totalPoints,
    addresses: accrual.amounts.length,
    amount: accrual.summary.distributed,
    spend: { points: accrual.layers.spend.units, amount: accrual.layers.spend.distributed },
    memory: { credits: accrual.layers.memory.units, amount: accrual.layers.memory.distributed },
    skipped: accrual.skipped.length,
    replayed: write.recorded.length === 0 && write.alreadyRecorded.length > 0,
    notes: notesFor(accrual, write),
  };
}

/**
 * Publishes the cumulative root, unless it is already the one on chain.
 *
 * `through` is the end of the last period this service has settled, never the
 * current instant: a root built while a period is still being written would
 * publish a total that is about to change, and the next root would have to
 * contradict it.
 */
/** How long a root seen on chain is taken at its word before it is read again. */
export const RECHECK_CHAIN_MS = 6 * 60 * 60_000;

async function publish(deps: ServiceDeps, settledThrough: number): Promise<PublishOutcome> {
  const through = periodAt(settledThrough, deps.config.periodMs).until;
  const totals = await deps.rewards.cumulativeTotals(deps.db, { through });
  if (totals.length === 0) return { kind: 'nothing-earned' };

  const entries: RewardEntry[] = totals.map((row) => ({
    account: row.address,
    cumulativeAmount: row.amount,
  }));
  const tree = deps.rewards.buildTree(entries);

  const writeProofs = (rootIndex: number): void => {
    deps.proofs.write(
      buildProofDocument(tree, {
        rootIndex,
        chainId: deps.chain.chainId,
        contract: deps.chain.contractAddress,
        publishedAt: new Date(deps.now()),
        dryRun: deps.config.dryRun,
      })
    );
  };

  // The cheapest read is the one not made. While the cumulative root has not
  // moved since we last saw it on chain, the chain's answer is known, and
  // asking it twice every ten minutes for that answer is what the public
  // endpoint was refusing. Re-checked when the root moves, and periodically
  // anyway, so a chain that moved without us cannot stay unnoticed.
  const remembered = deps.state.read()?.confirmed;
  if (remembered && remembered.root === tree.root && deps.now() - remembered.at < RECHECK_CHAIN_MS) {
    if (deps.proofs.latestRoot() !== tree.root) writeProofs(remembered.index);
    return { kind: 'unchanged', root: tree.root, rootIndex: remembered.index };
  }

  const onchain = await deps.chain.currentRoot();
  const remember = (root: string, index: number): void => {
    const cursor = deps.state.read();
    if (cursor) deps.state.write({ ...cursor, confirmed: { root, index, at: deps.now() } });
  };

  if (onchain.root === tree.root) {
    remember(tree.root, onchain.index);
    // Quiet hours: nobody earned anything new, so the chain already says
    // everything there is to say and a transaction would pay gas to restate it.
    //
    // The same branch covers a publication that landed just before this process
    // died. The files are re-derived rather than assumed, because proofs for a
    // live root that has no file leave everyone in it unable to claim until the
    // next time somebody happens to earn.
    if (deps.proofs.latestRoot() !== tree.root) writeProofs(onchain.index);
    return { kind: 'unchanged', root: tree.root, rootIndex: onchain.index };
  }

  // publishRoot is whenNotPaused. Asking first turns an owner pausing the
  // contract from a revert every ten minutes into one honest log line.
  if (await deps.chain.paused()) return { kind: 'paused' };

  try {
    const receipt = await deps.chain.publishRoot(tree.root);
    // Only after the receipt. A file written first would describe a root that
    // may never exist, and the console would hand out proofs against it.
    writeProofs(receipt.rootIndex);
    remember(tree.root, receipt.rootIndex);
    return {
      kind: 'published',
      root: tree.root,
      rootIndex: receipt.rootIndex,
      hash: receipt.hash,
      holders: entries.length,
    };
  } catch (error) {
    // Swallowed on purpose: the next period publishes a root that supersedes
    // this one. Retrying here would spend gas racing whatever just refused us.
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function runOnce(deps: ServiceDeps): Promise<TickReport> {
  const verification = await verifyUsage(deps);

  let state = deps.state.read();
  if (!state) {
    state = coldStart(deps);
    // Written immediately. Leaving a cold start unrecorded means a crash before
    // the first period is settled recomputes the starting point from a later
    // clock, and every period in between is silently never paid.
    deps.state.write(state);
    deps.log.info(
      `No cursor found. Starting at period ${state.lastCompletedPeriod + 1}; nothing earlier will be settled.`
    );
  }

  const due = duePeriods(state.lastCompletedPeriod, deps.now(), deps.config.periodMs);
  if (due.length > 1) {
    deps.log.warn(`Catching up ${due.length} periods missed while this service was down.`);
  }

  const periods: PeriodOutcome[] = [];
  let settledThrough = state.lastCompletedPeriod;
  for (const index of due) {
    periods.push(await settle(deps, periodAt(index, deps.config.periodMs)));
    settledThrough = index;
  }

  return { verification, periods, publish: await publish(deps, settledThrough) };
}
