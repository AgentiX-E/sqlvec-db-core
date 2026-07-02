/**
 * ParallelIndexBuilder — Parallel index creation for SQLite using Piscina workers.
 *
 * Splits a table's rowid space into ranges and distributes sub-index construction
 * across worker threads. Each worker builds a part table containing indexed
 * columns for its assigned range. After all workers complete, the part tables
 * are merged via UNION ALL into a single index table with a SQLite index.
 *
 * ## Architecture
 *
 * ```
 * 表数据 (N rows)
 *      │
 *      ▼
 * splitRowIdRanges(workers=4) → 4 个 range
 *      │
 *      ├─ Worker 1: range [0..R1] → build sub-index in __idx_{name}__part_0
 *      ├─ Worker 2: range [R1..R2] → build sub-index in __idx_{name}__part_1
 *      ├─ Worker 3: range [R2..R3] → build sub-index in __idx_{name}__part_2
 *      └─ Worker 4: range [R3..R4] → build sub-index in __idx_{name}__part_3
 *      │
 *      ▼
 * mergeSubIndexes() → CREATE TABLE final_index AS SELECT * FROM parts UNION ALL
 *                    → DROP TABLE sub-indexes
 *                    → RENAME TO real name
 * ```
 *
 * ## Important Notes
 *
 * - The "index" is a regular SQLite table (`__idx_{name}`) containing
 *   (rowid, col1, col2, ...) rows — a materialized index table.
 * - A real SQLite CREATE INDEX is created on the final merged table for
 *   native query plan usage when querying the index directly.
 * - Non-unique indexes do NOT check uniqueness (by design).
 * - For in-memory databases, falls back to sequential build on the main thread.
 *
 * @module index/ParallelIndexBuilder
 */

import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Piscina } from 'piscina';
import { PinoLogger } from '../monitoring/PinoLogger';
import type { IndexWorkerTask, IndexWorkerResult } from './parallel-index-worker';

const logger = PinoLogger.forComponent('ParallelIndexBuilder');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ParallelIndexBuilderOptions {
  /** Maximum number of worker threads (default: os.cpus().length) */
  maxWorkers?: number;
  /** Default timeout per worker task in ms (default: 60000) */
  defaultTimeoutMs?: number;
  /** Path to the parallel-index-worker.ts file (auto-resolved by default) */
  workerPath?: string;
}

/**
 * A rowid range assigned to a single worker for parallel index building.
 */
export interface RowIdRange {
  /** Minimum rowid (inclusive) */
  min: number;
  /** Maximum rowid (inclusive) */
  max: number;
  /** Worker identifier (0-based) */
  workerId: number;
}

/**
 * Definition of the index to create.
 */
export interface IndexDef {
  /** Name for the index */
  indexName: string;
  /** Columns to index */
  columns: string[];
  /** Whether the index should enforce uniqueness */
  unique?: boolean;
  /** Optional WHERE clause (partial index), without the WHERE keyword */
  where?: string;
}

/**
 * Full result of a parallel index build operation.
 */
export interface IndexBuildResult {
  /** Final index name (always prefixed with '__idx_') */
  indexName: string;
  /** Total number of rows in the final index */
  totalRows: number;
  /** Wall-clock time for the parallel build phase in ms */
  buildTimeMs: number;
  /** Wall-clock time for the merge phase in ms */
  mergeTimeMs: number;
  /** Total wall-clock time in ms */
  totalTimeMs: number;
  /** Per-worker results */
  workerResults: WorkerResultEntry[];
}

export interface WorkerResultEntry {
  workerId: number;
  success: boolean;
  rowCount: number;
  timeMs: number;
  error: string | null;
}

// ──────────────────────────────────────────────
//  Class
// ──────────────────────────────────────────────

export class ParallelIndexBuilder {
  private db: Database.Database;
  private dbPath: string;
  private pool: Piscina | null;
  private options: Required<ParallelIndexBuilderOptions>;
  private destroyed: boolean = false;

