/**
 * PgStatIoShim — PostgreSQL pg_stat_io view compatibility shim (PG 16+)
 *
 * pg_stat_io provides I/O statistics per backend type, object type, and context.
 * Since SQLite does not have the same I/O infrastructure as PostgreSQL,
 * this shim returns plausible-zero/empty data.
 *
 * Columns returned:
 *   - backend_type (text) → 'client_backend'
 *   - object (text)      → 'relation'
 *   - context (text)     → 'normal'
 *   - reads (int8)       → 0
 *   - writes (int8)      → 0
 *   - extends (int8)     → 0
 *   - op_bytes (int8)    → 8192
 *   - hits (int8)        → 0
 *   - evictions (int8)   → 0
 *   - fsyncs (int8)      → 0
 *
 * Usage:
 *   SELECT * FROM pg_stat_io;
 *   → single row with zero/plausible defaults
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('pg-stat-io');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/**
 * The static VALUES clause representing pg_stat_io.
 * All counters are zero/sensible-default, and backend type, object type,
 * and context are statically set to the most common values.
 */
const PG_STAT_IO_VALUES = `SELECT 'client_backend' AS backend_type, 'relation' AS object, 'normal' AS context, 0 AS reads, 0 AS writes, 0 AS extends, 8192 AS op_bytes, 0 AS hits, 0 AS evictions, 0 AS fsyncs`;

/**
 * Regex to detect SELECT from pg_stat_io.
 */
const PG_STAT_IO_PATTERN = /\bpg_stat_io\b/i;

/**
 * Pattern to detect "SELECT * FROM pg_stat_io" specifically.
 */
const PG_STAT_IO_SELECT_PATTERN = /SELECT\s+.+\bFROM\s+pg_stat_io\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL references the pg_stat_io view.
 */
export function detectPgStatIo(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return PG_STAT_IO_PATTERN.test(sql);
}

/**
 * Rewrite a reference to pg_stat_io into a VALUES clause returning
 * plausible-zero I/O statistics.
 *
 * For `SELECT * FROM pg_stat_io`, the entire query is replaced with
 * the static VALUES clause that produces a single row with default values.
 *
 * For column-specific SELECT, the rewrite produces the same result.
 */
export function rewritePgStatIo(sql: string): string {
  if (!detectPgStatIo(sql)) {
    return sql;
  }

  // Handle SELECT ... FROM pg_stat_io
  if (PG_STAT_IO_SELECT_PATTERN.test(sql)) {
    // Extract column list for column-specific queries
    // Since all columns are provided in the VALUES clause, we can
    // use a subquery approach: (SELECT ... ) AS pg_stat_io
    // This preserves column-selection when present.

    // Replace pg_stat_io table reference with the VALUES subquery
    let rewrittenSql = sql.replace(
      /\bpg_stat_io\b/gi,
      `(${PG_STAT_IO_VALUES})`,
    );

    // If this is a standalone query (not a CTE or subquery reference),
    // clean up any double parentheses
    if (rewrittenSql !== sql) {
      logger.debug(
        { original: sql, rewritten: rewrittenSql },
        'pg_stat_io query rewritten to VALUES clause',
      );
    }

    return rewrittenSql;
  }

  // Non-SELECT references to pg_stat_io (e.g., in subqueries)
  let rewrittenSql = sql.replace(
    /\bpg_stat_io\b/gi,
    `(${PG_STAT_IO_VALUES})`,
  );

  if (rewrittenSql !== sql) {
    logger.debug(
      { original: sql, rewritten: rewrittenSql },
      'pg_stat_io reference rewritten',
    );
  }

  return rewrittenSql;
}
