/**
 * NullsFirstLastShim — Rewrites ORDER BY ... NULLS FIRST / NULLS LAST
 * into SQLite-compatible expressions.
 *
 * PostgreSQL supports:
 *   ORDER BY col ASC NULLS FIRST   → NULLs before non-NULLs, ascending
 *   ORDER BY col ASC NULLS LAST    → NULLs after non-NULLs, ascending  (default for ASC)
 *   ORDER BY col DESC NULLS FIRST  → NULLs before non-NULLs, descending (default for DESC)
 *   ORDER BY col DESC NULLS LAST   → NULLs after non-NULLs, descending
 *
 * SQLite does NOT support NULLS FIRST / NULLS LAST syntax.
 * SQLite default: NULLs sort first for ASC, last for DESC.
 *
 * Rewrite strategy:
 *   NULLS FIRST  → ORDER BY (CASE WHEN col IS NULL THEN 0 ELSE 1 END), col ASC/DESC
 *   NULLS LAST   → ORDER BY (CASE WHEN col IS NULL THEN 1 ELSE 0 END), col ASC/DESC
 *
 * For multi-column ORDER BY with mixed NULLS clauses, each column gets
 * its own CASE expression to control NULL ordering independently.
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('NullsFirstLastShim');

// ── Types ────────────────────────────────────────────────────────

export interface NullsFirstLastResult {
  /** Rewritten SQL (original if no rewrite was applied) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
  /** Count of NULLS FIRST/LAST clauses rewritten */
  count: number;
}

// ── Patterns ─────────────────────────────────────────────────────

/**
 * Matches a sort key followed by NULLS FIRST or NULLS LAST.
 *
 * Group 1: the sort key expression (everything before NULLS)
 * Group 2: optional ASC/DESC
 * Group 3: NULLS FIRST or NULLS LAST
 *
 * Examples:
 *   `col NULLS FIRST`
 *   `col ASC NULLS LAST`
 *   `col DESC NULLS FIRST`
 *   `t.column_name NULLS LAST`
 *   `SUM(x) DESC NULLS FIRST`
 */
const NULLS_CLAUSE_RE =
  /\b(NULLS)\s+(FIRST|LAST)\b/i;

/**
 * ORDER BY clause detection — finds the main ORDER BY block.
 */
const ORDER_BY_RE = /\bORDER\s+BY\b/i;

/**
 * Extracts the full ORDER BY clause content (everything after ORDER BY up
 * to next major clause or end of SQL).
 */
const ORDER_BY_CLAUSE_RE =
  /\bORDER\s+BY\s+(.+?)(?=\b(LIMIT|OFFSET|FETCH|FOR\s+UPDATE|FOR\s+SHARE|\bUNION\b|\bINTERSECT\b|\bEXCEPT\b|\bHAVING\b|$))/is;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL contains ORDER BY ... NULLS FIRST/LAST.
 */
export function detectNullsFirstLast(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;

  const trimmed = sql.trim();

  // Must have ORDER BY first
  if (!ORDER_BY_RE.test(trimmed)) return false;

  // Then check for NULLS FIRST/LAST
  NULLS_CLAUSE_RE.lastIndex = 0;
  return NULLS_CLAUSE_RE.test(trimmed);
}

/**
 * Parse ORDER BY clause into individual sort keys.
 *
 * Input: `col1 ASC, col2 DESC NULLS LAST, col3 NULLS FIRST`
 * Output: `['col1 ASC', 'col2 DESC NULLS LAST', 'col3 NULLS FIRST']`
 */
