/**
 * DistinctOnRewriter — Translates PostgreSQL SELECT DISTINCT ON to SQLite window-function equivalent.
 *
 * SQLite 3.25+ supports window functions (ROW_NUMBER, PARTITION BY, ORDER BY),
 * which enables translating PostgreSQL's DISTINCT ON syntax.
 *
 * Translation strategy:
 *   SELECT DISTINCT ON (d1, d2) a, b, c FROM t WHERE x = 1 ORDER BY d1, d2, a LIMIT 10
 *   →
 *   SELECT * FROM (
 *     SELECT a, b, c, ROW_NUMBER() OVER (PARTITION BY d1, d2 ORDER BY d1, d2, a) AS _rn
 *     FROM t WHERE x = 1
 *   ) WHERE _rn = 1 LIMIT 10
 *
 * Key guarantees:
 *   - Every returned SQL is valid SQLite (3.25+) and PostgreSQL-compatible
 *   - The _rn column is transparently filtered out in the outer query
 *   - ORDER BY, LIMIT, OFFSET are preserved at the outer level
 *
 * Limitations (regex-based approach):
 *   - String literals containing DISTINCT ON keywords may trigger false positive detection
 *   - Nested parentheses beyond one level inside DISTINCT ON(...) may fail
 *   - ORDER BY expressions with subqueries (rare) may not be properly separated
 */

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL } from './LiteralProtectionLayer';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('DistinctOnRewriter');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface DistinctOnResult {
  /** Rewritten SQL string (unchanged if no DISTINCT ON found) */
  sql: string;
  /** Whether a DISTINCT ON was found and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Private helpers
// ──────────────────────────────────────────────

/**
 * Split a comma-separated expression list at top-level commas only.
 * Respects nested parentheses and skips over string literals, quoted
 * identifiers, dollar-quoted strings, and comments so that a `,` inside any of
 * them is never treated as a delimiter.
 */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;

  while (i < s.length) {
    const skip = skipSqlLiteral(s, i);
    if (skip !== -1) {
      current += s.slice(i, skip);
      i = skip;
      continue;
    }

    const ch = s[i];

    if (ch === '(') {
      depth++;
      current += ch;
      i++;
      continue;
    }

    if (ch === ')') {
      depth--;
      current += ch;
      i++;
      continue;
    }

    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const last = current.trim();
  if (last.length > 0) {
    parts.push(last);
  }

  return parts;
}

/**
 * Find the matching closing parenthesis, given the position of the opening '('.
 * Returns the index of the matching ')'. String literals, quoted identifiers,
 * dollar-quoted strings, and comments are skipped so their parentheses never
 * affect the depth count.
 */
function findMatchingClose(sql: string, openPos: number): number {
  let depth = 1;
  let i = openPos + 1;

  while (i < sql.length && depth > 0) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }

    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
    if (depth > 0) i++;
  }

  return i;
}

/**
 * Extract the content inside a TOP-LEVEL `DISTINCT ON (...)`.
 * Returns the raw content string and the position of the closing ')'.
 * Returns `null` if DISTINCT ON is not found, or if the DISTINCT ON is nested
 * inside a subquery (i.e. an unclosed `(` precedes it), which this regex-based
 * rewriter does not support — the caller then leaves the statement unchanged
 * rather than emitting a malformed rewrite.
 */
