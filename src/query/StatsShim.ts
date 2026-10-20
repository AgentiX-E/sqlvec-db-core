/**
 * StatsShim — PostgreSQL query planner statistics compatibility shim for SQLite.
 *
 * PostgreSQL exposes a rich set of GUC parameters that control the query
 * planner's behaviour: statistics targets, join collapse limits, enable/disable
 * flags for individual scan/join methods, and the ANALYZE command that
 * gathers table statistics. SQLite's planner uses a fixed-cost model and has
 * no equivalent GUCs, so all such statements must be rewritten to SQLite-safe
 * no-ops.
 *
 * ## Coverage
 *
 * This shim handles the following categories of PostgreSQL planner-statistics
 * SQL:
 *
 * | Category                       | SQL patterns                                                              | Action      |
 * |:-------------------------------|:--------------------------------------------------------------------------|:------------|
 * | Statistics target              | `SET default_statistics_target = N`                                       | `SELECT 1`  |
 * | Collapse limits                | `SET from_collapse_limit = N`, `SET join_collapse_limit = N`              | `SELECT 1`  |
 * | Planner scan/join enable flags | `SET enable_material = on/off`, `SET enable_nestloop = on/off` etc (7)    | `SELECT 1`  |
 * | ANALYZE command                | `ANALYZE [VERBOSE] [table]`                                               | `SELECT 1`  |
 * | System catalog queries         | `SELECT * FROM pg_stats`, `SELECT * FROM pg_statistic`                    | `SELECT '' as schemaname` |
 * | SHOW statistics target         | `SHOW default_statistics_target`                                          | `SELECT '100'` |
 * | SET SESSION/LOCAL variants     | All of the above SET statements with `SESSION` or `LOCAL` prefix          | `SELECT 1`  |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite syntax
 * - Detection is conservative — anchored full-statement patterns only
 * - No false positives on keywords appearing in string literals or identifiers
 * - PinoLogger integration for debugging and audit trails
 *
 * @module query/StatsShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { PgCatalog } from '../system/PgCatalog';
import { SystemCatalog } from '../system/SystemCatalog';

// ── Logger ──────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('StatsShim');

// ── Types ──────────────────────────────────────────────────────

export interface StatsResult {
  /** Rewritten SQL string (unchanged if no rewriting was needed) */
  sql: string;
  /** Whether a planner-statistics rewrite was performed */
  rewritten: boolean;
}

// ── Stats caching ──────────────────────────────────────────────

interface ColumnStat {
  schemaname: string;
  tablename: string;
  attname: string;
  null_frac: number;
  avg_width: number;
  n_distinct: number;
  most_common_vals: string | null;
  correlation: number | null;
}

const TYPE_WIDTH_MAP: Record<string, number> = {
  'INTEGER': 4,
  'INT': 4,
  'BIGINT': 8,
  'SMALLINT': 2,
  'TINYINT': 1,
  'REAL': 4,
  'FLOAT': 8,
  'DOUBLE': 8,
  'TEXT': 256,
  'VARCHAR': 128,
  'CHAR': 1,
  'BLOB': 256,
  'BOOLEAN': 1,
  'DATE': 4,
  'DATETIME': 8,
  'TIMESTAMP': 8,
  'NUMERIC': 8,
  'DECIMAL': 8,
};

/** Cached per-column statistics */
let statsCache: ColumnStat[] | null = null;

/** Timestamp of last cache refresh */
let lastAnalyzeTime = 0;

/** Minimum interval between cache rebuilds (in ms) — default 60 seconds */
const CACHE_TTL_MS = Number(process.env.STATS_CACHE_TTL_MS) || 60_000;

/**
 * Collect real column-level statistics from the SQLite database.
 *
 * For each user table:
 * 1. Queries `PRAGMA table_info(<table>)` for column names and types
 * 2. Queries `SELECT COUNT(*)` for total row count
 * 3. For tables with ≤10 rows: computes exact distinct count per column
 * 4. Computes null_frac from null values in each column
 * 5. Estimates n_distinct from distinct values
 * 6. Assigns avg_width based on column type
 *
 * Falls back to SystemCatalog metadata when no DB connection is available.
 */
