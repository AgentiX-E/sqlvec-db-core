/**
 * AnalyzeShim — PostgreSQL ANALYZE compatibility shim for SQLite.
 *
 * SQLite natively supports `ANALYZE` and `ANALYZE table_name`, but does NOT
 * support PostgreSQL-specific extensions such as the VERBOSE keyword or
 * column list syntax `(col1, col2)`.
 *
 * This shim detects PG-specific ANALYZE patterns and rewrites them into
 * their SQLite-compatible equivalents.
 *
 * ## PG syntax vs SQLite support
 *
 * | PG Syntax                              | Rewrite                        | Rewritten |
 * |----------------------------------------|--------------------------------|-----------|
 * | `ANALYZE;`                             | `ANALYZE` (pass-through)       | ❌        |
 * | `ANALYZE table_name;`                  | `ANALYZE table_name` (pass)    | ❌        |
 * | `ANALYZE VERBOSE;`                     | `ANALYZE`                      | ✅        |
 * | `ANALYZE table_name (col1, col2);`     | `ANALYZE table_name`           | ✅        |
 * | `ANALYZE VERBOSE table_name (col1, col2);` | `ANALYZE table_name`      | ✅        |
 * | `ANALYZE (col1, col2);`                | `ANALYZE`                      | ✅        |
 * | `ANALYZE VERBOSE table_name;`          | `ANALYZE table_name`           | ✅        |
 *
 * ## Strategy
 * 1. Detect if the SQL is a PG-specific ANALYZE (contains VERBOSE or column list)
 * 2. Strip VERBOSE keyword
 * 3. Strip column list `(col1, col2)` suffix
 * 4. Leave bare `ANALYZE` / `ANALYZE table_name` untouched
 *
 * ## Autovacuum Hook
 * A mutation notification callback can be registered via
 * `setAnalyzeMutationHook()`. When an ANALYZE is detected, the hook
 * is called with the table name so the AutovacuumDaemon can reset
 * its modification counter.
 *
 * @module AnalyzeShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('AnalyzeShim');

// ── Autovacuum Hook ─────────────────────────────────────────────

/**
 * Callback type for analyze mutation notifications.
 */
export type AnalyzeHookCallback = (tableName?: string) => void;

/** Registered autovacuum hook (null if not set) */
let analyzeMutationHook: AnalyzeHookCallback | null = null;

/**
 * Register a callback to be notified when ANALYZE is processed.
 * Used by AutovacuumDaemon to reset internal modification counters.
 *
 * @param hook  The callback to invoke on ANALYZE detection, or null to clear
 */
export function setAnalyzeMutationHook(hook: AnalyzeHookCallback | null): void {
  analyzeMutationHook = hook;
}

// ── Types ────────────────────────────────────────────────────────

export interface AnalyzeResult {
  /** Rewritten SQL (original SQL if no rewrite needed) */
  sql: string;
  /** Whether the SQL was rewritten */
  rewritten: boolean;
}

// ── Constants — Regex patterns ───────────────────────────────────

/**
 * Matches SQL statements that start with ANALYZE (case-insensitive).
 */
const ANALYZE_START_PATTERN = /^\s*ANALYZE\b/i;

/**
 * Matches the VERBOSE keyword as a whole word (case-insensitive).
 */
const VERBOSE_PATTERN = /\bVERBOSE\b/i;

/**
 * Matches a parenthesized column list at the end of an ANALYZE statement.
 *
 * The column list must appear:
 * - After optional whitespace following the table name (or directly after ANALYZE)
 * - At the end of the statement (before optional semicolon)
 *
 * Examples matched:
 *   ANALYZE (col1, col2)
 *   ANALYZE table_name (col1, col2)
 *   ANALYZE VERBOSE (col1, col2)
 *   ANALYZE VERBOSE table_name (col1, col2)
 *
 * We use negative lookbehind to avoid matching anything other than
 * the column list suffix. Since ANALYZE has no other parenthesized
 * sub-expressions, a simple non-greedy group is sufficient.
 */
const COL_LIST_END_PATTERN = /\s*\([^)]*\)\s*$/;

/**
 * Matches VERBOSE followed by optional whitespace — used for removal.
 */
const VERBOSE_WITH_TRAILING = /\bVERBOSE\s+/i;

/**
 * Matches any PG-specific ANALYZE pattern (has VERBOSE or column list).
 *
 * This is used by detectPgAnalyze() to distinguish PG-extended syntax
 * from SQLite-compatible bare ANALYZE / ANALYZE table_name.
 */
const PG_ANALYZE_PATTERN =
  /^\s*ANALYZE\s+(?:VERBOSE(?:\s+[a-zA-Z_][a-zA-Z0-9_.]*)?\s*\([^)]*\)|VERBOSE\b|\s*\([^)]*\)|[a-zA-Z_][a-zA-Z0-9_.]*\s*\([^)]*\))/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL is a PostgreSQL-specific ANALYZE statement
 * that requires rewriting for SQLite compatibility.
 *
 * Returns `true` if the statement is an ANALYZE containing VERBOSE or a
 * column list `(col1, col2)`. Returns `false` for bare `ANALYZE` or
 * `ANALYZE table_name` (both supported natively by SQLite).
 *
 * @param sql - The raw SQL string to inspect.
 * @returns `true` if the SQL is a PG-specific ANALYZE statement.
 *
 * @example
 * ```ts
 * detectPgAnalyze('ANALYZE;');                                  // false
 * detectPgAnalyze('ANALYZE users;');                            // false
 * detectPgAnalyze('ANALYZE VERBOSE;');                          // true
 * detectPgAnalyze('ANALYZE users (id, name);');                 // true
 * detectPgAnalyze('ANALYZE VERBOSE users (id, name);');         // true
 * detectPgAnalyze('SELECT * FROM users;');                      // false
 * ```
 */
