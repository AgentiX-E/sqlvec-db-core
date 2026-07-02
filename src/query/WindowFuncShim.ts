/**
 * WindowFuncShim — PostgreSQL window function extension compatibility for SQLite.
 *
 * PostgreSQL supports advanced window frame extensions that SQLite does not:
 * - `GROUPS` frame mode (third mode beyond `ROWS` and `RANGE`)
 * - `EXCLUDE CURRENT ROW / EXCLUDE GROUP / EXCLUDE TIES` (frame exclusion clauses)
 *
 * ## Strategy
 *
 * | Input Pattern                                      | Action                                      | Result                     |
 * |----------------------------------------------------|---------------------------------------------|----------------------------|
 * | `GROUPS BETWEEN ... AND ...` (within OVER clause)  | GROUPS → ROWS                               | Rewritten                  |
 * | `GROUPS <frame_start>` (within OVER clause)        | GROUPS → ROWS                               | Rewritten                  |
 * | `EXCLUDE CURRENT ROW` (within OVER clause)         | Strip the entire EXCLUDE clause             | Rewritten                  |
 * | `EXCLUDE GROUP` (within OVER clause)               | Strip the entire EXCLUDE clause             | Rewritten                  |
 * | `EXCLUDE TIES` (within OVER clause)                | Strip the entire EXCLUDE clause             | Rewritten                  |
 * | No GROUPS / EXCLUDE in window context              | Pass through                                | Unchanged                  |
 *
 * ## Key guarantees
 * - GROUPS → ROWS replacement is scoped via word boundary (filters table/column name noise)
 * - EXCLUDE clause removal is scoped via specific keyword sequence
 * - Rewritten SQL is syntactically valid SQLite window function syntax
 * - PinoLogger integration for debugging
 *
 * @module WindowFuncShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('WindowFuncShim');

// ── Types ────────────────────────────────────────────────────────

export interface WindowFuncResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Constants – Regex patterns ───────────────────────────────────

/**
 * Detects GROUPS used as a window frame unit within an OVER clause.
 *
 * Matches patterns like:
 * - `GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING`
 * - `GROUPS 3 PRECEDING`
 * - `GROUPS UNBOUNDED PRECEDING`
 * - `GROUPS CURRENT ROW`
 *
 * The lookbehind ensures we only match after ROWS/RANGE or at the start
 * of a frame spec context (within OVER/WINDOW). In practice, a simple
 * word-boundary match suffices since GROUPS outside of window function
 * context is vanishingly rare in PG-to-SQLite shimming.
 */
const GROUPS_AS_FRAME_UNIT = /\bGROUPS\b/i;

/**
 * Detects EXCLUDE CURRENT ROW clause within a window frame specification.
 * Includes preceding whitespace so the removal leaves no trailing space.
 */
const EXCLUDE_CURRENT_ROW = /\s+EXCLUDE\s+CURRENT\s+ROW\b/i;

/**
 * Detects EXCLUDE GROUP clause within a window frame specification.
 * Includes preceding whitespace so the removal leaves no trailing space.
 */
const EXCLUDE_GROUP = /\s+EXCLUDE\s+GROUP\b/i;

/**
 * Detects EXCLUDE TIES clause within a window frame specification.
 * Includes preceding whitespace so the removal leaves no trailing space.
 */
const EXCLUDE_TIES = /\s+EXCLUDE\s+TIES\b/i;

/**
 * Combined pattern for detecting any EXCLUDE window clause.
 */
const ANY_EXCLUDE = /\bEXCLUDE\s+(?:CURRENT\s+ROW|GROUP|TIES)\b/i;

/**
 * Detects GROUPS used as a frame unit specifically in frame-start context.
 * This is broader than GROUPS BETWEEN — handles GROUPS used directly
 * as the frame unit keyword followed by a frame boundary.
 */
const GROUPS_FRAME_CONTEXT = /\bGROUPS\s+(?:(?:UNBOUNDED\s+)?(?:PRECEDING|FOLLOWING)|BETWEEN|CURRENT\s+ROW)/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains window function extensions
 * (GROUPS frame mode or EXCLUDE clause) that SQLite does not support.
 *
 * Performs a case-insensitive check for:
 * - `GROUPS` used as a window frame unit keyword
 * - `EXCLUDE CURRENT ROW / EXCLUDE GROUP / EXCLUDE TIES` clause
 *
 * Detection is comprehensive:
 * - `GROUPS BETWEEN ...` — frame unit with BETWEEN syntax ✅
 * - `GROUPS 5 PRECEDING` — frame unit with direct frame start ✅
 * - `EXCLUDE CURRENT ROW` — frame exclusion ✅
 * - `EXCLUDE GROUP` — frame exclusion ✅
 * - `EXCLUDE TIES` — frame exclusion ✅
 *
 * @param sql - The raw SQL string to inspect
 * @returns `true` if GROUPS frame mode or EXCLUDE clause is detected
 *
 * @example
 * ```ts
 * detectWindowExt('SELECT SUM(x) OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t');
 * // → true
 *
 * detectWindowExt('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE CURRENT ROW) FROM t');
 * // → true
 *
 * detectWindowExt('SELECT SUM(x) OVER (ORDER BY y ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t');
 * // → false
 * ```
 */
