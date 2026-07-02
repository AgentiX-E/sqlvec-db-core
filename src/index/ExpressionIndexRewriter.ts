/**
 * ExpressionIndexRewriter — Detects and rewrites PostgreSQL expression indexes to SQLite.
 *
 * PostgreSQL allows `CREATE INDEX ON t ((expression))` with double parentheses to
 * distinguish expression columns from simple columns. SQLite uses single parentheses:
 * `CREATE INDEX ON t (expression)`.
 *
 * Also strips PG-specific ASC/DESC and NULLS FIRST/LAST modifiers from expression
 * columns since SQLite does not support them on expression-based index keys.
 *
 * ## Enhanced support (v2)
 *
 * In addition to basic double-parenthesis unwrapping, this rewriter now supports:
 *
 * - **Arithmetic expressions**: `(col1 + col2)`, `(price * 1.1)`, `(qty - discount)`
 *   These pass through to SQLite as native expression index columns.
 *
 * - **JSON extraction**: `(json_extract(data, '$.key'))`
 *   Detected as a function call and passed through as-is to SQLite, which
 *   supports expression indexes with json_extract.
 *
 * - **Function composition**: `(lower(trim(col)))`
 *   Nested function calls are preserved and passed through to SQLite as
 *   expression index columns.
 *
 * Reference: https://www.postgresql.org/docs/current/indexes-expressional.html
 * Reference: https://www.sqlite.org/expridx.html
 *
 * @module index/ExpressionIndexRewriter
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('ExprIndex');

// ── Types ────────────────────────────────────────────────────────

export interface ExprIndexResult {
  /** The rewritten SQL string (identical to input if not rewritten). */
  sql: string;
  /** Whether any transformation was applied. */
  rewritten: boolean;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * Regex to match CREATE INDEX statement and split into:
 *  - prefix: everything up to and including `ON schema.table (`
 *  - suffix: everything after the closing `)` (semicolon, whitespace, comments)
 *
 * Group 1: prefix  — e.g. "CREATE INDEX ix ON t ("
 * Group 2: columns — the content between the outer parens
 * Group 3: suffix  — everything after the closing paren (including the paren itself is excluded)
 */