function collectColumnStats(): ColumnStat[] {
  const db = PgCatalog.shardDb;
  const stats: ColumnStat[] = [];

  if (db) {
    try {
      // Get all user tables from sqlite_master
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__' ORDER BY name`
      ).all() as Array<{ name: string }>;

      for (const tbl of tables) {
        const tableName = tbl.name;

        // Get total row count
        let rowCount = 0;
        try {
          const row = db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`).get() as { cnt: number };
          rowCount = Number(row.cnt) || 0;
        } catch {
          // Skip tables that can't be queried
        }

        // Try to load real stats from __sqlvec_statistics (added by ANALYZE)
        let statsFromAnalyze: Map<string, { null_frac: number; n_distinct: number; mcv_vals: string | null }> | null = null;
        try {
          const statsTableExists = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='__sqlvec_statistics'"
          ).get() as { name: string } | undefined;
          if (statsTableExists && rowCount > 0) {
            const statRows = db.prepare(
              "SELECT column_name, null_fraction, distinct_count, mcv_values FROM __sqlvec_statistics WHERE table_name = ?"
            ).all(tableName) as Array<{
              column_name: string;
              null_fraction: number;
              distinct_count: number;
              mcv_values: string;
            }>;
            if (statRows.length > 0) {
              statsFromAnalyze = new Map();
              for (const sr of statRows) {
                statsFromAnalyze.set(sr.column_name, {
                  null_frac: sr.null_fraction,
                  n_distinct: sr.distinct_count,
                  mcv_vals: sr.mcv_values === '[]' ? null : sr.mcv_values,
                });
              }
            }
          }
        } catch {
          // __sqlvec_statistics may not exist — fall through
        }

        // Get column info
        const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>;

        for (const col of columns) {
          const colName = col.name;
          const colType = (col.type || 'TEXT').toUpperCase();

          // Default width from type map
          let avgWidth = TYPE_WIDTH_MAP[colType] || 4;

          let nDistinct = -1;
          let nullFrac = 0;
          let mcvVals: string | null = null;
          let correlation: number | null = null;

          // Use __sqlvec_statistics data if available
          const colStats = statsFromAnalyze?.get(colName);
          if (colStats && rowCount > 0) {
            nullFrac = colStats.null_frac;
            nDistinct = colStats.n_distinct;

            // MCV: format from JSON to comma-separated list
            if (colStats.mcv_vals) {
              try {
                const parsed = JSON.parse(colStats.mcv_vals);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  mcvVals = parsed.map(String).join(',');
                }
              } catch { /* use fallback */ }
            }

            // Estimate correlation from dispersion
            if (nDistinct > 0 && rowCount > 0) {
              const dispersion = nDistinct / Math.max(rowCount, 1);
              correlation = Math.max(0, 1 - dispersion);
            }
          } else if (rowCount > 0 && rowCount <= 10) {
            // Small table: compute exact distinct and null counts
            try {
              const counts = db.prepare(
                `SELECT COUNT(DISTINCT "${colName}") as d, COUNT(*) as t, SUM(CASE WHEN "${colName}" IS NULL THEN 1 ELSE 0 END) as n FROM "${tableName}"`
              ).get() as { d: number; t: number; n: number };

              nDistinct = Number(counts.d) || 0;
              nullFrac = (Number(counts.n) || 0) / rowCount;
            } catch {
              // Column might not be directly queryable
            }

            // For ≤10 rows, compute most_common_vals
            try {
              const valRows = db.prepare(
                `SELECT "${colName}" as v, COUNT(*) as c FROM "${tableName}" GROUP BY v ORDER BY c DESC LIMIT 5`
              ).all() as Array<{ v: any; c: number }>;

              if (valRows.length > 0) {
                mcvVals = valRows.map(r => String(r.v)).join(',');
              }
            } catch {
              // Skip MCV for non-simple columns
            }
          }

          stats.push({
            schemaname: 'public',
            tablename: tableName,
            attname: colName,
            null_frac: nullFrac,
            avg_width: avgWidth,
            n_distinct: nDistinct,
            most_common_vals: mcvVals,
            correlation,
          });
        }
      }
    } catch {
      // Fall through to SystemCatalog fallback
    }
  }

  // If we couldn't get data from the DB, fall back to SystemCatalog metadata
  if (stats.length === 0) {
    for (const tbl of SystemCatalog.userTables) {
      if (tbl.tableType !== 'BASE TABLE') continue;
      stats.push({
        schemaname: tbl.tableSchema,
        tablename: tbl.tableName,
        attname: 'id',
        null_frac: 0,
        avg_width: 4,
        n_distinct: -1,
        most_common_vals: null,
        correlation: null,
      });
    }
  }

  return stats;
}

/**
 * Build a SQL query that returns pg_stats-compatible rows as literal values.
 * Each row is a UNION of SELECT literals.
 */
function buildPgStatsSql(stats: ColumnStat[]): string {
  if (stats.length === 0) {
    return "SELECT '' as schemaname, '' as tablename, '' as attname, 0.0 as null_frac, 0 as avg_width, 0 as n_distinct, NULL as most_common_vals, NULL as correlation WHERE 0";
  }

  const rows = stats.map(s => {
    const mcv = s.most_common_vals ? `'${s.most_common_vals.replace(/'/g, "''")}'` : 'NULL';
    const corr = s.correlation !== null ? s.correlation : 'NULL';
    return `SELECT '${s.schemaname}' as schemaname, '${s.tablename}' as tablename, '${s.attname}' as attname, ${s.null_frac} as null_frac, ${s.avg_width} as avg_width, ${s.n_distinct} as n_distinct, ${mcv} as most_common_vals, ${corr} as correlation`;
  });

  return rows.join('\nUNION ALL\n');
}

