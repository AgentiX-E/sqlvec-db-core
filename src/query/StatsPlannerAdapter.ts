/**
 * StatsPlannerAdapter — 统计信息 → 查询规划器数据通路
 *
 * 将 ANALYZE 收集的统计信息（__sqlvec_statistics, __sqlvec_histogram）
 * 转换为 QueryPlanner.TableStats 对象，使成本优化基于真实数据而非固定假设。
 *
 * 数据流:
 *   ANALYZE → AnalyzeStatsCollector → __sqlvec_statistics
 *                                       ↓ (本文件)
 *   QueryPlanner.plan() ← StatsPlannerAdapter.loadTableStats()
 *                                       ↓
 *   CostModel.estimateSelectivity() ← TableStats (含 nDistinct, histogram, MCV)
 */

import type Database from 'better-sqlite3';
import { PinoLogger } from '../monitoring/PinoLogger';
import { STATS_TABLE, HISTOGRAM_TABLE, MCV_LIMIT, MAX_HISTOGRAM_BUCKETS } from './AnalyzeStatsCollector';

export interface StatsProvider {
  /** 获取某个表的统计信息，供 QueryPlanner 使用 */
  loadTableStats(tableName: string): Promise<TableStats | null>;
}

// Re-export TableStats type so consumers only import from here
export type { TableStats } from './CostModel';
import type { TableStats } from './CostModel';
import type { IndexDef } from './QueryPlanner';

const logger = PinoLogger.forComponent('StatsPlannerAdapter');

/** 列统计信息的缓存条目 */
interface CachedTableStats {
  stats: TableStats;
  fetchedAt: number;
}

const CACHE_TTL_MS = Number(process.env.STATS_CACHE_TTL_MS) || 60_000;
const tableStatsCache = new Map<string, CachedTableStats>();

/**
 * 从 __sqlvec_statistics 表加载表统计信息，返回 QueryPlanner 可用的 TableStats。
 * 缓存 60 秒（默认），可通过 STATS_CACHE_TTL_MS 环境变量覆盖。
 *
 * @param db        SQLite 数据库连接（shard 0，含 __sqlvec_statistics 表）
 * @param tableName 目标表名
 * @returns TableStats | null（表不存在或无统计信息时返回 null）
 */
export async function loadTableStats(
  db: Database.Database | undefined,
  tableName: string,
): Promise<TableStats | null> {
  if (!db || !tableName) return null;

  // 校验 __sqlvec_statistics 表是否存在
  const statsTableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(STATS_TABLE) as { name: string } | undefined;
  if (!statsTableExists) {
    logger.debug({ tableName }, 'Stats table not found — run ANALYZE first');
    return null;
  }

  // 检查缓存
  const cacheKey = `${tableName}`;
  const cached = tableStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.stats;
  }

  try {
    // 查询表行数（从 stats 表汇总非空的第一个列）
    const rowCountRow = db.prepare(
      `SELECT row_count FROM "${STATS_TABLE}" WHERE table_name = ? LIMIT 1`,
    ).get(tableName) as { row_count: number } | undefined;
    const reltuples = rowCountRow?.row_count ?? 0;

    // 估计页数: 假设每页 4KB, 每行约 100 字节
    const relpages = Math.max(1, Math.ceil(reltuples * 100 / 4096));

    // 获取所有列的统计信息
    const colRows = db.prepare(
      `SELECT column_name, distinct_count, mcv_values, mcv_frequencies, min_value, max_value
       FROM "${STATS_TABLE}" WHERE table_name = ?`,
    ).all(tableName) as Array<{
      column_name: string;
      distinct_count: number;
      mcv_values: string;
      mcv_frequencies: string;
      min_value: string | null;
      max_value: string | null;
    }>;

    const nDistinct = new Map<string, number>();
    const correlation = new Map<string, number>();
    const mcvVals = new Map<string, any[]>();
    const mcvFreqs = new Map<string, number[]>();

    for (const row of colRows) {
      nDistinct.set(row.column_name, row.distinct_count);

      // 加载 MCV 值
      try {
        const vals = JSON.parse(row.mcv_values);
        const freqs = JSON.parse(row.mcv_frequencies);
        if (Array.isArray(vals) && vals.length > 0) {
          mcvVals.set(row.column_name, vals);
          mcvFreqs.set(row.column_name, freqs.map((f: any) => Number(f)));
        }
      } catch {
        // MCV 解析失败 — 跳过（非致命）
      }

      // 粗略相关性估计：如果 min/max 有值且 distinct_count 较少，相关性可能较高
      if (row.min_value !== null && row.max_value !== null && row.min_value !== row.max_value) {
        // 对整数/浮点列估算相关性
        const minNum = Number(row.min_value);
        const maxNum = Number(row.max_value);
        if (!isNaN(minNum) && !isNaN(maxNum) && maxNum > minNum) {
          // 近似相关性 = 1 - (distinct_count / MAX(reltuples, 1))  — 值离散度越低越相关
          const dispersion = row.distinct_count / Math.max(reltuples, 1);
          correlation.set(row.column_name, Math.max(0, 1 - dispersion));
        }
      }
    }

    const stats: TableStats = {
      reltuples,
      relpages,
      nDistinct,
      correlation,
    };

    // 写入缓存
    tableStatsCache.set(cacheKey, { stats, fetchedAt: Date.now() });

    logger.debug({ tableName, reltuples, columns: colRows.length }, 'TableStats loaded from __sqlvec_statistics');
    return stats;
  } catch (err: any) {
    logger.warn({ tableName, err: err.message }, 'Failed to load table stats');
    return null;
  }
}

