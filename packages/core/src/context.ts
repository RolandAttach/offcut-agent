/**
 * Context Builder (SS4): retrieval and bounded context assembly with references.
 *
 * SS3.4 specifies four steps, and this file follows them literally:
 *
 *   1. the caller supplies a workspace, a question or task, and a size limit
 *   2. access is checked, then relevant records are selected - inaccessible and
 *      deleted records contribute to nothing, not even a count
 *   3. the result carries text, sources, versions and unresolved conflicts; when
 *      the budget cannot fit both sides of a conflict it returns an explicit
 *      flag and references rather than one supposedly correct side
 *   4. when there is no data the result is empty - memory is never replaced by
 *      an invented answer
 *
 * Step 3 drives the budget policy below. Conflicts are paid for before items,
 * because dropping an item only makes an answer less complete, while dropping a
 * conflict makes it confidently wrong.
 */

import type { Db } from './db';
import type { AccessContext } from './access';
import { visibilityWhere } from './access';
import { agentNameMap } from './store';
import { buildItems, openConflicts } from './merge';
import { bm25, hashRequest, normalizeTopic, tokenize } from './util';
import { LIMITS } from './types';
import type { ConflictView, ContextItem, ContextResult, RecordType } from './types';

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

export interface RecallOptions {
  query: string;
  topic?: string | undefined;
  limit?: number | undefined;
  maxItems: number;
  types?: RecordType[] | undefined;
  useCache: boolean;
}

