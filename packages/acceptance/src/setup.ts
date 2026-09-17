import { afterAll, beforeEach } from 'vitest';
import { disconnectPrisma, getPrisma } from '@offcut/core';

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
});

afterAll(async () => {
  await disconnectPrisma();
});
