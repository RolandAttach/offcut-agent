/**
 * Per-test isolation: every table this suite touches is emptied before each
 * test. Accruals go first because nothing cascades to them - they survive the
 * workspace that earned them on purpose, so that a deleted workspace cannot
 * erase a payment that was already published in a root.
 */

import { afterAll, beforeEach } from 'vitest';
import { disconnectPrisma, getPrisma } from '@offcut/core';

beforeEach(async () => {
  const db = getPrisma();

  await db.rewardAccrual.deleteMany();
  // Cleared by name rather than left to the cascade from workspace: this is the
  // table the accrual is now paid from, and a suite that silently stopped
  // emptying it would leak one test's spend into the next one's pool.
  await db.modelUsage.deleteMany();
  await db.rewardCredit.deleteMany();
  await db.workspace.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await disconnectPrisma();
});
