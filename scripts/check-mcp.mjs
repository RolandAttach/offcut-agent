#!/usr/bin/env node
/**
 * End-to-end check that the MCP server actually works when an MCP CLIENT starts
 * it — not when we start it ourselves from the repository root.
 *
 * That distinction is the whole point of this script. `pnpm mcp` runs the server
 * with the repository as the working directory, with the full developer
 * environment, from a shell that already has node on PATH. Claude Desktop and
 * Cursor do none of those things: they spawn the process from their own working
 * directory with whatever environment the desktop session hands them. A server
 * that only works under `pnpm mcp` looks healthy and still fails for every real
 * user, and the failure is invisible — the client shows "no tools" and nothing
 * explains why.
 *
 * So this harness deliberately behaves like the least forgiving client it can:
 *
 *   - working directory is the filesystem root, never the repository
 *   - the environment is stripped to what a GUI application actually passes on
 *   - the server is addressed by absolute path, as a client config must
 *   - it speaks real JSON-RPC over stdio and reads real answers back
 *
 * It then runs a full round trip: initialize, list the tools, write a record,
 * read it back, and delete it. Anything less would pass while the store is
 * pointed at the wrong file, which is the exact failure this was written for.
 *
 * The check mints a throwaway agent and revokes it afterwards, so running it
 * leaves nothing behind but an audit trail entry.
 *
 *   node scripts/check-mcp.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const serverEntry = path.join(repoRoot, 'apps', 'mcp-server', 'dist', 'index.js');

// Imported by URL, not by path: on Windows the ESM loader rejects a bare
// `C:\...` string, and this file is a sibling of the package rather than a
// dependency of it, so there is no bare specifier to use instead.
const core = await import(new URL('../packages/core/dist/index.js', import.meta.url).href);
const { createAgent, authenticateUser, getPrisma, disconnectPrisma, revokeAgent } = core;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];

function pass(name, detail) {
  results.push({ ok: true, name, detail });
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  results.push({ ok: false, name, detail });
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Stops with an explanation rather than a stack trace. Everything this script
 * can refuse to start over is a setup step the reader can actually perform.
 */
