/**
 * Merge Engine (SS4): duplicates, related records, conflicts, and the freshness
 * of derived blocks.
 *
 * SS3.3 defines merging as a five-row table, and this file is a direct
 * transcription of it:
 *
 *   1. exact content duplicate, same topic and type -> one retrieval item,
 *      every source record and author preserved
 *   2. different parts of one task                  -> grouped into a shared
 *      block with references to every record used
 *   3. two values of one explicitly identified fact -> a flagged conflict
 *      showing both sides, deciding nothing
 *   4. an explicit authorised correction            -> current version updated,
 *      linked to its predecessor (handled in store.writeRecord)
 *   5. an uncertain semantic relationship           -> records stay separate
 *
 * Rule 5 is the one that shapes the code most. Every grouping decision below
 * needs an explicit signal - an identical content hash, a shared topic, a
 * declared link, or a matching fact key. Where no such signal exists the engine
 * does nothing, because "nothing is discarded for a cleaner summary".
 *
 * There is no model in this file. Semantic suggestions are the optional module
 * of SS9 and are disabled by default.
 */

import type { Db } from './db';
import type { AccessContext } from './access';
import { visibilityWhere } from './access';
import { agentNameMap, audit, factIdentity, factValueOf } from './store';
import { normalizeTopic, uniqueBy } from './util';
import type {
  ConflictView,
  ContextItem,
  MergeResult,
  MergedBlockView,
  RecordType,
  Scope,
  SourceRef,
} from './types';

type RecordRow = {
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
  contentHash: string;
  createdAt: Date;
};

// ---------------------------------------------------------------------------
// Rule 1 - exact duplicates collapse in retrieval, never in storage
// ---------------------------------------------------------------------------

/**
 * Groups records by content hash so an identical note saved by three agents
 * appears once - while all three authors travel with it.
 *
 * The distinction SS3.2 draws matters here: "identical notes submitted by
 * different agents retain their own provenance; they are not a request retry".
 * Nothing is deleted, and the refs array is what preserves authorship.
 */
export function buildItems(
  records: RecordRow[],
  agentNames: Map<string, string>
): { items: ContextItem[]; duplicatesCollapsed: number } {
  const groups = new Map<string, RecordRow[]>();

  for (const record of records) {
    const bucket = groups.get(record.contentHash);
    if (bucket) bucket.push(record);
    else groups.set(record.contentHash, [record]);
  }

  let duplicatesCollapsed = 0;
  const items: ContextItem[] = [];

  for (const bucket of groups.values()) {
    // Oldest first: the earliest phrasing is the canonical one to display.
    bucket.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const head = bucket[0]!;

    if (bucket.length > 1) duplicatesCollapsed += bucket.length - 1;

    const refs: SourceRef[] = bucket.map((record) => ({
      recordId: record.recordId,
      version: record.version,
      agentId: record.agentId,
      agentName: agentNames.get(record.agentId) ?? 'unknown',
      source: record.source,
    }));

    items.push({
      text: head.text,
      topic: head.topic,
      type: head.type as RecordType,
      refs,
      merged: bucket.length > 1,
    });
  }

  // Deterministic order: topic, then oldest first. Two identical inputs must
  // always produce byte-identical output, otherwise SS7.1's "same query through
  // SDK and MCP returns the same context" cannot be asserted.
  items.sort((a, b) => a.topic.localeCompare(b.topic) || a.text.localeCompare(b.text));

  return { items, duplicatesCollapsed };
}

// ---------------------------------------------------------------------------
// Rule 3 - conflicts over explicitly identified facts
// ---------------------------------------------------------------------------

/**
 * Finds records that assign different values to the same fact key, in the same
 * context and the same audience, and records the disagreement.
 *
 * Two things this deliberately does NOT do. It does not compare free text: SS3.3
 * says "detecting every contradiction in free text is not promised", and
 * pretending otherwise would produce false conflicts. And it does not choose a
 * winner - not by recency, not by author seniority, not by majority. SS3.5
 * reserves that for the owner or an explicitly authorised participant.
 */
