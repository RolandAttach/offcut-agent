/**
 * Prisma client wiring.
 *
 * §4 fixes one rule that this file exists to enforce: "every connection to a
 * workspace uses the same store; it does not create a separate database for each
 * subagent". So the client is a module-level singleton, and every surface (SDK,
 * MCP, HTTP) resolves to the same instance in the same process.
 *
 * ---------------------------------------------------------------------------
 * Two rules about the environment, both learned by publishing
 * ---------------------------------------------------------------------------
 *
 * The runtime reads OFFCUT_DATABASE_URL. It does NOT read DATABASE_URL in an
 * installed copy, because that is the name every other tool — Prisma, Rails,
 * Heroku — uses for the consumer's OWN database. The first version did read it,
 * and a pre-publish review installed the package next to a project with a
 * `users` table: OFFCUT created its thirteen tables inside that database and
 * put a unique index on the consumer's own `users.email`. Inside this checkout
 * DATABASE_URL is still honoured, because here it is ours and the Prisma CLI
 * needs it for `db push`.
 *
 * And nothing here ever writes to process.env. The earlier version assigned
 * DATABASE_URL so the generated client could find it, which also handed our
 * SQLite path to every child process the consumer spawned.
 */

import './env';
import path from 'node:path';
import { isInstalledCopy, resolveDataDir } from './paths';
import { withSchemaBootstrap } from './bootstrap';
import type { PrismaClient as GeneratedPrismaClient } from '../generated/client';

export type PrismaClient = GeneratedPrismaClient;
export type { Prisma, MemoryRecord } from '../generated/client';

/** Transaction-capable handle: either the root client or an interactive tx. */
export type Db =
  | PrismaClient
  | Omit<PrismaClient, '$transaction' | '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>;

/**
 * The generated client, loaded with a message a person can act on.
 *
 * It is produced by `prisma generate` when the package installs, into this
 * package's own directory (see the generator block in prisma/schema.prisma). If
 * that step did not run — install scripts blocked, `--ignore-scripts`, no
 * network for the engine download — the raw failure is a MODULE_NOT_FOUND for a
 * path nobody recognises. This turns it into the command that fixes it.
 */
function loadGeneratedClient(): typeof import('../generated/client') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../generated/client');
  } catch (error) {
    if ((error as { code?: string }).code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error(
      "OFFCUT's database client has not been generated. `prisma generate` runs when the package is " +
        'installed; that step was skipped (install scripts blocked, --ignore-scripts, or no network to ' +
        'fetch the engine). Run:\n\n' +
        '  npx prisma generate --schema node_modules/@offcut/core/prisma/schema.prisma\n\n' +
        'With pnpm: `pnpm approve-builds` (allow @offcut/core and @prisma/client), then ' +
        '`pnpm rebuild @offcut/core`.'
    );
  }
}

const generated = loadGeneratedClient();

let client: PrismaClient | null = null;

/**
 * A relative `file:` URL made absolute against `base`.
 *
 * Prisma resolves a relative SQLite path against the directory of the schema
 * file. For a consumer that means `file:./dev.db` lands inside
 * node_modules/@offcut/core/prisma — the one place state must never live — so
 * their URL is resolved against the working directory instead. The checkout's
 * own DATABASE_URL keeps Prisma's rule, so the CLI and the runtime agree.
 */
function absoluteFileUrl(url: string, base: string): string {
  if (!url.startsWith('file:')) return url;
  const target = url.slice('file:'.length);
  if (target.startsWith('//') || path.isAbsolute(target)) return url;
  return `file:${path.resolve(base, target)}`;
}

/**
 * Where the store is.
 *
 *   1. OFFCUT_DATABASE_URL — any copy, relative paths against the working directory
 *   2. DATABASE_URL       — this checkout only, relative paths as the Prisma CLI reads them
 *   3. the data directory — ~/.offcut installed, packages/core/.data in a checkout
 */
export function resolveDatabaseUrl(): string {
  const own = process.env.OFFCUT_DATABASE_URL;
  if (own) return absoluteFileUrl(own, process.cwd());

  if (!isInstalledCopy() && process.env.DATABASE_URL) {
    return absoluteFileUrl(process.env.DATABASE_URL, path.resolve(__dirname, '..', 'prisma'));
  }

  // Shared with the ledger and the backup rotation, so all three always agree
  // on where state lives even when OFFCUT_DATA_DIR moves it.
  return `file:${path.join(resolveDataDir(), 'offcut.db')}`;
}

/**
 * Whether the active datasource is PostgreSQL.
 *
 * Needed because `contains` is not portable: SQLite's LIKE folds ASCII case, so
 * searching "cache" finds "Cache", while PostgreSQL's LIKE does not. Prisma
 * offers `mode: 'insensitive'` to close the gap, but ONLY on PostgreSQL —
 * passing it to SQLite is an error. So the filter has to be chosen per provider.
 */
export function isPostgres(): boolean {
  const url = resolveDatabaseUrl();
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

/**
 * A case-insensitive `contains` filter that behaves identically on both
 * supported databases. Search results must not depend on where the data lives.
 */
export function insensitiveContains(value: string): Record<string, unknown> {
  return isPostgres() ? { contains: value, mode: 'insensitive' } : { contains: value };
}

export function getPrisma(): PrismaClient {
  if (!client) {
    const url = resolveDatabaseUrl();
    const base = new generated.PrismaClient({
      datasources: { db: { url } },
      log: process.env.OFFCUT_DEBUG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
    // An installed copy opens an empty file the first time. See bootstrap.ts.
    client = withSchemaBootstrap(base, url);
  }
  return client;
}

/** Used by tests to point the core at a throwaway database file. */
export function setPrisma(instance: PrismaClient): void {
  client = instance;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
