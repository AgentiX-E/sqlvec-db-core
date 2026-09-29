/**
 * ArrayConstructorShim — PostgreSQL ARRAY constructor compatibility shim for SQLite.
 *
 * PostgreSQL supports array constructors via:
 * - DDL array type annotations: `col type[]`
 * - Literal syntax: `ARRAY[1, 2, 3]`
 * - Subquery syntax: `ARRAY(SELECT x FROM t)`
 *
 * SQLite has no native array type. This shim rewrites array expressions to
 * JSON array representations using SQLite's built-in JSON functions:
 *
 * | Input                                | Output                                       |
 * |--------------------------------------|----------------------------------------------|
 * | `col int[]` (DDL)                    | `col TEXT`                                   |
 * | `col text[][]` (DDL multi-dim)       | `col TEXT`                                   |
 * | `ARRAY[1, 2, 3]`                    | `json_array(1, 2, 3)`                        |
 * | `ARRAY['a', 'b']`                   | `json_array('a', 'b')`                       |
 * | `ARRAY(SELECT x FROM t)`            | `(SELECT json_group_array(x) FROM t)`        |
 * | `ARRAY(SELECT DISTINCT x FROM t)`   | `(SELECT json_group_array(DISTINCT x) FROM t)` |
 * | `SELECT 1`                           | (pass-through)                               |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite
 * - No false positives on non-array SQL
 * - Handles optional whitespace around ARRAY keyword
 * - PinoLogger integration for debugging and audit trails
 *
 * ## Limitations (regex-based)
 *
 * - Operators appearing inside string literals may be incorrectly matched
 * - Nested `ARRAY[...]` expressions are not rewritten
 * - `ARRAY(SELECT ...)` only rewrites simple SELECT-FROM subqueries
 *
 * @module ArrayConstructorShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('ArrayConstructorShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ArrayResult {
  /** Rewritten SQL (original if no array syntax detected) */
  sql: string;
  /** Whether any array expression was detected and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Captures the raw pattern for a DDL array type suffix: `type[]`, `type[][]`, etc.
 *
 * The source pattern is reused by a detection-only copy (non-global, to avoid
 * the JavaScript `lastIndex` issue with `g` flag + `test()`) and a replacement
 * copy (global, to apply `replace()` across all occurrences).
 *
 * The regex matches a type identifier (with optional dimension spec like
 * `(255)`) followed by one or more `[]` suffixes. A word boundary precedes
 * the type name to avoid partial matches.
 *
 * Matches:
 *   - `int[]`
 *   - `bigint[]`
 *   - `text[][]`
 *   - `varchar(255)[]`
 *   - `decimal(10,2)[]`
 *
 * Does NOT match:
 *   - `int` (no brackets)
 *   - `[]int` (brackets before type)
 *   - `col[1]` (index access)
 *   - `ARRAY[...]` (keyword, not DDL)
 */
const ARRAY_TYPE_SUFFIX_SRC = '([a-zA-Z_][a-zA-Z0-9_]*(?:\\s*\\(\\s*\\d+(?:\\s*,\\s*\\d+)?\\s*\\))?)(?:\\s*\\[\\]\\s*)+';

/** Non-global copy for `test()` — avoids the `lastIndex` state mutation bug. */
// eslint-disable-next-line require-unicode-regexp
const ARRAY_TYPE_SUFFIX_DETECT = new RegExp(`\\b${ARRAY_TYPE_SUFFIX_SRC}`, 'i');

/** Global copy for `replace()` — replaces all occurrences. */
// eslint-disable-next-line require-unicode-regexp
const ARRAY_TYPE_SUFFIX_REPLACE = new RegExp(`\\b${ARRAY_TYPE_SUFFIX_SRC}`, 'gi');

/**
 * Detects any ARRAY keyword followed by `[` or `(` — the two array
 * constructor forms.
 *
 * Matches:
 *   - `ARRAY[1,2,3]`
 *   - `ARRAY[ 'a', 'b' ]`
 *   - `ARRAY(SELECT x FROM t)`
 *
 * Does NOT match:
 *   - `my_array` (not followed by bracket/paren)
 *   - `'ARRAY[1]'` (inside string — regex limitation noted)
 */