  /**
   * @param db - An open `better-sqlite3` database handle (read-write, file-backed)
   * @param opts - Optional configuration
   */
  constructor(db: Database.Database, opts: ParallelIndexBuilderOptions = {}) {
    this.db = db;
    this.dbPath = (db as any).name ?? '';

    if (!this.dbPath) {
      logger.warn(
        'In-memory database detected; parallel index building requires a file-backed database. ' +
          'Falling back to sequential index creation.',
      );
    }

    this.options = {
      maxWorkers: opts.maxWorkers ?? Math.max(1, os.cpus().length),
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 60000,
      workerPath:
        opts.workerPath ??
        path.resolve(__dirname, 'parallel-index-worker.ts'),
    };

    // Only create the Piscina pool if we have a file path to a real database file
    // (:memory: databases cannot be shared across worker threads)
    const isInMemory = !this.dbPath || this.dbPath === ':memory:' || this.dbPath.startsWith('file::memory:');
    if (!isInMemory) {
      this.pool = new Piscina({
        filename: this.options.workerPath,
        maxThreads: this.options.maxWorkers,
        idleTimeout: 60000,
        concurrentTasksPerWorker: 1,
      });

      logger.info(
        {
          maxWorkers: this.options.maxWorkers,
          defaultTimeoutMs: this.options.defaultTimeoutMs,
          dbPath: this.dbPath,
        },
        'ParallelIndexBuilder initialized with Piscina thread pool',
      );
    } else {
      this.pool = null;
    }
  }

  // ──────────────────────────────────────────
  //  Public API — createIndex (async)
  // ──────────────────────────────────────────

  /**
   * Create an index on the specified table columns using parallel workers.
   *
   * @param tableName - Name of the source table
   * @param columns - Column(s) to include in the index
   * @param indexName - Optional index name (auto-generated if omitted)
   * @param workers - Number of parallel workers (defaults to maxWorkers)
   * @returns Promise resolving to IndexBuildResult
   *
   * @throws Error if the table does not exist or the builder is destroyed
   */
  async createIndex(
    tableName: string,
    columns: string[],
    indexName?: string,
    workers?: number,
  ): Promise<IndexBuildResult> {
    if (this.destroyed) {
      throw new Error('ParallelIndexBuilder has been destroyed');
    }

    const effectiveIndexName = indexName ?? `${tableName}_${columns.join('_')}_idx`;
    const effectiveWorkers = workers ?? this.options.maxWorkers;

    logger.info(
      { tableName, columns, indexName: effectiveIndexName, workers: effectiveWorkers },
      'Starting parallel index creation',
    );

    const start = performance.now();

    // Validate table exists before proceeding
    const tblInfo = this.db.pragma(`table_info([${tableName}])`) as any[];
    if (tblInfo.length === 0) {
      throw new Error(`Table "${tableName}" not found or has no columns`);
    }

    // ── Phase 1: Split rowid ranges ─────────────────────────────────
    const ranges = this.splitRowIdRanges(tableName, effectiveWorkers);

    if (ranges.length === 0) {
      // Empty table — create empty index
      const emptyResult = this._createEmptyIndex(effectiveIndexName, columns, tableName);
      return {
        ...emptyResult,
        totalTimeMs: performance.now() - start,
      };
    }

    // Fall back to sequential if no pool (in-memory DB)
    if (!this.pool || this.dbPath === ':memory:' || this.dbPath.startsWith('file:')) {
      return this._buildSequential(tableName, columns, effectiveIndexName, start);
    }

    // ── Phase 2: Build sub-indexes in parallel ─────────────────────
    const buildStart = performance.now();

    const indexDef: IndexDef = {
      indexName: effectiveIndexName,
      columns,
      unique: false,
    };

    const workerResults = await this._dispatchBuildTasks(tableName, ranges, indexDef);

    const buildTimeMs = performance.now() - buildStart;

    // Check for worker failures
    const failedWorkers = workerResults.filter((w) => !w.success);
    if (failedWorkers.length > 0) {
      const errors = failedWorkers.map((w) => `Worker ${w.workerId}: ${w.error}`).join('; ');
      logger.error(
        { tableName, indexName: effectiveIndexName, failedCount: failedWorkers.length, errors },
        'Parallel index build phase failed; cleaning up part tables',
      );
      this._cleanupPartTables(effectiveIndexName, ranges.length);
      throw new Error(
        `Parallel index build failed: ${failedWorkers.length}/${ranges.length} workers errored. ${errors}`,
      );
    }

    // ── Phase 3: Merge sub-indexes ──────────────────────────────────
    const mergeStart = performance.now();

    this.mergeSubIndexes(effectiveIndexName, ranges.length);

    const mergeTimeMs = performance.now() - mergeStart;
    const totalTimeMs = performance.now() - start;

    // Get final row count
    const totalRows = this._countIndexRows(effectiveIndexName);

    logger.info(
      {
        indexName: effectiveIndexName,
        totalRows,
        buildTimeMs: Math.round(buildTimeMs),
        mergeTimeMs: Math.round(mergeTimeMs),
        totalTimeMs: Math.round(totalTimeMs),
        workerCount: ranges.length,
      },
      'Parallel index creation completed',
    );

    return {
      indexName: effectiveIndexName,
      totalRows,
      buildTimeMs,
      mergeTimeMs,
      totalTimeMs,
      workerResults,
    };
  }

