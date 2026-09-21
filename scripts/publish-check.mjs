#!/usr/bin/env node
/**
 * A dry run of publishing @offcut/core, @offcut/sdk and @offcut/mcp-server.
 *
 * It exists because the failure it catches is invisible until a stranger hits
 * it. A tarball that ships `src/` leaks work in progress; one that ships a
 * `.env` leaks a key; one whose `bin` points at a file the `files` whitelist
 * left out installs cleanly and then does nothing — and npm will not let you
 * replace that version. So: build, pack, open the tarball, and read what is
 * actually inside it rather than what the manifest promised.
 *
 * Three things it checks that nothing else does:
 *
 * 1. Every path in the tarball is on the allow list. Forbidden wins over
 *    allowed, so a `dist/secrets.env` is still a failure.
 * 2. `main`, `types`, `exports` and `bin` are resolved AGAINST THE TARBALL, not
 *    against the working tree, where the file exists either way.
 * 3. No `workspace:` range survives into the packed package.json. pnpm rewrites
 *    them at pack time; if that ever stops happening, `npm i @offcut/sdk` fails
 *    on a protocol npm has never heard of.
 *
 * Nothing here publishes or logs in. It prints the commands and stops.
 *
 *   node scripts/publish-check.mjs             build, pack, check
 *   node scripts/publish-check.mjs --no-build  use the dist that is already there
 *   node scripts/publish-check.mjs --keep      leave the tarballs on disk
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const skipBuild = argv.includes('--no-build');
const keep = argv.includes('--keep');

// ---------------------------------------------------------------------------
// What each package is allowed to ship
// ---------------------------------------------------------------------------

/**
 * `prisma/` is core's one exception, and it is not slack: the schema is what
 * `postinstall` regenerates the client from on the consumer's machine. Drop it
 * and the package installs and then cannot open its own database.
 */