/**
 * 从 __sqlvec_histogram 表加载列的直方图。
 *
 * @returns 桶数组，每个桶包含 bucket_min, bucket_max, bucket_count
 */
export function loadHistogram(
  db: Database.Database,
  tableName: string,
  columnName: string,
): Array<{ bucketIndex: number; bucketMin: string; bucketMax: string; bucketCount: number }> {
  try {
    const histTableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(HISTOGRAM_TABLE) as { name: string } | undefined;
    if (!histTableExists) return [];

    const rows = db.prepare(
      `SELECT bucket_index, bucket_min, bucket_max, bucket_count
       FROM "${HISTOGRAM_TABLE}"
       WHERE table_name = ? AND column_name = ?
       ORDER BY bucket_index`,
    ).all(tableName, columnName) as Array<{
      bucket_index: number;
      bucket_min: string;
      bucket_max: string;
      bucket_count: number;
    }>;

    return rows.map(r => ({
      bucketIndex: r.bucket_index,
      bucketMin: r.bucket_min,
      bucketMax: r.bucket_max,
      bucketCount: r.bucket_count,
    }));
  } catch {
    return [];
  }
}

/**
 * 使用 MCV 和直方图估计选择率（查询谓词的选择性）。
 *
 * 用于 QueryPlanner 的 estimateSelectivity 增强。
 *
 * @param db        数据库连接
 * @param tableName 表名
 * @param column    列名
 * @param operator  操作符 (=, >, <, >=, <=, !=, BETWEEN, IN, LIKE)
 * @param value     查询值
 * @returns 选择率 (0-1)，null 表示无法估计
 */
