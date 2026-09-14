/**
 * @offcut/sdk - the TypeScript interface for memory operations (SS4.1).
 *
 * This package is deliberately thin. SS4 states that the SDK and the server
 * reach the Memory Store "through a shared core", and invariant 8 requires SDK
 * and MCP to enforce identical rules. Both hold here because every method below
 * forwards to @offcut/core and adds nothing: no caching, no validation of its
 * own, no second opinion about permissions.
 *
 * Usage:
 *
 *   import { connect } from '@offcut/sdk';
 *
 *   const offcut = await connect(process.env.OFFCUT_API_KEY!);
 *   await offcut.memory.add({
 *     workspaceId: offcut.workspaceId,
 *     type: 'result',
 *     text: 'One saved record disappears after a restart.',
 *     topic: 'release-1',
 *     source: 'regression run #148',
 *     idempotencyKey: 'tester-run-148',
 *   });
 *
 *   const context = await offcut.memory.recall({
 *     workspaceId: offcut.workspaceId,
 *     query: 'what remains before release?',
 *   });
 *
 * And, once the model calls for that task have been made, what they cost:
 *
 *   await offcut.usage.report([
 *     { generationId: 'gen-01J...', model: 'anthropic/claude-sonnet-4.5' },
 *   ]);
 *
 * That is the id of the request, not its price. The provider is asked what it
 * actually cost; see UsageApi below for what that does and does not buy you.
 */

import {
  Memory,
  authenticateAgent,
  authenticateUser,
  disconnectPrisma,
  type AddInput,
  type AddResult,
  type ConflictView,
  type ContextResult,
  type ExportInput,
  type ExportResult,
  type ForgetInput,
  type ForgetResult,
  type ImportInput,
  type ImportResult,
  type InspectInput,
  type InspectResult,
  type MergeInput,
  type MergeResult,
  type MergedBlockView,
  type Principal,
  type RecallInput,
  type ReportUsageResult,
  type ResolveInput,
  type ResolveResult,
  type UsageReport,
} from '@offcut/core';

/**
 * The eight operations of SS4.1, named exactly as the specification names them.
 */
export interface MemoryApi {
  /** Save a source record or an authorised correction. */
  add(input: AddInput): Promise<AddResult>;
  /** Load explicitly supplied JSON records with schema and access validation. */
  import(input: ImportInput): Promise<ImportResult>;
  /** Combine selected accessible records. */
  merge(input: MergeInput): Promise<MergeResult>;
  /** Retrieve task context. */
  recall(input: RecallInput): Promise<ContextResult>;
  /** Inspect sources, relationships, versions and conflicts. */
  inspect(input: InspectInput): Promise<InspectResult>;
  /** Record an authorised conflict resolution. */
  resolve(input: ResolveInput): Promise<ResolveResult>;
  /** Delete selected memory within the caller's permissions. */
  forget(input: ForgetInput): Promise<ForgetResult>;
  /** Export accessible memory and relationships as JSON. */
  export(input: ExportInput): Promise<ExportResult>;
}

/**
 * Reporting what your model calls actually cost.
 *
 * Separate from `memory` because it is not a memory operation: nothing here
 * reads or writes project memory. It is how a connected subagent's AI spend
 * becomes the workspace's weight in Stock Rewards.
 *
 * Two things worth knowing before wiring it up, both of them the same point:
 * you are reporting an id, not an amount. The provider is asked what the
 * request cost, and only its answer counts, so reporting a generation twice or
 * reporting more than you spent achieves nothing. And the direction of causation
 * runs one way only - rewards follow spend, they do not refund it. The fund is
 * pre-funded and nothing mints against it, but what a period pays out of it
 * follows confirmed spend up to a per-period ceiling: more spend can mean more
 * tokens, and it never means the dollars back.
 */
export interface UsageApi {
  /**
   * Reports the provider generation ids of model calls made on this
   * workspace's tasks. At most 200 at a time.
   */
  report(reports: UsageReport[]): Promise<ReportUsageResult>;
}

