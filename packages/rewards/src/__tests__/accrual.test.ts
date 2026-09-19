/**
 * What the pool formula decides, what it refuses to decide, and what it counts.
 *
 * Every test here is a way the emission could run away from the owner, and the
 * assertion is that it does not:
 *
 *   - a busy period cannot mint more than the day's ceiling allows
 *   - a quiet period is not topped up to the ceiling for the sake of it
 *   - one earner cannot take a contested period, however many workspaces they
 *     hold, and is not docked a share of an uncontested one
 *   - points that cannot be paid do not become somebody else's money
 *
 * And one that is about WHICH number is being divided at all: a point is a
 * millionth of a dollar of confirmed AI spend, never a memory retrieval. That
 * is the brief's own rule, and it has a describe block to itself because it is
 * one import line and therefore the thing most easily reverted by accident.
 *
 * Two scales are used deliberately. Most blocks price a handful of points at a
 * rate of one token per point, so the arithmetic can be read: a ceiling of 1440
 * tokens a day over 144 periods is 10 tokens a period. The last block uses the
 * shipped rate and thousands of dollars of real spend, because a formula that
 * reads correctly at twelve points can still round or overflow at twelve
 * billion.
 */

import { describe, expect, it } from 'vitest';
import { getPrisma, type Db } from '@offcut/core';
import { accrueWindow } from '../accrual';
import { DEFAULT_REWARD_CONFIG, ONE_TOKEN, type RewardConfig } from '../config';
import {
  WINDOW_END,
  WINDOW_START,
  INSIDE,
  address,
  claimSpend,
  dollars,
  makeEarner,
  retrieve,
  spend,
  credit,
  windowOf,
} from './helpers';

const WINDOW = { since: WINDOW_START, until: WINDOW_END };

const config: RewardConfig = {
  dailyCeiling: 1440n * ONE_TOKEN,
  periodMinutes: 10,
  ratePerPoint: ONE_TOKEN,
  perWorkspaceCapPerPeriod: 0.25,
  // The memory layer at the same readable scale: 288 tokens a day over 144
  // periods is two tokens a period, a fifth of the spend layer's ten — the
  // same ratio as the shipped defaults, small enough that a block meaning to
  // exercise the memory ceiling reaches it with three credits rather than two
  // thousand.
  memoryDailyCeiling: 288n * ONE_TOKEN,
  ratePerCredit: ONE_TOKEN,
};

/** The same policy with the cap lifted, so one rule can be read at a time. */
const uncapped: RewardConfig = { ...config, perWorkspaceCapPerPeriod: 1 };

