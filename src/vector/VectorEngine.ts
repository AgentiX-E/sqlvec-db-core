/**
 * VectorEngine — Dual-mode vector search engine
 *
 * Mode A: DuckDB FLOAT[] brute-force (≤ threshold rows)
 * Mode B: sqlite-vec indexed search (> threshold rows)
 *
 * Auto-selects based on row count estimation. User sees a unified API.
 *
 * Inspired by HashQL's Vector Search Technical Design.
 */

import * as path from 'path';
import * as fs from 'fs';
import duckdb from 'duckdb';
import { ShardManager } from '../storage/ShardManager';
import { HnswIndexManager } from './HnswIndexManager';
import { IVFPQIndex } from '../index/ivfpq-index';
import {
  HnswConfig,
  VectorConfig,
  VectorMode,
  VectorMetric,
  VectorSearchQuery,
  VectorSearchResult,
  VectorSearchStats,
  SqlVecError,
  SqlVecErrorCode,
} from '../core/types';

import { PinoLogger } from '../monitoring/PinoLogger';
const logger = PinoLogger.forComponent('VectorEngine');

interface DuckDBConnection {
  db: duckdb.Database;
  conn: duckdb.Connection;
}

export class VectorEngine {
  private shardManager: ShardManager;
  private config: VectorConfig;
  private duckDB: DuckDBConnection | null = null;
  private duckDBPath: string;
  private duckDBAvailable: boolean = false;
  private stats: {
    bruteForceCount: number;
    indexedCount: number;
    totalBruteForceMs: number;
    totalIndexedMs: number;
  } = { bruteForceCount: 0, indexedCount: 0, totalBruteForceMs: 0, totalIndexedMs: 0 };

  // Row count cache (refreshed every 30s)
  private rowCountCache: Map<string, { count: number; ts: number }> = new Map();

  // HNSW index (optional, used when mode=HNSW or AUTO with hnsw indexType)
  private hnswIndex: HnswIndexManager | null = null;

  // IVFPQ index (optional, used when mode=IVFPQ)
  private ivfpqIndex: IVFPQIndex | null = null;

  // Persistence paths for auto-load on startup
  private hnswIndexPath: string | null = null;
  private ivfpqIndexPath: string | null = null;
  private dataDir: string;

  // Auto-persist: WAL-style periodic checkpoint for HNSW index
  private autoPersistCount: number = 1000;       // Checkpoint every N registerHnswVectors calls
  private autoPersistHnswCounter: number = 0;     // Running count since last checkpoint
  private autoPersistHnswTimer: ReturnType<typeof setTimeout> | null = null;  // Debounce timer
  private autoPersistPending: boolean = false;     // Save already queued

  /** Enable strict dimension checking on insert/search (default: true) */
  private strictDimensionCheck: boolean = true;
  /** Expected vector dimension from config */
  private dimension: number;

  constructor(shardManager: ShardManager, config: VectorConfig, dataDir: string, options?: { strictDimensionCheck?: boolean }) {
    this.shardManager = shardManager;
    this.config = config;
    this.duckDBPath = path.join(dataDir, 'duckdb_analytics.db');
    this.dimension = config.dimension;
    this.dataDir = dataDir;
    if (options?.strictDimensionCheck !== undefined) {
      this.strictDimensionCheck = options.strictDimensionCheck;
    }
  }

