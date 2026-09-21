/**
 * Configuration, and the things this service refuses to start without.
 *
 * Every refusal here is a failure that would otherwise surface at minute ten,
 * in a log nobody is watching, as a transaction that reverted. A service that
 * signs money movements should discover it cannot do its job while a human is
 * still looking at the terminal.
 *
 * Nothing about HOW MUCH is decided here. The pool, the rate and the cap come
 * from resolveRewardConfig in @offcut/rewards, which the API process also
 * reads: a second parser of OFFCUT_REWARD_* in this file would be a second
 * opinion about emission, and the two would eventually disagree in a way only
 * visible as a wrong number in a Merkle leaf. The period length comes from
 * there too, for the same reason - the daily ceiling is divided by the number
 * of periods in a day, so a publisher running on a different period length than
 * the accrual was written for would emit a multiple of what was intended.
 *
 * ---------------------------------------------------------------------------
 * The private key
 * ---------------------------------------------------------------------------
 *
 * It is read once, turned into a Wallet, and never returned, stored on the
 * config object, formatted, or attached to an error. That last one is the easy
 * mistake: interpolating a malformed value into "bad key: ..." puts the
 * near-miss of a real key into a log aggregator forever. So the parse failure
 * below says what is wrong and nothing about what was given - including its
 * length, which for a key truncated in transit would narrow the search.
 *
 * Two ways to supply it, and setting both is an error rather than a precedence
 * rule. Precedence means a stale variable silently wins over the file somebody
 * just rotated, and the only symptom is transactions signed by an address the
 * contract stopped accepting.
 */

import fs from 'node:fs';
import { Wallet, isAddress } from 'ethers';
import { resolveRewardConfig, type RewardConfig } from '@offcut/rewards';
import type { ChainClient } from './chain';

export type Network = 'mainnet' | 'testnet';

export interface PublisherConfig {
  network: Network;
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  /** One period, in milliseconds. Derived from the reward config, never set here. */
  periodMs: number;
  tickLagMs: number;
  confirmTimeoutMs: number;
  /** How many pending reports one tick will confirm. */
  usageBatchLimit: number;
  dryRun: boolean;
  /** The emission policy, as the accrual package resolved it. */
  reward: RewardConfig;
}

/**
 * Copied from apps/web/src/lib/chains.ts, where both endpoints were checked
 * against a live eth_chainId rather than taken from documentation. Duplicated
 * rather than imported because a background service must not depend on a Next
 * app, and a second copy of two URLs is cheaper than that coupling.
 */
