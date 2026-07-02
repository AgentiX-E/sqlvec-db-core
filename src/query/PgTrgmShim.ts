/**
 * PgTrgmShim — PostgreSQL pg_trgm extension compatibility shim for SQLite.
 *
 * PostgreSQL provides the pg_trgm extension with functions for trigram-based
 * fuzzy string matching and similarity scoring:
 *
 *   - show_trgm(text)             → text[]        — Extract trigram set
 *   - similarity(a, b)            → float4        — Dice coefficient (0.0-1.0)
 *   - word_similarity(a, b)       → float4        — Best word-level match
 *   - strict_word_similarity(a, b)→ float4        — Exact word boundary match
 *   - show_limit()                → float4        — Current threshold (default 0.3)
 *   - set_limit(limit)            → float4        — Set threshold, return old
 *
 * SQLite has no built-in trigram support. This shim implements all pg_trgm
 * functions using pure-JS trigram extraction and Dice coefficient computation.
 *
 * Relation to existing FTS5/trigram infrastructure:
 *   - `LikeIndexShim` provides trigram-based FTS5 indexes for LIKE/ILIKE queries
 *   - This shim provides the SQL-level pg_trgm functions independently
 *   - They complement each other: one for index-based pattern matching,
 *     the other for ad-hoc similarity scoring in SQL queries
 *
 * @module query/PgTrgmShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('PgTrgmShim');

// ── Module-level limit state ─────────────────────────────────────

/**
 * Stores the current similarity threshold (GUC-style state).
 * Initialized to PostgreSQL's default of 0.3.
 * Updated by set_limit(), queried by show_limit().
 */
let currentLimit: number = 0.3;

// ── Trigram extraction ───────────────────────────────────────────

/**
 * Extract trigrams from a string, matching PostgreSQL's show_trgm() behavior.
 *
 * Algorithm (per PostgreSQL source):
 *   1. Lowercase the input
 *   2. Pad with 2 spaces at both ends: `  ${s}  `
 *   3. Extract all 3-character sliding windows
 *   4. Return the full multiset (duplicates preserved, matching PG behavior)
 *
 * PostgreSQL signature:
 *   show_trgm(text) → text[]
 *
 * Edge cases:
 *   - Empty string → `['   ']` — 1 trigram (3 spaces)
 *   - Single character → `['  x', ' x ', 'x  ']` — 3 trigrams with padding
 *   - Two characters → `['  a', ' ab', 'ab ', 'b  ']` — 4 trigrams
 *
 * @param text - Input string
 * @returns Array of trigrams (lowercase, padded)
 */
export function showTrgm(text: string): string[] {
  if (text == null) return [];
  const s = `  ${String(text).toLowerCase()} `;
  const trigrams: string[] = [];
  for (let i = 0; i <= s.length - 3; i++) {
    trigrams.push(s.substring(i, i + 3));
  }
  return trigrams;
}

// ── Dice coefficient (shared helper) ─────────────────────────────

/**
 * Compute the trigram-based Dice coefficient between two strings.
 *
 * Dice coefficient = 2 * |trigrams(a) ∩ trigrams(b)| / (|trigrams(a)| + |trigrams(b)|)
 *
 * Uses multiset (bag) intersection, matching PostgreSQL's exact algorithm:
 * duplicates in both sets contribute to the intersection count.
 *
 * @param t1 - Trigrams of string A
 * @param t2 - Trigrams of string B
 * @returns Score from 0.0 (no overlap) to 1.0 (identical trigram sets)
 */
export function trigramDiceCoefficient(t1: string[], t2: string[]): number {
  if (t1.length === 0 && t2.length === 0) return 1.0;
  if (t1.length === 0 || t2.length === 0) return 0.0;

  // Count trigrams in each set
  const counts1 = new Map<string, number>();
  const counts2 = new Map<string, number>();
  for (const tg of t1) counts1.set(tg, (counts1.get(tg) || 0) + 1);
  for (const tg of t2) counts2.set(tg, (counts2.get(tg) || 0) + 1);

  // Multiset intersection: sum of min(freq1, freq2) for each trigram
  let shared = 0;
  for (const [tg, c1] of counts1) {
    const c2 = counts2.get(tg) || 0;
    shared += Math.min(c1, c2);
  }

  return (2.0 * shared) / (t1.length + t2.length);
}

// ── Individual function implementations ──────────────────────────

/**
 * Compute the Dice coefficient similarity between two strings.
 *
 * PostgreSQL signature:
 *   similarity(a text, b text) → float4
 *
 * Returns a value between 0.0 (no trigram overlap) and 1.0 (identical).
 *
 * @param a - First string
 * @param b - Second string
 * @returns Similarity score from 0.0 to 1.0
 */
export function similarity(a: string, b: string): number {
  const t1 = showTrgm(a);
  const t2 = showTrgm(b);
  return trigramDiceCoefficient(t1, t2);
}

/**
 * Find the best trigram match between a and any word in b.
 *
 * PostgreSQL signature:
 *   word_similarity(a text, b text) → float4
 *
 * Splits string b into words (by non-alphanumeric boundaries), computes
 * similarity(a, word) for each word, and returns the maximum score.
 * This matches PostgreSQL's behavior of finding the best continuous
 * substring match.
 *
 * Returns:
 *   - 1.0 if exactly one word in b matches a perfectly
 *   - 0.0 if no words match (or empty inputs)
 *   - Values in between for partial matches
 *
 * @param a - Query string
 * @param b - String to search within
 * @returns Maximum similarity score from 0.0 to 1.0
 */