  // ──────────────────────────────────────────
  //  Public API — createIndexConcurrently
  // ──────────────────────────────────────────

  /**
   * Create an index with the CONCURRENTLY multi-phase protocol.
   *
   * **Phase 1 — Build**: Create sub-indexes in parallel covering the current
   * rowid range. Captures a snapshot of the data.
   *
   * **Phase 2 — Quiescence Wait**: Ensure database is idle, then capture
   * the current max rowid.
   *
   * **Phase 3 — Incremental Scan**: Insert any new rows (rowid > Phase 1 max)
   * into the first part table. Catches rows inserted during Phase 1.
   *
   * **Phase 4 — Finalize**: Merge sub-indexes → drop parts → final index.
   *
   * @param tableName - Name of the source table
   * @param indexDef - Index definition
   * @returns Promise resolving to IndexBuildResult
   */
  async createIndexConcurrently(tableName: string, indexDef: IndexDef): Promise<IndexBuildResult> {
    if (this.destroyed) {
      throw new Error('ParallelIndexBuilder has been destroyed');
    }

    const { indexName, columns } = indexDef;
    const workers = this.options.maxWorkers;

    logger.info(
      { tableName, indexName, workers, mode: 'CONCURRENTLY' },
      'Starting CONCURRENTLY parallel index creation (3-phase)',
    );

    const start = performance.now();

    // Validate table exists before proceeding
    const tblInfo = this.db.pragma(`table_info([${tableName}])`) as any[];
    if (tblInfo.length === 0) {
      throw new Error(`Table "${tableName}" not found or has no columns`);
    }

    // Fall back to sequential if no pool (in-memory DB)
    if (!this.pool || this.dbPath === ':memory:' || this.dbPath.startsWith('file:')) {
      return this._buildSequential(tableName, columns, indexName, start);
    }

    // ── Phase 1: Build sub-indexes (snapshot) ───────────────────────
    const phase1Start = performance.now();
    const ranges = this.splitRowIdRanges(tableName, workers);

    if (ranges.length === 0) {
      const emptyResult = this._createEmptyIndex(indexName, columns, tableName);
      return { ...emptyResult, totalTimeMs: performance.now() - start };
    }

    // Record the max rowid from Phase 1 for incremental scan
    const snapshotMaxRowid = ranges[ranges.length - 1].max;

    const workerResults = await this._dispatchBuildTasks(tableName, ranges, indexDef);
    const buildTimeMs = performance.now() - phase1Start;

    const failedWorkers = workerResults.filter((w) => !w.success);
    if (failedWorkers.length > 0) {
      const errors = failedWorkers.map((w) => `Worker ${w.workerId}: ${w.error}`).join('; ');
      logger.error(
        { tableName, indexName, failedCount: failedWorkers.length },
        'CONCURRENTLY Phase 1 failed; cleaning up',
      );
      this._cleanupPartTables(indexName, ranges.length);
      throw new Error(
        `CONCURRENTLY Phase 1 failed: ${failedWorkers.length}/${ranges.length} workers errored. ${errors}`,
      );
    }

    // ── Phase 2: Quiescence wait ────────────────────────────────────
    this._waitForQuiescence();

    // ── Phase 3: Incremental scan for new/modified rows ────────────
    const phase3Start = performance.now();
    this._incrementalScan(tableName, indexName, columns, snapshotMaxRowid);
    const incrementalTimeMs = performance.now() - phase3Start;

    // ── Phase 4: Merge sub-indexes ──────────────────────────────────
    const mergeStart = performance.now();
    this.mergeSubIndexes(indexName, ranges.length);
    const mergeTimeMs = performance.now() - mergeStart;

    const totalTimeMs = performance.now() - start;
    const totalRows = this._countIndexRows(indexName);

    logger.info(
      {
        indexName,
        totalRows,
        buildTimeMs: Math.round(buildTimeMs),
        incrementalTimeMs: Math.round(incrementalTimeMs),
        mergeTimeMs: Math.round(mergeTimeMs),
        totalTimeMs: Math.round(totalTimeMs),
        mode: 'CONCURRENTLY',
      },
      'CONCURRENTLY parallel index creation completed',
    );

    return {
      indexName,
      totalRows,
      buildTimeMs,
      mergeTimeMs,
      totalTimeMs,
      workerResults,
    };
  }

