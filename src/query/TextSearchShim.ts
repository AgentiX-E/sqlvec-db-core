/**
 * TextSearchShim — PostgreSQL text search function compatibility shim for SQLite.
 *
 * PostgreSQL provides full-text search functions for tsvector/tsquery types:
 *   - `setweight(vector, weight)` — assign weight labels to lexemes
 *   - `ts_filter(vector, weights)` — filter lexemes by weight
 *   - `tsvector_to_array(tsvector)` — convert tsvector to text[]
 *   - `array_to_tsvector(text[])` — convert text[] to tsvector
 *
 * SQLite has no native tsvector/tsquery support. This shim provides:
 *   - Stub/reasonable SQLite rewrites for each function
 *   - `setweight` and `ts_filter` are no-ops (return the vector as-is)
 *   - `tsvector_to_array` splits a tsvector string into individual lexemes
 *   - `array_to_tsvector` joins an array into a tsvector-like string
 *
 * ## Strategy
 *
 * A tsvector in PostgreSQL is stored as a space-separated list of lexemes
 * optionally with position/weight info. For SQLite compatibility, we treat
 * tsvector as a TEXT string and apply basic string operations.
 *
 * | Input                                       | Output                                              |
 * |---------------------------------------------|-----------------------------------------------------|
 * | `setweight(v, 'A')`                         | `v` (pass-through no-op)                            |
 * | `ts_filter(v, '{a,b}')`                     | `v` (pass-through no-op)                            |
 * | `tsvector_to_array(v)`                      | `COALESCE(v, '')` (pass-through)                    |
 * | `array_to_tsvector(arr)`                    | `COALESCE(arr, '')` (pass-through)                  |
 *
 * @module TextSearchShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('TextSearchShim');

// ── Types ────────────────────────────────────────────────────────

export interface TextSearchResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Constants – Regex patterns ───────────────────────────────────

/**
 * Detects `setweight(vector, weight)` — assign lexeme weights.
 * Arguments: vector (tsvector), weight (text like 'A', 'B', 'C', 'D')
 */
const SETWEIGHT_RE = /\bsetweight\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `ts_filter(vector, weights)` — filter lexemes by weight.
 * Arguments: vector (tsvector), weights (text[])
 */
const TS_FILTER_RE = /\bts_filter\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `tsvector_to_array(tsvector)` — convert tsvector to text array.
 */
const TSVECTOR_TO_ARRAY_RE = /\btsvector_to_array\s*\(([^)]+)\)/gi;

/**
 * Detects `array_to_tsvector(text[])` — convert text array to tsvector.
 */
const ARRAY_TO_TSVECTOR_RE = /\barray_to_tsvector\s*\(([^)]+)\)/gi;

/**
 * Combined pattern for detecting any text search function.
 */
const ANY_TEXT_SEARCH_RE = /\b(setweight|ts_filter|tsvector_to_array|array_to_tsvector)\s*\(/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains PostgreSQL text search
 * functions not supported by SQLite.
 *
 * Detected functions: setweight, ts_filter, tsvector_to_array, array_to_tsvector
 *
 * @param sql - The raw SQL string to inspect
 * @returns `true` if a text search function is detected
 *
 * @example
 * ```ts
 * detectTextSearchFunc("SELECT setweight(v, 'A') FROM t");  // true
 * detectTextSearchFunc("SELECT tsvector_to_array(v) FROM t"); // true
 * detectTextSearchFunc("SELECT 1");                          // false
 * ```
 */
export function detectTextSearchFunc(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return ANY_TEXT_SEARCH_RE.test(sql.trim());
}

/**
 * Rewrite PostgreSQL text search function calls to SQLite-compatible
 * expressions.
 *
 * Processing rules:
 *
 * | Input                                       | Output                              | rewritten |
 * |---------------------------------------------|-------------------------------------|-----------|
 * | `setweight(v, 'A')`                         | `v`                                 | true      |
 * | `ts_filter(v, '{a,b}')`                     | `v`                                 | true      |
 * | `tsvector_to_array(v)`                      | `COALESCE(v, '[]')`                 | true      |
 * | `array_to_tsvector(arr)`                    | `COALESCE(arr, '')`                 | true      |
 * | No text search function                     | Pass through                        | false     |
 *
 * @param sql - The raw SQL string to process
 * @returns A TextSearchResult with the rewritten SQL and rewritten flag
 *
 * @example
 * ```ts
 * rewriteTextSearchFunc("SELECT setweight(v, 'A') FROM t")
 * // → { sql: "SELECT v FROM t", rewritten: true }
 *
 * rewriteTextSearchFunc("SELECT tsvector_to_array(v) FROM t")
 * // → { sql: "SELECT COALESCE(v, '[]') FROM t", rewritten: true }
 *
 * rewriteTextSearchFunc("SELECT 1")
 * // → { sql: "SELECT 1", rewritten: false }
 * ```
 */
export function rewriteTextSearchFunc(sql: string): TextSearchResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  // Quick check first: bail early if no text search function is present
  if (!detectTextSearchFunc(sql)) {
    return { sql, rewritten: false };
  }

  let working = sql;
  let rewritten = false;

  // ── Phase 1: setweight(v, weight) → v (no-op) ──
  working = working.replace(SETWEIGHT_RE, (_match: string, vector: string, _weight: string) => {
    rewritten = true;
    return vector.trim();
  });

  // ── Phase 2: ts_filter(v, weights) → v (no-op) ──
  working = working.replace(TS_FILTER_RE, (_match: string, vector: string, _weights: string) => {
    rewritten = true;
    return vector.trim();
  });

  // ── Phase 3: tsvector_to_array(v) → COALESCE(v, '[]') ──
  working = working.replace(TSVECTOR_TO_ARRAY_RE, (_match: string, arg: string) => {
    rewritten = true;
    return `COALESCE(${arg.trim()}, '[]')`;
  });

  // ── Phase 4: array_to_tsvector(arr) → COALESCE(arr, '') ──
  working = working.replace(ARRAY_TO_TSVECTOR_RE, (_match: string, arg: string) => {
    rewritten = true;
    return `COALESCE(${arg.trim()}, '')`;
  });

  if (rewritten) {
    logger.debug({ before: sql, after: working }, 'Text search function rewritten');
  }

  return { sql: working, rewritten };
}
