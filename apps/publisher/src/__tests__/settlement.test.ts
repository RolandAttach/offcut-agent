/**
 * Restarting, and what a restart must never cost.
 *
 * This service is going to be killed mid-period. It will be redeployed, it will
 * run out of memory, the machine will reboot while a transaction is in flight.
 * Two things have to survive all of that: no ten minutes is ever settled twice,
 * and no ten minutes is ever jumped over.
 *
 * Each test below is a different moment to pull the plug.
 */

import { describe, expect, it } from 'vitest';
import {
  ALICE,
  BOB,
  ONE_TOKEN,
  PERIOD_0,
  PERIOD_MS,
  atPeriod,
  harness,
} from './fakes';

describe('Settling a period', () => {
  it('settles the period that just closed, and only that one, on a first start', () => {
    // Nothing else, because the credits table may hold months of history and a
    // first start that walked back through it would emit a day's ceiling for
    // every day at once - the opposite of a fixed pool.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 3);
    world.rewards.earn(PERIOD_0 - 1, BOB, 99);

    return world.run().then(() => {
      expect(world.rewards.written).toEqual([PERIOD_0]);
      expect(world.rewards.totalFor(ALICE)).toBe(3n * ONE_TOKEN);
      expect(world.rewards.totalFor(BOB)).toBe(0n);
    });
  });

  it('settles a period once however many times the service restarts inside it', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 5);

    await world.run();

    // Three more starts inside the same period. Each reads the same cursor,
    // finds nothing closed since, and does nothing.
    world.setNow(atPeriod(PERIOD_0 + 1, 120_000));
    await world.run();
    world.setNow(atPeriod(PERIOD_0 + 1, 400_000));
    await world.run();

    expect(world.rewards.written).toEqual([PERIOD_0]);
    expect(world.rewards.totalFor(ALICE)).toBe(5n * ONE_TOKEN);
  });

  it('does not pay twice when the cursor never reached the disk', async () => {
    // The crash this is really about: the ledger accepted the period and the
    // process died before the cursor recording it was written. On restart the
    // period looks owed, is settled again, and the ledger - not this service -
    // is what makes that harmless. If either side of that stopped being true,
    // ALICE would hold ten tokens here instead of five.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 5);

    world.state.losesWritesFromNowOn();
    await world.run();

    expect(world.rewards.totalFor(ALICE)).toBe(5n * ONE_TOKEN);
    expect(world.state.read()).toBeNull();

    // Restart: same ledger, no cursor.
    const report = await world.run();

    expect(world.rewards.totalFor(ALICE)).toBe(5n * ONE_TOKEN);
    expect(world.rewards.accrued).toEqual([PERIOD_0, PERIOD_0]);
    expect(world.rewards.written).toEqual([PERIOD_0]);
    expect(report.periods[0]?.replayed).toBe(true);
  });

  it('says in the log that a period was already in the ledger', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 2);

    world.state.losesWritesFromNowOn();
    await world.run();
    const report = await world.run();

    // A replay that looks identical to a first run in the log is a replay
    // nobody notices the day it starts happening every ten minutes.
    expect(report.periods[0]?.notes.join(' ')).toContain('already in the ledger');
  });
});

