/**
 * AnalyzeExecutor — 真正的 ANALYZE 统计信息收集器
 *
 * 将 ANALYZE 语句由 no-op 转为真正的统计信息收集。
 *
 * 执行流程：
 * 1. 创建 _sqlvec_stats 元数据表（如不存在）
 * 2. 通过 PRAGMA table_info 发现列
 * 3. 对每列收集: row_count, null_fraction, n_distinct, correlation, min, max
 * 4. 存储到 _sqlvec_stats 表
 *
 * 参考 PostgreSQL: ANALYZE → pg_statistic + pg_class.reltuples
 */

import type Database from 'better-sqlite3';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('AnalyzeExecutor');

// ── SQL 常量 ──

export const STATS_PREFIX = '_sqlvec_stats';

export const CREATE_STATS_SQL = `
  CREATE TABLE IF NOT EXISTS "${STATS_PREFIX}" (
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    null_count INTEGER NOT NULL DEFAULT 0,
    null_fraction REAL NOT NULL DEFAULT 0.0,
    n_distinct INTEGER NOT NULL DEFAULT 0,
    correlation REAL DEFAULT 0.0,
    min_value TEXT,
    max_value TEXT,
    analyzed_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    PRIMARY KEY (table_name, column_name)
  )
`;

// ── 类型 ──

export interface ColumnStats {
  table_name: string;
  column_name: string;
  row_count: number;
  null_count: number;
  null_fraction: number;
  n_distinct: number;
  correlation: number;
  min_value: any;
  max_value: any;
}

export interface AnalyzeTableResult {
  table_name: string;
  columns_analyzed: number;
  total_columns: number;
}

// ── 统计收集 ──

/**
 * 收集单表的统计信息并写入 _sqlvec_stats 表。
 */
export function analyzeTable(
  db: Database.Database,
  tableName: string,
): AnalyzeTableResult {
  // 1) 确保元数据表存在
  db.exec(CREATE_STATS_SQL);

  // 2) 获取表的列信息
  const columns = db.prepare(
    `SELECT name, type FROM pragma_table_info(?)`,
  ).all(tableName) as { name: string; type: string }[];

  if (columns.length === 0) {
    logger.warn({ table: tableName }, 'ANALYZE: table has no discoverable columns');
    return { table_name: tableName, columns_analyzed: 0, total_columns: 0 };
  }

  // 3) 统计总行数
  const countRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM "${tableName.replace(/"/g, '""')}"`,
  ).get() as { cnt: number };
  const totalRows = Number(countRow?.cnt ?? 0);

  // 4) 删除旧统计
  db.prepare(`DELETE FROM "${STATS_PREFIX}" WHERE table_name = ?`).run(tableName);

  // 5) 对每列收集并写入
  let analyzed = 0;

  for (const col of columns) {
    const safeCol = col.name.replace(/"/g, '""');

    // null_count, n_distinct, min, max
    const row = db.prepare(`
      SELECT
        COUNT(*)                                                                        AS row_count,
        SUM(CASE WHEN "${safeCol}" IS NULL THEN 1 ELSE 0 END)                           AS null_count,
        COUNT(DISTINCT "${safeCol}")                                                     AS n_distinct,
        MIN("${safeCol}")                                                                AS min_value,
        MAX("${safeCol}")                                                                AS max_value
      FROM "${tableName.replace(/"/g, '""')}"
    `).get() as any;

    // correlation — 用行号与列值的秩相关近似
    let correlation = 0.0;
    if (totalRows > 1) {
      try {
        const corrRow = db.prepare(`
          WITH indexed AS (
            SELECT
              "${safeCol}" AS val,
              ROW_NUMBER() OVER (ORDER BY "${safeCol}") AS rank
            FROM "${tableName.replace(/"/g, '""')}"
            WHERE "${safeCol}" IS NOT NULL
          ),
          stats AS (
            SELECT
              AVG(rank)        AS avg_rank,
              AVG(CAST(val AS REAL)) AS avg_val,
              COUNT(*)         AS n
            FROM indexed
          )
          SELECT
            CASE WHEN s.n * (SUM(r.rank * CAST(r.val AS REAL)) - s.n * s.avg_rank * s.avg_val) != 0
                 AND (s.n * SUM(r.rank * r.rank) - s.n * s.avg_rank * s.avg_rank) > 0
                 AND (s.n * SUM(CAST(r.val AS REAL) * CAST(r.val AS REAL)) - s.n * s.avg_val * s.avg_val) > 0
            THEN (
              (s.n * SUM(r.rank * CAST(r.val AS REAL)) - s.n * s.avg_rank * s.avg_val)
              /
              SQRT(
                (s.n * SUM(r.rank * r.rank) - s.n * s.avg_rank * s.avg_rank)
                *
                (s.n * SUM(CAST(r.val AS REAL) * CAST(r.val AS REAL)) - s.n * s.avg_val * s.avg_val)
              )
            )
            ELSE 0.0 END AS corr
          FROM indexed r, stats s
        `).get() as { corr: number } | undefined;

        if (corrRow && typeof corrRow.corr === 'number' && !isNaN(corrRow.corr)) {
          correlation = corrRow.corr;
        }
      } catch {
        // correlation 计算是尽力而为，数值列才有效
        correlation = 0.0;
      }
    }

    const nullCount = Number(row?.null_count ?? 0);
    const nDistinct = Number(row?.n_distinct ?? 0);

    db.prepare(`
      INSERT INTO "${STATS_PREFIX}"
        (table_name, column_name, row_count, null_count, null_fraction, n_distinct, correlation, min_value, max_value)
      VALUES (?, ?, ?, ?, CAST(? AS REAL) / MAX(CAST(? AS REAL), 1.0), ?, ?, ?, ?)
    `).run(
      tableName, col.name,
      totalRows, nullCount, nullCount, totalRows,
      nDistinct, correlation,
      row?.min_value != null ? String(row.min_value) : null,
      row?.max_value != null ? String(row.max_value) : null,
    );

    analyzed++;
  }

  logger.info(
    { table: tableName, columns_analyzed: analyzed, total_columns: columns.length },
    'ANALYZE completed',
  );

  return {
    table_name: tableName,
    columns_analyzed: analyzed,
    total_columns: columns.length,
  };
}

