/**
 * CitextShim — PostgreSQL citext (case-insensitive text) compatibility shim.
 *
 * PostgreSQL's citext extension provides a case-insensitive text type where
 * `=`, `<>`, and `LIKE` comparisons are performed case-insensitively.
 *
 * In SQLite, we implement this via:
 * 1. SQL-level rewriting: replace `col op expr` with `LOWER(col) op LOWER(expr)`
 *    for citext columns when the operator is `=`, `<>`, or `LIKE`.
 * 2. DDL rewriting: `CITEXT` → `TEXT` (type alias)
 *
 * ## Usage
 *
 * ```ts
 * import { detectCitext, rewriteCitextSql } from './CitextShim';
 *
 * const r = rewriteCitextSql(
 *   "SELECT * FROM t WHERE name = 'Hello'",
 *   ['name'],               // citext columns
 * );
 * // → { sql: "SELECT * FROM t WHERE LOWER(name) = LOWER('Hello')", rewritten: true }
 * ```
 *
 * ## Type registration
 *
 * Register `CITEXT → TEXT` in the system type registry so DDL passes through.
 *
 * ## Operator rewriting
 *
 * | Operator | Rewritten to   |
 * |----------|----------------|
 * | `=`      | LOWER(a) = LOWER(b) |
 * | `<>`     | LOWER(a) <> LOWER(b) |
 * | `!=`     | LOWER(a) != LOWER(b) |
 * | `LIKE`   | LOWER(a) LIKE LOWER(b) |
 *
 * @module query/CitextShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('CitextShim');

// ── Types ────────────────────────────────────────────────────────

export interface CitextRewriteResult {
  sql: string;
  rewritten: boolean;
}

// ── DDL rewriting ────────────────────────────────────────────────

/**
 * Rewrite DDL to replace CITEXT type keyword with TEXT.
 *
 * Handles: `col CITEXT` → `col TEXT`
 *
 * @param sql - Raw SQL DDL statement.
 * @returns Rewritten SQL with CITEXT → TEXT.
 */
export function rewriteCitextType(sql: string): string {
  // Protect string literals, quoted identifiers, and comments so a `CITEXT`
  // token inside them (e.g. `SELECT 'CITEXT'`) is never rewritten to TEXT.
  const protectedSql = protectSQL(sql);
  const rewritten = protectedSql.protectedSql.replace(/\bCITEXT\b/gi, 'TEXT');
  return restoreSQL({ ...protectedSql, protectedSql: rewritten });
}

// ── Operator rewriting ───────────────────────────────────────────

/**
 * Rewrite comparison operators against citext columns to use LOWER() wrapping.
 *
 * For each citext column name in the SQL, replace:
 *   `col = expr`  → `LOWER(col) = LOWER(expr)`
 *   `col <> expr` → `LOWER(col) <> LOWER(expr)`
 *   `col LIKE expr` → `LOWER(col) LIKE LOWER(expr)`
 *
 * The `citextColumns` parameter identifies which columns citext-typed columns.
 *
 * **Limitation**: This is a regex-based rewrite.  It handles common patterns
 * but may miss column references in subqueries, CTEs, or function arguments.
 *
 * @param sql           - Raw SQL to rewrite.
 * @param citextColumns - Column names that are citext-typed.
 * @returns Rewrite result.
 */
export function rewriteCitextComparisons(
  sql: string,
  citextColumns: string[],
): CitextRewriteResult {
  if (!sql || typeof sql !== 'string' || citextColumns.length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  const columnPatterns = citextColumns.map(col =>
    escapeRegex(col),
  );

  let result = sql;

  for (const colPattern of columnPatterns) {
    // Pattern 1: col = expr  →  LOWER(col) = LOWER(expr)
    // This regex matches: column_name followed by =, then captures the RHS expression
    // ending at a keyword boundary or end-of-string.
    result = result.replace(
      new RegExp(
        `\\b(${colPattern})\\s*=\\s*('[^']*'|[^\\s,;)]+)(?=\\s+(?:AND|OR|WHERE|ORDER|GROUP|LIMIT|HAVING|SET|RETURNING|OFFSET|FETCH)|\\s*[,;)]|$)`,
        'gi',
      ),
      (_match, col, expr) => `LOWER(${col}) = LOWER(${expr})`,
    );

    // Pattern 2: col <> expr → LOWER(col) <> LOWER(expr)
    result = result.replace(
      new RegExp(
        `\\b(${colPattern})\\s*<>\\s*('[^']*'|[^\\s,;)]+)(?=\\s+(?:AND|OR|WHERE|ORDER|GROUP|LIMIT|HAVING|SET|RETURNING|OFFSET|FETCH)|\\s*[,;)]|$)`,
        'gi',
      ),
      (_match, col, expr) => `LOWER(${col}) <> LOWER(${expr})`,
    );

    // Pattern 3: col != expr → LOWER(col) != LOWER(expr)
    result = result.replace(
      new RegExp(
        `\\b(${colPattern})\\s*!=\\s*('[^']*'|[^\\s,;)]+)(?=\\s+(?:AND|OR|WHERE|ORDER|GROUP|LIMIT|HAVING|SET|RETURNING|OFFSET|FETCH)|\\s*[,;)]|$)`,
        'gi',
      ),
      (_match, col, expr) => `LOWER(${col}) != LOWER(${expr})`,
    );

    // Pattern 4: col LIKE expr → LOWER(col) LIKE LOWER(expr)
    result = result.replace(
      new RegExp(
        `\\b(${colPattern})\\s+LIKE\\s+('[^']*'|[^\\s,;)]+)(?=\\s+(?:AND|OR|WHERE|ORDER|GROUP|LIMIT|HAVING|SET|RETURNING|OFFSET|FETCH)|\\s*[,;)]|$)`,
        'gi',
      ),
      (_match, col, expr) => `LOWER(${col}) LIKE LOWER(${expr})`,
    );
  }

  const rewritten = result !== sql;
  if (rewritten) {
    logger.debug({ original: sql, rewritten: result, citextColumns }, 'Rewrote citext comparisons');
  }

  return { sql: result, rewritten };
}

/**
 * Full pipeline: type alias + comparison rewrites.
 */
export function rewriteCitextSql(sql: string, citextColumns: string[]): CitextRewriteResult {
  const typeResult = rewriteCitextType(sql);
  if (typeResult !== sql) {
    // DDL path — just rewrite type
    return { sql: typeResult, rewritten: true };
  }
  return rewriteCitextComparisons(sql, citextColumns);
}

/**
 * Detect CITEXT in SQL.
 */
export function detectCitextType(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  const cleaned = sql.replace(/'[^']*'/g, '').replace(/--[^\n]*/g, '');
  return /\bCITEXT\b/i.test(cleaned);
}

// ── Helpers ──────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { logger };
