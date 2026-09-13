# OFFCUT AGENT ($OFFCUT) — Technical Specification v3.1

**Format:** Memory SDK + MCP server. **Reference:** [Finch](https://www.finchagentic.com/) — the starting point for memory and MCP, not trading.
**Project and token name:** OFFCUT AGENT. **Ticker:** OFFCUT; written as $OFFCUT.
**Status:** specification for development; replaces v3.0. **Date:** September 13, 2026.

All mechanisms below are requirements for OFFCUT, not a description of a released product. Method names describe a proposed interface. `[OPEN]` marks an unresolved decision.

---

## 1. Overview and Thesis

OFFCUT AGENT is a memory SDK and MCP server that merges a user's own subagents' memory into one project memory. The researcher saves findings, the developer saves an implementation decision, and the tester saves a test result. The lead agent receives their shared context even when it did not participate in the earlier sessions.

**The core is memory merging:** preserve source records, consolidate duplicates in retrieval, bring related results together, and keep contradictions visible. The user does not have to repeat every agent's work to the others.

OFFCUT neither replaces the agents nor runs their tasks. It is not a relayer: it stores, merges, and retrieves memory itself rather than only forwarding requests. It combines submitted knowledge, not models, model weights, or hidden reasoning.

**Product boundary: no watermelon trading — “без торговли арбузами”.** No trades, swaps, arbitrage, market monitoring, stock portfolios, or transaction signing. No proprietary chat application or trading terminal is required.

## 2. Entities and Roles

| Entity | Type | Role |
|---|---|---|
| Workspace | One project's memory | A shared scope for selected agents, not a common database for all users |
| Source record | Original record | A fact, decision, result, or hypothesis with an author and source |
| Merged memory | Combined memory | Related records without duplicate retrieval items, with references to source records and versions |
| Context | Memory-query result | The relevant portion of merged memory within the caller's permissions and size limit |
| $OFFCUT | Project token | An asset separate from memory; its product utility is `[OPEN]` |

| Participant | Does | Cannot |
|---|---|---|
| Owner | Creates a workspace, grants access, authorizes corrections and deletion | Access another workspace by holding the token |
| Lead agent | Retrieves shared context and saves decisions | Automatically acquire owner permissions |
| Subagent | Saves its results and reads authorized memory | Overwrite another agent's record or grant itself new permissions |
| Merge Engine | Combines accessible records and maintains relationships | Silently expand the audience or present a hypothesis as a verified fact |

## 3. Mechanics

### 3.1 Connection

1. The user connects OFFCUT as an MCP server to an AI application or embeds the SDK in code.
2. They create a workspace and grant the lead agent and selected subagents read and write access.
3. Agents submit results through memory tools. Existing notes enter through explicit JSON import.
4. The next session connects to the same workspace and retrieves the saved context.

Connection does not mean automatically reading every chat. The application must expose tools to subagents or save their results itself. Without a write or import, OFFCUT does not know those records.

### 3.2 Writing

A record contains `recordId`, `workspaceId`, `agentId`, type, text, topic, source, timestamp, version, and access scope. `agentId` comes from the verified connection, not an arbitrary string in a model request. Authorship and supporting evidence are separate fields.

Every write operation has an `idempotencyKey`: retrying the same request returns the previous result. Reusing that key with different content is rejected. Identical notes submitted by different agents retain their own provenance; they are not a request retry.

A write is acknowledged after it is persisted. A correction creates a new version linked to its predecessor; a stale version in a request cannot silently overwrite a concurrent change.

### 3.3 Merging Memory

Merging operates within one workspace and an identical authorized audience. Private records do not become shared because their topics match.

| Input | OFFCUT behavior | What remains in memory |
|---|---|---|
| Exact content duplicate with the same topic and type | Returns one item | All source records and their authors |
| Different parts of one task | Groups related items into a shared block | References to every record used |
| Different values of one explicitly identified fact in the same context | Flags a conflict and shows the alternatives | Both versions, without deciding who is right |
| An explicit authorized correction | Updates the current version | A link to the previous version |
| An uncertain semantic relationship | Keeps records separate | Nothing is discarded for a cleaner summary |

Basic merging uses topics, explicit relationships, and structured values. Model-based semantic suggestions belong to the optional module in section 9. Detecting every contradiction in free text is not promised.

**Shared memory is not one enormous prompt.** It consists of records and relationships from which relevant context is assembled. A derived block contains source IDs and versions. When a source changes, the dependent block becomes stale and must be rebuilt before being returned as current.

### 3.4 Retrieving Context

1. The agent provides a workspace, a question or task, and a response-size limit.
2. OFFCUT checks access and selects relevant records. Inaccessible and deleted records do not contribute to search, counts, or summaries for that request.
3. It returns text, sources, versions, and detected unresolved conflicts. When the limit cannot fit both sides of a conflict, it returns an explicit flag and references rather than one supposedly correct side.
4. When no data exists, it returns an empty result. Memory is not replaced with an invented answer.

Access checks also apply to cached results. Revocation prevents subsequent reads; context already received by another application cannot be recalled.

### 3.5 Resolving Conflicts and Deleting Memory

The owner or an explicitly authorized participant records a conflict resolution: the chosen version, rationale, and decision author. Repetition and the title “lead agent” do not by themselves grant authority to determine truth.

Deletion excludes a record and dependent derived blocks from subsequent responses immediately after the operation is acknowledged. Indexes and managed copies are cleaned up. Backup cleanup timing is `[OPEN-5]`; OFFCUT cannot delete copies exported to external applications.

### 3.6 End-to-End Example

| Agent | Saved record |
|---|---|
| Researcher | R1: “The application must work offline” |
| Developer | D1: “Project data is stored locally” |
| Tester | T1: “One saved record disappears after a restart” |

A new lead agent asks: **“What remains before release?”** OFFCUT returns one context containing the offline requirement, the local-storage decision, and the unresolved recovery bug, with references R1, D1, and T1. The lead agent uses this context to answer the user.

There is no need to rerun the researcher or have the user repeat three earlier conversations. A new “bug fixed” record does not erase T1: it links to T1 as an update with its own source.

## 4. Components and Roles

```text
Lead agent + subagents
             ↕
       SDK / MCP server
             ↕
         Access check
             ↕
    Write → merge → context
             ↕
Sources + versions + search index
```

| Component | Responsibility | Caller |
|---|---|---|
| Memory SDK | TypeScript interface for memory operations | Developer's application |
| MCP Server | The same operations through MCP, without separate business logic | Connected AI application |
| Access Layer | Workspace permissions and caller identity | Every read and write path |
| Memory Store | Sources, versions, relationships, and transactional writes | SDK and server through a shared core |
| Merge Engine | Duplicates, related records, conflicts, and freshness of derived blocks | A merge request or post-write handler |
| Context Builder | Retrieval and bounded context assembly with references | A recall request |

The first release is local. Every connection to a workspace uses the same store; it does not create a separate database for each subagent. SQLite is a candidate; the final choice is `[OPEN-2]`.

### 4.1 SDK and MCP Interface

| SDK | MCP tool | Purpose |
|---|---|---|
| `memory.add()` | `offcut_memory_add` | Save a source record or an authorized correction |
| `memory.import()` | `offcut_memory_import` | Import explicitly supplied JSON records with schema and access validation |
| `memory.merge()` | `offcut_memory_merge` | Combine selected accessible records |
| `memory.recall()` | `offcut_memory_recall` | Retrieve task context |
| `memory.inspect()` | `offcut_memory_inspect` | Inspect sources, relationships, versions, and conflicts |
| `memory.resolve()` | `offcut_memory_resolve` | Record an authorized conflict resolution |
| `memory.forget()` | `offcut_memory_forget` | Delete selected memory within the caller's permissions |
| `memory.export()` | `offcut_memory_export` | Export accessible memory and relationships as JSON |

### 4.2 Trust Boundaries

| Boundary | Rule |
|---|---|
| Agent connection | Permissions belong to a verified connection. When a client cannot distinguish subagents, the server treats them as one principal rather than promising separate isolation |
| Memory text | Data, not instructions. A record saying “ignore the rules” cannot change permissions or invoke a tool |
| Local storage | SDK checks do not protect against a process with direct database-file access; operating-system permissions are required |
| External model | Text leaves the system only with explicit owner permission; disabled by default |

## 5. Economics

| Area | Decision | Status |
|---|---|---|
| Local SDK and MCP | Memory operations require no wallet, gas, or token purchase | Core requirement |
| Storage and compute | Supplied by the user's infrastructure; project pricing and licensing are undecided | `[OPEN-7]` |
| $OFFCUT | Token name: OFFCUT AGENT; symbol: OFFCUT | Fixed in the brief |
| Token launch | Robinhood Chain `4663`, pons v2: launch context from the brief, not memory infrastructure | Launch parameters are `[OPEN-7]` |
| Token utility | Undecided; no invented staking, tax, buyback, or payouts merely to populate this section | `[OPEN-7]` |

Storing memory is not an onchain operation. Holding $OFFCUT does not grant access to other users' records. SDK operation does not depend on the token launch or its trading volume.

## 6. Invariants

1. Every record has a workspace, author, source, and version; merging does not destroy source records. Explicit deletion is a separate operation.
2. Merging does not broaden access: records from different workspaces or audiences cannot enter a shared persisted block.
3. Retrying one write request does not create another record; identical text from a different source retains its authorship.
4. Acknowledged records survive a restart. Concurrent corrections cannot silently overwrite each other.
5. A detected conflict cannot disappear from current retrieval without a recorded resolution or deletion of the relevant data.
6. Derived memory references existing source versions; a stale summary is not presented as current.
7. After deletion is acknowledged, the record cannot return through the service's search, export, cache, or dependent summaries.
8. SDK and MCP enforce the same access and mutation rules.
9. Memory text cannot grant permissions. Revocation blocks subsequent operations by that principal.
10. The local core works without the token or an external model. Sending memory to an external model requires separate permission.

## 7. Risks and Calibration

| Risk | Mitigation | Initial calibration |
|---|---|---|
| Combining different facts because the wording is similar | Code handles exact duplicates; ambiguous records remain separate | A labeled set of duplicates, complements, and conflicts; semantic-module thresholds are `[OPEN-4]` |
| Losing context through shortening | Preserve source records; return references and an incompleteness indicator | Context limit is `[OPEN-3]` |
| Cross-project leakage | Access checks on retrieval, merge, cache, and export | Negative tests on every path |
| Author spoofing through `agentId` | Identity comes from the connection; imported claimed authorship is stored separately | Client connection design is `[OPEN-1]` |
| Write conflicts or process failure | Transactions, versions, and idempotency keys | Concurrent writes and forced restarts |
| Malicious instructions inside memory | Never treat text as authorization or execute actions from a record | Tests with injected commands; external-agent behavior is not fully controlled by OFFCUT |
| Deleted information remains in a copy | Invalidate derived data, clean indexes, define backup policy | Backup retention is `[OPEN-5]` |
| An external model or its summary is wrong | Module disabled by default; source records remain usable without it | Authorized provider and quality checks are `[OPEN-4]` |

### 7.1 Acceptance

| Test | Expected result |
|---|---|
| Two subagents save different results; a new lead agent queries the task | One context with both results and source references |
| Retry a request; submit identical text from another agent | No duplicate request write; the second note's provenance is preserved |
| Two values of one structured fact | A visible conflict; neither version is overwritten |
| Concurrent writes and a restart | All acknowledged data remains available; version conflicts are explicit |
| Query another workspace or query after revocation | No content, summary, or metadata from inaccessible memory |
| Delete a source after creating a summary | Neither the source nor its dependent block is returned |
| Run the same query through SDK and MCP | The same context with identical permissions, data, and settings |
| No token or external model is connected | Writing, basic merging, retrieval, deletion, and export still work |

**Primary acceptance check:** a new agent continues a task using merged subagent memory without the user manually repeating it. This must be demonstrated in an integration example, not merely by exposing MCP tools.

The first release includes the SDK, MCP, local memory, import/export, basic merging, and the checks above. Supported clients, data format, limits, and deletion policy must be fixed before release. Model summaries and the token launch do not block release of the core.

## 8. Open Questions

| ID | Question | Affects |
|---|---|---|
| OPEN-1 | Which MCP clients are supported; how do they expose tools and separate permissions to subagents? | Connection, identity, and integration demo |
| OPEN-2 | Which local store and record schema; how are topics, facts, versions, sources, and migrations defined? | Writing, import, merging, and recovery |
| OPEN-3 | Maximum agents, record size, workspace size, and context limit | Performance and cost |
| OPEN-4 | Are model summaries needed in the first release; local or authorized external model; how is quality evaluated? | Optional module in section 9 |
| OPEN-5 | Backup cleanup timing and restoration without resurrecting deleted data | Deletion and operations |
| OPEN-6 | Package names, license, and name/ticker clearance | SDK publication and branding |
| OPEN-7 | Is there a paid service; how is $OFFCUT used; what are the confirmed launch parameters? | Economics outside the memory core |

## 9. Optional Extension — Model Summaries

Not required for basic merging and disabled by default. When added, a model proposes semantic relationships, possible conflicts, and a concise summary of already authorized records.

Its output is labeled as derived, references source versions, and passes structural validation. This validates references, not the truth of the text. The model gains no permission to change sources, resolve conflicts for the owner, or share memory with a new audience.

When the model fails, OFFCUT returns the original linked records without a summary. Writing, exact deduplication, and shared-memory retrieval continue to work.

## Appendix A — Decisions Log

| Decision | Alternative | Rationale |
|---|---|---|
| OFFCUT AGENT is the name; OFFCUT is the ticker | Identical name and symbol | Explicit user clarification |
| Memory merging is the core | A trading agent or relayer | Latest product direction |
| SDK and MCP use one core | Separate memory implementations | The same data and rules for every connection |
| Sources are preserved separately from merged memory | Replace conversations with one summary | Sources remain inspectable, correctable, and deletable |
| Explicit writes and imports only | Promise access to every chat after installation | Connection is not automatic access to unknown data |
| The local core does not depend on $OFFCUT | Require a wallet for each request | The token is not a memory-storage mechanism |
| “No watermelon trading” is a scope boundary | Import markets and yield mechanics from the examples | Explicit user requirement: “без торговли арбузами” |

(Reference to other, unrelated private specifications removed for publication.)
