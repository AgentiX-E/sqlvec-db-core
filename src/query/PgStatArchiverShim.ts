/**
 * PgStatArchiverShim — PostgreSQL pg_stat_archiver view compatibility shim (PG 16+)
 *
 * pg_stat_archiver provides statistics about WAL archiving activity.
 * Since SQLite does not have a WAL archiver in the PostgreSQL sense,
 * this shim returns zero/empty data.
 *
 * Columns returned:
 *   - archived_count (int8)       → 0
 *   - last_archived_wal (text)    → NULL
 *   - last_archived_time (timestamptz) → NULL
 *   - failed_count (int8)        → 0
 *   - last_failed_wal (text)     → NULL
 *   - last_failed_time (timestamptz) → NULL
 *   - stats_reset (timestamptz)  → NULL
 *
 * Usage:
 *   SELECT * FROM pg_stat_archiver;
 *   → single row with zero/empty defaults
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('pg-stat-archiver');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/**
 * The static VALUES clause representing pg_stat_archiver.
 * All counters are zero, and timestamp/text columns are NULL.
 */
const PG_STAT_ARCHIVER_VALUES =
  `SELECT 0 AS archived_count, NULL AS last_archived_wal, NULL AS last_archived_time, ` +
  `0 AS failed_count, NULL AS last_failed_wal, NULL AS last_failed_time, NULL AS stats_reset`;

/**
 * Regex to detect pg_stat_archiver reference.
 */
const PG_STAT_ARCHIVER_PATTERN = /\bpg_stat_archiver\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL references the pg_stat_archiver view.
 */
export function detectPgStatArchiver(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return PG_STAT_ARCHIVER_PATTERN.test(sql);
}

/**
 * Rewrite a reference to pg_stat_archiver into a VALUES clause returning
 * zero/empty archiver statistics.
 *
 * For `SELECT * FROM pg_stat_archiver`, the table reference is replaced
 * with a derived table (VALUES clause) producing a single row with zero
 * defaults.
 *
 * For column-specific SELECT, the rewrite works similarly since all
 * columns are present in the subquery.
 */
export function rewritePgStatArchiver(sql: string): string {
  if (!detectPgStatArchiver(sql)) {
    return sql;
  }

  // Replace pg_stat_archiver table reference with the VALUES subquery
  const rewrittenSql = sql.replace(
    /\bpg_stat_archiver\b/gi,
    `(${PG_STAT_ARCHIVER_VALUES})`,
  );

  if (rewrittenSql !== sql) {
    logger.debug(
      { original: sql, rewritten: rewrittenSql },
      'pg_stat_archiver query rewritten to VALUES clause',
    );
  }

  return rewrittenSql;
}