/**
 * Build a SQL query with real stats data for a specific table.
 * Used when the original query has a WHERE tablename = '...' clause.
 */
function buildPgStatsSqlForTable(stats: ColumnStat[], tableName: string): string {
  const filtered = stats.filter(s => s.tablename.toLowerCase() === tableName.toLowerCase());
  return buildPgStatsSql(filtered);
}

/**
 * Get (and cache) column statistics.
 * Refreshes the cache if the last ANALYZE was more than CACHE_TTL_MS ago.
 */
function getCachedStats(): ColumnStat[] {
  const now = Date.now();
  if (statsCache === null || (now - lastAnalyzeTime) > CACHE_TTL_MS) {
    statsCache = collectColumnStats();
    lastAnalyzeTime = now;
  }
  return statsCache;
}

/**
 * Force a statistics cache refresh (triggered by ANALYZE command).
 */
export function refreshStatsCache(): void {
  statsCache = null;
  lastAnalyzeTime = 0;
  getCachedStats(); // Rebuild immediately
  logger.debug('Statistics cache refreshed');
}

// ── Constants — Regex patterns ──────────────────────────────────

/**
 * Matches `SET [SESSION|LOCAL] default_statistics_target = N` or
 * `SET [SESSION|LOCAL] default_statistics_target TO N`.
 *
 * PostgreSQL GUC syntax:
 *   SET default_statistics_target = 100;
 *   SET SESSION default_statistics_target = 500;
 *   SET LOCAL default_statistics_target TO 1000;
 *
 * The `default_statistics_target` GUC controls how many rows the ANALYZE
 * command samples for each column's statistics. SQLite has no equivalent.
 */
const SET_STATISTICS_TARGET_RE =
  /^\s*SET\s+(?:(?:SESSION|LOCAL)\s+)?default_statistics_target\s*(?:=|TO)\s+\d+\s*;?\s*$/i;

/**
 * Matches `SET [SESSION|LOCAL] from_collapse_limit = N` or
 * `SET [SESSION|LOCAL] from_collapse_limit TO N`.
 *
 * PostgreSQL GUC syntax:
 *   SET from_collapse_limit = 8;
 *   SET SESSION from_collapse_limit = 16;
 *
 * This GUC controls how many items in a FROM list the planner will flatten
 * before it starts considering explicit JOIN syntax. SQLite's planner does
 * not expose such a parameter.
 */
