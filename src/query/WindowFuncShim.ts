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
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('WindowFuncShim');

// ── Types ────────────────────────────────────────────────────────

export interface WindowFuncResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Literal-aware scanner helpers ────────────────────────────────

/** Whether `ch` is a word character that may continue an identifier. */
function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Whether the identifier `keyword` ends at index `end` in `sql`, i.e. it is
 * not immediately followed by another identifier character.
 */
function wordEnds(sql: string, end: number): boolean {
  return end >= sql.length || !isIdentChar(sql[end]);
}

/**
 * Whether `sql.slice(i)` begins with `keyword` (case-insensitive) as a whole
 * word, with the match ending before `endHint` characters. Used to verify that
 * `GROUPS` is followed by a frame-boundary keyword, not an arbitrary identifier.
 */
function startsKeyword(sql: string, i: number, keyword: string): boolean {
  const after = sql.slice(i, i + keyword.length);
  if (after.toUpperCase() !== keyword.toUpperCase()) return false;
  return wordEnds(sql, i + keyword.length);
}

/**
 * Scan for the first occurrence of `keyword` (whole word, case-insensitive)
 * outside of literals/comments. Returns its start index, or `-1`.
 */
function findKeyword(sql: string, keyword: string): number {
  let i = 0;
  while (i < sql.length) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const ch = sql[i];
    if (isIdentChar(ch) && (i === 0 || !isIdentChar(sql[i - 1]))) {
      if (startsKeyword(sql, i, keyword)) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Whether a `GROUPS` keyword at `i` is used as a window frame unit. The
 * PostgreSQL frame grammar after `GROUPS` is one of:
 *   - `BETWEEN <start> AND <end>`
 *   - `UNBOUNDED PRECEDING` / `UNBOUNDED FOLLOWING`
 *   - `<expr> PRECEDING` / `<expr> FOLLOWING`  (e.g. `3 PRECEDING`)
 *   - `CURRENT ROW`
 */
function isGroupsFrameUnit(sql: string, groupsIdx: number): boolean {
  let j = groupsIdx + 'GROUPS'.length;
  while (j < sql.length && /\s/.test(sql[j])) j++;
  if (startsKeyword(sql, j, 'BETWEEN')) return true;
  if (startsKeyword(sql, j, 'UNBOUNDED')) return true;
  if (startsKeyword(sql, j, 'CURRENT')) return true;
  // Otherwise we expect `<expr> PRECEDING/FOLLOWING`. Skip tokens until a
  // PRECEDING/FOLLOWING keyword, stopping at a closing paren or clause end.
  let k = j;
  while (k < sql.length) {
    if (sql[k] === ')' || sql[k] === ';') return false;
    if (startsKeyword(sql, k, 'PRECEDING') || startsKeyword(sql, k, 'FOLLOWING')) {
      return true;
    }
    const skipped = skipSqlLiteral(sql, k);
    if (skipped !== -1) {
      k = skipped;
      continue;
    }
    k++;
  }
  return false;
}

// ── Constants – Regex patterns (keyword tokens) ──────────────────

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

  // Check for GROUPS used as a window frame unit (outside literals/comments).
  const groupsIdx = findKeyword(trimmed, 'GROUPS');
  if (groupsIdx !== -1 && isGroupsFrameUnit(trimmed, groupsIdx)) {
    return true;
  }

  // Check for EXCLUDE clause (outside literals/comments).
  const excludeIdx = findKeyword(trimmed, 'EXCLUDE');
  if (excludeIdx !== -1) {
    let j = excludeIdx + 'EXCLUDE'.length;
    while (j < trimmed.length && /\s/.test(trimmed[j])) j++;
    if (
      startsKeyword(trimmed, j, 'CURRENT') ||
      startsKeyword(trimmed, j, 'GROUP') ||
      startsKeyword(trimmed, j, 'TIES')
    ) {
      return true;
    }
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

  // Replace every GROUPS frame-unit occurrence (outside literals/comments),
  // scanning right-to-left so indices stay valid as we mutate `working`.
  {
    const groupsIdx = findKeyword(working, 'GROUPS');
    if (groupsIdx !== -1 && isGroupsFrameUnit(working, groupsIdx)) {
      const beforeReplace = working;
      // Replace all GROUPS frame units.
      let result = '';
      let i = 0;
      while (i < working.length) {
        const skipped = skipSqlLiteral(working, i);
        if (skipped !== -1) {
          result += working.slice(i, skipped);
          i = skipped;
          continue;
        }
        if (isIdentChar(working[i]) && (i === 0 || !isIdentChar(working[i - 1])) && startsKeyword(working, i, 'GROUPS') && isGroupsFrameUnit(working, i)) {
          result += 'ROWS';
          i += 'GROUPS'.length;
          continue;
        }
        result += working[i];
        i++;
      }
      working = result;

      if (working !== beforeReplace) {
        rewritten = true;
        logger.debug({ sql: beforeReplace, rewritten: working }, 'GROUPS → ROWS rewritten (frame unit)');
        // Append semantic gap warning
        working += GROUPS_SEMANTIC_WARNING;
      }
    }
  }

  // ── Phase 2: Remove EXCLUDE clauses ──
  {
    const excludeIdx = findKeyword(working, 'EXCLUDE');
    if (excludeIdx !== -1) {
      let result = '';
      let i = 0;
      let removed = false;
      while (i < working.length) {
        const skipped = skipSqlLiteral(working, i);
        if (skipped !== -1) {
          result += working.slice(i, skipped);
          i = skipped;
          continue;
        }
        if (isIdentChar(working[i]) && (i === 0 || !isIdentChar(working[i - 1])) && startsKeyword(working, i, 'EXCLUDE')) {
          // Parse the EXCLUDE clause: EXCLUDE (CURRENT ROW | GROUP | TIES | NO OTHERS).
          let j = i + 'EXCLUDE'.length;
          while (j < working.length && /\s/.test(working[j])) j++;
          const clauseLen = matchExcludeClauseLen(working, j);
          if (clauseLen > 0) {
            // Strip the clause plus its preceding whitespace run.
            let start = i;
            while (start > 0 && /\s/.test(working[start - 1])) start--;
            result = result.slice(0, result.length - (i - start)) + '';
            i = j + clauseLen;
            removed = true;
            continue;
          }
        }
        result += working[i];
        i++;
      }
      // Collapse any double spaces left by removal.
      const cleaned = result.replace(/\s{2,}/g, ' ').trim();
      if (removed && cleaned !== sql.trim()) {
        rewritten = true;
        logger.debug({ sql: sql.trim(), rewritten: cleaned }, 'EXCLUDE clause stripped');
      }
      working = cleaned;
    }
  }

  return {
    sql: working,
    rewritten,
  };
}

/**
 * Return the length of an `EXCLUDE …` window clause starting at index `j`
 * (which points just past `EXCLUDE` and any whitespace), or `0` if the token
 * there is not a recognized exclusion option.
 */
function matchExcludeClauseLen(sql: string, j: number): number {
  if (startsKeyword(sql, j, 'CURRENT')) {
    // EXCLUDE CURRENT ROW
    let k = j + 'CURRENT'.length;
    while (k < sql.length && /\s/.test(sql[k])) k++;
    if (startsKeyword(sql, k, 'ROW')) {
      return k + 'ROW'.length - (j - 0);
    }
    return 0;
  }
  if (startsKeyword(sql, j, 'GROUP')) {
    return 'GROUP'.length;
  }
  if (startsKeyword(sql, j, 'TIES')) {
    return 'TIES'.length;
  }
  if (startsKeyword(sql, j, 'NO')) {
    // EXCLUDE NO OTHERS — also not SQLite-compatible, strip it.
    let k = j + 'NO'.length;
    while (k < sql.length && /\s/.test(sql[k])) k++;
    if (startsKeyword(sql, k, 'OTHERS')) {
      return k + 'OTHERS'.length - j;
    }
    return 0;
  }
  return 0;
}

// ══════════════════════════════════════════════════════════════
//  DENSE_RANK() simulation (Gap 9)
// ══════════════════════════════════════════════════════════════

/**
 * Detect DENSE_RANK() followed by an OVER clause, outside of literals/comments.
 */
export function detectDenseRank(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  return findDenseRankCall(sql) !== null;
}

/**
 * Locate the first `DENSE_RANK()` call (the function name, outside literals and
 * comments). Returns the index of the `DENSE_RANK` token or `null`.
 */
function findDenseRankCall(sql: string): number | null {
  let i = 0;
  while (i < sql.length) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    if (isIdentChar(sql[i]) && (i === 0 || !isIdentChar(sql[i - 1])) && startsKeyword(sql, i, 'DENSE_RANK')) {
      // Require an opening parenthesis after optional whitespace.
      let j = i + 'DENSE_RANK'.length;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      if (j < sql.length && sql[j] === '(') return i;
    }
    i++;
  }
  return null;
}

/**
 * Rewrite DENSE_RANK() to an equivalent SQLite expression.
 *
 * Simple cases (single ORDER BY column):
 *   DENSE_RANK() OVER (ORDER BY col)
 *   → (SELECT COUNT(DISTINCT t2.col) FROM t AS t2 WHERE t2.col <= t.col)
 *
 * Complex cases (PARTITION BY, multiple ORDER BY columns) → ROW_NUMBER() fallback
 */
export function rewriteDenseRank(sql: string): WindowFuncResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }
  if (!detectDenseRank(sql)) {
    return { sql, rewritten: false };
  }

  let working = sql;
  let rewritten = false;

  // Extract the OVER clause to find table/column references (simple single-column case).
  const overMatch = /DENSE_RANK\s*\(\s*\)\s*OVER\s*\(\s*ORDER\s+BY\s+(\w+(?:\s+ASC|\s+DESC)?)\s*\)/i.exec(working);
  if (!overMatch) {
    // Fallback: convert only the literal-aware DENSE_RANK token to ROW_NUMBER.
    working = replaceFirstDenseRank(working, 'ROW_NUMBER()');
    rewritten = true;
    return { sql: working, rewritten };
  }

  // Simple case: DENSE_RANK() OVER (ORDER BY col)
  const orderCol = overMatch[1].replace(/\s+(ASC|DESC)$/i, '').trim();
  const isDesc = /\s+DESC\s*$/i.test(overMatch[1]);

  // Find the table reference in the FROM clause
  const fromMatch = /FROM\s+(\w+)/i.exec(working);
  if (!fromMatch) {
    working = replaceFirstDenseRank(working, 'ROW_NUMBER()');
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

/**
 * Replace the first literal-aware `DENSE_RANK()` token with `replacement`.
 */
function replaceFirstDenseRank(sql: string, replacement: string): string {
  const idx = findDenseRankCall(sql);
  if (idx === null) return sql;
  // Find the end of the empty argument list: `DENSE_RANK ( )`.
  let j = idx + 'DENSE_RANK'.length;
  while (j < sql.length && /\s/.test(sql[j])) j++;
  if (j >= sql.length || sql[j] !== '(') return sql;
  let p = j + 1;
  while (p < sql.length && /\s/.test(sql[p])) p++;
  if (p >= sql.length || sql[p] !== ')') return sql;
  return sql.slice(0, idx) + replacement + sql.slice(p + 1);
}
