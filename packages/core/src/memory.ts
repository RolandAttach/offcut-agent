/**
 * The eight memory operations of SS4.1.
 *
 * This class IS the core. The SDK wraps it, the MCP server wraps it, and the
 * HTTP API wraps it - none of them add business logic of their own. That is how
 * invariant 8 ("SDK and MCP enforce the same access and mutation rules") is met
 * structurally rather than by keeping two implementations in sync by hand.
 *
 * Every operation follows the same skeleton:
 *   validate input -> authorize -> transaction { idempotency, work, audit } -> result
 */

import { getPrisma, insensitiveContains, type Db } from './db';
import { errors, parseInput } from './errors';
import {
  authorize,
  canCorrectRecordOf,
  canDecideTruth,
  looksLikeInjection,
  visibilityWhere,
  type AccessContext,
} from './access';
import {
  agentNameMap,
  audit,
  findIdempotent,
  invalidateCache,
  removeFromIndex,
  resolveWriterAgentId,
  saveIdempotent,
  transaction,
  writeRecord,
} from './store';
import {
  detectConflicts,
  listBlocks,
  loadConflictView,
  markBlocksStale,
  openConflicts,
  runMerge,
} from './merge';
import { buildContext, readCachedRecordIds, recallCacheKey, writeCache } from './context';
import { appendDeletions } from './ledger';
import { creditRetrieval } from './credits';
import {
  reportUsage as recordSpendReports,
  type ReportUsageResult,
  type UsageReport,
} from './usage';
import {
  addInputSchema,
  exportInputSchema,
  forgetInputSchema,
  importInputSchema,
  importRecordSchema,
  inspectInputSchema,
  mergeInputSchema,
  recallInputSchema,
  resolveInputSchema,
} from './types';
import type {
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
  LinkKind,
  MergeInput,
  MergeResult,
  MergedBlockView,
  Principal,
  RecallInput,
  RecordType,
  RecordView,
  ResolveInput,
  ResolveResult,
  Scope,
} from './types';
import { normalizeTopic } from './util';