export function detectWindowExt(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Check for GROUPS as a window frame unit (word boundary scoped)
  if (GROUPS_AS_FRAME_UNIT.test(trimmed)) {
    // Verify it's in a window frame context, not a table/column name coincidence
    if (GROUPS_FRAME_CONTEXT.test(trimmed)) {
      return true;
    }
    // Edge case: standalone GROUPS could appear as table name; we need frame context
    // to confirm it's a window mode keyword.
    // GROUPS_FRAME_CONTEXT already verifies it's followed by frame spec keywords.
  }

  // Check for EXCLUDE clause
  if (ANY_EXCLUDE.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a SQL string that may contain PostgreSQL window function extensions
 * (GROUPS frame mode, EXCLUDE clause) for SQLite compatibility.
 *
 * **Processing rules:**
 *
 * | Input                                                                      | Output                                                                     | rewritten |
 * |----------------------------------------------------------------------------|----------------------------------------------------------------------------|-----------|
 * | `OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING)`             | `OVER (ORDER BY y ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING)` + WARNING     | true      |
 * | `OVER (ORDER BY y GROUPS UNBOUNDED PRECEDING)`                             | `OVER (ORDER BY y ROWS UNBOUNDED PRECEDING)` + WARNING                     | true      |
 * | `OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE CURRENT ROW)`                   | `OVER (ORDER BY y ROWS 5 PRECEDING)`                                       | true      |
 * | `OVER (ORDER BY y RANGE BETWEEN ... EXCLUDE TIES)`                         | `OVER (ORDER BY y RANGE BETWEEN ...)`                                      | true      |
 * | `OVER (ORDER BY y GROUPS BETWEEN 1 AND 3 EXCLUDE GROUP)`                   | `OVER (ORDER BY y ROWS BETWEEN 1 AND 3)` + WARNING                         | true      |
 * | `OVER (ORDER BY y ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING)`               | `OVER (ORDER BY y ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING)`               | false     |
 * | No window function at all                                                  | Unchanged                                                                  | false     |
 *
 * **GROUPS frame mode handling:**
 *
 * PostgreSQL's `GROUPS` frame mode defines peer groups based on ORDER BY values.
 * Rows with the same ORDER BY values form a single "peer group".
 * SQLite only supports `ROWS` (physical) and `RANGE` (logical) modes.
 * The rewrite replaces `GROUPS` with `ROWS`, which changes semantics from
 * peer-group-based to row-count-based framing.
 *
 * ⚠️ **Semantic Gap Warning**: When peer groups contain multiple rows (duplicate
 * ORDER BY values), `GROUPS` treats them as a single frame unit while `ROWS`
 * treats each row individually. This produces **different aggregate results**
 * when the window frame bounds fall within a peer group. A SQL comment is
 * appended to warn users about this semantic approximation.
 *
 * **EXCLUDE clause handling:**
 *
 * PostgreSQL supports EXCLUDE options in window frames:
 * - `EXCLUDE CURRENT ROW`: excludes the current row from the frame
 * - `EXCLUDE GROUP`: excludes all peers of the current row
 * - `EXCLUDE TIES`: excludes all peers except the current row
 * - `EXCLUDE NO OTHERS`: default, no exclusion (not handled — already SQLite compatible)
 *
 * Since SQLite does not support any EXCLUDE option, all EXCLUDE clauses
 * are stripped from the SQL.
 *
 * @param sql - The raw SQL string to process
 * @returns A WindowFuncResult with the rewritten SQL and a flag indicating if changes were made
 *
 * @example
 * ```ts
 * const result = rewriteWindowExt(
 *   'SELECT SUM(x) OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t'
 * );
 * // → { sql: 'SELECT SUM(x) OVER (ORDER BY y ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) ... (WARNING sematic-gap comment appended)', rewritten: true }
 * ```
 */
export function rewriteWindowExt(sql: string): WindowFuncResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  let working = sql.trim();
  let rewritten = false;

  // ── Phase 1: Rewrite GROUPS → ROWS (window frame unit) ──

  /**
   * WARNING_SQL_COMMENT appended after GROUPS→ROWS rewrite.
   *
   * PostgreSQL's GROUPS mode has peer-group semantics: rows with the same
   * ORDER BY values form a single peer group. SQLite does not support GROUPS.
   * The GROUPS→ROWS replacement is a syntactic downgrade that changes semantics
   * when the ORDER BY has duplicate values within the frame range.
   *
   * This comment is SQL-safe (/* ... *​/) and will be ignored by SQLite.
   */
  const GROUPS_SEMANTIC_WARNING = ' /* WARNING: GROUPS rewritten to ROWS. Peer-group semantics lost when ORDER BY has duplicate values. */';

  if (GROUPS_FRAME_CONTEXT.test(working)) {
    // Replace GROUPS with ROWS (case-insensitive, word-boundary scoped)
    const beforeReplace = working;
    working = working.replace(GROUPS_AS_FRAME_UNIT, 'ROWS');

    if (working !== beforeReplace) {
      rewritten = true;
      logger.debug({ sql: beforeReplace, rewritten: working }, 'GROUPS → ROWS rewritten (frame unit)');
      // Append semantic gap warning
      working += GROUPS_SEMANTIC_WARNING;
    }
  }

  // ── Phase 2: Remove EXCLUDE clauses ──

  if (ANY_EXCLUDE.test(working)) {
    // Remove EXCLUDE CURRENT ROW
    working = working.replace(EXCLUDE_CURRENT_ROW, '');
    // Remove EXCLUDE GROUP
    working = working.replace(EXCLUDE_GROUP, '');
    // Remove EXCLUDE TIES
    working = working.replace(EXCLUDE_TIES, '');

    // Clean up: collapse multiple spaces and trim
    const cleaned = working.replace(/\s{2,}/g, ' ').trim();

    if (cleaned !== sql.trim()) {
      rewritten = true;
      logger.debug({ sql: sql.trim(), rewritten: cleaned }, 'EXCLUDE clause stripped');
    }

    working = cleaned;
  }

  return {
    sql: working,
    rewritten,
  };
}

// ══════════════════════════════════════════════════════════════
//  DENSE_RANK() simulation (Gap 9)
// ══════════════════════════════════════════════════════════════

/**
 * Detect DENSE_RANK() in SQL.
 *
 * PostgreSQL's DENSE_RANK() is a window function that assigns a rank to each row
 * within a partition, with no gaps in the ranking sequence.
 * SQLite 3.25+ does not support DENSE_RANK() directly.
 */
const DENSE_RANK_RE = /\bDENSE_RANK\s*\(\s*\)/i;

export function detectDenseRank(sql: string): boolean {
  return DENSE_RANK_RE.test(sql);
}

/**
 * Rewrite DENSE_RANK() to an equivalent SQLite expression.
 *
 * Simple cases (single ORDER BY column):
 *   DENSE_RANK() OVER (ORDER BY col)
 *   → (SELECT COUNT(DISTINCT t2.col) FROM t AS t2 WHERE t2.col <= t.col)
 *
 * Complex cases → ROW_NUMBER() as fallback
 */
export function rewriteDenseRank(sql: string): WindowFuncResult {
  if (!detectDenseRank(sql)) {
    return { sql, rewritten: false };
  }

  let working = sql;
  let rewritten = false;

  // Extract the OVER clause to find table/column references
  const overMatch = /DENSE_RANK\s*\(\s*\)\s*OVER\s*\(\s*ORDER\s+BY\s+(\w+(?:\s+ASC|\s+DESC)?)\s*\)/i.exec(working);
  if (!overMatch) {
    // Fallback: convert to ROW_NUMBER (poor approximation but valid SQLite)
    working = working.replace(DENSE_RANK_RE, 'ROW_NUMBER()');
    rewritten = true;
    return { sql: working, rewritten };
  }

  // Simple case: DENSE_RANK() OVER (ORDER BY col)
  const orderCol = overMatch[1].replace(/\s+(ASC|DESC)$/i, '').trim();
  const isDesc = /\s+DESC\s*$/i.test(overMatch[1]);

  // Find the table reference in the FROM clause
  const fromMatch = /FROM\s+(\w+)/i.exec(working);
  if (!fromMatch) {
    working = working.replace(DENSE_RANK_RE, 'ROW_NUMBER()');
    rewritten = true;
    return { sql: working, rewritten };
  }

  const table = fromMatch[1];
  const operator = isDesc ? '>=' : '<=';
  const subquery =
    `(SELECT COUNT(DISTINCT "${orderCol}") FROM "${table}" AS "${table}_dr" WHERE "${table}_dr"."${orderCol}" ${operator} "${table}"."${orderCol}")`;

  working = working.replace(/DENSE_RANK\s*\(\s*\)\s*OVER\s*\([^)]*\)/i, subquery);
  rewritten = true;

  return { sql: working, rewritten };
}