export async function detectConflicts(
  db: Db,
  context: AccessContext,
  options: { scope?: Scope; topic?: string } = {}
): Promise<ConflictView[]> {
  const where = visibilityWhere(context);

  const candidates = (await db.memoryRecord.findMany({
    where: {
      ...where,
      isCurrent: true,
      factKey: { not: null },
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.topic ? { topic: normalizeTopic(options.topic) } : {}),
    },
    orderBy: { createdAt: 'asc' },
  })) as RecordRow[];

  // Group by (audience, fact key, fact context) - all three must match before
  // two values are even comparable (SS3.3: "in the same context").
  const groups = new Map<string, RecordRow[]>();
  for (const record of candidates) {
    const identity = factIdentity(record);
    if (!identity) continue;
    const bucket = groups.get(identity);
    if (bucket) bucket.push(record);
    else groups.set(identity, [record]);
  }

  const views: ConflictView[] = [];

  for (const [identity, bucket] of groups) {
    const distinctValues = new Set(bucket.map(factValueOf));

    const first = bucket[0]!;
    const scope = first.scope;
    const factKey = first.factKey ?? '';
    const factContext = first.factContext;

    const existing = await db.conflict.findUnique({
      where: {
        workspaceId_scope_factKey_factContext: {
          workspaceId: context.workspaceId,
          scope,
          factKey,
          factContext,
        },
      },
      include: { sides: true },
    });

    // --- Agreement: at most one distinct value -------------------------
    if (distinctValues.size <= 1) {
      // A conflict that was open only because of a record that has since been
      // corrected or deleted is retired. Invariant 5 permits disappearance
      // exactly here: the underlying data changed, and that is recorded.
      if (existing && existing.status === 'open') {
        await db.conflict.delete({ where: { id: existing.id } });
        await audit(db, context, 'conflict.retired', existing.id, {
          factKey,
          factContext,
          reason: 'only one value remains',
        });
      }
      continue;
    }

    // --- Disagreement --------------------------------------------------
    const sideData = bucket.map((record) => ({
      recordRowId: record.id,
      recordId: record.recordId,
      version: record.version,
      value: record.factValue ?? '',
      agentId: record.agentId,
    }));

    let conflictId: string;

    if (!existing) {
      const created = await db.conflict.create({
        data: {
          workspaceId: context.workspaceId,
          scope,
          factKey,
          factContext,
          status: 'open',
          sides: { create: sideData },
        },
      });
      conflictId = created.id;
      await audit(db, context, 'conflict.detected', conflictId, {
        factKey,
        factContext,
        values: [...distinctValues],
      });
    } else {
      conflictId = existing.id;

      // Refresh the sides to match today's current versions. Neither version is
      // ever overwritten - the sides point at rows that all still exist.
      await db.conflictSide.deleteMany({ where: { conflictId } });
      await db.conflictSide.createMany({
        data: sideData.map((side) => ({ ...side, conflictId })),
      });

      // A resolved conflict reopens when evidence arrives that the recorded
      // decision did not cover: a value that is neither the chosen one nor one
      // of the values present when the decision was made. Without this, a new
      // disagreement could hide behind an old ruling, which invariant 5 forbids.
      if (existing.status === 'resolved') {
        const chosenRow = bucket.find((r) => r.recordId === existing.resolvedRecordId);
        const chosenValue = chosenRow ? factValueOf(chosenRow) : null;
        const knownRowIds = new Set(existing.sides.map((side) => side.recordRowId));

        const uncoveredEvidence = bucket.some(
          (record) => !knownRowIds.has(record.id) && factValueOf(record) !== chosenValue
        );

        if (uncoveredEvidence || chosenValue === null) {
          await db.conflict.update({
            where: { id: conflictId },
            data: { status: 'open' },
          });
          await audit(db, context, 'conflict.reopened', conflictId, {
            factKey,
            factContext,
            reason: chosenValue === null ? 'chosen record is gone' : 'new differing value',
          });
        }
      }
    }

    const view = await loadConflictView(db, conflictId);
    if (view) views.push(view);
  }

  return views;
}

