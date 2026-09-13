# @offcut/core

The memory core behind OFFCUT AGENT: one store that several agents write into and any agent can
read back from, with the merge rules, access checks and versioning that keep it honest.

Most projects want [`@offcut/sdk`](https://www.npmjs.com/package/@offcut/sdk), which is the typed
interface over this package and re-exports the four calls needed to set a store up. Install
`@offcut/core` directly only if you are building another surface on top of it — the SDK, the MCP
server and the HTTP API all do exactly that and add no logic of their own.

## Install

```bash
npm install @offcut/core
```

Installing runs `prisma generate` inside the package (its generated client lives in the package
directory, never in your `node_modules/.prisma`, so it cannot collide with your own Prisma client).
That step downloads a query engine from `binaries.prisma.sh` the first time, and it pulls in the
Prisma CLI — expect roughly 300 MB in `node_modules`.

**If the step did not run** — install scripts disabled, `--ignore-scripts`, or no network — the
first import fails with a message naming this command:

```bash
npx prisma generate --schema node_modules/@offcut/core/prisma/schema.prisma
```

**pnpm 10 and later** refuse install scripts until you approve them, and the install exits 1 with
`ERR_PNPM_IGNORED_BUILDS` listing `@offcut/core`, `@prisma/client`, `@prisma/engines` and
`prisma`. Allow the first two (the other two may stay denied):

```bash
pnpm approve-builds        # or add them under allowBuilds in pnpm-workspace.yaml
pnpm rebuild @offcut/core
```

## Where the data goes

Installed from npm, everything is kept in `~/.offcut/` — outside `node_modules`, so a reinstall
cannot delete it. Nothing is created until the first call; a failed call (wrong key) still creates
the store.

| Variable | Effect |
|---|---|
| `OFFCUT_DATA_DIR` | Moves the whole directory: database, deletion ledger, backup snapshots. |
| `OFFCUT_DATABASE_URL` | Moves only the SQLite file. `file:` paths are resolved against your working directory. Use a dedicated file: the core refuses to create its tables inside a database that already holds another application's tables. |

The package reads real environment variables only; it does not load your project's `.env`. It
does **not** read `DATABASE_URL` — that name belongs to your own database.

**SQLite only, in this release.** The shipped client is generated for SQLite. PostgreSQL is
supported from a checkout of the repository (switch the datasource, regenerate, push), not from
the npm package.

## First run without the console

Keys are minted by a workspace owner. In the repository the console does that; from npm there is
no console, so the same four calls are exported here:

```ts
import { authenticateUser, createAgent, createUser, createWorkspace } from '@offcut/core';

const user = await createUser({ email: 'me@example.com', password: 'at-least-8-chars', displayName: 'Me' });
const workspace = await createWorkspace({ ownerId: user.id, name: 'My project' });
const owner = await authenticateUser(user.id);
const { apiKey } = await createAgent(owner, workspace.id, { name: 'lead', kind: 'lead' });
// apiKey is shown once; only its hash is stored. Hand it to `connect()` in @offcut/sdk.
```

## The eight operations

`add`, `import`, `merge`, `recall`, `inspect`, `resolve`, `forget`, `export` — all on the `Memory`
class, all authorised through the agent key you connect with. Authorship is the connection; there
is no parameter for acting as someone else. Every write takes an `idempotencyKey` of 8–200
characters: retrying with the same key returns the original result instead of writing twice.

## What the store guarantees

Each of these is a test in the repository, not a promise:

1. Every record keeps its workspace, author, source and version. Merging never destroys a source.
2. Merging never broadens access. Records from different workspaces or audiences cannot share a block.
3. Retrying a write creates no second record. Identical text from another author keeps its own provenance.
4. Acknowledged records survive a restart. Concurrent corrections cannot silently overwrite each other.
5. A detected conflict cannot disappear without a recorded resolution or the deletion of the data.
6. Derived memory cites real source versions. A stale summary is never served as current.
7. After deletion, a record cannot return through search, export, cache or a dependent summary.
8. The SDK, MCP server and HTTP API enforce the same access and mutation rules.
9. Memory text grants no permissions. Revocation blocks every later operation by that caller.
10. The core runs without any token and without an external model.

## Backups

The package installs an `offcut-backup` command: `create`, `list`, `prune`, `restore <file>`.
Snapshots are JSON under `OFFCUT_DATA_DIR/backups`, kept 30 days. Restoring replays every deletion
recorded after the snapshot was taken, so a record someone asked to forget does not come back.

## License

MIT.
