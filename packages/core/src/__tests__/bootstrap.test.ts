/**
 * The first time an installed copy opens a store.
 *
 * Found by publishing for real: `npm pack`, install into a clean project,
 * connect. The client loaded, and the first query died with
 *
 *     The table `main.agents` does not exist in the current database.
 *
 * Nothing in the package had ever created the tables — inside the repository
 * `pnpm setup` does that, and a consumer has no such step. These tests hold the
 * fix in place by doing what the consumer does: open a brand-new file and ask.
 *
 * The second half came from an adversarial review of that fix. Given a
 * database that already belonged to another application, the bootstrap added
 * its tables to it; given a store where a previous bootstrap had been cut
 * short, it saw one table and declared the schema complete forever.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/client';
import { SCHEMA_VERSION, ensureSchema, offcutTables, withSchemaBootstrap } from '../bootstrap';

const opened: Array<{ client: PrismaClient; dir: string }> = [];

/** A client over a file that has never existed. */
function freshStore(): { client: PrismaClient; url: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offcut-bootstrap-'));
  const url = `file:${path.join(dir, 'fresh.db')}`;
  const client = new PrismaClient({ datasources: { db: { url } } });
  opened.push({ client, dir });
  return { client, url };
}

async function tablesIn(client: PrismaClient): Promise<string[]> {
  const rows = await client.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
  );
  return rows.map((row) => row.name).sort();
}

async function versionOf(client: PrismaClient): Promise<number> {
  const rows = await client.$queryRawUnsafe<Array<{ user_version: number | bigint }>>(
    'PRAGMA user_version'
  );
  return Number(rows[0]?.user_version ?? 0);
}

