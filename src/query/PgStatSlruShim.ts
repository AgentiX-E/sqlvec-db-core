/**
 * PgStatSlruShim — PostgreSQL pg_stat_slru view compatibility shim (PG 16+)
 *
 * pg_stat_slru provides SLRU (Least Recently Used) cache statistics for
 * various internal PG subsystems (clog, commit_ts, subtrans, multixact,
 * etc.). Since SQLite does not have these SLRU caches, this shim returns
 * zero/empty data.
 *
 * Columns returned:
 *   - name (text)        → 'pg_stat_slru'
 *   - blks_zeroed (int8) → 0
 *   - blks_hit (int8)    → 0
 *   - blks_read (int8)   → 0
 *   - blks_written (int8)→ 0
 *   - blks_exists (int8) → 0
 *   - flushes (int8)     → 0
 *   - truncates (int8)   → 0
 *   - stats_reset (timestamptz) → NULL
 *
 * Usage:
 *   SELECT * FROM pg_stat_slru;
 *   → single row with zero defaults
 */

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('pg-stat-slru');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/**
 * The static VALUES clause representing pg_stat_slru.
 * All counters are zero, name is a static placeholder, and stats_reset is NULL.
 */
const PG_STAT_SLRU_VALUES =
  `SELECT 'pg_stat_slru' AS name, 0 AS blks_zeroed, ` +
  `0 AS blks_hit, 0 AS blks_read, 0 AS blks_written, ` +
  `0 AS blks_exists, 0 AS flushes, 0 AS truncates, NULL AS stats_reset`;

/**
 * Regex to detect pg_stat_slru reference.
 */
const PG_STAT_SLRU_PATTERN = /\bpg_stat_slru\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL references the pg_stat_slru view.
 */
export function detectPgStatSlru(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return PG_STAT_SLRU_PATTERN.test(sql);
}

/**
 * Rewrite a reference to pg_stat_slru into a VALUES clause returning
 * zero/empty SLRU cache statistics.
 *
 * For `SELECT * FROM pg_stat_slru`, the table reference is replaced
 * with a derived table (VALUES clause) producing a single row with zero
 * defaults.
 *
 * For column-specific SELECT, the rewrite works similarly since all
 * columns are present in the subquery.
 */
export function rewritePgStatSlru(sql: string): string {
  if (!detectPgStatSlru(sql)) {
    return sql;
  }

  // Replace pg_stat_slru table reference with the VALUES subquery
  // Protect string literals and comments so a `pg_stat_slru` token inside
  // them is never rewritten as a table reference.
  const protectedSql = protectSQL(sql);
  const rewrittenSql = protectedSql.protectedSql.replace(
    /\bpg_stat_slru\b/gi,
    `(${PG_STAT_SLRU_VALUES})`,
  );
  const restoredSql = restoreSQL({ ...protectedSql, protectedSql: rewrittenSql });

  if (restoredSql !== sql) {
    logger.debug(
      { original: sql, rewritten: restoredSql },
      'pg_stat_slru query rewritten to VALUES clause',
    );
  }

  return restoredSql;
}
