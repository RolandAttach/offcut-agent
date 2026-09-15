#!/usr/bin/env node
/**
 * OFFCUT AGENT MCP server (stdio).
 *
 * Connect it to an MCP client by adding this to the client's config:
 *
 *   {
 *     "mcpServers": {
 *       "offcut": {
 *         "command": "npx",
 *         "args": ["-y", "@offcut/mcp-server"],
 *         "env": { "OFFCUT_API_KEY": "offcut_sk_..." }
 *       }
 *     }
 *   }
 *
 * The key comes from the environment, never from a tool argument. That is the
 * "verified connection" of SS3.2: a model cannot talk its way into another
 * identity, because identity is not something it can address.
 *
 * TWO STORES, one variable. Without OFFCUT_API_URL this server opens the local
 * SQLite store, which is what SS7 calls the first release and what the default
 * stays. With OFFCUT_API_URL it talks to that OFFCUT server over HTTPS and
 * opens no database at all. The distinction is not cosmetic: a key minted on a
 * server exists in that server's database and nowhere else, so pointing the
 * local mode at a key from the site produced "could not authenticate" without
 * ever making a request. One store, named out loud, both ways.
 *
 * A caveat SS4.2 insists on stating rather than papering over: if a client hands
 * one key to several subagents, this server sees ONE principal. It will not
 * pretend to isolate agents it cannot tell apart.
 */

/**
 * `--help` and `--version` are answered HERE, above the imports, on purpose.
 *
 * Importing @offcut/core opens the generated Prisma client at module load, and
 * that client only exists after `prisma generate` has run. The one person most
 * likely to type `--help` is the stranger who just ran `npx @offcut/mcp-server`
 * and wants to know what it is before wiring a key into a client config — the
 * machine where generation is least likely to have happened. A help flag that
 * needs a database is not a help flag.
 *
 * tsc emits each import as a `require` at the position it occupies in the
 * source, so a statement placed before them really does run first.
 *
 * The same reasoning now covers the whole remote mode, not just `--help`: core
 * is imported by `await import(...)` inside the local branch below, so a
 * process pointed at a server never loads it, never generates a client and
 * never creates a file. Everything else imported here is type-only or has no
 * database in it.
 */
const VERSION = '3.2.0';

const USAGE = `offcut-mcp ${VERSION} - OFFCUT AGENT memory over MCP (stdio).

This is not a command you run by hand. An MCP client spawns it and talks to it
on stdin and stdout; everything it prints for a person goes to stderr.

Usage:
  offcut-mcp                 run the server on stdio (what the client does)
  offcut-mcp --help          this text
  offcut-mcp --version       print the version

TWO STORES. The key you have decides which one you want, because a key only
exists in the store that minted it.

  A key from a server's console (https://offcut.tech, or your own deployment):

    claude mcp add offcut -e OFFCUT_API_URL=https://offcut.tech -e OFFCUT_API_KEY=offcut_sk_... -- npx -y @offcut/mcp-server

    Every operation goes to that server over HTTPS and no database is opened on
    this machine. What you save appears in that console, and is read by every
    other agent in that workspace.

  A key minted on this machine (pnpm mcp:install, or the SDK):

    claude mcp add offcut -e OFFCUT_API_KEY=offcut_sk_... -- npx -y @offcut/mcp-server

    Memory lives in a SQLite file under ~/.offcut/ and never leaves the
    machine. Nothing is sent anywhere. A server's console cannot see it.

Environment:
  OFFCUT_API_KEY   required. An agent key (offcut_sk_...) minted by a workspace
                   owner, in the console of the store you are addressing.
                   Identity lives in the connection, not in a tool argument, so
                   a model cannot talk its way into another agent.
  OFFCUT_API_URL   optional. An OFFCUT server, e.g. https://offcut.tech. Set it
                   and the store is remote; leave it unset and the store is the
                   local file.
  OFFCUT_DATA_DIR  optional, local mode only. Where the store lives.
                   Default: ~/.offcut/
  OFFCUT_DATABASE_URL  optional, local mode only. Moves just the SQLite file.

Client configuration (Claude Desktop, Cursor - same shape, different file):

  {
    "mcpServers": {
      "offcut": {
        "command": "npx",
        "args": ["-y", "@offcut/mcp-server"],
        "env": {
          "OFFCUT_API_URL": "https://offcut.tech",
          "OFFCUT_API_KEY": "offcut_sk_..."
        }
      }
    }
  }

Drop OFFCUT_API_URL from that env block for the local store.

One key per client. Hand one key to several subagents and this server sees ONE
principal; it will not pretend to isolate agents it cannot tell apart.

Tools, listed by the client once it connects: offcut_memory_add,
offcut_memory_import, offcut_memory_merge, offcut_memory_recall,
offcut_memory_inspect, offcut_memory_resolve, offcut_memory_forget,
offcut_memory_export, offcut_usage_report.`;

