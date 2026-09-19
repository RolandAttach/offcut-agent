/**
 * Turning what a period earned into amounts owed.
 *
 * @offcut/core answers "what happened"; this answers "and what is that worth".
 *
 * TWO LAYERS, ONE LEDGER. A period prices two quantities that are not the same
 * thing and must never share a denominator:
 *
 *   SPEND   one point is a millionth of a dollar of CONFIRMED model spend by a
 *           workspace's subagents — `spendInWindow`. An agent reports a
 *           generation id and the provider is asked what it cost; only the
 *           provider's answer reaches this file, which is what makes the metric
 *           expensive to farm. Every point here cost the person who earned it a
 *           millionth of a dollar of somebody else's money.
 *
 *   MEMORY  one credit is one RECORD, written by one agent, retrieved once ever
 *           by an agent that did not write it — `creditsInWindow`. The unique
 *           constraint in credits.ts is what makes it once-ever; the ceiling in
 *           config.ts, a fifth of the spend layer's, is what makes farming rows
 *           unprofitable. The credit belongs to the workspace that OWNS the
 *           record — the author's side — never the reader's.
 *
 * Each layer has its own ceiling, its own rate, its own pro-rata split and its
 * own per-earner cap; the two amounts an address earns are ADDED into one
 * accrual, one root, one claim. They are kept apart up to that addition because
 * a credit and a millionth of a dollar cannot be summed: one pool over both
 * would price whichever unit happened to be larger that period.
 *
 * Which is the answer to the question this file is most often asked. Somebody
 * running Claude Code on a subscription spends nothing this service can
 * confirm, so they earn NOTHING from the spend layer. What they earn from is
 * the memory layer, when an agent that is not theirs uses a record theirs
 * wrote. Say that plainly wherever this is described.
 *
 * Nothing below counts rows for their own sake: not records written, not agents
 * created, not $OFFCUT held. A hundred idle agents earn nothing because they
 * neither spend nor write anything anybody uses.
 *
 * And the sentence that has to appear wherever this is described: spend is not
 * reimbursed. Nothing below mints a token — the distributor was funded before
 * anybody spent anything, and an amount a period does not allocate stays in it.
 * What a period DOES allocate, per layer, is min(ceiling, units * rate), so
 * while the right-hand branch binds, more real usage allocates more. "A fixed
 * pool that usage merely redivides" is the one description of this file that is
 * false, and it is false in precisely the regime this network launches in: at
 * the shipped defaults neither ceiling binds until everybody together confirms
 * $10,000 of spend, or 2,000 used records, in a day. What holds in both regimes
 * is the part that has to be said out loud — none of this promises that AI
 * costs come back.
 *
 * Three rules run through every line of it:
 *
 *   1. The pool is a ceiling, not an obligation. What the formula does not
 *      allocate is never minted. The contract holds tokens already, so an
 *      amount that is not accrued simply stays where it is.
 *
 *   2. Remainders stay in the contract. Integer division on a pro-rata split
 *      always leaves a few base units over, and the two tempting answers —
 *      give them to the first address, give them to the largest — are both
 *      "whoever sorts first wins". Neither is defensible, so nobody gets them.
 *
 *   3. Nothing is dropped quietly. A workspace that earned something and cannot
 *      be paid appears in the result with the layer, the units and the reason.
 *      An accrual run that silently returns fewer addresses than earned is
 *      indistinguishable from one that is working, and that is how people stop
 *      trusting a payout.
 *
 * Payout follows OWNERSHIP, not authorship: agents hold keys, not wallets, so
 * a workspace resolves to its owner's address and two workspaces with one owner
 * are one payee.
 */

import { creditsInWindow, spendInWindow, type CreditWindow, type Db } from '@offcut/core';
import {
  DEFAULT_REWARD_CONFIG,
  assertUsableConfig,
  capForPool,
  ceilingPerPeriod,
  memoryCeilingPerPeriod,
  type RewardConfig,
} from './config';

