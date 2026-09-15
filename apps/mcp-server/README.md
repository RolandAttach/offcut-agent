# @offcut/mcp-server

Shared memory for teams of agents, exposed over MCP. A subagent in one client saves what it
learned; an agent in another client, on another day, asks a question and gets an answer assembled
from everything that was saved — with references to who said what and which version.

This package is the MCP surface only. Every rule lives in `@offcut/core`, which it calls; there is
no behaviour here that the SDK does not also have.

## Run it

```bash
npx @offcut/mcp-server --help
```

It is not a command you drive by hand. An MCP client spawns it and speaks to it on stdin and
stdout, so everything meant for a person goes to stderr.

## Two stores, and the key decides which one you want

A key exists only in the store that minted it. That is the whole of it, and getting it wrong is
the one failure people hit: a key copied from a website's console does not exist in a SQLite file
on your laptop, and a server told to look in that file will refuse it without ever making a
request.

**A key from a server's console** (`https://offcut.tech`, or your own deployment):

```bash
claude mcp add offcut -e OFFCUT_API_URL=https://offcut.tech -e OFFCUT_API_KEY=offcut_sk_... -- npx -y @offcut/mcp-server
```

Every operation goes to that server over HTTPS with the key as a Bearer token, and **no database is
opened on this machine**. What you save appears in that console, and every other agent in that
workspace can recall it.

**A key minted on this machine** (`pnpm mcp:install`, or the SDK):

```bash
claude mcp add offcut -e OFFCUT_API_KEY=offcut_sk_... -- npx -y @offcut/mcp-server
```

Memory lives in a SQLite file under `~/.offcut/` and never leaves the machine. Nothing is sent
anywhere, and no server's console can see it.

`OFFCUT_API_URL` is the only difference. Unset, this is the local release of §7, unchanged.

When the server cannot be reached, or refuses the key, that is said out loud — on stderr and as the
tool's error. It never falls back to the local store: a write that lands in a file nobody is
looking at, reported as a success, is worse than a failure.

## Wire it into a client

Claude Desktop and Cursor use the same shape in different files:

- Claude Desktop — `%APPDATA%\Claude\claude_desktop_config.json` (on a Store or WinGet install the
  live file is inside the package container; the app's own "Edit Config" button opens a different
  file that nothing reads)
- Cursor — `~/.cursor/mcp.json`

```json
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
```

Drop `OFFCUT_API_URL` from that `env` block for the local store.

If the client is launched from a desktop icon rather than a shell, its PATH may not contain the
Node you installed, and `"npx"` will not resolve. In that case give the absolute path to `npx`
(`where npx` / `which npx`) — uglier, and it works. From a checkout, `node scripts/mcp-config.mjs
--install` writes the whole file for you, mints a key per client, merges what is already there and
backs it up first.

## The key

Keys are minted by a workspace owner, in the console of the store they belong to, or through the
SDK. The key arrives in `env`,
never as a tool argument: identity lives in the connection, so a model cannot talk its way into
another agent's identity because identity is not something it can address.

**One key per client.** Hand one key to several subagents and this server sees ONE principal. It
will not pretend to isolate agents it cannot tell apart.

## Tools

`offcut_memory_add`, `offcut_memory_import`, `offcut_memory_merge`, `offcut_memory_recall`,
`offcut_memory_inspect`, `offcut_memory_resolve`, `offcut_memory_forget`, `offcut_memory_export`,
`offcut_usage_report`. The client lists them with their schemas once it connects.

Errors come back as tool results rather than protocol failures, so the calling model can read the
reason and adjust — a denied permission or a version conflict is information, not a crash.

## Install notes

This depends on `@offcut/core`, which runs `prisma generate` on install, into its own directory —
it will not touch a Prisma client of your own. If that step is skipped (install scripts off,
`--ignore-scripts`, no network), the first connection fails with a message naming the fix:

```bash
npx prisma generate --schema node_modules/@offcut/core/prisma/schema.prisma
```

On **pnpm 10 or newer** the install exits with `ERR_PNPM_IGNORED_BUILDS`; run `pnpm approve-builds`,
allow `@offcut/core` and `@prisma/client`, then `pnpm rebuild @offcut/core`.

With `OFFCUT_API_URL` set none of that is reached: the core is imported only inside the local
branch, so a machine whose Prisma client was never generated still runs fine against a server.

## Where the data goes

With `OFFCUT_API_URL` set: to that server, over HTTPS, and nowhere else. No SQLite file is created,
and `OFFCUT_DATA_DIR` and `OFFCUT_DATABASE_URL` are not read at all — there is no local store to
point at.

Without it:

`~/.offcut/` on the machine that runs this — outside `node_modules`, created on the first call.
`OFFCUT_DATA_DIR` moves the whole directory; `OFFCUT_DATABASE_URL` moves just the SQLite file. The
package reads environment variables only, not your `.env`, and it never reads `DATABASE_URL`: that
one is yours.

SQLite only in this release. PostgreSQL is available from a checkout of the repository.

## License

MIT.