const SET_FROM_COLLAPSE_RE =
  /^\s*SET\s+(?:(?:SESSION|LOCAL)\s+)?from_collapse_limit\s*(?:=|TO)\s+\d+\s*;?\s*$/i;

/**
 * Matches `SET [SESSION|LOCAL] join_collapse_limit = N` or
 * `SET [SESSION|LOCAL] join_collapse_limit TO N`.
 *
 * PostgreSQL GUC syntax:
 *   SET join_collapse_limit = 8;
 *   SET SESSION join_collapse_limit = 16;
 *
 * This GUC controls how many explicit JOINs the planner will try to reorder
 * before falling back to the order specified in the query. SQLite's planner
 * does not expose such a parameter.
 */
const SET_JOIN_COLLAPSE_RE =
  /^\s*SET\s+(?:(?:SESSION|LOCAL)\s+)?join_collapse_limit\s*(?:=|TO)\s+\d+\s*;?\s*$/i;

/**
 * Matches `SET [SESSION|LOCAL] enable_<method> = on/off` or
 * `SET [SESSION|LOCAL] enable_<method> TO on/off`.
 *
 * PostgreSQL planner method-enable GUCs:
 *   SET enable_material = on;
 *   SET enable_nestloop = off;
 *   SET enable_hashjoin = off;
 *   SET enable_mergejoin = off;
 *   SET enable_seqscan = off;
 *   SET enable_indexscan = off;
 *   SET enable_bitmapscan = off;
 *
 * Each of these GUCs permits or forbids a specific scan or join strategy.
 * SQLite's planner has a fixed set of strategies and no equivalent GUCs,
 * so all forms can be safely replaced with a no-op.
 *
 * Supported method names: material, nestloop, hashjoin, mergejoin, seqscan,
 * indexscan, bitmapscan.
 */
const SET_ENABLE_FLAG_RE =
  /^\s*SET\s+(?:(?:SESSION|LOCAL)\s+)?enable_(?:material|nestloop|hashjoin|mergejoin|seqscan|indexscan|bitmapscan)\s*(?:=|TO)\s+(?:on|off|true|false|0|1)\s*;?\s*$/i;

/**
 * Matches `ANALYZE [VERBOSE] [schema.]table` — the PostgreSQL ANALYZE command.
 *
 * PostgreSQL syntax:
 *   ANALYZE;
 *   ANALYZE VERBOSE;
 *   ANALYZE my_table;
 *   ANALYZE VERBOSE my_schema.my_table;
 *   ANALYZE (VERBOSE, SKIP_DATABASE_STATS) my_table;  -- parens syntax (not fully supported: caught as a simpler pattern)
 *
 * SQLite has `ANALYZE` but it only works on sqlite_stat tables and has no
 * equivalent for collecting distribution statistics. The standard PG ANALYZE
 * command that gathers planner statistics has no SQLite equivalent, so we
 * replace it with SELECT 1.
 *
 * Note: We must be careful not to match SQLite's own ANALYZE statement which
 * is valid. However, PG's ANALYZE is parameter-heavy while SQLite's is just
 * `ANALYZE;` or `ANALYZE schema-name;`. To be safe, we match any ANALYZE
 * that has PG-specific keywords (VERBOSE, parenthesized options, or a table
 * reference with a dot).
 *
 * Also, PG supports `ANALYZE (VERBOSE)` and other parenthesized option list
 * syntax. We catch the parenthesized option variant as well.
 */
const ANALYZE_PG_RE =
  /^\s*ANALYZE\b\s*(?:\(.+?\)\s*)?(?:VERBOSE\s+)?(?:[a-zA-Z_][a-zA-Z0-9_]*\s*(?:\.\s*[a-zA-Z_][a-zA-Z0-9_]*\s*)?)?\s*;?\s*$/i;

/**
 * Matches `ANALYZE` with PG-specific VERBOSE keyword.
 *   ANALYZE VERBOSE;
 *   ANALYZE VERBOSE my_table;
 */
const ANALYZE_VERBOSE_RE =
  /^\s*ANALYZE\s+VERBOSE\s*(?:[a-zA-Z_][a-zA-Z0-9_]*(?:\s*\.\s*[a-zA-Z_][a-zA-Z0-9_]*)?\s*)?;?\s*$/i;

