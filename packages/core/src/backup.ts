/**
 * Backups and restoration (OPEN-5, answered: 30-day retention).
 *
 * Snapshots are JSON rather than a copy of the SQLite file, for two reasons:
 * a file copy taken while the database is being written is not guaranteed to be
 * consistent, and a JSON dump survives the move to PostgreSQL that `pnpm
 * use:postgres` makes possible.
 *
 * The part that matters is restoration. A naive restore resurrects records the
 * owner deleted after the snapshot was taken, which invariant 7 forbids
 * outright. So restore is two steps, always:
 *
 *   1. load the snapshot
 *   2. replay every deletion the ledger recorded AFTER the snapshot's timestamp
 *
 * Step 2 is not optional and there is no flag to skip it. A deletion that has
 * been acknowledged stays done.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getPrisma } from './db';
import { errors } from './errors';
import { backupRetentionDays, resolveBackupDir } from './paths';
import { deletionsSince, readLedger, type LedgerEntry } from './ledger';

export const BACKUP_FORMAT = 'offcut.backup.v1';

/**
 * Insert order. Parents first, so foreign keys resolve on the way in; the
 * reverse is used to clear the database on the way out.
 *
 * `memoryRecord.previousVersionId` is a plain column rather than a declared
 * relation, so a lineage can be inserted in any internal order without the
 * self-reference failing.
 *
 * spent_siwe_nonces is missing on purpose and must stay missing. A snapshot has
 * no reason to carry which sign-in nonces were used, and restoring one would
 * clear the table below and put back a list from the past - handing anyone
 * holding a captured sign-in the replay that table exists to refuse. Leaving it
 * out means a restore can only ever leave a nonce spent.
 */
const TABLES = [
  'user',
  'workspace',
  'agent',
  'memoryRecord',
  'recordLink',
  'mergedBlock',
  'mergedBlockSource',
  'conflict',
  'conflictSide',
  'idempotencyEntry',
  'searchDoc',
  'recallCacheEntry',
  'auditEvent',
  'deletionLedgerEntry',
] as const;

type TableName = (typeof TABLES)[number];

/**
 * Prisma's per-model delegates are each strongly typed, so indexing the client
 * by a variable name cannot be checked statically. This narrows once, in one
 * place, to the three methods the backup path uses — rather than scattering
 * casts through the file.
 */
interface TableDelegate {
  findMany(): Promise<Record<string, unknown>[]>;
  deleteMany(): Promise<unknown>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

function table(name: TableName): TableDelegate {
  return getPrisma()[name] as unknown as TableDelegate;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  /** When the snapshot was taken. Restore replays deletions recorded after it. */
  takenAt: string;
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
}

export interface BackupSummary {
  file: string;
  takenAt: string;
  sizeBytes: number;
  counts: Record<string, number>;
  ageDays: number;
}

// ---------------------------------------------------------------------------
// Date handling
// ---------------------------------------------------------------------------

/**
 * JSON has no date type, so timestamps come back as strings and Prisma rejects
 * them. Every DateTime column in schema.prisma ends in `At` — createdAt,
 * deletedAt, revokedAt, resolvedAt and so on — which makes the rule mechanical
 * rather than a hand-maintained list that drifts when a column is added.
 */
function reviveDates(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith('At') && typeof value === 'string' && value.length > 0) {
      const parsed = new Date(value);
      out[key] = Number.isNaN(parsed.getTime()) ? value : parsed;
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createBackup(
  options: { label?: string } = {}
): Promise<{ file: string; takenAt: string; counts: Record<string, number>; pruned: string[] }> {
  const db = getPrisma();
  const takenAt = new Date();

  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const name of TABLES) {
    const rows = await table(name).findMany();
    tables[name] = rows;
    counts[name] = rows.length;
  }

  const payload: BackupFile = {
    format: BACKUP_FORMAT,
    takenAt: takenAt.toISOString(),
    counts,
    tables,
  };

  const stamp = takenAt.toISOString().replace(/[:.]/g, '-');
  const suffix = options.label ? `-${options.label.replace(/[^a-zA-Z0-9-]/g, '')}` : '';
  const file = path.join(resolveBackupDir(), `offcut-${stamp}${suffix}.json`);

  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');

  const pruned = pruneBackups();
  return { file, takenAt: payload.takenAt, counts, pruned };
}

// ---------------------------------------------------------------------------
// List and prune
// ---------------------------------------------------------------------------

export function listBackups(): BackupSummary[] {
  const dir = resolveBackupDir();
  const now = Date.now();

  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('offcut-') && name.endsWith('.json'))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);

      let takenAt = stat.mtime.toISOString();
      let counts: Record<string, number> = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as BackupFile;
        if (parsed.takenAt) takenAt = parsed.takenAt;
        if (parsed.counts) counts = parsed.counts;
      } catch {
        // A snapshot that cannot be parsed is still listed, so it can be seen
        // and removed rather than silently ignored.
      }

      return {
        file: full,
        takenAt,
        sizeBytes: stat.size,
        counts,
        ageDays: Math.floor((now - new Date(takenAt).getTime()) / 86_400_000),
      };
    })
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}

/**
 * Deletes snapshots past the retention window.
 *
 * The deletion ledger is deliberately untouched: it is tiny, holds no content,
 * and a restore from the oldest surviving snapshot still has to replay every
 * deletion that ever happened. Pruning it would reintroduce exactly the bug the
 * ledger exists to prevent.
 */