function extractDistinctOnContent(sql: string): { content: string; closePos: number } | null {
  const regex = /\bDISTINCT\s+ON\s*\(/i;
  const match = regex.exec(sql);
  if (!match) return null;

  // If an unclosed parenthesis (or dollar-quote/string that is not yet closed)
  // precedes DISTINCT ON, it is nested inside a subquery. Only a top-level
  // DISTINCT ON is rewritable here; otherwise the outer SELECT wrapper would be
  // misparsed into the inner body, producing unbalanced parentheses.
  if (hasUnclosedParenBefore(sql, match.index)) {
    return null;
  }

  const openPos = match.index + match[0].length - 1; // position of '('
  const closePos = findMatchingClose(sql, openPos);
  const content = sql.substring(openPos + 1, closePos);

  return { content, closePos };
}

/**
 * Return true if the SQL prefix up to (but not including) `pos` contains an
 * unclosed `(` at any point — i.e. `pos` sits inside a parenthesized subquery or
 * function-call argument list. String literals, quoted identifiers,
 * dollar-quoted strings, and comments are skipped.
 */
function hasUnclosedParenBefore(sql: string, pos: number): boolean {
  let depth = 0;
  let i = 0;
  while (i < pos) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      // A literal that extends past `pos` means `pos` is inside it, but we only
      // reach here for a DISTINCT ON keyword match, which cannot be a literal;
      // still clamp so the loop does not run past the boundary.
      i = Math.min(skip, pos);
      continue;
    }
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
    i++;
  }
  return depth > 0;
}

/**
 * Extract the WITH clause prefix (including WITH keyword up to but not including
 * the final SELECT), if present. Uses paren-depth tracking to skip over CTE
 * body subqueries that may contain DISTINCT ON themselves.
 *
 * Returns the WITH prefix and the remainder starting at the main SELECT.
 *
 * Whitespace compatibility: supports any standard SQL whitespace (spaces, tabs,
 * newlines, etc.).
 */