export interface OffcutClient {
  /** The workspace this connection is bound to. */
  readonly workspaceId: string;
  /** The verified identity behind this connection. */
  readonly identity: Principal;
  readonly memory: MemoryApi;
  /** Confirmed AI spend - the metric Stock Rewards are weighted by. */
  readonly usage: UsageApi;

  /** Stored derived blocks, with staleness reported rather than hidden. */
  blocks(topic?: string): Promise<MergedBlockView[]>;
  /** Every unresolved conflict visible to this connection. */
  conflicts(): Promise<ConflictView[]>;
  /** Releases the database handle. */
  close(): Promise<void>;
}

function wrap(memory: Memory, workspaceId: string): OffcutClient {
  return {
    workspaceId,
    identity: memory.identity,
    memory: {
      add: (input) => memory.add(input),
      import: (input) => memory.import(input),
      merge: (input) => memory.merge(input),
      recall: (input) => memory.recall(input),
      inspect: (input) => memory.inspect(input),
      resolve: (input) => memory.resolve(input),
      forget: (input) => memory.forget(input),
      export: (input) => memory.export(input),
    },
    usage: {
      report: (reports) => memory.reportUsage(workspaceId, reports),
    },
    blocks: (topic) => memory.blocks(workspaceId, topic),
    conflicts: () => memory.conflicts(workspaceId),
    close: () => disconnectPrisma(),
  };
}

/**
 * Connects using an agent API key.
 *
 * The key is the identity (SS3.2). Note what the returned client does NOT let
 * you do: there is no parameter for "act as agent X". Authorship is decided by
 * the key you hold, which is what makes the spoofing risk in SS7 unreachable
 * from this surface.
 *
 * One caveat worth stating plainly, from SS4.2: if your application hands the
 * same key to several subagents, OFFCUT sees one principal, not several. It
 * will not pretend to isolate agents it cannot distinguish. Mint one key per
 * subagent when you need them kept apart.
 */
export async function connect(apiKey: string): Promise<OffcutClient> {
  const principal = await authenticateAgent(apiKey);
  if (principal.kind !== 'agent') {
    throw new Error('Expected an agent key.');
  }
  return wrap(new Memory(principal), principal.workspaceId);
}

/**
 * Connects as a workspace owner.
 *
 * Intended for tooling that already authenticated a human - the web console, a
 * migration script, a seed. Owners hold every permission on workspaces they
 * own (SS2), so this is not a substitute for an agent key in agent code.
 */
export async function connectAsOwner(
  userId: string,
  workspaceId: string
): Promise<OffcutClient> {
  const principal = await authenticateUser(userId);
  return wrap(new Memory(principal), workspaceId);
}

export type {
  AddInput,
  AddResult,
  ConflictView,
  ContextResult,
  ExportInput,
  ExportResult,
  ForgetInput,
  ForgetResult,
  ImportInput,
  ImportResult,
  InspectInput,
  InspectResult,
  MergeInput,
  MergeResult,
  MergedBlockView,
  Principal,
  RecallInput,
  ReportUsageResult,
  ResolveInput,
  ResolveResult,
  UsageReport,
};

export { OffcutError, isOffcutError } from '@offcut/core';

/**
 * First run without the console.
 *
 * Keys are minted by a workspace owner. Inside the repository that is the
 * console's job; a package installed from npm has no console, and a memory
 * nobody can obtain a key for is not a memory. So the four calls that take an
 * empty store to a usable key are exposed here as well - they are the same
 * functions the console uses, not a second path.
 *
 *   const user = await createUser({ email, password, displayName });
 *   const workspace = await createWorkspace({ ownerId: user.id, name: 'My project' });
 *   const owner = await authenticateUser(user.id);
 *   const { apiKey } = await createAgent(owner, workspace.id, { name: 'lead', kind: 'lead' });
 *   const offcut = await connect(apiKey);
 */
export { authenticateUser, createAgent, createUser, createWorkspace } from '@offcut/core';
