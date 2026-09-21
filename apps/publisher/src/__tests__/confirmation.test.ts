/**
 * The step between a report and a payment.
 *
 * Reward weight follows spend a provider has CONFIRMED. An agent's report lands
 * as `pending` and earns nothing; spendInWindow sums only confirmed rows. The
 * call that moves a row from one to the other belongs to whatever runs on a
 * schedule, and this service is the only thing in a deployment that does.
 *
 * These tests exist because that call went missing once and nothing noticed.
 * Every report stayed pending, every window summed to zero, the accrual took
 * its empty-window early return, the root never moved and no transaction was
 * ever sent - with no error, no warning and a green suite, because the suites
 * covering confirmation all handed it a provider and the suite covering the
 * tick faked the ledger. Neither side could see the gap between them. A reward
 * mechanism that pays nothing forever and says nothing about it is the worst
 * failure this service has, so the wiring is asserted here rather than inferred.
 */

import { describe, expect, it } from 'vitest';
import { describeTick } from '../log';
import { ALICE, BOB, ONE_TOKEN, PERIOD_0, atPeriod, harness } from './fakes';

describe('Confirming what agents reported', () => {
  it('confirms before it accrues, never after', async () => {
    // Order, not merely presence - "it was called" is true of the broken order
    // too. Confirmation stamps a row with the instant it ran, so confirming
    // after the accrual writes spend into a window this tick has already closed
    // and paid out: it would wait a full period at best, and at worst land in a
    // window the ledger has already settled at a different figure, which the
    // ledger refuses outright.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.usage.report(ALICE, 3);

    await world.run();

    expect(world.trace).toEqual(['confirm', 'accrue']);
  });

  it('pays a report in the period it was confirmed in, one tick after it arrives', async () => {
    // End to end, through the same runOnce a deployment runs: an agent reports,
    // and the money appears without anybody calling anything by hand. This is
    // the test the missing call failed - ALICE stayed on zero forever.
    //
    // The lag is real and intended. verifiedAt is the confirmation instant, so
    // spend confirmed during an open period is paid when that period closes.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.usage.report(ALICE, 5);

    // Tick one: the report is confirmed into period+1, which is still open.
    await world.run();
    expect(world.rewards.totalFor(ALICE)).toBe(0n);

    // Tick two: that period has closed, and it is settled.
    world.setNow(atPeriod(PERIOD_0 + 2, 20_000));
    await world.run();

    expect(world.rewards.totalFor(ALICE)).toBe(5n * ONE_TOKEN);
  });

  it('confirms once for the whole tick, not once for every period of a catch-up', async () => {
    // Six periods owed after an outage is one backlog of reports, not six. A
    // confirmation per period would put six times the questions on a workspace
    // owner's own OpenRouter rate limit, and every answer after the first would
    // find nothing left pending.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    await world.run();

    world.setNow(atPeriod(PERIOD_0 + 7, 20_000));
    await world.run();

    expect(world.rewards.accrued).toHaveLength(7);
    expect(world.usage.runs).toHaveLength(2);
  });

  it('settles the period anyway when the provider could not be reached', async () => {
    // An outage at OpenRouter must not stop a workspace that confirmed last
    // week from being paid this week. Unconfirmed rows stay pending and the
    // next tick asks again; refusing to settle would hold the cursor still and
    // delay everybody, to protect nothing.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.usage.failNext('getaddrinfo ENOTFOUND openrouter.ai');
    world.rewards.earn(PERIOD_0, BOB, 4);

    const report = await world.run();

    expect(report.verification).toEqual({
      kind: 'failed',
      reason: 'getaddrinfo ENOTFOUND openrouter.ai',
    });
    expect(world.rewards.written).toEqual([PERIOD_0]);
    expect(world.rewards.totalFor(BOB)).toBe(4n * ONE_TOKEN);
    expect(world.state.read()?.lastCompletedPeriod).toBe(PERIOD_0);
  });

  it('keeps the reports it could not confirm, and confirms them on the next tick', async () => {
    // The guarantee that makes swallowing the failure safe: an outage costs a
    // period of delay, never the earnings themselves.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.usage.report(ALICE, 7);
    world.usage.failNext('502 Bad Gateway');

    await world.run();

    world.setNow(atPeriod(PERIOD_0 + 2, 20_000));
    await world.run();
    world.setNow(atPeriod(PERIOD_0 + 3, 20_000));
    await world.run();

    expect(world.rewards.totalFor(ALICE)).toBe(7n * ONE_TOKEN);
  });

  it('confirms in batches the operator sized, and pays what spills into a later one', async () => {
    // Confirming is one HTTP request per report, in series, so a tick asks about
    // a bounded number of them - otherwise a backlog keeps a tick running past
    // the period that should have started the next one. What does not fit is
    // deferred, never dropped: BOB is paid for a later period than ALICE, and
    // both are paid.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.deps.config.usageBatchLimit = 1;
    world.usage.report(ALICE, 4);
    world.usage.report(BOB, 6);

    await world.run();
    world.setNow(atPeriod(PERIOD_0 + 2, 20_000));
    await world.run();
    world.setNow(atPeriod(PERIOD_0 + 3, 20_000));
    await world.run();

    expect(world.usage.runs).toEqual([1, 1, 1]);
    expect(world.rewards.totalFor(ALICE)).toBe(4n * ONE_TOKEN);
    expect(world.rewards.totalFor(BOB)).toBe(6n * ONE_TOKEN);
  });
});

describe('Confirmation in the log', () => {
  it('says nothing at all when there was nothing to confirm', async () => {
    // Most ten-minute windows contain no reports. A line about zero every ten
    // minutes teaches whoever reads these logs to skip them.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });

    const lines = describeTick(await world.run(), false);

    expect(lines.some((line) => line.startsWith('usage:'))).toBe(false);
  });

  it('reports a provider that could not be reached rather than dropping it', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.usage.failNext('401 Unauthorized');

    const lines = describeTick(await world.run(), false);

    expect(lines[0]).toContain('confirming spend failed (401 Unauthorized)');
    expect(lines[0]).toContain('retries');
  });
});
