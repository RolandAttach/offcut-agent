/**
 * Every number that decides how much money leaves the contract.
 *
 * They live together because the only way to reason about emission is to read
 * all of them at once, and because a rate hidden in one file and a ceiling
 * hidden in another is how a system ends up minting more than anybody intended.
 *
 * The shape of the policy, decided with the owner:
 *
 *   TWO LAYERS, ONE LEDGER. A period prices two things that are not the same
 *   quantity and must never share a denominator: SPEND, confirmed model spend
 *   in millionths of a dollar, and MEMORY, records another agent used. Each has
 *   its own ceiling, its own rate and its own pro-rata split; the two amounts
 *   an address earns are added into one accrual, one root, one claim. The
 *   reason they are separate is that a credit and a millionth of a dollar
 *   cannot be added — one pool over both would price whichever unit happened to
 *   be larger that period.
 *
 *   Someone running Claude Code on a subscription spends nothing this service
 *   can confirm and therefore earns nothing from the spend layer. The memory
 *   layer is what they earn from, and the ceilings say how much: 10,000 tokens
 *   a day for spend, 2,000 for memory.
 *
 *   FIXED POOL, SPLIT PRO-RATA. Each layer has a pool each period, and it is
 *
 *       min(dailyCeiling / periodsPerDay, units * rate)
 *
 *   — a CEILING, not an obligation. Three users on day one share tens of
 *   tokens, not hundreds, because the right-hand branch binds. A busy month
 *   cannot outrun the left-hand branch. Unbounded per-unit emission, where
 *   every point mints at the rate however many points there are, is exactly
 *   what this is avoiding.
 *
 *   A point is a millionth of a dollar of CONFIRMED AI SPEND, so the right-hand
 *   branch is the network's real usage priced in tokens. While that branch
 *   binds, extra spend DOES enlarge the pool — that is what the branch is for
 *   — and at the ceiling it stops. What no amount of spend does is mint: the
 *   distributor holds its tokens already, so a pool the formula never allocates
 *   is an amount that stays in the contract rather than one that appears.
 *
 *   A PER-EARNER CAP ON A CONTESTED POOL, which brakes a dominant earner
 *   sharing a period with other people. It applies only where the ceiling
 *   decided the pool: when the rate decided it, every share is already exactly
 *   that earner's own spend at the rate, and a cap could only refuse to pay it.
 *   See accrual.ts, which is where the distinction is enforced. What it does
 *   NOT do is stop a farm, which splits across addresses to walk around it —
 *   perWorkspaceCapPerPeriod carries the arithmetic of why nothing capped
 *   per-identity can, and why the pool formula is the part that does.
 *
 * Amounts are BASE units — 10^18 to a whole token — held as bigint and never as
 * a float, because a float cannot represent 10^18 + 1, and arithmetic that
 * cannot represent its own smallest unit has no business deciding payments.
 */

// @offcut/core reads .env on import. Without this the variables below are only
// seen when somebody exported them by hand, so a ceiling configured in the
// repository's .env would be silently ignored and the defaults would pay out.
import '@offcut/core';

import { parseUnits } from 'ethers';

/** Decimals of the reward token, matching the ERC-20 the distributor holds. */
export const TOKEN_DECIMALS = 18;

/** One whole token, in base units. */
export const ONE_TOKEN = 10n ** BigInt(TOKEN_DECIMALS);

const MINUTES_PER_DAY = 1440;

/**
 * Points in one dollar of confirmed spend.
 *
 * usage.ts counts spend in integer millionths of a dollar and hands those
 * straight through as points, so every figure in this file that is written per
 * dollar has to be divided by this to become a rate per point. Named rather
 * than spelled 1_000_000 inline: the two places it appears are a default and a
 * README, and a mismatch between them is a rate off by six orders of magnitude.
 */
export const POINTS_PER_DOLLAR = 1_000_000n;

/**
 * The cap is written as a fraction and the arithmetic is integer, so fractions
 * are converted to basis points and applied as `pool * bp / 10000`. A fraction
 * finer than a basis point is refused rather than rounded: rounding a cap is
 * rounding somebody's ceiling, in a direction nobody chose.
 */
const BASIS_POINTS = 10_000n;