describe('Coming back from downtime', () => {
  it('settles every period missed while it was down, oldest first, none skipped', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);
    await world.run();

    for (const offset of [1, 2, 3, 4, 5]) world.rewards.earn(PERIOD_0 + offset, ALICE, 1);

    // Down for an hour.
    world.setNow(atPeriod(PERIOD_0 + 6, 20_000));
    const report = await world.run();

    expect(world.rewards.written).toEqual([PERIOD_0, PERIOD_0 + 1, PERIOD_0 + 2, PERIOD_0 + 3, PERIOD_0 + 4, PERIOD_0 + 5]);
    expect(report.periods.map((outcome) => outcome.period)).toEqual([
      PERIOD_0 + 1,
      PERIOD_0 + 2,
      PERIOD_0 + 3,
      PERIOD_0 + 4,
      PERIOD_0 + 5,
    ]);
    expect(world.rewards.totalFor(ALICE)).toBe(6n * ONE_TOKEN);
  });

  it('pays one transaction for a catch-up, not one per period', async () => {
    // Roots are cumulative, so the root published after the sixth period
    // already says everything the five before it would have said. One
    // transaction per missed period would be six times the gas for one
    // statement.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    for (const offset of [0, 1, 2, 3, 4, 5]) world.rewards.earn(PERIOD_0 + offset, ALICE, 1);

    await world.run();
    const before = world.chain.published.length;

    world.setNow(atPeriod(PERIOD_0 + 6, 20_000));
    const report = await world.run();

    expect(report.periods).toHaveLength(5);
    expect(world.rewards.written).toHaveLength(6);
    expect(world.chain.published.length - before).toBe(1);
  });

  it('leaves no gap between the period before the outage and the one after it', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    await world.run();

    world.setNow(atPeriod(PERIOD_0 + 4, 20_000));
    await world.run();

    const asked = world.rewards.accrued;
    for (let i = 1; i < asked.length; i += 1) {
      // Consecutive indexes, which is the same statement as consecutive windows
      // with no gap and no overlap - see periods.test.ts.
      expect(asked[i]).toBe(asked[i - 1]! + 1);
    }
    expect(asked[asked.length - 1]).toBe(PERIOD_0 + 3);
  });

  it('carries on from the cursor rather than from now, after a long outage', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    await world.run();

    // A week. The point is that the first period settled after the outage is
    // the one immediately after the cursor, not the one before now.
    world.setNow(atPeriod(PERIOD_0 + 1008, 20_000));
    const report = await world.run();

    expect(report.periods[0]?.period).toBe(PERIOD_0 + 1);
    expect(report.periods).toHaveLength(1007);
    expect(report.periods[report.periods.length - 1]?.period).toBe(PERIOD_0 + 1007);
  });
});

describe('The cursor itself', () => {
  it('records the last settled period, never one ahead of the ledger', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);

    await world.run();

    // toMatchObject, not toEqual: the cursor file also carries the root last seen
    // on chain, which is not what this test is about.
    expect(world.state.read()).toMatchObject({ lastCompletedPeriod: PERIOD_0 });
    expect(world.rewards.written).toEqual([PERIOD_0]);
  });

  it('is written on a first start before any period is settled', async () => {
    // Otherwise a crash during the very first tick would recompute the starting
    // point from a later clock, and everything in between is never paid.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.deps.rewards.accrueWindow = () => {
      throw new Error('killed mid-tick');
    };

    await expect(world.run()).rejects.toThrow('killed mid-tick');
    expect(world.state.read()).toEqual({ lastCompletedPeriod: PERIOD_0 - 1 });
  });

  it('does not advance past a period the ledger refused', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 2, 20_000) });
    await world.run();
    const cursor = world.state.read();

    world.deps.rewards.recordAccruals = () => {
      throw new Error('This period is already settled at a different figure.');
    };
    world.rewards.earn(PERIOD_0 + 2, ALICE, 1);
    world.setNow(atPeriod(PERIOD_0 + 3, 20_000));

    await expect(world.run()).rejects.toThrow('already settled at a different figure');
    // The tick failed loudly and the cursor stayed put, so the next one asks
    // the same question rather than stepping over it.
    expect(world.state.read()).toEqual(cursor);
  });
});

describe('A cursor that cannot be trusted', () => {
  it('refuses to start rather than treating an unreadable cursor as a fresh one', async () => {
    // Silently starting over would jump the service forward to now and never
    // pay whatever sat between - invisible, and unrecoverable once the window
    // has passed.
    const { fileStateStore } = await import('../state');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offcut-publisher-'));
    const file = path.join(dir, 'publisher.json');
    fs.writeFileSync(file, '{ this is not json');

    expect(() => fileStateStore(file).read()).toThrow(/not a publisher cursor/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives a round trip through the disk', async () => {
    const { fileStateStore } = await import('../state');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offcut-publisher-'));
    const store = fileStateStore(path.join(dir, 'nested', 'publisher.json'));

    expect(store.read()).toBeNull();
    store.write({ lastCompletedPeriod: PERIOD_0 });
    expect(store.read()).toEqual({ lastCompletedPeriod: PERIOD_0 });

    store.write({ lastCompletedPeriod: PERIOD_0 + 1 });
    expect(store.read()).toEqual({ lastCompletedPeriod: PERIOD_0 + 1 });

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Periods and the clock', () => {
  it('settles the window the credits were actually written in', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 4);

    const report = await world.run();
    const outcome = report.periods[0]!;

    expect(outcome.since.getTime()).toBe(PERIOD_0 * PERIOD_MS);
    expect(outcome.until.getTime()).toBe((PERIOD_0 + 1) * PERIOD_MS);
    expect(outcome.points).toBe(4);
    expect(outcome.amount).toBe(4n * ONE_TOKEN);
  });
});