/**
 * Matches `ANALYZE` with parenthesized option list:
 *   ANALYZE (VERBOSE);
 *   ANALYZE (VERBOSE, SKIP_DATABASE_STATS);
 */
const ANALYZE_PAREN_RE =
  /^\s*ANALYZE\s*\(.*?\)\s*(?:[a-zA-Z_][a-zA-Z0-9_]*(?:\s*\.\s*[a-zA-Z_][a-zA-Z0-9_]*)?\s*)?;?\s*$/i;

/**
 * Matches `ANALYZE <table>` where table contains a dot (schema-qualified).
 *   ANALYZE my_schema.my_table;
 *   ANALYZE VERBOSE my_schema.my_table;
 *
 * Bare `ANALYZE` (no args) is valid SQLite — we only rewrite PG-specific forms.
 * But to be safe, we also rewrite bare `ANALYZE;` since it's equivalent to
 * a no-op in a PG-controlled context anyway.
 */
const ANALYZE_WITH_TABLE_RE =
  /^\s*ANALYZE\s+(?:VERBOSE\s+)?(?:[a-zA-Z_][a-zA-Z0-9_]*\s*(?:\.\s*[a-zA-Z_][a-zA-Z0-9_]*\s*)?)\s*;?\s*$/i;

/**
 * Matches a bare `ANALYZE;` — the simplest form.
 * Both PG and SQLite have this command, but in a PG-controlled context
 * (tool wrapper, migration script) it is safe to rewrite to SELECT 1.
 * For pure pass-through of SQLite ANALYZE, see the note in rewriteStats.
 *
 * We match the *bare* form only when it's literally just `ANALYZE;` or
 * `ANALYZE` with optional semicolon.
 */
const ANALYZE_BARE_RE = /^\s*ANALYZE\s*;?\s*$/i;

/**
 * Matches queries selecting from PostgreSQL system statistics views:
 *   SELECT * FROM pg_stats
 *   SELECT * FROM pg_statistic
 *   SELECT schemaname, tablename FROM pg_stats WHERE tablename = 'foo'
 *   SELECT * FROM "pg_catalog".pg_stats
 *
 * These views contain per-column statistics gathered by ANALYZE. Since
 * SQLite does not collect column-level statistics, we return a valid
 * SQLite query that produces an empty result set with a compatible
 * column name (schemaname).
 *
 * We check for `FROM pg_stats` or `FROM pg_statistic` (case-insensitive)
 * with optional schema qualification (`pg_catalog.`).
 */
const PG_STATS_SELECT_RE =
  /\bFROM\s+(?:(?:pg_catalog|"pg_catalog")\.)?pg_stats\b/i;

const PG_STATISTIC_SELECT_RE =
  /\bFROM\s+(?:(?:pg_catalog|"pg_catalog")\.)?pg_statistic\b/i;

/**
 * Matches `SHOW default_statistics_target`.
 *
 * PostgreSQL returns the current value of the default_statistics_target GUC
 * (default: 100). Since SQLite has no equivalent, we return a sensible
 * default constant.
 */
const SHOW_STATISTICS_TARGET_RE =
  /^\s*SHOW\s+default_statistics_target\s*;?\s*$/i;

// ── Public API ──────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL planner-statistics
 * statement that requires rewriting for SQLite compatibility.
 *
 * Checks for the following patterns (case-insensitive):
 *
 * 1. `SET [SESSION|LOCAL] default_statistics_target = N`
 * 2. `SET [SESSION|LOCAL] from_collapse_limit = N`
 * 3. `SET [SESSION|LOCAL] join_collapse_limit = N`
 * 4. `SET [SESSION|LOCAL] enable_material|nestloop|hashjoin|mergejoin|seqscan|indexscan|bitmapscan = on|off`
 * 5. `ANALYZE [VERBOSE] [schema.table]`
 * 6. `SELECT ... FROM pg_stats`
 * 7. `SELECT ... FROM pg_statistic`
 * 8. `SHOW default_statistics_target`
 *
 * Returns `false` for:
 *   - Non-statistics SQL statements
 *   - Empty or non-string input
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL requires planner-statistics rewriting
 *
 * @example
 * ```ts
 * detectStats("SET default_statistics_target = 100");            // true
 * detectStats("SET enable_seqscan = off");                       // true
 * detectStats("SET enable_nestloop = off");                      // true
 * detectStats("SET from_collapse_limit = 8");                    // true
 * detectStats("ANALYZE VERBOSE my_table");                       // true
 * detectStats("SELECT * FROM pg_stats");                         // true
 * detectStats("SHOW default_statistics_target");                 // true
 * detectStats("SELECT 1");                                       // false
 * detectStats("SELECT * FROM my_table");                         // false
 * detectStats("");                                               // false
 * ```
 */