export async function buildContext(
  db: Db,
  context: AccessContext,
  options: RecallOptions
): Promise<ContextResult> {
  const limit = Math.min(
    options.limit ?? context.contextLimit ?? LIMITS.contextLimitDefault,
    LIMITS.contextLimitMax
  );

  const where = visibilityWhere(context);

  // ---- Step 2: select candidates inside the caller's visibility ----------
  const candidates = (await db.memoryRecord.findMany({
    where: {
      ...where,
      isCurrent: true,
      ...(options.topic ? { topic: normalizeTopic(options.topic) } : {}),
      ...(options.types && options.types.length > 0 ? { type: { in: options.types } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })) as RecordRow[];

  const notes: string[] = [];

  // ---- Step 4: no data means an empty result, never a guess -------------
  if (candidates.length === 0) {
    return {
      workspaceId: context.workspaceId,
      query: options.query,
      items: [],
      conflicts: [],
      incomplete: false,
      notes: ['No accessible records matched this query.'],
      usedCharacters: 0,
      limit,
      consideredRecords: 0,
      fromCache: false,
    };
  }

  // ---- Ranking ----------------------------------------------------------
  let ranked = candidates;
  const queryTokens = tokenize(options.query ?? '');

  if (queryTokens.length > 0) {
    // The search index carries the audience and author, so scoring only ever
    // sees rows the caller is already allowed to read.
    const docs = await db.searchDoc.findMany({
      where: { recordRowId: { in: candidates.map((record) => record.id) } },
      select: { recordRowId: true, tokens: true, length: true },
    });

    const scores = bm25(
      queryTokens,
      docs.map((doc) => ({
        id: doc.recordRowId,
        tokens: doc.tokens ? doc.tokens.split(' ') : [],
        length: doc.length,
      }))
    );

    const scored = candidates
      .map((record) => ({ record, score: scores.get(record.id) ?? 0 }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Ties break on recency, then id: the ordering must be total so that
        // SDK and MCP return byte-identical context (SS7.1).
        const byDate = b.record.createdAt.getTime() - a.record.createdAt.getTime();
        return byDate !== 0 ? byDate : a.record.id.localeCompare(b.record.id);
      });

    const matched = scored.filter((entry) => entry.score > 0);

    // A query that matches nothing falls back to recency rather than returning
    // an empty context - the records exist and the caller may read them.
    if (matched.length > 0) {
      ranked = matched.map((entry) => entry.record);
    } else {
      notes.push('No term matched the query; showing the most recent records instead.');
    }
  }

  const names = await agentNameMap(
    db,
    ranked.map((record) => record.agentId)
  );

  // ---- Rule 1 of SS3.3 applies to retrieval, so dedupe before budgeting --
  const { items: allItems } = buildItems(ranked, names);

  // Preserve ranking order: buildItems sorts alphabetically for determinism,
  // but relevance is what should survive truncation.
  const rankIndex = new Map<string, number>();
  ranked.forEach((record, index) => {
    const key = record.recordId;
    if (!rankIndex.has(key)) rankIndex.set(key, index);
  });
  const orderedItems = [...allItems].sort((a, b) => {
    const aRank = Math.min(...a.refs.map((ref) => rankIndex.get(ref.recordId) ?? Infinity));
    const bRank = Math.min(...b.refs.map((ref) => rankIndex.get(ref.recordId) ?? Infinity));
    return aRank - bRank;
  });

  // ---- Conflicts are budgeted first -------------------------------------
  const visibleRecordIds = ranked.map((record) => record.recordId);
  const conflicts = await openConflicts(db, context, { recordIds: visibleRecordIds });

  let incomplete = false;
  let used = 0;

  const { rendered: renderedConflicts, cost: conflictCost, truncated } = fitConflicts(
    conflicts,
    Math.floor(limit * 0.5)
  );
  used += conflictCost;

  if (truncated) {
    incomplete = true;
    notes.push(
      'Conflict details were shortened to fit the limit: values and references are shown, full record text is not. No side was chosen.'
    );
  }

  // ---- Items fill whatever remains --------------------------------------
  const selected: ContextItem[] = [];
  for (const item of orderedItems) {
    if (selected.length >= options.maxItems) {
      incomplete = true;
      notes.push(`Stopped at ${options.maxItems} items (maxItems).`);
      break;
    }

    const cost = itemCost(item);
    if (used + cost > limit) {
      incomplete = true;
      notes.push(
        `Context limit of ${limit} characters reached; ${orderedItems.length - selected.length} further item(s) were not included. Source records are unchanged.`
      );
      break;
    }

    selected.push(item);
    used += cost;
  }

  // Restore stable display order once the selection is fixed.
  selected.sort((a, b) => a.topic.localeCompare(b.topic) || a.text.localeCompare(b.text));

  return {
    workspaceId: context.workspaceId,
    query: options.query,
    items: selected,
    conflicts: renderedConflicts,
    incomplete,
    notes,
    usedCharacters: used,
    limit,
    consideredRecords: candidates.length,
    fromCache: false,
  };
}

/** Characters an item contributes: its text plus a short reference footprint. */
function itemCost(item: ContextItem): number {
  const refCost = item.refs.length * 24;
  return item.text.length + item.topic.length + refCost;
}

/**
 * Fits conflicts into their share of the budget.
 *
 * When the full form does not fit, sides keep their VALUE and REFERENCES and
 * lose only the quoted record text. Both sides always survive: SS3.4 is explicit
 * that a tight budget must produce "an explicit flag and references rather than
 * one supposedly correct side". Dropping a conflict entirely is never an option
 * here, because invariant 5 forbids it disappearing from current retrieval.
 */
function fitConflicts(
  conflicts: ConflictView[],
  budget: number
): { rendered: ConflictView[]; cost: number; truncated: boolean } {
  if (conflicts.length === 0) return { rendered: [], cost: 0, truncated: false };

  const fullCost = conflicts.reduce((sum, conflict) => sum + conflictCost(conflict), 0);
  if (fullCost <= budget) {
    return { rendered: conflicts, cost: fullCost, truncated: false };
  }

  const compact = conflicts.map((conflict) => ({
    ...conflict,
    sides: conflict.sides.map((side) => ({ ...side, text: '' })),
  }));

  const compactCost = compact.reduce((sum, conflict) => sum + conflictCost(conflict), 0);
  return { rendered: compact, cost: compactCost, truncated: true };
}

function conflictCost(conflict: ConflictView): number {
  const head = conflict.factKey.length + conflict.factContext.length + 40;
  const sides = conflict.sides.reduce(
    (sum, side) => sum + side.value.length + side.text.length + 40,
    0
  );
  return head + sides;
}

// ---------------------------------------------------------------------------
// Cache (SS3.4: "access checks also apply to cached results")
// ---------------------------------------------------------------------------

export function recallCacheKey(options: RecallOptions & { workspaceId: string }): string {
  return hashRequest({
    workspaceId: options.workspaceId,
    query: options.query,
    topic: options.topic ?? null,
    limit: options.limit ?? null,
    maxItems: options.maxItems,
    types: options.types ?? null,
  });
}

/**
 * The cache stores record IDS ONLY - never rendered text.
 *
 * That is what makes revocation immediate: a hit still re-reads those rows
 * through the caller's own visibility filter, so a record that became private,
 * was deleted, or belongs to an agent whose access was revoked simply is not
 * there on the way back out. A cache of rendered text could not offer this.
 */
export async function readCachedRecordIds(
  db: Db,
  workspaceId: string,
  queryHash: string
): Promise<string[] | null> {
  const entry = await db.recallCacheEntry.findUnique({
    where: { workspaceId_queryHash: { workspaceId, queryHash } },
  });
  if (!entry || entry.invalidatedAt) return null;
  return JSON.parse(entry.recordRowIds) as string[];
}

export async function writeCache(
  db: Db,
  workspaceId: string,
  queryHash: string,
  recordRowIds: string[]
): Promise<void> {
  await db.recallCacheEntry.upsert({
    where: { workspaceId_queryHash: { workspaceId, queryHash } },
    create: {
      workspaceId,
      queryHash,
      recordRowIds: JSON.stringify(recordRowIds),
    },
    update: {
      recordRowIds: JSON.stringify(recordRowIds),
      invalidatedAt: null,
      createdAt: new Date(),
    },
  });
}
