/**
 * TableStatementShim — Rewrites PostgreSQL `TABLE tab` shorthand to `SELECT * FROM tab`.
 *
 * PostgreSQL supports `TABLE tablename` as shorthand for `SELECT * FROM tablename`.
 * This also supports optional ORDER BY, LIMIT, OFFSET, and aliases:
 *
 * @example
 * ```sql
 * TABLE users;                           → SELECT * FROM users
 * TABLE public.users;                    → SELECT * FROM public.users
 * TABLE users ORDER BY id DESC;          → SELECT * FROM users ORDER BY id DESC
 * TABLE users LIMIT 10;                  → SELECT * FROM users LIMIT 10
 * TABLE users OFFSET 5 LIMIT 10;         → SELECT * FROM users OFFSET 5 LIMIT 10
 * TABLE users AS u;                      → SELECT * FROM users AS u
 * TABLE users ORDER BY name LIMIT 5;     → SELECT * FROM users ORDER BY name LIMIT 5
 * ```
 *
 * This shim runs early in the query pipeline, before any other processing,
 * so the rest of the engine sees a regular SELECT statement.
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('TableStatementShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface TableStatementResult {
  /** Rewritten SQL (`SELECT * FROM …`) or original if not a TABLE statement */
  sql: string;
  /** Whether a TABLE statement was detected and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants – Regex patterns
// ──────────────────────────────────────────────

/**
 * Detects `TABLE` as the first keyword in a SQL statement.
 *
 * This is safe because in PostgreSQL, `TABLE` at statement start is
 * exclusively the shorthand syntax — never a DDL/Grant/Comment keyword.
 *
 * Matches:
 *   TABLE tablename …
 *   TABLE schema.tablename …
 */
const TABLE_START_PATTERN = /^\s*TABLE\s+/i;

/**
 * Captures everything after `TABLE <whitespace>` for the rewrite.
 *
 * Group 1: the full table reference with any trailing clauses
 *   (ORDER BY, LIMIT, OFFSET, alias, semicolon, etc.)
 */
const TABLE_CAPTURE_PATTERN = /^\s*TABLE\s+(.+)$/is;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL is a PostgreSQL TABLE shorthand statement.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL starts with `TABLE` as its first keyword
 *
 * @example
 * ```ts
 * detectTableStatement('TABLE users');               // true
 * detectTableStatement('TABLE users ORDER BY id');   // true
 * detectTableStatement('SELECT * FROM users');       // false
 * detectTableStatement('GRANT SELECT ON TABLE x TO r'); // false
 * ```
 */
export function detectTableStatement(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  // Fast prefix check before regex
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('TABLE ')) {
    return false;
  }

  // Confirm with word-boundary-aware regex
  return TABLE_START_PATTERN.test(trimmed);
}

/**
 * Rewrite a PostgreSQL TABLE shorthand statement to a standard SELECT query.
 *
 * In PostgreSQL the `TABLE` command accepts:
 *   TABLE name [ WITH ( … ) ]
 *
 * SqlVec DB only needs the common form:
 *   TABLE tablename [AS alias] [ORDER BY …] [LIMIT …] [OFFSET …]
 *
 * @param sql   The raw SQL string to process
 * @returns     A TableStatementResult with the rewritten SQL
 *
 * @example
 * ```ts
 * rewriteTableStatement('TABLE users');
 * // → { sql: 'SELECT * FROM users', rewritten: true }
 *
 * rewriteTableStatement('TABLE users LIMIT 5');
 * // → { sql: 'SELECT * FROM users LIMIT 5', rewritten: true }
 *
 * rewriteTableStatement('SELECT 1');
 * // → { sql: 'SELECT 1', rewritten: false }
 * ```
 */
export function rewriteTableStatement(sql: string): TableStatementResult {
  if (!detectTableStatement(sql)) {
    return { sql, rewritten: false };
  }

  const match = sql.trim().match(TABLE_CAPTURE_PATTERN);
  if (!match || !match[1] || match[1].trim().length === 0) {
    // `TABLE` with no following identifier — pass through as-is
    logger.warn({ sql: sql.trim() }, 'TABLE statement with no table name — passthrough');
    return { sql: sql.trim(), rewritten: false };
  }

  const rest = match[1].trim();
  const rewrittenSql = `SELECT * FROM ${rest}`;

  logger.debug(
    { original: sql.trim(), rewritten: rewrittenSql },
    'TABLE statement rewritten to SELECT',
  );

  return { sql: rewrittenSql, rewritten: true };
}
