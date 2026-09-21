/**
 * Stand-ins for the two things this service does not own: the chain, and the
 * ledger.
 *
 * The chain is faked because a test that needs an RPC endpoint to prove a
 * period is not paid twice is a test nobody runs, and because the interesting
 * cases - a transaction that reverts, a root that was already published, a
 * paused contract - are ones you cannot arrange on demand against a real node.
 *
 * The ledger is faked, but not loosely. recordAccruals in @offcut/rewards makes
 * three promises this service leans on, and the fake below keeps all three:
 *
 *   - the same window with the same figures writes nothing new, and says so
 *   - the same window with different figures throws
 *   - a window overlapping one already on file throws
 *
 * Those promises are what make replaying a period safe, so a fake that did not
 * keep them would let a real double-pay pass here. The rewards package tests
 * that its ledger behaves this way; these tests assume it and check that this
 * service replays, orders and records periods correctly on top of it.
 *
 * Confirming spend is faked too, and it keeps the one property the service
 * depends on: a report is worth nothing until a provider confirms it, and it
 * then counts in the period it was CONFIRMED in rather than the one it was made
 * in - because spendInWindow selects on verifiedAt. A fake that paid at the
 * moment of reporting would hide exactly the failure these tests exist for.
 *
 * buildTree is NOT faked. It is pure, it is what decides whether a proof is
 * claimable, and a second implementation of it in a test file would only be a
 * second chance to be wrong about the thing that matters most.
 */

import { buildTree } from '@offcut/rewards';
import type { Db } from '@offcut/core';
import type { LedgerWriteResult, RecordedAmount, RewardConfig, WindowAccrual } from '@offcut/rewards';
import { dryRunClient, type ChainClient, type PublishReceipt, type RootState } from '../chain';
import type { PublisherConfig } from '../config';
import { memoryProofWriter } from '../proofs';
import type { RewardsApi } from '../rewards';
import { runOnce, type Logger, type ServiceDeps, type TickReport } from '../service';
import type { PublisherState, StateStore } from '../state';
import type { UsageApi } from '../usage';

export const PERIOD_MS = 10 * 60_000;
export const ONE_TOKEN = 10n ** 18n;

/** Some period a long way from the epoch, so the numbers look like real ones. */
export const PERIOD_0 = Math.floor(Date.UTC(2026, 8, 15, 12, 0, 0) / PERIOD_MS);

export function atPeriod(index: number, offsetMs = 0): number {
  return index * PERIOD_MS + offsetMs;
}

/** The period a moment falls in - the inverse of atPeriod, and still open. */
export function periodIndexAt(atMs: number): number {
  return Math.floor(atMs / PERIOD_MS);
}

export const ALICE = '0x1111111111111111111111111111111111111111';
export const BOB = '0x2222222222222222222222222222222222222222';

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

interface LedgerRow {
  address: string;
  periodStart: number;
  periodEnd: number;
  amount: bigint;
}

export interface FakeRewards {
  api: RewardsApi;
  /** One point of confirmed spend earned by one address inside one period. */
  earn(periodIndex: number, address: string, points: number): void;
  /**
   * The other layer: records another agent used, earned by one address inside
   * one period.
   *
   * Kept apart from `earn` rather than folded into it because the whole reason
   * the accrual has two layers is that these units are not the same quantity,
   * and a fake that added them would hide a service adding them too.
   */
  earnMemory(periodIndex: number, address: string, credits: number): void;
  /** Period indexes accrueWindow was asked to compute, in order. */
  accrued: number[];
  /** Period indexes that actually wrote rows, in order. */
  written: number[];
  rows(): LedgerRow[];
  totalFor(address: string): bigint;
}

/** One layer of the fake's working, priced at its own rate and all payable. */
function layerFor(
  layer: 'spend' | 'memory',
  units: number,
  distributed: bigint,
  ceiling: bigint,
  rate: bigint
): WindowAccrual['layers']['spend'] {
  return {
    layer,
    units,
    payableUnits: units,
    unpayableUnits: 0,
    ceilingPerPeriod: ceiling,
    atRate: BigInt(units) * rate,
    pool: distributed,
    boundBy: 'rate',
    cap: distributed,
    distributed,
    undistributed: 0n,
    cappedWorkspaceIds: [],
    cappedAddresses: [],
  };
}