const NETWORKS: Record<Network, { chainId: number; rpcUrl: string }> = {
  mainnet: { chainId: 4663, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com' },
  testnet: { chainId: 46630, rpcUrl: 'https://rpc.testnet.chain.robinhood.com' },
};

type Env = Record<string, string | undefined>;

function positiveInteger(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name}="${raw}" must be a positive whole number.`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): PublisherConfig {
  const network: Network = env.OFFCUT_NETWORK?.trim() === 'testnet' ? 'testnet' : 'mainnet';
  const chain = NETWORKS[network];

  const contractAddress = env.OFFCUT_CONTRACT_ADDRESS?.trim();
  if (!contractAddress) {
    throw new Error(
      'OFFCUT_CONTRACT_ADDRESS is not set. It is the address of the deployed OffcutRewards proxy - ' +
        'the one the console reads, not the implementation behind it.'
    );
  }
  if (!isAddress(contractAddress)) {
    throw new Error(`OFFCUT_CONTRACT_ADDRESS="${contractAddress}" is not an Ethereum address.`);
  }

  // Throws on a ceiling, rate, cap or period length that cannot be applied -
  // before a key is read and long before anything is signed.
  const reward = resolveRewardConfig(env as NodeJS.ProcessEnv);

  return {
    network,
    rpcUrl: env.OFFCUT_RPC_URL?.trim() || chain.rpcUrl,
    chainId: chain.chainId,
    contractAddress,
    periodMs: reward.periodMinutes * 60_000,
    tickLagMs: positiveInteger(env, 'OFFCUT_PUBLISHER_TICK_LAG_SECONDS', 15) * 1_000,
    confirmTimeoutMs: positiveInteger(env, 'OFFCUT_PUBLISHER_CONFIRM_SECONDS', 120) * 1_000,
    // Confirming is one HTTP request per report, made in series, and the whole
    // batch has to finish well inside a period. Five hundred is roughly four
    // minutes at a slow provider - headroom in a ten-minute period, and a
    // ceiling low enough that a backlog cannot stretch a tick past the next one.
    // A deployment that reports more than this per period raises it; the figure
    // is an env var rather than a constant so that it can be raised on a service
    // that is already falling behind, without a redeploy.
    usageBatchLimit: positiveInteger(env, 'OFFCUT_PUBLISHER_USAGE_BATCH', 500),
    dryRun: env.OFFCUT_PUBLISHER_DRY_RUN === '1',
    reward,
  };
}

const KEY_HELP =
  'Supply it in OFFCUT_PUBLISHER_KEY, or put it in a file and name the file in OFFCUT_PUBLISHER_KEY_FILE. ' +
  'It must be the key the contract names as publisher(); it never needs to hold reward tokens, only enough gas. ' +
  'Under OFFCUT_PUBLISHER_DRY_RUN=1 any key will do, funded or not, because nothing is sent.';

/**
 * The signing wallet.
 *
 * Deliberately not part of PublisherConfig: config objects get logged whole at
 * startup by the next person debugging something, and there must be nothing in
 * one worth stealing.
 */
export function loadSigner(env: Env = process.env): Wallet {
  const inline = env.OFFCUT_PUBLISHER_KEY?.trim();
  const file = env.OFFCUT_PUBLISHER_KEY_FILE?.trim();

  if (inline && file) {
    throw new Error(
      'Both OFFCUT_PUBLISHER_KEY and OFFCUT_PUBLISHER_KEY_FILE are set, and this service will not choose ' +
        'between them. Whichever is stale would win silently on the next rotation. Unset one.'
    );
  }

  if (!inline && !file) {
    throw new Error(`No publisher key. ${KEY_HELP}`);
  }

  let material: string;
  if (inline) {
    material = inline;
  } else {
    try {
      material = fs.readFileSync(file as string, 'utf8').trim();
    } catch {
      // The path is the operator's own, not a secret, so naming it is what
      // makes this actionable. The contents never reach the message.
      throw new Error(`OFFCUT_PUBLISHER_KEY_FILE="${file}" could not be read.`);
    }
    if (!material) throw new Error(`OFFCUT_PUBLISHER_KEY_FILE="${file}" is empty.`);
    // The file `pnpm --filter @offcut/contracts keys` writes carries the key
    // among labelled lines; a bare key file is just the key. Either way the
    // first 0x + 64 hex token is the key, and nothing else in the file matters.
    const token = material.match(/0x[0-9a-fA-F]{64}/);
    if (token) material = token[0];
  }

  try {
    return new Wallet(material.startsWith('0x') ? material : `0x${material}`);
  } catch {
    // Nothing derived from the value goes in here - not the value, not its
    // length, not a prefix. A truncated real key is still most of a real key.
    throw new Error(`The publisher key is not a valid private key. ${KEY_HELP}`);
  }
}

/**
 * Refuses to run as a key the contract will not accept.
 *
 * Without this the service looks healthy for ten minutes and then reverts with
 * NotPublisher, which in a log reads like a chain problem rather than a
 * configuration one. Both addresses are public; printing them is what turns
 * this into a one-line fix.
 */
/**
 * How patiently the first read waits for the RPC.
 *
 * The public Robinhood endpoint answers 429 "Rate Limit Hit, limit will reset
 * in 60 seconds" to a client that has been busy - and a service that dies on
 * that answer, gets restarted by pm2 and asks again is exactly such a client.
 * So the startup read is retried across a couple of minutes, with the reason
 * logged each time, before it is treated as a configuration error. Without a
 * policy there is a single attempt, which is what a test or a one-off check
 * wants.
 */
export interface StartupRetry {
  /** Pauses between attempts, in ms; one more attempt than there are pauses. */
  delaysMs: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: { warn(line: string): void };
}

export const STARTUP_RETRY: StartupRetry = {
  delaysMs: [5_000, 15_000, 30_000, 60_000, 60_000],
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function assertIsPublisher(client: ChainClient, retry?: StartupRetry): Promise<void> {
  const delays = retry?.delaysMs ?? [];
  const sleep = retry?.sleep ?? realSleep;
  let expected: string | undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      expected = await client.publisher();
      break;
    } catch (error) {
      if (attempt >= delays.length) break;
      const wait = delays[attempt] as number;
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      retry?.log?.warn(
        `Could not read publisher() from ${client.contractAddress} yet (${reason}); ` +
          `retrying in ${Math.round(wait / 1000)} s (${attempt + 1} of ${delays.length}).`
      );
      await sleep(wait);
    }
  }
  if (expected === undefined) {
    // A read that fails here almost always means the address is right for a
    // different network, or names the implementation rather than the proxy.
    // Either way the raw ethers decoding error names neither.
    throw new Error(
      `Could not read publisher() from ${client.contractAddress} on chain ${client.chainId}. Check that ` +
        'it is the OffcutRewards proxy on this network, not the implementation behind it, and that the RPC ' +
        'endpoint above is reachable.'
    );
  }

  if (expected.toLowerCase() === client.signerAddress.toLowerCase()) return;

  throw new Error(
    `This key signs as ${client.signerAddress}, but ${client.contractAddress} only accepts roots from ` +
      `${expected}. Either supply the publisher key, or have the contract owner call setPublisher(${client.signerAddress}).`
  );
}