function abort(message, remedy) {
  console.error(`\n${message}\n`);
  if (remedy) console.error(`  ${remedy}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// A minimal environment, the way a desktop application passes one
// ---------------------------------------------------------------------------

/**
 * Desktop clients do not forward a developer shell's environment. On Windows a
 * spawned process still needs a small floor of variables — strip SystemRoot and
 * even DNS resolution stops working — so this keeps that floor and nothing else.
 *
 * Notably absent: DATABASE_URL, OFFCUT_DATA_DIR, NODE_ENV, and anything else the
 * repository's own tooling sets. If the server needs one of those to find its
 * store, it must read it from a file it locates itself, because no client will
 * ever supply it.
 */
function desktopEnvironment(extra) {
  const floor = [
    'SystemRoot',
    'windir',
    'COMSPEC',
    'PATHEXT',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'HOME',
  ];

  const env = {};
  for (const key of floor) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  // PATH is kept because the client resolves `node` through it; the server
  // itself is addressed absolutely.
  if (process.env.PATH) env.PATH = process.env.PATH;

  return { ...env, ...extra };
}

// ---------------------------------------------------------------------------
// A very small MCP client
// ---------------------------------------------------------------------------

/**
 * The stdio transport frames messages as newline-delimited JSON. That is the
 * entire wire format, so implementing it here is cheaper than depending on the
 * SDK — and it means this check exercises the server the way a foreign client
 * does rather than the way our own library happens to.
 */
class StdioClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.exited = null;

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          // Anything unparseable on stdout is itself a defect: stdout is the
          // transport and nothing else may write to it.
          this.protocolViolation = line;
          continue;
        }

        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          waiter(message);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });

    child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      for (const waiter of this.pending.values()) {
        waiter({ error: { message: `server exited (code ${code}, signal ${signal})` } });
      }
      this.pending.clear();
    });
  }

  request(method, params, timeoutMs = 20_000) {
    if (this.exited) {
      return Promise.resolve({
        error: { message: `server already exited (code ${this.exited.code})` },
      });
    }

    const id = this.nextId++;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `timed out after ${timeoutMs}ms` } });
      }, timeoutMs);

      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });

      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

/** Tool results arrive as a text block holding JSON; this is the unwrapping. */
function toolPayload(response) {
  const text = response?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

if (!fs.existsSync(serverEntry)) {
  abort(
    `The MCP server is not built: ${serverEntry} does not exist.`,
    'Run: pnpm --filter @offcut/mcp-server build'
  );
}

const prisma = getPrisma();

const workspace = await prisma.workspace.findFirst({
  orderBy: { createdAt: 'asc' },
  select: { id: true, name: true, slug: true, ownerId: true },
});

if (!workspace) {
  await disconnectPrisma();
  abort(
    'There is no workspace in the store, so there is nothing for an agent to connect to.',
    'Run: pnpm setup'
  );
}

const owner = await authenticateUser(workspace.ownerId);

const minted = await createAgent(owner, workspace.id, {
  name: `mcp-selfcheck`,
  kind: 'lead',
  description: 'Temporary agent created by scripts/check-mcp.mjs. Revoked when the check finishes.',
  // Granted explicitly, because §3.5 does not grant it: "lead" is a name, not an
  // authority, so canForget is off even for a lead unless the owner says
  // otherwise. This check needs it to clear up after itself — and an earlier
  // version did not ask for it, had its cleanup correctly refused, ignored the
  // refusal, and left a record behind on every single run.
  permissions: { canForget: true },
});

console.log(`\nOFFCUT MCP connection check`);
console.log(`  workspace   ${workspace.name} (${workspace.slug})`);
console.log(`  server      ${serverEntry}`);
console.log(`  spawned as  ${process.execPath}`);
console.log(`  working dir ${path.parse(repoRoot).root}   (deliberately not the repository)`);
console.log(`  environment stripped to a desktop floor + OFFCUT_API_KEY\n`);

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const child = spawn(process.execPath, [serverEntry], {
  // The filesystem root: no client will ever start us inside the repository, and
  // anything that resolves a path relative to the working directory breaks here.
  cwd: path.parse(repoRoot).root,
  env: desktopEnvironment({ OFFCUT_API_KEY: minted.apiKey }),
  stdio: ['pipe', 'pipe', 'pipe'],
});

const client = new StdioClient(child);

let writtenRecordId = null;

try {
  // -- 1. Handshake ---------------------------------------------------------
  const initialize = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'offcut-check-mcp', version: '1.0.0' },
  });

  if (initialize.error) {
    fail('handshake', initialize.error.message);
  } else if (initialize.result?.serverInfo?.name !== 'offcut-agent') {
    fail('handshake', `unexpected server identity: ${JSON.stringify(initialize.result?.serverInfo)}`);
  } else {
    pass(
      'handshake',
      `${initialize.result.serverInfo.name} ${initialize.result.serverInfo.version}, protocol ${initialize.result.protocolVersion}`
    );
  }

  client.notify('notifications/initialized', {});

  // -- 2. The store the client actually reached -----------------------------
  // A server that starts but resolved a relative database path against the
  // working directory will authenticate against an empty file. The handshake
  // above still succeeds, because authentication happens before it — so this
  // is really a check that the key minted a moment ago is visible from there.
  const listed = await client.request('tools/list', {});

  if (listed.error) {
    fail('tools/list', listed.error.message);
  } else {
    const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
    const expected = [
      'offcut_memory_add',
      'offcut_memory_export',
      'offcut_memory_forget',
      'offcut_memory_import',
      'offcut_memory_inspect',
      'offcut_memory_merge',
      'offcut_memory_recall',
      'offcut_memory_resolve',
    ];

    const missing = expected.filter((name) => !names.includes(name));
    if (missing.length > 0) {
      fail('tools/list', `missing: ${missing.join(', ')}`);
    } else {
      pass('tools/list', `${names.length} tools`);
    }

    const described = (listed.result?.tools ?? []).filter(
      (tool) => typeof tool.description === 'string' && tool.description.length > 40
    );
    if (described.length === names.length) {
      pass('tool descriptions', 'every tool explains itself to a model');
    } else {
      fail('tool descriptions', `${names.length - described.length} tools are underdescribed`);
    }
  }

  // -- 3. A real write ------------------------------------------------------
  const marker = `mcp-selfcheck-${minted.agent.id}`;

  const added = await client.request('tools/call', {
    name: 'offcut_memory_add',
    arguments: {
      workspaceId: workspace.id,
      type: 'result',
      text: `Connection check from an MCP client. Marker ${marker}.`,
      topic: 'mcp-selfcheck',
      source: 'scripts/check-mcp.mjs',
      idempotencyKey: marker,
    },
  });

  const addPayload = toolPayload(added);

  if (added.error) {
    fail('write a record', added.error.message);
  } else if (added.result?.isError) {
    // This is where a store mismatch surfaces: the key exists in the repository
    // database but not in whatever file the server actually opened.
    fail('write a record', JSON.stringify(addPayload?.error ?? addPayload));
  } else if (!addPayload?.recordId) {
    fail('write a record', `no recordId in the reply: ${JSON.stringify(addPayload)}`);
  } else {
    writtenRecordId = addPayload.recordId;
    pass('write a record', `recordId ${writtenRecordId}, version ${addPayload.version}`);
  }

  // -- 4. Read it back ------------------------------------------------------
  if (writtenRecordId) {
    const recalled = await client.request('tools/call', {
      name: 'offcut_memory_recall',
      arguments: { workspaceId: workspace.id, query: marker, topic: 'mcp-selfcheck' },
    });

    const recallPayload = toolPayload(recalled);
    const found = JSON.stringify(recallPayload ?? {}).includes(marker);

    if (recalled.error || recalled.result?.isError) {
      fail('read it back', JSON.stringify(recallPayload?.error ?? recalled.error));
    } else if (!found) {
      fail('read it back', 'the record just written was not returned');
    } else {
      pass('read it back', 'the write and the read reached the same store');
    }
  }

  // -- 5. Errors are information, not crashes -------------------------------
  const denied = await client.request('tools/call', {
    name: 'offcut_memory_add',
    arguments: { workspaceId: workspace.id, type: 'result', text: '', topic: '' },
  });

  const deniedPayload = toolPayload(denied);

  // The code matters as much as the fact that it answered. A model that reads
  // VALIDATION knows to fix its arguments and call again; one that reads UNKNOWN
  // has been told only that something broke. This check asserts the useful one,
  // because UNKNOWN is exactly what the server used to return here.
  if (denied.error) {
    fail('a bad call answers instead of dying', `protocol-level failure: ${denied.error.message}`);
  } else if (!denied.result?.isError) {
    fail('a bad call answers instead of dying', `expected a tool error, got ${JSON.stringify(deniedPayload)}`);
  } else if (deniedPayload?.error?.code !== 'VALIDATION') {
    fail(
      'a bad call answers instead of dying',
      `expected code VALIDATION, got ${deniedPayload?.error?.code}: ${deniedPayload?.error?.message}`
    );
  } else {
    pass('a bad call answers instead of dying', `VALIDATION — "${deniedPayload.error.message}"`);
  }

  // -- 6. stdout carries the protocol and nothing else ----------------------
  if (client.protocolViolation) {
    fail('stdout is protocol-only', `stray output: ${client.protocolViolation.slice(0, 120)}`);
  } else {
    pass('stdout is protocol-only', 'diagnostics went to stderr, where they belong');
  }

  // -- 7. Clean up after itself, and prove it ------------------------------
  //
  // Asserted rather than fired and forgotten. A cleanup whose result nobody
  // reads is a cleanup that can silently stop working — which is exactly what
  // happened here once, leaving a record in the user's workspace per run.
  if (writtenRecordId) {
    const forgotten = await client.request('tools/call', {
      name: 'offcut_memory_forget',
      arguments: {
        workspaceId: workspace.id,
        recordId: writtenRecordId,
        reason: 'connection check',
        idempotencyKey: `${marker}-forget`,
      },
    });

    const forgetPayload = toolPayload(forgotten);

    if (forgotten.error || forgotten.result?.isError) {
      fail('clean up after itself', JSON.stringify(forgetPayload?.error ?? forgotten.error));
    } else {
      // Verified against the store rather than taken from the reply: deletion is
      // the operation where "it said OK" and "it is gone" must not be confused.
      const survivor = await prisma.memoryRecord.findFirst({
        where: { workspaceId: workspace.id, recordId: writtenRecordId, deletedAt: null },
        select: { id: true },
      });

      if (survivor) {
        fail('clean up after itself', 'the record was reported deleted but is still present');
      } else {
        pass('clean up after itself', 'nothing left behind in the workspace');
      }
    }
  }
} finally {
  client.close();

  try {
    await revokeAgent(owner, workspace.id, minted.agent.id);
  } catch (error) {
    console.error(`  (could not revoke the temporary agent: ${error?.message ?? error})`);
  }

  await disconnectPrisma();
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const failures = results.filter((result) => !result.ok);

console.log('');

if (failures.length === 0) {
  console.log('All checks passed. An MCP client can start this server and use it.\n');
  process.exit(0);
}

console.log(`${failures.length} check${failures.length === 1 ? '' : 's'} failed.\n`);

if (client.stderr.trim()) {
  console.log('Server stderr:');
  for (const line of client.stderr.trim().split(/\r?\n/)) console.log(`  ${line}`);
  console.log('');
}

process.exit(1);
