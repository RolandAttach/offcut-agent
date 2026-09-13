#!/usr/bin/env node
/**
 * Backup CLI.
 *
 *   offcut-backup create           take a snapshot and prune expired ones
 *   offcut-backup list             show snapshots and ledger state
 *   offcut-backup prune            prune only
 *   offcut-backup restore <file>   restore, then replay later deletions
 *
 * Inside the repository the same four are `pnpm backup`, `pnpm backup:list`,
 * `pnpm backup:prune` and `pnpm backup:restore <file>`.
 *
 * Restore is destructive and asks for confirmation unless --yes is passed, so a
 * mistyped filename cannot quietly replace a live workspace.
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  backupRetentionDays,
  createBackup,
  disconnectPrisma,
  ledgerPath,
  ledgerStats,
  listBackups,
  pruneBackups,
  resolveBackupDir,
  restoreBackup,
} from '../index';

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${question} (type "yes") `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const [command = 'create', ...rest] = process.argv.slice(2);

  switch (command) {
    case 'create': {
      const result = await createBackup();
      const total = Object.values(result.counts).reduce((sum, n) => sum + n, 0);

      console.log('');
      console.log('  Snapshot written');
      console.log(`  ${result.file}`);
      console.log(`  ${total} rows across ${Object.keys(result.counts).length} tables`);

      if (result.pruned.length > 0) {
        console.log('');
        console.log(`  Pruned ${result.pruned.length} snapshot(s) older than ${backupRetentionDays()} days`);
      }
      console.log('');
      break;
    }

    case 'list': {
      const backups = listBackups();
      const ledger = ledgerStats();

      console.log('');
      console.log(`  Snapshots in ${resolveBackupDir()}`);
      console.log(`  Retention: ${backupRetentionDays()} days`);
      console.log('');

      if (backups.length === 0) {
        console.log('  (none yet — run: offcut-backup create)');
      } else {
        for (const backup of backups) {
          const records = backup.counts.memoryRecord ?? 0;
          console.log(
            `  ${backup.takenAt}   ${human(backup.sizeBytes).padStart(9)}   ${String(records).padStart(5)} records   ${backup.ageDays}d old`
          );
        }
      }

      console.log('');
      console.log('  Deletion ledger (never pruned — it is what stops a restore');
      console.log('  from resurrecting deleted records):');
      console.log(`  ${ledgerPath()}`);
      console.log(
        `  ${ledger.entries} entries` +
          (ledger.oldest ? `, from ${ledger.oldest} to ${ledger.newest}` : '')
      );
      console.log('');
      break;
    }

    case 'prune': {
      const removed = pruneBackups();
      console.log('');
      console.log(
        removed.length === 0
          ? `  Nothing older than ${backupRetentionDays()} days.`
          : `  Removed ${removed.length} snapshot(s) older than ${backupRetentionDays()} days.`
      );
      for (const file of removed) console.log(`    ${file}`);
      console.log('');
      break;
    }

    case 'restore': {
      const file = rest.find((argument) => !argument.startsWith('--'));
      const skipPrompt = rest.includes('--yes');

      if (!file) {
        console.error('Usage: offcut-backup restore <file> [--yes]');
        process.exitCode = 1;
        return;
      }

      if (!skipPrompt) {
        console.log('');
        console.log('  This REPLACES every record, agent and workspace in the current');
        console.log('  database with the contents of the snapshot.');
        console.log('');
        console.log('  Deletions recorded after the snapshot was taken will be replayed');
        console.log('  afterwards, so nothing you deleted comes back.');
        console.log('');

        if (!(await confirm('  Continue?'))) {
          console.log('  Cancelled.');
          return;
        }
      }

      const report = await restoreBackup(file);
      const total = Object.values(report.restored).reduce((sum, n) => sum + n, 0);

      console.log('');
      console.log('  Restored');
      console.log(`  snapshot taken   ${report.takenAt}`);
      console.log(`  rows restored    ${total}`);
      console.log(`  deletions after  ${report.deletionsReplayed} in the ledger`);
      console.log(`  replayed         ${report.deletionsApplied} matched a restored record`);
      console.log('');
      break;
    }

    default:
      console.error(`Unknown command "${command}". Use: create | list | prune | restore`);
      process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('Backup command failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