function summaryFor(
  layers: WindowAccrual['layers'],
  distributed: bigint
): WindowAccrual['summary'] {
  return {
    // Spend only, as the real summary does: points are millionths of a dollar
    // and credits are used records, and the two are never added.
    totalPoints: layers.spend.units,
    payablePoints: layers.spend.units,
    unpayablePoints: 0,
    ceilingPerPeriod: layers.spend.ceilingPerPeriod + layers.memory.ceilingPerPeriod,
    atRate: layers.spend.atRate + layers.memory.atRate,
    pool: distributed,
    boundBy: 'rate',
    cap: distributed,
    distributed,
    undistributed: 0n,
    cappedWorkspaceIds: [],
    cappedAddresses: [],
  };
}

export function fakeRewards(trace: string[] = []): FakeRewards {
  const earned = new Map<number, Map<string, number>>();
  const credited = new Map<number, Map<string, number>>();
  const rows: LedgerRow[] = [];
  const accrued: number[] = [];
  const written: number[] = [];

  const api: RewardsApi = {
    async accrueWindow(_db, window, config): Promise<WindowAccrual> {
      const index = window.since.getTime() / PERIOD_MS;
      trace.push('accrue');
      accrued.push(index);

      const spentInWindow = earned.get(index) ?? new Map<string, number>();
      const usedInWindow = credited.get(index) ?? new Map<string, number>();

      let points = 0;
      let credits = 0;
      let spendTotal = 0n;
      let memoryTotal = 0n;

      const addresses = [...new Set([...spentInWindow.keys(), ...usedInWindow.keys()])].sort();
      const amounts = addresses.map((address) => {
        const earnedPoints = spentInWindow.get(address) ?? 0;
        const earnedCredits = usedInWindow.get(address) ?? 0;
        points += earnedPoints;
        credits += earnedCredits;

        // Each layer at its own rate, then added - which is the one property of
        // the real accrual this service leans on.
        const spend = BigInt(earnedPoints) * config.ratePerPoint;
        const memory = BigInt(earnedCredits) * config.ratePerCredit;
        spendTotal += spend;
        memoryTotal += memory;

        return {
          address,
          amount: spend + memory,
          spend,
          memory,
          workspaceIds: [`ws-${address}`],
          cappedByAddress: false,
        };
      });

      const layers = {
        spend: layerFor('spend', points, spendTotal, config.dailyCeiling / 144n, config.ratePerPoint),
        memory: layerFor(
          'memory',
          credits,
          memoryTotal,
          config.memoryDailyCeiling / 144n,
          config.ratePerCredit
        ),
      };

      return {
        window,
        config,
        amounts,
        shares: [],
        skipped: [],
        layers,
        summary: summaryFor(layers, spendTotal + memoryTotal),
      };
    },

    async recordAccruals(_db, window, amounts): Promise<LedgerWriteResult> {
      const since = window.since.getTime();
      const until = window.until.getTime();
      const payable = amounts.filter((row) => row.amount > 0n);

      const overlapping = rows.filter((row) => row.periodStart < until && row.periodEnd > since);
      const settled = overlapping.filter((row) => row.periodStart === since && row.periodEnd === until);

      if (settled.length !== overlapping.length) {
        throw new Error('Refusing to record a period that overlaps one already in the ledger.');
      }

      if (settled.length > 0) {
        const existing = new Map(settled.map((row) => [row.address, row.amount]));
        for (const row of payable) {
          if (existing.get(row.address) !== row.amount) {
            throw new Error(`This period is already settled at a different figure for ${row.address}.`);
          }
          existing.delete(row.address);
        }
        if (existing.size > 0) {
          throw new Error('This period is already settled for addresses the recomputed accrual does not include.');
        }
        return {
          window,
          recorded: [],
          alreadyRecorded: settled.map((row) => ({ address: row.address, amount: row.amount })),
        };
      }

      if (payable.length === 0) return { window, recorded: [], alreadyRecorded: [] };

      written.push(since / PERIOD_MS);
      for (const row of payable) {
        rows.push({ address: row.address, periodStart: since, periodEnd: until, amount: row.amount });
      }
      return { window, recorded: payable, alreadyRecorded: [] };
    },

    async cumulativeTotals(_db, options = {}): Promise<RecordedAmount[]> {
      const through = options.through?.getTime();
      const totals = new Map<string, bigint>();
      for (const row of rows) {
        if (through !== undefined && row.periodEnd > through) continue;
        totals.set(row.address, (totals.get(row.address) ?? 0n) + row.amount);
      }
      return [...totals.entries()]
        .map(([address, amount]) => ({ address, amount }))
        .sort((a, b) => (a.address < b.address ? -1 : 1));
    },

    buildTree,
  };

  return {
    api,
    earn(periodIndex, address, points) {
      const inPeriod = earned.get(periodIndex) ?? new Map<string, number>();
      inPeriod.set(address, (inPeriod.get(address) ?? 0) + points);
      earned.set(periodIndex, inPeriod);
    },
    earnMemory(periodIndex, address, credits) {
      const inPeriod = credited.get(periodIndex) ?? new Map<string, number>();
      inPeriod.set(address, (inPeriod.get(address) ?? 0) + credits);
      credited.set(periodIndex, inPeriod);
    },
    accrued,
    written,
    rows: () => rows.map((row) => ({ ...row })),
    totalFor: (address) => rows.filter((row) => row.address === address).reduce((sum, row) => sum + row.amount, 0n),
  };
}