function splitOrderByClause(orderByContent: string): string[] {
  // Split by commas, respecting nested parentheses
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar: string | null = null;

  for (let i = 0; i < orderByContent.length; i++) {
    const ch = orderByContent[i];

    if (inString) {
      if (ch === '\\') {
        current += ch + (orderByContent[i + 1] || '');
        i++;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

/**
 * Extract the sort key expression (without ASC/DESC/NULLS modifiers).
 *
 * Input: `col1 ASC NULLS LAST` → `col1`
 * Input: `SUM(x) DESC` → `SUM(x)`
 * Input: `t.column` → `t.column`
 */
function extractSortKey(sortItem: string): string {
  return sortItem
    .replace(/\s+(ASC|DESC)\b/i, '')
    .replace(/\s+NULLS\s+(FIRST|LAST)\b/i, '')
    .trim();
}

/**
 * Extract the ASC/DESC direction (defaults to ASC if absent).
 */
function extractDirection(sortItem: string): 'ASC' | 'DESC' {
  if (/\bDESC\b/i.test(sortItem)) return 'DESC';
  return 'ASC';
}

/**
 * Extract the NULLS direction (NULLS FIRST or NULLS LAST).
 * Returns null if not specified.
 */
function extractNullsDirection(sortItem: string): 'FIRST' | 'LAST' | null {
  const match = sortItem.match(NULLS_CLAUSE_RE);
  if (match) return match[2].toUpperCase() as 'FIRST' | 'LAST';
  return null;
}

/**
 * Build a CASE expression for controlling NULL ordering.
 *
 * For NULLS FIRST:
 *   (CASE WHEN expr IS NULL THEN 0 ELSE 1 END)
 *
 * For NULLS LAST:
 *   (CASE WHEN expr IS NULL THEN 1 ELSE 0 END)
 */
function buildNullsCaseExpr(sortKey: string, nullsDir: 'FIRST' | 'LAST'): string {
  const nullScore = nullsDir === 'FIRST' ? '0' : '1';
  const nonNullScore = nullsDir === 'FIRST' ? '1' : '0';
  return `(CASE WHEN ${sortKey} IS NULL THEN ${nullScore} ELSE ${nonNullScore} END)`;
}

/**
 * Rewrite a single sort item with NULLS FIRST/LAST into SQLite-compatible expression.
 */
function rewriteSortItem(sortItem: string): string {
  const sortKey = extractSortKey(sortItem);
  const direction = extractDirection(sortItem);
  const nullsDir = extractNullsDirection(sortItem);

  if (!nullsDir) {
    // No NULLS clause — keep as-is
    return `${sortKey} ${direction}`;
  }

  // Build the null-order CASE expression + original sort direction
  // SQLite default: NULLS FIRST for ASC, NULLS LAST for DESC
  // So we only need the CASE expression when the desired behavior
  // differs from SQLite's default.

  // SQLite default behavior:
  //   ASC default:   NULLS FIRST
  //   DESC default:  NULLS LAST
  //
  // So we need a rewite when:
  //   ASC + NULLS LAST  → need CASE to put NULLs last
  //   DESC + NULLS FIRST → need CASE to put NULLs first
  //   ASC + NULLS FIRST  → no rewrite needed (SQLite default)
  //   DESC + NULLS LAST  → no rewrite needed (SQLite default)

  const isAscDefault = direction === 'ASC' && nullsDir === 'FIRST';
  const isDescDefault = direction === 'DESC' && nullsDir === 'LAST';

  if (isAscDefault || isDescDefault) {
    // SQLite default behavior — strip NULLS clause
    return `${sortKey} ${direction}`;
  }

  // Need the CASE expression for non-default behavior
  const caseExpr = buildNullsCaseExpr(sortKey, nullsDir);
  return `${caseExpr}, ${sortKey} ${direction}`;
}

/**
 * Rewrite ORDER BY ... NULLS FIRST/LAST into SQLite-compatible ORDER BY.
 *
 * @param sql - The SQL statement to rewrite
 * @returns Rewrite result
 *
 * @example
 * ```ts
 * rewriteNullsFirstLast('SELECT * FROM t ORDER BY name NULLS LAST');
 * // → 'SELECT * FROM t ORDER BY (CASE WHEN name IS NULL THEN 1 ELSE 0 END), name ASC'
 *
 * rewriteNullsFirstLast('SELECT * FROM t ORDER BY a DESC NULLS FIRST, b ASC NULLS LAST');
 * // → 'SELECT * FROM t ORDER BY (CASE WHEN a IS NULL THEN 0 ELSE 1 END), a DESC, (CASE WHEN b IS NULL THEN 1 ELSE 0 END), b ASC'
 * ```
 */
export function rewriteNullsFirstLast(sql: string): NullsFirstLastResult {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql || '', rewritten: false, count: 0 };
  }

  const trimmed = sql.trim();

  if (!detectNullsFirstLast(trimmed)) {
    return { sql: trimmed, rewritten: false, count: 0 };
  }

  // Find the ORDER BY clause
  const orderByMatch = trimmed.match(ORDER_BY_CLAUSE_RE);
  if (!orderByMatch) {
    return { sql: trimmed, rewritten: false, count: 0 };
  }

  const orderByContent = orderByMatch[1].trim();
  const orderByStart = orderByMatch.index!;
  const orderByFullLen = orderByMatch[0].length;

  // Split into individual sort items
  const sortItems = splitOrderByClause(orderByContent);

  // Count how many have NULLS FIRST/LAST
  let nullsCount = 0;
  for (const item of sortItems) {
    if (extractNullsDirection(item)) nullsCount++;
  }

  if (nullsCount === 0) {
    return { sql: trimmed, rewritten: false, count: 0 };
  }

  // Rewrite each sort item
  const rewrittenSortItems = sortItems.map(rewriteSortItem);
  const rewrittenOrderBy = `ORDER BY ${rewrittenSortItems.join(', ')}`;

  // Reconstruct the SQL
  const resultSql =
    trimmed.substring(0, orderByStart) +
    rewrittenOrderBy +
    trimmed.substring(orderByStart + orderByFullLen);

  logger.debug(
    { count: nullsCount, original: orderByContent, rewritten: rewrittenSortItems.join(', ') },
    'Rewrote NULLS FIRST/LAST clauses',
  );

  return {
    sql: resultSql,
    rewritten: true,
    count: nullsCount,
  };
}
