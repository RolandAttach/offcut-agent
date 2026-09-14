# @offcut/sdk

Shared memory for teams of agents. A subagent saves what it learned; a different agent, created
later, asks a question and gets an answer assembled from everything that was saved — with
references to who said what and which version.

## Install

```bash
npm install @offcut/sdk
```

This pulls in `@offcut/core`, which runs `prisma generate` on install (into its own directory —
it will not touch a Prisma client of your own). If that step is skipped — install scripts off,
`--ignore-scripts`, no network — the first import fails with a message naming the fix:

```bash
npx prisma generate --schema node_modules/@offcut/core/prisma/schema.prisma
```

On **pnpm 10 or newer** the install exits with `ERR_PNPM_IGNORED_BUILDS`; run `pnpm approve-builds`,
allow `@offcut/core` and `@prisma/client`, then `pnpm rebuild @offcut/core`.

## First run

Keys are minted by a workspace owner. Without the console, do it once in code:

```ts
import { authenticateUser, connect, createAgent, createUser, createWorkspace } from '@offcut/sdk';

const user = await createUser({ email: 'me@example.com', password: 'at-least-8-chars', displayName: 'Me' });
const workspace = await createWorkspace({ ownerId: user.id, name: 'My project' });
const owner = await authenticateUser(user.id);
const { apiKey } = await createAgent(owner, workspace.id, { name: 'lead', kind: 'lead' });
// Keep apiKey: it is shown once, and only its hash is stored.
```

## Use

```ts
import { connect } from '@offcut/sdk';

const offcut = await connect(process.env.OFFCUT_API_KEY!);

await offcut.memory.add({
  workspaceId: offcut.workspaceId,
  type: 'result', // 'fact' | 'decision' | 'result' | 'hypothesis'
  text: 'One saved record disappears after a restart.',
  topic: 'release-1',
  source: 'regression run #148',
  idempotencyKey: 'tester-run-148', // 8–200 characters; a retry with the same key writes nothing new
});

const context = await offcut.memory.recall({
  workspaceId: offcut.workspaceId,
  query: 'what remains before release?',
});
```

The key is the identity. Everything an agent may do — read, write, merge, decide a conflict,
delete — is a permission on that key, granted by the owner. There is no way to write as somebody
else.

## What you are getting

- **Nothing is overwritten.** A correction is a new version linked to the old one.
- **Duplicates collapse; disagreements do not.** Two agents asserting different values for the
  same fact produce a conflict that a person, or an agent granted the right, resolves with a
  written reason. Neither side is deleted.
- **Derived context cites its sources.** Every merged block names the record versions it was built
  from, and says so when one of them has since changed.
- **Deletion is real.** A forgotten record leaves search, export and every derived block that used
  it. A snapshot restored with OFFCUT's own `offcut-backup restore` does not bring it back.

## Where the data goes

`~/.offcut/` on the machine that runs this — outside `node_modules`, created on the first call.
`OFFCUT_DATA_DIR` moves the whole directory; `OFFCUT_DATABASE_URL` moves just the SQLite file
(relative `file:` paths resolve against your working directory). The package reads environment
variables only, not your `.env`, and it never reads `DATABASE_URL`: that one is yours.

SQLite only in this release. PostgreSQL is available from a checkout of the repository.

## The same memory over MCP

If the agents you want to connect live in Claude Desktop or Cursor rather than in your own code,
`@offcut/mcp-server` is this SDK's operations exposed as MCP tools, over the same store:

```bash
npx @offcut/mcp-server --help
```

## License

MIT.
