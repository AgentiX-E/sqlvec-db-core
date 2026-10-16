/**
 * PartialIndexShim — PG partial index shim for SQLite
 *
 * SQLite natively supports partial indexes (`CREATE INDEX ... WHERE condition`),
 * but PG-specific extensions need to be stripped or rewritten so the SQL
 * can pass through to SQLite without error.
 *
 * Gap IX04 (P1): PG partial indexes must be transparently shimmed.
 *
 * Rewrites applied:
 *   - CREATE INDEX CONCURRENTLY   →  CREATE INDEX            (SQLite unsupported)
 *   - ... NULLS NOT DISTINCT ...  →  removed                 (PG 15+, SQLite unsupported)
 *   - IF NOT EXISTS               →  transparent passthrough (SQLite supports it)
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('PartialIndexShim');

// ── Types ────────────────────────────────────────────────────────

export interface PartialIndexResult {
  /** The (potentially rewritten) SQL safe to execute against SQLite */
  sql: string;
  /** true when at least one rewrite was applied */
  rewritten: boolean;
}

// ── Regex ────────────────────────────────────────────────────────

/**
 * Matches the opening `CREATE [UNIQUE] INDEX` clause, capturing optional
 * modifiers before the index name.
 */
const RE_CREATE_INDEX = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+/i;

/**
 * Matches `CONCURRENTLY` immediately after `CREATE INDEX` (or
 * `CREATE UNIQUE INDEX`). Case-insensitive.
 */
const RE_CONCURRENTLY = /\bCONCURRENTLY\s+/i;

/**
 * `IF NOT EXISTS` is deliberately NOT rewritten: SQLite natively supports it,
 * so it passes through to the engine unchanged.
 */

/**
 * Matches `NULLS NOT DISTINCT` anywhere after the index column list.
 * This is a PG 15+ extension that SQLite doesn't support.
 * We use a relaxed pattern to catch variations like:
 *   ... NULLS NOT DISTINCT ...
 */
const RE_NULLS_NOT_DISTINCT = /\bNULLS\s+NOT\s+DISTINCT\b/i;

/**
 * Matches a `WHERE` clause that appears after the column/expression list
 * in a CREATE INDEX statement. This is the defining feature of a partial index.
 */
const RE_WHERE_CLAUSE = /\bWHERE\s+/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether a `CREATE INDEX` statement contains a `WHERE` clause,
 * i.e. whether it defines a partial index.
 *
 * @param sql - The raw SQL statement.
 * @returns `true` if the statement is a partial index.
 */
export function detectPartialIndex(sql: string): boolean {
  if (!RE_CREATE_INDEX.test(sql.trim())) {
    return false;
  }
  return RE_WHERE_CLAUSE.test(sql);
}

/**
 * Rewrite a PG `CREATE INDEX` statement so it is safe to execute against
 * SQLite.
 *
 * The function strips PG-only syntax (`CONCURRENTLY`, `NULLS NOT DISTINCT`)
 * while preserving the `WHERE` clause (partial index) and `IF NOT EXISTS`.
 *
 * @param sql - The raw PG CREATE INDEX statement.
 * @returns A `PartialIndexResult` containing the sanitised SQL and a flag
 *          indicating whether any rewrites were applied.
 */
export function rewritePartialIndex(sql: string): PartialIndexResult {
  const trimmed = sql.trim();

  if (!RE_CREATE_INDEX.test(trimmed)) {
    logger.warn({ sql: trimmed }, '[PartialIndexShim] Not a CREATE INDEX statement; returning as-is');
    return { sql: trimmed, rewritten: false };
  }

  let rewritten = false;
  let result = trimmed;

  // ── 1. Strip CONCURRENTLY ──────────────────────────────────
  if (RE_CONCURRENTLY.test(result)) {
    result = result.replace(RE_CONCURRENTLY, '');
    rewritten = true;
    logger.info('[PartialIndexShim] Stripped CONCURRENTLY');
  }

  // ── 2. Strip NULLS NOT DISTINCT ────────────────────────────
  if (RE_NULLS_NOT_DISTINCT.test(result)) {
    result = result.replace(RE_NULLS_NOT_DISTINCT, '');
    rewritten = true;
    logger.info('[PartialIndexShim] Stripped NULLS NOT DISTINCT');
  }

  // ── 3. Validate WHERE clause presence ──────────────────────
  const hasWhere = RE_WHERE_CLAUSE.test(result);
  if (!hasWhere) {
    logger.debug('[PartialIndexShim] No WHERE clause — not a partial index (no-op rewrite)');
  }

  // Normalise whitespace left by removed tokens
  result = result.replace(/\s{2,}/g, ' ').trim();

  if (rewritten) {
    logger.info({ before: trimmed, after: result }, '[PartialIndexShim] Rewrite applied');
  }

  return { sql: result, rewritten };
}