  // ──────────────────────────────────────────────
  //  Lifecycle
  // ──────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.config.mode === VectorMode.BRUTEFORCE || this.config.mode === VectorMode.AUTO) {
      await this.initDuckDB();
    }
    if (this.config.mode === VectorMode.HNSW ||
        (this.config.mode === VectorMode.AUTO && this.config.indexType === 'hnsw')) {
      this.initHnswIndex();
    }
    if (this.config.mode === VectorMode.IVFPQ ||
        (this.config.mode === VectorMode.AUTO && this.config.indexType === 'ivfpq')) {
      this.initIvfpqIndex();
    }

    // Auto-load persisted indexes from well-known paths
    this.tryAutoLoadIndexes();
  }

  /**
   * Try to load persisted HNSW/IVFPQ indexes from the data directory.
   * This allows pre-built indexes to survive restarts.
   */
  private tryAutoLoadIndexes(): void {
    const fs = require('fs') as typeof import('fs');

    // Check for HNSW index files (*.hnsw + *.meta)
    if (!this.hnswIndex) {
      const hnswFiles = fs.readdirSync(this.dataDir).filter((f: string) => f.endsWith('.hnsw'));
      for (const hf of hnswFiles) {
        const basePath = path.join(this.dataDir, hf.replace(/\.hnsw$/, ''));
        const metaPath = basePath + '.meta';
        if (fs.existsSync(metaPath)) {
          try {
            const hnswCfg = {
              m: (this.config.indexParams?.m as number) ?? 32,
              efConstruction: (this.config.indexParams?.efConstruction as number) ?? 200,
              efSearch: (this.config.indexParams?.efSearch as number) ?? 200,
              maxElements: (this.config.indexParams?.maxElements as number) ?? 1_000_000,
            };
            this.hnswIndex = HnswIndexManager.loadSync(basePath, this.config.dimension, hnswCfg);
            this.hnswIndexPath = basePath;
            logger.info(`[VectorEngine] Auto-loaded HNSW index from ${basePath}.hnsw`);
            break;
          } catch (e: any) {
            logger.warn(`[VectorEngine] Failed to auto-load HNSW index from ${basePath}: ${e.message}`);
          }
        }
      }
    }

    // Check for IVFPQ index files (*.ivfpq.json)
    if (!this.ivfpqIndex) {
      const ivfFiles = fs.readdirSync(this.dataDir).filter((f: string) => f.endsWith('.ivfpq.json'));
      for (const ivf of ivfFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.dataDir, ivf), 'utf-8'));
          this.ivfpqIndex = IVFPQIndex.fromJSON(data);
          this.ivfpqIndexPath = path.join(this.dataDir, ivf);
          logger.info(`[VectorEngine] Auto-loaded IVFPQ index from ${ivf}`);
          break;
        } catch (e: any) {
          logger.warn(`[VectorEngine] Failed to auto-load IVFPQ index from ${ivf}: ${e.message}`);
        }
      }
    }
  }

  private async initDuckDB(): Promise<void> {
    const db = new duckdb.Database(':memory:'); // In‑memory for analytics
    const conn = db.connect();
    this.duckDB = { db, conn };

    // Install + load sqlite_scanner extension — gracefully degrade if unavailable
    try {
      await this.duckDBExec(conn, 'INSTALL sqlite_scanner;');
      await this.duckDBExec(conn, 'LOAD sqlite_scanner;');
      this.duckDBAvailable = true;
    } catch (err: any) {
      logger.warn(`[VectorEngine] DuckDB sqlite_scanner extension unavailable, falling back to indexed search: ${err.message || err}`);
      this.duckDBAvailable = false;
    }
  }

  initHnswIndex(spaceName?: 'l2' | 'ip'): void {
    // High defaults: M=32 for good recall on 128D, efConstruction=200 for quality build
    const hnswCfg: HnswConfig = {
      m: (this.config.indexParams?.m as number) ?? 32,
      efConstruction: (this.config.indexParams?.efConstruction as number) ?? 200,
      efSearch: (this.config.indexParams?.efSearch as number) ?? 200,
      maxElements: (this.config.indexParams?.maxElements as number) ?? 1_000_000,
      spaceName: spaceName || 'l2',
    };
    this.hnswIndex = new HnswIndexManager(this.config.dimension, hnswCfg);
  }

  /** Execute a DuckDB statement via callback-based API wrapped in Promise. */
  private duckDBExec(conn: duckdb.Connection, sql: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      conn.exec(sql, (err: any) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.duckDB) {
      this.duckDB.conn.close();
      this.duckDB.db.close();
      this.duckDB = null;
    }
  }

  // ──────────────────────────────────────────────
  //  Dimension Validation (F4)
  // ──────────────────────────────────────────────

  /**
   * Validate that a vector matches the expected dimension.
   *
   * @param vector    The vector to validate
   * @param operation Name of the operation for error context (e.g. 'insert', 'search')
   * @throws SqlVecError(VECTOR_DIMENSION_MISMATCH) if dimension doesn't match
   */
  validateDimension(vector: Float32Array, operation: string = 'unknown'): void {
    if (!this.strictDimensionCheck) return;

    if (vector.length !== this.dimension) {
      throw new SqlVecError(
        `Dimension mismatch for operation '${operation}': expected ${this.dimension} dimensions, got ${vector.length} dimensions`,
        SqlVecErrorCode.VECTOR_DIMENSION_MISMATCH,
        { expected: this.dimension, actual: vector.length, operation },
      );
    }
  }

  // ──────────────────────────────────────────────
  //  Core search — auto-selects mode
  // ──────────────────────────────────────────────

  async search(query: VectorSearchQuery): Promise<{
    results: VectorSearchResult[];
    stats: VectorSearchStats;
  }> {
    // Validate query vector dimension before proceeding
    this.validateDimension(query.queryVector, 'search');
    const start = Date.now();

    switch (this.config.mode) {
      case VectorMode.BRUTEFORCE:
        return this.bruteForceSearch(query, start);
      case VectorMode.INDEXED:
        return this.indexedSearch(query, start);
      case VectorMode.HNSW:
        return this.hnswSearch(query, start);
      case VectorMode.IVFPQ:
        return this.ivfpqSearch(query, start);
      case VectorMode.AUTO:
      default: {
        // If indexType is explicitly configured, use that index
        if (this.config.indexType === 'hnsw' && this.hnswIndex) {
          return this.hnswSearch(query, start);
        }
        if (this.config.indexType === 'ivfpq' && this.ivfpqIndex && (this.ivfpqIndex as any)['built']) {
          return this.ivfpqSearch(query, start);
        }

        // Auto-detect based on data size
        const estimated = await this.estimateTableRows(query.collection);

        // Small set: brute-force is fast enough and exact
        if (estimated <= this.config.bruteForceThreshold) {
          return this.bruteForceSearch(query, start);
        }

        // Medium set: IVFPQ (fast build, low memory, good recall on real data)
        if (this.ivfpqIndex && (this.ivfpqIndex as any)['built']) {
          return this.ivfpqSearch(query, start);
        }

        // Large set: HNSW (fastest search, reasonable build time)
        if (this.hnswIndex) {
          return this.hnswSearch(query, start);
        }

        // Fallback: indexed search (sqlite-vec)
        return this.indexedSearch(query, start);
      }
    }
  }

  /**
   * Convenience: search by embedding array.
   */
  async searchByEmbedding(
    collection: string,
    embedding: number[],
    topK: number,
    filters?: Record<string, any>,
  ): Promise<{ results: VectorSearchResult[]; stats: VectorSearchStats }> {
    const query: VectorSearchQuery = {
      collection,
      queryVector: new Float32Array(embedding),
      topK,
    };
    return this.search(query);
  }

  // ──────────────────────────────────────────────
  //  Mode A: DuckDB brute-force via sqlite_scanner
  // ──────────────────────────────────────────────

  private async bruteForceSearch(
    query: VectorSearchQuery,
    startTime: number,
  ): Promise<{ results: VectorSearchResult[]; stats: VectorSearchStats }> {
    // Graceful fallback: if DuckDB is unavailable, redirect to indexed search
    if (!this.duckDBAvailable) {
      logger.warn('[VectorEngine] DuckDB unavailable, falling back to indexed search for brute-force request');
      return this.indexedSearch(query, startTime);
    }

    if (!this.duckDB) {
      throw new SqlVecError(
        'DuckDB not initialized for brute-force mode',
        SqlVecErrorCode.INTERNAL_ERROR,
      );
    }

    const conn = this.duckDB.conn;
    const dim = this.config.dimension;
    const metricFn = this.getMetricFunction(this.config.metric);

    // Attach all shards
    const shardPaths = this.shardManager.getShardIds().map(id => {
      const shard = this.shardManager.getShard(id);
      return shard?.path;
    }).filter(Boolean);

    // If no shards, fall back to indexed search (returns empty results)
    if (shardPaths.length === 0) {
      return this.indexedSearch(query, startTime);
    }

    for (const shardPath of shardPaths) {
      const alias = `shard_${path.basename(shardPath!, '.db')}`;
      await this.duckDBExec(conn, `DETACH DATABASE IF EXISTS "${alias}";`);
      await this.duckDBExec(conn, `ATTACH '${shardPath}' AS "${alias}" (READ_ONLY);`);
    }

    // Build the query vector literal
    const vecLiteral = `CAST([${Array.from(query.queryVector).join(',')}] AS FLOAT[${dim}])`;

    // Build SQL: Union all shards, compute similarity, ORDER BY + LIMIT
    const shardQueries = shardPaths.map(shardPath => {
      const alias = `shard_${path.basename(shardPath!, '.db')}`;
      return `SELECT id, ${metricFn}(CAST(embedding AS FLOAT[${dim}]), ${vecLiteral}) AS score
              FROM "${alias}".${query.collection}
              WHERE embedding IS NOT NULL`;
    });

    const sql = `
      SELECT id, score AS distance
      FROM (
        ${shardQueries.join('\nUNION ALL\n')}
      )
      ORDER BY score ${this.config.metric === VectorMetric.L2 ? 'ASC' : 'DESC'}
      LIMIT ${query.topK}
    `;

    // Execute via DuckDB conn.all (callback-based, wrapped in Promise)
    const rows: any[] = await new Promise<any[]>((resolve, reject) => {
      conn.all(sql, (err: any, data: any[]) => {
        if (err) return reject(err);
        resolve(data || []);
      });
    });

    const results: VectorSearchResult[] = rows.map(r => ({
      id: r.id,
      distance: this.config.metric === VectorMetric.L2 ? r.distance : (1 - r.distance),
    }));

    const elapsed = Date.now() - startTime;
    this.stats.bruteForceCount++;
    this.stats.totalBruteForceMs += elapsed;

    return {
      results,
      stats: {
        mode: VectorMode.BRUTEFORCE,
        shardsSearched: shardPaths.length,
        totalCandidates: rows.length,
        searchTimeMs: elapsed,
        postFilterCount: 0,
      },
    };
  }

  // ──────────────────────────────────────────────
  //  Mode B: sqlite-vec indexed search
  // ──────────────────────────────────────────────

  private async indexedSearch(
    query: VectorSearchQuery,
    startTime: number,
  ): Promise<{ results: VectorSearchResult[]; stats: VectorSearchStats }> {
    // Search all shards via sqlite-vec, merge globally
    const perShardTopK = Math.ceil(query.topK * 1.5); // oversample for merge
    const allResults = await this.shardManager.vectorSearchAll(
      query.collection,
      query.queryVector,
      query.topK,
      perShardTopK,
    );

    const results: VectorSearchResult[] = allResults.map(r => ({
      id: r.id,
      distance: r.distance,
      metadata: { shardId: r.shardId },
    }));

    const elapsed = Date.now() - startTime;
    this.stats.indexedCount++;
    this.stats.totalIndexedMs += elapsed;

    return {
      results,
      stats: {
        mode: VectorMode.INDEXED,
        shardsSearched: this.shardManager.getShardCount(),
        totalCandidates: allResults.length,
        searchTimeMs: elapsed,
        postFilterCount: 0,
      },
    };
  }

  // ──────────────────────────────────────────────
  //  Mode C: HNSW approximate nearest-neighbor search
  // ──────────────────────────────────────────────

  private async hnswSearch(
    query: VectorSearchQuery,
    startTime: number,
  ): Promise<{ results: VectorSearchResult[]; stats: VectorSearchStats }> {
    if (!this.hnswIndex) {
      // Graceful fallback: if HNSW index is not built, use indexed search
      logger.warn('[VectorEngine] HNSW index not initialized, falling back to indexed search');
      return this.indexedSearch(query, startTime);
    }

    const hnswResults = this.hnswIndex.search(query.queryVector, query.topK);

    const results: VectorSearchResult[] = hnswResults.map(r => ({
      id: r.id,
      distance: r.distance,
      metadata: { mode: 'hnsw' },
    }));

    const elapsed = Date.now() - startTime;
    this.stats.indexedCount++;
    this.stats.totalIndexedMs += elapsed;

    return {
      results,
      stats: {
        mode: VectorMode.HNSW,
        shardsSearched: this.shardManager.getShardCount(),
        totalCandidates: results.length,
        searchTimeMs: elapsed,
        postFilterCount: 0,
      },
    };
  }

  // ──────────────────────────────────────────────
  //  HNSW index population
  // ──────────────────────────────────────────────

  /**
   * Register vectors with the HNSW index.
   * Called during INSERT operations to keep the HNSW index in sync.
   */
  registerHnswVectors(vectors: Float32Array[], ids: number[]): void {
    if (this.hnswIndex) {
      // Validate each vector dimension
      for (const vec of vectors) {
        this.validateDimension(vec, 'registerHnswVectors');
      }
      this.hnswIndex.addPoints(vectors, ids);

      // Trigger auto-persist checkpoint if threshold reached
      this.autoPersistHnswCounter += vectors.length;
      if (this.autoPersistHnswCounter >= this.autoPersistCount) {
        this.scheduleHnswPersist();
      }
    }
  }

  /**
   * Register vectors with the IVFPQ index.
   * Called during INSERT operations to keep the IVFPQ index in sync.
   */
  registerIvfpqVectors(vectors: Float32Array[], ids: number[]): void {
    if (this.ivfpqIndex) {
      // Validate each vector dimension
      for (const vec of vectors) {
        this.validateDimension(vec, 'registerIvfpqVectors');
      }
      // IVFPQ.add() expects Float64Array[] — convert from Float32Array
      const f64Vectors: Float64Array[] = vectors.map(v => new Float64Array(v));
      this.ivfpqIndex.add(f64Vectors, ids);
    }
  }

  /**
   * Build the HNSW index from all vectors in the vec0 virtual tables.
   * Uses parallel shard build when row count exceeds shardBuildThreshold (default: 10K).
   * Useful at startup or after bulk-loading data.
   */
  async refreshHnswIndex(tableName: string, shardBuildThreshold: number = 10000): Promise<number> {
    if (!this.hnswIndex) return 0;

    const rows = await this.shardManager.queryAll(
      `SELECT id, embedding FROM vec_${tableName}`,
    );

    // Small dataset: incremental addPoints (no overhead of worker threads)
    if (rows.length < shardBuildThreshold) {
      return this._refreshHnswIncremental(rows);
    }

    // Large dataset: parallel shard build
    logger.info(
      `[VectorEngine] Large refresh (${rows.length} rows) — using parallel shard build`,
    );
    return this._refreshHnswShard(rows);
  }

  /** Incremental addPoints for small datasets. */
  private async _refreshHnswIncremental(
    rows: Array<{ id: number; embedding: Buffer }>,
  ): Promise<number> {
    const batchSize = 1000;
    let count = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const vectors: Float32Array[] = [];
      const ids: number[] = [];
      for (const row of batch) {
        const emb = new Float32Array(row.embedding.buffer);
        vectors.push(emb);
        ids.push(row.id);
      }
      this.hnswIndex!.addPoints(vectors, ids);
      count += vectors.length;
    }
    return count;
  }

  /** Parallel shard build for large datasets. */
  private async _refreshHnswShard(
    rows: Array<{ id: number; embedding: Buffer }>,
  ): Promise<number> {
    const vectors: Float32Array[] = new Array(rows.length);
    const ids: number[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      vectors[i] = new Float32Array(rows[i].embedding.buffer);
      ids[i] = rows[i].id;
    }
    await this.hnswIndex!.shardBuild(vectors, ids);
    return vectors.length;
  }

  /** Check whether HNSW index is active. */
  isHnswAvailable(): boolean {
    return this.hnswIndex !== null && this.hnswIndex.getCurrentCount() > 0;
  }

  /** Get the underlying HnswIndexManager (for advanced usage). */
  getHnswIndex(): HnswIndexManager | null {
    return this.hnswIndex;
  }

  // ──────────────────────────────────────────────
  //  IVFPQ index (lightweight alternative to HNSW)
  // ──────────────────────────────────────────────

  private initIvfpqIndex(): void {
    const K = (this.config.indexParams?.ivfpqK as number) ?? 64;
    const M = (this.config.indexParams?.ivfpqM as number) ?? 8;
    const nprobe = (this.config.indexParams?.ivfpqNprobe as number) ?? 8;
    this.ivfpqIndex = new IVFPQIndex({
      dim: this.config.dimension,
      K,
      M,
      codebookSize: 256,
      nprobe,
    });
  }

  private async ivfpqSearch(
    query: VectorSearchQuery,
    startTime: number,
  ): Promise<{ results: VectorSearchResult[]; stats: VectorSearchStats }> {
    if (!this.ivfpqIndex) {
      logger.warn('[VectorEngine] IVFPQ index not initialized, falling back to brute-force');
      return this.bruteForceSearch(query, startTime);
    }
    if (!this.ivfpqIndex['built']) {
      logger.warn('[VectorEngine] IVFPQ index not trained/built yet, falling back to brute-force');
      return this.bruteForceSearch(query, startTime);
    }

    const queryVec = new Float64Array(query.queryVector);
    const results = this.ivfpqIndex.search(queryVec, query.topK);

    const mapped: VectorSearchResult[] = results.map(r => ({
      id: r.id,
      distance: r.distance,
      metadata: { mode: 'ivfpq' },
    }));

    const elapsed = Date.now() - startTime;
    this.stats.indexedCount++;
    this.stats.totalIndexedMs += elapsed;

    return {
      results: mapped,
      stats: {
        mode: VectorMode.IVFPQ,
        shardsSearched: this.shardManager.getShardCount(),
        totalCandidates: results.length,
        searchTimeMs: elapsed,
        postFilterCount: 0,
      },
    };
  }

  /**
   * Train and build the IVFPQ index from all vectors in the vec0 table.
   */
  async buildIvfpqIndex(tableName: string): Promise<void> {
    if (!this.ivfpqIndex) {
      this.initIvfpqIndex();
    }

    const rows = await this.shardManager.queryAll(
      `SELECT id, embedding FROM vec_${tableName}`,
    ) as Array<{ id: number; embedding: Buffer }>;

    if (rows.length === 0) return;

    const vectors: Float64Array[] = [];
    const ids: number[] = [];

    for (const row of rows) {
      const emb = new Float32Array(row.embedding.buffer);
      vectors.push(new Float64Array(emb));
      ids.push(row.id);
    }

    // Train on sampled subset (IVFPQ internally handles this)
    this.ivfpqIndex!.train(vectors);
    this.ivfpqIndex!.add(vectors, ids);
  }

  /** Check whether IVFPQ index is available. */
  isIvfpqAvailable(): boolean {
    return this.ivfpqIndex !== null && (this.ivfpqIndex as any)['built'] === true;
  }

  /** Get the underlying IVFPQIndex instance. */
  getIvfpqIndex(): IVFPQIndex | null {
    return this.ivfpqIndex;
  }

  // ──────────────────────────────────────────────
  //  Persistence path management
  // ──────────────────────────────────────────────

  /** Set the path for the persisted HNSW index (for save/load tracking). */
  setHnswIndexPath(basePath: string): void {
    this.hnswIndexPath = basePath;
    logger.info(`[VectorEngine] HNSW index path set to ${basePath}.hnsw`);
  }

  /** Set the path for the persisted IVFPQ index (for save/load tracking). */
  setIvfpqIndexPath(filePath: string): void {
    this.ivfpqIndexPath = filePath;
    logger.info(`[VectorEngine] IVFPQ index path set to ${filePath}`);
  }

  /** Get the tracked HNSW index path (null if not persisted). */
  getHnswIndexPath(): string | null {
    return this.hnswIndexPath;
  }

  /** Get the tracked IVFPQ index path (null if not persisted). */
  getIvfpqIndexPath(): string | null {
    return this.ivfpqIndexPath;
  }

  // ──────────────────────────────────────────────
  //  Auto-Persist (WAL-style checkpoint)
  // ──────────────────────────────────────────────

  /**
   * Schedule an async HNSW index persist.
   * Uses debounce: if a save is already queued, resets the 200ms timer.
   * Reset counter so the next checkpoint happens after N more vectors.
   */
  private scheduleHnswPersist(): void {
    this.autoPersistHnswCounter = 0;
    if (this.autoPersistPending) return; // already queued

    this.autoPersistPending = true;
    this.autoPersistHnswTimer = setTimeout(() => {
      this.autoPersistPending = false;
      this.autoPersistHnswTimer = null;
      this.doHnswPersist().catch((e: Error) => {
        logger.warn({ err: e.message }, '[VectorEngine] Auto-persist failed (non-blocking)');
      });
    }, 200);
    // Unref so it doesn't keep the process alive
    if (this.autoPersistHnswTimer?.unref) this.autoPersistHnswTimer.unref();
  }

  /**
   * Perform the actual HNSW index save.
   * Non-blocking: errors are logged, never thrown.
   */
  private async doHnswPersist(): Promise<void> {
    if (!this.hnswIndex || !this.hnswIndexPath) return;
    try {
      this.hnswIndex.saveSync(this.hnswIndexPath);
      logger.info('[VectorEngine] HNSW auto-persist complete');
    } catch (e: any) {
      logger.warn({ err: e.message }, '[VectorEngine] HNSW auto-persist error');
    }
  }

  /**
   * Force a synchronous persist now (e.g., before shutdown).
   * Returns true if persisted, false if no index or no path set.
   */
  forcePersistHnsw(): boolean {
    if (!this.hnswIndex || !this.hnswIndexPath) return false;
    try {
      this.hnswIndex.saveSync(this.hnswIndexPath);
      this.autoPersistHnswCounter = 0;
      logger.info('[VectorEngine] HNSW force-persist complete');
      return true;
    } catch (e: any) {
      logger.warn({ err: e.message }, '[VectorEngine] HNSW force-persist error');
      return false;
    }
  }

  /**
   * On startup: compare persisted index count vs vec0 table, repair if needed.
   * Queries vec0 for vectors after the saved count and adds them incrementally.
   *
   * @returns number of vectors added (0 = consistent), or -1 on error.
   */
  async syncIndexWithVec0(tableName: string): Promise<number> {
    if (!this.hnswIndex || !this.hnswIndexPath) return -1;
    const savedCount = this.hnswIndex.getCurrentCount();

    // Count current vectors in the vec0 table
    const countRows = await this.shardManager.queryAll(
      `SELECT COUNT(*) as cnt FROM vec_${tableName}`,
    );
    const vec0Count = Number((countRows as any[])[0]?.cnt ?? 0);

    if (vec0Count <= savedCount) return 0; // consistent

    const missing = vec0Count - savedCount;
    logger.info(
      `[VectorEngine] Index has ${savedCount} vectors, vec0 has ${vec0Count} — adding ${missing} missing`,
    );

    // Fetch only the missing vectors (after savedCount)
    const rows = await this.shardManager.queryAll(
      `SELECT id, embedding FROM vec_${tableName} WHERE id > ${savedCount}`,
    );

    let added = 0;
    const batchSize = 1000;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const vectors: Float32Array[] = [];
      const ids: number[] = [];

      for (const row of batch as Array<{ id: number; embedding: Buffer }>) {
        const emb = new Float32Array(row.embedding.buffer);
        vectors.push(emb);
        ids.push(row.id);
      }
      this.hnswIndex.addPoints(vectors, ids);
      added += vectors.length;
    }

    // Persist the repaired index
    this.autoPersistHnswCounter = 0;
    this.hnswIndex.saveSync(this.hnswIndexPath);
    logger.info(`[VectorEngine] Index repaired: added ${added} vectors, persisted`);

    return added;
  }

  private getMetricFunction(metric: VectorMetric): string {
    switch (metric) {
      case VectorMetric.COSINE:
        return 'list_cosine_similarity';   // DuckDB built‑in
      case VectorMetric.L2:
        return 'list_distance';            // DuckDB built‑in
      case VectorMetric.IP:
        return 'list_dot_product';         // DuckDB built‑in
    }
  }

  private async estimateTableRows(tableName: string): Promise<number> {
    const cached = this.rowCountCache.get(tableName);
    if (cached && (Date.now() - cached.ts) < 30000) {
      return cached.count;
    }

    try {
      const rows = this.shardManager.queryAll(`SELECT COUNT(*) AS cnt FROM "${tableName}"`);
      const [firstRow] = await rows;
      const total = Array.isArray(firstRow) ? (firstRow[0] as any)?.cnt ?? 0 : (firstRow as any)?.cnt ?? 0;

      this.rowCountCache.set(tableName, { count: total, ts: Date.now() });
      return total;
    } catch {
      return 0;
    }
  }

  /** Get engine statistics. */
  getStats() {
    return {
      ...this.stats,
      avgBruteForceMs: this.stats.bruteForceCount > 0
        ? this.stats.totalBruteForceMs / this.stats.bruteForceCount : 0,
      avgIndexedMs: this.stats.indexedCount > 0
        ? this.stats.totalIndexedMs / this.stats.indexedCount : 0,
      mode: this.config.mode,
      dimension: this.config.dimension,
      hnswIndexSize: this.hnswIndex?.getCurrentCount() ?? 0,
      hnswAvailable: this.hnswIndex !== null,
    };
  }

  /** Update config at runtime (for gradual rollout). */
  updateConfig(config: Partial<VectorConfig>): void {
    if (config.dimension !== undefined) {
      this.dimension = config.dimension;
    }
    Object.assign(this.config, config);
  }
}
