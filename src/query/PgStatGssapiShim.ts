/**
 * PgStatGssapiShim — PostgreSQL pg_stat_gssapi view compatibility shim (PG 16+)
 *
 * pg_stat_gssapi provides GSSAPI authentication metrics per connection.
 * Since SQLite does not use GSSAPI authentication, this shim returns
 * zero/empty data for all columns.
 *
 * Columns returned:
 *   - pid (int4)                → 0
 *   - gss_authenticated (bool)  → false
 *   - principal (text)          → NULL
 *   - encrypted (bool)          → false
 *   - credentials_delegated (bool) → false
 *
 * Usage:
 *   SELECT * FROM pg_stat_gssapi;
 *   → single row with zero/empty defaults
 */

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('pg-stat-gssapi');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/**
 * The static VALUES clause representing pg_stat_gssapi.
 * All counters are zero/false/NULL.
 */
const PG_STAT_GSSAPI_VALUES =
  `SELECT 0 AS pid, 0 AS gss_authenticated, NULL AS principal, ` +
  `0 AS encrypted, 0 AS credentials_delegated`;

/**
 * Regex to detect pg_stat_gssapi reference.
 */
const PG_STAT_GSSAPI_PATTERN = /\bpg_stat_gssapi\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL references the pg_stat_gssapi view.
 */
export function detectPgStatGssapi(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return PG_STAT_GSSAPI_PATTERN.test(sql);
}

/**
 * Rewrite a reference to pg_stat_gssapi into a VALUES clause returning
 * zero/empty GSSAPI authentication metrics.
 *
 * For `SELECT * FROM pg_stat_gssapi`, the table reference is replaced
 * with a derived table (VALUES clause) producing a single row with zero
 * defaults.
 *
 * For column-specific SELECT, the rewrite works similarly since all
 * columns are present in the subquery.
 */
export function rewritePgStatGssapi(sql: string): string {
  if (!detectPgStatGssapi(sql)) {
    return sql;
  }

  // Replace pg_stat_gssapi table reference with the VALUES subquery
  // Protect string literals and comments so a `pg_stat_gssapi` token inside
  // them is never rewritten as a table reference.
  const protectedSql = protectSQL(sql);
  const rewrittenSql = protectedSql.protectedSql.replace(
    /\bpg_stat_gssapi\b/gi,
    `(${PG_STAT_GSSAPI_VALUES})`,
  );
  const restoredSql = restoreSQL({ ...protectedSql, protectedSql: rewrittenSql });

  if (restoredSql !== sql) {
    logger.debug(
      { original: sql, rewritten: restoredSql },
      'pg_stat_gssapi query rewritten to VALUES clause',
    );
  }

  return restoredSql;
}