{
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    // stdout, not stderr: a person asked, and no MCP transport is running yet.
    console.log(USAGE);
    process.exit(0);
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION);
    process.exit(0);
  }
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { MemorySurface } from './memory-surface';
import { chooseStore } from './mode';
import { createRemoteMemory, pingServer } from './remote';
import { TOOL_DEFINITIONS, callTool } from './tools';

/**
 * The error shape both stores speak, recognised structurally.
 *
 * It used to be `isOffcutError` from the core - a value import, and therefore a
 * database, for the sake of an instanceof. The core's own filter in apps/api
 * makes the same move for zod errors and for the same reason: two copies of a
 * class are two classes, and what matters is the three fields a model reads.
 */
function describedError(
  error: unknown
): { code: string; message: string; details: Record<string, unknown> } | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return null;
  return {
    code: candidate.code,
    message: candidate.message,
    details:
      typeof candidate.details === 'object' && candidate.details !== null
        ? (candidate.details as Record<string, unknown>)
        : {},
  };
}

/**
 * Opens the local store, lazily.
 *
 * The dynamic import is the whole point: `require('@offcut/core')` at the top
 * of this file would load the generated Prisma client for every process,
 * including the ones whose store is a thousand miles away.
 */
async function openLocalStore(): Promise<MemorySurface> {
  const { Memory, authenticateAgent } = await import('@offcut/core');

  // Read AFTER the import, not before, and this is not tidiness: the core
  // loads .env files on import (packages/core/src/env.ts), and inside a
  // checkout that is where a developer's key lives. Reading the variable first
  // would have told them it was not set while the file that sets it sat
  // unread - a regression the remote mode would have introduced for free.
  const apiKey = process.env.OFFCUT_API_KEY;
  if (!apiKey) {
    console.error(
      'OFFCUT_API_KEY is not set. Create an agent in the console and pass its key in the MCP server env.'
    );
    process.exit(1);
  }

  const principal = await authenticateAgent(apiKey);
  console.error(
    `[offcut] connected as "${principal.kind === 'agent' ? principal.name : 'unknown'}" (local store)`
  );
  return new Memory(principal);
}

/**
 * Points this process at a server.
 *
 * The health check is deliberately not an authentication: there is no endpoint
 * that tells an agent key who it is, and inventing one would be a new surface.
 * What it buys is the difference between a mistyped URL and a working one at
 * the moment the client starts, instead of inside the first tool call.
 */
async function openRemoteStore(baseUrl: string, apiKey: string): Promise<MemorySurface> {
  const health = await pingServer(baseUrl);
  console.error(
    `[offcut] remote store ${baseUrl} (${health.service} ${health.version ?? '?'}) - no local database is opened`
  );
  console.error('[offcut] the key is checked by that server on every call; it is not checked here');
  return createRemoteMemory({ baseUrl, apiKey });
}

async function main(): Promise<void> {
  const choice = chooseStore(process.env);
  if (choice.kind === 'refused') {
    // stderr, never stdout: stdout is the MCP transport.
    console.error(`[offcut] ${choice.message}`);
    process.exit(1);
  }

  if (choice.kind === 'remote' && !process.env.OFFCUT_API_KEY) {
    console.error(
      `OFFCUT_API_KEY is not set. Create an agent in the console at ${choice.baseUrl} and pass its key in the MCP server env.`
    );
    process.exit(1);
  }

  let memory: MemorySurface;
  try {
    memory =
      choice.kind === 'remote'
        ? await openRemoteStore(choice.baseUrl, process.env.OFFCUT_API_KEY as string)
        : await openLocalStore();
  } catch (error) {
    const described = describedError(error);
    console.error(
      `[offcut] could not ${choice.kind === 'remote' ? 'use that server' : 'authenticate'}: ${
        described?.message ?? (error instanceof Error ? error.message : String(error))
      }`
    );
    process.exit(1);
  }

  const server = new Server(
    { name: 'offcut-agent', version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await callTool(memory, name, (args ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      // Errors are returned as tool results rather than protocol failures, so
      // the calling model can read the reason and adjust - a denied permission
      // or a version conflict is information, not a crash. A remote failure
      // arrives in the same three fields, so "the server refused" and "the
      // store refused" read alike to whoever is on the other end.
      const described = describedError(error);
      const payload = described
        ? { error: described }
        : {
            error: {
              code: 'UNKNOWN',
              message: error instanceof Error ? error.message : String(error),
            },
          };

      // Also to stderr: a tool error the model recovers from is invisible to
      // the person watching the client's log, and a wrong URL or a foreign key
      // is exactly the kind of thing they need to see once.
      console.error(`[offcut] ${name}: ${payload.error.code} - ${payload.error.message}`);

      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[offcut] MCP server ready on stdio');
}

main().catch((error) => {
  console.error('[offcut] fatal:', error);
  process.exit(1);
});
