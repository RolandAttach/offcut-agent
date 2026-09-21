/**
 * One line per period, and the reason there was no transaction.
 *
 * This service runs unattended and spends money. Six months from now the only
 * evidence of what it did will be these lines, so each carries the whole
 * decision: which window, what went in ON BOTH LAYERS, what came out, and
 * either the transaction or the reason there was not one. "Skipped" with no
 * reason is the line that makes somebody open a database at 2am.
 *
 * Amounts are rendered exactly. formatUnits does not round - it moves the
 * decimal point - so a line reading 12.5 means 12.5 and one reading
 * 0.000000000000000001 means a single base unit. Nothing here shortens a number
 * to fit; a rounded amount in a log is how a shortfall stays invisible.
 */

import { formatUnits } from 'ethers';
import { TOKEN_DECIMALS } from '@offcut/rewards';
import type {
  Logger,
  PeriodOutcome,
  PublishOutcome,
  TickReport,
  VerificationOutcome,
} from './service';

const PREFIX = 'offcut-publisher';

export const consoleLogger: Logger = {
  info: (line) => console.log(`[${PREFIX}] ${line}`),
  warn: (line) => console.warn(`[${PREFIX}] ${line}`),
  error: (line) => console.error(`[${PREFIX}] ${line}`),
};

function windowOf(outcome: PeriodOutcome): string {
  const since = outcome.since.toISOString().replace('.000Z', 'Z');
  const until = outcome.until.toISOString().slice(11, 16);
  return `${since} -> ${until}`;
}

/**
 * Confirmed spend, in dollars, exactly.
 *
 * A point is an integer millionth of a dollar, so this moves the decimal point
 * six places and rounds nothing: $0.000004 is four points and reads back as
 * four. Rendering dollars rather than points because dollars are what an
 * operator reconciles against a provider's invoice, and the integer is
 * recoverable from this either way.
 */
function dollars(points: number): string {
  return formatUnits(BigInt(points), 6);
}

/** An amount of $OFFCUT, in whole tokens, also exactly. */
function tokens(amount: bigint): string {
  return formatUnits(amount, TOKEN_DECIMALS);
}

/** Long enough to identify a root in a log, short enough to sit on one line. */
function shortRoot(root: string): string {
  return `${root.slice(0, 10)}..${root.slice(-6)}`;
}

export function describePublish(outcome: PublishOutcome, dryRun: boolean): string {
  switch (outcome.kind) {
    case 'published':
      return dryRun
        ? `DRY RUN: would publish root ${shortRoot(outcome.root)} as index ${outcome.rootIndex}, ${outcome.holders} addresses`
        : `published root ${shortRoot(outcome.root)} as index ${outcome.rootIndex}, ${outcome.holders} addresses, tx ${outcome.hash}`;
    case 'unchanged':
      return `no transaction: root ${shortRoot(outcome.root)} (index ${outcome.rootIndex}) is already on chain`;
    case 'nothing-earned':
      return 'no transaction: nothing has been earned yet, so there is no root to publish';
    case 'paused':
      return 'no transaction: the contract is paused; roots resume when the owner unpauses';
    case 'failed':
      return `no transaction: publishing failed (${outcome.reason}). The next period publishes a root that supersedes this one.`;
  }
}

/**
 * What confirming reports did, or null when there was nothing to confirm.
 *
 * Null rather than a line saying zero, because most ten-minute windows contain
 * no reports and a service that prints a line about nothing teaches whoever
 * reads these logs to skip them.
 *
 * Deferred reports are always named. A report that cannot be confirmed earns
 * nothing, and a backlog that never clears - a revoked key, a provider refusing
 * this server - looks exactly like quiet hours from the outside. It is the one
 * number here that is a symptom, so it is never folded into the others.
 */
export function describeVerification(outcome: VerificationOutcome): string | null {
  if (outcome.kind === 'failed') {
    return `confirming spend failed (${outcome.reason}). Reports stay pending; the next period retries them.`;
  }

  const { verified, rejected, deferred } = outcome;
  if (verified + rejected + deferred === 0) return null;

  const parts = [`${verified} confirmed`];
  if (rejected > 0) parts.push(`${rejected} rejected by the provider`);
  if (deferred > 0) parts.push(`${deferred} still unconfirmed and earning nothing`);
  return `usage: ${parts.join(', ')}`;
}

/**
 * The tick, as lines.
 *
 * Returned rather than printed so the wording can be asserted in a test without
 * capturing stdout, and so a caller that wants them somewhere other than a
 * console has them already formed.
 */
export function describeTick(report: TickReport, dryRun: boolean): string[] {
  const publish = describePublish(report.publish, dryRun);
  const confirmed = describeVerification(report.verification);
  // Its own line, ahead of the periods: it happened before them, and it is the
  // reason they have anything in them at all.
  const lead = confirmed ? [confirmed] : [];

  if (report.periods.length === 0) {
    // Nothing had closed since the last tick. Reachable when the timer fires
    // early, or when a period length changed under a running service.
    return [...lead, `no closed period to settle | ${publish}`];
  }

  return lead.concat(report.periods.flatMap((outcome) => {
    // BOTH LAYERS, ALWAYS, even when one of them earned nothing. Rewards have
    // paid on two things since 2026-09-21 - confirmed AI spend, and memory
    // another agent used - and a line that printed only the layer that moved
    // would leave "memory earned nothing this period" and "memory was never
    // computed" looking identical six months from now. The totals that follow
    // are the two added.
    const credits = outcome.memory.credits;
    const line =
      `period ${outcome.period}  ${windowOf(outcome)}  ` +
      `spend $${dollars(outcome.spend.points)} -> ${tokens(outcome.spend.amount)} OFFCUT, ` +
      `memory ${credits} ${credits === 1 ? 'credit' : 'credits'} -> ${tokens(outcome.memory.amount)} OFFCUT  ` +
      `addresses ${outcome.addresses}  ` +
      `amount ${tokens(outcome.amount)}  ` +
      `unpaid workspaces ${outcome.skipped}${outcome.replayed ? '  replayed' : ''}  | ${publish}`;

    // Notes are the accrual explaining itself - a workspace held at its cap, an
    // owner with no wallet linked. They belong next to the period they describe.
    return [line, ...outcome.notes.map((note) => `  period ${outcome.period}: ${note}`)];
  }));
}

export function logTick(log: Logger, report: TickReport, dryRun: boolean): void {
  const failed = report.publish.kind === 'failed' || report.verification.kind === 'failed';
  const write = failed ? log.error : log.info;
  for (const line of describeTick(report, dryRun)) write(line);
}
