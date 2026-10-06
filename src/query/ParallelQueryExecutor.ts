// @ts-nocheck
/**
 * ParallelQueryExecutor — 使用 Piscina 线程池的并行查询执行器
 *
 * ## 策略
 *
 * - 将表数据按 rowid 范围分片（chunk），每个 chunk 分配给一个 worker
 * - 每个 worker 打开独立的 SQLite 连接，执行 SELECT ... WHERE rowid BETWEEN ? AND ?
 * - 使用 Piscina 的线程池限制并发数（默认 maxThreads = CPU 核心数）
 * - 主线程合并所有 worker 的结果
 *
 * ## 适用场景
 *
 * - 全表扫描 + WHERE 下推（sequential-scan with conditions）
 * - 大表聚合（COUNT, SUM, AVG）
 * - 索引构建（CREATE INDEX）
 *
 * ## 架构
 *
 * ```
 * PlanExecutor.executeQuery()
 *     │
 *     ▼
 * executeNode({ type: 'parallel-scan' })
 *     │
 *     ├─ (内存数据库) → executeSequentialScan() [降级]
 *     │
 *     └─ (文件数据库) → executeParallelScan()
 *                          │
 *                          ▼
 *                     ParallelQueryExecutor
 *                          │
 *                     partitionRowIdRange() → N chunks
 *                          │
 *                     piscina.run(chunk_0)  ──► worker: scanChunk()
 *                     piscina.run(chunk_1)  ──► worker: scanChunk()
 *                     piscina.run(chunk_2)  ──► worker: scanChunk()
 *                          │
 *                     mergeResults() → flat array
 * ```
 *
 * ## 关键约束
 *
 * - 每个 worker 打开独立的 read-only SQLite 连接
 * - WAL mode 保证并发读取一致性
 * - 单个 worker 失败不影响其他 worker（错误隔离）
 *
 * @module query/ParallelQueryExecutor
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { Piscina } from 'piscina';
import type { QueryCondition } from './QueryPlanner';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('ParallelQueryExecutor');

// ── Worker Path Resolution ─────────────────────────────────────

/**
 * Resolve the path to the parallel-scan-worker script.
 * In production (dist/), the compiled .js file is used;
 * in development (src/), the raw .ts file is used.
 * This allows tsc compilation to produce a runnable artifact
 * while keeping tsx/ts-node dev workflows working.
 */
function resolveParallelWorkerPath(): string {
  const dir = __dirname;
  // Production: dist/query/parallel-scan-worker.js
  const jsPath = path.resolve(dir, 'parallel-scan-worker.js');
  if (fs.existsSync(jsPath)) return jsPath;
  // Development: src/query/parallel-scan-worker.ts
  const tsPath = path.resolve(dir, 'parallel-scan-worker.ts');
  if (fs.existsSync(tsPath)) return tsPath;
  // Fallback: trust the caller
  return tsPath;
}

// ── Interfaces ──────────────────────────────────────────────────

export interface ParallelScanConfig {
  /** 最少行数才启用并行（默认 10000） */
  minRowsForParallel: number;
  /** 每个 chunk 的行数（默认 5000） */
  chunkSize: number;
  /** 最大线程数（默认 CPU 核心数） */
  maxThreads: number;
}

export interface RowIdRange {
  start: number;
  end: number;
}

export interface ParallelExecutorOptions {
  /** Path to the worker file (auto-resolved by default) */
  workerPath?: string;
  /** Maximum number of worker threads (default: CPU cores) */
  maxThreads?: number;
  /** Timeout per worker task in ms (default: 60000) */
  taskTimeoutMs?: number;
}

/**
 * Piscina-based parallel query executor for intra-table parallel scanning.
 *
 * This executor splits a table's rowid space into chunks and dispatches
 * each chunk to a separate worker thread. Each worker opens its own read-only
 * SQLite connection for full worker isolation.
 */
export class ParallelQueryExecutor {
  private pool: Piscina;
  private options: Required<ParallelExecutorOptions>;
  private config: ParallelScanConfig;
  private destroyed: boolean = false;

