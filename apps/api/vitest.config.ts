import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDb = path.resolve(here, '.data', 'api-test.db');

export default defineConfig({
  test: {
    env: {
      // One variable points the whole suite at a different database:
      //   OFFCUT_TEST_DATABASE_URL=postgresql://... pnpm test
      DATABASE_URL: process.env.OFFCUT_TEST_DATABASE_URL ?? `file:${testDb}`,
      // A fixed secret keeps sessions valid across the suite; without it the
      // dev fallback would write a file and the tests would depend on disk state.
      OFFCUT_JWT_SECRET: 'test-secret-not-used-anywhere-real',
      // A server configured to store credentials, because the usage suite links
      // an OpenRouter key and the core refuses to store one without this. Any
      // 32 bytes will do: nothing outside this suite reads what it encrypts.
      OFFCUT_SECRET_KEY: 'QrU9lH/XhaZvXVd46msTdKJ+30RF/F9WWkSbsz+XRW4=',
      NODE_ENV: 'test',
    },
    globalSetup: ['./src/__tests__/global-setup.ts'],
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