const PACKAGES = [
  { name: '@offcut/core', dir: 'packages/core', extraAllowed: [/^prisma\//] },
  { name: '@offcut/sdk', dir: 'packages/sdk', extraAllowed: [] },
  { name: '@offcut/mcp-server', dir: 'apps/mcp-server', extraAllowed: [] },
];

const ALWAYS_ALLOWED = [
  /^package\.json$/,
  /^README(\.md)?$/i,
  /^LICEN[SC]E(\.md|\.txt)?$/i,
  /^dist\//,
];

/**
 * Checked before the allow list, so a forbidden name buried under `dist/` is
 * still caught. `.data` and `.env` are the two that would actually hurt.
 */
const FORBIDDEN = [
  { pattern: /(^|\/)src\//, why: 'source' },
  { pattern: /(^|\/)node_modules\//, why: 'node_modules' },
  { pattern: /(^|\/)\.env/, why: 'environment file' },
  { pattern: /(^|\/)\.data(\/|$)/, why: 'local data directory' },
  { pattern: /(^|\/)__tests__\//, why: 'tests' },
  { pattern: /(^|\/)tests?\//, why: 'tests' },
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/, why: 'test file' },
  { pattern: /(^|\/)vitest\.config\./, why: 'test config' },
  { pattern: /(^|\/)tsconfig.*\.json$/, why: 'build config' },
  { pattern: /\.tsbuildinfo$/, why: 'build cache' },
  { pattern: /(^|\/)\.git(\/|$)/, why: 'git metadata' },
  { pattern: /\.(sqlite|db)$/, why: 'database file' },
  { pattern: /(^|\/)generated\//, why: 'generated Prisma client (regenerated on install)' },
];

// ---------------------------------------------------------------------------
// Reading a tarball without a dependency
// ---------------------------------------------------------------------------

/**
 * Parses the gzipped tar npm produces, far enough to list names and read bodies.
 *
 * Shelling out to `tar` was the first attempt and it is not portable here: the
 * GNU tar that ships with Git Bash reads `C:/...` as a remote host and tries to
 * open an ssh connection to a machine called C. Forty lines of header walking
 * is the boring answer.
 */
function listTarball(file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const entries = [];
  let offset = 0;
  let longName = null;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]);

    offset += 512;
    const dataBlocks = Math.ceil(size / 512) * 512;

    if (type === 'L') {
      // GNU long-name extension: the next header's real name lives in this body.
      longName = buf.subarray(offset, offset + size).toString('utf8').replace(/\0.*$/, '');
      offset += dataBlocks;
      continue;
    }

    const name = longName ?? (prefix ? prefix + '/' + rawName : rawName);
    longName = null;

    if (type === '0' || type === '\0') {
      const start = offset;
      entries.push({ name, size, body: () => buf.subarray(start, start + size) });
    }
    offset += dataBlocks;
  }

  return entries;
}

/** npm nests everything under `package/`; nobody wants to read that prefix. */
const strip = (name) => name.replace(/^package\//, '');

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkEntrypoints(manifest, files) {
  const problems = [];
  const has = (p) => files.includes(path.posix.normalize(String(p).replace(/^\.\//, '')));

  const claim = (label, value) => {
    if (value === undefined || value === null) return;
    if (!has(value)) problems.push(label + ' points at ' + value + ', which is not in the tarball');
  };

  claim('main', manifest.main);
  claim('types', manifest.types);

  for (const [name, target] of Object.entries(manifest.bin ?? {})) {
    claim('bin.' + name, target);
  }

  const walkExports = (node, trail) => {
    if (typeof node === 'string') return claim('exports' + trail, node);
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walkExports(child, trail + '[' + key + ']');
    }
  };
  walkExports(manifest.exports, '');

  return problems;
}

function checkDependencyRanges(manifest) {
  const problems = [];
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range === 'string' && /^(workspace|link|file):/.test(range)) {
        problems.push(field + '.' + dep + ' is "' + range + '" — npm cannot install that');
      }
    }
  }
  return problems;
}

function checkShebang(entries, manifest) {
  const problems = [];
  for (const [name, target] of Object.entries(manifest.bin ?? {})) {
    const wanted = 'package/' + String(target).replace(/^\.\//, '');
    const entry = entries.find((e) => e.name === wanted);
    if (!entry) continue; // already reported by checkEntrypoints
    if (entry.body().subarray(0, 2).toString('utf8') !== '#!') {
      problems.push('bin.' + name + ' (' + target + ') has no shebang — a global install cannot run it');
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function run(command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // pnpm is a .cmd shim on Windows; execFile will not find it otherwise.
    shell: process.platform === 'win32',
  });
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offcut-publish-check-'));
let failures = 0;

console.log('OFFCUT publish check — dry run, nothing is published.');
console.log('tarballs: ' + outDir + '\n');

for (const pkg of PACKAGES) {
  console.log('-- ' + pkg.name + ' ' + '-'.repeat(Math.max(0, 55 - pkg.name.length)));

  if (!skipBuild) {
    process.stdout.write('   building... ');
    try {
      run('pnpm', ['--filter', pkg.name, 'build']);
      console.log('ok');
    } catch (error) {
      console.log('FAILED');
      const output = ((error.stdout ?? '') + (error.stderr ?? '')).trim();
      console.log('   ' + output);
      // The failure everyone hits first, and the message does not say why: a
      // running `pnpm dev` has the Prisma query engine DLL open, and Windows
      // will not let the build replace a loaded DLL. Stop dev, build, restart.
      if (/EPERM|EBUSY/.test(output)) {
        console.log('   -> a running `pnpm dev` holds the Prisma engine DLL open. Stop it and run this again.');
      }
      failures += 1;
      continue;
    }
  }

  let tarball;
  try {
    const output = run('pnpm', ['--filter', pkg.name, 'pack', '--pack-destination', outDir]);
    tarball = output
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.tgz'))
      .pop();
  } catch (error) {
    console.log('   pack FAILED\n   ' + ((error.stdout ?? '') + (error.stderr ?? '')).trim());
    failures += 1;
    continue;
  }

  if (!tarball || !fs.existsSync(tarball)) {
    console.log('   pack produced no tarball');
    failures += 1;
    continue;
  }

  const entries = listTarball(tarball);
  const files = entries.map((e) => strip(e.name)).sort();
  const manifestEntry = entries.find((e) => strip(e.name) === 'package.json');

  if (!manifestEntry) {
    console.log('   tarball has no package.json');
    failures += 1;
    continue;
  }

  const manifest = JSON.parse(manifestEntry.body().toString('utf8'));
  const sizeKb = (fs.statSync(tarball).size / 1024).toFixed(1);
  console.log('   ' + path.basename(tarball) + '  ' + files.length + ' files, ' + sizeKb + ' kB');

  const allowed = [...ALWAYS_ALLOWED, ...pkg.extraAllowed];
  const problems = [];

  for (const file of files) {
    const forbidden = FORBIDDEN.find((rule) => rule.pattern.test(file));
    if (forbidden) {
      problems.push('forbidden: ' + file + ' (' + forbidden.why + ')');
      continue;
    }
    if (!allowed.some((rule) => rule.test(file))) {
      problems.push('unexpected: ' + file + ' (not dist, README, LICENSE or package.json)');
    }
  }

  for (const required of ['package.json', 'README.md', 'LICENSE']) {
    if (!files.includes(required)) problems.push('missing: ' + required);
  }

  problems.push(...checkEntrypoints(manifest, files));
  problems.push(...checkDependencyRanges(manifest));
  problems.push(...checkShebang(entries, manifest));

  // The listing is the point of the exercise, so it is always printed — folded
  // per directory once dist gets long, because fifty lines of dist/*.js teaches
  // nobody anything.
  const groups = new Map();
  for (const file of files) {
    const dir = file.includes('/') ? file.split('/')[0] + '/' : '';
    groups.set(dir, (groups.get(dir) ?? []).concat(file));
  }
  for (const [dir, members] of groups) {
    if (dir && members.length > 6) {
      console.log('     ' + dir + '  ' + members.length + ' files');
      for (const m of members.slice(0, 3)) console.log('       ' + m);
      console.log('       ... ' + (members.length - 3) + ' more');
    } else {
      for (const m of members) console.log('     ' + m);
    }
  }

  if (problems.length > 0) {
    failures += problems.length;
    console.log('');
    for (const problem of problems) console.log('   x ' + problem);
  } else {
    console.log('   ok  contents, entrypoints and dependency ranges all check out');
  }

  const deps = Object.entries(manifest.dependencies ?? {})
    .map(([d, r]) => d + '@' + r)
    .join(', ');
  if (deps) console.log('   deps: ' + deps);
  console.log('');
}

// ---------------------------------------------------------------------------
// The commands, spelled out
// ---------------------------------------------------------------------------

console.log('-'.repeat(60));

if (failures > 0) {
  console.log('\n' + failures + ' problem' + (failures === 1 ? '' : 's') + '. Fix them before publishing.\n');
} else {
  console.log(
    '\nEverything packs clean. Nothing has been published.\n' +
      '\nPublish, in this order — core first, because the other two depend on it:\n' +
      '\n  npm login                 # once, on this machine (or set NPM_TOKEN)' +
      '\n  pnpm publish --filter @offcut/core       --access public --no-git-checks' +
      '\n  pnpm publish --filter @offcut/sdk        --access public --no-git-checks' +
      '\n  pnpm publish --filter @offcut/mcp-server --access public --no-git-checks\n' +
      '\nWhat a stranger then runs:\n' +
      '\n  npm i @offcut/sdk               # the TypeScript interface' +
      '\n  npx @offcut/mcp-server --help   # the MCP server; npx needs no install\n' +
      '\nand the MCP client config that goes with it — "command": "npx",' +
      '\n"args": ["-y", "@offcut/mcp-server"], key in "env" — is written for them by:\n' +
      '\n  node scripts/mcp-config.mjs --npx --install\n'
  );
}

if (keep) {
  console.log('tarballs kept: ' + outDir);
} else {
  fs.rmSync(outDir, { recursive: true, force: true });
}

process.exit(failures > 0 ? 1 : 0);