export function detectPgAnalyze(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Must start with ANALYZE
  if (!ANALYZE_START_PATTERN.test(trimmed)) {
    return false;
  }

  // Quick check: has VERBOSE keyword?
  if (VERBOSE_PATTERN.test(trimmed)) {
    return true;
  }

  // Check for column list pattern (PG-specific ANALYZE)
  if (PG_ANALYZE_PATTERN.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL ANALYZE statement into SQLite-compatible form.
 *
 * **Processing rules:**
 * | Input                                   | Output                   | rewritten |
 * |-----------------------------------------|--------------------------|-----------|
 * | `ANALYZE`                               | `ANALYZE` (pass-through) | `false`   |
 * | `ANALYZE table_name`                    | `ANALYZE table_name`     | `false`   |
 * | `ANALYZE VERBOSE`                       | `ANALYZE`                | `true`    |
 * | `ANALYZE table_name (col1, col2)`       | `ANALYZE table_name`     | `true`    |
 * | `ANALYZE VERBOSE table_name (col1, col2)` | `ANALYZE table_name` | `true`    |
 * | `ANALYZE (col1, col2)`                  | `ANALYZE`                | `true`    |
 * | `ANALYZE VERBOSE table_name`            | `ANALYZE table_name`     | `true`    |
 * | Non-ANALYZE SQL                         | `<original>`             | `false`   |
 *
 * The rewrite process:
 * 1. Strip the VERBOSE keyword and trailing whitespace
 * 2. Strip the column list `(...)` suffix if present at end of statement
 * 3. Normalize whitespace and ensure proper termination
 *
 * @param sql - The raw SQL string to process.
 * @returns An `AnalyzeResult` with the (possibly rewritten) SQL and a flag.
 *
 * @example
 * ```ts
 * rewriteAnalyze('ANALYZE VERBOSE users (id, name);');
 * // → { sql: 'ANALYZE users', rewritten: true }
 *
 * rewriteAnalyze('ANALYZE users;');
 * // → { sql: 'ANALYZE users', rewritten: false }
 * ```
 */
export function rewriteAnalyze(sql: string): AnalyzeResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  let trimmed = sql.trim();

  // Not an ANALYZE statement — pass through unchanged
  if (!ANALYZE_START_PATTERN.test(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  let rewritten = false;

  // ── Step 1: Remove VERBOSE keyword ──────────────────────────
  if (VERBOSE_PATTERN.test(trimmed)) {
    trimmed = trimmed.replace(VERBOSE_WITH_TRAILING, '');
    // Handle the edge case where VERBOSE is at end with no trailing space
    trimmed = trimmed.replace(/\s*VERBOSE\s*$/i, '');
    rewritten = true;
    trimmed = trimmed.trim();
  }

  // ── Step 2: Remove parenthesized column list at end ─────────
  const withoutSemicolon = trimmed.replace(/;\s*$/, '').trim();
  if (COL_LIST_END_PATTERN.test(withoutSemicolon)) {
    // Only strip col list if it's part of the ANALYZE statement,
    // not a completely different parenthesized expression.
    // We check if the part before the col list is valid.
    const beforeColList = withoutSemicolon.replace(COL_LIST_END_PATTERN, '').trim();

    // Verify this still looks like a valid ANALYZE prefix
    if (
      beforeColList.length > 0 &&
      /^(?:ANALYZE|ANALYZE\s+[a-zA-Z_][a-zA-Z0-9_.]*)$/i.test(beforeColList)
    ) {
      logger.debug(
        { sql: trimmed, beforeColList },
        'Removing column list from ANALYZE statement',
      );
      trimmed = beforeColList;
      rewritten = true;
    }
  }

  // ── Step 3: Ensure proper semicolon termination ─────────────
  trimmed = trimmed.trim();

  // ── Step 4: Notify autovacuum hook ─────────────────────────

  if (analyzeMutationHook) {
    // Extract table name from the ANALYZE statement (after the ANALYZE keyword)
    const tableNameMatch = trimmed.match(/^\s*ANALYZE\s+(?:VERBOSE\s+)?([a-zA-Z_][a-zA-Z0-9_.]*)/i);
    const extractedTable = tableNameMatch?.[1] || undefined;
    analyzeMutationHook(extractedTable);
  }

  if (rewritten) {
    logger.debug(
      { original: sql, rewritten: trimmed },
      'Rewrote PG ANALYZE to SQLite-compatible form',
    );
  }

  return { sql: trimmed, rewritten };
}

// ── Internal helpers (exported for testing) ─────────────────────

/**
 * Check if the given string starts with ANALYZE (case-insensitive).
 *
 * @internal Exported for unit testing only.
 */
export function _isAnalyzeStart(s: string): boolean {
  return ANALYZE_START_PATTERN.test(s);
}
