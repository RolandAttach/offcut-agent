/**
 * First-run schema for an installed copy.
 *
 * Inside the repository, `pnpm setup` pushes the schema before anything runs.
 * A copy installed from npm has no such step: the package arrives, the first
 * call opens a fresh SQLite file, and every query fails with "table does not
 * exist" — verified by installing the tarball into a clean project. Telling
 * users to run `prisma db push` against a schema buried in node_modules is not
 * an answer, so the core creates its own tables the first time it opens an
 * empty store.
 *
 * The DDL is not written by hand: the build asks Prisma to diff an empty
 * database against schema.prisma and ships the result as
 * prisma/bootstrap.sqlite.sql, so it cannot drift from the schema.
 *
 * Three rules, each the answer to a way this went wrong under review:
 *
 * 1. It runs as ONE transaction and finishes by stamping the file
 *    (PRAGMA user_version). The first version ran forty-six statements one at
 *    a time and checked for a single table afterwards, so a process killed
 *    halfway left a store with some tables and no indexes that the core then
 *    treated as complete forever. Now an interrupted bootstrap leaves nothing
 *    behind, and a store without the stamp is redone.
 *
 * 2. It refuses a database that already belongs to something else. Given a
 *    file with a `customers` table in it, the first version happily added
 *    fourteen tables of its own. A store is either empty, or ours, or not ours
 *    to touch.
 *
 * 3. SQLite only. A PostgreSQL store is a server somebody administers, and a
 *    library has no business running DDL against it on its own.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '../generated/client';

const BOOTSTRAP_SQL = path.resolve(__dirname, '..', 'prisma', 'bootstrap.sqlite.sql');

/**
 * Stamped into the file once the schema is complete. Bump it when the shipped
 * DDL changes shape; a store below it is bootstrapped again, which the
 * IF NOT EXISTS statements make safe.
 */
export const SCHEMA_VERSION = 5;

/**
 * Every table this package owns, read out of the shipped DDL.
 *
 * This used to be a hand-written array, and it broke the first time the schema
 * gained a table: the generated SQL created `reward_credits`, the list did not
 * know about it, and the foreign-database guard below decided the store
 * belonged to somebody else and refused to open it. A list that must be edited
 * in step with a generated file will fall out of step with it.
 *
 * Parsed once, lazily, because the file is read for the DDL anyway.
 */
let tableCache: string[] | null = null;

export function offcutTables(): string[] {
  if (tableCache) return tableCache;

  if (!fs.existsSync(BOOTSTRAP_SQL)) return [];

  const sql = fs.readFileSync(BOOTSTRAP_SQL, 'utf8');
  const names = new Set<string>();
  for (const match of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/g)) {
    names.add(match[1]!);
  }

  tableCache = [...names].sort();
  return tableCache;
}

function isPostgresUrl(url: string): boolean {
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

/**
 * Splits the shipped script into statements the driver can run one at a time.
 * Comment lines are dropped first so a chunk that is nothing but a comment does
 * not reach the database as an empty statement.
 */
function statementsOf(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((chunk) => chunk.replace(/^--.*$/gm, '').trim())
    .filter((chunk) => chunk.length > 0);
}

async function schemaVersionOf(client: PrismaClient): Promise<number> {
  const rows = await client.$queryRawUnsafe<Array<{ user_version: number | bigint }>>(
    'PRAGMA user_version'
  );
  return Number(rows[0]?.user_version ?? 0);
}

async function tableNamesOf(client: PrismaClient): Promise<string[]> {
  const rows = await client.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
  );
  return rows.map((row) => row.name);
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY|\bbusy\b/i.test(message);
}

/**
 * Columns added to a table that older stores already have.
 *
 * Replaying IF NOT EXISTS DDL creates a table or an index that is missing and
 * leaves an existing table exactly as it was. So a column added to a table the
 * store already holds never arrives that way — and the index the DDL then
 * creates on that column fails, and the store does not open at all. Found when
 * SCHEMA_VERSION reached 5 and users.walletProvenAddress gained a unique index.
 *
 * Each entry is applied only while PRAGMA table_info says the column is absent.
 * Only a nullable column with no default can be added to SQLite in place, which
 * is also the only kind that leaves every existing row meaning what it meant.
 */
const ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; type: string }> = [
  { table: 'users', column: 'walletProvenAt', type: 'DATETIME' },
  { table: 'users', column: 'walletProvenAddress', type: 'TEXT' },
];

/**
 * What cannot be done in place.
 *
 * Version 4 made users.email and users.passwordHash nullable so an account can
 * be opened by a wallet alone, and SQLite cannot relax NOT NULL on a column it
 * already has. A store from before that is refused, with the command that
 * migrates it, rather than opened into a state where the wallet door fails on
 * its first sign-in with an error about a column nobody named.
 */
const RELAXED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'users', column: 'email' },
  { table: 'users', column: 'passwordHash' },
];

interface ColumnInfo {
  name: string;
  notnull: number | bigint;
}

async function columnsOf(client: PrismaClient, table: string): Promise<ColumnInfo[]> {
  return client.$queryRawUnsafe<ColumnInfo[]>(`PRAGMA table_info("${table}")`);
}

/**
 * Brings the tables a store already has up to the current shape, so the DDL
 * replay that follows finds every column its indexes name.
 */
