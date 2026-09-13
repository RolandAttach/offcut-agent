/**
 * Filesystem locations the core owns.
 *
 * Kept in one module because three different things need the same directory —
 * the SQLite file, the deletion ledger and the backup rotation — and having them
 * derive it independently is how they end up disagreeing after a deployment
 * changes one path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where state lives when nobody said.
 *
 * Inside this repository it is `packages/core/.data`, next to the source — which
 * is what makes `pnpm setup` work with no configuration at all.
 *
 * Installed from npm, "next to the source" means inside node_modules, and that
 * is the one place state must never live: the next `npm install` deletes the
 * package directory and every record with it, silently. A memory that vanishes
 * on reinstall is worse than none, because it looked like it was keeping things.
 * So an installed copy defaults to a directory in the user's home instead, which
 * survives reinstalls and is shared by every project on the machine — matching
 * §4, where a workspace is a row in one store rather than a folder per project.
 *
 * Whether we are installed is read from the path itself: nothing else about the
 * runtime differs.
 */
let installedOverride: boolean | null = null;

/** Test hook: pretend to be, or not to be, an installed copy. Pass null to reset. */
export function setInstalledForTests(value: boolean | null): void {
  installedOverride = value;
}

/**
 * Whether this copy of the core was installed from a registry rather than
 * checked out.
 *
 * Read from the path: an installed package lives under a node_modules directory
 * and a checkout does not. Three things hang off the answer - where state
 * lives, whether the generic DATABASE_URL is believed, and whether a .env two
 * directories up is ours to read - so it is decided once, here, and nowhere
 * else re-derives it.
 */
export function isInstalledCopy(): boolean {
  if (installedOverride !== null) return installedOverride;
  return path.resolve(__dirname, '..').split(path.sep).includes('node_modules');
}

function defaultDataDir(): string {
  return isInstalledCopy() ? path.join(os.homedir(), '.offcut') : path.resolve(__dirname, '..', '.data');
}

/**
 * The core's data directory.
 *
 * OFFCUT_DATA_DIR wins, so a deployment can put state on a mounted volume.
 */
export function resolveDataDir(): string {
  const dir = process.env.OFFCUT_DATA_DIR
    ? path.resolve(process.env.OFFCUT_DATA_DIR)
    : defaultDataDir();

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveBackupDir(): string {
  const dir = path.join(resolveDataDir(), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Snapshot retention, in days. OPEN-5, answered: 30.
 *
 * Override with OFFCUT_BACKUP_RETENTION_DAYS. The deletion ledger is explicitly
 * NOT covered by this — it is never pruned, because a restore from the oldest
 * surviving snapshot still has to replay every deletion that ever happened.
 */
export function backupRetentionDays(): number {
  const raw = Number(process.env.OFFCUT_BACKUP_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
}
