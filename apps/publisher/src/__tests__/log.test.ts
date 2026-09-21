/**
 * The line this service leaves behind.
 *
 * It runs unattended and spends money, so months from now the only account of
 * what it did will be these lines. Each has to carry the whole decision -
 * window, points, addresses, amount, and either the transaction or the reason
 * there was not one. A line saying "skipped" with no reason is the line that
 * makes somebody open a database at 2am.
 */

import { describe, expect, it } from 'vitest';
import { describePublish, describeTick, describeVerification } from '../log';
import { ALICE, BOB, ONE_TOKEN, PERIOD_0, atPeriod, harness } from './fakes';

describe('A period in the log', () => {
  it('carries the window, both layers, the addresses and the amount', async () => {
    // UPDATED 2026-09-21. The line used to read "points 4", which was the whole
    // of what a period could pay for. Rewards now pay on two things, and a line
    // naming one of them would be a line that is wrong about the other.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 3);
    world.rewards.earn(PERIOD_0, BOB, 1);

    const [line] = describeTick(await world.run(), false);

    expect(line).toContain(`period ${PERIOD_0}`);
    expect(line).toContain(new Date(atPeriod(PERIOD_0)).toISOString().replace('.000Z', 'Z'));
    // Four points is four millionths of a dollar, rendered exactly.
    expect(line).toContain('spend $0.000004 -> 4.0 OFFCUT');
    expect(line).toContain('addresses 2');
    expect(line).toContain('amount 4.0');
  });

  it('says the memory layer earned nothing rather than leaving it out', async () => {
    // Silence and zero look identical in a log a year old. A period where
    // nobody's memory was used has to say so, or a memory layer that quietly
    // stopped being computed reads exactly like a quiet week.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 3);

    const [line] = describeTick(await world.run(), false);

    expect(line).toContain('memory 0 credits -> 0.0 OFFCUT');
  });

  it('carries what memory earned, beside what spend earned, in one total', async () => {
    // The subscriber's case: somebody who confirms no spend at all and is paid
    // for memory another agent used. The line has to be able to say that.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 4);
    world.rewards.earnMemory(PERIOD_0, BOB, 2);

    const [line] = describeTick(await world.run(), false);

    expect(line).toContain('spend $0.000004 -> 4.0 OFFCUT');
    expect(line).toContain('memory 2 credits -> 2.0 OFFCUT');
    expect(line).toContain('addresses 2');
    expect(line).toContain('amount 6.0');
  });

  it('writes one credit as a credit', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earnMemory(PERIOD_0, ALICE, 1);

    const [line] = describeTick(await world.run(), false);

    expect(line).toContain('memory 1 credit -> 1.0 OFFCUT');
    expect(line).toContain('spend $0.0 -> 0.0 OFFCUT');
  });

  it('renders an amount exactly, never rounded to fit', async () => {
    // A rounded figure in a log is how a shortfall stays invisible. One base
    // unit has to read as one base unit.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.deps.config.reward = { ...world.deps.config.reward, ratePerPoint: 1n };
    world.rewards.earn(PERIOD_0, ALICE, 1);

    const [line] = describeTick(await world.run(), false);

    expect(line).toContain('amount 0.000000000000000001');
  });

  it('says which transaction carried the root', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1);

    const [line] = describeTick(await world.run(), false);

    expect(line).toContain('published root');
    expect(line).toContain(`tx ${world.chain.published.length === 1 ? '0xtx1' : ''}`);
  });

  it('gives a reason every time there is no transaction', async () => {
    // Every branch, because the one without a reason is the one that gets
    // added later and quietly hides a stuck publisher.
    const reasons = [
      describePublish({ kind: 'unchanged', root: `0x${'ab'.repeat(32)}`, rootIndex: 4 }, false),
      describePublish({ kind: 'nothing-earned' }, false),
      describePublish({ kind: 'paused' }, false),
      describePublish({ kind: 'failed', reason: 'insufficient funds for gas' }, false),
    ];

    for (const reason of reasons) {
      expect(reason).toMatch(/^no transaction: \S/);
    }
    expect(reasons[3]).toContain('insufficient funds for gas');
  });

  it('marks a dry run so a rehearsal never reads as a real publication', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000), dryRun: true });
    world.rewards.earn(PERIOD_0, ALICE, 1);

    const [line] = describeTick(await world.run(), true);

    expect(line).toContain('DRY RUN');
    expect(line).not.toContain('tx ');
  });

  it('explains what the accrual left undistributed, beside the period it belongs to', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 2);

    const lines = describeTick(await world.run(), false);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toContain(`period ${PERIOD_0}:`);
    expect(lines[1]).toContain('stay in the contract');
  });

  it('still says something when a tick found no closed period', () => {
    const quiet = { kind: 'settled', verified: 0, rejected: 0, deferred: 0 } as const;
    expect(describeTick({ verification: quiet, periods: [], publish: { kind: 'nothing-earned' } }, false)).toEqual([
      'no closed period to settle | no transaction: nothing has been earned yet, so there is no root to publish',
    ]);
  });

  it('writes one line for every period of a catch-up, not one for the batch', async () => {
    // Five silent periods and a single summary line would hide which of them
    // paid what.
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    await world.run();
    for (const offset of [1, 2, 3, 4, 5]) world.rewards.earn(PERIOD_0 + offset, ALICE, 1);

    world.setNow(atPeriod(PERIOD_0 + 6, 20_000));
    const lines = describeTick(await world.run(), false).filter((line) => line.startsWith('period '));

    expect(lines).toHaveLength(5);
    expect(lines.every((line) => line.includes('published root'))).toBe(true);
  });
});

describe('Amounts in base units', () => {
  it('never loses a digit of a whole-token figure', async () => {
    const world = harness({ now: atPeriod(PERIOD_0 + 1, 20_000) });
    world.rewards.earn(PERIOD_0, ALICE, 1234);

    const report = await world.run();

    expect(report.periods[0]?.amount).toBe(1234n * ONE_TOKEN);
    expect(describeTick(report, false)[0]).toContain('amount 1234.0');
  });
});

describe('Confirmation in the log', () => {
  it('names reports that are still unconfirmed, because they are earning nothing', () => {
    // The symptom of a revoked key, or of a provider that has stopped answering
    // this server, is a backlog that never clears - and from the outside that
    // looks exactly like a quiet period with nothing to pay. Folded into the
    // other counts it would stay invisible for a month, which is how the
    // publisher came to pay nothing at all without anybody noticing.
    const line = describeVerification({ kind: 'settled', verified: 2, rejected: 1, deferred: 17 });

    expect(line).toContain('2 confirmed');
    expect(line).toContain('1 rejected by the provider');
    expect(line).toContain('17 still unconfirmed and earning nothing');
  });

  it('says nothing at all when there was nothing to confirm', () => {
    // Most ten-minute windows contain no reports. A line about zero every ten
    // minutes teaches whoever reads these logs to skip them.
    expect(describeVerification({ kind: 'settled', verified: 0, rejected: 0, deferred: 0 })).toBeNull();
  });

  it('gives the reason when the provider could not be asked at all', () => {
    const line = describeVerification({ kind: 'failed', reason: '401 Unauthorized' });

    expect(line).toContain('401 Unauthorized');
    expect(line).toContain('retries');
  });
});
