/**
 * PgStatCheckpointerShim — PostgreSQL pg_stat_checkpointer view compatibility shim (PG 16+)
 *
 * pg_stat_checkpointer provides checkpointer statistics, replacing pg_stat_bgwriter
 * in PostgreSQL 16. Since SQLite uses WAL and does not have a separate checkpointer
 * process, this shim returns plausible-zero/empty data.
 *
 * Columns returned:
 *   - num_timed (int8)           → 0
 *   - num_requested (int8)       → 0
 *   - write_count (int8)         → 0
 *   - write_time (float8)        → 0.0
 *   - sync_count (int8)          → 0
 *   - sync_time (float8)         → 0.0
 *   - total_write_count (int8)   → 0
 *   - total_write_time (float8)  → 0.0
 *   - total_sync_count (int8)    → 0
 *   - total_sync_time (float8)   → 0.0
 *   - stats_reset (timestamptz)  → NULL
 *
 * Usage:
 *   SELECT * FROM pg_stat_checkpointer;
 *   → single row with zero/empty defaults
 */

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('pg-stat-checkpointer');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/**
 * The static VALUES clause representing pg_stat_checkpointer.
 * All counters are zero and stats_reset is NULL.
 */
const PG_STAT_CHECKPOINTER_VALUES =
  `SELECT 0 AS num_timed, 0 AS num_requested, 0 AS write_count, ` +
  `0.0 AS write_time, 0 AS sync_count, 0.0 AS sync_time, ` +
  `0 AS total_write_count, 0.0 AS total_write_time, ` +
  `0 AS total_sync_count, 0.0 AS total_sync_time, NULL AS stats_reset`;

/**
 * Regex to detect pg_stat_checkpointer reference.
 */
const PG_STAT_CHECKPOINTER_PATTERN = /\bpg_stat_checkpointer\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL references the pg_stat_checkpointer view.
 */
export function detectPgStatCheckpointer(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return PG_STAT_CHECKPOINTER_PATTERN.test(sql);
}

/**
 * Rewrite a reference to pg_stat_checkpointer into a VALUES clause
 * returning plausible-zero checkpointer statistics.
 *
 * For `SELECT * FROM pg_stat_checkpointer`, the table reference is
 * replaced with a derived table (VALUES clause) producing a single row
 * with zero defaults.
 *
 * For column-specific SELECT, the rewrite works similarly since all
 * columns are present in the subquery.
 */
export function rewritePgStatCheckpointer(sql: string): string {
  if (!detectPgStatCheckpointer(sql)) {
    return sql;
  }

  // Replace pg_stat_checkpointer table reference with the VALUES subquery
  // Protect string literals and comments so a `pg_stat_checkpointer` token inside
  // them is never rewritten as a table reference.
  const protectedSql = protectSQL(sql);
  const rewrittenSql = protectedSql.protectedSql.replace(
    /\bpg_stat_checkpointer\b/gi,
    `(${PG_STAT_CHECKPOINTER_VALUES})`,
  );
  const restoredSql = restoreSQL({ ...protectedSql, protectedSql: rewrittenSql });

  if (restoredSql !== sql) {
    logger.debug(
      { original: sql, rewritten: restoredSql },
      'pg_stat_checkpointer query rewritten to VALUES clause',
    );
  }

  return restoredSql;
}
