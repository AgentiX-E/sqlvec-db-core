/**
 * IncrementalSortShim — Detects and handles PostgreSQL incremental sort related
 * statements for SQLite compatibility.
 *
 * PostgreSQL supports the `enable_incremental_sort` GUC (Grand Unified Configuration)
 * parameter to control whether the optimizer can use incremental sort (Sort → Incremental Sort).
 * SQLite has no incremental sort concept.
 *
 * ## Strategy
 * 1. `SET enable_incremental_sort = on/off` → Rewrite as `SELECT 1` (no-op)
 * 2. `SHOW enable_incremental_sort` → Rewrite as `SELECT 'off' as enable_incremental_sort`
 *    (informational query reporting the absence of the feature)
 * 3. All other SQL → Passthrough (unchanged)
 *
 * ## Supported patterns
 *
 * ### SET variants:
 * ```sql
 * SET enable_incremental_sort = on;       -- = value
 * SET enable_incremental_sort = off;      -- = value
 * SET enable_incremental_sort TO on;      -- TO value
 * SET enable_incremental_sort TO off;     -- TO value
 * SET SESSION enable_incremental_sort = on;
 * SET LOCAL enable_incremental_sort = off;
 * ```
 *
 * ### SHOW variants:
 * ```sql
 * SHOW enable_incremental_sort;
 * ```
 *
 * ## Key guarantees
 * - No false positives on SQL containing 'enable_incremental_sort' in identifiers,
 *   strings, or comments
 * - Detection is case-insensitive
 * - PinoLogger integration for debugging and audit trails
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('IncrementalSortShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface IncrSortResult {
  /** Rewritten SQL (original SQL if not rewritten) */
  sql: string;
  /** Whether incremental sort was detected and processed */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants – Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches a SET statement for enable_incremental_sort.
 *
 * Captures: the value (on/off/true/false/0/1/etc.)
 *
 * Covers:
 *   SET enable_incremental_sort = on
 *   SET enable_incremental_sort = off
 *   SET enable_incremental_sort TO on
 *   SET enable_incremental_sort TO off
 *   SET SESSION enable_incremental_sort = on
 *   SET LOCAL enable_incremental_sort = off
 */
const SET_INCR_SORT_PATTERN =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+|TEMP(?:ORARY)?\s+)?enable_incremental_sort\s*(?:[=:]\s*|\s+TO\s+)(.+?)\s*;?\s*$/i;

/**
 * Matches a SHOW statement for enable_incremental_sort.
 *
 * Covers:
 *   SHOW enable_incremental_sort;
 */
const SHOW_INCR_SORT_PATTERN =
  /^\s*SHOW\s+enable_incremental_sort\s*;?\s*$/i;

/**
 * Broad detection pattern — matches any statement containing
 * "enable_incremental_sort" as a significant token (not inside a string literal).
 * Used by `detectIncrSort` for early fast-path detection.
 */
const INCR_SORT_TOKEN_PATTERN = /enable_incremental_sort/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string references `enable_incremental_sort`.
 *
 * Performs a case-insensitive check for the token `enable_incremental_sort`
 * anywhere in the statement. Intentionally broad to catch both SET and SHOW
 * variants.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL references incremental sort configuration
 *
 * @example
 * ```ts
 * detectIncrSort("SET enable_incremental_sort = on;");   // true
 * detectIncrSort("SHOW enable_incremental_sort;");       // true
 * detectIncrSort("SELECT * FROM users");                 // false
 * ```
 */
export function detectIncrSort(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast keyword check before regex matching
  if (!INCR_SORT_TOKEN_PATTERN.test(trimmed)) {
    return false;
  }

  // Confirm it's either a SET or SHOW targeting incremental sort
  return (
    SET_INCR_SORT_PATTERN.test(trimmed) ||
    SHOW_INCR_SORT_PATTERN.test(trimmed)
  );
}

/**
 * Rewrite a PostgreSQL incremental sort related SQL statement for SQLite compatibility.
 *
 * **Processing rules:**
 * | Input                                           | Output                                         | rewritten |
 * |-------------------------------------------------|------------------------------------------------|-----------|
 * | `SET enable_incremental_sort = on`              | `SELECT 1`                                     | true      |
 * | `SET enable_incremental_sort = off`             | `SELECT 1`                                     | true      |
 * | `SET enable_incremental_sort TO on`             | `SELECT 1`                                     | true      |
 * | `SET SESSION enable_incremental_sort = on`      | `SELECT 1`                                     | true      |
 * | `SET LOCAL enable_incremental_sort = off`       | `SELECT 1`                                     | true      |
 * | `SHOW enable_incremental_sort`                  | `SELECT 'off' as enable_incremental_sort`      | true      |
 * | Non-incremental-sort SQL                        | `<original>`                                   | false     |
 * | Empty string                                    | `''`                                           | false     |
 *
 * @param sql   The raw SQL string to process
 * @returns     An IncrSortResult indicating the handling outcome
 *
 * @example
 * ```ts
 * const result = rewriteIncrSort("SET enable_incremental_sort = off");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * const result = rewriteIncrSort("SHOW enable_incremental_sort");
 * // → { sql: "SELECT 'off' as enable_incremental_sort", rewritten: true }
 *
 * const result = rewriteIncrSort("SELECT * FROM users");
 * // → { sql: "SELECT * FROM users", rewritten: false }
 * ```
 */
export function rewriteIncrSort(sql: string): IncrSortResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Fast-path: no "enable_incremental_sort" token at all ──

  if (!INCR_SORT_TOKEN_PATTERN.test(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Check SHOW pattern first ─────────────────────────────

  if (SHOW_INCR_SORT_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SHOW enable_incremental_sort detected — rewriting to SELECT',
    );
    return {
      sql: "SELECT 'off' as enable_incremental_sort",
      rewritten: true,
    };
  }

  // ── Check SET pattern ────────────────────────────────────

  if (SET_INCR_SORT_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SET enable_incremental_sort detected — rewriting to SELECT 1',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Token present but not a SET/SHOW we handle → passthrough ──

  logger.debug(
    { sql: trimmed },
    'enable_incremental_sort token found but not a handled pattern — passing through',
  );

  return {
    sql: trimmed,
    rewritten: false,
  };
}
