/**
 * The deletion ledger's file mirror (OPEN-5).
 *
 * The problem this exists to solve:
 *
 *   Monday    record R is written
 *   Tuesday   a backup is taken — the snapshot contains R
 *   Wednesday the owner deletes R, and it is purged everywhere
 *   Thursday  the database is lost and Tuesday's snapshot is restored
 *
 * Without a ledger, R comes back. Invariant 7 says a deleted record must not
 * return "through the service's search, export, cache or dependent summaries",
 * and a restore that resurrects it breaks exactly that promise. SS3.5 is why
 * OPEN-5 asks for "backup cleanup timing AND restoration without resurrecting
 * deleted data" in the same breath.
 *
 * So deletions are recorded twice: in the database (transactionally, alongside
 * the deletion itself) and appended to this file, which lives OUTSIDE the
 * snapshot rotation and is never pruned. Restore replays every entry recorded
 * after the snapshot was taken.
 *
 * The file records identity only — workspace, record id, timestamp, who. Never
 * content. A ledger that remembered what a record said would defeat its purpose,
 * and would become the one place a purge could not reach.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './paths';

export interface LedgerEntry {
  workspaceId: string;
  recordId: string;
  rowIds: string[];
  purged: boolean;
  deletedBy: string;
  reason: string;
  /** ISO timestamp. */
  deletedAt: string;
}

export function ledgerPath(): string {
  return path.join(resolveDataDir(), 'deletions.jsonl');
}

/**
 * Appends entries. Best-effort by design: a failure here must never turn a
 * successful deletion into an error, because the deletion has already committed
 * and the database ledger row is the authoritative copy. A warning is emitted
 * instead, since a silently missing mirror would only be discovered during a
 * restore - the worst possible moment.
 */
export function appendDeletions(entries: LedgerEntry[]): void {
  if (entries.length === 0) return;

  try {
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const lines = entries.map((entry) => JSON.stringify(entry)).join('\n');
    fs.appendFileSync(file, `${lines}\n`, 'utf8');
  } catch (error) {
    console.warn(
      `[offcut] could not append to the deletion ledger at ${ledgerPath()}. ` +
        `Deletions are still recorded in the database, but a restore from an older ` +
        `snapshot may not replay them. Cause: ${
          error instanceof Error ? error.message : String(error)
        }`
    );
  }
}

/** Reads the whole ledger. Malformed lines are skipped, not fatal. */
export function readLedger(): LedgerEntry[] {
  const file = ledgerPath();
  if (!fs.existsSync(file)) return [];

  const out: LedgerEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as LedgerEntry;
      if (entry.recordId && entry.workspaceId && entry.deletedAt) out.push(entry);
    } catch {
      // One corrupt line must not make the rest of the ledger unreadable.
    }
  }
  return out;
}

/** Entries recorded strictly after the given moment. */
export function deletionsSince(isoTimestamp: string): LedgerEntry[] {
  const cutoff = new Date(isoTimestamp).getTime();
  return readLedger().filter((entry) => new Date(entry.deletedAt).getTime() > cutoff);
}
