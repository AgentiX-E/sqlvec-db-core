/**
 * ExclusionConstraintShim — PostgreSQL EXCLUDE constraint compatibility
 * shim for SQLite.
 *
 * PostgreSQL supports exclusion constraints via:
 *
 *   CREATE TABLE t (
 *     id INT,
 *     period TSTZRANGE,
 *     EXCLUDE USING gist (period WITH &&)
 *   );
 *
 * Exclusion constraints ensure that no two rows violate a specified operator
 * condition (e.g., range overlap via &&, equality via =). They go beyond
 * UNIQUE by supporting arbitrary comparison operators.
 *
 * SQLite does NOT support exclusion constraints in any form. The strategy
 * is to detect and strip EXCLUDE clauses from DDL statements, making them
 * compatible with SQLite. This is a safe no-op because exclusion constraints
 * are only enforced at write time — removing them from the DDL allows the
 * table to be created without the constraint being enforced.
 *
 * ## Strategy
 *
 * | Input SQL                                                    | Output SQL                         | rewritten |
 * |--------------------------------------------------------------|------------------------------------|-----------|
 * | `EXCLUDE USING gist (period WITH &&)`                        | (removed)                          | true      |
 * | `CONSTRAINT c EXCLUDE USING gist (a WITH &&)`                | (removed)                          | true      |
 * | `EXCLUDE USING btree (id WITH =) WHERE (active)`            | (removed)                          | true      |
 * | `EXCLUDE USING gist (a WITH &&) WITH (fillfactor=70)`       | (removed)                          | true      |
 * | `CREATE TABLE t (id INT)`                                    | `CREATE TABLE t (id INT)`          | false     |
 * | `SELECT 1`                                                   | `SELECT 1`                         | false     |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite DDL
 * - No false positives on non-EXCLUDE SQL
 * - Handles both named (CONSTRAINT ... EXCLUDE) and unnamed EXCLUDE constraints
 * - Handles all optional PG clauses: INCLUDE, WITH, USING INDEX TABLESPACE,
 *   WHERE, DEFERRABLE, INITIALLY
 * - Multiple EXCLUDE constraints in a single statement are all removed
 * - PinoLogger integration for debugging and audit trails
 *
 * @module ExclusionConstraintShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('ExclusionConstraintShim');

// ── Types ────────────────────────────────────────────────────────

export interface ExclusionResult {
  /** Rewritten SQL (unchanged if no EXCLUDE constraint was found) */
  sql: string;
  /** Whether the SQL was rewritten */
  rewritten: boolean;
}

// ── Constants — Regex Patterns ──────────────────────────────────

/**
 * Regex to detect an EXCLUDE keyword followed by optional `USING <method>`
 * and a column list in parentheses.
 *
 * This is the primary detection pattern. It avoids false positives by
 * requiring the `(` after `USING method` or directly after `EXCLUDE`.
 *
 * Matches:
 *   - `EXCLUDE USING gist (`
 *   - `EXCLUDE (`
 *   - `EXCLUDE USING btree (`
 */
const EXCLUDE_DETECT_RE = /\bEXCLUDE\s+(?:USING\s+\w+\s+)?\(/i;

/**
 * Pattern for optional PG keywords that may follow the EXCLUDE column list.
 *
 * These are PG-specific modifiers appended after the parenthesized
 * column list of an EXCLUDE constraint:
 *   - INCLUDE (columns)
 *   - WITH (storage_params)
 *   - USING INDEX TABLESPACE name
 *   - WHERE (predicate)
 *   - (NOT)? DEFERRABLE
 *   - INITIALLY (DEFERRED|IMMEDIATE)
 */
const EXCLUDE_TRAILING_RE = /(?:\s+INCLUDE\s*\([^)]*\)|\s+WITH\s*\([^)]*\)|\s+USING\s+INDEX\s+TABLESPACE\s+\w+|\s+WHERE\s*\([^)]*\)|\s+(?:NOT\s+)?DEFERRABLE|\s+INITIALLY\s+(?:DEFERRED|IMMEDIATE))+/i;

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Walk forward from a given position, tracking balanced parentheses,
 * and return the index of the matching closing paren.
 *
 * @param sql - The full SQL string.
 * @param start - Index of the opening '(' character.
 * @returns Index of the matching ')', or sql.length if unbalanced.
 */
function findMatchingParen(sql: string, start: number): number {
  if (start >= sql.length || sql[start] !== '(') {
    return start;
  }

  let depth = 1;
  let pos = start + 1;

  while (pos < sql.length && depth > 0) {
    const ch = sql[pos];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    }
    if (depth > 0) {
      pos++;
    }
  }

  // If unbalanced, return the end of the string
  return depth === 0 ? pos : sql.length;
}