/** Which of the two layers a figure belongs to. */
export type LayerName = 'spend' | 'memory';

/** Why a workspace that earned something is being paid nothing for it. */
export type SkipReason =
  /** The owner has not connected a wallet. They earn from the moment they do. */
  | 'no-wallet'
  /** The wallet on file is not a 20-byte hex address, so there is nobody to pay. */
  | 'unusable-wallet'
  /** Units outlived their workspace row. Should not happen; reported if it does. */
  | 'workspace-missing';

export interface SkippedWorkspace {
  workspaceId: string;
  /**
   * Which layer's units earned nothing.
   *
   * Reported per layer rather than once per workspace, because the two figures
   * are in different units and an operator reading "12 earned nothing" has to
   * know whether that is twelve millionths of a dollar or twelve records
   * somebody else found useful. A workspace with no wallet and both kinds of
   * activity appears twice, once for each.
   */
  layer: LayerName;
  /** Millionths of a dollar on the spend layer; credits on the memory layer. */
  units: number;
  reason: SkipReason;
}

/** The working for one workspace on one layer, so the console can explain a number. */
export interface WorkspaceShare {
  workspaceId: string;
  layer: LayerName;
  /** Millionths of a dollar on the spend layer; credits on the memory layer. */
  units: number;
  /** Lowercase owner address this workspace pays to. */
  address: string;
  /** The pro-rata share of that layer's pool, before the cap was applied. */
  proRata: bigint;
  /** After the per-workspace cap. */
  amount: bigint;
  cappedByWorkspace: boolean;
}

/** What one address is owed for this window. This is what the ledger records. */
export interface AddressAmount {
  address: string;
  /** spend + memory. The only figure a published root is built from. */
  amount: bigint;
  /** The part confirmed AI spend earned. */
  spend: bigint;
  /** The part memory another agent used earned. */
  memory: bigint;
  /** Every workspace that contributed, so a payment can be traced back. */
  workspaceIds: string[];
  /** A cap took something off this payee on at least one layer. */
  cappedByAddress: boolean;
}

/** One layer's own arithmetic, whole, so a number on a screen can be explained. */
export interface LayerSummary {
  layer: LayerName;
  /** Every unit earned in the window on this layer, payable or not. */
  units: number;
  /** Units behind an address that can be paid. */
  payableUnits: number;
  /** Units that earned nothing because nobody could be paid for them. */
  unpayableUnits: number;

  /** The left branch of this layer's pool formula: dailyCeiling / periodsPerDay. */
  ceilingPerPeriod: bigint;
  /** The right branch: units * rate. */
  atRate: bigint;
  /** min of the two. */
  pool: bigint;
  /** Which branch decided this layer's pool. */
  boundBy: 'ceiling' | 'rate';
  /** The most any one workspace or address may take from this layer's pool. */
  cap: bigint;

  /** Sum of the amounts this layer actually owes. */
  distributed: bigint;
  /** pool - distributed. Remainders, caps, unconnected wallets. Never minted. */
  undistributed: bigint;

  cappedWorkspaceIds: string[];
  cappedAddresses: string[];
}

export interface AccrualSummary {
  /**
   * SPEND ONLY, and still called points because that is what a point is: a
   * millionth of a dollar of confirmed spend. Memory credits are counted in
   * `layers.memory.units` and are deliberately not added in here — a total
   * mixing millionths of a dollar with used records is a number nothing can
   * act on.
   */
  totalPoints: number;
  payablePoints: number;
  unpayablePoints: number;