  /**
   * @param config - Parallel scanning configuration
   * @param opts - Pool and worker configuration
   */
  constructor(
    config: Partial<ParallelScanConfig> = {},
    opts: ParallelExecutorOptions = {},
  ) {
    this.config = {
      minRowsForParallel: config.minRowsForParallel ?? 10000,
      chunkSize: config.chunkSize ?? 5000,
      maxThreads: config.maxThreads ?? Math.max(1, os.cpus().length),
    };

    this.options = {
      workerPath: opts.workerPath ?? resolveParallelWorkerPath(),
      // Piscina requires a strictly positive maxThreads integer and throws an
      // opaque error otherwise; clamp to at least 1 to match the config
      // field's own `Math.max(1, ...)` guard.
      maxThreads: Math.max(1, opts.maxThreads ?? this.config.maxThreads),
      taskTimeoutMs: opts.taskTimeoutMs ?? 60000,
    };

    this.pool = new Piscina({
      filename: this.options.workerPath,
      maxThreads: this.options.maxThreads,
      idleTimeout: 60000,
      concurrentTasksPerWorker: 1,
    });

    logger.info(
      {
        maxThreads: this.options.maxThreads,
        chunkSize: this.config.chunkSize,
        minRowsForParallel: this.config.minRowsForParallel,
        workerPath: this.options.workerPath,
      },
      'ParallelQueryExecutor initialized with Piscina thread pool',
    );
  }