export interface RewardConfig {
  /**
   * The most that may be emitted in a day, in base units.
   *
   * A ceiling, not a budget to be spent: if the points earned that day are
   * worth less at `ratePerPoint`, less is emitted and the difference is never
   * minted at all.
   *
   * Default 10,000 tokens a day. Paired with the default rate of one token per
   * dollar of confirmed spend, the ceiling begins to bind once the whole
   * network spends more than $10,000 of AI on a day — below that a dollar is
   * worth a token, above it every dollar is worth proportionally less and the
   * emission stays flat however busy the network gets. This is the one lever
   * that bounds emission, so set it deliberately before the first root is
   * published.
   */
  dailyCeiling: bigint;

  /**
   * How long a distribution period is. Default 10 minutes, so 144 a day. Must
   * divide a day evenly, or the periods do not tile it and `dailyCeiling`
   * stops meaning what it says.
   */
  periodMinutes: number;

  /**
   * What one point is worth while the ceiling is not binding, in base units.
   *
   * A point is ONE MILLIONTH OF A DOLLAR of confirmed model spend (see
   * usage.ts). So a dollar of spend is a million points, and the default of
   * 10^12 base units — a millionth of a token — prices a dollar of confirmed
   * spend at one whole token while the ceiling is not binding.
   *
   * The scale matters more than the figure. This used to be one token per
   * point, when a point was one record another agent retrieved. Left at that
   * against a metric a million times finer, the right-hand branch of the pool
   * formula would be a million tokens per dollar and would never again be the
   * smaller of the two: the ceiling would bind in every period, and a day would
   * emit its whole ceiling whether anybody spent ten dollars or ten cents. The
   * branch that makes the pool follow real usage would have been quietly dead.
   *
   * What it is NOT is a promise to repay a dollar of AI spend with a token's
   * worth of $OFFCUT. The fund is pre-funded and owes nobody this rate; on any
   * period where the ceiling binds, a dollar of spend is worth whatever the
   * pro-rata split makes it worth, which is less, and on any period at all a
   * lone earner takes the per-earner cap rather than the rate. Rewards follow
   * usage. They do not reimburse it.
   */
  ratePerPoint: bigint;

  /**
   * The most one earner may take out of a single CEILING-BOUND period, as a
   * fraction of that period's pool. Default 0.25.
   *
   * Enforced on the workspace AND on the owner address it pays to. A workspace,
   * like an agent, is a row that costs nothing to create, and the address is
   * where money actually lands, so both are capped. The address is also the
   * strongest identity this codebase has: User.walletAddress is a single
   * column, so an account resolves to exactly one payee, and two accounts
   * naming one address are merged into one payee sharing one cap.
   *
   * IT STILL DOES NOT STOP A FARM, and this comment used to claim it did. The
   * allowance is granted per payee, so n payees are allowed n * cap between
   * them out of a pool that does not grow to match. Anyone entitled to more
   * than the cap is better off split across enough addresses to stay under it,
   * and an address costs a registration and a self-declared string — linkWallet
   * calls it a mailing address, not a proof of ownership. On the defaults, $900
   * of confirmed spend beside four honest earners at $100 takes 17.36 tokens
   * behind one address and 48.08 behind five: 2.77x, on identical spend and an
   * identical pool. Capping owner accounts instead would change nothing,
   * because that is already what this caps, and no cap of any shape escapes it
   * — a cap is sublinear in a payee's share, and n * f(x/n) >= f(x) for every
   * sublinear f. Only a proof of uniqueness would, and nothing here has one.
   *
   * What bounds a farm is the pool, not this. Splitting spend across accounts
   * does not change how much was spent, so min(ceiling, points * rate) returns
   * the same number either way, and a pro-rata split of a fixed pool pays for
   * money that was really spent however many addresses it arrives behind. Read
   * this as a ceiling on what one payee may be paid for one period — it bounds
   * a single leaf of the tree, and it brakes a dominant earner who has not
   * bothered to split — and not as a defence.
   *
   * It does not apply to a rate-bound period. There the pool is the window's
   * own spend priced at `ratePerPoint` and each share is the earner's own
   * spend, so there is no larger share to take and a cap withholds rather than
   * redistributes. Raising this figure cannot make a quiet period pay more than
   * the rate; lowering it cannot hold a busy one below what the ceiling allows.
   */
  perWorkspaceCapPerPeriod: number;