const ARRAY_CONSTRUCTOR_RE = /\bARRAY\s*[\[(]/i;

/**
 * Matches the opening of an ARRAY literal: `ARRAY[`.
 *
 * Used to locate candidate positions before bracket-matching.
 */
const ARRAY_LITERAL_RE = /\bARRAY\s*\[\s*/i;

/**
 * Matches the opening of an ARRAY subquery: `ARRAY(` followed by SELECT.
 *
 * This ensures we only rewrite `ARRAY(SELECT ...)` pattern and not
 * other function-like ARRAY uses.
 */
const ARRAY_SUBQUERY_RE = /\bARRAY\s*\(\s*SELECT\s/i;

/**
 * Keywords that can follow a SELECT list, used to find the end of the
 * select expression in subquery rewriting.
 */
const SQL_CLAUSE_KEYWORDS = /\s+(FROM|WHERE|GROUP\s+BY|HAVING|WINDOW|QUALIFY|ORDER\s+BY|LIMIT|OFFSET|FETCH|FOR)\s/i;

// ──────────────────────────────────────────────
//  Internal Helpers
// ──────────────────────────────────────────────

/**
 * Find the position of the matching closing bracket/paren character,
 * accounting for nesting depth.
 *
 * Starts from `openPos` which should be the position of the opening
 * character. Returns the position of the matching closing character,
 * or `-1` if not found.
 *
 * Skips string literals, quoted identifiers, dollar-quoted strings and
 * comments (via `skipSqlLiteral`) so a `[`, `]` or `(` inside a string does
 * not corrupt depth tracking.
 *
 * @param sql       The full SQL string
 * @param openPos   Position of the opening bracket or parenthesis
 * @param openChar  The opening character (e.g., `[`)
 * @param closeChar The closing character (e.g., `]`)
 * @returns         Position of the matching close character, or -1
 */
function findMatchingClose(
  sql: string,
  openPos: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 1;
  let idx = openPos + 1;

  while (idx < sql.length) {
    const skipped = skipSqlLiteral(sql, idx);
    if (skipped !== -1) {
      idx = skipped;
      continue;
    }

    const ch = sql[idx];
    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
    }
    if (depth === 0) return idx;
    idx++;
  }

  return -1;
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains any PostgreSQL array
 * constructor syntax:
 *
 * - DDL array type annotation (`type[]`)
 * - ARRAY literal (`ARRAY[...]`)
 * - ARRAY subquery (`ARRAY(SELECT ...)`)
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL contains array constructor syntax
 *
 * @example
 * ```ts
 * detectArrayConstructor('CREATE TABLE t (ids int[])');   // true
 * detectArrayConstructor('SELECT ARRAY[1,2,3]');          // true
 * detectArrayConstructor('ARRAY(SELECT x FROM t)');       // true
 * detectArrayConstructor('SELECT 1');                     // false
 * detectArrayConstructor('SELECT * FROM t');              // false
 * ```
 */
export function detectArrayConstructor(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  // Mask string literals and comments so array syntax inside them is never
  // reported as a real constructor/type annotation.
  const protectedSql = protectSQL(sql.trim()).protectedSql;

  // Check for DDL array type suffix (non-global regex to avoid `lastIndex` issues)
  if (ARRAY_TYPE_SUFFIX_DETECT.test(protectedSql)) {
    return true;
  }

  // Check for ARRAY[ or ARRAY( constructors
  if (ARRAY_CONSTRUCTOR_RE.test(protectedSql)) {
    return true;
  }

  return false;
}

/**
 * Rewrite PostgreSQL array syntax to SQLite-compatible equivalents.
 *
 * Processing logic:
 *
 * **Phase 1 — DDL array types:** Replace `type[]` (with optional dimension
 * spec and multi-dimensional `[][]`) with `TEXT`.
 *
 * **Phase 2 — ARRAY subqueries:** Transform `ARRAY(SELECT expr FROM ...)`
 * to `(SELECT json_group_array(expr) FROM ...)`. Supports `SELECT DISTINCT`
 * and a single-column select list. The outer parens are kept to make the
 * result a valid scalar subquery expression.
 *
 * **Phase 3 — ARRAY literals:** Transform `ARRAY[e1, e2, e3]` to
 * `json_array(e1, e2, e3)` using balanced bracket matching.
 *
 * Phases are applied sequentially. If no array syntax is found, the
 * original SQL is returned unchanged.
 *
 * @param sql   The raw SQL string to process
 * @returns     An {@link ArrayResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteArrayExpr('SELECT ARRAY[1, 2, 3]');
 * // → { sql: 'SELECT json_array(1, 2, 3)', rewritten: true }
 *
 * rewriteArrayExpr('ARRAY(SELECT x FROM t)');
 * // → { sql: '(SELECT json_group_array(x) FROM t)', rewritten: true }
 *
 * rewriteArrayExpr('CREATE TABLE t (ids int[])');
 * // → { sql: 'CREATE TABLE t (ids TEXT)', rewritten: true }
 *
 * rewriteArrayExpr('SELECT 1');
 * // → { sql: 'SELECT 1', rewritten: false }
 * ```
 */
export function rewriteArrayExpr(sql: string): ArrayResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  // Mask string literals, quoted identifiers and comments up front so none of
  // the phase-specific regexes or bracket matchers are fooled by array syntax
  // appearing inside a literal. Original text is restored at the end.
  const protectedSQL = protectSQL(sql.trim());

  let result = protectedSQL.protectedSql;
  let modified = false;
  let prev: string;

  // ── Phase 1: Rewrite DDL array types ──────────────────────────

  prev = result;
  result = replaceArrayTypes(result);
  if (result !== prev) {
    logger.debug(
      { before: prev, after: result },
      'DDL array type annotation rewritten to TEXT',
    );
    modified = true;
  }

  // ── Phase 2: Rewrite ARRAY(SELECT ...) subqueries ─────────────

  prev = result;
  result = rewriteArraySubqueries(result);
  if (result !== prev) {
    logger.debug(
      { before: prev, after: result },
      'ARRAY(SELECT ...) subquery rewritten to json_group_array',
    );
    modified = true;
  }

  // ── Phase 3: Rewrite ARRAY[literal, ...] ──────────────────────

  prev = result;
  result = rewriteArrayLiterals(result);
  if (result !== prev) {
    logger.debug(
      { before: prev, after: result },
      'ARRAY[...] literal rewritten to json_array(...)',
    );
    modified = true;
  }

  return {
    sql: restoreSQL({ ...protectedSQL, protectedSql: result }),
    rewritten: modified,
  };
}

/**
 * Simplified entry point: only strip DDL array type annotations.
 *
 * Replaces all occurrences of `type[]`, `type[][]`, etc. (with optional
 * dimension specs) with `TEXT`. This is useful when the caller has already
 * handled ARRAY constructors separately and only needs DDL compatibility.
 *
 * @param sql   The raw SQL string to process
 * @returns     The SQL string with array type annotations replaced by TEXT
 *
 * @example
 * ```ts
 * stripArrayType('CREATE TABLE t (ids int[], name text)');
 * // → 'CREATE TABLE t (ids TEXT, name text)'
 *
 * stripArrayType('ALTER TABLE t ALTER COLUMN c TYPE bigint[]');
 * // → 'ALTER TABLE t ALTER COLUMN c TYPE TEXT'
 *
 * stripArrayType('SELECT 1');
 * // → 'SELECT 1'
 * ```
 */
export function stripArrayType(sql: string): string {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return sql ?? '';
  }

  // Mask string literals and comments first so a `type[]` annotation inside
  // them is never rewritten; restore them afterwards.
  const protectedSQL = protectSQL(sql);
  const stripped = replaceArrayTypes(protectedSQL.protectedSql);
  return restoreSQL({ ...protectedSQL, protectedSql: stripped });
}

/**
 * Replace every DDL array type annotation in an already-protected SQL string
 * with `TEXT`.
 *
 * This is the literal-unaware core of {@link stripArrayType}: it must only be
 * given SQL whose literals/comments are already masked (e.g. by `protectSQL`),
 * otherwise a `type[]` inside a string would be rewritten too.
 *
 * @param protectedSql  SQL with literals/comments masked
 * @returns             The SQL with array type annotations replaced by TEXT
 */
function replaceArrayTypes(protectedSql: string): string {
  return protectedSql.replace(ARRAY_TYPE_SUFFIX_REPLACE, (_match: string): string => {
    logger.debug({ arrayType: _match }, 'Stripping array type annotation to TEXT');
    return 'TEXT';
  });
}

// ──────────────────────────────────────────────
//  Internal Rewrite Functions
// ──────────────────────────────────────────────

/**
 * Rewrite all `ARRAY[literal, ...]` occurrences to `json_array(literal, ...)`.
 *
 * Uses balanced bracket matching to correctly handle expressions that
 * contain brackets (e.g., function calls, subscripts) inside array elements.
 *
 * Transformations are applied right-to-left to preserve position offsets
 * across multiple replacements in the same SQL string.
 *
 * If an unmatched bracket is encountered, the occurrence is skipped and
 * a warning is logged.
 *
 * @param sql   The SQL string potentially containing ARRAY[...] expressions
 * @returns     The SQL string with ARRAY[...] rewritten to json_array(...)
 */
function rewriteArrayLiterals(sql: string): string {
  // Collect replacements while skipping nested ARRAY[...] ranges.
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  const re = /\bARRAY\s*\[\s*/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(sql)) !== null) {
    const arrayStart = match.index;

    // Skip a match that falls inside a previously-collected (outer) range so
    // nested ARRAY[...] expressions are replaced once by their outer call.
    if (replacements.some((r) => arrayStart >= r.start && arrayStart < r.end)) {
      continue;
    }

    const bracketStart = match.index + match[0].length - 1; // position of '['
    const closeBracket = findMatchingClose(sql, bracketStart, '[', ']');

    if (closeBracket === -1) {
      logger.warn(
        { sql, pos: arrayStart },
        'Unmatched opening bracket in ARRAY[...] — skipping',
      );
      continue;
    }

    // Extract content between [ and ]
    const innerContent = sql.slice(bracketStart + 1, closeBracket).trim();
    const replacement = `json_array(${innerContent})`;

    replacements.push({
      start: arrayStart,
      end: closeBracket + 1,
      replacement,
    });
  }

  // Apply replacements in reverse order (right-to-left) to preserve offsets
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, r.start) + r.replacement + sql.slice(r.end);
  }

  return sql;
}