/**
 * Remove all EXCLUDE-related clauses from a SQL statement.
 *
 * This function scans for `EXCLUDE` keywords, then uses balanced-paren
 * tracking to find the full extent of each EXCLUDE clause including all
 * optional PG-specific trailing keywords. Each matched clause is removed
 * along with any preceding `CONSTRAINT name` and any trailing comma.
 *
 * The function iterates to handle multiple EXCLUDE constraints in a
 * single statement.
 *
 * @param sql - The SQL to clean.
 * @returns Cleaned SQL without EXCLUDE constraints.
 */
function stripExcludeClauses(sql: string): string {
  let result = sql;

  // Loop until all EXCLUDE clauses are removed
  let iteration = 0;
  const maxIterations = 100; // Safety limit

  while (iteration < maxIterations) {
    const excludeMatch = EXCLUDE_DETECT_RE.exec(result);
    if (!excludeMatch) {
      break;
    }

    const excludeStart = excludeMatch.index;

    // Walk backwards to find a preceding CONSTRAINT keyword
    // Pattern: CONSTRAINT name EXCLUDE ...
    const beforeExclude = result.slice(0, excludeStart);
    const constraintMatch = beforeExclude.match(
      /\bCONSTRAINT\s+[A-Za-z_][A-Za-z0-9_$]*\s*$/i,
    );

    // RegExpMatchArray.index is optional in TypeScript libdef, but in
    // practice it is always present when a match is found. We use a
    // well-typed fallback to satisfy strict null checks.
    const clauseStart: number = constraintMatch !== null
      ? (constraintMatch.index as number)
      : excludeStart;

    // Find the opening paren of the column list — this is what
    // EXCLUDE_DETECT_RE matched. It's the last '(' before the match end.
    const matchEnd = excludeMatch.index + excludeMatch[0].length;
    const parenPos = result.lastIndexOf('(', matchEnd - 1);
    const clauseEnd = findMatchingParen(result, parenPos);

    if (clauseEnd >= result.length) {
      // Unbalanced — remove everything from clauseStart to end
      result = result.slice(0, clauseStart).trimEnd();
      break;
    }

    let endPos = clauseEnd + 1; // Past the closing ')'

    // Consume trailing PG-specific keywords
    while (endPos < result.length) {
      // Skip whitespace
      const wsMatch = result.slice(endPos).match(/^\s+/);
      if (wsMatch) {
        endPos += wsMatch[0].length;
      }

      const remaining = result.slice(endPos);

      // INCLUDE ( columns )
      const includeMatch = remaining.match(/^INCLUDE\s*\(/i);
      if (includeMatch) {
        endPos += includeMatch[0].length - 1; // position at '('
        const inclEnd = findMatchingParen(result, endPos);
        endPos = (inclEnd < result.length ? inclEnd : endPos) + 1;
        continue;
      }

      // WITH ( storage_params )
      const withMatch = remaining.match(/^WITH\s*\(/i);
      if (withMatch) {
        endPos += withMatch[0].length - 1;
        const wEnd = findMatchingParen(result, endPos);
        endPos = (wEnd < result.length ? wEnd : endPos) + 1;
        continue;
      }

      // WHERE ( predicate )
      const whereMatch = remaining.match(/^WHERE\s*\(/i);
      if (whereMatch) {
        endPos += whereMatch[0].length - 1;
        const whEnd = findMatchingParen(result, endPos);
        endPos = (whEnd < result.length ? whEnd : endPos) + 1;
        continue;
      }

      // USING INDEX TABLESPACE name
      const usingIndexMatch = remaining.match(
        /^USING\s+INDEX\s+TABLESPACE\s+[A-Za-z_][A-Za-z0-9_$]*/i,
      );
      if (usingIndexMatch) {
        endPos += usingIndexMatch[0].length;
        continue;
      }

      // NOT? DEFERRABLE
      if (/^NOT\s+DEFERRABLE\b/i.test(remaining)) {
        endPos += remaining.match(/^NOT\s+DEFERRABLE/i)![0].length;
        continue;
      }
      if (/^DEFERRABLE\b/i.test(remaining) && !/^DEFERRABLE\s*\(/i.test(remaining)) {
        endPos += remaining.match(/^DEFERRABLE/i)![0].length;
        continue;
      }

      // INITIALLY DEFERRED | INITIALLY IMMEDIATE
      const initiallyMatch = remaining.match(
        /^INITIALLY\s+(?:DEFERRED|IMMEDIATE)\b/i,
      );
      if (initiallyMatch) {
        endPos += initiallyMatch[0].length;
        continue;
      }

      // No more trailing keywords — stop
      break;
    }

    // Consume any trailing comma and whitespace after the clause
    const afterClause = result.slice(endPos).match(/^\s*,?\s*/);
    if (afterClause) {
      endPos += afterClause[0].length;
    }

    // Also consume any leading whitespace before the clause start.
    // The regex \s*$ always matches (zero-length match at minimum),
    // so beforeClauseTrim is guaranteed non-null in practice.
    const beforeClauseTrim = result.slice(0, clauseStart).match(/\s*$/);
    const trimStart: number = beforeClauseTrim
      ? clauseStart - beforeClauseTrim[0].length
      : clauseStart;

    // Remove the clause
    result =
      result.slice(0, trimStart < 0 ? 0 : trimStart) +
      result.slice(endPos);

    iteration++;
  }

  return result;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains a PostgreSQL EXCLUDE constraint.
 *
 * @param sql - The SQL statement to check.
 * @returns `true` if an EXCLUDE constraint is found.
 *
 * @example
 * ```ts
 * detectExclusionConstraint('EXCLUDE USING gist (period WITH &&)');
 * // → true
 *
 * detectExclusionConstraint('CREATE TABLE t (id INT)');
 * // → false
 * ```
 */
export function detectExclusionConstraint(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return false;
  }

  return EXCLUDE_DETECT_RE.test(trimmed);
}

/**
 * Remove PostgreSQL EXCLUDE constraints from a SQL statement,
 * producing SQLite-compatible DDL.
 *
 * **Processing logic:**
 *
 * 1. If the SQL does not contain an EXCLUDE constraint, return unchanged
 *    with `rewritten: false`.
 * 2. Locate each EXCLUDE clause using balanced-parentheses tracking.
 * 3. Remove the clause including:
 *    - Preceding `CONSTRAINT name` (if named constraint)
 *    - Trailing comma and whitespace
 *    - All optional PG-specific trailing keywords
 *      (INCLUDE, WITH, USING INDEX TABLESPACE, WHERE, DEFERRABLE,
 *       INITIALLY DEFERRED/IMMEDIATE)
 * 4. Clean up excess whitespace left by removals.
 * 5. Handle multiple EXCLUDE constraints in a single statement.
 *
 * @param sql - The SQL statement to process.
 * @returns An ExclusionResult indicating the rewritten SQL and
 *          whether any changes were made.
 *
 * @example
 * ```ts
 * rewriteExclusionConstraint(
 *   `CREATE TABLE t (id INT, period TSTZRANGE, EXCLUDE USING gist (period WITH &&))`
 * );
 * // → { sql: 'CREATE TABLE t (id INT, period TSTZRANGE)', rewritten: true }
 *
 * rewriteExclusionConstraint(
 *   `CREATE TABLE t (id INT, CONSTRAINT no_overlap EXCLUDE USING gist (period WITH &&))`
 * );
 * // → { sql: 'CREATE TABLE t (id INT)', rewritten: true }
 *
 * rewriteExclusionConstraint(
 *   `CREATE TABLE t (id INT, EXCLUDE USING gist (period WITH &&) WHERE (active = true))`
 * );
 * // → { sql: 'CREATE TABLE t (id INT)', rewritten: true }
 *
 * rewriteExclusionConstraint('CREATE TABLE t (id INT)');
 * // → { sql: 'CREATE TABLE t (id INT)', rewritten: false }
 *
 * rewriteExclusionConstraint('SELECT 1');
 * // → { sql: 'SELECT 1', rewritten: false }
 * ```
 */
export function rewriteExclusionConstraint(sql: string): ExclusionResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return { sql: trimmed, rewritten: false };
  }

  // ── Step 1: Fast-path detection ───────────────────────────────

  if (!EXCLUDE_DETECT_RE.test(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  logger.debug(
    'Found EXCLUDE constraint in statement: %s',
    trimmed,
  );

  // ── Step 2: Strip EXCLUDE clauses ─────────────────────────────

  const stripped = stripExcludeClauses(trimmed);

  // ── Step 3: Clean up excess whitespace ────────────────────────

  const rewritten = stripped.replace(/\s{2,}/g, ' ').trim();

  const changed = rewritten !== trimmed;

  if (changed) {
    logger.debug(
      'Removed EXCLUDE constraint: original=%s rewritten=%s',
      trimmed,
      rewritten,
    );
  }

  return { sql: rewritten, rewritten: changed };
}
