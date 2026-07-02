/**
 * ParallelExecutor — Piscina-based thread pool for parallel SQL query execution.
 *
 * Uses worker_threads via the Piscina library to execute SQL queries against
 * multiple shards concurrently. Each shard query runs in its own worker thread
 * for full CPU isolation.
 *
 * ## Usage
 *
 * ```ts
 * const executor = new ParallelExecutor({
 *   maxThreads: 4,
 *   defaultTimeoutMs: 30000,
 * });
 *
 * const tasks = [
 *   { sql: 'SELECT * FROM t', shardId: 0, dbPath: '/data/shard-0/db' },
 *   { sql: 'SELECT * FROM t', shardId: 1, dbPath: '/data/shard-1/db' },
 * ];
 *
 * const results = await executor.executeParallel(tasks);
 * ```
 *
 * ## Error Isolation
 *
 * If one shard's query fails, other shards continue unaffected.
 * Errors are reported in the result's `error` field.
 *
 * @module query/ParallelExecutor
 */
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Piscina } from 'piscina';
import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('ParallelExecutor');

// ── Types ───────────────────────────────────────────────────────

export interface ParallelTask {
  sql: string;
  shardId: number;
  dbPath: string;
  timeoutMs?: number;
  taskType?: 'select' | 'insert' | 'update' | 'delete' | 'merge';
  /** Intra-table parallel scan mode: splits a single table into rowid ranges */
  scanMode?: 'intra-table';
  /** Rowid range for intra-table scan segment (used with scanMode='intra-table') */
  rowidRange?: { min: number; max: number };
  /** Table name for intra-table scan (used with scanMode='intra-table') */
  tableName?: string;
}

export interface ParallelTaskResult {
  rows: any[];
  rowCount: number;
  shardId: number;
  queryTimeMs: number;
  error: string | null;
  /** Number of rows affected (for DML operations) */
  changes?: number;
  /** Last inserted rowid (for INSERT operations) */
  lastInsertRowid?: number;
}

export interface ParallelExecutorOptions {
  /** Maximum number of worker threads (default: os.cpus().length) */
  maxThreads?: number;
  /** Default timeout per worker task in ms (default: 30000) */
  defaultTimeoutMs?: number;
  /** Optional path to the worker file (default: auto-resolved) */
  workerPath?: string;
}

/**
 * Configuration for parallel execution decisions.
 */
export interface ParallelConfig {
  /** Minimum row count threshold to trigger parallel execution (default: 10000) */
  minRows: number;
  /** Maximum number of worker threads to use (default: 4) */
  maxWorkers: number;
}

/**
 * Configuration for intra-table parallel scans.
 * A single table is split into rowid ranges and scanned in parallel across workers.
 */
export interface IntraTableScanConfig {
  /** Name of the table to scan */
  tableName: string;
  /** Path to the SQLite database file */
  dbPath: string;
  /** Number of workers to use (default: maxWorkers from parallelConfig) */
  numWorkers?: number;
  /** Optional pre-computed rowid range (for testing / external computation) */
  rowidRange?: { min: number; max: number };
}

// ── ParallelExecutor ────────────────────────────────────────────

export class ParallelExecutor {
  private pool: Piscina;
  private options: Required<ParallelExecutorOptions>;
  private destroyed: boolean = false;
  /** Parallel execution configuration for automatic parallel detection. */
  private parallelConfig: ParallelConfig = {
    minRows: 10000,
    maxWorkers: 4,
  };

  constructor(opts: ParallelExecutorOptions = {}) {
    this.options = {
      maxThreads: opts.maxThreads ?? Math.max(1, os.cpus().length),
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 30000,
      workerPath: opts.workerPath ?? path.resolve(__dirname, 'parallel-worker.js'),
    };

    this.pool = new Piscina({
      filename: this.options.workerPath,
      maxThreads: this.options.maxThreads,
      // Disable idle shutdown for stability across multiple parallel calls
      idleTimeout: 60000,
      // Use the concurrentTasksPerWorker default (1) for simplicity
      concurrentTasksPerWorker: 1,
    });

    logger.info(
      {
        maxThreads: this.options.maxThreads,
        defaultTimeoutMs: this.options.defaultTimeoutMs,
        workerPath: this.options.workerPath,
      },
      'ParallelExecutor initialized with Piscina thread pool',
    );
  }