export function estimateSelectivity(
  db: Database.Database,
  tableName: string,
  column: string,
  operator: string,
  value: any,
): number | null {
  try {
    // 1. 查询该列的统计概要
    const statRow = db.prepare(
      `SELECT row_count, distinct_count, null_fraction,
              mcv_values, mcv_frequencies,
              min_value, max_value
       FROM "${STATS_TABLE}"
       WHERE table_name = ? AND column_name = ?`,
    ).get(tableName, column) as any;
    if (!statRow || statRow.row_count <= 0) return null;

    const nullFrac = Number(statRow.null_fraction);
    const nonNullRows = statRow.row_count * (1 - nullFrac);
    const nDistinct = Number(statRow.distinct_count);
    let mcvVals: any[] = [];
    let mcvFreqs: number[] = [];
    try {
      mcvVals = JSON.parse(statRow.mcv_values);
      mcvFreqs = JSON.parse(statRow.mcv_frequencies).map((f: any) => Number(f));
    } catch { /* ignore */ }

    // 2. 检查 MCV — 只在 = 操作符时优先用 MCV
    if (operator === '=' && mcvVals.length > 0) {
      const mcvIdx = mcvVals.indexOf(value);
      if (mcvIdx >= 0) {
        // MCV 中找到了 → 使用 MCV 频率
        return mcvFreqs[mcvIdx] / Math.max(statRow.row_count, 1);
      }
      // MCV 中没找到 → 剩余行均匀分布
      const totalMcvFreq = mcvFreqs.reduce((a, b) => a + b, 0);
      const remainingRows = Math.max(0, nonNullRows - totalMcvFreq);
      const remainingDistinct = Math.max(1, nDistinct - mcvVals.length);
      return (1 - nullFrac) / remainingDistinct * (remainingRows / Math.max(statRow.row_count, 1));
    }

    // 3. 范围操作符 (> >= < <= BETWEEN) — 使用直方图
    if (['>', '>=', '<', '<=', 'BETWEEN'].includes(operator)) {
      const histRows = loadHistogram(db, tableName, column);
      if (histRows.length > 0) {
        let bucketTotalCount = 0;
        let relevantCount = 0;
        for (const bucket of histRows) {
          bucketTotalCount += bucket.bucketCount;
          const bMin = bucket.bucketMin;
          const bMax = bucket.bucketMax;

          let relevant = true;
          if (operator === '<' || operator === '<=') {
            if (bMin !== null && bMin >= value) relevant = false;
          } else if (operator === '>' || operator === '>=') {
            if (bMax !== null && bMax <= value) relevant = false;
          } else if (operator === 'BETWEEN') {
            if (Array.isArray(value) && value.length === 2) {
              if (bMin !== null && bMin > value[1]) relevant = false;
              if (bMax !== null && bMax < value[0]) relevant = false;
            }
          }
          if (relevant) relevantCount += bucket.bucketCount;
        }
        return bucketTotalCount > 0 ? relevantCount / bucketTotalCount : null;
      }
    }

    // 4. 兜底: 均匀分布假设
    if (operator === '=') {
      return (1 - nullFrac) / Math.max(nDistinct, 1);
    }
    if (['>', '>=', '<', '<='].includes(operator)) {
      return 0.3333; // 粗略: 三分之一
    }
    if (operator === 'BETWEEN') {
      return 0.05; // 粗略: 5%
    }
    if (operator === 'IS NULL') {
      return nullFrac;
    }
    if (operator === 'IS NOT NULL') {
      return 1 - nullFrac;
    }
    if (operator === 'LIKE') {
      return 0.05; // 粗略: 5%
    }
    if (operator === '!=' || operator === '<>') {
      return (1 - nullFrac) * (nDistinct - 1) / Math.max(nDistinct, 1);
    }

    return 0.1;
  } catch {
    return null;
  }
}

/**
 * 列出当前需要 ANALYZE 的表（基于统计信息过期检测）。
 *
 * @returns 表名数组，建议对这些表执行 ANALYZE
 */
export function listTableNeedingAnalyze(db: Database.Database): string[] {
  try {
    const statsTableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(STATS_TABLE) as { name: string } | undefined;

    // 获取所有用户表
    const userTables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '__%' AND name NOT LIKE 'sqlite_%'`,
    ).all() as { name: string }[];

    if (!statsTableExists) {
      return userTables.map(t => t.name);
    }

    const needAnalyze: string[] = [];
    for (const tbl of userTables) {
      const hasStats = db.prepare(
        `SELECT COUNT(*) AS cnt FROM "${STATS_TABLE}" WHERE table_name = ?`,
      ).get(tbl.name) as { cnt: number } | undefined;
      if (!hasStats || hasStats.cnt === 0) {
        needAnalyze.push(tbl.name);
      }
    }
    return needAnalyze;
  } catch {
    return [];
  }
}

/**
 * 清除统计缓存（在 ANALYZE 后调用）。
 */
export function clearStatsCache(): void {
  tableStatsCache.clear();
  logger.debug('Stats cache cleared');
}
