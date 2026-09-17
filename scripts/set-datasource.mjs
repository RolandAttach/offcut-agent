#!/usr/bin/env node
/**
 * Switches the Prisma datasource between SQLite and PostgreSQL.
 *
 * Prisma cannot read `provider` from an environment variable, so moving between
 * databases means editing schema.prisma. Doing it with a script rather than
 * shipping two schema files keeps one source of truth — two copies of a 400-line
 * schema drift, and the drift is always discovered in production.
 *
 *   node scripts/set-datasource.mjs postgresql
 *   node scripts/set-datasource.mjs sqlite
 *
 * After switching:
 *   pnpm --filter @offcut/core exec prisma generate
 *   pnpm --filter @offcut/core exec prisma db push
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, '..', 'packages', 'core', 'prisma', 'schema.prisma');

const SUPPORTED = new Set(['sqlite', 'postgresql']);
const target = process.argv[2];

if (!SUPPORTED.has(target)) {
  console.error(`Usage: node scripts/set-datasource.mjs <${[...SUPPORTED].join('|')}>`);
  process.exit(1);
}

const schema = fs.readFileSync(schemaPath, 'utf8');
const match = schema.match(/datasource\s+db\s*\{[^}]*provider\s*=\s*"([^"]+)"/);

if (!match) {
  console.error('Could not find the datasource provider in schema.prisma.');
  process.exit(1);
}

const current = match[1];

if (current === target) {
  console.log(`Already on ${target}. Nothing to do.`);
  process.exit(0);
}

const updated = schema.replace(
  /(datasource\s+db\s*\{[^}]*provider\s*=\s*")[^"]+(")/,
  `$1${target}$2`
);

fs.writeFileSync(schemaPath, updated, 'utf8');

console.log(`Datasource: ${current} → ${target}`);
console.log('');
console.log('Next:');
console.log(`  1. Point DATABASE_URL at a ${target} database`);
console.log('  2. pnpm --filter @offcut/core exec prisma generate');
console.log('  3. pnpm --filter @offcut/core exec prisma db push');

if (target === 'postgresql') {
  console.log('');
  console.log('Two things to know:');
  console.log('  - Search is case-insensitive on both databases: the core picks the');
  console.log('    right filter per provider (insensitiveContains in src/db.ts), so');
  console.log('    nothing in memory.ts needs changing.');
  console.log('  - The first-run table bootstrap (src/bootstrap.ts) is SQLite-only.');
  console.log('    On PostgreSQL, step 3 above is what creates the tables.');
}