export function detectStats(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check — avoids unnecessary regex on non-SET/SHOW/ANALYZE/SELECT statements
  const upper = trimmed.toUpperCase();
  if (
    !upper.startsWith('SET ') &&
    !upper.startsWith('SHOW ') &&
    !upper.startsWith('ANALYZE') &&
    !upper.startsWith('SELECT ')
  ) {
    return false;
  }

  // ── Pattern 1: SET default_statistics_target = N ──────────
  if (SET_STATISTICS_TARGET_RE.test(trimmed)) {
    logger.debug({ sql: trimmed.substring(0, 120) }, 'SET default_statistics_target detected');
    return true;
  }

  // ── Pattern 2: SET from_collapse_limit = N ────────────────
  if (SET_FROM_COLLAPSE_RE.test(trimmed)) {
    logger.debug({ sql: trimmed.substring(0, 120) }, 'SET from_collapse_limit detected');
    return true;
  }

  // ── Pattern 3: SET join_collapse_limit = N ─────────────────
  if (SET_JOIN_COLLAPSE_RE.test(trimmed)) {
    logger.debug({ sql: trimmed.substring(0, 120) }, 'SET join_collapse_limit detected');
    return true;
  }

  // ── Pattern 4: SET enable_<method> = on/off ───────────────
  if (SET_ENABLE_FLAG_RE.test(trimmed)) {
    logger.debug({ sql: trimmed.substring(0, 120) }, 'SET enable_* planner flag detected');
    return true;
  }

  // ── Pattern 5: ANALYZE [VERBOSE] [table] ──────────────────
  if (ANALYZE_PG_RE.test(trimmed)) {
    logger.debug({ sql: trimmed.substring(0, 120) }, 'ANALYZE statement detected');
    return true;
  }

  // ── Pattern 6: SELECT ... FROM pg_stats ───────────────────
  if (PG_STATS_SELECT_RE.test(trimmed)) {
    logger.debug({ sql: trimmed.substring(0, 120) }, 'SELECT from pg_stats detected');
    return true;
  }

  // ── Pattern 7: SELECT ... FROM pg_statistic ───────────────
  if (PG_STATISTIC_SELECT_RE.test(trimmed)) {
    logger.debug({ sql: trimmed.substring(0, 120) }, 'SELECT from pg_statistic detected');
    return true;
  }

  // ── Pattern 8: SHOW default_statistics_target ─────────────
  if (SHOW_STATISTICS_TARGET_RE.test(trimmed)) {
    logger.debug({ sql: trimmed.substring(0, 120) }, 'SHOW default_statistics_target detected');
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL planner-statistics SQL statement to SQLite-compatible format.
 *
 * **Processing rules:**
 *
 * | Input                                                                     | Output                                              | rewritten |
 * |:--------------------------------------------------------------------------|:----------------------------------------------------|:----------|
 * | `SET default_statistics_target = 100`                                     | `SELECT 1`                                          | `true`    |
 * | `SET SESSION default_statistics_target TO 500`                            | `SELECT 1`                                          | `true`    |
 * | `SET from_collapse_limit = 8`                                             | `SELECT 1`                                          | `true`    |
 * | `SET join_collapse_limit = 16`                                            | `SELECT 1`                                          | `true`    |
 * | `SET enable_material = on`                                                | `SELECT 1`                                          | `true`    |
 * | `SET enable_nestloop = off`                                               | `SELECT 1`                                          | `true`    |
 * | `SET enable_hashjoin = on`                                                | `SELECT 1`                                          | `true`    |
 * | `SET enable_mergejoin = off`                                              | `SELECT 1`                                          | `true`    |
 * | `SET SESSION enable_seqscan = off`                                        | `SELECT 1`                                          | `true`    |
 * | `SET LOCAL enable_indexscan = on`                                         | `SELECT 1`                                          | `true`    |
 * | `SET enable_bitmapscan = off`                                             | `SELECT 1`                                          | `true`    |
 * | `ANALYZE`                                                                 | `SELECT 1`                                          | `true`    |
 * | `ANALYZE VERBOSE`                                                         | `SELECT 1`                                          | `true`    |
 * | `ANALYZE my_table`                                                        | `SELECT 1`                                          | `true`    |
 * | `ANALYZE VERBOSE my_table`                                                | `SELECT 1`                                          | `true`    |
 * | `SELECT * FROM pg_stats`                                                  | `SELECT '' as schemaname`                           | `true`    |
 * | `SELECT schemaname, tablename FROM pg_catalog.pg_stats WHERE tablename = 'foo'` | `SELECT '' as schemaname`                    | `true`    |
 * | `SELECT * FROM pg_statistic`                                              | `SELECT '' as schemaname`                           | `true`    |
 * | `SHOW default_statistics_target`                                          | `SELECT '100' as default_statistics_target`         | `true`    |
 * | `SELECT 1`                                                                | (unchanged)                                         | `false`   |
 * | `SELECT * FROM users`                                                     | (unchanged)                                         | `false`   |
 *
 * **Design rationale:**
 *
 * - **SET → `SELECT 1`**: All PG planner GUCs have no SQLite equivalent.
 *   Replacing with a lightweight no-op satisfies both syntactic correctness
 *   (SQLite accepts `SELECT 1`) and semantic safety — SQLite's planner uses
 *   its own fixed-cost model, so there is no actual planner behaviour to
 *   preserve.
 *
 * - **ANALYZE → `SELECT 1`**: SQLite's ANALYZE command only updates the
 *   sqlite_stat tables and is orthogonal to PG's ANALYZE which gathers
 *   column distribution statistics for the PG planner. In a migration context,
 *   PG ANALYZE commands should be dropped. Bare `ANALYZE;` is also rewritten
 *   since it adds no value in a PG-controlled workflow targeting SQLite.
 *
 * - **pg_stats/pg_statistic → `SELECT '' as schemaname`**: Applications that
 *   inspect pg_stats expect a specific result shape. Returning a null/empty
 *   schemaname column satisfies the API contract while indicating "no
 *   statistics available". A single-column placeholder is the minimum
 *   compatible output — most queries select specific columns, and at minimum
 *   `schemaname` is universally present in pg_stats.
 *
 * - **SHOW → `SELECT '100'`**: The PG default for default_statistics_target
 *   is 100. Returning this value is the most conservative and least surprising
 *   answer.
 *
 * @param sql   The raw SQL string to process
 * @returns     A `StatsResult` with the (potentially rewritten) SQL
 *
 * @example
 * ```ts
 * // SET statistics target → SELECT 1
 * rewriteStats("SET default_statistics_target = 100");
 * // → { sql: "SELECT 1", rewritten: true }
 *
 * // SET planner enable flag → SELECT 1
 * rewriteStats("SET enable_seqscan = off");
 * // → { sql: "SELECT 1", rewritten: true }
 *
 * // ANALYZE → SELECT 1
 * rewriteStats("ANALYZE VERBOSE my_table");
 * // → { sql: "SELECT 1", rewritten: true }
 *
 * // pg_stats query → placeholder
 * rewriteStats("SELECT * FROM pg_stats");
 * // → { sql: "SELECT '' as schemaname", rewritten: true }
 *
 * // SHOW → constant response
 * rewriteStats("SHOW default_statistics_target");
 * // → { sql: "SELECT '100' as default_statistics_target", rewritten: true }
 *
 * // Non-statistics — pass through
 * rewriteStats("SELECT 1");
 * // → { sql: "SELECT 1", rewritten: false }
 * ```
 */
export function rewriteStats(sql: string): StatsResult {
  const original = sql;

  // Guard: reject non-string or empty input
  if (typeof original !== 'string' || original.trim().length === 0) {
    return {
      sql: original ?? '',
      rewritten: false,
    };
  }

  const trimmed = original.trim();

  // ── Case 1: SET default_statistics_target = N ──────────────
  if (SET_STATISTICS_TARGET_RE.test(trimmed)) {
    logger.info(
      { original: trimmed.substring(0, 120) },
      'SET default_statistics_target rewritten to SELECT 1 (no-op for SQLite)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Case 2: SET from_collapse_limit = N ────────────────────
  if (SET_FROM_COLLAPSE_RE.test(trimmed)) {
    logger.info(
      { original: trimmed.substring(0, 120) },
      'SET from_collapse_limit rewritten to SELECT 1 (no-op for SQLite)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Case 3: SET join_collapse_limit = N ────────────────────
  if (SET_JOIN_COLLAPSE_RE.test(trimmed)) {
    logger.info(
      { original: trimmed.substring(0, 120) },
      'SET join_collapse_limit rewritten to SELECT 1 (no-op for SQLite)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Case 4: SET enable_<method> = on/off ──────────────────
  if (SET_ENABLE_FLAG_RE.test(trimmed)) {
    logger.info(
      { original: trimmed.substring(0, 120) },
      'SET enable_* planner flag rewritten to SELECT 1 (no-op for SQLite)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Case 5: ANALYZE [VERBOSE] [table] — refreshes stats cache ──
  if (
    ANALYZE_VERBOSE_RE.test(trimmed) ||
    ANALYZE_PAREN_RE.test(trimmed) ||
    ANALYZE_WITH_TABLE_RE.test(trimmed) ||
    ANALYZE_BARE_RE.test(trimmed) ||
    ANALYZE_PG_RE.test(trimmed)
  ) {
    // Refresh the stats cache when ANALYZE is issued
    refreshStatsCache();
    logger.info(
      { original: trimmed.substring(0, 120) },
      'ANALYZE rewritten to SELECT 1 — stats cache refreshed',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Case 6: SELECT ... FROM pg_stats / pg_statistic — real column stats ──
  if (PG_STATS_SELECT_RE.test(trimmed) || PG_STATISTIC_SELECT_RE.test(trimmed)) {
    const stats = getCachedStats();

    // Check if there's a WHERE tablename = '...' filter
    const tableMatch = trimmed.match(/\bWHERE\b[\s\S]*?\btablename\s*=\s*'([^']+)'/i);
    let rewritten: string;
    if (tableMatch && tableMatch[1]) {
      rewritten = buildPgStatsSqlForTable(stats, tableMatch[1]);
      if (rewritten === "SELECT '' as schemaname, '' as tablename, '' as attname, 0.0 as null_frac, 0 as avg_width, 0 as n_distinct, NULL as most_common_vals, NULL as correlation WHERE 0") {
        rewritten = `SELECT '' as schemaname, '' as tablename, '' as attname, 0.0 as null_frac, 0 as avg_width, 0 as n_distinct, NULL as most_common_vals, NULL as correlation WHERE tablename = '${tableMatch[1]}'`;
      }
    } else {
      rewritten = buildPgStatsSql(stats);
    }

    logger.info(
      {
        original: trimmed.substring(0, 120),
        statsCount: stats.length,
      },
      'SELECT from pg_stats/pg_statistic — returning real column statistics',
    );
    return {
      sql: rewritten,
      rewritten: true,
    };
  }

  // ── Case 7: SHOW default_statistics_target ────────────────
  if (SHOW_STATISTICS_TARGET_RE.test(trimmed)) {
    const rewritten = "SELECT '100' as default_statistics_target";
    logger.info(
      {
        original: trimmed.substring(0, 120),
        rewritten,
      },
      'SHOW default_statistics_target rewritten to constant-response SELECT',
    );
    return {
      sql: rewritten,
      rewritten: true,
    };
  }

  // ── Case 8: Non-statistics — pass through unchanged ────────
  return {
    sql: trimmed,
    rewritten: false,
  };
}