const CREATE_INDEX_RE =
  /^(CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`\w]+\.)?(?:["`\w]+\s+)?ON\s+(?:["`\w]+\.)?["`\w]+\s*\()(.+)\)((?:\s*;)?\s*)$/is;

/**
 * Matches ASC / DESC at end of a column fragment (case-insensitive).
 * Leading `\s*` allows `ASC` immediately after `)` as in `((col)ASC)`.
 */
const SORT_ORDER_RE = /\s*(ASC|DESC)\s*$/i;

/**
 * Matches NULLS FIRST / NULLS LAST at end of a column fragment (case-insensitive).
 */
const NULLS_ORDER_RE = /\s+NULLS\s+(FIRST|LAST)\s*$/i;

/**
 * Matches known SQLite-compatible function calls that can be used in
 * expression-based indexes.
 */
const SQLITE_EXPR_FUNCS = [
  'json_extract',
  'json_unquote',
  'json_type',
  'substr',
  'substring',
  'trim',
  'ltrim',
  'rtrim',
  'lower',
  'upper',
  'length',
  'abs',
  'round',
  'ceil',
  'floor',
  'coalesce',
  'ifnull',
  'nullif',
  'typeof',
  'instr',
  'replace',
  'like',
  'glob',
  'unicode',
  'char',
  'printf',
  'hex',
  'quote',
];

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Find the position of the matching closing parenthesis for the one at `startIdx`.
 *
 * @param sql - Full SQL string.
 * @param startIdx - Index of the opening `(`.
 * @returns Index of the matching `)`, or `-1` if unmatched.
 */
function findMatchingParen(sql: string, startIdx: number): number {
  let depth = 1;
  for (let i = startIdx + 1; i < sql.length; i++) {
    if (sql[i] === '(') {
      depth++;
    } else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split a comma-separated column list while respecting balanced parentheses.
 * Commas inside nested parentheses are not treated as delimiters.
 *
 * @param columnList - The raw column list string (e.g. `"(lower(name)), id"`).
 * @returns Array of individual column fragment strings.
 */
function splitColumnList(columnList: string): string[] {
  const columns: string[] = [];
  let depth = 0;
  let current = '';
  let inQuote: string | null = null;

  for (const ch of columnList) {
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      current += ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      columns.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    columns.push(trimmed);
  }

  return columns;
}

/**
 * Check if a string looks like it starts with a known SQLite expression
 * function call (e.g. `json_extract(...)`, `lower(...)`, `trim(...)`).
 */
function isSqliteExprFunc(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return SQLITE_EXPR_FUNCS.some((fn) => lower.startsWith(fn + '('));
}

/**
 * Check if a string looks like an arithmetic expression.
 * Detects the presence of arithmetic operators (+, -, *, /, %) between tokens.
 */
function isArithmeticExpr(text: string): boolean {
  // Must contain at least one arithmetic operator not inside quotes.
  const stripped = text.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
  return /[+\-*/%]/.test(stripped);
}

/**
 * Process a single column fragment:
 *  1. If it starts with `(`, unwrap one level of parens (PG expression
 *     wrapper) — even if modifiers follow the closing paren.
 *  2. Strip trailing ASC / DESC from the remainder.
 *  3. Strip trailing NULLS FIRST / LAST from the remainder.
 *  4. Simple column references (no leading `(`) pass through unchanged.
 *
 * Enhanced: Recognises and preserves SQLite-compatible expression patterns:
 *   - Arithmetic: `(col1 + col2)` → `col1 + col2`
 *   - JSON extraction: `(json_extract(data, '$.key'))` → `json_extract(data, '$.key')`
 *   - Function composition: `(lower(trim(col)))` → `lower(trim(col))`
 *
 * @param col - A single column fragment string.
 * @returns The processed column fragment.
 */
function processColumn(col: string): string {
  const trimmed = col.trim();
  if (trimmed.length === 0) return trimmed;

  // ── Expression column detection ───────────────────────────────
  // If the column starts with `(`, it's a PG expression column.
  // Simple column references (e.g. `id`, `id ASC`) are valid in
  // SQLite and pass through unchanged.
  if (!trimmed.startsWith('(')) {
    return trimmed;
  }

  // ── Step 1: Unwrap expression parentheses ─────────────────────
  let expression: string;
  let remainder: string;

  const outerOpenIdx = 0;
  const closeIdx = findMatchingParen(trimmed, outerOpenIdx);
  if (closeIdx === -1) {
    // Malformed parentheses — return as-is
    return trimmed;
  }

  // Extract the inner expression and everything after the closing `)`.
  expression = trimmed.substring(1, closeIdx).trim();
  remainder = trimmed.substring(closeIdx + 1);

  // ── Enhanced: Detect if the inner expression is itself wrapped ─
  // If the inner expression also starts and ends with parens, it may be
  // a function call like `(json_extract(data, '$.key'))`. In that case
  // we need to walk past the function's own closing paren.
  let finalExpr = expression;
  let innerRemainder = remainder;

  // Try to detect function calls where the inner expression may be nested.
  // E.g. `((lower(trim(col))))` — unwrap both layers.
  if (expression.startsWith('(')) {
    const innerClose = findMatchingParen(expression, 0);
    if (innerClose !== -1) {
      // Check if there's another layer.
      const innerContent = expression.substring(1, innerClose).trim();
      const afterInner = expression.substring(innerClose + 1).trim();
      finalExpr = innerContent + (afterInner ? ' ' + afterInner : '');
      // Recalculate remainder from the inner level.
      innerRemainder = remainder ? afterInner + ' ' + remainder : afterInner;
    }
  }

  // ── Step 2: Detect enhanced expression types ──────────────────
  // If the expression is a SQLite-compatible function call (json_extract,
  // lower, trim, etc.) or an arithmetic expression, we preserve it as-is
  // without stripping the function call parentheses.
  if (isSqliteExprFunc(finalExpr) || isArithmeticExpr(finalExpr)) {
    // Strip trailing PG modifiers.
    let cleanedRemainder = innerRemainder;
    for (let i = 0; i < 3; i++) {
      if (cleanedRemainder.length === 0) break;
      const before = cleanedRemainder;
      cleanedRemainder = cleanedRemainder.replace(SORT_ORDER_RE, '');
      cleanedRemainder = cleanedRemainder.replace(NULLS_ORDER_RE, '');
      if (cleanedRemainder === before) break;
    }

    const cleaned = cleanedRemainder.trim();
    return cleaned.length > 0 ? finalExpr + ' ' + cleaned : finalExpr;
  }

  // ── Step 2 (original): Strip PG-specific modifiers ────────────
  let r = innerRemainder;
  for (let i = 0; i < 3; i++) {
    if (r.length === 0) break;
    const before = r;
    r = r.replace(SORT_ORDER_RE, '');
    r = r.replace(NULLS_ORDER_RE, '');
    if (r === before) break;
  }

  // ── Reassemble ────────────────────────────────────────────────
  const cleaned = r.trim();

  return cleaned.length > 0 ? finalExpr + ' ' + cleaned : finalExpr;
}

/**
 * Determine whether the column list contains any expression columns
 * (columns that start with `(` after trimming).
 *
 * @param columns - Array of column fragment strings.
 * @returns `true` if any column is an expression column.
 */
function hasExpressionColumns(columns: string[]): boolean {
  return columns.some((col) => {
    const trimmed = col.trim();
    return trimmed.startsWith('(');
  });
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether a SQL statement is a CREATE INDEX that contains
 * expression columns (PG double-parentheses syntax).
 *
 * @param sql - The SQL statement to inspect.
 * @returns `true` if the statement contains expression index columns.
 */
export function detectExpressionIndex(sql: string): boolean {
  const match = sql.match(CREATE_INDEX_RE);
  if (!match) return false;

  const [, , columnList] = match;
  const columns = splitColumnList(columnList);
  const detected = hasExpressionColumns(columns);

  logger.debug({ sql: sql.substring(0, 80), detected }, 'detectExpressionIndex');
  return detected;
}

/**
 * Rewrite a PostgreSQL CREATE INDEX statement with expression columns
 * to a SQLite-compatible form.
 *
 * **Transformations applied:**
 *  1. Unwrap PG double-parentheses to single parentheses (expression columns).
 *  2. Strip ASC / DESC from expression columns.
 *  3. Strip NULLS FIRST / LAST from expression columns.
 *  4. **Enhanced:** Preserve SQLite-compatible function calls
 *     (json_extract, lower, trim, substr, etc.) and arithmetic expressions
 *     (col1 + col2, price * 1.1) as native expression index columns.
 *
 * If the statement is not a CREATE INDEX or contains no expression columns,
 * the original SQL is returned with `rewritten: false`.
 *
 * **Examples:**
 * ```
 * Input:  CREATE INDEX ix ON t ((lower(name)))
 * Output: CREATE INDEX ix ON t (lower(name))
 *
 * Input:  CREATE INDEX ON t ((lower(name)), id)
 * Output: CREATE INDEX ON t (lower(name), id)
 *
 * Input:  CREATE INDEX ON t ((col + 1) ASC)
 * Output: CREATE INDEX ON t (col + 1)
 *
 * Input:  CREATE INDEX ON t ((col) NULLS FIRST)
 * Output: CREATE INDEX ON t (col)
 *
 * Input:  CREATE INDEX ON t ((json_extract(data, '$.key')))
 * Output: CREATE INDEX ON t (json_extract(data, '$.key'))
 *
 * Input:  CREATE INDEX ON t ((price * 1.1))
 * Output: CREATE INDEX ON t (price * 1.1)
 *
 * Input:  CREATE INDEX ON t ((lower(trim(col))))
 * Output: CREATE INDEX ON t (lower(trim(col)))
 * ```
 *
 * @param sql - The PostgreSQL CREATE INDEX statement.
 * @returns The rewritten result with the original or modified SQL.
 */
export function rewriteExpressionIndex(sql: string): ExprIndexResult {
  // ── Fast path: not a CREATE INDEX ──────────────────────────
  const match = sql.match(CREATE_INDEX_RE);
  if (!match) {
    return { sql, rewritten: false };
  }

  const [fullMatch, prefix, columnList, suffix] = match;

  // ── Parse columns ─────────────────────────────────────────
  const originalColumns = splitColumnList(columnList);

  // ── Fast path: no expression columns ──────────────────────
  if (!hasExpressionColumns(originalColumns)) {
    return { sql, rewritten: false };
  }

  // ── Rewrite each column ───────────────────────────────────
  const rewrittenColumns = originalColumns.map((col) => processColumn(col));

  // ── Reconstruct SQL ───────────────────────────────────────
  const newColumns = rewrittenColumns.join(', ');
  let resultSql: string;

  if (suffix.startsWith(';') || suffix.startsWith(')')) {
    resultSql = prefix + newColumns + ')' + suffix;
  } else {
    resultSql = prefix + newColumns + ')' + (suffix || '');
  }

  // ── Sanity: emit a warning if output looks problematic ──
  if (rewrittenColumns.some((c) => c.length === 0)) {
    logger.warn(
      { original: sql, rewritten: resultSql },
      'rewriteExpressionIndex produced an empty column — possible parse issue',
    );
  }

  logger.info(
    {
      original: sql.substring(0, 120),
      rewritten: resultSql.substring(0, 120),
    },
    'rewriteExpressionIndex applied',
  );

  return { sql: resultSql, rewritten: true };
}
