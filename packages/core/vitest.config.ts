import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDb = path.resolve(here, '.data', 'test.db');

export default defineConfig({
  test: {
    globals: false,
    env: {
      // Tests get their own SQLite file so a run never touches the dev database.
      //
      // One variable points the whole suite at a different database:
      //   OFFCUT_TEST_DATABASE_URL=postgresql://... pnpm test
      // which is how the PostgreSQL path is verified without editing any config.
      DATABASE_URL: process.env.OFFCUT_TEST_DATABASE_URL ?? `file:${testDb}`,
    },
    globalSetup: ['./src/__tests__/global-setup.ts'],
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // SQLite takes a single writer. One fork keeps the suite deterministic;
    // genuine write races are exercised explicitly with Promise.allSettled.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