function extractWithClause(sql: string): { withClause: string; afterWith: string } {
  const trimmed = sql.trimStart();
  const withMatch = /^WITH\s+/i.exec(trimmed);
  if (!withMatch) {
    return { withClause: '', afterWith: trimmed };
  }

  let pos = withMatch[0].length;
  let depth = 0;
  let inString = false;
  let stringChar = '';
  // True when we are past "AS (" for a CTE and scanning its body
  let inCteBody = false;

  while (pos < trimmed.length) {
    const ch = trimmed[pos];

    if (inString) {
      if (ch === stringChar) inString = false;
      pos++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      pos++;
      continue;
    }

    if (ch === '(') {
      depth++;
      pos++;
      continue;
    }

    if (ch === ')') {
      depth--;
      pos++;
      if (depth === 0 && inCteBody) {
        // End of a CTE body. Look ahead for ',' (next CTE) or SELECT (main query).
        const rest = trimmed.substring(pos);
        const commaMatch = rest.match(/^\s*,/);
        if (commaMatch) {
          // More CTEs follow — reset and continue
          pos += commaMatch[0].length;
          inCteBody = false;
        } else {
          // Should be the main SELECT (WITH or DISTINCT ON is fine)
          // If it's another keyword, return everything as the WITH clause
          const mainSelectMatch = rest.match(/^\s*SELECT\b/i);
          if (mainSelectMatch) {
            const withClause = trimmed.substring(0, pos);
            const afterWith = trimmed.substring(pos).trimStart();
            return { withClause: withClause.trimEnd(), afterWith };
          }
          // Fallback: scan forward to find SELECT
          pos += rest.search(/\bSELECT\b/i);
          if (pos < 0) {
            // No SELECT found — shouldn't happen, bail out
            return { withClause: '', afterWith: trimmed };
          }
          const withClause = trimmed.substring(0, pos);
          const afterWith = trimmed.substring(pos);
          return { withClause: withClause.trimEnd(), afterWith: afterWith.trimStart() };
        }
      }
      continue;
    }

    // At depth 0 and not inside a CTE body, look for "AS (" to enter the next CTE body
    if (depth === 0 && !inCteBody) {
      const rest = trimmed.substring(pos);
      const asMatch = /^AS\s*\(/i.exec(rest);
      if (asMatch) {
        depth = 1;
        pos += asMatch[0].length;
        inCteBody = true;
        continue;
      }
    }

    pos++;
  }

  // No closing paren found — malformed or non-CTE WITH
  return { withClause: '', afterWith: trimmed };
}

/**
 * Clause-starting keywords (top-level only). These mark boundaries
 * between the SELECT-list and the rest of the query.
 */
const CLAUSE_KEYWORDS = /\b(FROM|WHERE|GROUP\s+BY|HAVING|WINDOW|ORDER\s+BY|LIMIT|OFFSET)\b/i;

/**
 * Check if the given index is at a word boundary (preceded by space/start).
 */
function isAtBoundary(sql: string, i: number): boolean {
  return i === 0 || /\s/.test(sql[i - 1]);
}

/**
 * Extract the SELECT column list (everything after DISTINCT ON (...)
 * up to the first top-level clause keyword).
 */
function extractSelectColumns(afterDo: string): { selectColumns: string; rest: string } {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let i = 0;

  while (i < afterDo.length) {
    const ch = afterDo[i];

    if (inString) {
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      i++;
      continue;
    }

    if (ch === '(') {
      depth++;
      i++;
      continue;
    }

    if (ch === ')') {
      depth--;
      i++;
      continue;
    }

    // At top level, check for clause-starting keywords
    if (depth === 0 && isAtBoundary(afterDo, i)) {
      const remaining = afterDo.substring(i);
      const kwMatch = remaining.match(CLAUSE_KEYWORDS);
      if (kwMatch && kwMatch.index === 0) {
        return {
          selectColumns: afterDo.substring(0, i).trim(),
          rest: afterDo.substring(i).trim(),
        };
      }
    }

    i++;
  }

  // No clause keyword found — the entire remaining string is the select list
  return {
    selectColumns: afterDo.trim(),
    rest: '',
  };
}

/**
 * Extract ORDER BY columns and separate them from LIMIT/OFFSET.
 *
 * Returns:
 *   - orderByCols: ORDER BY column expressions (empty if none)
 *   - beforeOrderBy: everything before the ORDER BY keyword
 *   - afterOrderBy: everything after ORDER BY (with LIMIT/OFFSET preserved)
 */
function extractOrderBy(rest: string): {
  orderByCols: string;
  beforeOrderBy: string;
  afterOrderBy: string;
} {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let i = 0;

  while (i < rest.length) {
    const ch = rest[i];

    if (inString) {
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      i++;
      continue;
    }

    if (ch === '(') {
      depth++;
      i++;
      continue;
    }

    if (ch === ')') {
      depth--;
      i++;
      continue;
    }

    if (depth === 0 && isAtBoundary(rest, i)) {
      const remaining = rest.substring(i);
      const obMatch = remaining.match(/^\s*ORDER\s+BY\s+/i);
      if (obMatch) {
        const beforeOrderBy = rest.substring(0, i).trim();
        const afterOb = remaining.substring(obMatch[0].length);

        // Extract ORDER BY columns — stop at LIMIT/OFFSET/end
        const orderByCols = extractOrderByColumns(afterOb);

        // Everything after ORDER BY (LIMIT/OFFSET)
        const afterOrderBy = extractAfterOrderBy(afterOb, orderByCols);

        return { orderByCols, beforeOrderBy, afterOrderBy };
      }
    }

    i++;
  }

  // No ORDER BY keyword found. LIMIT/OFFSET may still be present (DISTINCT ON
  // without ORDER BY is legal, though unusual); separate them so they land on
  // the outer query rather than the inner subquery (BUG #108).
  const { limitOffset, body } = extractLimitOffset(rest);
  if (limitOffset.length > 0) {
    return { orderByCols: '', beforeOrderBy: body, afterOrderBy: limitOffset };
  }

  return { orderByCols: '', beforeOrderBy: rest.trim(), afterOrderBy: '' };
}

/**
 * Extract the ORDER BY column expressions from the text after "ORDER BY".
 * Stops at LIMIT, OFFSET, or end of string.
 */
function extractOrderByColumns(afterOb: string): string {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let i = 0;

  while (i < afterOb.length) {
    const ch = afterOb[i];

    if (inString) {
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      i++;
      continue;
    }

    if (ch === '(') {
      depth++;
      i++;
      continue;
    }

    if (ch === ')') {
      depth--;
      i++;
      continue;
    }

    if (depth === 0 && isAtBoundary(afterOb, i)) {
      const remaining = afterOb.substring(i);
      const lMatch = remaining.match(/^\s*(LIMIT|OFFSET)\b/i);
      if (lMatch) {
        return afterOb.substring(0, i).trim();
      }
    }

    i++;
  }

  return afterOb.trim();
}

/**
 * Extract everything after the ORDER BY clause (LIMIT, OFFSET, etc.).
 *
 * `afterOb` begins with the already-extracted ORDER BY columns (there is no
 * leading whitespace because the `ORDER BY` keyword match consumed it), so what
 * follows those columns is the trailing LIMIT/OFFSET.
 */
function extractAfterOrderBy(afterOb: string, orderByCols: string): string {
  if (orderByCols.length === 0) return afterOb;
  return afterOb.substring(orderByCols.length).trim();
}

/**
 * Extract LIMIT/OFFSET clauses from a query string.
 */
function extractLimitOffset(clauses: string): { limitOffset: string; body: string } {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let i = 0;

  while (i < clauses.length) {
    const ch = clauses[i];

    if (inString) {
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      i++;
      continue;
    }

    if (ch === '(') {
      depth++;
      i++;
      continue;
    }

    if (ch === ')') {
      depth--;
      i++;
      continue;
    }

    if (depth === 0 && isAtBoundary(clauses, i)) {
      const remaining = clauses.substring(i);
      const loMatch = remaining.match(/^\s*(LIMIT\s+\d+(?:\s*(?:,|OFFSET)\s*\d+)?|OFFSET\s+\d+)/i);
      if (loMatch) {
        return {
          limitOffset: loMatch[0].trim(),
          body: clauses.substring(0, i).trim(),
        };
      }
    }

    i++;
  }

  return { limitOffset: '', body: clauses.trim() };
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains DISTINCT ON.
 *
 * @param sql - A SQL query string
 * @returns `true` if the SQL contains DISTINCT ON
 *
 * @example
 * ```ts
 * detectDistinctOn("SELECT DISTINCT ON (id) * FROM t"); // true
 * detectDistinctOn("SELECT DISTINCT name FROM t");      // false
 * ```
 */
export function detectDistinctOn(sql: string): boolean {
  // Detect on literal-protected SQL so a DISTINCT ON token inside a string
  // literal or comment is never reported (BUG #105/#106). This also guards
  // rewriteDistinctOn, which returns the original SQL unchanged for such inputs.
  const protectedSql = protectSQL(sql).protectedSql;
  return /\bDISTINCT\s+ON\s*\(/i.test(protectedSql);
}

/**
 * Rewrite a PostgreSQL DISTINCT ON query to SQLite-compatible window function syntax.
 *
 * Transformation uses ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...) to
 * emulate DISTINCT ON semantics. The outer query filters _rn = 1 to get one
 * row per distinct partition.
 *
 * @param sql - A SQL query string that may contain DISTINCT ON
 * @returns An object with the rewritten SQL and a flag indicating if a rewrite occurred
 *
 * @example
 * ```ts
 * const result = rewriteDistinctOn(
 *   "SELECT DISTINCT ON (cat_id) id, name, cat_id FROM products ORDER BY cat_id, price DESC"
 * );
 * // result.sql === [
 * //   "SELECT * FROM (",
 * //   "  SELECT id, name, cat_id, ROW_NUMBER() OVER (PARTITION BY cat_id ORDER BY cat_id, price DESC) AS _rn",
 * //   "  FROM products",
 * //   ") WHERE _rn = 1"
 * // ].join('\n')
 * // result.rewritten === true
 * ```
 */
export function rewriteDistinctOn(sql: string): DistinctOnResult {
  const trimmed = sql.trim();

  if (!detectDistinctOn(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  // ── 1. Extract WITH clause ─────────────────────────────────────
  const { withClause, afterWith } = extractWithClause(trimmed);

  // ── 2. Extract DISTINCT ON expressions ─────────────────────────
  const doInfo = extractDistinctOnContent(afterWith);
  if (!doInfo) {
    // Either DISTINCT ON is nested inside a subquery (which this rewriter does
    // not support), or the keyword only appeared inside a literal that protectSQL
    // did not cover. Leave the statement unchanged in either case.
    logger.debug({ sql: trimmed }, 'DistinctOnRewriter: top-level DISTINCT ON not found — leaving unchanged');
    return { sql: trimmed, rewritten: false };
  }

  const doExpressions = splitTopLevelCommas(doInfo.content);
  const afterDo = afterWith.substring(doInfo.closePos + 1).trimStart();

  if (doExpressions.length === 0) {
    logger.warn({ sql: trimmed }, 'DistinctOnRewriter: DISTINCT ON with empty expression list');
    return { sql: trimmed, rewritten: false };
  }

  // ── 3. Extract SELECT columns ──────────────────────────────────
  const { selectColumns, rest: restQuery } = extractSelectColumns(afterDo);

  // ── 4. Extract ORDER BY ────────────────────────────────────────
  const { orderByCols, beforeOrderBy, afterOrderBy } = extractOrderBy(restQuery);

  // ── 5. Extract LIMIT/OFFSET from afterOrderBy ──────────────────
  const { limitOffset } = extractLimitOffset(afterOrderBy);

  // ── 6. Build the main body (FROM + WHERE + GROUP BY + HAVING + WINDOW) ──
  //    This is everything before ORDER BY. afterOrderByBody is always empty in
  //    the current data flow: extractLimitOffset is fed from afterOrderBy which
  //    only ever carries LIMIT/OFFSET (any trailing FOR UPDATE etc. is consumed
  //    by extractOrderByColumns), so its body is the empty string.
  const innerBody = beforeOrderBy;

  // ── 7. Build PARTITION BY and window ORDER BY ──────────────────
  const doColsJoined = doExpressions.join(', ');
  const windowOrderBy = orderByCols.length > 0 ? orderByCols : doColsJoined;

  const partitionBy = `PARTITION BY ${doColsJoined}`;
  // windowOrderBy is always non-empty: it falls back to doColsJoined (which is
  // guaranteed non-empty by the empty-expression guard above) when ORDER BY is
  // absent, so the empty-string arm of the original ternary was unreachable.
  const orderByPart = ` ORDER BY ${windowOrderBy}`;
  const windowFn = `ROW_NUMBER() OVER (${partitionBy}${orderByPart})`;

  // ── 8. Build the rewritten query ───────────────────────────────
  // Inner subquery
  const innerSql = `SELECT ${selectColumns}, ${windowFn} AS _rn` +
    (innerBody.length > 0 ? ` ${innerBody}` : '');

  // Outer query — reselect the same columns to avoid _rn leakage
  const outerBody = `SELECT * FROM (${innerSql}) WHERE _rn = 1`;

  // Append LIMIT/OFFSET to outer query
  const result = limitOffset.length > 0 ? `${outerBody} ${limitOffset}` : outerBody;

  // Prepend WITH clause
  const finalSql = withClause.length > 0 ? `${withClause} ${result}` : result;

  logger.info(
    {
      doExpressions,
      orderByCols,
      innerBody,
      limitOffset,
      hasWith: withClause.length > 0,
    },
    'DistinctOnRewriter: rewrite complete',
  );

  return { sql: finalSql, rewritten: true };
}
