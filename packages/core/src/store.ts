/**
 * Memory Store (SS4): sources, versions, relationships and transactional writes.
 *
 * The store owns the parts of SS6 that are about durability rather than meaning:
 *
 *   invariant 1  every record keeps workspace, author, source and version
 *   invariant 3  replaying a write request does not create a second record
 *   invariant 4  acknowledged records survive restart; concurrent corrections
 *                cannot silently overwrite each other
 *   invariant 7  after deletion the payload is gone from the index too
 *
 * Note how invariant 4 is enforced: not by a lock or a read-then-write check,
 * but by the database's own unique constraint on (recordId, version). Two
 * corrections racing from the same base version both try to write version N+1;
 * exactly one succeeds and the loser gets VERSION_CONFLICT. There is no window
 * in which one silently wins.
 */

import { Prisma } from '../generated/client';
import type { MemoryRecord } from '../generated/client';
import { getPrisma, type Db, type PrismaClient } from './db';
import { errors } from './errors';
import type { AccessContext } from './access';
import { principalId, principalLabel } from './types';
import type { Operation, RecordType, Scope } from './types';
import {
  contentHashOf,
  hashRequest,
  normalizeFactKey,
  normalizeFactValue,
  normalizeTopic,
  tokenize,
} from './util';

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

// ---------------------------------------------------------------------------
// Idempotency (SS3.2, invariant 3)
// ---------------------------------------------------------------------------

export interface IdempotencyHit<T> {
  replayed: true;
  result: T;
}

/**
 * Looks for a previous run of this exact request.
 *
 * Returns the stored result when the key AND payload match, throws when the key
 * matches but the payload differs ("the same key with different content is
 * rejected"), and returns null when the key is new.
 */
export async function findIdempotent<T>(
  db: Db,
  workspaceId: string,
  key: string | undefined,
  payload: unknown
): Promise<IdempotencyHit<T> | null> {
  if (!key) return null;

  const existing = await db.idempotencyEntry.findUnique({
    where: { workspaceId_key: { workspaceId, key } },
  });
  if (!existing) return null;

  if (existing.requestHash !== hashRequest(payload)) {
    throw errors.idempotencyMismatch(key);
  }

  return { replayed: true, result: JSON.parse(existing.resultJson) as T };
}

/**
 * Records the outcome so a retry can replay it verbatim.
 *
 * A concurrent duplicate may have inserted the same key while this call was
 * running; that is a successful retry, not an error, so the unique violation is
 * swallowed rather than propagated.
 */
