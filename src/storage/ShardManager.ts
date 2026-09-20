// @ts-nocheck
/**
 * ShardManager — SQLite-based sharded storage with vector index support
 *
 * Each shard is a SQLite database file with:
 * - Data tables (standard SQL schema)
 * - vec0 virtual tables (sqlite-vec vector index)
 * - Metadata tables (shard info, schema version)
 *
 * Inspired by HashQL's ShardManager.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { PinoLogger } from '../logger/PinoLogger';
import { v4 as uuidv4 } from 'uuid';
import { WAL_CONFIGS, type WALConfig } from './WALConfig';
import { PeriodicCheckpointer } from './PeriodicCheckpointer';
import {
  ShardConfig,
  ShardStats,
  VectorConfig,
  SqlVecError,
  SqlVecErrorCode,
} from '../types/types-raw';
import { TDEEngine, type TDEAlgorithm } from './TDEEngine';
import { TDEConfig } from './TDEConfig';
import { WriteWorkerPool } from './WriteWorkerPool';

const logger = PinoLogger.forComponent('ShardManager');

/** Default number of reader connections per shard (WAL-mode concurrent readers) */
const DEFAULT_READER_POOL_SIZE = 4;

export interface ShardHandle {
  shardId: number;
  /** Writer connection (DML/DDL) — backward compatible with existing code */
  db: Database.Database;
  /** Reader connections pool (SELECT-only, round-robin) */
  readers: Database.Database[];
  /** Round-robin index for reader selection */
  readerIndex: number;
  path: string;
  vectorEnabled: boolean;
}

interface ShardQueryResult {
  rows: any[];
  shardId: number;
  queryTimeMs: number;
}

export class ShardManager {
  private shards: Map<number, ShardHandle> = new Map();
  private storageDir: string;
  private vectorConfig: VectorConfig;
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private tdeEngine: TDEEngine | null = null;
  private tdeEnabled = false;
  private tdeTempDir: string | null = null;
  /** Write worker pool for non-blocking DML execution */
  private writePool: WriteWorkerPool | null = null;
  /** Whether to use the write pool for execShard (async mode) */
  private useWritePool = false;
  /** Phase 3: WAL 写入策略 */
  private walConfig: WALConfig = WAL_CONFIGS.STANDALONE_SAFE;
  /** Phase 3: 每个 shard 的定时检查点 (仅 writer) */
  private checkpointers: Map<number, PeriodicCheckpointer> = new Map();

  constructor(storageDir: string, vectorConfig: VectorConfig) {
    this.storageDir = storageDir;
    this.vectorConfig = vectorConfig;
    this.ensureDir(storageDir);

    // Initialize TDE from environment (also sets policies dir for persistence)
    TDEConfig.setPoliciesDir(storageDir);
    TDEConfig.initFromEnv();
    const tdeConfig = TDEConfig.loadFromEnv();
    if (tdeConfig.enabled && tdeConfig.key) {
      this.tdeEngine = new TDEEngine({
        algorithm: tdeConfig.algorithm as TDEAlgorithm,
        keyDerivation: 'direct',
        keySource: tdeConfig.key.toString('base64'),
      });
      // Warm up the engine by deriving the key
      try {
        this.tdeEngine.deriveKey();
        this.tdeEnabled = true;
        logger.info('TDE initialized in ShardManager — shard files will be encrypted at rest');
      } catch (err: any) {
        logger.warn({ err: err.message }, 'TDE initialization skipped — key derivation failed');
      }
    } else if (tdeConfig.enabled && !tdeConfig.key) {
      logger.warn('TDE is enabled (SQLVEC_TDE_ENABLED=true) but SQLVEC_TDE_KEY is not set — TDE not active');
    }
  }

  // ──────────────────────────────────────────────
  //  Shard lifecycle
  // ──────────────────────────────────────────────

  /**
   * Initialize N shards. Creates missing files and bootstraps schema.
   */
  async initialize(
    shardCount: number,
    bootstrapSql?: string,
  ): Promise<void> {
    for (let i = 0; i < shardCount; i++) {
      await this.createShard(i, bootstrapSql);
    }
  }