export function pruneBackups(): string[] {
  const retention = backupRetentionDays();
  const removed: string[] = [];

  for (const backup of listBackups()) {
    if (backup.ageDays <= retention) continue;
    try {
      fs.rmSync(backup.file);
      removed.push(backup.file);
    } catch {
      // A locked file is retried on the next run rather than failing the backup.
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Replays one deletion, doing everything forget() does.
 *
 * Written to be idempotent: replaying a deletion whose record is already gone,
 * or was never in the snapshot, is a no-op rather than an error. Restores get
 * run twice by nervous operators, and that must be safe.
 */
async function replayDeletion(entry: LedgerEntry): Promise<boolean> {
  const db = getPrisma();

  const rows = await db.memoryRecord.findMany({
    where: { workspaceId: entry.workspaceId, recordId: entry.recordId },
  });
  if (rows.length === 0) return false;

  const rowIds = rows.map((row) => row.id);
  const deletedAt = new Date(entry.deletedAt);

  await db.memoryRecord.updateMany({
    where: { id: { in: rowIds } },
    data: entry.purged
      ? {
          deletedAt,
          deletedBy: entry.deletedBy,
          purged: true,
          isCurrent: false,
          text: '',
          topic: '',
          source: '',
          factKey: null,
          factValue: null,
          claimedAuthor: null,
          contentHash: '',
        }
      : { deletedAt, deletedBy: entry.deletedBy, isCurrent: false },
  });

  // The search index, or the record returns through search.
  await db.searchDoc.deleteMany({ where: { recordRowId: { in: rowIds } } });

  // Derived blocks are removed outright: a stale block still holds the text.
  const dependent = await db.mergedBlockSource.findMany({
    where: { recordId: entry.recordId, block: { workspaceId: entry.workspaceId } },
    select: { blockId: true },
  });
  const blockIds = [...new Set(dependent.map((row) => row.blockId))];
  if (blockIds.length > 0) {
    await db.mergedBlock.deleteMany({ where: { id: { in: blockIds } } });
  }

  await db.conflictSide.deleteMany({ where: { recordRowId: { in: rowIds } } });

  // A conflict needs two competing values to still be a conflict.
  const touched = await db.conflict.findMany({
    where: { workspaceId: entry.workspaceId },
    include: { sides: true },
  });
  for (const conflict of touched) {
    const distinct = new Set(conflict.sides.map((side) => side.value.trim().toLowerCase()));
    if (conflict.sides.length < 2 || distinct.size < 2) {
      await db.conflict.delete({ where: { id: conflict.id } }).catch(() => undefined);
    }
  }

  await db.recallCacheEntry.updateMany({
    where: { workspaceId: entry.workspaceId, invalidatedAt: null },
    data: { invalidatedAt: new Date() },
  });

  return true;
}

export interface RestoreReport {
  file: string;
  takenAt: string;
  restored: Record<string, number>;
  /** Deletions recorded after the snapshot and replayed on top of it. */
  deletionsReplayed: number;
  /** Of those, the ones that actually matched a record present in the snapshot. */
  deletionsApplied: number;
}

/**
 * Replaces the current database with a snapshot, then replays later deletions.
 *
 * Destructive and deliberately so — a partial restore would leave the store in a
 * state that never existed. The caller is expected to have confirmed.
 */
export async function restoreBackup(file: string): Promise<RestoreReport> {
  if (!fs.existsSync(file)) throw errors.notFound(`Backup file ${file}`);

  const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupFile;

  if (payload.format !== BACKUP_FORMAT) {
    throw errors.validation(
      `Unrecognised backup format "${payload.format}". Expected ${BACKUP_FORMAT}.`
    );
  }

  const db = getPrisma();

  // Clear in reverse dependency order so foreign keys never block a delete.
  for (const name of [...TABLES].reverse()) {
    await table(name).deleteMany();
  }

  const restored: Record<string, number> = {};

  for (const name of TABLES) {
    const rows = (payload.tables[name] ?? []) as Record<string, unknown>[];
    restored[name] = rows.length;
    if (rows.length === 0) continue;

    // One row at a time: createMany is faster but skips rows that trip a
    // constraint, and a silently incomplete restore is worse than a slow one.
    for (const row of rows) {
      await table(name).create({ data: reviveDates(row) });
    }
  }

  // --- The step that keeps invariant 7 true across a restore --------------
  const later = deletionsSince(payload.takenAt);
  let applied = 0;
  for (const entry of later) {
    if (await replayDeletion(entry)) applied += 1;
  }

  return {
    file,
    takenAt: payload.takenAt,
    restored,
    deletionsReplayed: later.length,
    deletionsApplied: applied,
  };
}

/** Diagnostics for the console and the CLI. */
export function ledgerStats(): { entries: number; oldest: string | null; newest: string | null } {
  const entries = readLedger();
  if (entries.length === 0) return { entries: 0, oldest: null, newest: null };

  const sorted = [...entries].sort((a, b) => a.deletedAt.localeCompare(b.deletedAt));
  return {
    entries: entries.length,
    oldest: sorted[0]!.deletedAt,
    newest: sorted[sorted.length - 1]!.deletedAt,
  };
}
