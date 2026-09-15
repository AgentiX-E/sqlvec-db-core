/**
 * RecursiveCteRewriter — Handles PostgreSQL CTE extensions for SQLite compatibility.
 *
 * SQLite 3.x **natively** supports `WITH RECURSIVE` CTEs.  However, PostgreSQL
 * adds several CTE extensions that SQLite does not support:
 *
 *   - **MATERIALIZED / NOT MATERIALIZED** (PG 12+)
 *     Removes `AS MATERIALIZED` / `AS NOT MATERIALIZED` between the CTE name
 *     and the query body.
 *   - **SEARCH {DEPTH | BREADTH} FIRST BY ... SET ...** (PG 16+)
 *     Removes the SEARCH ordering clause that appears after the CTE body.
 *   - **CYCLE ... SET ... TO ... [DEFAULT ...]** (PG 16+)
 *     Removes the CYCLE cycle-detection clause that appears after the CTE body.
 *
 * This module uses **regex-based** translation.  A full SQL parser is avoided
 * per project constraints.  Known limitations:
 *   - A closing `)` immediately preceding SEARCH/CYCLE that belongs to a nested
 *     subquery (not the CTE body) could cause a false-positive match.
 *   - In practice this is rare (SEARCH/CYCLE only appear after a CTE body's `)`)
 *     and the most common real-world patterns are handled correctly.
 *
 * @module RecursiveCteRewriter
 */

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

// ── Logger ────────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('RecursiveCteRewriter');

// ── Types ────────────────────────────────────────────────────────

export interface CteRewriteResult {
  /** Translated SQL string (unchanged if no PG CTE extensions found) */
  sql: string;
  /** Whether any rewriting was applied */
  rewritten: boolean;
}

// ── Shared sub-patterns ─────────────────────────────────────────

/**
 * Matches a SQL identifier:
 * - Simple: `col` / `schema.table`
 * - Double-quoted: `"column name"`
 */
const IDENT = '(?:[a-zA-Z_][a-zA-Z0-9_]*|"[^"]+")';

// ── MATERIALIZED CTE types ──────────────────────────────────────

/**
 * Represents the materialization hint for a single CTE.
 */
export interface CteMaterializationInfo {
  name: string;
  materialized: boolean | null; // true=MATERIALIZED, false=NOT MATERIALIZED, null=no hint
}

/**
 * Extract list of CTE names with their MATERIALIZED/NOT MATERIALIZED hints from a WITH clause.
 *
 * Parses the CTE list after `WITH [RECURSIVE]` by scanning CTE definitions:
 *   name [[NOT] MATERIALIZED] (body_expr) [, ...]
 *
 * Uses paren-balancing to skip past subquery bodies.
 *
 * @example
 * ```ts
 * extractCteMaterialization('WITH x AS MATERIALIZED (SELECT 1), y AS NOT MATERIALIZED (SELECT 2) SELECT * FROM x, y')
 * // → [{ name: 'x', materialized: true }, { name: 'y', materialized: false }]
 * ```
 */