// ---------------------------------------------------------------------------
describe('The ceiling on a busy period', () => {
  it('never allocates more than the period share of the daily ceiling', async () => {
    const a = await makeEarner(address(1));
    const b = await makeEarner(address(2));
    await spend(a.workspaceId, 1000, INSIDE);
    await spend(b.workspaceId, 500, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    // 1500 points would be 1500 tokens at the rate. The ceiling says 10.
    expect(result.summary.atRate).toBe(1500n * ONE_TOKEN);
    expect(result.summary.boundBy).toBe('ceiling');
    expect(result.summary.pool).toBe(10n * ONE_TOKEN);
    expect(result.summary.distributed).toBeLessThanOrEqual(result.summary.pool);
  });

  it('splits the pool in proportion to points', async () => {
    const a = await makeEarner(address(1));
    const b = await makeEarner(address(2));
    await spend(a.workspaceId, 1000, INSIDE);
    await spend(b.workspaceId, 500, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(result.amounts).toEqual([
      expect.objectContaining({ address: address(1), amount: 6_666_666_666_666_666_666n }),
      expect.objectContaining({ address: address(2), amount: 3_333_333_333_333_333_333n }),
    ]);
  });

  it('leaves the division remainder in the contract rather than giving it to whoever sorts first', async () => {
    const a = await makeEarner(address(1));
    const b = await makeEarner(address(2));
    await spend(a.workspaceId, 1000, INSIDE);
    await spend(b.workspaceId, 500, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    // Two thirds and one third of ten tokens cannot both be whole base units.
    expect(result.summary.undistributed).toBe(1n);
    expect(result.amounts[0]!.amount).toBeGreaterThan(result.amounts[1]!.amount);
  });
});

// ---------------------------------------------------------------------------
describe('The rate on a quiet period', () => {
  it('pays the rate per point and mints nothing more', async () => {
    const a = await makeEarner(address(1));
    await spend(a.workspaceId, 3, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    // Three users on day one share tens, not the whole ceiling.
    expect(result.summary.boundBy).toBe('rate');
    expect(result.summary.pool).toBe(3n * ONE_TOKEN);
    expect(result.amounts).toEqual([
      expect.objectContaining({ address: address(1), amount: 3n * ONE_TOKEN }),
    ]);
    expect(result.summary.undistributed).toBe(0n);
  });

  it('pays a lone earner the whole of a pool that only their own spending made', async () => {
    // At the shipped rate and ceiling, which is what makes this the ordinary
    // case rather than a corner: one account, one dollar of confirmed spend, a
    // pool of one token. The cap used to run here and pay a quarter of it,
    // leaving three quarters of a period nobody else was in sitting in the
    // contract — and neither the console nor the landing page said so.
    const a = await makeEarner(address(1));
    await spend(a.workspaceId, dollars(1), INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, DEFAULT_REWARD_CONFIG);

    expect(result.summary.boundBy).toBe('rate');
    expect(result.summary.pool).toBe(ONE_TOKEN);
    expect(result.amounts[0]!.amount).toBe(ONE_TOKEN);
    expect(result.summary.undistributed).toBe(0n);
    expect(result.summary.cappedAddresses).toEqual([]);
  });

  it('pays two earners their own dollar each rather than half of it', async () => {
    // The same fault one earner along. Two accounts, a dollar each, a pool of
    // two tokens: the cap was a half and both of them were held to it, so a
    // whole token of a two-token period was withheld from the only two people
    // in it.
    const a = await makeEarner(address(1));
    const b = await makeEarner(address(2));
    await spend(a.workspaceId, dollars(1), INSIDE);
    await spend(b.workspaceId, dollars(1), INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, DEFAULT_REWARD_CONFIG);

    expect(result.summary.pool).toBe(2n * ONE_TOKEN);
    expect(result.amounts.map((row) => row.amount)).toEqual([ONE_TOKEN, ONE_TOKEN]);
    expect(result.summary.undistributed).toBe(0n);
  });

  it('divides exactly when the rate decides the pool, so nothing is stranded', async () => {
    const a = await makeEarner(address(1));
    const b = await makeEarner(address(2));
    const c = await makeEarner(address(3));
    await spend(a.workspaceId, 1, INSIDE);
    await spend(b.workspaceId, 1, INSIDE);
    await spend(c.workspaceId, 1, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(result.amounts.map((row) => row.amount)).toEqual([ONE_TOKEN, ONE_TOKEN, ONE_TOKEN]);
    expect(result.summary.undistributed).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
describe('The cap on one earner', () => {
  it('holds a dominant workspace to its share of the pool', async () => {
    const farm = await makeEarner(address(1));
    const other = await makeEarner(address(2));
    await spend(farm.workspaceId, 1000, INSIDE);
    await spend(other.workspaceId, 1, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, config);

    // Pro-rata would hand the farm 99.9% of the period.
    const share = result.shares.find((row) => row.workspaceId === farm.workspaceId)!;
    expect(share.proRata).toBeGreaterThan(result.summary.cap);
    expect(share.amount).toBe(result.summary.cap);
    expect(share.cappedByWorkspace).toBe(true);
    expect(result.summary.cappedWorkspaceIds).toEqual([farm.workspaceId]);
  });

  it('is not beaten by splitting a farm across several workspaces', async () => {
    // The whole reason the cap is applied to the address as well: a workspace
    // is a row, and four of them cost nothing.
    const first = await makeEarner(address(1));
    const second = await makeEarner(null, first.ownerId);
    const third = await makeEarner(null, first.ownerId);
    const fourth = await makeEarner(null, first.ownerId);
    const rival = await makeEarner(address(2));

    for (const farm of [first, second, third, fourth]) await spend(farm.workspaceId, 250, INSIDE);
    await spend(rival.workspaceId, 1000, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, config);

    const farm = result.amounts.find((row) => row.address === address(1))!;
    const honest = result.amounts.find((row) => row.address === address(2))!;

    expect(farm.workspaceIds).toHaveLength(4);
    expect(farm.amount).toBe(result.summary.cap);
    expect(farm.cappedByAddress).toBe(true);
    // Four workspaces earned exactly what one would have.
    expect(farm.amount).toBe(honest.amount);
  });

  it('leaves a dominant earner alone while the rate is what priced the period', async () => {
    // Not a rule about how many earners there are. Eight points against one is
    // an 89% share, far past the quarter the cap allows — but a rate-bound pool
    // is the two of them priced at the rate, so that 89% is exactly this
    // workspace's own eight points and the other earner is paid their one in
    // full whatever happens to it. There is no larger share here to take.
    const heavy = await makeEarner(address(1));
    const light = await makeEarner(address(2));
    await spend(heavy.workspaceId, 8, INSIDE);
    await spend(light.workspaceId, 1, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, config);

    expect(result.summary.boundBy).toBe('rate');
    expect(result.amounts.map((row) => row.amount)).toEqual([8n * ONE_TOKEN, ONE_TOKEN]);
    expect(result.summary.cappedWorkspaceIds).toEqual([]);
    expect(result.summary.undistributed).toBe(0n);
  });

  it('closes on that same earner once the ceiling is what is being divided', async () => {
    // The same 8:1 between the same two accounts, with enough spend in the
    // window that the ceiling prices it. Now the shares are slices of something
    // scarce and the dominant one really is taking it from the other, which is
    // the case the cap was asked for: a quarter, and no more.
    const heavy = await makeEarner(address(1));
    const light = await makeEarner(address(2));
    await spend(heavy.workspaceId, 80, INSIDE);
    await spend(light.workspaceId, 10, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, config);

    expect(result.summary.boundBy).toBe('ceiling');
    expect(result.amounts.find((row) => row.address === address(1))!.amount).toBe(
      result.summary.cap
    );
    expect(result.summary.cap).toBe(result.summary.pool / 4n);
  });

  it('leaves what the cap removed in the contract', async () => {
    const farm = await makeEarner(address(1));
    const other = await makeEarner(address(2));
    await spend(farm.workspaceId, 1000, INSIDE);
    await spend(other.workspaceId, 1, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, config);

    expect(result.summary.distributed).toBeLessThan(result.summary.pool);
    expect(result.summary.undistributed).toBe(result.summary.pool - result.summary.distributed);
  });

  it('names a payee it held at the cap even when one workspace carried all their spend', async () => {
    // The publisher prints cappedAddresses as "held at the per-earner cap", so
    // this list is how anybody outside this file learns the cap engaged. It was
    // read off the figure the workspace pass had ALREADY clipped: a payee with
    // one dominant workspace reached the address pass holding exactly the cap,
    // `total > cap` was false, and the list came back empty in the very periods
    // where the cap took the most. Silence there is indistinguishable from a
    // period the cap never touched.
    const farm = await makeEarner(address(1));
    const other = await makeEarner(address(2));
    await spend(farm.workspaceId, 1000, INSIDE);
    await spend(other.workspaceId, 1, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, config);

    const held = result.amounts.find((row) => row.address === address(1))!;
    expect(held.amount).toBe(result.summary.cap);
    expect(held.cappedByAddress).toBe(true);
    expect(result.summary.cappedAddresses).toEqual([address(1)]);
  });
});

// ---------------------------------------------------------------------------
/**
 * The limit of the cap, measured rather than asserted.
 *
 * config.ts used to say the cap stopped a farm, and it does not: the allowance
 * is granted per payee, so n payees are allowed n * cap out of a pool that does
 * not grow to match, and an address is a registration plus a self-declared
 * string. These two tests are the same farm, the same $900 of confirmed spend,
 * the same four honest earners and the same pool, differing only in how many
 * addresses the farm arrives behind — and the pair of figures they pin is the
 * pair config.ts now quotes. If either moves, that comment has gone stale and
 * this is where it shows.
 *
 * The shipped defaults deliberately, because the claim being checked is about
 * the shipped policy and not about a readable toy rate.
 */
describe('What the cap does not do', () => {
  const FARM_BEHIND_ONE_ADDRESS = 17_361_111_111_111_111_111n;
  const FARM_BEHIND_FIVE_ADDRESSES = 48_076_923_076_923_076_920n;

  /** Four people, $100 of confirmed spend each, sharing the period with a farm. */
  async function honestEarners(): Promise<void> {
    for (const index of [1, 2, 3, 4]) {
      const honest = await makeEarner(address(index));
      await spend(honest.workspaceId, dollars(100), INSIDE);
    }
  }

  it('holds a farm to a quarter of the period while its spend sits behind one address', async () => {
    await honestEarners();
    const farm = await makeEarner(address(90));
    await spend(farm.workspaceId, dollars(900), INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, DEFAULT_REWARD_CONFIG);

    const paid = result.amounts.find((row) => row.address === address(90))!;
    expect(result.summary.boundBy).toBe('ceiling');
    expect(paid.amount).toBe(FARM_BEHIND_ONE_ADDRESS);
    expect(paid.amount).toBe(result.summary.cap);
    // What the cap withheld is not minted at all — that is the whole of its effect.
    expect(result.summary.undistributed).toBe(30_715_811_965_811_965_813n);
  });

  it('pays that same farm 2.77x more once it spreads the same spend over five addresses', async () => {
    await honestEarners();
    const socks = [90, 91, 92, 93, 94].map(address);
    for (const sock of socks) {
      const earner = await makeEarner(sock);
      await spend(earner.workspaceId, dollars(180), INSIDE);
    }

    const result = await accrueWindow(getPrisma(), WINDOW, DEFAULT_REWARD_CONFIG);

    const farm = result.amounts
      .filter((row) => socks.includes(row.address))
      .reduce((sum, row) => sum + row.amount, 0n);

    expect(farm).toBe(FARM_BEHIND_FIVE_ADDRESSES);
    // $180 each is under a quarter of the pool, so nothing engages: the cap is
    // not evaded so much as never met.
    expect(result.summary.cappedAddresses).toEqual([]);
    // And the ~30.7 tokens the cap withheld above are minted instead.
    expect(result.summary.undistributed).toBe(4n);
  });

  it('pays the honest earners the same either way, because the pool is what is fixed', async () => {
    // Worth pinning, because the obvious reading of the two tests above is that
    // the farm took the difference from the four of them. It did not — every
    // honest share is pool * points / totalPoints, which no amount of splitting
    // touches. What splitting converts is withheld supply into the farm's
    // payout, so the loss falls on everybody holding the token, not on the
    // people in the period.
    await honestEarners();
    const farm = await makeEarner(address(90));
    await spend(farm.workspaceId, dollars(900), INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, DEFAULT_REWARD_CONFIG);

    const honest = result.amounts.filter((row) => row.address !== address(90));
    expect(honest.map((row) => row.amount)).toEqual([
      5_341_880_341_880_341_880n,
      5_341_880_341_880_341_880n,
      5_341_880_341_880_341_880n,
      5_341_880_341_880_341_880n,
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('Earners nobody can pay', () => {
  it('pays a workspace with no wallet nothing and reports it by name', async () => {
    const connected = await makeEarner(address(1));
    const disconnected = await makeEarner(null);
    await spend(connected.workspaceId, 2, INSIDE);
    await spend(disconnected.workspaceId, 3, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, config);

    expect(result.amounts.map((row) => row.address)).toEqual([address(1)]);
    // Reported per LAYER, with the layer's own unit: "3 earned nothing" is
    // unreadable when it could be three millionths of a dollar or three
    // records somebody else found useful.
    expect(result.skipped).toEqual([
      { workspaceId: disconnected.workspaceId, layer: 'spend', units: 3, reason: 'no-wallet' },
    ]);
    expect(result.summary.unpayablePoints).toBe(3);
  });

  it('does not hand their share to everybody else', async () => {
    // Connecting a wallet must not change what a closed period paid somebody
    // else, so the pool is divided by every point earned - not only the payable
    // ones. Two of five points are payable, so two tokens leave, not five.
    const connected = await makeEarner(address(1));
    const disconnected = await makeEarner(null);
    await spend(connected.workspaceId, 2, INSIDE);
    await spend(disconnected.workspaceId, 3, INSIDE);

    // Uncapped, so the only thing shaping the number is the denominator.
    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(result.summary.pool).toBe(5n * ONE_TOKEN);
    expect(result.amounts[0]!.amount).toBe(2n * ONE_TOKEN);
    expect(result.summary.undistributed).toBe(3n * ONE_TOKEN);
  });

  it('refuses a stored wallet that is not an address instead of guessing at it', async () => {
    const broken = await makeEarner(address(1));
    await getPrisma().user.update({
      where: { id: broken.ownerId },
      data: { walletAddress: '0xNOT-AN-ADDRESS' },
    });
    await spend(broken.workspaceId, 4, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, config);

    expect(result.amounts).toEqual([]);
    expect(result.skipped[0]!.reason).toBe('unusable-wallet');
  });
});

// ---------------------------------------------------------------------------
describe('Windows it will not price', () => {
  it('refuses a window that is not exactly one period long', async () => {
    const a = await makeEarner(address(1));
    await spend(a.workspaceId, 5, INSIDE);

    await expect(accrueWindow(getPrisma(), windowOf(WINDOW_START, 60), config)).rejects.toThrow(
      /exactly one period long/
    );
  });

  it('decides nothing for a period in which nothing was earned', async () => {
    const result = await accrueWindow(getPrisma(), WINDOW, config);

    expect(result.amounts).toEqual([]);
    expect(result.summary.pool).toBe(0n);
    expect(result.summary.totalPoints).toBe(0);
  });

  it('ignores spend confirmed outside the window', async () => {
    const a = await makeEarner(address(1));
    await spend(a.workspaceId, 5, new Date(WINDOW_START.getTime() - 1));
    await spend(a.workspaceId, 7, WINDOW_END);

    const result = await accrueWindow(getPrisma(), WINDOW, config);

    expect(result.summary.totalPoints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('The spend layer counts confirmed AI spend', () => {
  it('pays for confirmed model spend', async () => {
    const a = await makeEarner(address(1));
    await spend(a.workspaceId, 8, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(result.summary.totalPoints).toBe(8);
    expect(result.amounts).toEqual([
      expect.objectContaining({ address: address(1), amount: 8n * ONE_TOKEN }),
    ]);
  });

  it('counts no memory credit towards the spend layer, however many there are', async () => {
    // UPDATED 2026-09-21, deliberately. This used to assert that a workspace
    // with nothing but used memory earned NOTHING — true while rewards had one
    // layer, false since the owner added the second. What survives unchanged is
    // the half that still matters: a credit must never be counted as spend.
    // Points are millionths of a dollar somebody really paid a provider, and a
    // credit is a row; adding them would let the cheap unit price the expensive
    // one. What the memory layer pays is asserted in its own block below.
    const a = await makeEarner(address(1));
    await retrieve(a.workspaceId, 5000, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(result.summary.totalPoints).toBe(0);
    expect(result.layers.spend.units).toBe(0);
    expect(result.layers.spend.pool).toBe(0n);
    expect(result.amounts[0]!.spend).toBe(0n);
  });

  it('pays nothing for spend no provider has confirmed yet', async () => {
    // "Spend is confirmed, never claimed." An agent that reports a fortune and
    // waits earns exactly what an agent reporting nothing earns.
    const a = await makeEarner(address(1));
    await claimSpend(a.workspaceId, dollars(50_000), INSIDE, 'pending');

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(result.summary.totalPoints).toBe(0);
    expect(result.amounts).toEqual([]);
  });

  it('pays nothing for spend a provider refused to recognise', async () => {
    const a = await makeEarner(address(1));
    await claimSpend(a.workspaceId, dollars(50_000), INSIDE, 'rejected');

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(result.summary.totalPoints).toBe(0);
    expect(result.amounts).toEqual([]);
  });

  it('earns a workspace of idle agents nothing at all', async () => {
    // The brief, verbatim: a hundred idle agents earn nothing. There is no
    // fixture for "created an agent" because nothing in the accrual can see
    // one — which is the proof. A connected wallet does not change it either.
    const idle = await makeEarner(address(1));

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(idle.wallet).toBe(address(1));
    expect(result.shares).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.summary.totalPoints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('The memory layer counts records another agent used', () => {
  /**
   * The second layer, added by the owner on 2026-09-21.
   *
   * It exists for the person this product is aimed at and the spend layer
   * cannot see: somebody running Claude Code on a subscription. This service is
   * never told what Anthropic charged them, so they confirm no spend and earn
   * nothing from the first layer, forever. What they do have is memory other
   * agents use, and these are the tests that say what that is worth.
   *
   * Every block here is a way the cheap unit could end up pricing the expensive
   * one — one pool over both, one ceiling over both, one cap over both — and
   * the assertion is that it does not.
   */

  it('pays a workspace that confirmed no spend at all', async () => {
    // Two credits at a token each, under the memory ceiling of two tokens a
    // period, so the rate decides it and the earner is paid exactly their own
    // credits at the rate.
    const subscriber = await makeEarner(address(1));
    await credit(subscriber.workspaceId, 2, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(result.layers.memory.units).toBe(2);
    expect(result.layers.memory.boundBy).toBe('rate');
    expect(result.layers.memory.pool).toBe(2n * ONE_TOKEN);
    expect(result.summary.totalPoints).toBe(0);
    expect(result.amounts).toEqual([
      expect.objectContaining({
        address: address(1),
        amount: 2n * ONE_TOKEN,
        spend: 0n,
        memory: 2n * ONE_TOKEN,
      }),
    ]);
  });

  it('adds both layers into one amount for one address', async () => {
    // One accrual, one root, one claim. The two figures are carried beside the
    // total so the console can say WHY somebody was paid, which for a
    // subscriber earning from memory alone is the whole answer.
    const both = await makeEarner(address(1));
    await spend(both.workspaceId, 3, INSIDE);
    await credit(both.workspaceId, 2, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(result.amounts).toEqual([
      expect.objectContaining({
        address: address(1),
        spend: 3n * ONE_TOKEN,
        memory: 2n * ONE_TOKEN,
        amount: 5n * ONE_TOKEN,
      }),
    ]);
    expect(result.summary.distributed).toBe(5n * ONE_TOKEN);
    expect(result.summary.distributed).toBe(
      result.layers.spend.distributed + result.layers.memory.distributed
    );
  });

  it('binds one layer at its ceiling while the other is still at its rate', async () => {
    // The reason there are two pools rather than one. Four credits is past the
    // memory ceiling of two tokens a period; four points of spend is nowhere
    // near the spend ceiling of ten. A single pool would have to pick one
    // branch for both and would price whichever unit happened to be larger.
    const dominant = await makeEarner(address(1));
    const other = await makeEarner(address(2));
    await spend(dominant.workspaceId, 3, INSIDE);
    await spend(other.workspaceId, 1, INSIDE);
    await credit(dominant.workspaceId, 3, INSIDE);
    await credit(other.workspaceId, 1, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, config);

    expect(result.layers.spend.boundBy).toBe('rate');
    expect(result.layers.spend.pool).toBe(4n * ONE_TOKEN);
    expect(result.layers.memory.boundBy).toBe('ceiling');
    expect(result.layers.memory.pool).toBe(2n * ONE_TOKEN);

    // And the cap follows the branch, per layer: it divides a contested pool,
    // so it applies to the memory layer here and not to the spend layer.
    expect(result.layers.spend.cappedWorkspaceIds).toEqual([]);
    expect(result.layers.memory.cappedWorkspaceIds).toEqual([dominant.workspaceId]);

    // Memory cap: a quarter of two tokens. The dominant workspace's pro-rata
    // 1.5 tokens is held to 0.5; the other keeps its own 0.5.
    expect(result.layers.memory.cap).toBe(ONE_TOKEN / 2n);
    expect(result.amounts).toEqual([
      expect.objectContaining({
        address: address(1),
        spend: 3n * ONE_TOKEN,
        memory: ONE_TOKEN / 2n,
      }),
      expect.objectContaining({
        address: address(2),
        spend: 1n * ONE_TOKEN,
        memory: ONE_TOKEN / 2n,
      }),
    ]);

    // What the memory cap withheld is not minted and does not reach the spend
    // layer either: one token of the memory pool stays in the contract.
    expect(result.layers.memory.undistributed).toBe(ONE_TOKEN);
    expect(result.layers.spend.undistributed).toBe(0n);
  });

  it('reports a credit nobody can be paid for, in credits, and gives it to nobody else', async () => {
    // Same rule as the spend layer, in the memory layer's own unit: the
    // denominator is every credit earned, not every payable one, so connecting
    // a wallet later cannot shrink what a closed period already paid somebody.
    const connected = await makeEarner(address(1));
    const disconnected = await makeEarner(null);
    await credit(connected.workspaceId, 1, INSIDE);
    await credit(disconnected.workspaceId, 1, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(result.skipped).toEqual([
      { workspaceId: disconnected.workspaceId, layer: 'memory', units: 1, reason: 'no-wallet' },
    ]);
    expect(result.layers.memory.unpayableUnits).toBe(1);
    expect(result.amounts).toEqual([
      expect.objectContaining({ address: address(1), memory: ONE_TOKEN }),
    ]);
    expect(result.layers.memory.undistributed).toBe(ONE_TOKEN);
  });

  it('leaves a spend-only period exactly as the single-layer accrual left it', async () => {
    // The no-regression line. Every period settled before this layer existed
    // had no credits in it, and the two-layer arithmetic has to agree with the
    // one-layer arithmetic on all of them — the ledger is never rewritten, so a
    // change of a single base unit here would be a root contradicting one
    // already on chain.
    const a = await makeEarner(address(1));
    const b = await makeEarner(address(2));
    await spend(a.workspaceId, 1000, INSIDE);
    await spend(b.workspaceId, 500, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, uncapped);

    expect(result.layers.memory.units).toBe(0);
    expect(result.layers.memory.pool).toBe(0n);
    expect(result.layers.memory.distributed).toBe(0n);
    expect(result.amounts).toEqual([
      { address: address(1), amount: 6_666_666_666_666_666_666n, spend: 6_666_666_666_666_666_666n, memory: 0n, workspaceIds: [a.workspaceId], cappedByAddress: false },
      { address: address(2), amount: 3_333_333_333_333_333_333n, spend: 3_333_333_333_333_333_333n, memory: 0n, workspaceIds: [b.workspaceId], cappedByAddress: false },
    ]);
    expect(result.summary.pool).toBe(10n * ONE_TOKEN);
    expect(result.summary.boundBy).toBe('ceiling');
  });
});

// ---------------------------------------------------------------------------
describe('Realistic magnitudes', () => {
  /**
   * The shipped policy, with the cap lifted so one rule reads at a time. A
   * point is a millionth of a dollar and the default rate prices a dollar of
   * confirmed spend at one token, so these are the figures a real period
   * carries.
   */
  const real: RewardConfig = { ...DEFAULT_REWARD_CONFIG, perWorkspaceCapPerPeriod: 1 };

  it('prices a dollar of confirmed spend at one token while the ceiling is clear', async () => {
    const a = await makeEarner(address(1));
    await spend(a.workspaceId, dollars(12), INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, real);

    expect(result.summary.totalPoints).toBe(12_000_000);
    expect(result.summary.boundBy).toBe('rate');
    expect(result.summary.pool).toBe(12n * ONE_TOKEN);
    expect(result.amounts[0]!.amount).toBe(12n * ONE_TOKEN);
  });

  it('splits thousands of dollars across several workspaces without rounding badly', async () => {
    // $4,000 + $3,000 + $2,000 + $1,000 = $10,000 confirmed in one ten-minute
    // period: 10^10 points against a rate of 10^12 base units. Both the point
    // total and the pool are far past anything the formula saw when a point was
    // a retrieval, and neither is allowed to drift by a base unit.
    const a = await makeEarner(address(1));
    const b = await makeEarner(address(2));
    const c = await makeEarner(address(3));
    const d = await makeEarner(address(4));

    await spend(a.workspaceId, dollars(4000), INSIDE);
    await spend(b.workspaceId, dollars(3000), INSIDE);
    await spend(c.workspaceId, dollars(2000), INSIDE);
    await spend(d.workspaceId, dollars(1000), INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, real);

    expect(result.summary.totalPoints).toBe(10_000_000_000);
    expect(Number.isSafeInteger(result.summary.totalPoints)).toBe(true);

    // The ceiling binds: $10,000 of spend is 10,000 tokens at the rate, and a
    // period is 10,000/144 of the daily ceiling.
    expect(result.summary.atRate).toBe(10_000n * ONE_TOKEN);
    expect(result.summary.boundBy).toBe('ceiling');
    expect(result.summary.pool).toBe((10_000n * ONE_TOKEN) / 144n);

    // Exact shares, to the base unit: 4:3:2:1 of the pool.
    const pool = result.summary.pool;
    expect(result.amounts.map((row) => row.amount)).toEqual([
      (pool * 4n) / 10n,
      (pool * 3n) / 10n,
      (pool * 2n) / 10n,
      (pool * 1n) / 10n,
    ]);

    // Nothing minted beyond the pool, and what stays behind is division
    // remainder rather than a lost share: four floors strand at most three base
    // units, which is three millionths of a millionth of a millionth of a token.
    expect(result.summary.distributed).toBeLessThanOrEqual(pool);
    expect(result.summary.undistributed).toBeLessThan(4n);
  });

  it('holds a large spender to the same cap as a small one', async () => {
    // Scale must not buy an exemption. $9,000 beside $1,000 is a 90% pro-rata
    // share, and the cap is still a quarter of the period.
    const whale = await makeEarner(address(1));
    const minnow = await makeEarner(address(2));

    await spend(whale.workspaceId, dollars(9000), INSIDE);
    await spend(minnow.workspaceId, dollars(1000), INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, DEFAULT_REWARD_CONFIG);

    const share = result.shares.find((row) => row.workspaceId === whale.workspaceId)!;
    expect(share.proRata).toBeGreaterThan(result.summary.cap);
    expect(share.amount).toBe(result.summary.cap);
    expect(result.summary.cap).toBe(result.summary.pool / 4n);
    expect(result.summary.distributed).toBeLessThan(result.summary.pool);
  });

  it('still pays a spender a million times smaller than its neighbour', async () => {
    // One cent beside ten thousand dollars. Its pro-rata share is a billionth
    // of the pool, which at 18 decimals is still tens of millions of base
    // units — so it is paid rather than floored away, and its points count in
    // the denominator either way so that dust cannot inflate anybody else.
    const big = await makeEarner(address(1));
    const dust = await makeEarner(address(2));

    await spend(big.workspaceId, dollars(10_000), INSIDE);
    await spend(dust.workspaceId, 10_000, INSIDE);

    const result = await accrueWindow(getPrisma(), WINDOW, real);

    expect(result.summary.totalPoints).toBe(10_000_010_000);

    const share = result.shares.find((row) => row.workspaceId === dust.workspaceId)!;
    expect(share.units).toBe(10_000);
    expect(share.amount).toBeGreaterThan(0n);
    expect(result.amounts.map((row) => row.address)).toContain(address(2));
  });

  it('refuses to price a window whose total it cannot add up exactly', async () => {
    // Out of reach with real money — nine quadrillion millionths is nine
    // billion dollars in ten minutes — but past that line JavaScript addition
    // rounds without saying so, and the rounded figure would go into a ledger
    // row that is never rewritten. So the refusal is asserted rather than
    // assumed.
    //
    // Fed from a stub rather than from rows, because no honest path produces
    // this total and forcing it into the column would mean writing a value
    // Postgres cannot hold in the Int the schema declares — a test that passes
    // on SQLite and fails on the database this suite can be pointed at.
    const unsummable = {
      modelUsage: {
        groupBy: async () => [
          { workspaceId: 'ws-a', _sum: { verifiedCostMicros: Number.MAX_SAFE_INTEGER } },
          { workspaceId: 'ws-b', _sum: { verifiedCostMicros: Number.MAX_SAFE_INTEGER } },
        ],
      },
      // The memory layer is read in the same call and would otherwise throw
      // first, which would pass this test for the wrong reason.
      rewardCredit: { groupBy: async () => [] },
      workspace: {
        findMany: async () => [
          { id: 'ws-a', owner: { walletAddress: address(1) } },
          { id: 'ws-b', owner: { walletAddress: address(2) } },
        ],
      },
    } as unknown as Db;

    await expect(accrueWindow(unsummable, WINDOW, real)).rejects.toThrow(
      /Refusing to price the period/
    );
  });
});

// ---------------------------------------------------------------------------
describe('What one more dollar of confirmed spend does to the period', () => {
  /**
   * The claim every surface makes about this formula, checked against the
   * formula.
   *
   * The console, the landing page and the MCP tool description all tell a
   * reader what spending more is worth, and all three used to say it was worth
   * nothing to anybody: a fixed pool that extra spend only redivides. That is
   * true of the FUND — nothing here mints — and false of the period, because
   * below the ceiling the pool IS the spend priced at the rate. Getting it
   * wrong is not a wording problem: a reader told their payout is only a share
   * of something fixed concludes that one more request is worth nothing to
   * them, and under the ceiling it is worth exactly the rate.
   *
   * Both regimes are pinned because the honest sentence needs both halves, and
   * because the launch sits in the first one: at the shipped defaults the
   * ceiling does not bind until the whole network confirms about $69 in ten
   * minutes.
   */

  /** 10,000 tokens a day over 144 ten-minute periods. */
  const CEILING_PER_PERIOD = 69_444_444_444_444_444_444n;

  it('adds to what the period pays out while the ceiling is clear, and takes nothing from the people already in it', async () => {
    const alice = await makeEarner(address(1));
    await spend(alice.workspaceId, dollars(1), INSIDE);

    const alone = await accrueWindow(getPrisma(), WINDOW, DEFAULT_REWARD_CONFIG);

    const bob = await makeEarner(address(2));
    await spend(bob.workspaceId, dollars(50), INSIDE);

    const together = await accrueWindow(getPrisma(), WINDOW, DEFAULT_REWARD_CONFIG);

    expect(alone.summary.boundBy).toBe('rate');
    expect(together.summary.boundBy).toBe('rate');

    // Bob's $50 put fifty more tokens into the period. Nothing was minted to
    // do it — the distributor held them already — but what leaves it that
    // period is fifty tokens larger than it would have been.
    expect(together.summary.pool - alone.summary.pool).toBe(50n * ONE_TOKEN);

    // And Alice is paid her own dollar either way. She did not fund Bob and
    // Bob did not dilute her.
    expect(alone.amounts[0]!.amount).toBe(ONE_TOKEN);
    expect(together.amounts[0]!.amount).toBe(ONE_TOKEN);
  });

  it('stops adding once the ceiling binds, and shrinks everybody already in the period', async () => {
    const alice = await makeEarner(address(1));
    const bob = await makeEarner(address(2));
    await spend(alice.workspaceId, dollars(1), INSIDE);
    await spend(bob.workspaceId, dollars(50), INSIDE);

    const under = await accrueWindow(getPrisma(), WINDOW, DEFAULT_REWARD_CONFIG);

    const carol = await makeEarner(address(3));
    await spend(carol.workspaceId, dollars(500), INSIDE);

    const over = await accrueWindow(getPrisma(), WINDOW, DEFAULT_REWARD_CONFIG);

    expect(under.summary.boundBy).toBe('rate');
    expect(over.summary.boundBy).toBe('ceiling');

    // Carol's $500 is worth 500 tokens at the rate and the period grew by
    // eighteen, because the ceiling is where it stopped.
    expect(over.summary.pool).toBe(CEILING_PER_PERIOD);
    expect(over.summary.pool - under.summary.pool).toBe(18_444_444_444_444_444_444n);

    // This is the only regime the fixed-pool sentence describes: Alice's
    // dollar, worth a whole token a moment ago, is now worth an eighth of one
    // because somebody else spent.
    expect(under.amounts[0]!.amount).toBe(ONE_TOKEN);
    expect(over.amounts[0]!.amount).toBe(126_033_474_490_824_763n);
  });
});