/** Loads one conflict with its sides rendered for callers. */
export async function loadConflictView(db: Db, conflictId: string): Promise<ConflictView | null> {
  const conflict = await db.conflict.findUnique({
    where: { id: conflictId },
    include: { sides: { where: { retiredAt: null } }, resolvedByUser: true, resolvedByAgent: true },
  });
  if (!conflict) return null;

  const names = await agentNameMap(
    db,
    conflict.sides.map((side) => side.agentId)
  );

  const rows = await db.memoryRecord.findMany({
    where: { id: { in: conflict.sides.map((side) => side.recordRowId) } },
    select: { id: true, text: true },
  });
  const texts = new Map(rows.map((row) => [row.id, row.text]));

  return {
    id: conflict.id,
    factKey: conflict.factKey,
    factContext: conflict.factContext,
    scope: conflict.scope as Scope,
    status: conflict.status as 'open' | 'resolved',
    detectedAt: conflict.detectedAt.toISOString(),
    sides: conflict.sides.map((side) => ({
      recordId: side.recordId,
      version: side.version,
      value: side.value,
      agentId: side.agentId,
      agentName: names.get(side.agentId) ?? 'unknown',
      text: texts.get(side.recordRowId) ?? '',
    })),
    resolution:
      conflict.status === 'resolved' && conflict.resolvedRecordId
        ? {
            chosenRecordId: conflict.resolvedRecordId,
            chosenVersion: conflict.resolvedVersion ?? 1,
            rationale: conflict.rationale ?? '',
            decidedBy:
              conflict.resolvedByUser?.displayName ?? conflict.resolvedByAgent?.name ?? 'unknown',
            decidedByKind: conflict.resolvedByUserId ? 'user' : 'agent',
            resolvedAt: (conflict.resolvedAt ?? conflict.detectedAt).toISOString(),
          }
        : null,
  };
}

/** Every unresolved conflict visible to this caller. */
export async function openConflicts(
  db: Db,
  context: AccessContext,
  options: { recordIds?: string[] } = {}
): Promise<ConflictView[]> {
  const conflicts = await db.conflict.findMany({
    where: {
      workspaceId: context.workspaceId,
      status: 'open',
      ...(context.principal.kind === 'agent' ? { scope: 'workspace' } : {}),
    },
    include: { sides: true },
  });

  const relevant = options.recordIds
    ? conflicts.filter((conflict) =>
        conflict.sides.some((side) => options.recordIds!.includes(side.recordId))
      )
    : conflicts;

  const views: ConflictView[] = [];
  for (const conflict of relevant) {
    const view = await loadConflictView(db, conflict.id);
    if (view) views.push(view);
  }
  return views;
}

// ---------------------------------------------------------------------------
// Derived block freshness (invariants 6 and 7)
// ---------------------------------------------------------------------------

/**
 * Marks every derived block that cites one of these record lineages as stale.
 *
 * Called after any write, correction or deletion. A stale block is never served
 * as current: SS3.3 requires it to be "rebuilt before being returned as current",
 * and invariant 6 forbids presenting a stale summary as fresh.
 */
export async function markBlocksStale(
  db: Db,
  workspaceId: string,
  recordIds: string[],
  reason: string
): Promise<string[]> {
  if (recordIds.length === 0) return [];

  const affected = await db.mergedBlockSource.findMany({
    where: { recordId: { in: recordIds }, block: { workspaceId } },
    select: { blockId: true },
  });

  const blockIds = [...new Set(affected.map((row) => row.blockId))];
  if (blockIds.length === 0) return [];

  await db.mergedBlock.updateMany({
    where: { id: { in: blockIds }, staleAt: null },
    data: { staleAt: new Date(), staleReason: reason },
  });

  return blockIds;
}