export function wordSimilarity(a: string, b: string): number {
  if (a == null || b == null) return 0.0;
  const textA = String(a);
  const textB = String(b);
  if (textA.length === 0 || textB.length === 0) return 0.0;

  // Split into words and find the best match
  const words = textB.split(/[^a-zA-Z0-9]+/).filter(w => w.length > 0);
  if (words.length === 0) return 0.0;

  let best = 0.0;
  const tA = showTrgm(textA);
  for (const word of words) {
    const tW = showTrgm(word);
    const score = trigramDiceCoefficient(tA, tW);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Like word_similarity but requires exact word boundary match.
 *
 * PostgreSQL signature:
 *   strict_word_similarity(a text, b text) → float4
 *
 * Same algorithm as word_similarity but additionally requires that the
 * matched substring is bounded by word boundaries (non-alphanumeric chars
 * or start/end of string). Since we split b into words by non-alphanumeric
 * boundaries, this constraint is naturally satisfied.
 *
 * @param a - Query string
 * @param b - String to search within
 * @returns Maximum similarity score from 0.0 to 1.0
 */
export function strictWordSimilarity(a: string, b: string): number {
  // Identical to wordSimilarity in our implementation because we already
  // split by word boundaries, guaranteeing exact word-level matches.
  return wordSimilarity(a, b);
}

/**
 * Return the current similarity threshold.
 *
 * PostgreSQL signature:
 *   show_limit() → float4
 *
 * Returns the limit currently set by set_limit(), or the default of 0.3.
 * The limit is used internally by pg_trgm's GiST/GIN index operators;
 * in this shim it's exposed for SQL compatibility.
 *
 * @returns Current limit value (default 0.3)
 */
export function showLimit(): number {
  return currentLimit;
}

/**
 * Set the similarity threshold and return the previous value.
 *
 * PostgreSQL signature:
 *   set_limit(limit float4) → float4
 *
 * Updates the module-level limit and returns the old value for chaining.
 * This is a no-op from the perspective of query execution — the limit
 * only affects GiST/GIN index behavior in real PostgreSQL.
 *
 * @param limit - New limit value (0.0 to 1.0)
 * @returns Previous limit value
 */
export function setLimit(limit: number): number {
  const old = currentLimit;
  currentLimit = limit;
  return old;
}

// ── SQL-level detection ──────────────────────────────────────────

/**
 * pg_trgm function names for detection and catalog purposes.
 */
const PG_TRGM_FUNC_NAMES = [
  'show_trgm',
  'similarity',
  'word_similarity',
  'strict_word_similarity',
  'show_limit',
  'set_limit',
];

/**
 * Build a regex pattern to detect any pg_trgm function call in SQL.
 */
const PG_TRGM_FUNC_RE = new RegExp(
  `\\b(${PG_TRGM_FUNC_NAMES.map(f => f.replace(/_/g, '[_]?')).join('|')})\\s*\\(`,
  'gi'
);

/**
 * Detect whether a SQL statement contains pg_trgm function calls.
 *
 * Matches both direct calls (`SELECT similarity(...)`) and
 * qualified calls (`SELECT public.similarity(...)`).
 *
 * @param sql - Raw SQL string
 * @returns true if any pg_trgm function is detected
 */
export function detectPgTrgmFunction(sql: string): boolean {
  if (!sql) return false;
  PG_TRGM_FUNC_RE.lastIndex = 0;
  return PG_TRGM_FUNC_RE.test(sql);
}

// ── Catalog registration ─────────────────────────────────────────

/**
 * Metadata for each pg_trgm function for pg_proc catalog registration.
 */
export interface PgTrgmFunctionMeta {
  /** Function name as exposed to SQL */
  name: string;
  /** Argument count (0 = variadic/no arguments) */
  argCount: number;
  /** Comma-separated argument types */
  argTypes: string;
  /** Return type */
  returnType: string;
  /** Brief description */
  description: string;
}

/**
 * Full list of pg_trgm functions with metadata.
 * Can be registered in pg_proc so they appear in `SELECT * FROM pg_proc`.
 */
export const PG_TRGM_FUNCTIONS: PgTrgmFunctionMeta[] = [
  {
    name: 'show_trgm',
    argCount: 1,
    argTypes: 'text',
    returnType: 'text[]',
    description: 'Extract trigram set from a string',
  },
  {
    name: 'similarity',
    argCount: 2,
    argTypes: 'text, text',
    returnType: 'float4',
    description: 'Dice coefficient similarity (0.0-1.0)',
  },
  {
    name: 'word_similarity',
    argCount: 2,
    argTypes: 'text, text',
    returnType: 'float4',
    description: 'Best trigram match between first arg and any word in second',
  },
  {
    name: 'strict_word_similarity',
    argCount: 2,
    argTypes: 'text, text',
    returnType: 'float4',
    description: 'Best trigram match with exact word boundary',
  },
  {
    name: 'show_limit',
    argCount: 0,
    argTypes: '',
    returnType: 'float4',
    description: 'Return current similarity threshold (default 0.3)',
  },
  {
    name: 'set_limit',
    argCount: 1,
    argTypes: 'float4',
    returnType: 'float4',
    description: 'Set similarity threshold, return previous value',
  },
];

/**
 * Convenience object mapping function name → our exported implementation.
 * Useful for dynamic dispatch when intercepting SQL function calls.
 */
export const PG_TRGM_FN_MAP: Record<string, (...args: any[]) => any> = {
  show_trgm: showTrgm,
  similarity,
  word_similarity: wordSimilarity,
  strict_word_similarity: strictWordSimilarity,
  show_limit: showLimit,
  set_limit: setLimit,
};

// ── Logger ───────────────────────────────────────────────────────

export { logger };