  async createShard(shardId: number, bootstrapSql?: string): Promise<ShardHandle> {
    const shardPath = path.join(this.storageDir, `shard_${shardId}.db`);

    // If TDE is enabled, check if an encrypted file exists and decrypt it
    let openPath = shardPath;
    if (this.tdeEnabled && this.tdeEngine) {
      openPath = this.decryptShardIfNeeded(shardId, shardPath);
    }

    const db = new Database(openPath);

    // Apply WAL config (sync level, journal size limit, cache size)
    this.applyWALConfig(db, true);

    // Phase 3: Periodic checkpoint if configured
    if (this.walConfig.checkpointIntervalMs > 0) {
      const checkpointer = new PeriodicCheckpointer(db, this.walConfig.checkpointIntervalMs, `shard-${shardId}`);
      checkpointer.start();
      this.checkpointers.set(shardId, checkpointer);
    }

    // Bootstrap schema (DDL is write — execute on the main connection
    // before setting query_only. After init, all subsequent writes go
    // through the WriteWorkerPool.)
    if (bootstrapSql) {
      db.exec(bootstrapSql);
    }

    // Ensure __mvcc_xid table exists in the base schema for shard 0.
    if (shardId === 0) {
      db.exec('CREATE TABLE IF NOT EXISTS __mvcc_xid (last_xid INTEGER)');
    }

    // Enable sqlite-vec if vector support is configured
    if (this.vectorConfig.enabled) {
      this.enableVectorExtension(db);
    }

    // ── Reader connections (WAL-mode, SELECT-only) ───────────
    // SQLite WAL mode allows multiple concurrent readers without blocking
    // the writer. Create a pool of reader connections for queryAll/queryShard.
    const readers: Database.Database[] = [];
    const readerPoolSize = Math.max(1, DEFAULT_READER_POOL_SIZE);
    for (let r = 0; r < readerPoolSize; r++) {
      const reader = new Database(openPath);
      this.applyWALConfig(reader, false);
      reader.pragma('busy_timeout = 5000');
      reader.pragma('query_only = true'); // Read-only safety net
      if (this.vectorConfig.enabled) {
        this.enableVectorExtension(reader);
      }
      readers.push(reader);
    }

    const handle: ShardHandle = {
      shardId,
      db,
      readers,
      readerIndex: 0,
      path: shardPath, // Always point to the canonical path (original shard path)
      vectorEnabled: this.vectorConfig.enabled,
    };

    this.shards.set(shardId, handle);
    return handle;
  }

  /**
   * Load existing shards from disk.
   */
  async loadExisting(): Promise<number> {
    const files = fs.readdirSync(this.storageDir)
      .filter(f => f.match(/^shard_\d+\.db$/));

    for (const file of files) {
      const match = file.match(/^shard_(\d+)\.db$/);
      if (!match) continue;
      const shardId = parseInt(match[1], 10);

      const shardPath = path.join(this.storageDir, file);

      // If TDE is enabled, decrypt the shard file before opening
      let openPath = shardPath;
      if (this.tdeEnabled && this.tdeEngine) {
        openPath = this.decryptShardIfNeeded(shardId, shardPath);
      }

      const db = new Database(openPath);
      this.applyWALConfig(db, true);

      // Phase 3: Periodic checkpoint if configured
      if (this.walConfig.checkpointIntervalMs > 0) {
        const checkpointer = new PeriodicCheckpointer(db, this.walConfig.checkpointIntervalMs, `shard-${shardId}`);
        checkpointer.start();
        this.checkpointers.set(shardId, checkpointer);
      }

      // Ensure __mvcc_xid table exists in the base schema for shard 0.
      // This prevents WAL replay corruption when persistXid creates it
      // at runtime — the table is always part of the base schema.
      if (shardId === 0) {
        db.exec('CREATE TABLE IF NOT EXISTS __mvcc_xid (last_xid INTEGER)');
      }

      if (this.vectorConfig.enabled) {
        this.enableVectorExtension(db);
      }

      // ── Reader connections ────────────────────────
      const readers: Database.Database[] = [];
      const readerPoolSize = Math.max(1, DEFAULT_READER_POOL_SIZE);
      for (let r = 0; r < readerPoolSize; r++) {
        const reader = new Database(openPath);
        this.applyWALConfig(reader, false);
        reader.pragma('busy_timeout = 5000');
        reader.pragma('query_only = true');
        readers.push(reader);
      }

      this.shards.set(shardId, {
        shardId,
        db,
        readers,
        readerIndex: 0,
        path: shardPath,
        vectorEnabled: this.vectorConfig.enabled,
      });
    }

    return this.shards.size;
  }

  /** Pick the next reader connection (round-robin) for a shard */
  private pickReader(shard: ShardHandle): Database.Database {
    if (shard.readers && shard.readers.length > 0) {
      const reader = shard.readers[shard.readerIndex % shard.readers.length];
      shard.readerIndex = (shard.readerIndex + 1) >>> 0; // unsigned increment
      return reader;
    }
    // Fallback: single-node setup may not have separate readers.
    // Use the main DB connection directly.
    return shard.db;
  }

  async close(): Promise<void> {
    // Close write pool first (worker must release its connections)
    await this.closeWritePool();

    for (const [, shard] of this.shards) {
      // Checkpoint and truncate WAL before close to minimize companion file sizes
      if (this.tdeEnabled && shard.db?.open) {
        try {
          shard.db.pragma('wal_checkpoint(TRUNCATE)');
        } catch { /* non-fatal */ }
      }
      shard.db.close();
      for (const reader of shard.readers) {
        reader.close();
      }
    }

    // If TDE is enabled, encrypt each shard file at rest
    if (this.tdeEnabled && this.tdeEngine) {
      logger.info(
        { shardCount: this.shards.size },
        'TDE: encrypting shard files at rest',
      );
      for (const [, shard] of this.shards) {
        this.encryptShardFile(shard.path);
      }
    }

    // Clean up TDE temp directory
    this.cleanupTdeTempDir();

    this.shards.clear();
  }

