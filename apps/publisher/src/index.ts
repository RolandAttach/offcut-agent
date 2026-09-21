#!/usr/bin/env node
/**
 * OFFCUT reward publisher.
 *
 * Every ten minutes: ask OpenRouter what the reports agents filed actually cost,
 * settle the period that just closed, rebuild the cumulative Merkle tree, write
 * the proofs where the console can serve them, and publish the root to
 * OffcutRewards - unless the root has not moved, in which case it sends nothing
 * at all.
 *
 * The first of those is what makes the rest of it worth running. Reward weight
 * follows CONFIRMED spend, and nothing else in a deployment asks a provider
 * anything, so a publisher that skipped it would settle every period at zero.
 *
 * That last clause is most of the operating cost. A publish measured at
 * 0.0000036 ETH, 144 times a day, is around forty-six dollars a month if it
 * fires unconditionally; on a product where most ten-minute windows contain no
 * retrievals, publishing only when the root changes makes quiet hours free. The
 * chain is not asked to store a statement it is already storing.
 *
 * Run it with:
 *
 *   OFFCUT_CONTRACT_ADDRESS=0x...    the deployed OffcutRewards proxy
 *   OFFCUT_PUBLISHER_KEY_FILE=...    or OFFCUT_PUBLISHER_KEY
 *   OFFCUT_NETWORK=testnet           anything but mainnet, while rehearsing
 *
 * The pool, rate, cap and period length come from OFFCUT_REWARD_* and are read
 * by @offcut/rewards, which the API reads too. OFFCUT_PUBLISHER_DRY_RUN=1
 * rehearses the whole thing without sending a transaction, and
 * OFFCUT_PUBLISHER_USAGE_BATCH raises how many reports one tick confirms, for a
 * deployment working through a backlog.
 */

import path from 'node:path';
import { disconnectPrisma, getPrisma, resolveDataDir } from '@offcut/core';
import { dryRunClient, ethersChainClient, isRateLimited } from './chain';
import { STARTUP_RETRY, assertIsPublisher, loadConfig, loadSigner } from './config';
import { consoleLogger, logTick } from './log';
import { msUntilNextTick } from './periods';
import { fileProofWriter } from './proofs';
import { rewards } from './rewards';
import { runOnce, type ServiceDeps } from './service';
import { fileStateStore } from './state';
import { usage } from './usage';

async function main(): Promise<void> {
  const log = consoleLogger;
  const config = loadConfig();

  // Before anything is constructed and before a single RPC call: a missing key
  // is a configuration mistake and should read as one.
  const signer = loadSigner();

  const base = ethersChainClient({
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    wallet: signer,
    confirmTimeoutMs: config.confirmTimeoutMs,
  });
  const chain = config.dryRun ? dryRunClient(base) : base;

  // The cursor sits beside the proofs but not inside them: the proofs directory
  // is meant to be served as static files, and the cursor is operational state
  // nobody outside this process has any business reading.
  const rewardsDir = path.join(resolveDataDir(), 'rewards');
  const proofsDir = path.join(rewardsDir, 'proofs');

  // Before the first read, not after it: if the contract turns out to be
  // unreachable or the wrong one, the refusal is far more useful next to the
  // address and endpoint it was reaching for.
  log.info(`publisher ${chain.signerAddress}`);
  log.info(`contract ${config.contractAddress} on ${config.network} (chain ${config.chainId}) via ${config.rpcUrl}`);
  log.info(`period ${config.reward.periodMinutes} minutes; ceiling ${config.reward.dailyCeiling} base units a day`);
  log.info(`proofs ${proofsDir}`);
  if (config.dryRun) {
    // Worth stating plainly: a dry run is not read-only. Accruals are written
    // to the ledger and proof files are written to disk; only the transaction
    // is withheld.
    log.warn('DRY RUN: no transaction will be sent. Accruals are still recorded and proof files still written.');
  }

  await assertIsPublisher(chain, { ...STARTUP_RETRY, log });

  const deps: ServiceDeps = {
    db: getPrisma(),
    chain,
    rewards,
    usage,
    state: fileStateStore(path.join(rewardsDir, 'publisher.json')),
    proofs: fileProofWriter(proofsDir),
    config,
    now: () => Date.now(),
    log,
  };

  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    try {
      logTick(log, await runOnce(deps), config.dryRun);
    } catch (error) {
      // The loop outlives any one tick. A database that went away, an RPC that
      // timed out, a ledger that refused a figure - none is a reason to stop
      // settling periods, and the cursor has not moved past whatever failed, so
      // the next tick picks up exactly where this one stopped.
      // A public endpoint refusing us for a minute is not a fault in this
      // service and nothing is lost by it, so it does not read as one.
      if (isRateLimited(error)) {
        log.warn('the public RPC is rate-limiting this client; nothing was lost, the next tick settles it.');
      } else {
        log.error(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const schedule = (): void => {
    if (stopping) return;
    // Recomputed from the wall clock each time rather than set once, so a tick
    // that runs long does not push every period after it off its boundary.
    timer = setTimeout(() => {
      inFlight = tick().then(schedule);
    }, msUntilNextTick(Date.now(), config.periodMs, config.tickLagMs));
  };

  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: finishing the period in flight, then stopping.`);
    if (timer) clearTimeout(timer);
    void inFlight
      .then(() => disconnectPrisma())
      .then(() => process.exit(0));
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // Immediately, not on the next boundary: whatever was missed while this was
  // down is owed now, and waiting ten minutes to discover that delays the first
  // root by ten minutes for no reason.
  inFlight = tick();
  await inFlight;
  schedule();
}

main().catch((error) => {
  // Nothing reaching here has ever seen the private key: loadSigner never puts
  // key material in an error, and every other failure is about addresses, URLs
  // and numbers.
  console.error(`[offcut-publisher] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
