import { afterAll, beforeEach } from 'vitest';
import { disconnectPrisma, getPrisma } from '@offcut/core';
import { resetRateLimits } from '../common/rate-limit.guard';

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

  // The limiter is process-global. Without this, a suite that exercises the
  // login limit would starve every test that runs after it.
  resetRateLimits();
});

afterAll(async () => {
  await disconnectPrisma();
});
