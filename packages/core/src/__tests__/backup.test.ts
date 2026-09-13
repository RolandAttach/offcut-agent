/**
 * Backups and restoration (OPEN-5, answered: 30 days).
 *
 * The test that matters is the resurrection scenario. Everything else here is
 * housekeeping; that one is an invariant.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createBackup, listBackups, pruneBackups, restoreBackup } from '../backup';
import { ledgerPath, readLedger } from '../ledger';
import { backupRetentionDays, resolveBackupDir } from '../paths';
import { getPrisma } from '../db';
import { key, makeAgent, makeWorkspace, seedEndToEndScenario } from './helpers';

/**
 * Backups and the ledger are written to a throwaway directory, so a test run
 * never touches the developer's real snapshots. DATABASE_URL is set separately
 * by vitest.config.ts, so the database location is unaffected by this.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offcut-backup-test-'));
process.env.OFFCUT_DATA_DIR = dataDir;

beforeEach(() => {
  // Each test starts with an empty rotation AND an empty ledger; otherwise a
  // deletion from a previous test would replay into this one's restore.
  for (const target of [resolveBackupDir(), ledgerPath()]) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('Snapshots', () => {
  it('captures every table and reports what it wrote', async () => {
    const workspace = await makeWorkspace();
    await seedEndToEndScenario(workspace);

    const result = await createBackup();

    expect(fs.existsSync(result.file)).toBe(true);
    expect(result.counts.memoryRecord).toBe(3);
    expect(result.counts.workspace).toBe(1);
    expect(result.counts.agent).toBeGreaterThan(0);

    const parsed = JSON.parse(fs.readFileSync(result.file, 'utf8'));
    expect(parsed.format).toBe('offcut.backup.v1');
    expect(parsed.takenAt).toBeTruthy();
  });

  it('restores a workspace that was wiped', async () => {
    const workspace = await makeWorkspace();
    const { researcher } = await seedEndToEndScenario(workspace);

    const backup = await createBackup();

    // Simulate total loss.
    await getPrisma().workspace.deleteMany();
    await getPrisma().user.deleteMany();
    expect(await getPrisma().memoryRecord.count()).toBe(0);

    const report = await restoreBackup(backup.file);

    expect(report.restored.memoryRecord).toBe(3);
    expect(await getPrisma().memoryRecord.count()).toBe(3);

    // And the restored data is actually usable, not just present.
    const context = await researcher.memory.recall({
      workspaceId: workspace.id,
      query: 'what remains before release',
    });
    expect(context.items.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('Restoring must not resurrect a deleted record (invariant 7)', () => {
  it('replays deletions recorded after the snapshot was taken', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Tester', { canForget: true, canExport: true });

    const doomed = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'SECRET-MARKER this must never come back from a backup.',
      topic: 'privacy',
      source: 'run',
      idempotencyKey: key(),
    });

    const survivor = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'This one should survive the restore.',
      topic: 'privacy',
      source: 'run',
      idempotencyKey: key(),
    });

    // --- Snapshot taken WHILE the record still exists ---------------------
    const backup = await createBackup();
    const snapshot = JSON.parse(fs.readFileSync(backup.file, 'utf8'));
    expect(JSON.stringify(snapshot)).toContain('SECRET-MARKER');

    // --- Then the owner deletes it ----------------------------------------
    await agent.memory.forget({
      workspaceId: workspace.id,
      recordId: doomed.recordId,
      purge: true,
      reason: 'privacy request',
      idempotencyKey: key(),
    });

    // The deletion reached the file ledger, which lives outside the rotation.
    const ledger = readLedger();
    expect(ledger.some((entry) => entry.recordId === doomed.recordId)).toBe(true);

    // --- Restore the snapshot that still contains it ----------------------
    const report = await restoreBackup(backup.file);

    expect(report.deletionsReplayed).toBeGreaterThanOrEqual(1);
    expect(report.deletionsApplied).toBeGreaterThanOrEqual(1);

    // --- The deleted record must be gone from every path ------------------
    const recalled = await agent.memory.recall({
      workspaceId: workspace.id,
      query: 'secret marker privacy',
    });
    expect(JSON.stringify(recalled)).not.toContain('SECRET-MARKER');

    const exported = await agent.memory.export({ workspaceId: workspace.id });
    expect(JSON.stringify(exported)).not.toContain('SECRET-MARKER');

    const inspected = await agent.memory.inspect({ workspaceId: workspace.id });
    expect(JSON.stringify(inspected)).not.toContain('SECRET-MARKER');

    const indexed = await getPrisma().searchDoc.findMany({
      where: { recordId: doomed.recordId },
    });
    expect(indexed).toHaveLength(0);

    // The payload is wiped in the restored row, not merely hidden.
    const raw = await getPrisma().memoryRecord.findFirst({
      where: { recordId: doomed.recordId },
    });
    expect(raw?.text).toBe('');
    expect(raw?.purged).toBe(true);

    // --- And the record that was NOT deleted came back intact -------------
    expect(JSON.stringify(exported)).toContain('This one should survive the restore.');
    expect(
      (await getPrisma().memoryRecord.findFirst({ where: { recordId: survivor.recordId } }))?.text
    ).toBe('This one should survive the restore.');
  });

  it('is idempotent — restoring twice is safe', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Tester', { canForget: true });

    const doomed = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'ERASE-ME twice over.',
      topic: 'privacy',
      source: 'run',
      idempotencyKey: key(),
    });

    const backup = await createBackup();
    await agent.memory.forget({
      workspaceId: workspace.id,
      recordId: doomed.recordId,
      purge: true,
      idempotencyKey: key(),
    });

    await restoreBackup(backup.file);
    await restoreBackup(backup.file);

    const raw = await getPrisma().memoryRecord.findFirst({
      where: { recordId: doomed.recordId },
    });
    expect(raw?.text).toBe('');
  });

  it('does not replay a deletion that happened BEFORE the snapshot', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Tester', { canForget: true });

    const removed = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'result',
      text: 'Deleted before the snapshot.',
      topic: 'privacy',
      source: 'run',
      idempotencyKey: key(),
    });
    await agent.memory.forget({
      workspaceId: workspace.id,
      recordId: removed.recordId,
      purge: true,
      idempotencyKey: key(),
    });

    const kept = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'Written after the deletion.',
      topic: 'privacy',
      source: 'run',
      idempotencyKey: key(),
    });

    const backup = await createBackup();
    const report = await restoreBackup(backup.file);

    // The earlier deletion is already baked into the snapshot as a tombstone,
    // so there is nothing after it to replay.
    expect(report.deletionsReplayed).toBe(0);

    const current = await getPrisma().memoryRecord.findFirst({
      where: { recordId: kept.recordId },
    });
    expect(current?.text).toBe('Written after the deletion.');
  });
});

// ---------------------------------------------------------------------------
describe('Retention', () => {
  it('defaults to 30 days', () => {
    expect(backupRetentionDays()).toBe(30);
  });

  it('prunes snapshots past the window and keeps the rest', async () => {
    const workspace = await makeWorkspace();
    await seedEndToEndScenario(workspace);

    const fresh = await createBackup();

    // A snapshot from well outside the window. listBackups reads takenAt from
    // the file body, so an old timestamp is enough — no mtime tampering.
    const old = JSON.parse(fs.readFileSync(fresh.file, 'utf8'));
    old.takenAt = new Date(Date.now() - 45 * 86_400_000).toISOString();

    const oldFile = path.join(resolveBackupDir(), 'offcut-2020-01-01T00-00-00-000Z.json');
    fs.writeFileSync(oldFile, JSON.stringify(old), 'utf8');

    expect(listBackups()).toHaveLength(2);

    const removed = pruneBackups();

    expect(removed).toContain(oldFile);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(fresh.file)).toBe(true);
  });

  it('never prunes the deletion ledger', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Tester', { canForget: true });

    const record = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'Will be deleted.',
      topic: 'privacy',
      source: 'run',
      idempotencyKey: key(),
    });
    await agent.memory.forget({
      workspaceId: workspace.id,
      recordId: record.recordId,
      purge: true,
      idempotencyKey: key(),
    });

    const before = readLedger().length;
    expect(before).toBeGreaterThan(0);

    await createBackup();
    pruneBackups();

    // The ledger is the one thing retention must never touch: a restore from
    // the oldest surviving snapshot still has to replay every deletion.
    expect(readLedger().length).toBe(before);
  });

  it('records identity but never content', async () => {
    const workspace = await makeWorkspace();
    const agent = await makeAgent(workspace, 'Tester', { canForget: true });

    const record = await agent.memory.add({
      workspaceId: workspace.id,
      type: 'fact',
      text: 'CONFIDENTIAL-TEXT that must not reach the ledger.',
      topic: 'privacy',
      source: 'run',
      idempotencyKey: key(),
    });
    await agent.memory.forget({
      workspaceId: workspace.id,
      recordId: record.recordId,
      purge: true,
      reason: 'privacy request',
      idempotencyKey: key(),
    });

    const raw = fs.readFileSync(ledgerPath(), 'utf8');

    expect(raw).toContain(record.recordId);
    // A ledger that remembered the text would be the one place a purge could
    // not reach, which would defeat its own purpose.
    expect(raw).not.toContain('CONFIDENTIAL-TEXT');
  });
});