// ---------------------------------------------------------------------------
// Rule 2 - assembling derived blocks
// ---------------------------------------------------------------------------

/**
 * Builds one derived block per topic from the records the caller may see.
 *
 * Grouping is by topic plus explicit links, never by similarity. A block records
 * the exact source versions it used (invariant 6) and is confined to a single
 * audience (invariant 2): a shared block can never contain a private record.
 */
export async function runMerge(
  db: Db,
  context: AccessContext,
  options: {
    topic?: string | undefined;
    recordIds?: string[] | undefined;
    scope: Scope;
    rebuildStale: boolean;
  }
): Promise<MergeResult> {
  const where = visibilityWhere(context);

  // A private block belongs to one agent; a workspace block spans the audience.
  // The two never mix, which is what keeps merging from broadening access.
  const ownerAgentId =
    options.scope === 'private' && context.principal.kind === 'agent'
      ? context.principal.agentId
      : null;

  const records = (await db.memoryRecord.findMany({
    where: {
      ...where,
      isCurrent: true,
      scope: options.scope,
      ...(options.topic ? { topic: normalizeTopic(options.topic) } : {}),
      ...(options.recordIds ? { recordId: { in: options.recordIds } } : {}),
      ...(ownerAgentId ? { agentId: ownerAgentId } : {}),
    },
    orderBy: { createdAt: 'asc' },
  })) as RecordRow[];

  const conflicts = await detectConflicts(db, context, {
    scope: options.scope,
    ...(options.topic ? { topic: options.topic } : {}),
  });

  if (records.length === 0) {
    return { blocks: [], duplicatesCollapsed: 0, conflicts, keptSeparate: 0 };
  }

  const names = await agentNameMap(
    db,
    records.map((record) => record.agentId)
  );

  // Explicit links let a record join a topic it was not filed under. This is
  // the only cross-topic grouping signal the engine accepts.
  const linkRows = await db.recordLink.findMany({
    where: {
      workspaceId: context.workspaceId,
      kind: { in: ['relates', 'partOf', 'updates'] },
      from: { id: { in: records.map((r) => r.id) } },
    },
    include: { to: { select: { recordId: true, topic: true, deletedAt: true } } },
  });

  const topicOf = new Map<string, string>();
  for (const record of records) topicOf.set(record.recordId, record.topic);
  for (const link of linkRows) {
    if (link.to.deletedAt) continue;
    // A linked record adopts the topic of what it is attached to, so "parts of
    // one task" land in one block even when filed under different topics.
    const fromRecord = records.find((r) => r.id === link.fromRecordId);
    if (fromRecord && topicOf.has(link.to.recordId)) {
      topicOf.set(fromRecord.recordId, topicOf.get(link.to.recordId)!);
    }
  }

  const byTopic = new Map<string, RecordRow[]>();
  for (const record of records) {
    const topic = topicOf.get(record.recordId) ?? record.topic;
    const bucket = byTopic.get(topic);
    if (bucket) bucket.push(record);
    else byTopic.set(topic, [record]);
  }

  let duplicatesCollapsed = 0;
  let keptSeparate = 0;
  const blocks: MergedBlockView[] = [];

  for (const [topic, bucket] of byTopic) {
    const { items, duplicatesCollapsed: collapsed } = buildItems(bucket, names);
    duplicatesCollapsed += collapsed;

    // Rule 5: a lone record with no duplicate, no link and no shared fact is
    // reported as kept-separate rather than folded into a summary.
    if (items.length === 1 && bucket.length === 1) keptSeparate += 1;

    const topicConflicts = conflicts.filter((conflict) =>
      conflict.sides.some((side) => bucket.some((record) => record.recordId === side.recordId))
    );

    const sources: SourceRef[] = uniqueBy(
      items.flatMap((item) => item.refs),
      (ref) => `${ref.recordId}@${ref.version}`
    );

    const body = JSON.stringify({ items, conflicts: topicConflicts });
    const title = `${topic} - ${items.length} item${items.length === 1 ? '' : 's'}`;

    // `origin` is part of the key, not an afterthought.
    //
    // Without it this lookup can match the MODEL block for the same topic and
    // audience (summaries.ts writes one with origin:'model'), and the update
    // below then overwrites its title and body with deterministic output while
    // leaving origin:'model' and the model's own prose attached. The result is
    // one block that claims to be a model summary, carries stale model prose,
    // and holds deterministic content - with no deterministic block existing at
    // all, because this branch updated instead of creating one.
    //
    // The two kinds are separate rows that never touch each other.
    const existing = await db.mergedBlock.findFirst({
      where: {
        workspaceId: context.workspaceId,
        topic,
        scope: options.scope,
        ownerAgentId,
        origin: 'deterministic',
      },
    });

    let blockId: string;
    const now = new Date();

    if (existing) {
      await db.mergedBlock.update({
        where: { id: existing.id },
        // Rebuilding clears staleness: the block now cites current versions.
        data: { title, body, rebuiltAt: now, staleAt: null, staleReason: null },
      });
      blockId = existing.id;
      await db.mergedBlockSource.deleteMany({ where: { blockId } });
    } else {
      const created = await db.mergedBlock.create({
        data: {
          workspaceId: context.workspaceId,
          scope: options.scope,
          ownerAgentId,
          topic,
          title,
          body,
          // Explicit, so the row can never be mistaken for a model block even
          // if the column default changes.
          origin: 'deterministic',
        },
      });
      blockId = created.id;
    }

    // Pin the block to exact source versions so staleness is detectable.
    const sourceRows = bucket.map((record) => ({
      blockId,
      recordRowId: record.id,
      recordId: record.recordId,
      version: record.version,
    }));
    if (sourceRows.length > 0) {
      await db.mergedBlockSource.createMany({ data: sourceRows });
    }

    blocks.push({
      id: blockId,
      topic,
      title,
      scope: options.scope,
      items,
      conflicts: topicConflicts,
      sources,
      createdAt: (existing?.createdAt ?? now).toISOString(),
      rebuiltAt: existing ? now.toISOString() : null,
      stale: false,
      staleReason: null,
    });
  }

  blocks.sort((a, b) => a.topic.localeCompare(b.topic));

  await audit(db, context, 'memory.merge', options.topic ?? '*', {
    blocks: blocks.length,
    duplicatesCollapsed,
    conflicts: conflicts.length,
    scope: options.scope,
  });

  return { blocks, duplicatesCollapsed, conflicts, keptSeparate };
}