export async function saveIdempotent(
  db: Db,
  params: {
    workspaceId: string;
    agentId: string;
    key: string | undefined;
    payload: unknown;
    operation: Operation;
    result: unknown;
  }
): Promise<void> {
  if (!params.key) return;

  try {
    await db.idempotencyEntry.create({
      data: {
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        key: params.key,
        requestHash: hashRequest(params.payload),
        resultJson: JSON.stringify(params.result),
        operation: params.operation,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

/**
 * Idempotency is keyed to an agent, but owners also write from the console. A
 * stable synthetic id keeps those writes replayable without a fake Agent row.
 *
 * Takes the transaction handle rather than reaching for the root client: SQLite
 * allows a single writer, so a root-client write issued from inside an open
 * transaction waits on a lock that transaction itself holds, and the operation
 * deadlocks until the socket times out.
 */
/**
 * The key prefix worn by the console/system writer below.
 *
 * Exported because admin.ts has to exclude that row when it counts agents
 * against LIMITS.agentsPerWorkspaceMax: it is not a key an owner minted, and a
 * literal 'console' in two files is a drift waiting to happen.
 */
export const CONSOLE_KEY_PREFIX = 'console';

export async function resolveWriterAgentId(db: Db, context: AccessContext): Promise<string> {
  if (context.principal.kind === 'agent') return context.principal.agentId;

  // Console and system writes are attributed to a per-workspace "console" agent
  // so that authorship stays a real, inspectable Agent row (invariant 1).
  const name = context.principal.kind === 'user' ? 'Console' : 'System';
  const existing = await db.agent.findFirst({
    where: { workspaceId: context.workspaceId, name, kind: 'lead' },
  });
  if (existing) return existing.id;

  const created = await db.agent.create({
    data: {
      workspaceId: context.workspaceId,
      name,
      kind: 'lead',
      description:
        'Writes made from the web console or during seeding. Holds no API key: it cannot be connected to.',
      // No usable credential: the hash is a namespace string, not a key hash, so
      // no API key can ever authenticate as this agent.
      keyHash: `console:${context.workspaceId}:${name}`,
      // Deliberately outside LIMITS.agentsPerWorkspaceMax: refusing an owner's
      // write because the agent cap was reached would be a memory limit wearing
      // an agent limit's clothes.
      keyPrefix: CONSOLE_KEY_PREFIX,
      canRead: true,
      canWrite: true,
      canImport: true,
      canMerge: true,
      canResolve: true,
      canForget: true,
      canExport: true,
    },
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// Writing records
// ---------------------------------------------------------------------------

export interface WriteRecordParams {
  workspaceId: string;
  agentId: string;
  type: RecordType;
  text: string;
  topic: string;
  source: string;
  scope: Scope;
  factKey?: string | undefined;
  factValue?: string | undefined;
  factContext: string;
  claimedAuthor?: string | undefined;
  /** Present when this write is an authorised correction of an existing lineage. */
  correctsRecordId?: string | undefined;
  expectedVersion?: number | undefined;
}

/**
 * Creates a record, or a new version of one.
 *
 * A correction never mutates the previous row. It writes a new row with
 * version+1 and `previousVersionId` pointing back, then flips `isCurrent` on the
 * old row. The old text stays readable through inspect() forever - SS3.2 calls
 * for "a new version linked to its predecessor", and invariant 1 forbids merging
 * or correcting from destroying sources.
 */
export async function writeRecord(db: Db, params: WriteRecordParams): Promise<MemoryRecord> {
  const topic = normalizeTopic(params.topic);
  const factKey = params.factKey ? normalizeFactKey(params.factKey) : null;
  const factContext = normalizeFactKey(params.factContext);

  const contentHash = contentHashOf({
    text: params.text,
    topic,
    type: params.type,
    scope: params.scope,
  });

  const common = {
    workspaceId: params.workspaceId,
    agentId: params.agentId,
    type: params.type,
    text: params.text,
    topic,
    source: params.source,
    scope: params.scope,
    factKey,
    factValue: params.factValue ?? null,
    factContext,
    claimedAuthor: params.claimedAuthor ?? null,
    contentHash,
  };

  // --- New lineage -------------------------------------------------------
  if (!params.correctsRecordId) {
    const recordId = `rec_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const created = await db.memoryRecord.create({
      data: { ...common, recordId, version: 1, isCurrent: true },
    });
    await indexRecord(db, created);
    return created;
  }

  // --- Correction of an existing lineage ---------------------------------
  const current = await db.memoryRecord.findFirst({
    where: {
      workspaceId: params.workspaceId,
      recordId: params.correctsRecordId,
      isCurrent: true,
      deletedAt: null,
    },
  });

  if (!current) throw errors.notFound(`Record ${params.correctsRecordId}`);

  // Optimistic concurrency: a caller working from a stale read is told to
  // re-read rather than allowed to clobber the newer version (invariant 4).
  if (params.expectedVersion !== undefined && params.expectedVersion !== current.version) {
    throw errors.versionConflict(params.correctsRecordId, params.expectedVersion, current.version);
  }

  const nextVersion = current.version + 1;

  let created: MemoryRecord;
  try {
    created = await db.memoryRecord.create({
      data: {
        ...common,
        recordId: current.recordId,
        version: nextVersion,
        isCurrent: true,
        previousVersionId: current.id,
      },
    });
  } catch (error) {
    // Lost the race for this version number: another correction landed first.
    if (isUniqueViolation(error)) {
      const latest = await db.memoryRecord.findFirst({
        where: { workspaceId: params.workspaceId, recordId: current.recordId, isCurrent: true },
        select: { version: true },
      });
      throw errors.versionConflict(
        params.correctsRecordId,
        params.expectedVersion ?? current.version,
        latest?.version ?? nextVersion
      );
    }
    throw error;
  }

  // The predecessor stops being current but is never removed.
  await db.memoryRecord.update({
    where: { id: current.id },
    data: { isCurrent: false },
  });

  // Only the current version is searchable; superseded text stays reachable
  // through inspect() but must not surface as today's answer (invariant 6).
  await db.searchDoc.deleteMany({ where: { recordRowId: current.id } });
  await indexRecord(db, created);

  return created;
}

// ---------------------------------------------------------------------------
// Search index (SS4: "sources + versions + search index")
// ---------------------------------------------------------------------------

/**
 * Indexed as explicit rows rather than computed on the fly, precisely so that
 * SS3.5's "indexes and managed copies are cleaned up" is a delete statement we
 * can point at, not an aspiration.
 */
export async function indexRecord(db: Db, record: MemoryRecord): Promise<void> {
  const parts = [record.text, record.topic, record.factKey ?? '', record.factValue ?? ''];
  const tokens = tokenize(parts.join(' '));

  await db.searchDoc.upsert({
    where: { recordRowId: record.id },
    create: {
      workspaceId: record.workspaceId,
      recordRowId: record.id,
      recordId: record.recordId,
      version: record.version,
      scope: record.scope,
      agentId: record.agentId,
      tokens: tokens.join(' '),
      length: tokens.length,
    },
    update: {
      tokens: tokens.join(' '),
      length: tokens.length,
      scope: record.scope,
      version: record.version,
    },
  });
}

export async function removeFromIndex(db: Db, recordRowIds: string[]): Promise<void> {
  if (recordRowIds.length === 0) return;
  await db.searchDoc.deleteMany({ where: { recordRowId: { in: recordRowIds } } });
}

// ---------------------------------------------------------------------------
// Recall cache (SS3.4: "access checks also apply to cached results")
// ---------------------------------------------------------------------------

/**
 * Invalidated on every mutation. The cache never stores rendered text - only
 * record ids - so a cache hit still runs the full access filter and cannot
 * outlive a revocation.
 */
export async function invalidateCache(db: Db, workspaceId: string): Promise<void> {
  await db.recallCacheEntry.updateMany({
    where: { workspaceId, invalidatedAt: null },
    data: { invalidatedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Audit (SS3.5 requires a recorded decision author)
// ---------------------------------------------------------------------------

export async function audit(
  db: Db,
  context: AccessContext,
  action: string,
  targetId: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await db.auditEvent.create({
    data: {
      workspaceId: context.workspaceId,
      actorType: context.principal.kind,
      actorId: principalId(context.principal),
      actorName: principalLabel(context.principal),
      action,
      targetId,
      detail: JSON.stringify(detail),
    },
  });
}

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

/**
 * All multi-step writes run inside one interactive transaction so a crash
 * mid-operation leaves no half-written state (invariant 4: "acknowledged records
 * survive a restart"). The timeout is generous because merge() can touch many
 * rows on a large workspace.
 */
export async function transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return inTransaction(getPrisma(), fn);
}

/**
 * The same guarantee for a function handed a database rather than reaching for
 * one, so it cannot be given a handle and then quietly write somewhere else.
 *
 * Given a transaction handle the steps run inline, because the caller's
 * transaction already covers them. Opening a second one there would not merely
 * be redundant: Prisma gives SQLite a pool of one connection, so the inner
 * transaction would wait for the connection the outer one is holding until the
 * operation times out.
 */
export async function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const root = db as PrismaClient;
  if (typeof root.$transaction !== 'function') return fn(db);

  return root.$transaction(async (tx) => fn(tx as unknown as Db), {
    maxWait: 10_000,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

export async function agentNameMap(db: Db, agentIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(agentIds)];
  if (unique.length === 0) return new Map();

  const rows = await db.agent.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Normalised structured-fact identity, used as the conflict grouping key. */
export function factIdentity(record: {
  factKey: string | null;
  factContext: string;
  scope: string;
}): string | null {
  const key = normalizeFactKey(record.factKey);
  if (!key) return null;
  return `${record.scope}::${key}::${normalizeFactKey(record.factContext)}`;
}

export function factValueOf(record: { factValue: string | null }): string {
  return normalizeFactValue(record.factValue);
}

export { isUniqueViolation };
