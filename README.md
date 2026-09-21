# OFFCUT AGENT

Shared memory for AI subagents. One workspace, many agents, one store: an agent writes a decision and another agent — in a different session, on a different machine, holding a different key — recalls it, with the author and the version attached. When two agents give the same named fact different values, OFFCUT raises a conflict instead of letting recency or luck decide.

This repository is the engine: the memory core, the SDK, an MCP server that puts the memory inside Claude Code and any other MCP client, an HTTP API, and a two-layer reward ledger whose cumulative Merkle roots are published on chain. The web console is not part of this repository.

## What is in here

| Path | What it owns |
|---|---|
| `packages/core` | The store. Prisma schema, records, versions, conflicts, agents, workspaces, usage reports, reward credits. Every invariant the rest of the system relies on is tested here. |
| `packages/sdk` | The typed surface an application calls: add, recall, inspect, merge, resolve, forget, export. |
| `apps/mcp-server` | stdio JSON-RPC MCP server exposing nine tools. Runs against a local database, or against a remote OFFCUT server over HTTPS with an agent key. Published as `@offcut/mcp-server`. |
| `apps/api` | NestJS HTTP API: sessions for people, keys for agents, one guard in front of both. Rate limits on the endpoints that can be abused. |
| `packages/rewards` | The reward arithmetic: two layers, two ceilings, pro-rata splits, cumulative totals, Merkle trees. No network, no database — pure functions over figures. |
| `packages/contracts` | `OffcutRewards`, an upgradeable, pausable Solidity contract that pays claims against a published Merkle root. |
| `apps/publisher` | The service that runs every ten minutes: confirm reported spend with the provider, settle the period that closed, rebuild the tree, write proofs, publish the root when it has moved. |
| `packages/acceptance` | The specification's clauses, executed against the API. |

## Memory, as it actually behaves

A **record** is a fact, a decision, a result or a hypothesis. It carries the agent that wrote it, its topic, its scope and its version.

- **Correcting is versioning.** Passing `correctsRecordId` writes a new version linked to the previous one. Nothing is overwritten, so the history of a decision survives the decision.
- **Conflicts are raised, not resolved.** A record can name a fact — `factKey: "storage.backend"`, `factValue: "SQLite"`. When another agent writes a different value for the same key in the same scope, the server returns an open conflict listing both sides with both authors. Resolving one requires a person, a chosen side and a written rationale, which is stored with the decision.
- **Retrieval is ranked, not searched.** `recall` returns what is relevant to a question within the workspace's context limit, with the references needed to inspect the originals.
- **Writes are idempotent.** Every write takes an `idempotencyKey`. A retried tool call — which is ordinary in an agent loop — is not a second record.

## The nine MCP tools

| Tool | What it does |
|---|---|
| `offcut_memory_add` | Save a record, or correct one you already saved. |
| `offcut_memory_import` | Save many records in one call. |
| `offcut_memory_merge` | Merge a topic's records into one consolidated block. |
| `offcut_memory_recall` | Retrieve what is relevant to a question, within the context limit. |
| `offcut_memory_inspect` | Read a record's full history, versions and fact keys. |
| `offcut_memory_resolve` | Settle an open conflict, with a rationale that is stored. |
| `offcut_memory_forget` | Remove a record, leaving the fact that it was removed. |
| `offcut_memory_export` | Export a workspace's memory. |
| `offcut_usage_report` | Report what a model call cost, for the reward ledger to confirm. |

## Getting it running

```bash
pnpm install
pnpm setup          # create the SQLite database and seed a demo workspace
pnpm dev            # the API on :4000
pnpm test           # every suite: core, rewards, publisher, acceptance, api, contracts
```

Connecting the MCP server to Claude Code, against a local database:

```bash
pnpm mcp:install    # writes the MCP entry for you
pnpm mcp:check      # handshake, list the tools, call one
```

Against a server, the client needs nothing but the published package:

```bash
claude mcp add offcut \
  -e OFFCUT_API_URL=https://your-offcut-server \
  -e OFFCUT_API_KEY=offcut_sk_... \
  -- npx -y @offcut/mcp-server
```

Configuration is documented in [`.env.example`](.env.example). Nothing in this repository requires a key to run locally: without one it uses SQLite in the repository, and the reward publisher does not start unless a contract address is configured.

## Rewards

Two layers pay into one ledger, under one root, with one claim:

- **Spend** — AI spend a provider confirmed. Reports from agents are worth nothing until the provider agrees they happened; only the confirmed figure earns.
- **Memory** — a record earns one credit, once ever, the first time an agent *other than its author* retrieves it. Writing memory nobody uses earns nothing.

Each layer has its own daily ceiling and its own rate, and each period's pool is split pro-rata among that period's earners, with a per-earner cap so one workspace cannot take a ceiling-bound period. The two shares are added into one accrual.

Totals are **cumulative**: every root carries what each address has ever earned, so a distribution that never lands is superseded by the next one rather than lost, and a recipient claims once for everything. The publisher sends a transaction only when the root has moved — quiet periods cost nothing.

Stated plainly, because it is the easiest thing to leave out: **this rewards usage, it does not reimburse it.** The fund is funded in advance and owes nobody a rate. On a ceiling-bound period a dollar of spend is worth whatever the split makes it worth, which is less.

## Checking the claims instead of believing them

```bash
pnpm test                 # the full suite
pnpm test:invariants      # the store's own rules
pnpm test:acceptance      # the specification, clause by clause
pnpm test:contracts       # the Solidity, including the claim path
```

- The reward contract is deployed on Robinhood Chain (chain id 4663) at [`0x92c9ef7FD1c2e7423f9b5edDf15ef74eaC4e04Ea`](https://robinhoodchain.blockscout.com/address/0x92c9ef7FD1c2e7423f9b5edDf15ef74eaC4e04Ea), with its implementation verified on Sourcify.
- The deployment record is committed at [`packages/contracts/deployments/robinhood.json`](packages/contracts/deployments/robinhood.json).
- The MCP server and the SDK are on npm as [`@offcut/mcp-server`](https://www.npmjs.com/package/@offcut/mcp-server) and [`@offcut/sdk`](https://www.npmjs.com/package/@offcut/sdk); `npx -y @offcut/mcp-server --help` runs the published build without installing anything.
- The specification this was built against is in [`OFFCUT_AGENT_TZ_EN_v3.1.md`](OFFCUT_AGENT_TZ_EN_v3.1.md), and `packages/acceptance` executes it.

## Status and limits

- **The contract is unaudited.** It is upgradeable and pausable by its owner, which means the owner can change its behaviour and withdraw the unclaimed pool. That is not trustless, and calling it trustless would be a lie.
- The default store is SQLite, which suits one machine. `pnpm use:postgres` switches the datasource for a deployment that needs more.
- Reward weight follows what a provider confirms. A subscription — Claude Code's included usage, for instance — is not spend anyone can confirm on your behalf, so it earns from the memory layer and nothing from the spend layer.
- Version control was added to this project late: the history here is a reconstruction over the days the work was done, not a recording of it.

## Licence

MIT. See [LICENSE](LICENSE).
