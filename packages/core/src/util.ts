/**
 * Deterministic helpers shared by the store, merge engine and context builder.
 *
 * Everything here is pure and model-free. SS3.3 is explicit that basic merging
 * rests on topics, explicit relationships and structured values; semantic
 * guessing is the optional module of SS9 and never leaks into this file.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RecordType, Scope } from './types';

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Stable JSON serialisation: object keys are sorted at every depth so that two
 * logically identical payloads always hash the same. Used for idempotency
 * request hashes, where "same key, different content" must be detectable (SS3.2).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = sortDeep(source[key]);
  }
  return out;
}

export function hashRequest(payload: unknown): string {
  return sha256(canonicalJson(payload));
}

// ---------------------------------------------------------------------------
// Agent API keys - the "verified connection" of SS3.2
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'offcut_sk_';

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const secret = randomBytes(24).toString('base64url');
  const key = `${KEY_PREFIX}${secret}`;
  return {
    key,
    hash: sha256(key),
    // Enough to recognise a key in a list, never enough to authenticate with.
    prefix: `${KEY_PREFIX}${secret.slice(0, 6)}`,
  };
}

export function hashApiKey(key: string): string {
  return sha256(key.trim());
}

export function looksLikeApiKey(value: string): boolean {
  return value.trim().startsWith(KEY_PREFIX);
}

/** Constant-time comparison for any secret compared outside the database. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Text normalisation and exact-duplicate detection
// ---------------------------------------------------------------------------

/**
 * Normalisation for duplicate detection: case folded, punctuation stripped,
 * whitespace collapsed. Deliberately conservative - it catches "the same
 * sentence typed twice", not "two sentences that mean the same thing". The
 * second case is a semantic judgement and SS3.3 says such records stay separate.
 */
export function normalizeForHash(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The exact-duplicate key of SS3.3 row 1: "exact content duplicate with the same
 * topic and type". Scope is folded in as well, because a private and a shared
 * record must never collapse into one item (invariant 2).
 */
export function contentHashOf(input: {
  text: string;
  topic: string;
  type: RecordType;
  scope: Scope;
}): string {
  return sha256(
    [normalizeForHash(input.text), input.topic.trim().toLowerCase(), input.type, input.scope].join(
      '\0'
    )
  );
}

/** Topics are merge keys, so they are normalised the same way everywhere. */
export function normalizeTopic(topic: string): string {
  return topic.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Fact keys and contexts are compared exactly; only case and spacing are folded. */
export function normalizeFactKey(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Fact VALUES are compared case-insensitively but otherwise verbatim. Two values
 * that differ only by case are the same answer; anything else is a real
 * disagreement and must surface as a conflict rather than be smoothed away.
 */
export function normalizeFactValue(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Tokenisation and ranking (the search index of SS4)
// ---------------------------------------------------------------------------

/**
 * Stop words for the two languages this project is written in. Kept short on
 * purpose: an over-eager list hides real query terms.
 */
const STOP_WORDS = new Set([
  // English
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were',
  'what', 'when', 'which', 'who', 'will', 'with', 'we', 'you', 'this', 'there',
  // Russian
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все',
  'она', 'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по',
  'только', 'ее', 'мне', 'было', 'вот', 'от', 'меня', 'еще', 'нет', 'о', 'из', 'ему',
]);

/**
 * Splits text into comparable tokens. Unicode-aware so Cyrillic and Latin are
 * treated alike; digits are kept because versions and identifiers matter.
 */
export function tokenize(text: string): string[] {
  const raw = text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean);

  const out: string[] = [];
  for (const token of raw) {
    if (token.length < 2) continue;
    if (STOP_WORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

export interface ScorableDoc {
  id: string;
  tokens: string[];
  length: number;
}

/**
 * Okapi BM25. Chosen over naive term counting because recall must rank by
 * relevance to a task, and BM25 handles both term saturation and document
 * length without any training data or model call.
 */
export function bm25(
  queryTokens: string[],
  docs: ScorableDoc[],
  options: { k1?: number; b?: number } = {}
): Map<string, number> {
  const k1 = options.k1 ?? 1.5;
  const b = options.b ?? 0.75;
  const scores = new Map<string, number>();
  if (docs.length === 0 || queryTokens.length === 0) return scores;

  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;

  // Document frequency per unique query term.
  const uniqueQueryTokens = [...new Set(queryTokens)];
  const docFrequency = new Map<string, number>();
  for (const term of uniqueQueryTokens) {
    let count = 0;
    for (const doc of docs) {
      if (doc.tokens.includes(term)) count += 1;
    }
    docFrequency.set(term, count);
  }

  for (const doc of docs) {
    const termCounts = new Map<string, number>();
    for (const token of doc.tokens) {
      termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    }

    let score = 0;
    for (const term of uniqueQueryTokens) {
      const frequency = termCounts.get(term);
      if (!frequency) continue;

      const n = docFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      const denominator = frequency + k1 * (1 - b + (b * doc.length) / avgLength);
      score += idf * ((frequency * (k1 + 1)) / denominator);
    }

    if (score > 0) scores.set(doc.id, score);
  }

  return scores;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export function isoRequired(date: Date): string {
  return date.toISOString();
}

/** Character budget accounting for the context builder (SS3.4). */
export function charCost(text: string): number {
  return text.length;
}

export function slugify(value: string): string {
  const base = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || `ws-${randomBytes(4).toString('hex')}`;
}

export function uniqueBy<T, K>(items: T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
