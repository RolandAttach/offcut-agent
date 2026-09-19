/**
 * Settings that cannot be applied are refused when they are read.
 *
 * A misconfigured ceiling that is discovered halfway through a distribution run
 * has already written half the addresses down. Every check here exists so that
 * the failure happens at startup, with a message naming the variable.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REWARD_CONFIG,
  ONE_TOKEN,
  assertUsableConfig,
  capForPool,
  ceilingPerPeriod,
  memoryCeilingPerPeriod,
  periodsPerDay,
  resolveRewardConfig,
} from '../config';

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
describe('The defaults', () => {
  it('are usable as they stand', () => {
    expect(() => assertUsableConfig(DEFAULT_REWARD_CONFIG)).not.toThrow();
    expect(periodsPerDay(DEFAULT_REWARD_CONFIG)).toBe(144);
  });

  it('spread the ceiling across the day, erring below it and never above', () => {
    const perPeriod = ceilingPerPeriod(DEFAULT_REWARD_CONFIG);
    const shortfall = DEFAULT_REWARD_CONFIG.dailyCeiling - perPeriod * 144n;

    // 10,000 tokens does not divide by 144, so a day emits at most 64 base
    // units - sixty-four billionths of a billionth of a token - under the
    // figure written down. Below is the only direction a ceiling may err.
    expect(shortfall).toBeGreaterThanOrEqual(0n);
    expect(shortfall).toBeLessThan(144n);
  });

  it('hold one earner to a quarter of a period', () => {
    const pool = ceilingPerPeriod(DEFAULT_REWARD_CONFIG);

    expect(capForPool(pool, DEFAULT_REWARD_CONFIG)).toBe(pool / 4n);
  });

  it('keep the memory layer an order under the spend layer', () => {
    // The owner's figures: 10,000 tokens a day for confirmed spend, 2,000 for
    // memory. The ratio is the policy, not a coincidence — spend is bounded by
    // money somebody really paid a provider, and memory is bounded by nothing
    // but this number, since a record is a row and a retrieval is a query.
    expect(DEFAULT_REWARD_CONFIG.memoryDailyCeiling).toBe(2_000n * ONE_TOKEN);
    expect(DEFAULT_REWARD_CONFIG.memoryDailyCeiling * 5n).toBe(
      DEFAULT_REWARD_CONFIG.dailyCeiling
    );
    expect(DEFAULT_REWARD_CONFIG.ratePerCredit).toBe(ONE_TOKEN);
  });

  it('price a dollar of spend and a used record both at one token', () => {
    // The two rates look a million apart and are not: a dollar of confirmed
    // spend is a million points, a used record is one credit.
    expect(DEFAULT_REWARD_CONFIG.ratePerPoint * 1_000_000n).toBe(ONE_TOKEN);
    expect(DEFAULT_REWARD_CONFIG.ratePerCredit).toBe(ONE_TOKEN);
  });

  it('spread the memory ceiling across the day with its own divisor', () => {
    // Its own function, so a caller cannot pass the wrong ceiling by passing
    // nothing. Reading the spend ceiling here would emit five times what the
    // owner approved, every period, without a single error to show for it.
    expect(memoryCeilingPerPeriod(DEFAULT_REWARD_CONFIG)).toBe(
      DEFAULT_REWARD_CONFIG.memoryDailyCeiling / 144n
    );
    expect(memoryCeilingPerPeriod(DEFAULT_REWARD_CONFIG)).toBeLessThan(
      ceilingPerPeriod(DEFAULT_REWARD_CONFIG)
    );
  });
});

// ---------------------------------------------------------------------------
describe('Reading settings from the environment', () => {
  it('takes amounts in whole tokens and stores base units', () => {
    const config = resolveRewardConfig(
      env({ OFFCUT_REWARD_DAILY_CEILING: '2880', OFFCUT_REWARD_RATE_PER_POINT: '0.5' })
    );

    expect(config.dailyCeiling).toBe(2880n * ONE_TOKEN);
    expect(config.ratePerPoint).toBe(ONE_TOKEN / 2n);
  });

  it('falls back to the defaults when nothing is set', () => {
    expect(resolveRewardConfig(env({}))).toEqual(DEFAULT_REWARD_CONFIG);
  });

  it('reads the memory layer the same way, from its own two variables', () => {
    const config = resolveRewardConfig(
      env({
        OFFCUT_REWARD_MEMORY_DAILY_CEILING: '720',
        OFFCUT_REWARD_RATE_PER_CREDIT: '0.5',
      })
    );

    expect(config.memoryDailyCeiling).toBe(720n * ONE_TOKEN);
    expect(config.ratePerCredit).toBe(ONE_TOKEN / 2n);
    // And the spend layer is untouched: two layers, four knobs, no crosstalk.
    expect(config.dailyCeiling).toBe(DEFAULT_REWARD_CONFIG.dailyCeiling);
    expect(config.ratePerPoint).toBe(DEFAULT_REWARD_CONFIG.ratePerPoint);
  });

  it('refuses a memory ceiling it cannot hold exactly, by name', () => {
    expect(() =>
      resolveRewardConfig(
        env({ OFFCUT_REWARD_MEMORY_DAILY_CEILING: '0.0000000000000000001' })
      )
    ).toThrow(/OFFCUT_REWARD_MEMORY_DAILY_CEILING/);
    expect(() =>
      resolveRewardConfig(env({ OFFCUT_REWARD_RATE_PER_CREDIT: 'a lot' }))
    ).toThrow(/OFFCUT_REWARD_RATE_PER_CREDIT/);
  });

  it('refuses a negative memory ceiling', () => {
    expect(() =>
      resolveRewardConfig(env({ OFFCUT_REWARD_MEMORY_DAILY_CEILING: '-1' }))
    ).toThrow(/cannot be negative/);
  });

  it('refuses more precision than the token has, rather than rounding it away', () => {
    expect(() =>
      resolveRewardConfig(env({ OFFCUT_REWARD_RATE_PER_POINT: '0.0000000000000000001' }))
    ).toThrow(/at most 18 decimals/);
  });

  it('refuses a negative ceiling', () => {
    expect(() => resolveRewardConfig(env({ OFFCUT_REWARD_DAILY_CEILING: '-1' }))).toThrow(
      /cannot be negative/
    );
  });

  it('refuses a period that does not tile a day', () => {
    // 7 minutes leaves 5 minutes of every day unpriced, and the daily ceiling
    // would stop bounding a day.
    expect(() => resolveRewardConfig(env({ OFFCUT_REWARD_PERIOD_MINUTES: '7' }))).toThrow(
      /divide a day evenly/
    );
  });

  it('refuses a cap that caps nothing', () => {
    expect(() => resolveRewardConfig(env({ OFFCUT_REWARD_WORKSPACE_CAP: '1.5' }))).toThrow(
      /above 0 and at most 1/
    );
    expect(() => resolveRewardConfig(env({ OFFCUT_REWARD_WORKSPACE_CAP: '0' }))).toThrow(
      /above 0 and at most 1/
    );
  });

  it('refuses a cap finer than a basis point', () => {
    expect(() => resolveRewardConfig(env({ OFFCUT_REWARD_WORKSPACE_CAP: '0.123456' }))).toThrow(
      /whole number of basis points/
    );
  });
});
