/**
 * Per-test isolation: every table is emptied before each test.
 *
 * Deletion order follows foreign keys from leaves inward. Workspaces and users
 * go last because everything else cascades from them.
 */

import { afterAll, beforeEach } from 'vitest';
import { disconnectPrisma, getPrisma } from '../db';

beforeEach(async () => {
  const db = getPrisma();

  await db.mergedBlockSource.deleteMany();
  await db.mergedBlock.deleteMany();
  await db.conflictSide.deleteMany();
  await db.conflict.deleteMany();
  await db.recordLink.deleteMany();
  await db.searchDoc.deleteMany();
  await db.recallCacheEntry.deleteMany();
  await db.idempotencyEntry.deleteMany();
  await db.auditEvent.deleteMany();
  await db.memoryRecord.deleteMany();
  await db.agent.deleteMany();
  await db.workspace.deleteMany();
  await db.user.deleteMany();
  // Hangs off nothing, so nothing cascades it away.
  await db.spentSiweNonce.deleteMany();
});

afterAll(async () => {
  await disconnectPrisma();
});
