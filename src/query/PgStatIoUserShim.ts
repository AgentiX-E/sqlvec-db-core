/**
 * PgStatIoUserShim — PostgreSQL pg_statio_user_tables / pg_statio_user_indexes
 * view compatibility shim (PG 16+)
 *
 * These views expose I/O statistics for user tables and indexes at the storage
 * level (heap and index block reads/hits). Since SQLite does not have the same
 * buffer manager / shared-buffer infrastructure as PostgreSQL, this shim returns
 * zero/empty data for all columns.
 *
 * pg_statio_user_tables columns:
 *   relid, schemaname, relname, heap_blks_read, heap_blks_hit,
 *   idx_blks_read, idx_blks_hit, toast_blks_read, toast_blks_hit,
 *   tidx_blks_read, tidx_blks_hit
 *
 * pg_statio_user_indexes columns:
 *   relid, indexrelid, schemaname, relname, indexrelname,
 *   idx_blks_read, idx_blks_hit
 *
 * Usage:
 *   SELECT * FROM pg_statio_user_tables;
 *   → single row with zero defaults
 */

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('pg-stat-io-user');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/**
 * The static VALUES clause representing pg_statio_user_tables.
 * All counters are zero, and identifier columns are empty.
 */
const PG_STATIO_USER_TABLES_VALUES =
  `SELECT 0 AS relid, '' AS schemaname, '' AS relname, ` +
  `0 AS heap_blks_read, 0 AS heap_blks_hit, ` +
  `0 AS idx_blks_read, 0 AS idx_blks_hit, ` +
  `0 AS toast_blks_read, 0 AS toast_blks_hit, ` +
  `0 AS tidx_blks_read, 0 AS tidx_blks_hit`;

/**
 * The static VALUES clause representing pg_statio_user_indexes.
 * All counters are zero, and identifier columns are empty.
 */
const PG_STATIO_USER_INDEXES_VALUES =
  `SELECT 0 AS relid, 0 AS indexrelid, '' AS schemaname, '' AS relname, '' AS indexrelname, ` +
  `0 AS idx_blks_read, 0 AS idx_blks_hit`;

/**
 * Regex to detect pg_statio_user_tables reference.
 */
const PG_STATIO_USER_TABLES_PATTERN = /\bpg_statio_user_tables\b/i;

/**
 * Regex to detect pg_statio_user_indexes reference.
 */
const PG_STATIO_USER_INDEXES_PATTERN = /\bpg_statio_user_indexes\b/i;

/**
 * Combined regex to detect either pg_statio_user_tables or pg_statio_user_indexes.
 */
const PG_STATIO_USER_PATTERN = /\bpg_statio_user_(?:tables|indexes)\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL references pg_statio_user_tables or
 * pg_statio_user_indexes.
 */
export function detectPgStatIoUser(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return PG_STATIO_USER_PATTERN.test(sql);
}

/**
 * Rewrite a reference to pg_statio_user_tables or pg_statio_user_indexes
 * into a VALUES clause returning zero I/O statistics.
 *
 * For `SELECT * FROM pg_statio_user_tables`, the table reference is
 * replaced with a derived table (VALUES clause) producing a single row
 * with zero defaults.
 *
 * For column-specific SELECT, the rewrite works similarly since all
 * columns are present in the subquery.
 */
export function rewritePgStatIoUser(sql: string): string {
  if (!detectPgStatIoUser(sql)) {
    return sql;
  }

  // Protect string literals and comments so a view name inside them is never
  // rewritten as a table reference.
  const protectedSql = protectSQL(sql);

  // Both views may appear in a single query (e.g. a join), so apply each
  // substitution independently rather than an if/else that stops at the first.
  const target = protectedSql.protectedSql;
  const withTablesReplaced = PG_STATIO_USER_TABLES_PATTERN.test(sql)
    ? target.replace(/\bpg_statio_user_tables\b/gi, `(${PG_STATIO_USER_TABLES_VALUES})`)
    : target;
  const withIndexesReplaced = PG_STATIO_USER_INDEXES_PATTERN.test(sql)
    ? withTablesReplaced.replace(/\bpg_statio_user_indexes\b/gi, `(${PG_STATIO_USER_INDEXES_VALUES})`)
    : withTablesReplaced;

  const restoredSql = withIndexesReplaced !== target
    ? restoreSQL({ ...protectedSql, protectedSql: withIndexesReplaced })
    : sql;

  if (restoredSql !== sql) {
    logger.debug(
      { original: sql, rewritten: restoredSql },
      'pg_statio_user_tables/indexes query rewritten to VALUES clause',
    );
  }

  return restoredSql;
}
