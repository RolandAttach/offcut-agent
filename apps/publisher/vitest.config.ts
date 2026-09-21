import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    // No database, no RPC endpoint, no global setup. Everything this service
    // decides - which period is owed, whether a root is worth a transaction,
    // whether it may start at all - is decided from a cursor, a clock and four
    // contract reads, and all four are faked. A suite that needed a chain to
    // prove a period is not paid twice is a suite nobody runs.
  },
});