function toRecordView(
  row: {
    id: string;
    recordId: string;
    version: number;
    type: string;
    text: string;
    topic: string;
    source: string;
    scope: string;
    agentId: string;
    factKey: string | null;
    factValue: string | null;
    factContext: string;
    claimedAuthor: string | null;
    isCurrent: boolean;
    createdAt: Date;
    deletedAt: Date | null;
  },
  names: Map<string, string>
): RecordView {
  return {
    rowId: row.id,
    recordId: row.recordId,
    version: row.version,
    type: row.type as RecordType,
    text: row.text,
    topic: row.topic,
    source: row.source,
    scope: row.scope as Scope,
    factKey: row.factKey,
    factValue: row.factValue,
    factContext: row.factContext,
    agentId: row.agentId,
    agentName: names.get(row.agentId) ?? 'unknown',
    claimedAuthor: row.claimedAuthor,
    isCurrent: row.isCurrent,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// The audit trail, as the console reads it
// ---------------------------------------------------------------------------

/** One entry of the append-only trail. timeline() and eventsSince() agree on it. */
export interface AuditEventView {
  id: string;
  actorType: string;
  actorName: string;
  action: string;
  targetId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

/**
 * A position in the trail: a timestamp, and an id to break ties inside it.
 *
 * The id half is not decoration. createdAt has millisecond resolution and one
 * agent write appends several entries inside a single millisecond, so a
 * timestamp on its own either re-sends those entries forever or loses the ones
 * the caller has not seen. cuid ids do not sort by time, which is exactly why
 * they are the TIEBREAK and never the ordering: (createdAt, id) is a total
 * order, id alone is not an order at all.
 *
 * `afterId` may be omitted, and then only strictly later timestamps follow. An
 * empty string is a real value rather than a missing one - it sorts before
 * every cuid, so it reads as "everything in this millisecond".
 */
export interface EventCursor {
  /** ISO timestamp of the newest entry the caller already has. */
  after: string;
  afterId?: string;
}

/** A page of the trail, and the position to ask from next. */
export interface EventPage {
  events: AuditEventView[];
  /** The last returned entry's position - or the cursor passed in, if none were. */
  cursor: EventCursor;
}

function toAuditEventView(row: {
  id: string;
  actorType: string;
  actorName: string;
  action: string;
  targetId: string;
  detail: string;
  createdAt: Date;
}): AuditEventView {
  return {
    id: row.id,
    actorType: row.actorType,
    actorName: row.actorName,
    action: row.action,
    targetId: row.targetId,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

export class Memory {
  constructor(private readonly principal: Principal) {}

  /** The caller this instance acts as. Identity is fixed at construction. */
  get identity(): Principal {
    return this.principal;
  }

  // -------------------------------------------------------------------------
  // memory.add
  // -------------------------------------------------------------------------

  /**
   * Saves a source record, or an authorised correction of one.
   *
   * A correction (`correctsRecordId`) writes a NEW version and links it to its
   * predecessor; nothing is overwritten (SS3.2, invariant 1). Supplying
   * `expectedVersion` makes the write fail rather than clobber a concurrent
   * correction (invariant 4).
   */
  async add(input: AddInput): Promise<AddResult> {
    const parsed = parseInput(addInputSchema, input);
    const context = await authorize(this.principal, parsed.workspaceId, 'add');

    return transaction(async (tx) => {
      // Invariant 3: replaying one write request must not create a second record.
      const replay = await findIdempotent<AddResult>(
        tx,
        context.workspaceId,
        parsed.idempotencyKey,
        parsed
      );
      if (replay) return { ...replay.result, replayed: true };

      const agentId = await resolveWriterAgentId(tx, context);

      if (parsed.correctsRecordId) {
        const target = await tx.memoryRecord.findFirst({
          where: {
            workspaceId: context.workspaceId,
            recordId: parsed.correctsRecordId,
            isCurrent: true,
            deletedAt: null,
          },
          select: { agentId: true },
        });
        if (!target) throw errors.notFound(`Record ${parsed.correctsRecordId}`);

        // SS2: a subagent cannot overwrite another agent's record.
        if (!canCorrectRecordOf(context, target.agentId)) {
          throw errors.accessDenied('correct a record authored by another agent');
        }
      }

      const record = await writeRecord(tx, {
        workspaceId: context.workspaceId,
        agentId,
        type: parsed.type,
        text: parsed.text,
        topic: parsed.topic,
        source: parsed.source,
        scope: parsed.scope,
        factKey: parsed.factKey,
        factValue: parsed.factValue,
        factContext: parsed.factContext,
        correctsRecordId: parsed.correctsRecordId,
        expectedVersion: parsed.expectedVersion,
      });

      // Explicit relationships. These are merge signals, not permissions.
      for (const link of parsed.links) {
        const target = await tx.memoryRecord.findFirst({
          where: {
            workspaceId: context.workspaceId,
            recordId: link.recordId,
            isCurrent: true,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!target) continue;

        await tx.recordLink
          .create({
            data: {
              workspaceId: context.workspaceId,
              kind: link.kind,
              fromRecordId: record.id,
              toRecordId: target.id,
              note: link.note,
              createdByAgentId: agentId,
            },
          })
          .catch(() => undefined); // duplicate link is a no-op
      }

      // A correction is itself an update-link to the previous version, so the
      // lineage reads as a chain in inspect() (SS3.6: "links to T1 as an update").
      if (parsed.correctsRecordId && record.previousVersionId) {
        await tx.recordLink
          .create({
            data: {
              workspaceId: context.workspaceId,
              kind: 'updates',
              fromRecordId: record.id,
              toRecordId: record.previousVersionId,
              note: 'authorised correction',
              createdByAgentId: agentId,
            },
          })
          .catch(() => undefined);
      }

      const conflicts = await detectConflicts(tx, context, { scope: parsed.scope });

      // Any derived block citing this lineage can no longer claim to be current.
      const staleBlocks = await markBlocksStale(
        tx,
        context.workspaceId,
        [record.recordId, ...parsed.links.map((link) => link.recordId)],
        'a source record changed'
      );

      await invalidateCache(tx, context.workspaceId);

      await audit(tx, context, 'memory.add', record.recordId, {
        version: record.version,
        topic: record.topic,
        type: record.type,
        correction: Boolean(parsed.correctsRecordId),
        // Flagged for display only. It changes no permission anywhere (SS4.2).
        injectionSuspected: looksLikeInjection(parsed.text),
      });

      const result: AddResult = {
        recordId: record.recordId,
        rowId: record.id,
        version: record.version,
        replayed: false,
        conflicts,
        staleBlocks,
      };

      await saveIdempotent(tx, {
        workspaceId: context.workspaceId,
        agentId,
        key: parsed.idempotencyKey,
        payload: parsed,
        operation: 'add',
        result,
      });

      return result;
    });
  }

  // -------------------------------------------------------------------------
  // memory.import
  // -------------------------------------------------------------------------

  /**
   * Loads explicitly supplied JSON records.
   *
   * SS3.1 is emphatic that this is the ONLY way existing notes enter OFFCUT -
   * connecting does not grant access to anyone's chat history. Claimed
   * authorship in the payload is stored in `claimedAuthor` and never becomes the
   * verified `agentId`, which is what closes the spoofing risk in SS7.
   */
  async import(input: ImportInput): Promise<ImportResult> {
    const parsed = parseInput(importInputSchema, input);
    const context = await authorize(this.principal, parsed.workspaceId, 'import');

    return transaction(async (tx) => {
      const replay = await findIdempotent<ImportResult>(
        tx,
        context.workspaceId,
        parsed.idempotencyKey,
        parsed
      );
      if (replay) return { ...replay.result, replayed: true };

      const agentId = await resolveWriterAgentId(tx, context);
      const recordIds: string[] = [];
      const skipped: { index: number; reason: string }[] = [];

      for (let index = 0; index < parsed.records.length; index += 1) {
        const candidate = parsed.records[index]!;

        const validation = importRecordSchema.safeParse(candidate);
        if (!validation.success) {
          skipped.push({
            index,
            reason: validation.error.issues.map((issue) => issue.message).join('; '),
          });
          continue;
        }

        const entry = validation.data;
        const record = await writeRecord(tx, {
          workspaceId: context.workspaceId,
          // Authorship is the importing connection - never the payload's claim.
          agentId,
          type: entry.type,
          text: entry.text,
          topic: entry.topic,
          source: entry.source,
          scope: entry.scope,
          factKey: entry.factKey,
          factValue: entry.factValue,
          factContext: entry.factContext,
          claimedAuthor: entry.claimedAuthor,
        });
        recordIds.push(record.recordId);
      }

      const conflicts = await detectConflicts(tx, context);
      await markBlocksStale(tx, context.workspaceId, recordIds, 'records were imported');
      await invalidateCache(tx, context.workspaceId);

      await audit(tx, context, 'memory.import', '', {
        imported: recordIds.length,
        skipped: skipped.length,
      });

      const result: ImportResult = {
        imported: recordIds.length,
        recordIds,
        replayed: false,
        conflicts,
        skipped,
      };

      await saveIdempotent(tx, {
        workspaceId: context.workspaceId,
        agentId,
        key: parsed.idempotencyKey,
        payload: parsed,
        operation: 'import',
        result,
      });

      return result;
    });
  }

  // -------------------------------------------------------------------------
  // memory.merge
  // -------------------------------------------------------------------------

  /** Combines accessible records into derived blocks (SS3.3). */
  async merge(input: MergeInput): Promise<MergeResult> {
    const parsed = parseInput(mergeInputSchema, input);
    const context = await authorize(this.principal, parsed.workspaceId, 'merge');

    return transaction(async (tx) => {
      const replay = await findIdempotent<MergeResult>(
        tx,
        context.workspaceId,
        parsed.idempotencyKey,
        parsed
      );
      if (replay) return replay.result;

      const result = await runMerge(tx, context, {
        topic: parsed.topic,
        recordIds: parsed.recordIds,
        scope: parsed.scope,
        rebuildStale: parsed.rebuildStale,
      });

      if (parsed.idempotencyKey) {
        await saveIdempotent(tx, {
          workspaceId: context.workspaceId,
          agentId: await resolveWriterAgentId(tx, context),
          key: parsed.idempotencyKey,
          payload: parsed,
          operation: 'merge',
          result,
        });
      }

      return result;
    });
  }

  // -------------------------------------------------------------------------
  // memory.recall
  // -------------------------------------------------------------------------

  /**
   * Retrieves task context (SS3.4).
   *
   * The primary acceptance check of SS7.1 runs through this method: a new lead
   * agent asks one question and receives the merged work of subagents it never
   * met, with references, without the user repeating anything.
   */
  async recall(input: RecallInput): Promise<ContextResult> {
    const parsed = parseInput(recallInputSchema, input);
    const context = await authorize(this.principal, parsed.workspaceId, 'recall');
    const db = getPrisma();

    const options = {
      query: parsed.query,
      topic: parsed.topic,
      limit: parsed.limit,
      maxItems: parsed.maxItems,
      types: parsed.types,
      useCache: parsed.useCache,
    };

    const result = await buildContext(db, context, options);

    // The cache holds ids only; a hit re-reads them through the access filter,
    // so revoked or deleted records can never be served from it (SS3.4).
    if (parsed.useCache) {
      const key = recallCacheKey({ ...options, workspaceId: context.workspaceId });
      const cached = await readCachedRecordIds(db, context.workspaceId, key);
      if (cached) {
        const stillVisible = await db.memoryRecord.count({
          where: { ...visibilityWhere(context), id: { in: cached } },
        });
        result.fromCache = stillVisible === cached.length && cached.length > 0;
      }

      await writeCache(
        db,
        context.workspaceId,
        key,
        result.items.flatMap((item) => item.refs.map((ref) => ref.recordId))
      );
    }

    // Records this caller did not write, that this caller just used. Runs after
    // the access filter, so nothing invisible is ever credited, and swallows its
    // own failures: a retrieval must not break because a rewards table did.
    await creditRetrieval(db, context, result);

    return result;
  }

  // -------------------------------------------------------------------------
  // memory.inspect
  // -------------------------------------------------------------------------

  /**
   * Shows sources, relationships, versions and conflicts.
   *
   * This is what makes SS3.3's promise auditable: merged retrieval never
   * destroys anything, and inspect() is where you go to prove it - every
   * superseded version is still readable here.
   */
  async inspect(input: InspectInput): Promise<InspectResult> {
    const parsed = parseInput(inspectInputSchema, input);
    const context = await authorize(this.principal, parsed.workspaceId, 'inspect');
    const db = getPrisma();

    const where = visibilityWhere(context, { includeDeleted: parsed.includeDeleted });

    // The filter is assembled once and used for both the count and the page, so
    // `total` can never describe a different set than `records` came from.
    const filter = {
      ...where,
      isCurrent: true,
      ...(parsed.recordId ? { recordId: parsed.recordId } : {}),
      ...(parsed.topic ? { topic: normalizeTopic(parsed.topic) } : {}),
      ...(parsed.types && parsed.types.length > 0 ? { type: { in: parsed.types } } : {}),
      ...(parsed.search
        ? {
            // insensitiveContains, not a bare `contains`: the two supported
            // databases disagree about case, and a search box that finds
            // different things on SQLite than on PostgreSQL is a bug, not a
            // deployment detail.
            OR: [
              { text: insensitiveContains(parsed.search) },
              { topic: insensitiveContains(parsed.search) },
              { source: insensitiveContains(parsed.search) },
            ],
          }
        : {}),
    };

    // Counted through the same visibility filter: a caller never learns how many
    // records exist beyond what they may see (SS7.1).
    const total = await db.memoryRecord.count({ where: filter });

    const currentRows = await db.memoryRecord.findMany({
      where: filter,
      orderBy: { createdAt: 'desc' },
      skip: parsed.offset,
      take: parsed.limit,
    });

    if (parsed.recordId && currentRows.length === 0) {
      throw errors.notFound(`Record ${parsed.recordId}`);
    }

    const lineageIds = currentRows.map((row) => row.recordId);

    const allVersions = await db.memoryRecord.findMany({
      where: { ...where, recordId: { in: lineageIds } },
      orderBy: { version: 'asc' },
    });

    const names = await agentNameMap(db, allVersions.map((row) => row.agentId));

    const links = await db.recordLink.findMany({
      where: { workspaceId: context.workspaceId },
      include: {
        from: { select: { recordId: true } },
        to: { select: { recordId: true } },
      },
    });

    const blockSources = await db.mergedBlockSource.findMany({
      where: { recordId: { in: lineageIds } },
      select: { recordId: true, blockId: true },
    });

    const conflictRows = await db.conflict.findMany({
      where: {
        workspaceId: context.workspaceId,
        sides: { some: { recordId: { in: lineageIds } } },
      },
      include: { sides: true },
    });

    const conflicts: ConflictView[] = [];
    for (const row of conflictRows) {
      const view = await loadConflictView(db, row.id);
      if (view) conflicts.push(view);
    }

    const records = currentRows.map((row) => {
      const view = toRecordView(row, names);
      const versions = allVersions
        .filter((version) => version.recordId === row.recordId)
        .map((version) => toRecordView(version, names));

      return {
        ...view,
        versions,
        linksOut: links
          .filter((link) => link.from.recordId === row.recordId)
          .map((link) => ({
            kind: link.kind as LinkKind,
            recordId: link.to.recordId,
            note: link.note,
          })),
        linksIn: links
          .filter((link) => link.to.recordId === row.recordId)
          .map((link) => ({
            kind: link.kind as LinkKind,
            recordId: link.from.recordId,
            note: link.note,
          })),
        conflicts: conflicts
          .filter((conflict) => conflict.sides.some((side) => side.recordId === row.recordId))
          .map((conflict) => conflict.id),
        usedInBlocks: [
          ...new Set(
            blockSources
              .filter((source) => source.recordId === row.recordId)
              .map((source) => source.blockId)
          ),
        ],
      };
    });

    return {
      records,
      conflicts,
      returned: records.length,
      total,
      offset: parsed.offset,
      limit: parsed.limit,
      hasMore: parsed.offset + records.length < total,
    };
  }

  // -------------------------------------------------------------------------
  // memory.resolve
  // -------------------------------------------------------------------------

  /**
   * Records an authorised conflict resolution (SS3.5).
   *
   * The chosen version, the rationale and the decision author are all stored.
   * The losing side is NOT deleted - SS7.1 requires that neither version is ever
   * overwritten, so both stay inspectable after the decision.
   */
  async resolve(input: ResolveInput): Promise<ResolveResult> {
    const parsed = parseInput(resolveInputSchema, input);
    const context = await authorize(this.principal, parsed.workspaceId, 'resolve');

    // Repetition and the title "lead agent" do not by themselves grant the
    // authority to determine truth (SS3.5).
    if (!canDecideTruth(context)) {
      throw errors.accessDenied('resolve a conflict without the resolve permission');
    }

    return transaction(async (tx) => {
      const replay = await findIdempotent<ResolveResult>(
        tx,
        context.workspaceId,
        parsed.idempotencyKey,
        parsed
      );
      if (replay) return { ...replay.result, replayed: true };

      const conflict = await tx.conflict.findFirst({
        where: { id: parsed.conflictId, workspaceId: context.workspaceId },
        include: { sides: true },
      });
      if (!conflict) throw errors.notFound('Conflict');

      // The winner must be one of the conflict's own sides: a resolution cannot
      // introduce a third answer that no agent ever recorded.
      const side = conflict.sides.find((candidate) => candidate.recordId === parsed.chosenRecordId);
      if (!side) {
        throw errors.validation('The chosen record is not one of this conflict\'s sides.', {
          conflictId: conflict.id,
          sides: conflict.sides.map((candidate) => candidate.recordId),
        });
      }

      await tx.conflict.update({
        where: { id: conflict.id },
        data: {
          status: 'resolved',
          resolvedRecordId: side.recordId,
          resolvedVersion: parsed.chosenVersion ?? side.version,
          rationale: parsed.rationale,
          resolvedByUserId: context.principal.kind === 'user' ? context.principal.userId : null,
          resolvedByAgentId: context.principal.kind === 'agent' ? context.principal.agentId : null,
          resolvedAt: new Date(),
        },
      });

      await markBlocksStale(
        tx,
        context.workspaceId,
        conflict.sides.map((candidate) => candidate.recordId),
        'a conflict was resolved'
      );
      await invalidateCache(tx, context.workspaceId);

      await audit(tx, context, 'memory.resolve', conflict.id, {
        factKey: conflict.factKey,
        chosenRecordId: side.recordId,
        rationale: parsed.rationale,
      });

      const view = await loadConflictView(tx, conflict.id);
      const result: ResolveResult = { conflict: view!, replayed: false };

      if (parsed.idempotencyKey) {
        await saveIdempotent(tx, {
          workspaceId: context.workspaceId,
          agentId: await resolveWriterAgentId(tx, context),
          key: parsed.idempotencyKey,
          payload: parsed,
          operation: 'resolve',
          result,
        });
      }

      return result;
    });
  }

  // -------------------------------------------------------------------------
  // memory.forget
  // -------------------------------------------------------------------------

  /**
   * Deletes memory within the caller's permissions (SS3.5).
   *
   * Invariant 7 is strict: after deletion is acknowledged, the record must not
   * return through search, export, cache or a dependent summary. Meeting all
   * four takes four separate actions, and this method does each of them:
   *
   *   search     - the SearchDoc rows are deleted
   *   export     - the row is tombstoned (deletedAt) and its payload wiped
   *   cache      - the workspace's recall cache is invalidated
   *   summaries  - dependent derived blocks are DELETED, not just flagged stale,
   *                because a stale block still holds the deleted text in its body
   *
   * The tombstone row itself survives so that lineage and audit stay honest: you
   * can still see that a record existed and was removed, just not what it said.
   */
  async forget(input: ForgetInput): Promise<ForgetResult> {
    const parsed = parseInput(forgetInputSchema, input);
    const context = await authorize(this.principal, parsed.workspaceId, 'forget');

    const result = await transaction(async (tx) => {
      const replay = await findIdempotent<ForgetResult>(
        tx,
        context.workspaceId,
        parsed.idempotencyKey,
        parsed
      );
      if (replay) return { ...replay.result, replayed: true };

      const where = visibilityWhere(context);
      const targets = await tx.memoryRecord.findMany({
        where: {
          ...where,
          ...(parsed.recordId ? { recordId: parsed.recordId } : {}),
          ...(parsed.topic ? { topic: normalizeTopic(parsed.topic) } : {}),
        },
      });

      if (targets.length === 0) {
        throw errors.notFound(parsed.recordId ? `Record ${parsed.recordId}` : 'Records for topic');
      }

      // An agent may only delete what it authored, unless it is the owner.
      if (!context.isOwner) {
        const foreign = targets.filter(
          (row) =>
            context.principal.kind !== 'agent' || row.agentId !== context.principal.agentId
        );
        if (foreign.length > 0) {
          throw errors.accessDenied('delete records authored by another agent');
        }
      }

      const rowIds = targets.map((row) => row.id);
      const lineageIds = [...new Set(targets.map((row) => row.recordId))];
      const now = new Date();

      // 1. Tombstone, and wipe the payload when purging.
      await tx.memoryRecord.updateMany({
        where: { id: { in: rowIds } },
        data: parsed.purge
          ? {
              deletedAt: now,
              deletedBy: context.principal.kind === 'agent' ? context.principal.agentId : 'owner',
              purged: true,
              isCurrent: false,
              text: '',
              topic: '',
              source: '',
              factKey: null,
              factValue: null,
              claimedAuthor: null,
              contentHash: '',
            }
          : {
              deletedAt: now,
              deletedBy: context.principal.kind === 'agent' ? context.principal.agentId : 'owner',
              isCurrent: false,
            },
      });

      // 2. Search index.
      await removeFromIndex(tx, rowIds);

      // 3. Dependent derived blocks - removed outright, since a stale block
      //    still carries the deleted text inside its body.
      const dependent = await tx.mergedBlockSource.findMany({
        where: { recordId: { in: lineageIds }, block: { workspaceId: context.workspaceId } },
        select: { blockId: true },
      });
      const blockIds = [...new Set(dependent.map((row) => row.blockId))];
      if (blockIds.length > 0) {
        await tx.mergedBlock.deleteMany({ where: { id: { in: blockIds } } });
      }

      // 4. Conflict sides that pointed at deleted records.
      await tx.conflictSide.deleteMany({ where: { recordRowId: { in: rowIds } } });

      // A conflict needs at least two competing sides to still be a conflict.
      const touched = await tx.conflict.findMany({
        where: { workspaceId: context.workspaceId },
        include: { sides: true },
      });
      const retiredConflicts: string[] = [];
      for (const conflict of touched) {
        const distinct = new Set(conflict.sides.map((side) => side.value.trim().toLowerCase()));
        if (conflict.sides.length < 2 || distinct.size < 2) {
          await tx.conflict.delete({ where: { id: conflict.id } });
          retiredConflicts.push(conflict.id);
        }
      }

      // 5. Recall cache.
      await invalidateCache(tx, context.workspaceId);

      // 6. The deletion ledger (OPEN-5).
      //
      // Written inside the same transaction as the deletion itself, so the two
      // can never disagree. This is what lets a restore replay deletions that
      // happened after a snapshot was taken, instead of resurrecting content the
      // user destroyed (invariant 7).
      const deletedBy =
        context.principal.kind === 'agent' ? context.principal.agentId : 'owner';

      for (const lineageId of lineageIds) {
        await tx.deletionLedgerEntry.create({
          data: {
            workspaceId: context.workspaceId,
            recordId: lineageId,
            rowIds: JSON.stringify(
              targets.filter((row) => row.recordId === lineageId).map((row) => row.id)
            ),
            purged: parsed.purge,
            deletedBy,
            reason: parsed.reason,
          },
        });
      }

      await audit(tx, context, 'memory.forget', parsed.recordId ?? parsed.topic ?? '', {
        versions: rowIds.length,
        lineages: lineageIds.length,
        purged: parsed.purge,
        reason: parsed.reason,
      });

      const result: ForgetResult = {
        deletedRecordIds: lineageIds,
        deletedVersions: rowIds.length,
        invalidatedBlocks: blockIds,
        retiredConflicts,
        purged: parsed.purge,
        replayed: false,
      };

      if (parsed.idempotencyKey) {
        await saveIdempotent(tx, {
          workspaceId: context.workspaceId,
          agentId: await resolveWriterAgentId(tx, context),
          key: parsed.idempotencyKey,
          payload: parsed,
          operation: 'forget',
          result,
        });
      }

      return result;
    });

    // Mirror to the ledger FILE, after the transaction has committed.
    //
    // The database row is the authoritative record and is written inside the
    // transaction above. This copy lives outside the snapshot rotation so that
    // restoring an older backup can replay deletions that happened after it was
    // taken (OPEN-5). A replayed idempotent call is skipped - the deletion was
    // already mirrored on its first run.
    if (!result.replayed) {
      appendDeletions(
        result.deletedRecordIds.map((recordId) => ({
          workspaceId: context.workspaceId,
          recordId,
          rowIds: [],
          purged: result.purged,
          deletedBy: context.principal.kind === 'agent' ? context.principal.agentId : 'owner',
          reason: parsed.reason,
          deletedAt: new Date().toISOString(),
        }))
      );
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // memory.export
  // -------------------------------------------------------------------------

  /**
   * Exports accessible memory and relationships as JSON.
   *
   * "Accessible" does the heavy lifting: the counts at the end reflect only what
   * this caller may see, never a total of the store (SS3.4 step 2, SS7.1). The
   * output is the same shape import() accepts, so a workspace round-trips.
   */
  async export(input: ExportInput): Promise<ExportResult> {
    const parsed = parseInput(exportInputSchema, input);
    const context = await authorize(this.principal, parsed.workspaceId, 'export');
    const db = getPrisma();

    const where = visibilityWhere(context);
    const rows = await db.memoryRecord.findMany({
      where: {
        ...where,
        ...(parsed.includeVersions ? {} : { isCurrent: true }),
        ...(parsed.topic ? { topic: normalizeTopic(parsed.topic) } : {}),
      },
      orderBy: [{ recordId: 'asc' }, { version: 'asc' }],
    });

    const names = await agentNameMap(db, rows.map((row) => row.agentId));
    const records = rows.map((row) => toRecordView(row, names));
    const lineageIds = new Set(records.map((record) => record.recordId));

    const links = parsed.includeLinks
      ? (
          await db.recordLink.findMany({
            where: { workspaceId: context.workspaceId },
            include: {
              from: { select: { recordId: true } },
              to: { select: { recordId: true } },
            },
          })
        )
          // Never export an edge that points at something the caller cannot see.
          .filter((link) => lineageIds.has(link.from.recordId) && lineageIds.has(link.to.recordId))
          .map((link) => ({
            kind: link.kind as LinkKind,
            fromRecordId: link.from.recordId,
            toRecordId: link.to.recordId,
            note: link.note,
          }))
      : [];

    const conflicts = parsed.includeConflicts ? await openConflicts(db, context) : [];

    await audit(db, context, 'memory.export', parsed.topic ?? '*', {
      records: records.length,
      links: links.length,
    });

    return {
      workspaceId: context.workspaceId,
      workspaceSlug: context.workspaceSlug,
      exportedAt: new Date().toISOString(),
      format: 'offcut.memory.v1',
      records,
      links,
      conflicts,
      counts: {
        records: records.length,
        links: links.length,
        conflicts: conflicts.length,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Confirmed AI spend - the metric rewards are paid on (usage.ts)
  // -------------------------------------------------------------------------

  /**
   * Records the provider generation ids of model calls made on this workspace's
   * tasks. Nothing is payable until the provider confirms them.
   *
   * Not one of the eight, and here anyway: the SDK, MCP and HTTP all have to
   * offer this, and all three have to land on the same row behind the same
   * unique key. A second path to the usage table would be a second way for one
   * request to be counted twice, which is the one thing the brief forbids
   * outright - so there is no second path, exactly as for memory itself.
   *
   * Authorised as `recall`. The part of authorize() that matters here is the
   * part it does whichever operation it is handed: the workspace exists, the
   * key belongs to THIS workspace, and the agent has not been revoked since it
   * authenticated. The read flag comes along with that choice, so an agent
   * whose read access was withdrawn stops reporting too - a wider gate than
   * this needs, and the alternative is a ninth permission flag in the console
   * that nobody could explain. reportUsage then applies the rule that decides
   * the metric: only an agent may report, because only a subagent spends model
   * tokens on a task.
   */
  async reportUsage(workspaceId: string, reports: UsageReport[]): Promise<ReportUsageResult> {
    const context = await authorize(this.principal, workspaceId, 'recall');
    return recordSpendReports(getPrisma(), context, reports);
  }

  // -------------------------------------------------------------------------
  // Read helpers used by the console (same access rules, no new logic)
  // -------------------------------------------------------------------------

  /** Stored derived blocks, with staleness reported rather than hidden. */
  async blocks(workspaceId: string, topic?: string): Promise<MergedBlockView[]> {
    const context = await authorize(this.principal, workspaceId, 'inspect');
    return listBlocks(getPrisma(), context, topic ? { topic } : {});
  }

  /** Every unresolved conflict visible to this caller. */
  async conflicts(workspaceId: string): Promise<ConflictView[]> {
    const context = await authorize(this.principal, workspaceId, 'inspect');
    return openConflicts(getPrisma(), context);
  }

  /** Recent audit entries. Console-only: agents have no reason to read this. */
  async timeline(workspaceId: string, limit = 50): Promise<AuditEventView[]> {
    const context = await authorize(this.principal, workspaceId, 'inspect');
    if (!context.isOwner) throw errors.accessDenied('read the workspace timeline');

    const rows = await getPrisma().auditEvent.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });

    return rows.map(toAuditEventView);
  }

  /**
   * Where the trail stands right now.
   *
   * A live feed has to start somewhere, and the beginning of time is the wrong
   * place: the console has already drawn its list from timeline(), so replaying
   * it would make every reconnect look like a burst of work that never
   * happened. Handing back the head position instead lets the client say "I
   * have everything up to here" and take the stream from that exact point, so
   * the seam between the snapshot and the feed has neither a gap nor a double.
   *
   * Owner-only for the reason timeline() is: watching a workspace work is the
   * console's job, and an agent has nothing to do with it.
   */
  async eventsCursor(workspaceId: string): Promise<EventCursor> {
    const context = await authorize(this.principal, workspaceId, 'inspect');
    if (!context.isOwner) throw errors.accessDenied('watch the workspace event stream');

    const newest = await getPrisma().auditEvent.findFirst({
      where: { workspaceId: context.workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true },
    });

    // Nothing written yet, so stand at this millisecond with an empty tiebreak:
    // an entry landing in the very same millisecond is then still "after". A
    // bare timestamp would drop it, and a dropped first entry is precisely the
    // gap the cursor exists to close.
    if (!newest) return { after: new Date().toISOString(), afterId: '' };

    return { after: newest.createdAt.toISOString(), afterId: newest.id };
  }

  /**
   * Entries appended after `cursor`, oldest first, with the next cursor.
   *
   * Ascending, unlike timeline(): a feed is read in the order the work
   * happened, and a page has to end at a position the next call can continue
   * from. `limit` is capped the same way timeline()'s is, so a caller polling
   * a busy workspace gets a page rather than the whole table; a full page means
   * there is more, and the caller should come straight back rather than wait.
   *
   * The one thing this ordering cannot do, said plainly: if an entry is written
   * into a millisecond a page has already ended inside, and its cuid happens to
   * sort below the entry that ended the page, the feed will not carry it. That
   * is inherent to any (timestamp, id) cursor over ids that are not monotonic,
   * and the recovery is the one the console already has - the trail itself,
   * re-read from timeline(). Nothing is lost from the store; only the live
   * feed's view of it can be a row short, and only in that collision.
   */
  async eventsSince(
    workspaceId: string,
    cursor: EventCursor,
    limit = 100
  ): Promise<EventPage> {
    const context = await authorize(this.principal, workspaceId, 'inspect');
    if (!context.isOwner) throw errors.accessDenied('watch the workspace event stream');

    const after = new Date(cursor.after);
    if (Number.isNaN(after.getTime())) {
      throw errors.validation('Event cursor "after" must be an ISO timestamp.', {
        after: cursor.after,
      });
    }

    // Omitted tiebreak means the caller has no opinion about the millisecond it
    // named, so only later ones follow. Present - empty string included - it
    // asks for the rest of that millisecond too.
    const restOfThatMillisecond =
      cursor.afterId === undefined ? [] : [{ createdAt: after, id: { gt: cursor.afterId } }];

    const rows = await getPrisma().auditEvent.findMany({
      where: {
        workspaceId: context.workspaceId,
        OR: [{ createdAt: { gt: after } }, ...restOfThatMillisecond],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });

    const last = rows.at(-1);

    return {
      events: rows.map(toAuditEventView),
      // An empty page leaves the caller exactly where it was. Advancing to "now"
      // instead would step over anything written while the query was in flight.
      cursor: last ? { after: last.createdAt.toISOString(), afterId: last.id } : cursor,
    };
  }
}

/** Convenience factory mirroring how the SDK is documented. */
export function memoryFor(principal: Principal): Memory {
  return new Memory(principal);
}
