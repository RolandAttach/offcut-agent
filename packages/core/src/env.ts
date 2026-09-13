/**
 * Loads .env files into process.env.
 *
 * Node does not read .env on its own, and Next.js only reads the one beside
 * apps/web — so a key the user puts at the repository root reaches the console
 * but not the API or the CLI. That asymmetry is confusing enough to be worth
 * fixing here rather than telling people to export variables by hand.
 *
 * Written without dotenv because the core has exactly two dependencies and this
 * is thirty lines of parsing. Behaviour matches dotenv where it matters:
 *
 *   - a variable already set in the real environment always wins, so
 *     `OPENROUTER_API_KEY=... pnpm dev` overrides the file
 *   - # comments and blank lines are skipped
 *   - surrounding single or double quotes are stripped
 *   - a leading `export ` is tolerated, since people paste shell snippets
 *
 * Files are read nearest-first: the package's own .env, then the monorepo root.
 * Nearest wins, matching how every other tool in the stack resolves config.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isInstalledCopy } from './paths';

let loaded = false;

function parse(contents: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;

    const equals = withoutExport.indexOf('=');
    if (equals <= 0) continue;

    const key = withoutExport.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(equals + 1).trim();

    // Strip a matched pair of surrounding quotes, but leave inner ones alone.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }

  return out;
}

/**
 * Idempotent: safe to call from several entry points, which is why db.ts and
 * index.ts both do. Only the first call reads the disk.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  const packageRoot = path.resolve(__dirname, '..');

  // The repository root exists only in a checkout. Installed, two directories up
  // is the consumer's node_modules - not a place to take configuration from.
  const dirs = isInstalledCopy() ? [packageRoot] : [packageRoot, path.resolve(packageRoot, '..', '..')];

  for (const dir of dirs) {
    const file = path.join(dir, '.env');
    if (!fs.existsSync(file)) continue;

    try {
      for (const [key, value] of Object.entries(parse(fs.readFileSync(file, 'utf8')))) {
        // A real environment variable is authoritative; never clobber it.
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // An unreadable .env must not stop the process from starting — every
      // setting it could carry has a working default.
    }
  }
}

loadEnv();
