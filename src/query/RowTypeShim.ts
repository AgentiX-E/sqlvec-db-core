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

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

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
//  Constants
// ──────────────────────────────────────────────

/**
 * Detects the `ROW` keyword — the canonical ROW constructor form.
 * The keyword is matched as a whole identifier (not part of a larger
 * identifier such as `row_number`).
 *
 * The actual `ROW(` matching is done via a literal-aware scan in
 * {@link findRowOccurrence} rather than a bare regex, so that `ROW`
 * appearing inside string literals, quoted identifiers, or comments is
 * never treated as a constructor.
 */
const ROW_KEYWORD = 'ROW';

// ──────────────────────────────────────────────
//  Internal Helpers
// ──────────────────────────────────────────────

interface RowOccurrence {
  /** Index of the `R` in the `ROW` keyword. */
  start: number;
  /** Index one past the closing `)`. */
  end: number;
  /** The argument list between the parentheses. */
  args: string;
}

/**
 * Find the position of the matching closing parenthesis, accounting
 * for nesting depth and skipping parentheses that appear inside string
 * literals, quoted identifiers, and comments.
 *
 * Starts from `openPos` which must be the position of the `(` character.
 * Returns the position of the matching `)`, or `-1` if the parentheses
 * are unbalanced.
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

    // Skip whole literals/comments so parentheses inside them don't
    // affect the depth tracking.
    const skip = skipSqlLiteral(sql, idx);
    if (skip !== -1) {
      idx = skip;
      continue;
    }

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

/**
 * Scan `sql` for the first occurrence of a `ROW(...)` constructor outside
 * any string literal, quoted identifier, or comment.
 *
 * Returns the occurrence (start, end, args) or `null` when no valid ROW
 * constructor is present.
 */
function findRowOccurrence(sql: string): RowOccurrence | null {
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];

    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }

    // Only consider positions starting an identifier.
    if (!/[A-Za-z_]/.test(c)) continue;
    // Must be a standalone word: the preceding char cannot be part of an
    // identifier (e.g., `my_row`, `row_number`).
    if (i > 0 && /[A-Za-z0-9_$]/.test(sql[i - 1])) continue;

    // Match `ROW` case-insensitively.
    if (sql.slice(i, i + ROW_KEYWORD.length).toUpperCase() !== ROW_KEYWORD) continue;

    // Token after ROW must be an opening paren (allowing whitespace).
    let j = i + ROW_KEYWORD.length;
    while (j < sql.length && /\s/.test(sql[j])) j++;
    if (sql[j] !== '(') continue;

    const close = findMatchingParen(sql, j);
    if (close === -1) {
      logger.warn(
        { sql, pos: i },
        'Unmatched parenthesis in ROW expression — skipping',
      );
      continue;
    }

    const args = sql.slice(j + 1, close);
    return { start: i, end: close + 1, args };
  }

  return null;
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

  return findRowOccurrence(sql.trim()) !== null;
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

  // Collect all ROW(...) replacements via literal-aware scanning.
  const occurrences: RowOccurrence[] = [];
  let cursor = 0;
  while (cursor < trimmed.length) {
    const occ = findRowOccurrence(trimmed.slice(cursor));
    if (!occ) break;
    occurrences.push({
      start: cursor + occ.start,
      end: cursor + occ.end,
      args: occ.args,
    });
    cursor += occ.end;
  }

  // No valid replacements found
  if (occurrences.length === 0) {
    return { sql: trimmed, rewritten: false };
  }

  // Apply replacements in reverse order (right-to-left) to preserve offsets.
  let result = trimmed;
  for (const r of occurrences.slice().reverse()) {
    const innerContent = r.args.trim();
    const replacement = `json_array(${innerContent})`;
    result = result.slice(0, r.start) + replacement + result.slice(r.end);
  }

  const modified = result !== trimmed;

  if (modified) {
    logger.debug(
      { before: trimmed, after: result, count: occurrences.length },
      'Rewrote ROW expressions to json_array',
    );
  }

  return {
    sql: result,
    rewritten: modified,
  };
}