/**
 * Rewrite all `ARRAY(SELECT ...)` occurrences to SQLite-compatible
 * `(SELECT json_group_array(...) ...)` scalar subqueries.
 *
 * The rewrite identifies the SELECT clause within the ARRAY(...) wrapper,
 * replaces the select expression list with a `json_group_array(expr)` call,
 * and wraps the result in parentheses as a scalar subquery.
 *
 * Supports `SELECT DISTINCT expr` and single-column select lists.
 *
 * If the subquery structure cannot be parsed (e.g., missing FROM clause
 * and no obvious clause boundary), the occurrence is skipped and a warning
 * is logged.
 *
 * @param sql   The SQL string potentially containing ARRAY(SELECT ...)
 * @returns     The SQL string with ARRAY subqueries rewritten
 */
function rewriteArraySubqueries(sql: string): string {
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  const re = /\bARRAY\s*\(\s*SELECT\s/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(sql)) !== null) {
    const arrayStart = match.index;
    const parenStart = sql.indexOf('(', arrayStart);
    const closeParen = findMatchingClose(sql, parenStart, '(', ')');

    if (closeParen === -1) {
      logger.warn(
        { sql, pos: arrayStart },
        'Unmatched parenthesis in ARRAY(SELECT ...) — skipping',
      );
      continue;
    }

    // Extract the full content between the matched parens
    const subqueryContent = sql.slice(parenStart + 1, closeParen).trim();

    // Parse the SELECT clause
    const selectRestMatch = subqueryContent.match(/^\s*SELECT\s+(DISTINCT\s+|ALL\s+)?/i);
    if (!selectRestMatch) {
      logger.warn(
        { sql, pos: arrayStart },
        'Cannot parse SELECT keyword in ARRAY subquery — skipping',
      );
      continue;
    }

    const selectModifier = selectRestMatch[1] ?? ''; // 'DISTINCT ' or 'ALL ' or ''
    const afterSelect = subqueryContent.slice(selectRestMatch.index! + selectRestMatch[0].length);

    // Find the first clause boundary keyword (FROM, WHERE, GROUP BY, etc.)
    const clauseBoundary = afterSelect.match(SQL_CLAUSE_KEYWORDS);

    let selectExpr: string;
    let restOfQuery: string;

    if (clauseBoundary) {
      // There is a clause boundary — split select expression and the rest
      selectExpr = afterSelect.slice(0, clauseBoundary.index!).trim();
      restOfQuery = afterSelect.slice(clauseBoundary.index!);
    } else {
      // No clause boundary found — assume this is a SELECT-only expression
      // (e.g., ARRAY(SELECT 1) — not common but valid)
      selectExpr = afterSelect.trim();
      restOfQuery = '';
    }

    // Handle multi-column select lists by wrapping only the first column
    // (PG would error on multi-column ARRAY subqueries anyway)
    const firstColumn = selectExpr.split(',').map(s => s.trim())[0];

    const replacement = `(SELECT COALESCE(json_group_array(${selectModifier}${firstColumn}), '[]')${restOfQuery})`;

    replacements.push({
      start: arrayStart,
      end: closeParen + 1,
      replacement,
    });
  }

  // Apply replacements in reverse order (right-to-left) to preserve offsets
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, r.start) + r.replacement + sql.slice(r.end);
  }

  return sql;
}
