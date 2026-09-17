import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');
const coreRoot = path.resolve(appRoot, '..', '..', 'packages', 'core');
const dataDir = path.join(appRoot, '.data');
const dbFile = path.join(dataDir, 'api-test.db');

/** A dedicated database for the HTTP suite, rebuilt from the shipped schema. */
export default function setup(): void {
  // The suite can be pointed at another database - see vitest.config.ts.
  // With an external database there is no local file to clear; db push with
  // --accept-data-loss resets the schema there instead.
  const databaseUrl = process.env.OFFCUT_TEST_DATABASE_URL ?? `file:${dbFile}`;
  const isFile = databaseUrl.startsWith('file:');

  fs.mkdirSync(dataDir, { recursive: true });

  if (isFile) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const file = `${dbFile}${suffix}`;
      if (fs.existsSync(file)) fs.rmSync(file);
    }
  }

  execSync('pnpm exec prisma db push --skip-generate --accept-data-loss', {
    cwd: coreRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}
