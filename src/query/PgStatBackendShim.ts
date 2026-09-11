/**
 * PgStatBackendShim — backend IDs set-returning function shim.
 *
 * pg_stat_get_backend_idset() returns a set of backend IDs currently active.
 * Since this is a single-node SQLite-backed PG-compatible system, there are
 * no real "backends" in the PG sense — return an empty set.
 *
 * Rewrite:
 *   SELECT * FROM pg_stat_get_backend_idset()
 *   → SELECT 0 WHERE 1=0
 *
 * This produces 0 rows with a single column, matching the expected call
 * signature (set of int4).
 */

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('pg-stat-backend');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/**
 * Pattern to detect pg_stat_get_backend_idset() function call.
 */
const PG_STAT_BACKEND_IDSET_PATTERN = /pg_stat_get_backend_idset\s*\(/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL references pg_stat_get_backend_idset().
 */
export function detectPgStatBackend(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return PG_STAT_BACKEND_IDSET_PATTERN.test(sql);
}

/**
 * Rewrite pg_stat_get_backend_idset() call to return empty set.
 *
 * The function call (e.g., `SELECT * FROM pg_stat_get_backend_idset()`) is
 * replaced with a subquery that returns 0 rows: `SELECT 0 WHERE 1=0`.
 */
export function rewritePgStatBackend(sql: string): string {
  if (!detectPgStatBackend(sql)) {
    return sql;
  }

  // Replace pg_stat_get_backend_idset() (with optional whitespace in parens)
  // with (SELECT 0 WHERE 1=0) for an empty set result. String literals and
  // comments are protected so a token inside them is never rewritten.
  const protectedSql = protectSQL(sql);
  const rewrittenSql = protectedSql.protectedSql.replace(
    /pg_stat_get_backend_idset\s*\(\s*\)/gi,
    '(SELECT 0 WHERE 1=0)',
  );
  const restoredSql = restoreSQL({ ...protectedSql, protectedSql: rewrittenSql });

  if (restoredSql !== sql) {
    logger.debug(
      { original: sql, rewritten: restoredSql },
      'pg_stat_get_backend_idset() query rewritten to empty set',
    );
  }

  return restoredSql;
}