afterEach(async () => {
  for (const { client, dir } of opened.splice(0)) {
    await client.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
describe('An empty store gets its tables before the first query', () => {
  it('fails exactly as the consumer saw without the bootstrap', async () => {
    // The defect, reproduced on purpose so the next test is known to be real.
    const { client } = freshStore();

    await expect(client.agent.count()).rejects.toMatchObject({ code: 'P2021' });
  });

  it('answers the first query on a brand-new file', async () => {
    const { client, url } = freshStore();
    const store = withSchemaBootstrap(client, url);

    await expect(store.agent.count()).resolves.toBe(0);
    await expect(store.memoryRecord.count()).resolves.toBe(0);
  });

  it('works inside an interactive transaction as the very first operation', async () => {
    const { client, url } = freshStore();
    const store = withSchemaBootstrap(client, url);

    const count = await store.$transaction(async (tx) => tx.workspace.count());

    expect(count).toBe(0);
  });

  it('is idempotent, so a second process opening the same file is harmless', async () => {
    const { client } = freshStore();

    await ensureSchema(client);
    await ensureSchema(client);
    await ensureSchema(client);

    await expect(client.agent.count()).resolves.toBe(0);
  });

  it('creates every table the schema declares, not just the one it checks for', async () => {
    const { client } = freshStore();
    await ensureSchema(client);

    // Every @@map in schema.prisma. A table missing here would surface as a
    // P2021 on whichever operation touches it first — possibly weeks later.
    expect(await tablesIn(client)).toEqual([...offcutTables()].sort());
  });

  it('gives a store from an older release the table it never had', async () => {
    const { client } = freshStore();
    await ensureSchema(client);

    // A store as a previous release left it: every table that release knew
    // about, stamped with the version it knew about. spent_siwe_nonces arrived
    // after version 4, and the wallet door writes a row there on the way in, so
    // an upgrade that skipped the new table would refuse honest sign-ins
    // instead of the replays the table exists to refuse. The stamp is what
    // decides: bump SCHEMA_VERSION when the shipped DDL grows, or every store
    // already out there keeps the schema it opened with.
    const before = await client.user.create({ data: { displayName: 'Opened last release' } });
    await client.$executeRawUnsafe('DROP TABLE "spent_siwe_nonces"');
    await client.$executeRawUnsafe('PRAGMA user_version = 4');

    await ensureSchema(client);

    expect(await tablesIn(client)).toContain('spent_siwe_nonces');
    expect(await versionOf(client)).toBe(SCHEMA_VERSION);
    // IF NOT EXISTS all the way down: an upgrade adds, it does not start again.
    expect(await client.user.findUnique({ where: { id: before.id } })).not.toBeNull();
  });

  it('stamps the file when it is done, and trusts the stamp afterwards', async () => {
    const { client } = freshStore();
    expect(await versionOf(client)).toBe(0);

    await ensureSchema(client);

    expect(await versionOf(client)).toBe(SCHEMA_VERSION);
  });

  it('derives its table list from the shipped DDL, not from a hand-written array', async () => {
    // The array version broke the first time the schema gained a table: the
    // generated SQL created it, the list did not know about it, and the guard
    // below decided our own store belonged to somebody else.
    const { client } = freshStore();
    await ensureSchema(client);

    const created = await tablesIn(client);
    expect(offcutTables()).toEqual(created);
    expect(offcutTables()).toContain('reward_credits');
  });

  it('leaves a PostgreSQL store untouched', () => {
    // A server someone administers is not ours to run DDL against.
    const { client } = freshStore();

    expect(withSchemaBootstrap(client, 'postgresql://offcut@db/offcut')).toBe(client);
  });
});

// ---------------------------------------------------------------------------
describe('A store that is not empty', () => {
  it('refuses a database that belongs to something else', async () => {
    // The review case: OFFCUT_DATABASE_URL pointed at an application's own
    // database. The first version created fourteen tables inside it and put a
    // unique index on that application's users table.
    const { client } = freshStore();
    await client.$executeRawUnsafe('CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT)');

    await expect(ensureSchema(client)).rejects.toThrow(/not its own/);

    // And it touched nothing.
    expect(await tablesIn(client)).toEqual(['customers']);
    expect(await versionOf(client)).toBe(0);
  });

  it('finishes a bootstrap that was cut short', async () => {
    // The review case: a store with the `agents` table and nothing else — what
    // a crash between statements used to leave behind — was accepted as
    // complete because that was the only table checked for.
    const { client } = freshStore();
    await client.$executeRawUnsafe(
      'CREATE TABLE agents (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL)'
    );

    await ensureSchema(client);

    expect(await tablesIn(client)).toEqual([...offcutTables()].sort());
    expect(await versionOf(client)).toBe(SCHEMA_VERSION);
    await expect(client.memoryRecord.count()).resolves.toBe(0);
  });

  it('leaves a complete, stamped store alone', async () => {
    const { client } = freshStore();
    await ensureSchema(client);

    // Drop one index behind the bootstrap's back. If it re-ran the DDL on every
    // open the index would come back; the stamp says it must not need to look.
    await client.$executeRawUnsafe('DROP INDEX IF EXISTS "users_email_key"');
    const before = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'users_email_key'`
    );
    expect(before).toHaveLength(0);

    await ensureSchema(client);

    const after = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'users_email_key'`
    );
    expect(after).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('A store from an earlier version is brought up to shape, not broken', () => {
  /** The users table as version 4 wrote it: email nullable, one wallet column short. */
  async function versionFourUsers(client: PrismaClient): Promise<void> {
    await client.$executeRawUnsafe(`CREATE TABLE "users" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "email" TEXT,
      "passwordHash" TEXT,
      "displayName" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "walletAddress" TEXT,
      "walletLinkedAt" DATETIME,
      "walletProvenAt" DATETIME
    )`);
    await client.$executeRawUnsafe(
      `INSERT INTO "users" ("id", "email", "passwordHash", "displayName") VALUES ('u1', 'a@b.c', 'x', 'A')`
    );
    await client.$executeRawUnsafe('PRAGMA user_version = 4');
  }

  it('adds the column a newer unique index needs, and keeps the rows', async () => {
    // Without this the replay reached CREATE UNIQUE INDEX ... ("walletProvenAddress")
    // on a table without that column, and the store never opened again.
    const { client } = freshStore();
    await versionFourUsers(client);

    await ensureSchema(client);

    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("users")');
    expect(columns.map((column) => column.name)).toContain('walletProvenAddress');

    const indexes = await client.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users'`
    );
    expect(indexes.map((index) => index.name)).toContain('users_walletProvenAddress_key');

    const rows = await client.$queryRawUnsafe<Array<{ id: string; email: string }>>('SELECT id, email FROM "users"');
    expect(rows).toEqual([{ id: 'u1', email: 'a@b.c' }]);
    expect(await versionOf(client)).toBe(SCHEMA_VERSION);
  });

  it('refuses a store whose users table still forbids a null email, and says how to migrate', async () => {
    // Version 3 shape. SQLite cannot relax NOT NULL in place, and opening the
    // store anyway would make the first wallet sign-in fail on an insert.
    const { client } = freshStore();
    await client.$executeRawUnsafe(`CREATE TABLE "users" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "email" TEXT NOT NULL,
      "passwordHash" TEXT NOT NULL,
      "displayName" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "walletAddress" TEXT,
      "walletLinkedAt" DATETIME
    )`);
    await client.$executeRawUnsafe('PRAGMA user_version = 3');

    await expect(ensureSchema(client)).rejects.toThrow(/prisma db push/);
    // And it did not half-upgrade: the stamp is untouched, so the next open says the same thing.
    expect(await versionOf(client)).toBe(3);
  });
});
