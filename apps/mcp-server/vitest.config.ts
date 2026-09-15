import { defineConfig } from 'vitest/config';

/**
 * A suite that must never touch a database.
 *
 * Everything under src/__tests__ exercises the choice between the two stores
 * and the HTTP client that serves the remote one, with a fake fetch. If one of
 * these tests ever needs a SQLite file, the thing it is testing has reached
 * for @offcut/core - which is the bug, not the fixture.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