  /**
   * 执行并行扫描
   *
   * @param dbPath SQLite 数据库文件路径
   * @param baseSql 要执行的 SQL（不含 WHERE rowid 条件；可包含已有 WHERE 子句）
   * @param params SQL 参数（? 占位符绑定值）
   * @param tableName 表名（用于获取 rowid 范围）
   * @param conditions 过滤条件（可选，仅用于决定是否启用并行）
   * @returns 合并后的结果行数组
   */
  async executeParallelScan(
    dbPath: string,
    baseSql: string,
    params: any[],
    tableName: string,
    conditions?: QueryCondition[],
  ): Promise<any[]> {
    if (this.destroyed) {
      throw new Error('ParallelQueryExecutor has been destroyed');
    }

    // Step 1: 检查是否满足并行条件
    const rangeInfo = this.getRowIdRange(dbPath, tableName);
    if (rangeInfo.count < this.config.minRowsForParallel) {
      logger.debug(
        { tableName, rowCount: rangeInfo.count, threshold: this.config.minRowsForParallel },
        'Table too small for parallel scan; caller should fall back to sequential',
      );
      // Return empty signal — caller handles fallback
      return [];
    }

    // Step 2: 将 rowid 范围分片
    const chunks = this.partitionRowIdRange(
      rangeInfo.min,
      rangeInfo.max,
      this.config.chunkSize,
    );

    if (chunks.length === 0) {
      return [];
    }

    // Cap chunks to maxThreads
    const actualChunks = chunks.length <= this.options.maxThreads
      ? chunks
      : this._mergeChunks(chunks, this.options.maxThreads);

    logger.debug(
      { tableName, rowCount: rangeInfo.count, chunkCount: actualChunks.length, threads: this.options.maxThreads },
      'Dispatching parallel scan chunks',
    );

    // Step 3: Dispatch all chunks to workers in parallel
    const results = await Promise.allSettled(
      actualChunks.map((chunk) =>
        this.pool.run({
          dbPath,
          baseSql,
          params,
          startRowId: chunk.start,
          endRowId: chunk.end,
          timeoutMs: this.options.taskTimeoutMs,
        }),
      ),
    );

    // Step 4: Merge results from all workers
    const mergedRows: any[] = [];
    let errorCount = 0;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const workerResult = result.value as any;
        if (workerResult.success) {
          mergedRows.push(...workerResult.rows);
        } else {
          errorCount++;
          logger.error(
            { error: workerResult.error },
            'Parallel scan worker chunk failed',
          );
        }
      } else {
        errorCount++;
        logger.error(
          { error: result.reason?.message || 'Unknown worker error' },
          'Parallel scan worker threw unhandled exception',
        );
      }
    }

    if (errorCount > 0) {
      logger.warn(
        { totalChunks: actualChunks.length, errorCount },
        'Parallel scan completed with some worker errors; results may be partial',
      );
    }

    return mergedRows;
  }

  /**
   * 获取表的 rowid 范围。
   *
   * 打开一个临时的只读连接查询 min(rowid), max(rowid), count(*)，
   * 然后立即关闭连接。
   *
   * @param dbPath SQLite 数据库文件路径
   * @param tableName 表名
   * @returns rowid 范围信息
   */
  getRowIdRange(
    dbPath: string,
    tableName: string,
  ): { min: number; max: number; count: number } {
    let db: Database.Database | null = null;
    try {
      const isInMemory = !dbPath || dbPath === ':memory:' || dbPath.startsWith('file::memory:');
      if (isInMemory) {
        return { min: 0, max: 0, count: 0 };
      }

      db = new Database(dbPath, { readonly: true });
      db.pragma('busy_timeout = 2000');

      const row = db
        .prepare(
          `SELECT COALESCE(min(rowid), 0) as minRowid, ` +
          `COALESCE(max(rowid), 0) as maxRowid, ` +
          `COALESCE(count(*), 0) as rowCount ` +
          `FROM [${tableName}]`,
        )
        .get() as { minRowid: number; maxRowid: number; rowCount: number };

      return {
        min: row.minRowid,
        max: row.maxRowid,
        count: row.rowCount,
      };
    } catch (err: any) {
      logger.error(
        { tableName, dbPath, error: err.message },
        'Failed to get rowid range for table',
      );
      return { min: 0, max: 0, count: 0 };
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // Best-effort close
        }
      }
    }
  }

  /**
   * 将 rowid 范围分片成多个 chunk。
   *
   * 每个 chunk 覆盖不多于 `chunkSize` 行，但均匀分布
   * 在整个 rowid 范围内（非密集 rowid 时也适用）。
   *
   * @param min 最小 rowid（含）
   * @param max 最大 rowid（含）
   * @param chunkSize 每个 chunk 的行数
   * @returns 分片数组，每个包含 start 和 end
   */
  partitionRowIdRange(
    min: number,
    max: number,
    chunkSize: number,
  ): RowIdRange[] {
    if (min > max || chunkSize <= 0) {
      return [];
    }

    const range = max - min + 1;
    const numChunks = Math.ceil(range / chunkSize);

    const chunks: RowIdRange[] = [];
    for (let i = 0; i < numChunks; i++) {
      const start = min + i * chunkSize;
      const end = Math.min(start + chunkSize - 1, max);
      chunks.push({ start, end });
    }

    return chunks;
  }

  /**
   * 更新并行扫描配置。
   */
  setConfig(config: Partial<ParallelScanConfig>): void {
    if (config.minRowsForParallel !== undefined) {
      this.config.minRowsForParallel = config.minRowsForParallel;
    }
    if (config.chunkSize !== undefined) {
      this.config.chunkSize = config.chunkSize;
    }
    if (config.maxThreads !== undefined) {
      this.config.maxThreads = config.maxThreads;
    }
  }

  /**
   * 获取当前配置。
   */
  getConfig(): ParallelScanConfig {
    return { ...this.config };
  }

  /**
   * 获取 Piscina 池的工作线程数。
   */
  get poolSize(): number {
    return this.options.maxThreads;
  }

  /**
   * 检查并行执行器是否已被销毁。
   */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * 销毁 Piscina 线程池，释放所有资源。
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      await this.pool.destroy();
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Error destroying Piscina pool');
    }
    logger.info('ParallelQueryExecutor destroyed');
  }

  // ── Private Helpers ───────────────────────────────────────────

  /**
   * 将过多的 chunk 合并为指定数量的 chunk。
   * 用于将 chunk 数量限制为 maxThreads。
   */
  private _mergeChunks(chunks: RowIdRange[], targetCount: number): RowIdRange[] {
    if (chunks.length <= targetCount) return chunks;

    const merged: RowIdRange[] = [];
    const chunkSize = Math.ceil(chunks.length / targetCount);

    for (let i = 0; i < chunks.length; i += chunkSize) {
      const batch = chunks.slice(i, i + chunkSize);
      merged.push({
        start: batch[0].start,
        end: batch[batch.length - 1].end,
      });
    }

    return merged;
  }
}

/**
 * Convenience function: 创建 ParallelQueryExecutor 并执行一次并行扫描。
 *
 * @param dbPath SQLite 数据库文件路径
 * @param baseSql 要执行的 SQL
 * @param params SQL 参数
 * @param tableName 表名
 * @param config 可选并行扫描配置
 * @returns 结果行数组
 *
 * @example
 * ```ts
 * const rows = await parallelQuery('/tmp/test.db', 'SELECT * FROM users', [], 'users', { chunkSize: 1000 });
 * ```
 */
export async function parallelQuery(
  dbPath: string,
  baseSql: string,
  params: any[],
  tableName: string,
  config?: Partial<ParallelScanConfig>,
): Promise<any[]> {
  const executor = new ParallelQueryExecutor(config);
  try {
    return await executor.executeParallelScan(dbPath, baseSql, params, tableName);
  } finally {
    await executor.destroy();
  }
}