  /**
   * The rest of this block is BOTH LAYERS SUMMED, which is what the publisher
   * writes down and what a root is built from. Per-layer working is in
   * `layers`, and anything reasoning about a branch or a ceiling should read it
   * there: the sum of two ceilings is a real bound on the period, but it is not
   * a ceiling anybody configured.
   */
  ceilingPerPeriod: bigint;
  atRate: bigint;
  pool: bigint;
  /** 'ceiling' when EITHER layer's ceiling decided its pool. */
  boundBy: 'ceiling' | 'rate';
  /**
   * The two layers' caps added.
   *
   * Equal to `pool` when both layers are rate-bound, where the shares are
   * already each earner's own usage at the rate and a cap could only withhold —
   * see accrueWindow. A figure to read alongside `boundBy`, never on its own.
   */
  cap: bigint;

  /** Sum of the amounts actually owed. */
  distributed: bigint;
  /**
   * pool - distributed. Division remainders, what the caps removed, and the
   * share of unconnected wallets. None of it is minted; all of it stays put.
   */
  undistributed: bigint;

  /** The union across layers, each id once. */
  cappedWorkspaceIds: string[];
  cappedAddresses: string[];
}

export interface WindowAccrual {
  window: CreditWindow;
  config: RewardConfig;
  /** Owed per address, sorted by address so two runs produce one order. */
  amounts: AddressAmount[];
  /** Per-workspace, per-layer working behind those amounts. */
  shares: WorkspaceShare[];
  /** Usage that pays nothing, with the layer and the reason for each. */
  skipped: SkippedWorkspace[];
  /** Each layer's own arithmetic, before they were added together. */
  layers: { spend: LayerSummary; memory: LayerSummary };
  summary: AccrualSummary;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * Whether a stored wallet is something we can put in a Merkle leaf.
 *
 * User.walletAddress is written lowercase by the console, so the check is exact
 * rather than case-insensitive: a value that is not already canonical did not
 * come through the path that validates addresses, and guessing at what it meant
 * is how money reaches the wrong account.
 */
function payableAddress(wallet: string | null | undefined): string | null {
  if (!wallet) return null;
  const trimmed = wallet.trim();
  return ADDRESS.test(trimmed) ? trimmed : null;
}

/** One layer's units per workspace, before anybody has been matched to a wallet. */
interface LayerUnits {
  workspaceId: string;
  units: number;
}

/** A layer priced, but not yet merged with the other one. */
interface PricedLayer {
  shares: WorkspaceShare[];
  skipped: SkippedWorkspace[];
  /** Everything a LayerSummary needs except what only the merge can know. */
  partial: Omit<LayerSummary, 'distributed' | 'undistributed' | 'cappedAddresses'>;
}

/**
 * One layer's pool, split.
 *
 * Both layers run through this, each with its own ceiling and its own rate,
 * because the arithmetic is the same and the two units are not. Writing it
 * twice is how the memory ceiling ends up enforced at the spend rate six months
 * from now.
 */
function priceLayer(
  layer: LayerName,
  rows: LayerUnits[],
  wallets: Map<string, string | null>,
  ceiling: bigint,
  rate: bigint,
  config: RewardConfig
): PricedLayer {
  const payable: Array<{ workspaceId: string; units: number; address: string }> = [];
  const skipped: SkippedWorkspace[] = [];
  let units = 0;

  for (const row of rows) {
    units += row.units;

    if (!wallets.has(row.workspaceId)) {
      skipped.push({
        workspaceId: row.workspaceId,
        layer,
        units: row.units,
        reason: 'workspace-missing',
      });
      continue;
    }

    const wallet = wallets.get(row.workspaceId) ?? null;
    const address = payableAddress(wallet);
    if (!address) {
      skipped.push({
        workspaceId: row.workspaceId,
        layer,
        units: row.units,
        reason: wallet ? 'unusable-wallet' : 'no-wallet',
      });
      continue;
    }

    payable.push({ workspaceId: row.workspaceId, units: row.units, address });
  }

  // Units arrive from the database as JavaScript numbers, and on the spend
  // layer a point is a millionth of a dollar — a window's total is in the
  // billions where a credit count is in the dozens. Well below 2^53, which is
  // nine billion dollars in one period, but the failure past that line is
  // silent: the addition rounds, BigInt() carries the rounded figure into the
  // pool, and the ledger records a number nobody computed. Refusing is the only
  // safe answer, because there is no correct amount to pay once the input is
  // lossy.
  if (!Number.isSafeInteger(units)) {
    throw new Error(
      `The ${layer} layer's total for this window (${units}) is past the largest integer a ` +
        'JavaScript number holds exactly, so the pro-rata split would be computed from a rounded ' +
        'total. Refusing to price the period rather than paying a figure nothing produced.'
    );
  }

  // The denominator is EVERY unit earned in the window, not only the payable
  // ones. A workspace whose owner has not connected a wallet must not make
  // everybody else's payment larger — their share is simply never minted. It
  // also means connecting a wallet later cannot retroactively shrink what
  // somebody was already paid for a closed period.
  const atRate = BigInt(units) * rate;
  const pool = atRate < ceiling ? atRate : ceiling;
  const boundBy: 'ceiling' | 'rate' = atRate <= ceiling ? 'rate' : 'ceiling';

  // The cap divides a CONTESTED pool, so it is only applied to one.
  //
  // When the ceiling binds, the pool is smaller than the window's usage at the
  // rate: every share is a slice of something scarce, a dominant earner really
  // does take it from the others, and holding them to a fraction is the rule
  // the owner asked for.
  //
  // When the rate binds, pool = units * rate, so a workspace's pro-rata share
  // is EXACTLY its own usage at the rate — check it: pool * u/total = u * rate.
  // Nobody's amount depends on anybody else's, and there is nothing to take a
  // larger share OF. A cap there cannot move a token from a farm to an honest
  // earner; the only thing it can do is refuse to pay the honest earner, and
  // that is what it was doing. One earner spending a dollar in a quiet period
  // was paid a quarter of a token and three quarters of the pool was withheld
  // from a period nobody else was in.
  //
  // Every period is rate-bound until the whole network passes the per-period
  // ceiling, which is the entire early life of this product, so the bug was not
  // an edge case — it was the normal case.
  const cap = boundBy === 'ceiling' ? capForPool(pool, config) : pool;

  const shares: WorkspaceShare[] = [];
  for (const entry of payable) {
    // Floor division. The few base units it leaves behind stay in the contract
    // rather than going to whoever sorts first — see the header.
    const proRata = units === 0 ? 0n : (pool * BigInt(entry.units)) / BigInt(units);
    const amount = proRata > cap ? cap : proRata;
    shares.push({
      workspaceId: entry.workspaceId,
      layer,
      units: entry.units,
      address: entry.address,
      proRata,
      amount,
      cappedByWorkspace: amount < proRata,
    });
  }
  shares.sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0));

  const payableUnits = payable.reduce((sum, row) => sum + row.units, 0);

  return {
    shares,
    skipped,
    partial: {
      layer,
      units,
      payableUnits,
      unpayableUnits: units - payableUnits,
      ceilingPerPeriod: ceiling,
      atRate,
      pool,
      boundBy,
      cap,
      cappedWorkspaceIds: shares.filter((s) => s.cappedByWorkspace).map((s) => s.workspaceId),
    },
  };
}