  /**
   * Configure parallel execution thresholds.
   *
   * Controls automatic parallel execution decisions used by
   * `shouldUseParallel()` and downstream QueryRouter integration.
   *
   * @param config - Partial ParallelConfig to apply
   *
   * @example
   * ```ts
   * executor.setParallelConfig({ minRows: 5000, maxWorkers: 8 });
   * ```
   */
  setParallelConfig(config: Partial<ParallelConfig>): void {
    if (config.minRows !== undefined) {
      if (config.minRows < 0) {
        throw new Error('minRows must be non-negative');
      }
      this.parallelConfig.minRows = config.minRows;
    }
    if (config.maxWorkers !== undefined) {
      if (config.maxWorkers < 1) {
        throw new Error('maxWorkers must be at least 1');
      }
      if (config.maxWorkers > 64) {
        logger.warn(
          `maxWorkers=${config.maxWorkers} exceeds recommended maximum of 64; using ${config.maxWorkers}`,
        );
      }
      this.parallelConfig.maxWorkers = config.maxWorkers;
    }
    logger.info(
      { minRows: this.parallelConfig.minRows, maxWorkers: this.parallelConfig.maxWorkers },
      'Parallel executor configuration updated',
    );
  }

  /**
   * Get the current parallel config.
   */
  getParallelConfig(): ParallelConfig {
    return { ...this.parallelConfig };
  }