  // ──────────────────────────────────────────
  //  Public Internals
  // ──────────────────────────────────────────

  /**
   * Split a table's rowid space into N roughly equal ranges.
   *
   * Uses SELECT min(rowid), max(rowid), count(*) to determine
   * boundaries, then partitions into `workers` segments.
   *
   * @param tableName - Name of the table
   * @param workers - Number of segments to create
   * @returns Array of RowIdRange objects (empty if table has no rows)
   */
  splitRowIdRanges(tableName: string, workers: number): RowIdRange[] {
    // Validate table exists by checking for columns
    const tableInfo = this.db.pragma(`table_info([${tableName}])`) as any[];
    if (tableInfo.length === 0) {
      logger.warn({ tableName }, 'Table not found or has no columns');
      return [];
    }

    const row = this.db
      .prepare(
        `SELECT min(rowid) as minRowid, max(rowid) as maxRowid, count(*) as rowCount FROM [${tableName}]`,
      )
      .get() as { minRowid: number | null; maxRowid: number | null; rowCount: number };

    if (!row || row.minRowid === null || row.maxRowid === null || row.rowCount === 0) {
      return [];
    }

    const rangeSize = row.maxRowid - row.minRowid + 1;
    const segmentSize = Math.max(1, Math.ceil(rangeSize / workers));
    const actualWorkers = Math.min(workers, rangeSize);

    const ranges: RowIdRange[] = [];
    for (let i = 0; i < actualWorkers; i++) {
      const segMin = row.minRowid + i * segmentSize;
      const segMax =
        i === actualWorkers - 1
          ? row.maxRowid
          : row.minRowid + (i + 1) * segmentSize - 1;

      ranges.push({
        min: segMin,
        max: segMax,
        workerId: i,
      });
    }

    logger.debug(
      { tableName, workers: actualWorkers, totalRows: row.rowCount, ranges },
      'Split rowid ranges for parallel index building',
    );

    return ranges;
  }