// ---------------------------------------------------------------------------
// Confirming spend
// ---------------------------------------------------------------------------

export interface FakeUsage {
  api: UsageApi;
  /** An agent reports one generation. Worth nothing until a provider confirms it. */
  report(address: string, points: number): void;
  /** Make the next confirmation run throw, once. */
  failNext(reason: string): void;
  /** The batch size each run asked for, in order - so one entry means one run. */
  runs: number[];
}

/**
 * Pending reports, and what confirming one is worth.
 *
 * `earn` is called against the period the clock is in AT CONFIRMATION TIME, not
 * the period the report was made in. That is not a shortcut: verifyPendingUsage
 * stamps verifiedAt with the current instant and spendInWindow windows on that
 * column, so a report confirmed during one tick is paid when the period it was
 * confirmed in closes - one tick later. Tests depend on that lag being real.
 */
export function fakeUsage(rewards: FakeRewards, now: () => number, trace: string[] = []): FakeUsage {
  const pending: { address: string; points: number }[] = [];
  const runs: number[] = [];
  let failure: string | null = null;

  return {
    runs,
    report: (address, points) => {
      pending.push({ address, points });
    },
    failNext: (reason) => {
      failure = reason;
    },
    api: {
      async settlePending(_db, options) {
        trace.push('confirm');
        runs.push(options.limit);

        if (failure) {
          const reason = failure;
          failure = null;
          // Thrown, not returned as zero confirmations: an outage and a quiet
          // period are different things and the service treats them differently.
          throw new Error(reason);
        }

        // Anything past the batch limit is simply not asked about this run. The
        // core does not fetch those rows at all, so they are not `deferred`.
        const confirmed = pending.splice(0, options.limit);
        const period = periodIndexAt(now());
        for (const row of confirmed) rewards.earn(period, row.address, row.points);

        return { verified: confirmed.length, rejected: 0, deferred: 0 };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

export const NO_ROOT = `0x${'0'.repeat(64)}`;

export interface FakeChain extends ChainClient {
  /** Every root handed to publishRoot, including ones that then failed. */
  attempted: string[];
  /** Every root that actually landed. */
  published: string[];
  /** Make the next publishRoot throw, once. */
  failNext(reason: string): void;
  setPaused(value: boolean): void;
  setPublisher(address: string): void;
  /** How many times the chain has been read. The public RPC counts these. */
  reads(): number;
}

export function fakeChain(options: { signer?: string; publisher?: string } = {}): FakeChain {
  const signer = options.signer ?? '0x9999999999999999999999999999999999999999';
  let publisher = options.publisher ?? signer;
  let paused = false;
  let state: RootState = { root: NO_ROOT, index: 0 };
  let failure: string | null = null;

  const attempted: string[] = [];
  const published: string[] = [];
  let reads = 0;

  return {
    signerAddress: signer,
    contractAddress: '0x3333333333333333333333333333333333333333',
    chainId: 46630,
    attempted,
    published,
    failNext: (reason) => {
      failure = reason;
    },
    setPaused: (value) => {
      paused = value;
    },
    setPublisher: (address) => {
      publisher = address;
    },
    async publisher(): Promise<string> {
      return publisher;
    },
    async paused(): Promise<boolean> {
      return paused;
    },
    reads: () => reads,

    async currentRoot(): Promise<RootState> {
      reads += 1;
      return { ...state };
    },
    async publishRoot(root): Promise<PublishReceipt> {
      attempted.push(root);
      if (failure) {
        const reason = failure;
        failure = null;
        throw new Error(reason);
      }
      state = { root, index: state.index + 1 };
      published.push(root);
      return { hash: `0xtx${published.length}`, rootIndex: state.index };
    },
  };
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

export interface RecordingLogger extends Logger {
  lines: string[];
}

export function recordingLogger(): RecordingLogger {
  const lines: string[] = [];
  return {
    lines,
    info: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
}

export const NO_DB = {} as Db;

export const TEST_REWARD_CONFIG: RewardConfig = {
  dailyCeiling: 10_000n * ONE_TOKEN,
  periodMinutes: 10,
  ratePerPoint: ONE_TOKEN,
  perWorkspaceCapPerPeriod: 0.25,
  memoryDailyCeiling: 2_000n * ONE_TOKEN,
  ratePerCredit: ONE_TOKEN,
};

// ---------------------------------------------------------------------------
// The service, assembled
// ---------------------------------------------------------------------------

/**
 * A cursor that can be told to stop reaching the disk.
 *
 * That is the crash this service has to survive: the ledger accepted a period
 * and the process died before the cursor recording it was written. It cannot be
 * produced by killing a test, so it is produced by dropping the write.
 */
export function crashableStateStore(initial: PublisherState | null = null): StateStore & {
  losesWritesFromNowOn(): void;
} {
  let current = initial;
  let losing = false;
  return {
    read: () => (current ? { ...current } : null),
    write: (state) => {
      if (!losing) current = { ...state };
    },
    losesWritesFromNowOn: () => {
      losing = true;
    },
  };
}

export interface Harness {
  deps: ServiceDeps;
  rewards: FakeRewards;
  usage: FakeUsage;
  chain: FakeChain;
  proofs: ReturnType<typeof memoryProofWriter>;
  state: ReturnType<typeof crashableStateStore>;
  log: RecordingLogger;
  /** Every confirm and accrue of the tick, in the order they actually happened. */
  trace: string[];
  /** Move the clock. Everything the service decides comes from this number. */
  setNow(ms: number): void;
  run(): Promise<TickReport>;
}

export function harness(options: { now?: number; chain?: FakeChain; dryRun?: boolean } = {}): Harness {
  let now = options.now ?? atPeriod(PERIOD_0 + 1, 30_000);

  // One trace shared by both, because the order between them is what matters:
  // confirmation that ran after an accrual confirmed into a window already paid.
  const trace: string[] = [];
  const rewards = fakeRewards(trace);
  // Reads `now` on every call rather than capturing it, so a test that moves the
  // clock between ticks confirms into the period it has moved to.
  const usage = fakeUsage(rewards, () => now, trace);
  const chain = options.chain ?? fakeChain();
  // Wrapped exactly as index.ts wraps it, so a dry-run test exercises the same
  // decorator the service uses rather than a second idea of what dry run means.
  const client = options.dryRun ? dryRunClient(chain) : chain;
  const proofs = memoryProofWriter();
  const state = crashableStateStore();
  const log = recordingLogger();

  const config: PublisherConfig = {
    network: 'testnet',
    rpcUrl: 'http://localhost:0/never-called',
    chainId: chain.chainId,
    contractAddress: chain.contractAddress,
    periodMs: PERIOD_MS,
    tickLagMs: 15_000,
    confirmTimeoutMs: 120_000,
    dryRun: options.dryRun ?? false,
    usageBatchLimit: 500,
    reward: TEST_REWARD_CONFIG,
  };

  const deps: ServiceDeps = {
    db: NO_DB,
    chain: client,
    rewards: rewards.api,
    usage: usage.api,
    state,
    proofs,
    config,
    now: () => now,
    log,
  };

  return {
    deps,
    rewards,
    usage,
    chain,
    trace,
    proofs,
    state,
    log,
    setNow: (ms) => {
      now = ms;
    },
    run: () => runOnce(deps),
  };
}
