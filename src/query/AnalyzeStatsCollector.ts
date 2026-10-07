/**
 * AnalyzeStatsCollector — ANALYZE statistics collector for SQLVec.
 *
 * Collects per-column statistics (row count, null fraction, distinct count,
 * MCV, min/max, equi-height histogram) and stores them in internal tables.
 *
 * ## Internal Tables
 *
 * - `__sqlvec_statistics` — per-column basic stats + MCV
 * - `__sqlvec_histogram` — equi-height histogram buckets
 *
 * ## Exports
 *
 * - `tableStatsQuery(tableName, columns)` — generates SQL for basic column stats
 * - `buildAnalyzeSql(tableName)` — generates SQL to run ANALYZE (collect + store)
 * - `AnalyzeStatsCollector` — orchestrates collection via better-sqlite3
 *
 * @module query/AnalyzeStatsCollector
 */

import Database from 'better-sqlite3';
import { PinoLogger } from '../logger/PinoLogger';

// ── Logger ──────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('AnalyzeStatsCollector');

// ── Constants ───────────────────────────────────────────────────

/** Maximum number of MCV entries per column */
export const MCV_LIMIT = 10;

/** Maximum number of histogram buckets */
export const MAX_HISTOGRAM_BUCKETS = 100;

/** Statistics internal table */
export const STATS_TABLE = '__sqlvec_statistics';

/** Histogram internal table */
export const HISTOGRAM_TABLE = '__sqlvec_histogram';

// ── Types ───────────────────────────────────────────────────────

export interface ColumnStatRow {
  table_name: string;
  column_name: string;
  row_count: number;
  null_count: number;
  null_fraction: number;
  distinct_count: number;
  mcv_values: any[];
  mcv_frequencies: number[];
  min_value: any;
  max_value: any;
  analyzed_at: number;
}

export interface HistogramBucket {
  table_name: string;
  column_name: string;
  bucket_index: number;
  bucket_min: any;
  bucket_max: any;
  bucket_count: number;
}

export interface AnalyzeResult {
  /** Table that was analyzed */
  tableName: string;
  /** Number of columns with collected stats */
  statsCount: number;
  /** Total histogram buckets inserted */
  histogramCount: number;
  /** List of column names discovered */
  statsColumns: string[];
}

// ── SQL Creation ────────────────────────────────────────────────

export const CREATE_STATS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${STATS_TABLE} (
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    null_count INTEGER NOT NULL DEFAULT 0,
    null_fraction REAL NOT NULL DEFAULT 0.0,
    distinct_count INTEGER NOT NULL DEFAULT 0,
    mcv_values TEXT DEFAULT '[]',
    mcv_frequencies TEXT DEFAULT '[]',
    min_value ANY,
    max_value ANY,
    analyzed_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
    PRIMARY KEY (table_name, column_name)
  )
`;

export const CREATE_HISTOGRAM_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${HISTOGRAM_TABLE} (
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    bucket_index INTEGER NOT NULL,
    bucket_min ANY,
    bucket_max ANY,
    bucket_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (table_name, column_name, bucket_index)
  )
`;

// ── SQL Query Generators ────────────────────────────────────────

/**
 * Generate a SQL SELECT query that returns basic column statistics.
 *
 * The returned query produces one row per column with:
 *   column_name, row_count, null_count, distinct_count, min_value, max_value
 *
 * @param tableName - The table to analyze (auto-quoted for safety)
 * @param columns   - List of column names to include
 * @returns A SQL query string (single SELECT or UNION ALL of SELECTs)
 *
 * @example
 * ```ts
 * const sql = tableStatsQuery('users', ['id', 'name', 'age']);
 * // Returns SQL like:
 * //   SELECT 'id' AS column_name, COUNT(*) AS row_count, ...
 * //   UNION ALL
 * //   SELECT 'name' AS column_name, COUNT(*) AS row_count, ...
 * //   UNION ALL
 * //   SELECT 'age' AS column_name, COUNT(*) AS row_count, ...
 * ```
 */