  /**
   * The most the MEMORY layer may emit in a day, in base units. Default 2,000
   * tokens — a fifth of the spend layer's.
   *
   * A separate ceiling rather than a slice of the first one, because the two
   * layers are bounded by different things. Spend is bounded by money somebody
   * really paid a provider; memory is bounded by nothing but this number, since
   * a record is a row and a retrieval is a query. The unique constraint on
   * RewardCredit (a record earns once, ever, and only for a reader that did not
   * write it) is what makes farming it laborious; this is what makes it
   * unprofitable at scale. Raising it is the single most dangerous edit in this
   * package.
   */
  memoryDailyCeiling: bigint;

  /**
   * What one credit is worth while the memory ceiling is not binding, in base
   * units. Default one whole token per credit.
   *
   * A credit is one record, written by one agent, retrieved once ever by
   * another — not per retrieval and not per record written. So the right-hand
   * branch of the memory pool is "how much of this workspace's memory was
   * actually useful to somebody else today", priced at a token each, and the
   * ceiling binds once the whole network passes 2,000 such records in a day.
   *
   * Whole tokens per unit here against a millionth of a token per unit in
   * `ratePerPoint` is not an inconsistency: the units are a million times
   * apart. A dollar of spend is a million points; a used record is one credit.
   */
  ratePerCredit: bigint;
}

export const DEFAULT_REWARD_CONFIG: RewardConfig = {
  dailyCeiling: 10_000n * ONE_TOKEN,
  periodMinutes: 10,
  // One token per DOLLAR of confirmed spend, expressed per point. Written as a
  // division rather than as 10n ** 12n so the intent survives a change to
  // TOKEN_DECIMALS — the rate is a fraction of a token, not a fixed integer.
  ratePerPoint: ONE_TOKEN / POINTS_PER_DOLLAR,
  perWorkspaceCapPerPeriod: 0.25,
  memoryDailyCeiling: 2_000n * ONE_TOKEN,
  ratePerCredit: ONE_TOKEN,
};

/**
 * Reads an amount written the way a person writes one — "10000", "0.5" — and
 * returns base units.
 *
 * parseUnits rather than a multiplication because it REFUSES more precision
 * than the token has. "0.0000000000000000001" is nineteen decimals on an
 * eighteen-decimal token; multiplying would round it away and pay a number
 * nobody chose, which is the one failure this package must not have.
 */
function tokenAmount(raw: string | undefined, fallback: bigint, name: string): bigint {
  if (raw === undefined || raw.trim() === '') return fallback;

  let parsed: bigint;
  try {
    parsed = parseUnits(raw.trim(), TOKEN_DECIMALS);
  } catch {
    throw new Error(
      `${name} must be an amount of whole tokens with at most ${TOKEN_DECIMALS} decimals, ` +
        `for example "10000" or "0.5". Got ${JSON.stringify(raw)}.`
    );
  }

  if (parsed < 0n) throw new Error(`${name} cannot be negative. Got ${JSON.stringify(raw)}.`);
  return parsed;
}

function wholeNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number of minutes. Got ${JSON.stringify(raw)}.`);
  }
  return value;
}

function fractionOf(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    throw new Error(
      `${name} must be a fraction above 0 and at most 1, for example 0.25. Got ${JSON.stringify(raw)}.`
    );
  }
  return value;
}

/**
 * The configuration in force: the environment, falling back to the defaults
 * above.
 *
 * Validated here rather than at the point of use, so a ceiling that cannot be
 * applied fails when the process reads its settings — not halfway through a
 * distribution run with half the addresses already written down.
 */
export function resolveRewardConfig(env: NodeJS.ProcessEnv = process.env): RewardConfig {
  const config: RewardConfig = {
    dailyCeiling: tokenAmount(
      env.OFFCUT_REWARD_DAILY_CEILING,
      DEFAULT_REWARD_CONFIG.dailyCeiling,
      'OFFCUT_REWARD_DAILY_CEILING'
    ),
    periodMinutes: wholeNumber(
      env.OFFCUT_REWARD_PERIOD_MINUTES,
      DEFAULT_REWARD_CONFIG.periodMinutes,
      'OFFCUT_REWARD_PERIOD_MINUTES'
    ),
    ratePerPoint: tokenAmount(
      env.OFFCUT_REWARD_RATE_PER_POINT,
      DEFAULT_REWARD_CONFIG.ratePerPoint,
      'OFFCUT_REWARD_RATE_PER_POINT'
    ),
    perWorkspaceCapPerPeriod: fractionOf(
      env.OFFCUT_REWARD_WORKSPACE_CAP,
      DEFAULT_REWARD_CONFIG.perWorkspaceCapPerPeriod,
      'OFFCUT_REWARD_WORKSPACE_CAP'
    ),
    memoryDailyCeiling: tokenAmount(
      env.OFFCUT_REWARD_MEMORY_DAILY_CEILING,
      DEFAULT_REWARD_CONFIG.memoryDailyCeiling,
      'OFFCUT_REWARD_MEMORY_DAILY_CEILING'
    ),
    ratePerCredit: tokenAmount(
      env.OFFCUT_REWARD_RATE_PER_CREDIT,
      DEFAULT_REWARD_CONFIG.ratePerCredit,
      'OFFCUT_REWARD_RATE_PER_CREDIT'
    ),
  };

  assertUsableConfig(config);
  return config;
}

/** Throws unless every number can actually be applied. */
export function assertUsableConfig(config: RewardConfig): void {
  if (config.dailyCeiling < 0n) throw new Error('dailyCeiling cannot be negative.');
  if (config.ratePerPoint < 0n) throw new Error('ratePerPoint cannot be negative.');
  if (config.memoryDailyCeiling < 0n) throw new Error('memoryDailyCeiling cannot be negative.');
  if (config.ratePerCredit < 0n) throw new Error('ratePerCredit cannot be negative.');

  if (!Number.isInteger(config.periodMinutes) || config.periodMinutes <= 0) {
    throw new Error(
      `periodMinutes must be a positive whole number of minutes; got ${config.periodMinutes}.`
    );
  }
  if (MINUTES_PER_DAY % config.periodMinutes !== 0) {
    throw new Error(
      `periodMinutes must divide a day evenly, or the periods do not tile it and dailyCeiling ` +
        `stops bounding a day; ${config.periodMinutes} does not divide ${MINUTES_PER_DAY}.`
    );
  }

  // Zero pays nobody anything, which is a broken deployment rather than a
  // policy; above one is a cap larger than the thing it caps.
  if (!(config.perWorkspaceCapPerPeriod > 0 && config.perWorkspaceCapPerPeriod <= 1)) {
    throw new Error(
      `perWorkspaceCapPerPeriod must be a fraction above 0 and at most 1; ` +
        `got ${config.perWorkspaceCapPerPeriod}.`
    );
  }
  capBasisPoints(config);
}

export function periodsPerDay(config: RewardConfig): number {
  assertUsableConfig(config);
  return MINUTES_PER_DAY / config.periodMinutes;
}

/**
 * The left-hand branch of the pool formula, in base units.
 *
 * Integer division, and the remainder is neither carried into the next period
 * nor handed to anybody: a ceiling that does not divide evenly by the number of
 * periods emits a few base units less per day than the figure written down.
 * Below is the only direction a ceiling may err.
 */
export function ceilingPerPeriod(config: RewardConfig): bigint {
  return config.dailyCeiling / BigInt(periodsPerDay(config));
}

/**
 * The same branch for the MEMORY layer.
 *
 * Its own function rather than a parameter on the one above, so that a caller
 * cannot pass the wrong ceiling by passing nothing: the two layers are priced
 * in the same file and an accrual that silently used the spend ceiling for
 * memory would emit five times what the owner approved.
 */
export function memoryCeilingPerPeriod(config: RewardConfig): bigint {
  return config.memoryDailyCeiling / BigInt(periodsPerDay(config));
}

/**
 * The per-earner cap as exact basis points.
 *
 * The tolerance below exists because 0.33 * 10000 is 3299.9999999999995 in
 * binary floating point, not because a third of a basis point is being let
 * through — anything genuinely finer is refused.
 */
export function capBasisPoints(config: RewardConfig): bigint {
  const scaled = config.perWorkspaceCapPerPeriod * Number(BASIS_POINTS);
  const whole = Math.round(scaled);
  if (Math.abs(scaled - whole) > 1e-9) {
    throw new Error(
      `perWorkspaceCapPerPeriod must be a whole number of basis points (a multiple of 0.0001); ` +
        `got ${config.perWorkspaceCapPerPeriod}.`
    );
  }
  return BigInt(whole);
}

/** The most one earner may take out of `pool`, in base units. */
export function capForPool(pool: bigint, config: RewardConfig): bigint {
  return (pool * capBasisPoints(config)) / BASIS_POINTS;
}