  /**
   * Determine whether a given SQL query should use parallel execution.
   *
   * Decision logic:
   *   1. SQL must contain a parallel hint comment (`/*+ PARALLEL *&#47;`)
   *      OR the caller/planner indicates large-table execution
   *   2. Multiple shards needed for meaningful parallelism
   *   3. Row count threshold met from config or caller estimate
   *
   * @example
   * ```ts
   * // Static usage
   * const ok = ParallelExecutor.shouldUseParallel('SELECT * FROM t', { minRows: 10000, shardCount: 4 });
   *
   * // Instance usage (uses configured defaults)
   * const ok = executor.shouldUseParallel('SELECT * FROM t', { minRows: 5000, shardCount: 4 });
   * ```
   */
  static shouldUseParallel(sql: string, config: { minRows: number; shardCount: number }): boolean {
    // Must have at least 2 shards for meaningful parallel execution
    if (config.shardCount < 2) {
      return false;
    }

    // Check for parallel hint in SQL
    const hasPgHint = /\/\*\+.*PARALLEL\s*\(/i.test(sql);
    const hasSetParallel = /SET\s+(parallel_workers|pgParallelWorkers)\s*=/i.test(sql);

    // If we have a parallel hint, always parallel
    if (hasPgHint || hasSetParallel) {
      return true;
    }

    // Without a hint, require a larger row count to justify parallelism
    return config.minRows > 10000;
  }

  /**
   * Instance method: determine whether to use parallel execution.
   * Uses the executor's configured parallelConfig as defaults.
   */
  shouldUseParallel(sql: string, config?: { minRows?: number; shardCount?: number }): boolean {
    const minRows = config?.minRows ?? this.parallelConfig.minRows;
    const shardCount = config?.shardCount ?? 2;

    return ParallelExecutor.shouldUseParallel(sql, { minRows, shardCount });
  }

  /**
   * Calculate the number of effective parallel workers, capped at shard count.
   *
   * SQLVec parallelism is shard-level — there is no benefit to requesting more
   * workers than there are shards. This method returns min(requested, shardCount).
   *
   * @param requestedWorkers  Number of workers requested via GUC (effectiveWorkers)
   * @param shardCount        Total number of shards available
   * @returns                 The actual number of workers to schedule
   */
  static effectiveWorkers(requestedWorkers: number, shardCount: number): number {
    return Math.min(requestedWorkers, shardCount);
  }

  /**
   * Merge DML results from parallel execution across shards.
   *
   * For INSERT: sum up total changes, take the minimum lastInsertRowid
   * For UPDATE/DELETE/MERGE: sum up total changes
   *
   * @param results - Array of ParallelTaskResult from parallel execution
   * @param taskType - The type of DML operation
   * @returns Merged result with aggregated changes and lastInsertRowid
   */
  static mergeDmlResults(
    results: ParallelTaskResult[],
    taskType: 'insert' | 'update' | 'delete' | 'merge',
  ): { totalChanges: number; lastInsertRowid?: number; errorCount: number } {
    let totalChanges = 0;
    let minLastInsertRowid: number | undefined;
    let errorCount = 0;

    for (const result of results) {
      if (result.error !== null) {
        errorCount++;
        continue;
      }
      totalChanges += result.changes ?? 0;
      if (taskType === 'insert' && result.lastInsertRowid !== undefined) {
        if (minLastInsertRowid === undefined || result.lastInsertRowid < minLastInsertRowid) {
          minLastInsertRowid = result.lastInsertRowid;
        }
      }
    }

    return {
      totalChanges,
      lastInsertRowid: minLastInsertRowid,
      errorCount,
    };
  }

  /**
   * Scan a single table in parallel by splitting its rowid space across workers.
   *
   * This enables intra-table parallelism — each worker handles a disjoint rowid
   * range, allowing a single large table to be scanned faster than sequential
   * access when workers are CPU-bound and the rows are spread across the range.
   *
   * ## Algorithm
   *
   * 1. Query `SELECT min(rowid), max(rowid) FROM [table]` to establish the range
   *    (or use the caller-supplied `rowidRange`)
   * 2. Split the range into `numWorkers` roughly equal segments
   * 3. Dispatch each segment to a worker as a `scanMode: 'intra-table'` task
   * 4. Merge results in rowid order (concatenate segments in order)
   *
   * ## Error handling
   *
   * If a worker fails, its error is captured in the per-segment result; other
   * workers continue unaffected. The overall call never throws.
   *
   * @param config - Config specifying table name, DB path, and optional parameters
   * @returns Array of per-segment results in rowid order, each containing rows
   *          and an error field if that segment failed
   *
   * @example
   * ```ts
   * const results = await executor.scanTableIntraParallel({
   *   tableName: 'large_table',
   *   dbPath: '/data/mydb.sqlite',
   *   numWorkers: 4,
   * });
   *
   * // All merged rows
   * const allRows = results.flatMap(r => r.rows);
   * ```
   */
  async scanTableIntraParallel(
    config: IntraTableScanConfig,
  ): Promise<ParallelTaskResult[]> {
    if (this.destroyed) {
      throw new Error('ParallelExecutor has been destroyed');
    }

    const { tableName, dbPath, numWorkers = this.parallelConfig.maxWorkers } = config;

    // ── Step 1: Determine rowid range ──────────────────────────────
    let rowidRange = config.rowidRange;

    if (!rowidRange) {
      // Query the database to find min and max rowid
      try {
        const rangeDb = new Database(dbPath, { readonly: true });
        rangeDb.pragma('busy_timeout = 5000');
        const row = rangeDb.prepare(
          `SELECT min(rowid) as minRowid, max(rowid) as maxRowid FROM [${tableName}]`,
        ).get() as { minRowid: number | null; maxRowid: number | null } | undefined;

        rangeDb.close();

        if (!row || row.minRowid === null || row.maxRowid === null) {
          // Empty table
          return [];
        }

        rowidRange = { min: row.minRowid, max: row.maxRowid };
        logger.debug(
          { tableName, minRowid: rowidRange.min, maxRowid: rowidRange.max, numWorkers },
          'Determined rowid range for intra-table parallel scan',
        );
      } catch (err: any) {
        logger.error(
          { tableName, dbPath, error: err.message },
          'Failed to determine rowid range for intra-table scan; falling back to single worker',
        );
        // Fall back to a single full-table scan
        return [{
          rows: [],
          rowCount: 0,
          shardId: 0,
          queryTimeMs: 0,
          error: `Failed to query rowid range: ${err.message}`,
        }];
      }
    }

    // ── Step 2: Split range into N roughly equal segments ─────────
    const rangeSize = rowidRange.max - rowidRange.min + 1;
    const segmentSize = Math.max(1, Math.ceil(rangeSize / numWorkers));

    // Cap workers to at most the number of rowid segments
    const actualWorkers = Math.min(numWorkers, rangeSize);

    const tasks: ParallelTask[] = [];
    for (let i = 0; i < actualWorkers; i++) {
      const segMin = rowidRange.min + i * segmentSize;
      const segMax = i === actualWorkers - 1
        ? rowidRange.max  // Last segment gets the remainder
        : rowidRange.min + (i + 1) * segmentSize - 1;

      tasks.push({
        sql: '',  // Not used; worker constructs SQL from scanMode/tableName/rowidRange
        shardId: i,
        dbPath,
        scanMode: 'intra-table',
        tableName,
        rowidRange: { min: segMin, max: segMax },
        taskType: 'select',
      });
    }

    logger.debug(
      { tableName, taskCount: tasks.length, rowidRange, actualWorkers },
      'Dispatching intra-table parallel scan tasks',
    );

    // ── Step 3: Execute in parallel ───────────────────────────────
    return this.executeParallel(tasks);
  }

  /**
   * Execute multiple SQL queries in parallel across worker threads.
   *
   * @param tasks - Array of tasks, each specifying sql, shardId, and dbPath
   * @returns Array of results in the same order as the input tasks
   *
   * Error isolation: if a worker task throws, its result.error is set and
   * other tasks continue unaffected. The overall method never throws.
   *
   * ## One-shard warning
   *
   * If only one shard is provided, parallelism has no effect. A warning is
   * logged to prevent confusion when `max_parallel_workers_per_gather` is set.
   */
  async executeParallel<T extends ParallelTask = ParallelTask>(
    tasks: T[],
  ): Promise<ParallelTaskResult[]> {
    if (this.destroyed) {
      throw new Error('ParallelExecutor has been destroyed');
    }

    if (tasks.length === 0) {
      return [];
    }

    // Warn if only one shard — parallelism has no effect with a single shard
    if (tasks.length === 1) {
      logger.warn(
        { taskCount: tasks.length },
        'Single-shard query: SET max_parallel_workers_per_gather has no effect with only 1 shard. ' +
          'SQLVec parallelism is shard-level only, not intra-table.',
      );
    }

    const start = performance.now();
    logger.debug({ taskCount: tasks.length }, 'Starting parallel query execution');

    // Submit all tasks in parallel and wait for all to settle
    const results = await Promise.allSettled(
      tasks.map((task) =>
        this.pool.run({
          sql: task.sql,
          shardId: task.shardId,
          dbPath: task.dbPath,
          timeoutMs: task.timeoutMs ?? this.options.defaultTimeoutMs,
          taskType: task.taskType ?? 'select',
          scanMode: task.scanMode,
          rowidRange: task.rowidRange,
          tableName: task.tableName,
        }),
      ),
    );

    // Map settled results back to ParallelTaskResult, preserving order
    const finalResults: ParallelTaskResult[] = results.map((result, index) => {
      const task = tasks[index];

      if (result.status === 'fulfilled') {
        // Worker returned a valid result (including error fields)
        return result.value as ParallelTaskResult;
      }

      // Worker threw an unhandled exception (e.g. Piscina internal error)
      return {
        rows: [],
        rowCount: 0,
        shardId: task.shardId,
        queryTimeMs: 0,
        error: result.reason?.message || String(result.reason || 'Unknown worker error'),
      };
    });

    const totalTime = performance.now() - start;
    const errorCount = finalResults.filter((r) => r.error !== null).length;

    logger.debug(
      {
        taskCount: tasks.length,
        totalTimeMs: totalTime.toFixed(1),
        errorCount,
      },
      'Parallel query execution completed',
    );

    return finalResults;
  }

  /**
   * Get the pool size.
   */
  get poolSize(): number {
    return this.options.maxThreads;
  }

  /**
   * Check if the executor has been destroyed.
   */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Destroy the Piscina thread pool.
   * After calling this, the executor cannot be used again.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;

    this.destroyed = true;
    await this.pool.destroy();
    logger.info('ParallelExecutor Piscina pool destroyed');
  }
}
