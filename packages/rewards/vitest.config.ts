import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDb = path.resolve(here, '.data', 'rewards-test.db');

export default defineConfig({
  test: {
    globals: false,
    env: {
      // Its own SQLite file, so an accrual run in a test never touches the dev
      // store. One variable points the whole suite somewhere else:
      //   OFFCUT_TEST_DATABASE_URL=postgresql://... pnpm test
      DATABASE_URL: process.env.OFFCUT_TEST_DATABASE_URL ?? `file:${testDb}`,
    },
    globalSetup: ['./src/__tests__/global-setup.ts'],
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // SQLite takes a single writer; one fork keeps the suite deterministic.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      // merkle.test.ts imports the contract suite's own tree builder to prove
      // the two agree on a root. That file says `import { ethers } from
      // 'hardhat'`, and booting a Hardhat runtime to hash four values would be
      // absurd — so the name is pointed at ethers instead. This is sound rather
      // than a trick: hardhat-ethers' helper object spreads ethers' own exports,
      // and the builder touches only AbiCoder, keccak256 and concat, which are
      // the same functions either way.
      hardhat: 'ethers',
    },
  },
});
