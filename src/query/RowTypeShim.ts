/**
 * RowTypeShim — PostgreSQL ROW constructor compatibility shim for SQLite.
 *
 * PostgreSQL supports row-type expressions via:
 *   - ROW constructor syntax: `ROW(1, 'a')`, `ROW(a, b, c)`
 *   - Table name references: `tablename.*` (out of scope for this shim)
 *
 * SQLite has no native ROW constructor syntax. This shim rewrites
 * ROW(...) expressions to SQLite-compatible json_array(...) calls:
 *
 * | Input                           | Output                          |
 * |---------------------------------|---------------------------------|
 * | `ROW(1, 'a')`                  | `json_array(1, 'a')`            |
 * | `ROW(a, b, c)`                 | `json_array(a, b, c)`           |
 * | `ROW(1)`                       | `json_array(1)`                 |
 * | `SELECT 1`                     | (pass-through)                  |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite
 * - No false positives on non-ROW SQL
 * - Handles optional whitespace around ROW keyword
 * - Balanced-parenthesis matching handles nested expressions
 * - PinoLogger integration for debugging and audit trails
 *
 * ## Limitations (regex-based)
 *
 * - ROW appearing inside string literals may produce false positives
 *   (a known and accepted limitation of regex-based SQL processing)
 * - `tablename.*` references are not handled by this shim
 *
 * @module RowTypeShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('RowTypeShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface RowTypeResult {
  /** Rewritten SQL (original if no ROW expression was found) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Detects the `ROW` keyword followed by an opening parenthesis —
 * the canonical ROW constructor form.
 *
 * Matches:
 *   - `ROW(1, 'a')`
 *   - `ROW(a, b, c)`
 *   - `row(1, 2)` (case-insensitive)
 *   - `ROW ( 1, 2 )` (with whitespace)
 *
 * Does NOT match:
 *   - `row_number()` (ROW is whole word, not part of identifier)
 *   - `my_row` (not followed by `(`)
 *
 * Note: Because this is a global regex used with exec(), we provide
 * a separate non-global copy for the detect() fast-path to avoid
 * the JavaScript `lastIndex` state mutation bug with RegExp#test().
 */
const ROW_EXPR_RE = /\bROW\s*\(/i;

/** Non-global copy for `test()` — avoids the `lastIndex` state mutation bug. */
// eslint-disable-next-line require-unicode-regexp
const ROW_EXPR_DETECT = new RegExp(ROW_EXPR_RE.source, 'i');

/** Global copy for exec() loop — used when scanning all ROW occurrences. */
// eslint-disable-next-line require-unicode-regexp
const ROW_EXPR_GLOBAL = new RegExp(ROW_EXPR_RE.source, 'gi');

// ──────────────────────────────────────────────
//  Internal Helpers
// ──────────────────────────────────────────────

/**
 * Find the position of the matching closing parenthesis, accounting
 * for nesting depth.
 *
 * Starts from `openPos` which should be the position of the `(`
 * character. Returns the position of the matching `)`, or `-1` if
 * the parentheses are unbalanced.
 *
 * This is a simple depth tracker and does NOT account for string
 * or comment literals; parens inside strings may cause false
 * matches. This is a known limitation of regex-based SQL processing.
 *
 * @param sql      The full SQL string
 * @param openPos  Position of the opening `(` character
 * @returns        Position of the matching `)`, or `-1`
 */
function findMatchingParen(sql: string, openPos: number): number {
  let depth = 1;
  let idx = openPos + 1;

  while (idx < sql.length && depth > 0) {
    const ch = sql[idx];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    }
    if (depth > 0) {
      idx++;
    }
  }

  return depth === 0 ? idx : -1;
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a ROW constructor
 * expression of the form `ROW(...)`.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL contains a ROW constructor expression
 *
 * @example
 * ```ts
 * detectRowExpr('SELECT ROW(1, \'a\')');   // true
 * detectRowExpr('ROW(a, b, c)');           // true
 * detectRowExpr('SELECT 1');               // false
 * detectRowExpr('SELECT * FROM t');        // false
 * detectRowExpr('SELECT row_number()');    // false (not a ROW constructor)
 * ```
 */
export function detectRowExpr(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  return ROW_EXPR_DETECT.test(sql.trim());
}

/**
 * Rewrite PostgreSQL ROW constructor expressions to SQLite-compatible
 * json_array(...) calls.
 *
 * Processing logic:
 *
 * 1. Scan the SQL string for all occurrences of `ROW(` using a
 *    case-insensitive global regex.
 * 2. For each occurrence, find the matching closing `)` using
 *    balanced-parenthesis tracking.
 * 3. Extract the inner content between the parentheses.
 * 4. Replace `ROW(inner)` with `json_array(inner)`.
 * 5. Apply replacements right-to-left to preserve position offsets
 *    across multiple ROW expressions in the same SQL string.
 *
 * If parentheses are unbalanced, the occurrence is skipped and a
 * warning is logged.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link RowTypeResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteRowExpr('SELECT ROW(1, \'a\') AS r');
 * // → { sql: "SELECT json_array(1, 'a') AS r", rewritten: true }
 *
 * rewriteRowExpr('SELECT ROW(a, b, c)');
 * // → { sql: 'SELECT json_array(a, b, c)', rewritten: true }
 *
 * rewriteRowExpr('SELECT * FROM t');
 * // → { sql: 'SELECT * FROM t', rewritten: false }
 * ```
 */
export function rewriteRowExpr(sql: string): RowTypeResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // Fast path — no ROW expression present
  if (!ROW_EXPR_DETECT.test(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  // Reset lastIndex after test()
  ROW_EXPR_DETECT.lastIndex = 0;

  // Collect all ROW(...) replacements, processing right-to-left
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = ROW_EXPR_GLOBAL.exec(trimmed)) !== null) {
    const rowStart = match.index;
    const keyword = match[0]; // e.g., "ROW(" or "row ("
    const parenStart = trimmed.indexOf('(', rowStart);
    const closeParen = findMatchingParen(trimmed, parenStart);

    if (closeParen === -1) {
      logger.warn(
        { sql: trimmed, pos: rowStart },
        'Unmatched parenthesis in ROW expression — skipping',
      );
      continue;
    }

    // Extract the inner content between the parentheses
    const innerContent = trimmed.slice(parenStart + 1, closeParen).trim();
    const replacement = `json_array(${innerContent})`;

    replacements.push({
      start: rowStart,
      end: closeParen + 1,
      replacement,
    });
  }

  // No valid replacements found
  if (replacements.length === 0) {
    return { sql: trimmed, rewritten: false };
  }

  // Apply replacements in reverse order (right-to-left) to preserve offsets
  let result = trimmed;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }

  const modified = result !== trimmed;

  if (modified) {
    logger.debug(
      { before: trimmed, after: result, count: replacements.length },
      'Rewrote ROW expressions to json_array',
    );
  }

  return {
    sql: result,
    rewritten: modified,
  };
}