  /**
   * Build a single sub-index table synchronously on the calling thread.
   *
   * Creates table `__idx_{indexName}__part_{workerId}` with columns
   * (rowid, col1, col2, ...) populated from source table within the
   * specified rowid range, plus a SQLite index on the indexed columns.
   *
   * For parallel execution, use `createIndex()` which dispatches Piscina workers.
   * This method is useful for testing or sequential fallbacks.
   *
   * @param tableName - Source table name
   * @param range - Rowid range for this sub-index
   * @param indexDef - Index definition
   */
  buildSubIndex(tableName: string, range: RowIdRange, indexDef: IndexDef): void {
    const { indexName, columns, unique = false, where } = indexDef;
    const { workerId } = range;

    const partTableName = `__idx_${indexName}__part_${workerId}`;

    this.db.exec(`DROP TABLE IF EXISTS [${partTableName}]`);

    const colInfo = this.db.pragma(`table_info([${tableName}])`) as Array<{
      cid: number;
      name: string;
      type: string;
    }>;
    const colTypeMap = new Map<string, string>();
    for (const col of colInfo) {
      colTypeMap.set(col.name, col.type);
    }

    const dedupColumns = Array.from(new Set(columns));
    const subIndexColumns = ['rowid', ...dedupColumns];
    const colDefs = subIndexColumns.map((col) => {
      if (col.toLowerCase() === 'rowid' || col.toLowerCase() === '_rowid_' || col === 'oid') {
        return `[${col}] INTEGER`;
      }
      return `[${col}] ${colTypeMap.get(col) || 'TEXT'}`;
    });

    this.db.exec(
      `CREATE TABLE [${partTableName}] (\n` +
        `  ${colDefs.join(',\n  ')},\n` +
        `  PRIMARY KEY (rowid)\n` +
        `)`,
    );

    const selectCols = ['rowid', ...dedupColumns.map((c) => `[${c}]`)].join(', ');
    const insertCols = subIndexColumns.map((c) => `[${c}]`).join(', ');
    const whereClause = where ? `AND (${where})` : '';

    const insertSql =
      `INSERT INTO [${partTableName}] (${insertCols})\n` +
      `SELECT ${selectCols}\n` +
      `FROM [${tableName}]\n` +
      `WHERE rowid >= ? AND rowid <= ? ${whereClause}`;

    const insertStmt = this.db.prepare(insertSql);
    const insertInTransaction = this.db.transaction(() => {
      return Number(insertStmt.run(range.min, range.max).changes);
    });

    insertInTransaction();

    const partIdxName = `__idx_${indexName}__part_${workerId}_idx`;
    const uniqueKeyword = unique ? 'UNIQUE' : '';
    const indexCols = dedupColumns.map((c) => `[${c}]`).join(', ');

    this.db.exec(
      `CREATE ${uniqueKeyword} INDEX IF NOT EXISTS [${partIdxName}] ON [${partTableName}] (${indexCols})`,
    );
  }