export function extractCteMaterialization(sql: string): CteMaterializationInfo[] {
  const result: CteMaterializationInfo[] = [];

  // Find WITH [RECURSIVE]
  const withMatch = sql.match(/^\s*WITH\s+(?:RECURSIVE\s+)?/i);
  if (!withMatch) return result;

  const afterWith = sql.substring(withMatch[0].length);

  // Scan CTE definitions from the CTE list
  let pos = 0;
  while (pos < afterWith.length) {
    // Skip whitespace
    while (pos < afterWith.length && /\s/.test(afterWith[pos])) pos++;
    if (pos >= afterWith.length) break;

    // CTE name
    const nameMatch = afterWith.substring(pos).match(/^([a-zA-Z_][a-zA-Z0-9_]*|"[^"]+")/);
    if (!nameMatch) break;

    const cteName = nameMatch[1].replace(/^"|"$/g, ''); // strip quotes
    pos += nameMatch[0].length;

    // Skip optional AS keyword
    const asMatch = afterWith.substring(pos).match(/^\s+(?:AS\s+)?/i);
    if (asMatch) pos += asMatch[0].length;

    // Check for [NOT] MATERIALIZED
    let materialized: boolean | null = null;
    const matMatch = afterWith.substring(pos).match(/^\s*(?:NOT\s+)?MATERIALIZED\b/i);
    if (matMatch) {
      const matched = matMatch[0].trim().toUpperCase();
      materialized = matched !== 'NOT MATERIALIZED';
      pos += matMatch[0].length;
    }

    result.push({ name: cteName, materialized });

    // Skip whitespace before opening paren
    while (pos < afterWith.length && /\s/.test(afterWith[pos])) pos++;

    // Balance parens to skip past the CTE body
    if (pos < afterWith.length && afterWith[pos] === '(') {
      let depth = 1;
      pos++;
      while (pos < afterWith.length && depth > 0) {
        if (afterWith[pos] === '(') depth++;
        else if (afterWith[pos] === ')') depth--;
        pos++;
      }
    } else {
      break; // malformed CTE
    }

    // Skip to next CTE or end
    while (pos < afterWith.length && /\s/.test(afterWith[pos])) pos++;
    if (pos < afterWith.length && afterWith[pos] === ',') {
      pos++;
    } else {
      break; // no more CTEs
    }
  }

  return result;
}

// ── Detection ────────────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains a WITH clause (CTE).
 *
 * Matches `WITH` or `WITH RECURSIVE` followed by a valid CTE name and `AS (`.
 * Case-insensitive across multiple lines.
 *
 * @example
 * ```ts
 * detectCte('WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t'); // true
 * detectCte('SELECT * FROM users');                           // false
 * ```
 */
export function detectCte(sql: string): boolean {
  // Detect on literal-protected SQL so a WITH token inside a string/comment is
  // never reported (BUG #101).
  const protectedSql = protectSQL(sql).protectedSql;
  const pattern = new RegExp(
    `\\bWITH\\s+(?:RECURSIVE\\s+)?${IDENT}\\s+AS\\s*\\(`,
    'i',
  );
  const result = pattern.test(protectedSql);
  logger.debug({ hasCte: result }, 'detectCte');
  return result;
}

/**
 * Detect whether a SQL statement contains a `WITH RECURSIVE` clause.
 *
 * @example
 * ```ts
 * detectRecursiveCte('WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t'); // true
 * detectRecursiveCte('WITH t AS (SELECT 1) SELECT * FROM t');           // false
 * ```
 */
export function detectRecursiveCte(sql: string): boolean {
  // Detect on literal-protected SQL so a WITH RECURSIVE token inside a
  // string/comment is never reported (BUG #101).
  const protectedSql = protectSQL(sql).protectedSql;
  const pattern = new RegExp(
    `\\bWITH\\s+RECURSIVE\\s+${IDENT}\\s+AS\\s*\\(`,
    'i',
  );
  const result = pattern.test(protectedSql);
  logger.debug({ hasRecursiveCte: result }, 'detectRecursiveCte');
  return result;
}

// ── Rewriting ────────────────────────────────────────────────────

/**
 * Strip PostgreSQL-specific CTE extensions to produce SQLite-compatible SQL.
 *
 * **Transformations applied:**
 * 1. `AS MATERIALIZED` / `AS NOT MATERIALIZED` → `AS`
 * 2. `) SEARCH {DEPTH|BREADTH} FIRST BY ... SET colname` → `)`
 * 3. `) CYCLE col SET mark TO 'val' [DEFAULT 'val']` → `)`
 *
 * When both SEARCH and CYCLE appear after the same CTE body (in either order),
 * both clauses are removed through an iterative loop (at most 2 iterations).
 *
 * If no PG extensions are found, the original SQL is returned as-is with
 * `rewritten: false`.
 *
 * @example
 * ```ts
 * // MATERIALIZED
 * rewriteCte('WITH cte AS MATERIALIZED (SELECT 1) SELECT * FROM cte');
 * // → { sql: 'WITH cte AS (SELECT 1) SELECT * FROM cte', rewritten: true }
 *
 * // SEARCH clause
 * rewriteCte(
 *   'WITH RECURSIVE cte AS (SELECT 1 UNION ALL SELECT n+1 FROM cte WHERE n<10) SEARCH DEPTH FIRST BY n SET ordering SELECT * FROM cte'
 * );
 * // → { sql: 'WITH RECURSIVE cte AS (...)', rewritten: true }
 *
 * // CYCLE clause
 * rewriteCte(
 *   "WITH RECURSIVE cte AS (...) CYCLE n SET is_cycle TO '1' DEFAULT '0' SELECT * FROM cte"
 * );
 * // → { sql: 'WITH RECURSIVE cte AS (...)', rewritten: true }
 *
 * // No PG extensions → unchanged
 * rewriteCte('WITH cte AS (SELECT 1) SELECT * FROM cte');
 * // → { sql: 'WITH cte AS (SELECT 1) SELECT * FROM cte', rewritten: false }
 * ```
 */
export function rewriteCte(sql: string): CteRewriteResult {
  const original = sql;

  // Protect literals/comments so the SEARCH/CYCLE/MATERIALIZED matchers never
  // rewrite a token inside a string literal or comment (BUG #102/#103/#104).
  // restoreSQL at the end maps placeholders back to the original text.
  const prot = protectSQL(sql);
  let current = prot.protectedSql;
  let modified = false;

  // ── Step 1: Remove MATERIALIZED / NOT MATERIALIZED ────────────────
  // Parse all CTE names and their materialization hints, then strip them.
  // SQLite does not recognize MATERIALIZED/NOT MATERIALIZED keywords, so we
  // must remove them. However, we log each occurrence (with CTE name) to
  // preserve the information for future query optimization.

  // First, extract and log materialization info
  const cteInfos = extractCteMaterialization(current);
  for (const info of cteInfos) {
    if (info.materialized === true) {
      logger.debug({ cteName: info.name }, 'CTE "%s" is MATERIALIZED', info.name);
    } else if (info.materialized === false) {
      logger.debug({ cteName: info.name }, 'CTE "%s" is NOT MATERIALIZED', info.name);
    }
  }

  // Then strip MATERIALIZED / NOT MATERIALIZED keywords
  const step1 = current.replace(
    /\bAS\s+(?:NOT\s+)?MATERIALIZED\s+(?=\()/gi,
    'AS ',
  );
  if (step1 !== current) {
    modified = true;
  }
  current = step1;

  // ── Step 2: Remove SEARCH and CYCLE clauses ──────────────────────
  // These appear after the closing `)` of a CTE query body.
  // They may appear in either order: `) SEARCH ... CYCLE ...` or `) CYCLE ... SEARCH ...`
  // An iterative loop ensures both are caught regardless of order.
  //
  // CYCLE's `TO 'val'` / `DEFAULT 'val'` string literals are themselves part of
  // the CYCLE statement syntax, so after protectSQL they appear as __LIT_N__
  // placeholders; the CYCLE matcher therefore anchors on those placeholders
  // rather than on a quoted literal.

  const SEARCH_RE = new RegExp(
    `\\)\\s+SEARCH\\s+(?:DEPTH|BREADTH)\\s+FIRST\\s+BY\\s+[\\s\\S]+?\\s+SET\\s+${IDENT}`,
    'gi',
  );

  const CYCLE_RE = new RegExp(
    `\\)\\s+CYCLE\\s+${IDENT}\\s+SET\\s+${IDENT}\\s+TO\\s+__LIT_\\d+__(?:\\s+DEFAULT\\s+__LIT_\\d+__)?`,
    'gi',
  );

  let prev: string;
  let loopCount = 0;
  const MAX_ITERATIONS = 5; // Safety limit, should never need > 2

  do {
    prev = current;

    // Try removing SEARCH clause(s)
    if (SEARCH_RE.test(current)) {
      SEARCH_RE.lastIndex = 0;
      current = current.replace(SEARCH_RE, ')');
    }

    // Try removing CYCLE clause(s)
    if (CYCLE_RE.test(current)) {
      CYCLE_RE.lastIndex = 0;
      current = current.replace(CYCLE_RE, ')');
    }

    loopCount++;
    if (loopCount >= MAX_ITERATIONS) {
      logger.warn(
        { loopCount: MAX_ITERATIONS },
        'SEARCH/CYCLE rewrite hit iteration limit — possible invalid pattern',
      );
      break;
    }
  } while (current !== prev);

  if (current !== step1) {
    modified = true;
    logger.debug('Removed SEARCH and/or CYCLE clauses');
  }

  // ── Result ──────────────────────────────────────────────────────
  if (modified) {
    logger.info({ rewritten: true }, 'CTE rewrite applied');
  } else {
    logger.debug({ rewritten: false }, 'No CTE rewrite needed');
  }

  return {
    sql: restoreSQL({ ...prot, protectedSql: current }),
    rewritten: modified,
  };
}
