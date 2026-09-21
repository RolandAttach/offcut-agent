/**
 * The only part of this service that talks to a blockchain.
 *
 * Kept behind an interface with four methods so the schedule, the cursor and
 * the skip logic can be tested against a fake that answers instantly and
 * deterministically. A test that needs an RPC endpoint to prove that a period
 * is not paid twice is a test nobody runs.
 *
 * The ABI is four lines rather than the generated typechain bindings. This
 * service is deployed on its own and should not need the contracts package, its
 * compiler or its artifacts installed to sign one function call; the contract
 * test suite is what guarantees the signatures below still exist.
 */

import { Contract, FetchRequest, JsonRpcProvider, Wallet } from 'ethers';

const ABI = [
  'function publisher() view returns (address)',
  'function merkleRoot() view returns (bytes32)',
  'function rootIndex() view returns (uint256)',
  'function paused() view returns (bool)',
  'function publishRoot(bytes32 root)',
];

export interface RootState {
  /** 32-byte hex. All zeroes before the first publication. */
  root: string;
  /** Monotonic; the index the current root was published under. */
  index: number;
}

export interface PublishReceipt {
  hash: string;
  rootIndex: number;
}

export interface ChainClient {
  /** The address the contract will accept roots from. */
  publisher(): Promise<string>;
  /** Whether publishing is currently paused by the owner. */
  paused(): Promise<boolean>;
  currentRoot(): Promise<RootState>;
  /** Sends publishRoot and resolves once it is mined. */
  publishRoot(root: string): Promise<PublishReceipt>;
  /** The address this client signs as. */
  readonly signerAddress: string;
  readonly contractAddress: string;
  readonly chainId: number;
}

export const ZERO_ROOT = `0x${'0'.repeat(64)}`;

export interface EthersClientOptions {
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  /** Already constructed, so the private key never passes through this module. */
  wallet: Wallet;
  /** How long to wait for a receipt before giving up on this period. */
  confirmTimeoutMs: number;
}

/** A 429 from the public endpoint, which announces its own reset in the body. */
export function isRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate limit|exceeded maximum retry limit/i.test(message);
}

/**
 * Waits out the window the endpoint announces, once, and tries again.
 *
 * ethers' own throttle gives up inside the minute: its backoff is randomised
 * (`slotInterval * random * 2^attempt`, which is frequently zero on the early
 * attempts), so six attempts can be spent in a few seconds and the tick dies
 * with "exceeded maximum retry limit" while the limit still has fifty seconds
 * to run. This waits the whole announced minute instead. Ticks are ten minutes
 * apart, so a read that takes two of them costs nothing.
 */
export const RATE_LIMIT_WAIT_MS = 65_000;

async function patiently<T>(call: () => Promise<T>, attempts = 2, waitMs = RATE_LIMIT_WAIT_MS): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !isRateLimited(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

export function ethersChainClient(options: EthersClientOptions): ChainClient {
  // The chain id is passed rather than discovered so a misconfigured RPC URL
  // fails as a mismatch instead of silently publishing to another network.
  //
  // staticNetwork: without it ethers opens with an eth_chainId probe and, when
  // that probe fails, re-sends it EVERY SECOND for as long as the process
  // lives. Against the public Robinhood RPC, which answers 429 "Rate Limit
  // Hit, limit will reset in 60 seconds" to a busy client, that probe loop is
  // what kept the limit tripped: the service could never get its first real
  // read through. The chain id is configured, so nothing needs probing; a wrong
  // URL still fails on the first contract read, with the mismatch spelled out.
  const network = { chainId: options.chainId, name: 'robinhood' };
  //
  // batchMaxCount 1: ethers folds calls made in the same tick into one JSON-RPC
  // batch, and the public endpoint answers a batch with the same 429 it gives a
  // burst - a whole tick failed on 2026-09-21 that way. One call per request
  // costs a few more round trips and stays under the limit.
  //
  // PATIENCE, because the public endpoint answers 429 "Rate Limit Hit, limit
  // will reset in 60 seconds" to anyone who asks twice in a hurry, and it was
  // refusing about half of all ticks on 2026-09-22. ethers' default throttle
  // gives up long before that minute is over, and the whole tick then fails
  // with "exceeded maximum retry limit". Six attempts on a doubling 2-second
  // slot wait roughly 2+4+8+16+32+64 seconds, so a tick rides out a full
  // window instead of dying inside it. A tick may take two minutes; they are
  // ten minutes apart, and a missed one is caught up by the next.
  const connection = new FetchRequest(options.rpcUrl);
  connection.setThrottleParams({ slotInterval: 2_000, maxAttempts: 6 });
  const provider = new JsonRpcProvider(connection, network, { staticNetwork: true, batchMaxCount: 1 });
  const signer = options.wallet.connect(provider);
  const contract = new Contract(options.contractAddress, ABI, signer);

  // A free function rather than a method, so publishRoot can read the index
  // back without depending on `this` - which a caller holding one method of
  // this object would not have.
  const readRoot = async (): Promise<RootState> => {
    // Sequential on purpose: two reads fired together are exactly the burst
    // this endpoint answers with a 429.
    const root = (await patiently(() => contract.merkleRoot!() as Promise<string>)) as string;
    const index = (await patiently(() => contract.rootIndex!() as Promise<bigint>)) as bigint;
    return { root, index: Number(index) };
  };

  return {
    signerAddress: options.wallet.address,
    contractAddress: options.contractAddress,
    chainId: options.chainId,

    async publisher(): Promise<string> {
      return (await contract.publisher!()) as string;
    },

    async paused(): Promise<boolean> {
      return (await patiently(() => contract.paused!() as Promise<boolean>)) as boolean;
    },

    currentRoot: readRoot,

    async publishRoot(root: string): Promise<PublishReceipt> {
      const tx = await contract.publishRoot!(root);
      const receipt = await tx.wait(1, options.confirmTimeoutMs);

      // wait() resolves null when it gives up. Reporting a hash with no receipt
      // as success would write a proof file for a root that may never land;
      // treating it as a failure is safe, because the next period recomputes
      // the same cumulative root, sees it already on chain, and writes the
      // proofs then.
      if (!receipt) throw new Error(`publishRoot ${tx.hash} was not mined within the confirmation window.`);
      if (receipt.status === 0) throw new Error(`publishRoot ${tx.hash} reverted on chain.`);

      // Read back rather than assuming index + 1: another publisher key, or a
      // manual publication, would make the guess wrong and the proof file would
      // be filed under a root index that holds a different root.
      const { index } = await readRoot();
      return { hash: tx.hash, rootIndex: index };
    },
  };
}

/**
 * Everything except the transaction.
 *
 * Wraps a real client so a dry run exercises the same reads, the same tree, the
 * same files and the same skip decision — including the skip, which is the
 * point: a decorator that always reported the chain's root would "publish" on
 * every period and never show the quiet-hours behaviour it exists to prove.
 * So the root it would have sent is remembered and answered with.
 */
export function dryRunClient(inner: ChainClient): ChainClient {
  let pretended: RootState | null = null;

  return {
    signerAddress: inner.signerAddress,
    contractAddress: inner.contractAddress,
    chainId: inner.chainId,
    publisher: () => inner.publisher(),
    paused: () => inner.paused(),
    async currentRoot(): Promise<RootState> {
      return pretended ?? (await inner.currentRoot());
    },
    async publishRoot(root: string): Promise<PublishReceipt> {
      const previous = pretended ?? (await inner.currentRoot());
      pretended = { root, index: previous.index + 1 };
      return { hash: '(dry run: no transaction was sent)', rootIndex: pretended.index };
    },
  };
}