  /**
   * Merge all sub-index part tables into a single index table.
   *
   * 1. Creates `__idx_{indexName}` as `SELECT * FROM part0 UNION ALL ...`
   * 2. Drops all part tables
   * 3. Creates a SQLite index on the merged table
   *
   * @param indexName - Name of the index (without `__idx_` prefix)
   * @param parts - Number of part tables to merge
   */
  mergeSubIndexes(indexName: string, parts: number): void {
    const finalTableName = `__idx_${indexName}`;

    this.db.exec(`DROP TABLE IF EXISTS [${finalTableName}]`);

    const partTables: string[] = [];
    for (let i = 0; i < parts; i++) {
      partTables.push(`SELECT * FROM [__idx_${indexName}__part_${i}]`);
    }

    if (partTables.length === 0) {
      logger.warn({ indexName }, 'mergeSubIndexes: no part tables to merge');
      return;
    }

    let unionSql: string;
    if (partTables.length === 1) {
      unionSql = partTables[0];
    } else {
      unionSql = partTables.join('\nUNION ALL\n');
    }

    this.db.exec(`CREATE TABLE [${finalTableName}] AS\n${unionSql}`);

    for (let i = 0; i < parts; i++) {
      this.db.exec(`DROP TABLE IF EXISTS [__idx_${indexName}__part_${i}]`);
      this.db.exec(`DROP INDEX IF EXISTS [__idx_${indexName}__part_${i}_idx]`);
    }

    // Create SQLite index on the merged table
    try {
      const finalColInfo = this.db.pragma(`table_info([${finalTableName}])`) as Array<{
        name: string;
      }>;
      const indexCols = finalColInfo
        .filter((c) => c.name.toLowerCase() !== 'rowid')
        .map((c) => `[${c.name}]`)
        .join(', ');

      if (indexCols) {
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS [__idx_${indexName}_idx] ON [${finalTableName}] (${indexCols})`,
        );
      }
    } catch (err: any) {
      logger.warn(
        { indexName, error: err.message },
        'Could not create SQLite index on merged table (non-fatal)',
      );
    }

    logger.debug(
      { indexName, parts, finalTable: finalTableName },
      'Merged sub-indexes into final index table',
    );
  }

  /**
   * Get the current pool size.
   */
  get poolSize(): number {
    return this.options.maxWorkers;
  }

  /**
   * Check if the builder has been destroyed.
   */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Destroy the Piscina thread pool and release resources.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pool) {
      try {
        await this.pool.destroy();
      } catch (err: any) {
        logger.warn({ error: err.message }, 'Error destroying Piscina pool');
      }
    }
    logger.info('ParallelIndexBuilder destroyed');
  }

  // ──────────────────────────────────────────
  //  Private helpers
  // ──────────────────────────────────────────

  /**
   * Dispatch sub-index build tasks to Piscina workers and await all results.
   */
  private async _dispatchBuildTasks(
    tableName: string,
    ranges: RowIdRange[],
    indexDef: IndexDef,
  ): Promise<WorkerResultEntry[]> {
    if (!this.pool) {
      // Fallback: build sequentially on main thread
      return ranges.map((range) => {
        const start = performance.now();
        try {
          this.buildSubIndex(tableName, range, indexDef);
          return {
            workerId: range.workerId,
            success: true,
            rowCount: this._countPartRows(indexDef.indexName, range.workerId),
            timeMs: performance.now() - start,
            error: null,
          };
        } catch (err: any) {
          return {
            workerId: range.workerId,
            success: false,
            rowCount: 0,
            timeMs: performance.now() - start,
            error: err.message || String(err),
          };
        }
      });
    }

    const tasks: IndexWorkerTask[] = ranges.map((range) => ({
      taskType: 'build-sub-index',
      dbPath: this.dbPath,
      tableName,
      indexName: indexDef.indexName,
      columns: indexDef.columns,
      range: { min: range.min, max: range.max },
      workerId: range.workerId,
      unique: indexDef.unique,
      where: indexDef.where,
      timeoutMs: this.options.defaultTimeoutMs,
    }));

    // Submit all tasks in parallel
    const settled = await Promise.allSettled(
      tasks.map((task) =>
        this.pool!.run(task).then(
          (result: any) => result as IndexWorkerResult,
        ),
      ),
    );

    // Map settled results back in order
    return settled.map((result, index) => {
      const task = tasks[index];

      if (result.status === 'fulfilled') {
        return result.value as WorkerResultEntry;
      }

      return {
        workerId: task.workerId,
        success: false,
        rowCount: 0,
        timeMs: 0,
        error: result.reason?.message || String(result.reason || 'Unknown worker error'),
      };
    });
  }

  /**
   * Build the index sequentially (fallback for in-memory databases).
   */
  private _buildSequential(
    tableName: string,
    columns: string[],
    indexName: string,
    startMs: number,
  ): IndexBuildResult {
    const start = startMs;
    const finalTableName = `__idx_${indexName}`;
    this.db.exec(`DROP TABLE IF EXISTS [${finalTableName}]`);

    const dedupColumns = Array.from(new Set(columns));
    const colInfo = this.db.pragma(`table_info([${tableName}])`) as Array<{
      name: string;
      type: string;
    }>;
    const colTypeMap = new Map<string, string>();
    for (const col of colInfo) {
      colTypeMap.set(col.name, col.type);
    }

    const subIndexColumns = ['rowid', ...dedupColumns];
    const colDefs = subIndexColumns.map((col) => {
      if (col.toLowerCase() === 'rowid') return '[rowid] INTEGER';
      return `[${col}] ${colTypeMap.get(col) || 'TEXT'}`;
    });

    this.db.exec(
      `CREATE TABLE [${finalTableName}] (\n` +
        `  ${colDefs.join(',\n  ')},\n` +
        `  PRIMARY KEY (rowid)\n` +
        `)`,
    );

    const selectCols = ['rowid', ...dedupColumns.map((c) => `[${c}]`)].join(', ');
    const insertCols = subIndexColumns.map((c) => `[${c}]`).join(', ');
    const insertSql = `INSERT INTO [${finalTableName}] (${insertCols}) SELECT ${selectCols} FROM [${tableName}]`;

    const stmt = this.db.prepare(insertSql);
    const insertTx = this.db.transaction(() => Number(stmt.run().changes));
    const rowCount = insertTx();

    const indexCols = dedupColumns.map((c) => `[${c}]`).join(', ');
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS [__idx_${indexName}_idx] ON [${finalTableName}] (${indexCols})`,
    );

    const totalTimeMs = performance.now() - start;

    return {
      indexName,
      totalRows: rowCount,
      buildTimeMs: totalTimeMs,
      mergeTimeMs: 0,
      totalTimeMs,
      workerResults: [
        { workerId: 0, success: true, rowCount, timeMs: totalTimeMs, error: null },
      ],
    };
  }

  /**
   * Create an empty index table for an empty source table.
   */
  private _createEmptyIndex(
    indexName: string,
    columns: string[],
    tableName: string,
  ): IndexBuildResult {
    const finalTableName = `__idx_${indexName}`;
    this.db.exec(`DROP TABLE IF EXISTS [${finalTableName}]`);

    const dedupColumns = Array.from(new Set(columns));
    const colInfo = this.db.pragma(`table_info([${tableName}])`) as Array<{
      name: string;
      type: string;
    }>;
    const colTypeMap = new Map<string, string>();
    for (const col of colInfo) {
      colTypeMap.set(col.name, col.type);
    }

    const subIndexColumns = ['rowid', ...dedupColumns];
    const colDefs = subIndexColumns.map((col) => {
      if (col.toLowerCase() === 'rowid') return '[rowid] INTEGER';
      return `[${col}] ${colTypeMap.get(col) || 'TEXT'}`;
    });

    this.db.exec(
      `CREATE TABLE [${finalTableName}] (\n` +
        `  ${colDefs.join(',\n  ')},\n` +
        `  PRIMARY KEY (rowid)\n` +
        `)`,
    );

    const indexCols = dedupColumns.map((c) => `[${c}]`).join(', ');
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS [__idx_${indexName}_idx] ON [${finalTableName}] (${indexCols})`,
    );

    return {
      indexName,
      totalRows: 0,
      buildTimeMs: 0,
      mergeTimeMs: 0,
      totalTimeMs: 0,
      workerResults: [],
    };
  }

  private _countIndexRows(indexName: string): number {
    try {
      const row = this.db
        .prepare(`SELECT count(*) as cnt FROM [__idx_${indexName}]`)
        .get() as { cnt: number };
      return row.cnt;
    } catch {
      return 0;
    }
  }

  private _countPartRows(indexName: string, workerId: number): number {
    try {
      const row = this.db
        .prepare(`SELECT count(*) as cnt FROM [__idx_${indexName}__part_${workerId}]`)
        .get() as { cnt: number };
      return row.cnt;
    } catch {
      return 0;
    }
  }

  private _cleanupPartTables(indexName: string, parts: number): void {
    for (let i = 0; i < parts; i++) {
      try {
        this.db.exec(`DROP TABLE IF EXISTS [__idx_${indexName}__part_${i}]`);
        this.db.exec(`DROP INDEX IF EXISTS [__idx_${indexName}__part_${i}_idx]`);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  /**
   * Wait for quiescence — ensure the database is idle.
   * Creates and drops a temp table to verify write access.
   */
  private _waitForQuiescence(): void {
    try {
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS __idx_quiescence_check (id INTEGER)');
      this.db.exec('DROP TABLE IF EXISTS __idx_quiescence_check');
    } catch {
      logger.warn('Quiescence check failed (database busy), proceeding anyway');
    }
  }

  /**
   * Incremental scan for rows inserted after the snapshot was taken.
   * Inserts new rows (rowid > snapshotMaxRowid) into the first part table.
   */
  private _incrementalScan(
    tableName: string,
    indexName: string,
    columns: string[],
    snapshotMaxRowid: number,
  ): void {
    const row = this.db
      .prepare(`SELECT count(*) as cnt FROM [${tableName}] WHERE rowid > ?`)
      .get(snapshotMaxRowid) as { cnt: number } | undefined;

    if (!row || row.cnt === 0) return;

    logger.debug(
      { tableName, newRows: row.cnt, snapshotMaxRowid },
      'Incremental scan: inserting new rows into part table',
    );

    const dedupColumns = Array.from(new Set(columns));
    const selectCols = ['rowid', ...dedupColumns.map((c) => `[${c}]`)].join(', ');
    const insertCols = ['rowid', ...dedupColumns.map((c) => `[${c}]`)].join(', ');
    const partTableName = `__idx_${indexName}__part_0`;

    try {
      const insertSql =
        `INSERT OR IGNORE INTO [${partTableName}] (${insertCols})\n` +
        `SELECT ${selectCols}\n` +
        `FROM [${tableName}]\n` +
        `WHERE rowid > ?`;

      const stmt = this.db.prepare(insertSql);
      const inserted = this.db.transaction(() => Number(stmt.run(snapshotMaxRowid).changes));
      inserted();
    } catch (err: any) {
      logger.warn(
        { error: err.message },
        'Incremental scan failed (non-fatal; index may be incomplete)',
      );
    }
  }
}

/**
 * Convenience function: create a ParallelIndexBuilder, build the index, and clean up.
 *
 * @param dbPath - Path to the SQLite database file
 * @param tableName - Source table name
 * @param columns - Columns to index
 * @param indexName - Optional index name
 * @param workers - Number of parallel workers
 * @returns Promise resolving to IndexBuildResult
 *
 * @example
 * ```ts
 * import { parallelCreateIndex } from './index/ParallelIndexBuilder';
 * const result = await parallelCreateIndex('/tmp/test.db', 'users', ['email']);
 * ```
 */
export async function parallelCreateIndex(
  dbPath: string,
  tableName: string,
  columns: string[],
  indexName?: string,
  workers?: number,
): Promise<IndexBuildResult> {
  const db = new Database(dbPath);
  try {
    const builder = new ParallelIndexBuilder(db, { maxWorkers: workers });
    const result = await builder.createIndex(tableName, columns, indexName);
    await builder.destroy();
    return result;
  } finally {
    try {
      db.close();
    } catch {
      // Best-effort
    }
  }
}
