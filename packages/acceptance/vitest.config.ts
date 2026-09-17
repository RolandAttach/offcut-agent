import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDb = path.resolve(here, '.data', 'acceptance.db');

export default defineConfig({
  test: {
    env: {
      // One variable points the whole suite at a different database:
      //   OFFCUT_TEST_DATABASE_URL=postgresql://... pnpm test
      DATABASE_URL: process.env.OFFCUT_TEST_DATABASE_URL ?? `file:${testDb}`,
    },
    globalSetup: ['./src/global-setup.ts'],
    setupFiles: ['./src/setup.ts'],
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