/**
 * 从 _sqlvec_stats 表读取统计信息。
 */
export function getTableStats(
  db: Database.Database,
  tableName: string,
): ColumnStats[] {
  return db.prepare(`
    SELECT * FROM "${STATS_PREFIX}" WHERE table_name = ?
    ORDER BY column_name
  `).all(tableName) as ColumnStats[];
}

/**
 * 判断表是否需要 ANALYZE（没有统计信息或统计信息过时）。
 */
export function needsAnalyze(
  db: Database.Database,
  tableName: string,
  maxAgeSeconds: number = 3600,
): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt,
           MAX(analyzed_at) AS latest
    FROM "${STATS_PREFIX}"
    WHERE table_name = ?
  `).get(tableName) as { cnt: number; latest: number | null };

  if (!row || row.cnt === 0) return true;
  if (row.latest == null) return true;
  return (Date.now() / 1000) - row.latest > maxAgeSeconds;
}

/**
 * 查询指定列的相关性（-1 ~ 1）.
 * 高正相关（接近 1）= 列值与物理行序正相关 → 适合 SortAggregate / 索引扫描。
 */
export function getColumnCorrelation(
  db: Database.Database,
  tableName: string,
  columnName: string,
): number {
  const row = db.prepare(`
    SELECT correlation FROM "${STATS_PREFIX}"
    WHERE table_name = ? AND column_name = ?
  `).get(tableName, columnName) as { correlation: number } | undefined;

  return row?.correlation ?? 0;
}

/**
 * 查询指定列的唯一值数。
 */
export function getColumnDistinctCount(
  db: Database.Database,
  tableName: string,
  columnName: string,
): number {
  const row = db.prepare(`
    SELECT n_distinct FROM "${STATS_PREFIX}"
    WHERE table_name = ? AND column_name = ?
  `).get(tableName, columnName) as { n_distinct: number } | undefined;

  return row?.n_distinct ?? 0;
}
