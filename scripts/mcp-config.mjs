#!/usr/bin/env node
/**
 * Writes the MCP client configuration, so nobody has to hand-edit JSON.
 *
 * OPEN-1 of the specification asks which MCP clients are supported and how they
 * hand tools and separate permissions to subagents. The answer given is Claude
 * Desktop and Cursor, and this script is the operational half of that answer.
 *
 * Three things here are not obvious, and each one is a failure people hit:
 *
 * 1. `"command": "node"` is wrong on Windows. A desktop client spawns the server
 *    from a GUI process whose PATH is whatever the login session had — often
 *    without the Node installation the developer added to their shell. So the
 *    config is written with the ABSOLUTE path to the running node binary. It
 *    looks uglier and it works.
 *
 * 2. The key goes in `env`, never in a tool argument. SS3.2 puts identity in the
 *    connection: a model cannot talk its way into another agent's identity
 *    because identity is not something it can address. That property only holds
 *    if the key arrives out of band.
 *
 * 3. One key per client. SS4.2 is blunt about the consequence of sharing: if one
 *    key is handed to several subagents the server sees ONE principal and will
 *    not pretend otherwise. So each client gets its own agent, and revoking one
 *    does not disturb the other.
 *
 * Usage:
 *
 *   node scripts/mcp-config.mjs                 show the config for both clients
 *   node scripts/mcp-config.mjs --install       write it into both client configs
 *   node scripts/mcp-config.mjs --install=claude
 *   node scripts/mcp-config.mjs --install=cursor
 *   node scripts/mcp-config.mjs --key offcut_sk_...   use a key you already have
 *   node scripts/mcp-config.mjs --npx           point the config at @offcut/mcp-server on npm
 *   node scripts/mcp-config.mjs --local         point it at this checkout's build
 *   node scripts/mcp-config.mjs --server https://offcut.tech --key offcut_sk_...
 *                                               point it at an OFFCUT SERVER
 *
 * With neither --npx nor --local it uses the checkout's build when there is one
 * and npx when there is not.
 *
 * 4. --server changes WHICH STORE the client reaches, not which binary it runs.
 *    It writes OFFCUT_API_URL into the env block, and the server then talks to
 *    that site over HTTPS and opens no database here. It requires --key,
 *    because a key exists only in the store that minted it: this script can
 *    mint one in the local database and has no business minting one in
 *    somebody's server. Take that key from the server's own console.
 *
 * Existing config files are merged, never replaced, and backed up first.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const serverEntry = path.join(repoRoot, 'apps', 'mcp-server', 'dist', 'index.js');

/**
 * Loaded on demand, not at the top of the file.
 *
 * Importing the core builds its Prisma client, and with --server there is no
 * local store in this story at all - the key was minted somewhere else and the
 * memory lives there. Opening a database to print a config file would be the
 * same confusion this flag exists to end.
 */