/**
 * What every address is owed for one window, across both layers.
 *
 * The window must be exactly one period long. A one-hour window paid against
 * the ten-minute ceiling underpays the hour; a one-minute window overpays the
 * minute; and neither is visible in the ledger afterwards. Catching up after
 * downtime means running each missed period, which the ledger's per-period key
 * makes safe — so this refuses rather than guesses which of the two the caller
 * meant.
 */
export async function accrueWindow(
  db: Db,
  window: CreditWindow,
  config: RewardConfig = DEFAULT_REWARD_CONFIG
): Promise<WindowAccrual> {
  assertUsableConfig(config);

  const lengthMs = window.until.getTime() - window.since.getTime();
  const expectedMs = config.periodMinutes * 60_000;
  if (lengthMs !== expectedMs) {
    throw new Error(
      `A window must be exactly one period long (${config.periodMinutes} minutes); this one is ` +
        `${lengthMs / 60_000}. Run each period separately rather than one long window — the ceiling ` +
        'is defined per period and cannot be stretched over another length.'
    );
  }

  // The two metrics, read side by side. Spend is windowed on when the PROVIDER
  // confirmed it — never on when an agent claimed it; a credit on when the
  // retrieval that earned it happened.
  const [spendRows, creditRows] = await Promise.all([
    spendInWindow(db, window),
    creditsInWindow(db, window),
  ]);

  const spendUnits: LayerUnits[] = spendRows.map((row) => ({
    workspaceId: row.workspaceId,
    units: row.points,
  }));
  const memoryUnits: LayerUnits[] = creditRows.map((row) => ({
    workspaceId: row.workspaceId,
    units: row.credits,
  }));

  // One query for both layers. A workspace that spent and was read from in the
  // same ten minutes is one row in the database and must be one lookup here, or
  // the two layers could disagree about whose wallet is on file.
  const wallets =
    spendUnits.length === 0 && memoryUnits.length === 0
      ? new Map<string, string | null>()
      : await walletsFor(db, [
          ...new Set([...spendUnits, ...memoryUnits].map((row) => row.workspaceId)),
        ]);

  const spendLayer = priceLayer(
    'spend',
    spendUnits,
    wallets,
    ceilingPerPeriod(config),
    config.ratePerPoint,
    config
  );
  const memoryLayer = priceLayer(
    'memory',
    memoryUnits,
    wallets,
    memoryCeilingPerPeriod(config),
    config.ratePerCredit,
    config
  );

  // The merge. Each layer's cap is applied to that layer's total per address
  // BEFORE the two are added, because a cap is a fraction of one pool: applying
  // the sum of the caps to the sum of the amounts would let a dominant spender
  // borrow the memory layer's allowance to take more of the contested one.
  interface Tally {
    spend: bigint;
    memory: bigint;
    capped: boolean;
    workspaceIds: Set<string>;
  }
  const byAddress = new Map<string, Tally>();
  const tallyFor = (address: string): Tally => {
    const existing = byAddress.get(address);
    if (existing) return existing;
    const fresh: Tally = { spend: 0n, memory: 0n, capped: false, workspaceIds: new Set() };
    byAddress.set(address, fresh);
    return fresh;
  };

  for (const layer of [spendLayer, memoryLayer]) {
    const totals = new Map<string, { amount: bigint; proRata: bigint }>();
    for (const share of layer.shares) {
      const row = totals.get(share.address) ?? { amount: 0n, proRata: 0n };
      row.amount += share.amount;
      row.proRata += share.proRata;
      totals.set(share.address, row);
      tallyFor(share.address).workspaceIds.add(share.workspaceId);
    }

    for (const [address, row] of totals) {
      // The cap again, now on the payee, because one owner can hold four
      // workspaces as easily as one. It is NOT a defence against a farm, which
      // makes four accounts instead — config.ts carries the arithmetic.
      const paid = row.amount > layer.partial.cap ? layer.partial.cap : row.amount;
      const tally = tallyFor(address);
      if (layer.partial.layer === 'spend') tally.spend += paid;
      else tally.memory += paid;
      // Asked of the UNCAPPED total, because the loop above may already have
      // clipped it. A payee behind one dominant workspace arrives here holding
      // exactly `cap`, so `amount > cap` is false in the one case the flag
      // exists to report — and the publisher prints this list as "held at the
      // per-earner cap", so it stayed silent in the periods where the cap took
      // the most.
      if (row.proRata > layer.partial.cap) tally.capped = true;
    }
  }

  const amounts: AddressAmount[] = [];
  for (const [address, tally] of byAddress) {
    const amount = tally.spend + tally.memory;
    // A zero here is real — a tiny share floored to nothing — and it is left
    // out rather than written down, because an address owed nothing has no
    // business in a tree or a ledger.
    if (amount === 0n) continue;
    amounts.push({
      address,
      amount,
      spend: tally.spend,
      memory: tally.memory,
      workspaceIds: [...tally.workspaceIds].sort(),
      cappedByAddress: tally.capped,
    });
  }
  amounts.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  /**
   * A layer's summary, finished with what only the merged amounts can say.
   *
   * `cappedAddresses` is asked per layer rather than copied from the flag on
   * the address: a spender held at the spend cap is not capped on a memory
   * layer they were paid in full on, and a log line saying otherwise sends
   * somebody looking for a rule that never fired.
   */
  const layerSummary = (priced: PricedLayer, take: (row: AddressAmount) => bigint): LayerSummary => {
    const distributed = amounts.reduce((sum, row) => sum + take(row), 0n);
    const cappedAddresses = amounts
      .filter((row) => row.cappedByAddress && take(row) > 0n && take(row) === priced.partial.cap)
      .map((row) => row.address);
    return {
      ...priced.partial,
      distributed,
      undistributed: priced.partial.pool - distributed,
      cappedAddresses,
    };
  };

  const layers = {
    spend: layerSummary(spendLayer, (row) => row.spend),
    memory: layerSummary(memoryLayer, (row) => row.memory),
  };

  // Spend before memory inside one workspace, workspaces in id order: a stable
  // listing, so two runs of the same period print their working the same way.
  const shares = [...spendLayer.shares, ...memoryLayer.shares].sort((a, b) => {
    if (a.workspaceId !== b.workspaceId) return a.workspaceId < b.workspaceId ? -1 : 1;
    if (a.layer === b.layer) return 0;
    return a.layer === 'spend' ? -1 : 1;
  });

  const distributed = amounts.reduce((sum, row) => sum + row.amount, 0n);
  const pool = layers.spend.pool + layers.memory.pool;

  return {
    window,
    config,
    amounts,
    shares,
    skipped: [...spendLayer.skipped, ...memoryLayer.skipped],
    layers,
    summary: {
      totalPoints: layers.spend.units,
      payablePoints: layers.spend.payableUnits,
      unpayablePoints: layers.spend.unpayableUnits,
      ceilingPerPeriod: layers.spend.ceilingPerPeriod + layers.memory.ceilingPerPeriod,
      atRate: layers.spend.atRate + layers.memory.atRate,
      pool,
      boundBy:
        layers.spend.boundBy === 'ceiling' || layers.memory.boundBy === 'ceiling'
          ? 'ceiling'
          : 'rate',
      cap: layers.spend.cap + layers.memory.cap,
      distributed,
      undistributed: pool - distributed,
      cappedWorkspaceIds: [
        ...new Set([...layers.spend.cappedWorkspaceIds, ...layers.memory.cappedWorkspaceIds]),
      ],
      cappedAddresses: [
        ...new Set([...layers.spend.cappedAddresses, ...layers.memory.cappedAddresses]),
      ],
    },
  };
}

/**
 * Owner wallet per workspace id.
 *
 * A workspace present in the map with a null value has an owner without a
 * wallet; one absent from the map has no row at all. The two are different
 * failures and the caller reports them differently, so they are not collapsed
 * into one nullable lookup.
 */
async function walletsFor(db: Db, workspaceIds: string[]): Promise<Map<string, string | null>> {
  const rows = await db.workspace.findMany({
    where: { id: { in: workspaceIds } },
    select: { id: true, owner: { select: { walletAddress: true } } },
  });

  return new Map(rows.map((row) => [row.id, row.owner?.walletAddress ?? null]));
}