/** Reads stored blocks, reporting staleness rather than hiding it. */
export async function listBlocks(
  db: Db,
  context: AccessContext,
  options: { topic?: string } = {}
): Promise<MergedBlockView[]> {
  const rows = await db.mergedBlock.findMany({
    where: {
      workspaceId: context.workspaceId,
      ...(options.topic ? { topic: normalizeTopic(options.topic) } : {}),
      // An agent never sees another agent's private blocks.
      ...(context.principal.kind === 'agent'
        ? { OR: [{ scope: 'workspace' }, { ownerAgentId: context.principal.agentId }] }
        : {}),
    },
    include: { sources: true },
    orderBy: { topic: 'asc' },
  });

  return rows.map((row) => {
    const parsed = JSON.parse(row.body) as { items: ContextItem[]; conflicts: ConflictView[] };
    return {
      id: row.id,
      topic: row.topic,
      title: row.title,
      scope: row.scope as Scope,
      items: parsed.items ?? [],
      conflicts: parsed.conflicts ?? [],
      sources: uniqueBy(
        (parsed.items ?? []).flatMap((item) => item.refs),
        (ref) => `${ref.recordId}@${ref.version}`
      ),
      createdAt: row.createdAt.toISOString(),
      rebuiltAt: row.rebuiltAt ? row.rebuiltAt.toISOString() : null,
      stale: row.staleAt !== null,
      staleReason: row.staleReason,
    };
  });
}