async function loadCore() {
  return import(new URL('../packages/core/dist/index.js', import.meta.url).href);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function flag(name) {
  return argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function value(name) {
  const found = flag(name);
  if (!found) return null;
  if (found.includes('=')) return found.slice(found.indexOf('=') + 1);
  const index = argv.indexOf(found);
  const next = argv[index + 1];
  return next && !next.startsWith('--') ? next : '';
}

const installArg = flag('install') ? (value('install') || 'both') : null;
const providedKey = value('key');

/** An OFFCUT server to address instead of this machine's store. */
const serverUrl = flag('server') ? value('server') : null;

if (flag('server') && !serverUrl) {
  console.error('\n--server needs a URL, e.g. --server https://offcut.tech\n');
  process.exit(2);
}

if (serverUrl && !providedKey) {
  console.error(
    `\n--server ${serverUrl} needs --key as well.\n\n` +
      `  A key exists only in the store that minted it. Create an agent in the console at\n` +
      `  ${serverUrl.replace(/\/+$/, '')} (Agents -> New agent), copy the key it shows once,\n` +
      `  and pass it here:\n\n` +
      `    node scripts/mcp-config.mjs --server ${serverUrl} --key offcut_sk_...\n`
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Where each client keeps its configuration
// ---------------------------------------------------------------------------

/**
 * Where Claude Desktop actually reads its configuration from on Windows.
 *
 * There are two answers, and picking the wrong one fails silently — no error, no
 * log line, the server simply never appears.
 *
 * The Windows installer is now MSIX (Store/WinGet), and MSIX redirects a
 * packaged app's %APPDATA% writes into its own container. So the app believes it
 * is reading %APPDATA%\Claude\claude_desktop_config.json while the file it truly
 * reads lives at
 *
 *   %LOCALAPPDATA%\Packages\Claude_<publisher>\LocalCache\Roaming\Claude\
 *
 * On this machine the documented %APPDATA%\Claude directory does not exist at
 * all, while the container copy does and is written by the app. Only the legacy
 * standalone .exe install uses the documented path.
 *
 * The container is found by looking for it rather than by hardcoding the
 * publisher suffix, which changes between builds.
 */
function claudeDesktopConfigFile() {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const roamingAppData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');

  const documented = path.join(roamingAppData, 'Claude', 'claude_desktop_config.json');

  const packages = path.join(localAppData, 'Packages');
  if (fs.existsSync(packages)) {
    for (const entry of fs.readdirSync(packages)) {
      if (!entry.startsWith('Claude_')) continue;

      const container = path.join(packages, entry, 'LocalCache', 'Roaming', 'Claude');
      if (fs.existsSync(container)) {
        return { file: path.join(container, 'claude_desktop_config.json'), packaged: true };
      }
    }
  }

  return { file: documented, packaged: false };
}

const claudeLocation = claudeDesktopConfigFile();

/**
 * Both clients use the same `mcpServers` shape, which is why one generator can
 * serve both. They differ only in where the file lives and in how they report a
 * server that failed to start.
 */
const CLIENTS = {
  claude: {
    label: 'Claude Desktop',
    file: claudeLocation.file,
    // Worth saying out loud, because the app's own Settings → Developer → Edit
    // Config button opens the OTHER file on a packaged install — so following
    // the official instructions edits a file nothing reads.
    note: claudeLocation.packaged
      ? 'Installed from the Store/WinGet, so the live config is inside the package container.\n             Settings → Developer → "Edit Config" opens a different file that is never read.'
      : null,
    installedHint: 'Quit Claude Desktop completely (from the tray, not just the window) and reopen it.',
    whereToLook:
      'The tools appear behind the tools icon in the message box. Logs: %LOCALAPPDATA%\\Claude\\logs\\',
  },
  cursor: {
    label: 'Cursor',
    file: path.join(os.homedir(), '.cursor', 'mcp.json'),
    note: 'This is the global config, so the server is available in every project.',
    installedHint: 'Quit Cursor and reopen it, then open Customize → MCP and make sure the toggle is ON.',
    whereToLook:
      'Customize → MCP lists the server with its tools. If it did not connect: Ctrl+Shift+U, pick\n             "MCP Logs" in the dropdown, and read the FIRST error rather than the last.',
  },
};

// ---------------------------------------------------------------------------
// What the client should actually spawn
// ---------------------------------------------------------------------------

/**
 * Two ways to start the server, and the config has to name one of them.
 *
 *   --local   node <repo>/apps/mcp-server/dist/index.js
 *   --npx     npx -y @offcut/mcp-server        (published on npm)
 *
 * With neither flag it picks: the checkout's own build if it is there, npx
 * otherwise. That ordering is deliberate. Someone running this from a checkout
 * is almost always testing a change they just made, and pointing their client
 * at the registry copy would quietly test somebody else's code. Someone running
 * it without a build has no local copy to test.
 *
 * `npx` has the same PATH problem `node` has, and for the same reason: a client
 * launched from a desktop icon inherits the login session's PATH, which often
 * has no Node in it. So when the npm CLI can be found next to the running node
 * binary, the config spawns `node <npx-cli.js>` by absolute path rather than the
 * bare word `npx`. If it cannot be found, the bare word is written and the
 * caller is told why that may not survive a GUI launch.
 */
function npxCliPath() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function resolveLauncher() {
  const wantsNpx = Boolean(flag('npx'));
  const wantsLocal = Boolean(flag('local'));

  if (wantsNpx && wantsLocal) {
    return { error: '\n--npx and --local are opposites; pass one or neither.\n' };
  }

  const built = fs.existsSync(serverEntry);

  if (wantsLocal && !built) {
    return {
      error: `\n--local was asked for, but the MCP server is not built: ${serverEntry} does not exist.\n\n  Run: pnpm build\n`,
    };
  }

  if (!wantsNpx && built) {
    return {
      label: `${serverEntry}  (this checkout)`,
      // Absolute, for the PATH reason in the header comment.
      spawn: { command: process.execPath, args: [serverEntry] },
    };
  }

  const cli = npxCliPath();

  if (cli) {
    return {
      label: '@offcut/mcp-server from npm  (npx -y)',
      spawn: { command: process.execPath, args: [cli, '-y', '@offcut/mcp-server'] },
    };
  }

  return {
    label: '@offcut/mcp-server from npm  (bare "npx" — see the note below)',
    note:
      'npm\'s npx-cli.js was not found next to this node binary, so the config says "npx".\n' +
      '             A client launched from a desktop icon may not have npx on its PATH; if the\n' +
      '             server never appears, put the absolute path to npx in "command".',
    spawn: { command: 'npx', args: ['-y', '@offcut/mcp-server'] },
  };
}

// ---------------------------------------------------------------------------
// The configuration itself
// ---------------------------------------------------------------------------

function serverBlock(apiKey) {
  // OFFCUT_API_URL first, because it is the line that decides which store the
  // key is checked against - and the one a person reads to tell the two
  // configurations apart at a glance.
  const env = serverUrl
    ? { OFFCUT_API_URL: serverUrl, OFFCUT_API_KEY: apiKey }
    : { OFFCUT_API_KEY: apiKey };
  return { ...launcher.spawn, env };
}

/**
 * Merges our entry into whatever is already there.
 *
 * A user may well have other MCP servers configured, and silently dropping them
 * because we wrote the file from scratch would be a far worse bug than anything
 * this script is meant to fix.
 */
function mergeConfig(existing, apiKey) {
  const config = existing && typeof existing === 'object' ? { ...existing } : {};
  const servers = { ...(config.mcpServers ?? {}) };
  servers.offcut = serverBlock(apiKey);
  return { ...config, mcpServers: servers };
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    // A malformed file is not ours to silently overwrite — it may contain work.
    throw new Error(
      `${file} exists but is not valid JSON (${error.message}). Fix or move it, then run this again.`
    );
  }
}

function writeConfig(client, existing, apiKey) {
  if (existing) {
    const backup = `${client.file}.offcut-backup`;
    fs.copyFileSync(client.file, backup);
    console.log(`  backed up  ${backup}`);
  }

  fs.mkdirSync(path.dirname(client.file), { recursive: true });
  fs.writeFileSync(client.file, `${JSON.stringify(mergeConfig(existing, apiKey), null, 2)}\n`, 'utf8');

  const others = Object.keys(existing?.mcpServers ?? {}).filter((name) => name !== 'offcut');
  console.log(`  wrote      ${client.file}`);
  if (others.length > 0) console.log(`  kept       ${others.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Mints one agent per client.
 *
 * `lead` rather than `subagent` because a human's own editor is the principal
 * that resolves conflicts and merges — SS3.3 reserves those for a lead, and a
 * client that cannot resolve a conflict it surfaced is a dead end.
 */
async function mintKey(workspace, owner, clientLabel) {
  const name = `${clientLabel} (MCP)`;

  const existing = await listAgents(owner, workspace.id);
  const clash = existing.find((agent) => agent.name === name && !agent.revokedAt);

  if (clash) {
    console.log(
      `\n  An agent named "${name}" already exists. A key is shown once and never stored in\n` +
        `  readable form, so this run mints a separate one rather than pretending to recover it.\n` +
        `  Revoke the old one in the console (Agents) if it is no longer in use.`
    );
  }

  const created = await createAgent(owner, workspace.id, {
    name: clash ? `${name} ${existing.filter((agent) => agent.name.startsWith(name)).length + 1}` : name,
    kind: 'lead',
    description: `Connected through MCP from ${clientLabel}.`,
  });

  return created.apiKey;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const launcher = resolveLauncher();

if (launcher.error) {
  console.error(launcher.error);
  process.exit(2);
}

/**
 * The local store is consulted only when the config points at it.
 *
 * With --server the workspace, the owner and the key all live on the other
 * machine, and this script's only job is to write a file. Opening a database
 * to do that would be the same confusion the flag exists to end.
 */
let workspace = null;
let owner = null;
let createAgent = null;
let listAgents = null;
let disconnectPrisma = async () => {};

if (!serverUrl) {
  const core = await loadCore();
  ({ createAgent, listAgents, disconnectPrisma } = core);

  const prisma = core.getPrisma();

  workspace = await prisma.workspace.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, slug: true, ownerId: true },
  });

  if (!workspace) {
    await disconnectPrisma();
    console.error('\nThere is no workspace yet, so there is nothing to connect to.\n\n  Run: pnpm setup\n');
    process.exit(2);
  }

  owner = await core.authenticateUser(workspace.ownerId);
}

const targets =
  installArg === 'claude'
    ? ['claude']
    : installArg === 'cursor'
      ? ['cursor']
      : ['claude', 'cursor'];

console.log(`\nOFFCUT MCP configuration`);
console.log(
  serverUrl
    ? `  store      ${serverUrl}  (remote - the key and the memory live there, not here)`
    : `  store      this machine  (workspace ${workspace.name} / ${workspace.slug})`
);
console.log(`  server     ${launcher.label}`);
console.log(`  node       ${process.execPath}`);
if (launcher.note) console.log(`  note       ${launcher.note}`);

try {
  let failed = 0;

  for (const id of targets) {
    const client = CLIENTS[id];

    console.log(`\n── ${client.label} ${'─'.repeat(Math.max(0, 56 - client.label.length))}`);
    console.log(`  config     ${client.file}`);
    if (client.note) console.log(`  note       ${client.note}`);

    const alreadyThere = fs.existsSync(client.file);
    if (!alreadyThere && !installArg) {
      console.log(`  status     not present yet (the application may not be installed)`);
    }

    if (installArg) {
      // The existing file is read BEFORE a key is minted. Reading can fail — a
      // hand-edited config with a trailing comma is common — and minting first
      // would leave a live credential behind for a client that never got
      // configured. An unused key is not harmless: it is real access to the
      // workspace until somebody notices and revokes it.
      let existing;
      try {
        existing = readJson(client.file);
      } catch (error) {
        failed += 1;
        console.log(`  SKIPPED    ${error.message}`);
        console.log(`  (no key was created for ${client.label})`);
        continue;
      }

      const apiKey = providedKey || (await mintKey(workspace, owner, client.label));

      writeConfig(client, existing, apiKey);
      console.log(`  next       ${client.installedHint}`);
      console.log(`  verify     ${client.whereToLook}`);
    } else {
      // Showing the config is something people do to look at it. Creating a live
      // credential every time someone looks would litter the workspace with
      // agents nobody connected.
      const apiKey = providedKey;

      console.log(`\n  Add this to that file:\n`);
      const snippet = JSON.stringify(
        { mcpServers: { offcut: serverBlock(apiKey ?? 'offcut_sk_PASTE_AN_AGENT_KEY_HERE') } },
        null,
        2
      );
      for (const line of snippet.split('\n')) console.log(`    ${line}`);

      if (!apiKey) {
        console.log(
          `\n  The key is a placeholder. Create an agent in the console (Agents → New agent)\n` +
            `  and paste its key — it is shown once — or let this script mint one with --install.`
        );
      }

      console.log(`\n  Then: ${client.installedHint}`);
      console.log(`  Check: ${client.whereToLook}`);
    }
  }

  if (!installArg) {
    console.log(
      `\n  Or let this script write both files for you:\n\n    pnpm mcp:install\n`
    );
  } else if (failed === targets.length) {
    console.log(`\nNothing was written. Fix the file${targets.length > 1 ? 's' : ''} named above and run this again.\n`);
    process.exitCode = 1;
  } else {
    if (failed > 0) console.log(`\n${failed} client was skipped — see above.`);
    console.log(
      `\nDone. To confirm the server itself works before opening a client:\n\n    pnpm mcp:check\n`
    );
  }

  console.log(
    serverUrl
      ? `  The key in that file is a credential minted by ${serverUrl}. It grants access to\n` +
          `  one workspace there and nothing else, and it can be revoked in that console\n` +
          `  under Agents at any time. Nothing about it is stored on this machine, and no\n` +
          `  database was opened here to write this file.\n`
      : `  The key in that file is a credential. It grants access to this workspace and\n` +
          `  nothing else, it is stored only as a hash here, and it can be revoked in the\n` +
          `  console under Agents at any time.\n`
  );
} finally {
  await disconnectPrisma();
}