export function tableStatsQuery(tableName: string, columns: string[]): string {
  if (!tableName || !columns || columns.length === 0) {
    throw new Error('tableStatsQuery: tableName and columns are required');
  }

  const safeTable = tableName.replace(/"/g, '""');

  const parts = columns.map((col) => {
    const safeCol = col.replace(/"/g, '""');
    return [
      `SELECT`,
      `  '${col.replace(/'/g, "''")}' AS column_name,`,
      `  COUNT(*) AS row_count,`,
      `  IFNULL(SUM(CASE WHEN "${safeCol}" IS NULL THEN 1 ELSE 0 END), 0) AS null_count,`,
      `  COUNT(DISTINCT "${safeCol}") AS distinct_count,`,
      `  MIN("${safeCol}") AS min_value,`,
      `  MAX("${safeCol}") AS max_value`,
      `FROM "${safeTable}"`,
    ].join('\n');
  });

  return parts.join('\nUNION ALL\n');
}

/**
 * Generate a SQL query that computes MCV (Most Common Values) for a column.
 *
 * @param tableName - The table to analyze
 * @param columnName - The column to find MCV for
 * @param limit - Maximum number of MCV entries (default: 10)
 * @returns A SQL query string returning val and freq columns
 *
 * @example
 * ```ts
 * const sql = buildMcvQuery('users', 'status');
 * // Returns SQL:
 * //   SELECT "status" AS val, COUNT(*) AS freq
 * //   FROM "users"
 * //   GROUP BY "status"
 * //   ORDER BY freq DESC
 * //   LIMIT 10
 * ```
 */
export function buildMcvQuery(tableName: string, columnName: string, limit: number = MCV_LIMIT): string {
  const safeTable = tableName.replace(/"/g, '""');
  const safeCol = columnName.replace(/"/g, '""');

  return [
    `SELECT "${safeCol}" AS val, COUNT(*) AS freq`,
    `FROM "${safeTable}"`,
    `WHERE "${safeCol}" IS NOT NULL`,
    `GROUP BY "${safeCol}"`,
    `ORDER BY freq DESC`,
    `LIMIT ${Math.max(1, limit)}`,
  ].join('\n');
}

/**
 * Generate a SQL query that creates an equi-height histogram for a column.
 *
 * Divides sorted non-null values into approximately `bucketCount` buckets
 * of equal height (within ±1 row due to NTILE rounding).
 *
 * @param tableName - The table to analyze
 * @param columnName - The column to histogram
 * @param bucketCount - Number of histogram buckets (default: 100, max: 100)
 * @returns A SQL query string returning bucket rows
 *
 * @example
 * ```ts
 * const sql = buildHistogramQuery('users', 'age');
 * // Returns SQL using NTILE(100) to create equal-height buckets
 * ```
 */
export function buildHistogramQuery(
  tableName: string,
  columnName: string,
  bucketCount: number = MAX_HISTOGRAM_BUCKETS,
): string {
  const safeTable = tableName.replace(/"/g, '""');
  const safeCol = columnName.replace(/"/g, '""');
  const buckets = Math.min(Math.max(1, bucketCount), MAX_HISTOGRAM_BUCKETS);

  return [
    `WITH ranked AS (`,
    `  SELECT "${safeCol}" AS val,`,
    `    NTILE(${buckets}) OVER (ORDER BY "${safeCol}") AS bucket`,
    `  FROM "${safeTable}"`,
    `  WHERE "${safeCol}" IS NOT NULL`,
    `)`,
    `SELECT`,
    `  bucket - 1 AS bucket_index,`,
    `  MIN(val) AS bucket_min,`,
    `  MAX(val) AS bucket_max,`,
    `  COUNT(*) AS bucket_count`,
    `FROM ranked`,
    `GROUP BY bucket`,
    `ORDER BY bucket_index`,
  ].join('\n');
}

/**
 * Build a SQL command that triggers ANALYZE collection for a table.
 *
 * Returns a compound SQL string (executable via `db.exec()`) that:
 * 1. Creates internal tables if they don't exist
 * 2. Deletes old stats for the table
 * 3. Discovers columns via PRAGMA table_info
 * 4. Collects and inserts basic per-column stats
 * 5. Updates MCV for each column
 * 6. Inserts histogram buckets for each column
 *
 * @param tableName - The table to analyze
 * @returns A compound SQL string to execute
 *
 * @example
 * ```ts
 * const sql = buildAnalyzeSql('users');
 * db.exec(sql);
 * ```
 */
/**
 * Collect statistics for a table using a Database instance.
 * Discovers columns via PRAGMA table_info, collects basic stats, MCV, histogram.
 *
 * @param db - better-sqlite3 Database instance
 * @param tableName - The table to analyze
 * @returns AnalyzeResult with stats and histogram information
 */
export function analyzeTable(db: Database.Database, tableName: string): AnalyzeResult {
  if (!db || !tableName) {
    throw new Error('analyzeTable: db and tableName are required');
  }

  const safeTable = tableName.replace(/"/g, '""');

  // 1. Ensure internal tables exist
  db.exec(CREATE_STATS_TABLE_SQL);
  db.exec(CREATE_HISTOGRAM_TABLE_SQL);

  // 2. Discover columns via PRAGMA
  const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(tableName) as { name: string }[];
  if (columns.length === 0) {
    // SQLite does not permit a table (or view) with zero columns, so an empty
    // pragma_table_info result can only mean the table does not exist. Throw a
    // descriptive error rather than the raw "no such table" from a follow-up
    // query.
    throw new Error(`analyzeTable: table "${tableName}" not found`);
  }

  const columnNames = columns.map(c => c.name);

  // 3. Delete old stats
  db.prepare(`DELETE FROM "${STATS_TABLE}" WHERE table_name = ?`).run(tableName);
  db.prepare(`DELETE FROM "${HISTOGRAM_TABLE}" WHERE table_name = ?`).run(tableName);

  // 4. Collect and insert basic stats for each column
  let statsCount = 0;
  for (const col of columnNames) {
    const safeCol = col.replace(/"/g, '""');
    // An aggregate query without GROUP BY always returns exactly one row, so
    // `row` is never undefined.
    const row = db.prepare(`
      SELECT
        COUNT(*) AS row_count,
        IFNULL(SUM(CASE WHEN "${safeCol}" IS NULL THEN 1 ELSE 0 END), 0) AS null_count,
        COUNT(DISTINCT "${safeCol}") AS distinct_count,
        MIN("${safeCol}") AS min_value,
        MAX("${safeCol}") AS max_value
      FROM "${safeTable}"
    `).get() as {
      row_count: number;
      null_count: number;
      distinct_count: number;
      min_value: any;
      max_value: any;
    };

    db.prepare(`
      INSERT INTO "${STATS_TABLE}" (table_name, column_name, row_count, null_count, null_fraction, distinct_count, mcv_values, mcv_frequencies, min_value, max_value, analyzed_at)
      VALUES (?, ?, ?, ?, CAST(? AS REAL) / MAX(CAST(? AS REAL), 1.0), ?, '[]', '[]', ?, ?, CAST(strftime('%s', 'now') AS INTEGER))
    `).run(
      tableName, col,
      row.row_count, row.null_count, row.null_count, row.row_count,
      row.distinct_count, row.min_value, row.max_value,
    );
    statsCount++;

    // 5. Collect MCV
    const mcvRows = db.prepare(`
      SELECT "${safeCol}" AS val, COUNT(*) AS freq
      FROM "${safeTable}"
      WHERE "${safeCol}" IS NOT NULL
      GROUP BY "${safeCol}"
      ORDER BY freq DESC
      LIMIT ${MCV_LIMIT}
    `).all() as any[];

    const mcvVals = mcvRows.map((r: any) => r.val);
    const mcvFreqs = mcvRows.map((r: any) => r.freq);

    db.prepare(`
      UPDATE "${STATS_TABLE}" SET mcv_values = ?, mcv_frequencies = ?
      WHERE table_name = ? AND column_name = ?
    `).run(JSON.stringify(mcvVals), JSON.stringify(mcvFreqs), tableName, col);

    // 6. Collect histogram
    const histogramRows = db.prepare(`
      WITH ranked AS (
        SELECT "${safeCol}" AS val,
          NTILE(${MAX_HISTOGRAM_BUCKETS}) OVER (ORDER BY "${safeCol}") AS bucket
        FROM "${safeTable}"
        WHERE "${safeCol}" IS NOT NULL
      )
      SELECT bucket - 1 AS bucket_index, MIN(val) AS bucket_min, MAX(val) AS bucket_max, COUNT(*) AS bucket_count
      FROM ranked
      GROUP BY bucket
      ORDER BY bucket_index
    `).all() as any[];

    for (const hb of histogramRows) {
      db.prepare(`
        INSERT INTO "${HISTOGRAM_TABLE}" (table_name, column_name, bucket_index, bucket_min, bucket_max, bucket_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(tableName, col, hb.bucket_index, hb.bucket_min, hb.bucket_max, hb.bucket_count);
    }
  }

  // 7. Verify inserted stats (aggregate COUNT(*) always returns one row)
  const statsRow = db.prepare(`SELECT COUNT(*) AS cnt FROM "${STATS_TABLE}" WHERE table_name = ?`).get(tableName) as { cnt: number };
  const histRow = db.prepare(`SELECT COUNT(*) AS cnt FROM "${HISTOGRAM_TABLE}" WHERE table_name = ?`).get(tableName) as { cnt: number };

  return {
    tableName,
    statsCount: Number(statsRow.cnt),
    histogramCount: Number(histRow.cnt),
    statsColumns: columnNames,
  };
}

export function buildAnalyzeSql(tableName: string): string {
  if (!tableName) {
    throw new Error('buildAnalyzeSql: tableName is required');
  }

  const safeTable = tableName.replace(/"/g, '""');
  return `SELECT '__sqlvec_analyze' AS cmd, '${safeTable.replace(/'/g, "''")}' AS table_name`;
}