  // ──────────────────────────────────────────────
  //  Query execution
  // ──────────────────────────────────────────────

  /**
   * Execute a query on all shards in parallel.
   * Uses reader connections for WAL-mode concurrency.
   * M-05: Uses Promise.allSettled to isolate single-shard failures instead
   * of Promise.all which would fail the entire query on one shard error.
   */
  async queryAll(sql: string, params?: any[]): Promise<any[]> {
    const results: any[] = [];
    const errors: Error[] = [];

    const promises = Array.from(this.shards.entries()).map(async ([shardId, shard]) => {
      try {
        const reader = this.pickReader(shard);
        const stmt = reader.prepare(sql);
        const rows = stmt.all(...(params || []));
        return { shardId, rows };
      } catch (err: any) {
        throw err;
      }
    });

    const settled = await Promise.allSettled(promises);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(...result.value.rows);
      } else {
        errors.push(result.reason);
      }
    }

    if (errors.length > 0 && results.length === 0) {
      throw new SqlVecError(
        `Query failed on all shards: ${errors[0].message}`,
        SqlVecErrorCode.INTERNAL_ERROR,
      );
    }

    return results;
  }

  /**
   * Execute a write on all shards in parallel.
   * Each shard is a different SQLite file, so parallel execution is safe.
   * Uses direct db.exec() on each shard's writer connection.
   */
  async execAll(sql: string): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [shardId] of this.shards) {
      promises.push(this.execShard(shardId, sql));
    }
    await Promise.all(promises);
  }

  /**
   * Execute a batch of SQLs on all shards in a single transaction each.
   * All SQLs are wrapped in BEGIN IMMEDIATE ... COMMIT per shard.
   * Shards execute in parallel (each is a different SQLite file).
   * This eliminates per-SQL auto-commit overhead.
   */
  async execAllBatch(sqls: string[]): Promise<void> {
    if (sqls.length === 0) return;

    const batchSql = `BEGIN IMMEDIATE;\n${sqls.join(';\n')};\nCOMMIT;`;

    // Execute on each shard in parallel.
    // Each shard is a different SQLite file, so no write lock contention.
    // Wrapping all SQLs in a single BEGIN/COMMIT eliminates per-SQL
    // auto-commit overhead, which is ~5ms of event-loop blocking per SQL.
    const promises: Promise<void>[] = [];
    for (const [shardId, shard] of this.shards) {
      promises.push(this._execBatchRaw(shardId, shard, batchSql, sqls));
    }
    await Promise.all(promises);
  }

  /**
   * Execute a batch of SQLs on a single shard in a BEGIN IMMEDIATE ... COMMIT.
   * For use with shard-aware routing (each batch targets exactly one shard).
   */
  async execBatchOnShard(shardId: number, sqls: string[]): Promise<void> {
    if (sqls.length === 0) return;
    const shard = this.shards.get(shardId);
    if (!shard) throw new Error(`Shard ${shardId} not found`);

    // Chunk into groups of 50 to avoid building multi-GiB SQL strings
    // when a single COMMIT flushes thousands of pendingChanges (e.g.
    // pgbench scale=10 COPY → 2000 INSERTs buffered).
    const CHUNK_SIZE = 50;
    for (let i = 0; i < sqls.length; i += CHUNK_SIZE) {
      const chunk = sqls.slice(i, i + CHUNK_SIZE);
      const batchSql = `BEGIN IMMEDIATE;\n${chunk.join(';\n')};\nCOMMIT;`;
      await this._execBatchRaw(shardId, shard, batchSql, chunk);
    }
  }

  private _execBatchRaw(shardId: number, shard: ShardHandle, batchSql: string, sqls: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        shard.db.exec(batchSql);
        resolve();
      } catch (err: any) {
        logger.error({ shardId, sql: sqls.slice(0, 4), err: err.message }, 'execAllBatch failed');
        reject(err);
      }
    });
  }

  /**
   * Execute on a specific shard.
   * Uses a reader connection for WAL-mode concurrency.
   * Returns rows with both object keys and raw positional values.
   * For queries with duplicate column names (e.g. JOIN with same-named columns),
   * row._raw preserves the full value array (position-based).
   */
  queryShard(shardId: number, sql: string, params?: any[]): any[] {
    const shard = this.shards.get(shardId);
    if (!shard) {
      throw new SqlVecError(
        `Shard ${shardId} not available`,
        SqlVecErrorCode.SHARD_UNAVAILABLE,
      );
    }
    const reader = this.pickReader(shard);
    const stmt = reader.prepare(sql);
    const colNames = stmt.columns().map((c: { name: string }) => c.name);
    const hasDups = colNames.length !== new Set(colNames).size;

    if (hasDups) {
      // Use raw mode to preserve all values when columns have duplicate names
      const rawRows = stmt.raw(true).all(...(params || []));
      return (rawRows as any[][]).map((raw) => {
        const obj: Record<string, any> = {};
        for (let i = 0; i < raw.length; i++) {
          const key = i < colNames.length ? colNames[i] : `col${i}`;
          // Only set the first occurrence; duplicates are accessible via _raw
          // Only set the first occurrence; duplicates are accessible via _raw
          if (!(key in obj)) obj[key] = raw[i];
        }
        (obj as any)._raw = raw;
        return obj;
      });
    }

    return stmt.all(...(params || []));
  }

  // ──────────────────────────────────────────────
  //  Write worker pool
  // ──────────────────────────────────────────────

  /**
   * Initialize the write worker pool.
   * Spawns a dedicated worker thread that opens persistent connections
   * to all shard database files. Call after all shards are created/loaded.
   */
  async initWritePool(): Promise<void> {
    if (this.shards.size === 0) {
      logger.warn('Cannot init write pool — no shards available');
      return;
    }
    const shardPaths: Record<number, string> = {};
    for (const [shardId, shard] of this.shards) {
      shardPaths[shardId] = shard.path;
    }
    this.writePool = new WriteWorkerPool();
    try {
      await this.writePool.initialize(shardPaths);
      this.useWritePool = true;
      logger.info({ shardCount: this.shards.size }, 'Write worker pool initialized');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Write worker pool init failed — falling back to sync writes');
      this.writePool = null;
      this.useWritePool = false;
    }
  }

  /** Close the write worker pool */
  private async closeWritePool(): Promise<void> {
    if (this.writePool) {
      await this.writePool.close();
      this.writePool = null;
      this.useWritePool = false;
    }
  }

  // ──────────────────────────────────────────────
  //  Query execution
  // ──────────────────────────────────────────────

  /**
   * Execute write on a specific shard.
   * Routes through the WriteWorkerPool to avoid blocking the main
   * thread's event loop. The worker holds the sole write-capable
   * connection to each shard file, avoiding WAL write-lock conflicts.
   */
  async execShard(shardId: number, sql: string): Promise<void> {
    if (this.useWritePool && this.writePool) {
      const result = await this.writePool.exec(shardId, sql);
      if (result.changes < 0) throw new Error('Write failed');
      return;
    }
    // Fallback: direct execution (not available when query_only=true)
    const shard = this.shards.get(shardId);
    if (!shard) {
      throw new SqlVecError(`Shard ${shardId} not available`, SqlVecErrorCode.SHARD_UNAVAILABLE);
    }
    shard.db.exec(sql);
  }

  /**
   * Run a transaction across all shards.
   * Uses the writer connection (DML needs write access).
   */
  async transactionAll(fn: (shard: ShardHandle) => void): Promise<void> {
    for (const [, shard] of this.shards) {
      const txn = shard.db.transaction(() => fn(shard));
      txn();
    }
  }

  // ──────────────────────────────────────────────
  //  Vector operations
  // ──────────────────────────────────────────────

  /**
   * Create a vec0 virtual table on all shards.
   */
  createVectorIndex(
    tableName: string,
    dimension: number,
    metric: string = 'cosine',
  ): void {
    const sql = `CREATE VIRTUAL TABLE IF NOT EXISTS vec_${tableName} USING vec0(
      id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimension}] distance_metric=${metric}
    )`;
    this.execAll(sql);
  }

  /**
   * Insert vector + metadata in a single transaction on the target shard.
   */
  vectorInsert(
    shardId: number,
    tableName: string,
    id: number,
    embedding: Float32Array,
    metadata?: Record<string, any>,
  ): void {
    const shard = this.shards.get(shardId);
    if (!shard) {
      throw new SqlVecError(
        `Shard ${shardId} not available`,
        SqlVecErrorCode.SHARD_UNAVAILABLE,
      );
    }

    const embBlob = Buffer.from(embedding.buffer);

    shard.db.transaction(() => {
      // Insert into main table
      if (metadata) {
        const cols = Object.keys(metadata).join(', ');
        const vals = Object.values(metadata);
        const placeholders = vals.map(() => '?').join(', ');
        shard.db.prepare(
          `INSERT OR REPLACE INTO ${tableName} (id, ${cols}) VALUES (?, ${placeholders})`,
        ).run(id, ...vals);
      }

      // Insert into vec0 virtual table
      shard.db.prepare(
        `INSERT OR REPLACE INTO vec_${tableName} (id, embedding) VALUES (?, ?)`,
      ).run(id, embBlob);
    })();
  }

  /**
   * Vector search on a single shard — returns (id, distance) pairs.
   */
  vectorSearch(
    shardId: number,
    tableName: string,
    queryVector: Float32Array,
    topK: number,
  ): Array<{ id: number; distance: number }> {
    const shard = this.shards.get(shardId);
    if (!shard) return [];

    const embBlob = Buffer.from(queryVector.buffer);
    const rows = shard.db.prepare(
      `SELECT id, distance
       FROM vec_${tableName}
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
    ).all(embBlob, topK) as Array<{ id: number; distance: number }>;

    return rows;
  }

  /**
   * Vector search on ALL shards, with global merge.
   */
  async vectorSearchAll(
    tableName: string,
    queryVector: Float32Array,
    topK: number,
    perShardTopK?: number,
  ): Promise<Array<{ id: number; distance: number; shardId: number }>> {
    const perShard = perShardTopK || Math.ceil(topK * 1.5); // oversample for merge
    const allResults: Array<{ id: number; distance: number; shardId: number }> = [];
    const errors: Error[] = [];

    const promises = Array.from(this.shards.entries()).map(async ([shardId, shard]) => {
      try {
        const embBlob = Buffer.from(queryVector.buffer);
        const rows = shard.db.prepare(
          `SELECT id, distance
           FROM vec_${tableName}
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`,
        ).all(embBlob, perShard) as Array<{ id: number; distance: number }>;

        for (const row of rows) {
          allResults.push({ ...row, shardId });
        }
      } catch (err: any) {
        errors.push(err);
      }
    });

    await Promise.all(promises);

    if (errors.length > 0 && allResults.length === 0) {
      throw new SqlVecError(
        `Vector search failed on all shards: ${errors[0].message}`,
        SqlVecErrorCode.INTERNAL_ERROR,
      );
    }

    // Global merge sort
    allResults.sort((a, b) => a.distance - b.distance);
    return allResults.slice(0, topK);
  }

  // ──────────────────────────────────────────────
  //  Utilities
  // ──────────────────────────────────────────────

  getShard(shardId: number): ShardHandle | undefined {
    return this.shards.get(shardId);
  }

  getShardCount(): number {
    return this.shards.size;
  }

  getAllShards(): Map<number, ShardHandle> {
    return this.shards;
  }

  getShardIds(): number[] {
    return Array.from(this.shards.keys());
  }

  /**
   * Get stats for all shards.
   */
  getStats(): ShardStats[] {
    const stats: ShardStats[] = [];
    for (const [, shard] of this.shards) {
      const stmt = shard.db.prepare(
        "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table'",
      );
      const result = stmt.get() as { cnt: number } | undefined;

      stats.push({
        shardId: shard.shardId,
        rowCount: this.getShardRowCount(shard),
        dbSizeBytes: fs.existsSync(shard.path) ? fs.statSync(shard.path).size : 0,
        vectorIndexSizeBytes: 0, // sqlite-vec stores in same db
        lastWriteTs: Date.now(),
        isHealthy: true,
      });
    }
    return stats;
  }

  private getShardRowCount(shard: ShardHandle): number {
    try {
      const tables = shard.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND substr(name, 1, 4) != 'vec_' AND name NOT LIKE 'sqlite_%'",
      ).all() as Array<{ name: string }>;

      let total = 0;
      for (const { name } of tables) {
        const row = shard.db.prepare(`SELECT COUNT(*) as cnt FROM "${name}"`).get() as { cnt: number };
        total += row.cnt;
      }
      return total;
    } catch {
      return 0;
    }
  }

  /**
   * Deterministic shard assignment by key hash.
   */
  getShardIdForKey(key: string, shardCount: number): number {
    const hash = this.hashKey(key);
    return Number(hash % BigInt(shardCount));
  }

  private hashKey(key: string): bigint {
    let hash = BigInt(0);
    for (let i = 0; i < key.length; i++) {
      hash = (hash * BigInt(31) + BigInt(key.charCodeAt(i))) % BigInt(2 ** 53);
    }
    return hash;
  }

  private enableVectorExtension(db: Database.Database): void {
    try {
      db.loadExtension('vec0');
    } catch {
      // sqlite-vec may not be available — log and continue
    }
  }

  /**
   * Apply WAL configuration to a database connection.
   * Writers get periodic checkpoint; readers skip it.
   */
  private applyWALConfig(db: Database.Database, isWriter: boolean): void {
    const cfg = this.walConfig;
    db.pragma('journal_mode = WAL');
    db.pragma(`synchronous = ${cfg.syncLevel}`);
    db.pragma(`cache_size = ${cfg.cacheSize}`);
    db.pragma('busy_timeout = 5000');
    if (isWriter) {
      db.pragma(`journal_size_limit = ${cfg.journalSizeLimit}`);
      db.pragma('foreign_keys = ON');
    } else {
      db.pragma('query_only = true');
    }
  }

  /**
   * Set WAL config. Applies to future shards AND retrofits existing shards.
   * For cluster mode: pass CLUSTER_ACCEL to set synchronous=OFF on all shards.
   */
  setWALConfig(config: WALConfig): void {
    const prev = this.walConfig;
    this.walConfig = config;
    // Retrofit existing shards
    let retrofitted = 0;
    for (const [, shard] of this.shards) {
      this.applyWALConfig(shard.db, true);
      retrofitted++;
      // Restart checkpointer if interval changed
      if (config.checkpointIntervalMs > 0) {
        const existing = this.checkpointers.get(shard.shardId);
        if (existing) {
          existing.stop();
        }
        const cp = new PeriodicCheckpointer(shard.db, config.checkpointIntervalMs);
        cp.start();
        this.checkpointers.set(shard.shardId, cp);
      }
    }
    logger.info({
      syncLevel: config.syncLevel,
      checkpointIntervalMs: config.checkpointIntervalMs,
      retrofitted,
    }, 'WAL config updated and retrofitted to existing shards');
  }

  /** Get current WAL config */
  getWALConfig(): WALConfig {
    return { ...this.walConfig };
  }

  /** Stop all periodic checkpointers */
  stopCheckpointers(): void {
    for (const [shardId, cp] of this.checkpointers) {
      cp.stop();
    }
    this.checkpointers.clear();
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ──────────────────────────────────────────────
  //  TDE integration
  // ──────────────────────────────────────────────

  /**
   * Get the path for a WAL or SHM companion file.
   */
  private static getCompanionPath(dbPath: string, ext: string): string {
    return dbPath + ext;
  }

  /**
   * Get the temp path for a WAL or SHM companion file during TDE operations.
   */
  private static getCompanionTempPath(dbPath: string, ext: string): string {
    return dbPath + ext + '.tde_decrypted';
  }

  /**
   * Encrypt a WAL or SHM companion file using the TDE engine.
   * After encrytion, replaces the original with the encrypted version.
   */
  private encryptCompanionFile(
    dbPath: string,
    ext: string,
    keyVersion: number,
  ): void {
    const companionPath = ShardManager.getCompanionPath(dbPath, ext);
    if (!fs.existsSync(companionPath)) return;

    const stat = fs.statSync(companionPath);
    if (stat.size === 0) {
      // Empty file — delete it (no data to protect)
      try { fs.unlinkSync(companionPath); } catch { /* best effort */ }
      return;
    }

    const dir = path.dirname(companionPath);
    const tempEncPath = ShardManager.getCompanionTempPath(companionPath, '.encrypting');

    const result = this.tdeEngine!.encryptFile(companionPath, tempEncPath);
    if (!result.success) {
      logger.warn(
        { companionPath, err: result.error },
        'TDE: companion file encryption failed — removing unencrypted file',
      );
      try { fs.unlinkSync(tempEncPath); } catch { /* best effort */ }
      // Delete the unencrypted companion rather than leave it exposed
      try { fs.unlinkSync(companionPath); } catch { /* best effort */ }
      return;
    }

    // Atomic replace with fsync
    this.atomicReplace(tempEncPath, companionPath, dir);

    logger.debug(
      { companionPath, keyVersion },
      'TDE: companion file encrypted at rest',
    );
  }

  /**
   * Decrypt a companion file during shard open.
   * Checks for TDE magic header before decrypting.
   */
  private decryptCompanionIfNeeded(dbPath: string, ext: string): void {
    const companionPath = ShardManager.getCompanionPath(dbPath, ext);
    if (!fs.existsSync(companionPath)) return;

    const stat = fs.statSync(companionPath);
    if (stat.size < 33) return; // Too small to be TDE-encrypted

    // Check if it's TDE-encrypted (no SQLite header)
    const header = Buffer.alloc(16);
    const fd = fs.openSync(companionPath, 'r');
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);

    const isSqlite = header.toString('utf-8', 0, 15) === 'SQLite format 3';
    if (isSqlite) return; // Plain SQLite companion — no decryption needed

    // TDE-encrypted — decrypt to original path
    const tempPath = ShardManager.getCompanionTempPath(dbPath, ext) + '.decrypting';
    const result = this.tdeEngine!.decryptFile(companionPath, tempPath);
    if (!result.success) {
      logger.warn(
        { companionPath, err: result.error },
        'TDE: companion decryption failed',
      );
      return;
    }

    // Atomic replace
    const dir = path.dirname(companionPath);
    this.atomicReplace(tempPath, companionPath, dir);

    logger.debug(
      { companionPath },
      'TDE: companion file decrypted for access',
    );
  }

  /**
   * Check if a file has a TDE encryption header.
   * TDE files start with a 16-byte IV followed by a 16-byte auth tag.
   * Plaintext SQLite files start with "SQLite format 3\x00".
   */
  private hasTdeHeader(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) return false;
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(16);
      try {
        const bytesRead = fs.readSync(fd, buf, 0, 16, 0);
        if (bytesRead < 16) return false;
        // SQLite header starts with "SQLite format 3\x00"
        // TDE header starts with [16 B IV] — random binary, no fixed pattern.
        // Check that it does NOT start with the SQLite magic bytes.
        const sqliteMagic = Buffer.from('SQLite format 3\x00');
        return !buf.equals(sqliteMagic);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  /**
   * Atomic file replacement with fsync for crash safety.
   */
  private atomicReplace(sourcePath: string, targetPath: string, dir: string): void {
    try {
      // Step 1: fsync the source file
      const srcFd = fs.openSync(sourcePath, 'r');
      try { fs.fsyncSync(srcFd); } finally { fs.closeSync(srcFd); }

      // Step 2: fsync the directory before rename
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }

      // Step 3: Remove target if exists
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }

      // Step 4: Atomic rename
      fs.renameSync(sourcePath, targetPath);

      // Step 5: fsync the directory again
      const dirFd2 = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd2); } finally { fs.closeSync(dirFd2); }
    } catch (err: any) {
      logger.error(
        { sourcePath, targetPath, err: err.message },
        'TDE: atomic file replacement failed',
      );
    }
  }

  /**
   * Get the TDE temp directory (creates on first access).
   */
  private getTdeTempDir(): string {
    if (!this.tdeTempDir) {
      this.tdeTempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'sqlvec-tde-'),
      );
      logger.debug({ tempDir: this.tdeTempDir }, 'TDE: created temp directory for decrypted shards');
    }
    return this.tdeTempDir;
  }

  /**
   * Clean up the TDE temp directory.
   */
  private cleanupTdeTempDir(): void {
    if (this.tdeTempDir && fs.existsSync(this.tdeTempDir)) {
      try {
        const files = fs.readdirSync(this.tdeTempDir);
        for (const f of files) {
          fs.unlinkSync(path.join(this.tdeTempDir, f));
        }
        fs.rmdirSync(this.tdeTempDir);
        logger.debug({ tempDir: this.tdeTempDir }, 'TDE: cleaned up temp directory');
      } catch (err: any) {
        logger.warn({ err: err.message }, 'TDE: failed to clean up temp directory');
      }
      this.tdeTempDir = null;
    }
  }

  /**
   * Get the temp path for a decrypted shard.
   */
  private getTdeDecryptedPath(shardId: number): string {
    return path.join(this.getTdeTempDir(), `shard_${shardId}_decrypted.db`);
  }

  /**
   * Decrypt a shard file if it's TDE-encrypted.
   *
   * Checks if the file has the TDE header marker (starts with valid IV-sized data
   * and key version byte). If so, decrypts to a temp file and returns the temp path.
   * Otherwise, returns the original path unchanged.
   *
   * @param shardId   - The shard ID.
   * @param shardPath - The canonical shard file path.
   * @returns The path to the decrypted database file to open.
   */
  private decryptShardIfNeeded(shardId: number, shardPath: string): string {
    if (!this.tdeEngine) return shardPath;

    // Also decrypt companion files (WAL, SHM) if they exist and are TDE-encrypted
    this.decryptCompanionIfNeeded(shardPath, '-wal');
    this.decryptCompanionIfNeeded(shardPath, '-shm');

    // Only try to decrypt if the file exists and has TDE header size
    if (!fs.existsSync(shardPath)) {
      return shardPath; // File doesn't exist yet — will be created fresh
    }

    const stat = fs.statSync(shardPath);
    if (stat.size < 33) {
      // Files smaller than 33 bytes (16 IV + 16 tag + 1 version) can't be TDE
      // These are either empty or plain SQLite files
      return shardPath;
    }

    // Check if file looks like a TDE-encrypted file (not a standard SQLite header)
    // SQLite header bytes: "SQLite format 3\0"
    const header = Buffer.alloc(16);
    const fd = fs.openSync(shardPath, 'r');
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);

    const isSqlite = header.toString('utf-8', 0, 15) === 'SQLite format 3';
    if (isSqlite) {
      // File looks like plain SQLite — no TDE decryption needed
      return shardPath;
    }

    // File has TDE header — decrypt to temp
    const decryptedPath = this.getTdeDecryptedPath(shardId);
    const result = this.tdeEngine.decryptFile(shardPath, decryptedPath);

    if (!result.success) {
      logger.warn(
        { shardId, shardPath, err: result.error },
        'TDE: shard decryption failed — falling back to raw file',
      );
      return shardPath;
    }

    logger.info(
      { shardId, shardPath, decryptedPath, keyVersion: result.keyVersion },
      'TDE: shard decrypted for access',
    );

    return decryptedPath;
  }

  /**
   * Encrypt a shard file for at-rest protection.
   *
   * Replaces the plain SQLite file with its TDE-encrypted version.
   * The plain file is deleted after successful encryption.
   *
   * @param shardPath - The canonical shard file path.
   */
  private encryptShardFile(shardPath: string): void {
    if (!this.tdeEngine) return;
    if (!fs.existsSync(shardPath)) return;

    const stat = fs.statSync(shardPath);
    if (stat.size === 0) return;

    // Encrypt in-place by encrypting to a temp file and renaming
    const dir = path.dirname(shardPath);
    const base = path.basename(shardPath);
    const tempEncPath = path.join(dir, `.${base}.encrypting.tmp`);

    const result = this.tdeEngine.encryptFile(shardPath, tempEncPath);

    if (!result.success) {
      logger.error(
        { shardPath, err: result.error },
        'TDE: shard encryption failed — file left unencrypted',
      );
      // Clean up temp file
      try { fs.unlinkSync(tempEncPath); } catch { /* best effort */ }
      return;
    }

    // C-06: Atomic file replacement with fsync for crash safety
    this.atomicReplace(tempEncPath, shardPath, dir);

    logger.info(
      { shardPath, keyVersion: result.keyVersion },
      'TDE: shard encrypted at rest (atomic fsync)',
    );

    // Encrypt companion files (-wal, -shm) that may contain residual data
    this.encryptCompanionFile(shardPath, '-wal', result.keyVersion);
    this.encryptCompanionFile(shardPath, '-shm', result.keyVersion);
  }

  /**
   * Rotate the TDE encryption key for all shard files (.db, -wal, -shm).
   *
   * Decrypts all shard files with the old key, then re-encrypts with the
   * new key. Key version is incremented automatically by TDEEngine.
   *
   * @param newKeyBase64 - Base64-encoded 32-byte AES-256 key.
   * @returns A record of rotation results for each shard.
   */
  rotateAllKeys(newKeyBase64: string): Record<number, { success: boolean; error?: string }> {
    if (!this.tdeEngine) {
      logger.warn('TDE key rotation requested but TDE engine is not initialized');
      return {};
    }

    const oldKeyBase64 = TDEConfig.loadFromEnv().key;
    if (!oldKeyBase64) {
      const msg = 'TDE key rotation failed: no old key available (SQLVEC_TDE_KEY not set)';
      logger.error(msg);
      throw new Error(msg);
    }
    const oldKey = Buffer.from(oldKeyBase64, 'base64');

    // Validate new key
    if (!TDEConfig.validateKey(newKeyBase64)) {
      const msg = 'TDE key rotation failed: invalid new key (must be base64-encoded 32 bytes)';
      logger.error({ newKeyBase64: newKeyBase64.substring(0, 10) + '...' }, msg);
      throw new Error(msg);
    }

    const newKey = Buffer.from(newKeyBase64, 'base64');
    const results: Record<number, { success: boolean; error?: string }> = {};

    for (const [shardId, shard] of this.shards) {
      const errors: string[] = [];
      const filesToRotate = [shard.path];

      // Flush the WAL into the main DB file before rotating. The shard file is
      // about to be rewritten on disk; without a checkpoint any uncommitted
      // frames still sitting in the -wal file would be silently dropped.
      try {
        if (shard.db?.open) shard.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Non-fatal — rotation proceeds and reports any file-level failure.
      }

      for (const filePath of filesToRotate) {
        // Companion files (-wal, -shm) are encrypted on close/checkpoint,
        // not during online key rotation. Only the main .db is rotated.
        if (filePath !== shard.path) continue;
        try {
          if (!fs.existsSync(filePath)) continue;
          const stat = fs.statSync(filePath);
          if (stat.size === 0) continue;

          // Check if file has a TDE header. If not, encrypt directly with new key.
          if (!this.hasTdeHeader(filePath)) {
            // Plaintext file — encrypt it directly with the new key
            const dir = path.dirname(filePath);
            const base = path.basename(filePath);
            const tempEncPath = path.join(dir, `.${base}.encrypting.tmp`);
            const encResult = this.tdeEngine.encryptFile(filePath, tempEncPath, newKey);
            if (!encResult.success) {
              errors.push(`direct encrypt failed for ${path.basename(filePath)}: ${encResult.error}`);
              try { fs.unlinkSync(tempEncPath); } catch { /* */ }
            } else {
              this.atomicReplace(tempEncPath, filePath, dir);
              logger.info(
                { shardId, filePath: path.basename(filePath), keyVersion: encResult.keyVersion },
                'TDE key rotation: plaintext file encrypted with new key',
              );
            }
          } else {
            // Already encrypted — rotate (decrypt with old, re-encrypt with new)
            const ok = this.tdeEngine.rotateKey(filePath, oldKey, newKey);
            if (!ok) {
              errors.push(`rotateKey returned false for ${path.basename(filePath)}`);
            } else {
              logger.info(
                { shardId, filePath: path.basename(filePath) },
                'TDE key rotation: file re-encrypted with new key',
              );
            }
          }
        } catch (err: any) {
          errors.push(`${path.basename(filePath)}: ${err.message}`);
          logger.error(
            { shardId, filePath: path.basename(filePath), err: err.message },
            'TDE key rotation: file rotation failed',
          );
        }
      }

      results[shardId] = {
        success: errors.length === 0,
        error: errors.length > 0 ? errors.join('; ') : undefined,
      };
    }

    // Update the environment for subsequent operations
    process.env.SQLVEC_TDE_KEY = newKeyBase64;

    logger.info(
      { successCount: Object.values(results).filter(r => r.success).length, totalCount: Object.keys(results).length },
      'TDE key rotation completed',
    );

    return results;
  }

  /**
   * Check whether TDE is currently active in this ShardManager.
   */
  isTdeEnabled(): boolean {
    return this.tdeEnabled;
  }

  /**
   * Get the TDEEngine instance, if TDE is enabled.
   */
  getTdeEngine(): TDEEngine | null {
    return this.tdeEngine;
  }
}
