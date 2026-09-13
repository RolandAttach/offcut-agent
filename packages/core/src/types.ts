/**
 * Domain types and request validation for the OFFCUT memory core.
 *
 * SQLite stores these as plain strings; the unions below are the single place
 * where the allowed values are defined, and the zod schemas are what every
 * surface (SDK, MCP, HTTP) validates against. Invariant 8 requires all three to
 * enforce the same rules, which they do by sharing this file.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enumerations (SS2, SS3.2, SS3.3)
// ---------------------------------------------------------------------------

/** What a source record asserts (SS2: "a fact, decision, result or hypothesis"). */
export const RECORD_TYPES = ['fact', 'decision', 'result', 'hypothesis'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/**
 * The audience of a record. Merging requires an identical audience, so this is
 * a hard partition rather than a display hint (SS3.3, invariant 2).
 *   workspace - visible to every agent with read access
 *   private   - visible only to its author agent and the workspace owner
 */
export const SCOPES = ['workspace', 'private'] as const;
export type Scope = (typeof SCOPES)[number];

/** Explicit relationships. These are merge signals; semantics are never guessed. */
export const LINK_KINDS = ['updates', 'relates', 'partOf', 'duplicateOf', 'contradicts'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const AGENT_KINDS = ['lead', 'subagent'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const CONFLICT_STATUSES = ['open', 'resolved'] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

/** The eight memory operations of SS4.1. */
export const OPERATIONS = [
  'add',
  'import',
  'merge',
  'recall',
  'inspect',
  'resolve',
  'forget',
  'export',
] as const;
export type Operation = (typeof OPERATIONS)[number];

// ---------------------------------------------------------------------------
// Permissions (SS2, SS4.2)
// ---------------------------------------------------------------------------

export interface Permissions {
  canRead: boolean;
  canWrite: boolean;
  canImport: boolean;
  canMerge: boolean;
  canResolve: boolean;
  canForget: boolean;
  canExport: boolean;
}

export const DEFAULT_SUBAGENT_PERMISSIONS: Permissions = {
  canRead: true,
  canWrite: true,
  canImport: false,
  canMerge: true,
  canResolve: false,
  canForget: false,
  canExport: false,
};

export const DEFAULT_LEAD_PERMISSIONS: Permissions = {
  canRead: true,
  canWrite: true,
  canImport: true,
  canMerge: true,
  // A lead agent still cannot decide truth or delete on its own: SS3.5 says the
  // title "lead agent" does not by itself grant authority. The owner may grant
  // these explicitly, but they are off by default.
  canResolve: false,
  canForget: false,
  canExport: true,
};

/**
 * Who is calling. Identity always comes from a verified connection - an API key
 * for agents, a session for humans - never from a field in the request body
 * (SS3.2, and the agentId-spoofing risk in SS7).
 */
export type Principal =
  | {
      kind: 'agent';
      agentId: string;
      workspaceId: string;
      name: string;
      agentKind: AgentKind;
      permissions: Permissions;
    }
  | {
      kind: 'user';
      userId: string;
      /**
       * Null for an account opened by signing with a wallet: there are two
       * doors into one account and only one of them collects an email. Code
       * that needs something to print uses displayName, which every account
       * has.
       */
      email: string | null;
      displayName: string;
    }
  /** Reserved for migrations and seeding. Never reachable from a network surface. */
  | { kind: 'system'; label: string };

export function principalLabel(principal: Principal): string {
  switch (principal.kind) {
    case 'agent':
      return principal.name;
    case 'user':
      // displayName is never empty - an account opened with a wallet is named
      // after its address - so the fallbacks are for a row edited by hand.
      return principal.displayName || principal.email || principal.userId;
    case 'system':
      return principal.label;
  }
}

export function principalId(principal: Principal): string {
  switch (principal.kind) {
    case 'agent':
      return principal.agentId;
    case 'user':
      return principal.userId;
    case 'system':
      return 'system';
  }
}

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

/** OPEN-3 starting limits. Deliberately generous but finite. */
export const LIMITS = {
  /** Maximum characters in one record's text. */
  recordTextMax: 20_000,
  topicMax: 200,
  sourceMax: 500,
  factKeyMax: 200,
  factValueMax: 2_000,
  /** Default characters returned by recall when the caller gives no limit. */
  contextLimitDefault: 6_000,
  contextLimitMax: 60_000,
  /** Maximum records accepted in a single import call. */
  importBatchMax: 1_000,
  /**
   * Maximum live agent keys in one workspace - the fourth number OPEN-3 asks
   * for, and the last one to get a value.
   *
   * It is 200 because three things in this repo already say 200 is the edge:
   *
   *   - one assembled context carries at most `maxItems` = 200 records (see
   *     recallInputSchema below), and every item names its author, so at most
   *     200 distinct agents can appear in one context. A roster larger than the
   *     context's own ceiling holds agents that could never all be represented
   *     in the single merged memory this product exists to produce.
   *   - listAgents() counts records per agent with one query each, and the
   *     console's agents page draws every agent as a key card with no
   *     pagination, two to a row. At the cap that is 200 count queries and 100
   *     rows of cards: long, but still a page that loads and can be read.
   *   - the demo workspace the seed builds uses five.
   *
   * So it is forty times what the reference workspace needs and stops at the
   * point where a merged context and the console both stop being able to show
   * the whole swarm. It bounds automation minting keys in a loop; it is not a
   * number anyone should meet doing real work.
   */
  agentsPerWorkspaceMax: 200,
} as const;

const topicSchema = z
  .string()
  .trim()
  .min(1, 'topic is required')
  .max(LIMITS.topicMax)
  // Topics are merge keys, so they are normalised to a stable slug-ish form.
  .transform((value) => value.toLowerCase());

export const idempotencyKeySchema = z.string().trim().min(8).max(200);

// ---------------------------------------------------------------------------
// memory.add (SS4.1)
// ---------------------------------------------------------------------------

export const addInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    type: z.enum(RECORD_TYPES),
    text: z.string().trim().min(1, 'text is required').max(LIMITS.recordTextMax),
    topic: topicSchema,
    /** Supporting evidence, kept apart from authorship (SS3.2). */
    source: z.string().trim().max(LIMITS.sourceMax).default(''),
    scope: z.enum(SCOPES).default('workspace'),

    /** The deterministic half of merging: an explicitly identified fact (SS3.3). */
    factKey: z.string().trim().max(LIMITS.factKeyMax).optional(),
    factValue: z.string().trim().max(LIMITS.factValueMax).optional(),
    factContext: z.string().trim().max(LIMITS.factKeyMax).default(''),

    /**
     * Supplying this turns the call into an authorised correction: it creates a
     * NEW version linked to the previous one rather than overwriting anything
     * (SS3.2, invariant 1).
     */
    correctsRecordId: z.string().min(1).optional(),
    /**
     * The version the caller believes is current. A stale value is rejected so
     * concurrent corrections cannot silently overwrite each other (invariant 4).
     */
    expectedVersion: z.number().int().positive().optional(),

    /** Explicit relationships to create alongside the record. */
    links: z
      .array(
        z.object({
          kind: z.enum(LINK_KINDS),
          recordId: z.string().min(1),
          note: z.string().trim().max(500).default(''),
        })
      )
      .max(50)
      .default([]),

    idempotencyKey: idempotencyKeySchema,
  })
  .refine((value) => (value.factValue === undefined ? true : value.factKey !== undefined), {
    message: 'factValue requires factKey: a value without a key cannot be compared',
    path: ['factKey'],
  });

export type AddInput = z.input<typeof addInputSchema>;
export type AddInputParsed = z.output<typeof addInputSchema>;

// ---------------------------------------------------------------------------
// memory.import (SS4.1)
// ---------------------------------------------------------------------------

/**
 * Imported payloads may CLAIM an author. That claim is stored in a separate
 * field and never becomes the verified `agentId` (SS7, author-spoofing risk).
 */
export const importRecordSchema = z.object({
  type: z.enum(RECORD_TYPES),
  text: z.string().trim().min(1).max(LIMITS.recordTextMax),
  topic: topicSchema,
  source: z.string().trim().max(LIMITS.sourceMax).default(''),
  scope: z.enum(SCOPES).default('workspace'),
  factKey: z.string().trim().max(LIMITS.factKeyMax).optional(),
  factValue: z.string().trim().max(LIMITS.factValueMax).optional(),
  factContext: z.string().trim().max(LIMITS.factKeyMax).default(''),
  /** Free-form provenance from the exporting system. Never trusted as identity. */
  claimedAuthor: z.string().trim().max(200).optional(),
  /** Original id in the exporting system, kept for traceability only. */
  externalId: z.string().trim().max(200).optional(),
});

export type ImportRecord = z.input<typeof importRecordSchema>;

export const importInputSchema = z.object({
  workspaceId: z.string().min(1),
  records: z.array(importRecordSchema).min(1).max(LIMITS.importBatchMax),
  idempotencyKey: idempotencyKeySchema,
});

export type ImportInput = z.input<typeof importInputSchema>;

// ---------------------------------------------------------------------------
// memory.merge (SS4.1)
// ---------------------------------------------------------------------------

export const mergeInputSchema = z.object({
  workspaceId: z.string().min(1),
  /** Restrict merging to one topic. Omitted means every accessible topic. */
  topic: z.string().trim().max(LIMITS.topicMax).optional(),
  /** Explicit record selection. Omitted means "every accessible record". */
  recordIds: z.array(z.string().min(1)).max(500).optional(),
  /** Merging never crosses audiences, so the audience is chosen up front. */
  scope: z.enum(SCOPES).default('workspace'),
  /** Rebuild blocks that are already stale even if nothing else changed. */
  rebuildStale: z.boolean().default(true),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export type MergeInput = z.input<typeof mergeInputSchema>;

// ---------------------------------------------------------------------------
// memory.recall (SS3.4, SS4.1)
// ---------------------------------------------------------------------------

export const recallInputSchema = z.object({
  workspaceId: z.string().min(1),
  /** The question or task the caller needs context for. */
  query: z.string().trim().max(2_000).default(''),
  topic: z.string().trim().max(LIMITS.topicMax).optional(),
  /** Response size budget in characters (SS3.4 step 1). */
  limit: z.number().int().positive().max(LIMITS.contextLimitMax).optional(),
  /** Cap on returned items, independent of the character budget. */
  maxItems: z.number().int().positive().max(200).default(40),
  types: z.array(z.enum(RECORD_TYPES)).optional(),
  /** Serve from the recall cache when it is valid. Permissions are always rechecked. */
  useCache: z.boolean().default(true),
});

export type RecallInput = z.input<typeof recallInputSchema>;

// ---------------------------------------------------------------------------
// memory.inspect (SS4.1)
// ---------------------------------------------------------------------------

export const inspectInputSchema = z.object({
  workspaceId: z.string().min(1),
  /** Inspect one lineage in full: every version, link and conflict it touches. */
  recordId: z.string().min(1).optional(),
  topic: z.string().trim().max(LIMITS.topicMax).optional(),
  /** Free-text filter over record text and topic. Applied after the access filter. */
  search: z.string().trim().max(200).optional(),
  types: z.array(z.enum(RECORD_TYPES)).optional(),
  includeDeleted: z.boolean().default(false),
  limit: z.number().int().positive().max(500).default(50),
  /** Rows to skip. With `total` in the result, this is enough to page a list. */
  offset: z.number().int().min(0).default(0),
});

export type InspectInput = z.input<typeof inspectInputSchema>;

// ---------------------------------------------------------------------------
// memory.resolve (SS3.5, SS4.1)
// ---------------------------------------------------------------------------

export const resolveInputSchema = z.object({
  workspaceId: z.string().min(1),
  conflictId: z.string().min(1),
  /** The winning record lineage. Must be one of the conflict's own sides. */
  chosenRecordId: z.string().min(1),
  chosenVersion: z.number().int().positive().optional(),
  /** SS3.5 requires a rationale alongside the choice and its author. */
  rationale: z.string().trim().min(1, 'a rationale is required').max(2_000),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export type ResolveInput = z.input<typeof resolveInputSchema>;

// ---------------------------------------------------------------------------
// memory.forget (SS3.5, SS4.1)
// ---------------------------------------------------------------------------

export const forgetInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    /** Delete a whole lineage: every version of this record. */
    recordId: z.string().min(1).optional(),
    /** Delete every accessible record under one topic. */
    topic: z.string().trim().max(LIMITS.topicMax).optional(),
    /**
     * Wipe the payload as well as hiding the row. Default true, because SS3.5
     * requires indexes and managed copies to be cleaned, not merely flagged.
     */
    purge: z.boolean().default(true),
    reason: z.string().trim().max(1_000).default(''),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .refine((value) => Boolean(value.recordId) !== Boolean(value.topic), {
    message: 'provide exactly one of recordId or topic',
    path: ['recordId'],
  });

export type ForgetInput = z.input<typeof forgetInputSchema>;

// ---------------------------------------------------------------------------
// memory.export (SS4.1)
// ---------------------------------------------------------------------------

export const exportInputSchema = z.object({
  workspaceId: z.string().min(1),
  topic: z.string().trim().max(LIMITS.topicMax).optional(),
  /** Include superseded versions, not only the current one. */
  includeVersions: z.boolean().default(true),
  includeLinks: z.boolean().default(true),
  includeConflicts: z.boolean().default(true),
});

export type ExportInput = z.input<typeof exportInputSchema>;

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** A source record as returned to callers. */
export interface RecordView {
  rowId: string;
  recordId: string;
  version: number;
  type: RecordType;
  text: string;
  topic: string;
  source: string;
  scope: Scope;
  factKey: string | null;
  factValue: string | null;
  factContext: string;
  agentId: string;
  agentName: string;
  claimedAuthor: string | null;
  isCurrent: boolean;
  createdAt: string;
  deletedAt: string | null;
}

/** A reference used everywhere a result cites its sources (SS3.4 step 3). */
export interface SourceRef {
  recordId: string;
  version: number;
  agentId: string;
  agentName: string;
  /** Evidence field of the record, not its author. */
  source: string;
}

/** One retrieval item. Exact duplicates collapse here while keeping every author. */
export interface ContextItem {
  text: string;
  topic: string;
  type: RecordType;
  /** Every source record behind this single item (SS3.3, row 1). */
  refs: SourceRef[];
  /** True when more than one record produced this item. */
  merged: boolean;
}

export interface ConflictSideView {
  recordId: string;
  version: number;
  value: string;
  agentId: string;
  agentName: string;
  text: string;
}

export interface ConflictView {
  id: string;
  factKey: string;
  factContext: string;
  scope: Scope;
  status: ConflictStatus;
  detectedAt: string;
  sides: ConflictSideView[];
  resolution: {
    chosenRecordId: string;
    chosenVersion: number;
    rationale: string;
    decidedBy: string;
    decidedByKind: 'user' | 'agent';
    resolvedAt: string;
  } | null;
}

/**
 * The result of recall. When the budget cannot fit both sides of a conflict the
 * builder returns an explicit flag plus references instead of silently picking
 * one side (SS3.4 step 3).
 */
export interface ContextResult {
  workspaceId: string;
  query: string;
  items: ContextItem[];
  /** Unresolved conflicts touching the returned records. */
  conflicts: ConflictView[];
  /** True when the budget forced items or conflict sides to be dropped. */
  incomplete: boolean;
  /** Human-readable notes about what was trimmed and why. */
  notes: string[];
  usedCharacters: number;
  limit: number;
  /** Records considered after the access filter - never a total of the store. */
  consideredRecords: number;
  fromCache: boolean;
}

export interface AddResult {
  recordId: string;
  rowId: string;
  version: number;
  /** True when this call replayed a stored idempotent result (invariant 3). */
  replayed: boolean;
  /** Conflicts detected or reopened by this write. */
  conflicts: ConflictView[];
  /** Derived blocks invalidated by this write (invariant 6). */
  staleBlocks: string[];
}

export interface ImportResult {
  imported: number;
  recordIds: string[];
  replayed: boolean;
  conflicts: ConflictView[];
  skipped: { index: number; reason: string }[];
}

export interface MergedBlockView {
  id: string;
  topic: string;
  title: string;
  scope: Scope;
  items: ContextItem[];
  conflicts: ConflictView[];
  sources: SourceRef[];
  createdAt: string;
  rebuiltAt: string | null;
  stale: boolean;
  staleReason: string | null;
}

export interface MergeResult {
  blocks: MergedBlockView[];
  /** Exact duplicates collapsed in retrieval while all sources were preserved. */
  duplicatesCollapsed: number;
  conflicts: ConflictView[];
  /** Records left alone because the relationship was not certain (SS3.3, row 5). */
  keptSeparate: number;
}

export interface InspectResult {
  records: (RecordView & {
    versions: RecordView[];
    linksOut: { kind: LinkKind; recordId: string; note: string }[];
    linksIn: { kind: LinkKind; recordId: string; note: string }[];
    conflicts: string[];
    usedInBlocks: string[];
  })[];
  conflicts: ConflictView[];
  /** Records on this page. */
  returned: number;
  /**
   * Total matching records the caller may see - never a total of the store
   * (SS3.4 step 2: inaccessible and deleted records contribute to no count).
   */
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface ResolveResult {
  conflict: ConflictView;
  replayed: boolean;
}

export interface ForgetResult {
  deletedRecordIds: string[];
  deletedVersions: number;
  /** Derived blocks invalidated because a source disappeared (invariant 7). */
  invalidatedBlocks: string[];
  /** Conflicts closed because every competing side was deleted. */
  retiredConflicts: string[];
  purged: boolean;
  replayed: boolean;
}

export interface ExportResult {
  workspaceId: string;
  workspaceSlug: string;
  exportedAt: string;
  format: 'offcut.memory.v1';
  records: RecordView[];
  links: { kind: LinkKind; fromRecordId: string; toRecordId: string; note: string }[];
  conflicts: ConflictView[];
  /** Counts reflect only what the caller may see (SS3.4 step 2). */
  counts: { records: number; links: number; conflicts: number };
}