async function upgradeInPlace(client: PrismaClient, present: string[]): Promise<void> {
  const tables = new Set(present);

  for (const { table, column } of RELAXED_COLUMNS) {
    if (!tables.has(table)) continue;
    const info = (await columnsOf(client, table)).find((entry) => entry.name === column);
    if (info && Number(info.notnull) === 1) {
      throw new Error(
        `This store was made by an older OFFCUT: "${table}"."${column}" is still NOT NULL, ` +
          'and SQLite cannot change that in place. Migrate it once with ' +
          '`prisma db push` from packages/core (or `pnpm db:push` in a checkout), ' +
          'pointed at this file, and it will open from then on.'
      );
    }
  }

  for (const { table, column, type } of ADDED_COLUMNS) {
    if (!tables.has(table)) continue;
    const existing = await columnsOf(client, table);
    if (existing.some((entry) => entry.name === column)) continue;
    await client.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`);
  }
}

/**
 * Creates the tables if the file is new or a previous attempt was cut short.
 * Safe to call any number of times, from any number of processes.
 *
 * Runs against the plain client it is given, never an extended one — the
 * wrapper below routes every query through a hook that waits for this, and a
 * bootstrap that waited for itself would never finish.
 */
export async function ensureSchema(client: PrismaClient): Promise<void> {
  if ((await schemaVersionOf(client)) >= SCHEMA_VERSION) return;

  const ours = offcutTables();
  const present = await tableNamesOf(client);
  const foreign = present.filter(
    (name) => !ours.includes(name) && !name.startsWith('_prisma_')
  );
  if (foreign.length > 0) {
    throw new Error(
      `The database OFFCUT was pointed at already contains tables that are not its own ` +
        `(${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', …' : ''}). ` +
        'OFFCUT will not create its schema inside another application\'s database. ' +
        'Point OFFCUT_DATABASE_URL at a dedicated file, or unset it to use ~/.offcut/offcut.db.'
    );
  }

  if (!fs.existsSync(BOOTSTRAP_SQL)) {
    throw new Error(
      `The store is empty and ${BOOTSTRAP_SQL} is missing, so its tables cannot be created. ` +
        'This package was built without its bootstrap SQL; run the build ' +
        '(pnpm --filter @offcut/core build) or push the schema with prisma db push.'
    );
  }

  const statements = statementsOf(fs.readFileSync(BOOTSTRAP_SQL, 'utf8'));

  // Two processes opening the same new file at once both arrive here. SQLite
  // lets one of them write; the other waits on the lock and may be told the
  // database is busy. It re-checks the stamp — the first may have finished —
  // and otherwise tries again. The statements are IF NOT EXISTS, so a second
  // full pass is harmless even if both somehow ran.
  for (let attempt = 1; ; attempt += 1) {
    if ((await schemaVersionOf(client)) >= SCHEMA_VERSION) return;

    try {
      // Outside the transaction: ALTER TABLE is its own statement in SQLite and
      // is idempotent here by the column check, so a retry after a busy error
      // finds the column present and moves on.
      await upgradeInPlace(client, present);

      await client.$transaction(async (tx) => {
        for (const statement of statements) {
          await tx.$executeRawUnsafe(statement);
        }
        await tx.$executeRawUnsafe(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      return;
    } catch (error) {
      if (!isBusy(error) || attempt >= 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 60 * attempt));
    }
  }
}

/**
 * Returns a client that guarantees its tables exist before any query runs.
 *
 * The bootstrap is started at once rather than on the first query, so on the
 * common path it has finished by the time anything asks. The hook is still the
 * guarantee: every operation waits on the same promise, and if creating the
 * schema failed every operation fails with that reason rather than with a
 * misleading "table does not exist".
 *
 * Transactions need one more step, and it is not optional. Prisma gives SQLite
 * a pool of exactly one connection. An interactive transaction takes it, and
 * then the first query inside — routed through the hook — waits for the DDL,
 * which waits for a connection, which the transaction is holding: a deadlock
 * that only ends when the transaction times out. So `$transaction` itself waits
 * for the bootstrap BEFORE it takes the connection. The test that opens a
 * transaction as the very first operation is the one that found this.
 *
 * The cast at the end is deliberate. An extended client is typed differently
 * from PrismaClient even though it carries every model delegate and every `$`
 * method the rest of the core uses, and threading the extended type through
 * every signature would change nothing at runtime.
 */
export function withSchemaBootstrap(base: PrismaClient, databaseUrl: string): PrismaClient {
  if (isPostgresUrl(databaseUrl)) return base;

  const ready = ensureSchema(base);
  // Observed here so a failure does not surface as an unhandled rejection at
  // the moment the client is built; it surfaces on the first query instead,
  // where the caller is waiting for an answer.
  ready.catch(() => undefined);

  const extended = base.$extends({
    query: {
      async $allOperations({ query, args }) {
        await ready;
        return query(args);
      },
    },
  });

  type Extended = typeof extended;
  type TransactionFn = Extended['$transaction'];

  const guarded = new Proxy(extended, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        const transaction = (target.$transaction as TransactionFn).bind(target);
        return async (...args: Parameters<TransactionFn>) => {
          await ready;
          return (transaction as (...a: unknown[]) => unknown)(...args);
        };
      }

      const value = Reflect.get(target, property, receiver);
      // Client-level methods ($disconnect, $queryRawUnsafe, ...) are called on
      // the extended client, never on this wrapper, so their internals see the
      // object they belong to.
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

  return guarded as unknown as PrismaClient;
}
