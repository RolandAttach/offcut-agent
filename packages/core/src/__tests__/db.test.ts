/**
 * Where the store is, and whose variables decide it.
 *
 * Written after a pre-publish review installed the package next to a project
 * that used Prisma for its own database. The core read that project's
 * DATABASE_URL, opened that project's database, and created its schema inside
 * it. The rules these tests hold:
 *
 *   - OFFCUT_DATABASE_URL is ours and always wins
 *   - DATABASE_URL is honoured inside this checkout, where it is ours, and
 *     ignored in an installed copy, where it is somebody else's
 *   - relative file: paths never resolve into node_modules
 *   - the core writes nothing into process.env
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma, isPostgres, resolveDatabaseUrl } from '../db';
import { setInstalledForTests } from '../paths';

const saved = {
  own: process.env.OFFCUT_DATABASE_URL,
  generic: process.env.DATABASE_URL,
};

/** packages/core/prisma — where the Prisma CLI resolves a relative file: from. */
const schemaDir = path.resolve(__dirname, '..', '..', 'prisma');

beforeEach(() => {
  delete process.env.OFFCUT_DATABASE_URL;
});

afterEach(async () => {
  if (saved.own === undefined) delete process.env.OFFCUT_DATABASE_URL;
  else process.env.OFFCUT_DATABASE_URL = saved.own;
  process.env.DATABASE_URL = saved.generic;
  setInstalledForTests(null);
  // The singleton was built from whatever this test set; the next test's
  // setup must build it again from the real environment.
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------
describe('Which variable decides', () => {
  it('OFFCUT_DATABASE_URL wins over everything, installed or not', () => {
    process.env.OFFCUT_DATABASE_URL = 'file:/dedicated/offcut.db';
    process.env.DATABASE_URL = 'file:/somebody/elses.db';

    setInstalledForTests(true);
    expect(resolveDatabaseUrl()).toBe('file:/dedicated/offcut.db');

    setInstalledForTests(false);
    expect(resolveDatabaseUrl()).toBe('file:/dedicated/offcut.db');
  });

  it('an installed copy ignores the generic DATABASE_URL', () => {
    // This is the whole point. A consumer's DATABASE_URL names THEIR database.
    setInstalledForTests(true);
    process.env.DATABASE_URL = 'file:/somebody/elses.db';

    // Other suites in this run point OFFCUT_DATA_DIR at a scratch directory;
    // clear it so the default home-directory location is what gets asserted.
    const dataDir = process.env.OFFCUT_DATA_DIR;
    delete process.env.OFFCUT_DATA_DIR;
    try {
      const url = resolveDatabaseUrl();

      expect(url).not.toContain('elses');
      expect(url).toMatch(/\.offcut[\\/]offcut\.db$/);
    } finally {
      if (dataDir !== undefined) process.env.OFFCUT_DATA_DIR = dataDir;
    }
  });

  it('a checkout honours DATABASE_URL, resolved the way the Prisma CLI resolves it', () => {
    setInstalledForTests(false);
    process.env.DATABASE_URL = 'file:../.data/here.db';

    // Relative to prisma/schema.prisma, so `prisma db push` and the runtime
    // open the same file.
    expect(resolveDatabaseUrl()).toBe(`file:${path.resolve(schemaDir, '../.data/here.db')}`);
  });
});

// ---------------------------------------------------------------------------
describe('Relative paths', () => {
  it('resolves a relative OFFCUT_DATABASE_URL against the working directory', () => {
    // The review case: `file:./dev.db` used to land inside
    // node_modules/@offcut/core/prisma, where the next install deletes it.
    process.env.OFFCUT_DATABASE_URL = 'file:./dev.db';

    expect(resolveDatabaseUrl()).toBe(`file:${path.resolve(process.cwd(), 'dev.db')}`);
  });

  it('leaves absolute and non-file URLs alone', () => {
    process.env.OFFCUT_DATABASE_URL = 'postgresql://offcut@db/offcut';
    expect(resolveDatabaseUrl()).toBe('postgresql://offcut@db/offcut');
    expect(isPostgres()).toBe(true);

    const absolute = `file:${path.resolve(os_tmp(), 'x.db')}`;
    process.env.OFFCUT_DATABASE_URL = absolute;
    expect(resolveDatabaseUrl()).toBe(absolute);
    expect(isPostgres()).toBe(false);
  });
});

function os_tmp(): string {
  return process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
}

// ---------------------------------------------------------------------------
describe('The environment is read, never written', () => {
  it('building the client leaves DATABASE_URL exactly as it was', async () => {
    // The earlier version assigned process.env.DATABASE_URL so the generated
    // client could find it — which also handed OFFCUT's SQLite path to every
    // child process the consumer spawned, including their own `prisma migrate`.
    const marker = 'file:/left/alone.db';
    process.env.OFFCUT_DATABASE_URL = saved.generic; // the suite's own test store
    process.env.DATABASE_URL = marker;

    await disconnectPrisma();
    getPrisma();

    expect(process.env.DATABASE_URL).toBe(marker);
  });
});
