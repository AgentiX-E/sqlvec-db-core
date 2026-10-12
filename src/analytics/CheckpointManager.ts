import { PinoLogger } from '../logger/PinoLogger';
import { DuckDBAnalyticsManager } from './DuckDBAnalyticsManager';
import { OLAPSchemaManager } from './OLAPSchemaManager';
import { ShardManager, ShardHandle } from '../storage/ShardManager';

const logger = PinoLogger.forComponent('CheckpointManager');

/**
 * Persistent checkpoint state for a single table.
 */
interface TableCheckpoint {
  byTable: Map<string, number>;
  counters: Map<string, { inserted: number; updated: number; deleted: number }>;
}

/**
 * CheckpointManager owns all checkpoint-related state for the data bridge:
 * - in-memory rowid checkpoints (per table)
 * - per-shard change counters
 * - DuckDB persistence layer for crash recovery
 *
 * Exposes raw checkpoint references so DataBridge can update counters in-place.
 */
export class CheckpointManager {
  static readonly CP_TABLE = '_sqlvec_checkpoints';
  /** SQLite-side checkpoint redundancy table — created per shard */
  static readonly SQLITE_CP_TABLE = '_sqlvec_checkpoints';

  private checkpoint: TableCheckpoint = {
    byTable: new Map(),
    counters: new Map(),
  };
  private checkpointTableReady = false;
  private checkpointWriteFailures = 0;

  constructor(
    private readonly duckDB: DuckDBAnalyticsManager,
    private readonly schemaManager: OLAPSchemaManager,
  ) {}

  // ──────────────────────────────────────────────
  //  Table lifecycle
  // ──────────────────────────────────────────────

  /**
   * Create the checkpoint metadata table in DuckDB if it does not exist.
   * Safe to call multiple times.
   */
  async ensureCheckpointTable(): Promise<void> {
    if (!this.duckDB.isAvailable) return;
    if (this.checkpointTableReady) return;

    try {
      await this.duckDB.execRaw(
        `CREATE TABLE IF NOT EXISTS main.${CheckpointManager.CP_TABLE} (
          table_key TEXT PRIMARY KEY,
          max_rowid INTEGER,
          row_count INTEGER,
          status TEXT DEFAULT 'active',
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
      );
      this.checkpointTableReady = true;
      logger.debug('[CheckpointManager] Checkpoint table ready');
    } catch (err: any) {
      logger.warn({ err: err.message }, '[CheckpointManager] Cannot create checkpoint table');
      this.checkpointTableReady = false;
    }
  }

  /**
   * Load persisted checkpoints from DuckDB into memory.
   * Tables without persisted entries start at checkpoint 0 (full sync).
   */
  async drawCheckpoints(): Promise<void> {
    if (!this.duckDB.isAvailable || !this.checkpointTableReady) {
      // P0: Fallback — DuckDB checkpoint table unavailable, try SQLite shards
      return;
    }

    try {
      const res = await this.duckDB.execute(
        `SELECT table_key, max_rowid FROM main.${CheckpointManager.CP_TABLE}`,
      );

      let loaded = 0;
      for (const row of res.rows) {
        const key = row.table_key as string;
        const maxRowId = Number(row.max_rowid);
        if (maxRowId > 0) {
          this.checkpoint.byTable.set(key, maxRowId);
          loaded++;
        }
      }

      if (loaded > 0) {
        logger.info({ tablesLoaded: loaded }, '[CheckpointManager] Loaded persisted checkpoints');
      }
    } catch (err: any) {
      if (err.message && err.message.includes('no such table')) {
        logger.debug('[CheckpointManager] No checkpoint table yet — full sync on next tick');
      } else {
        logger.warn(
          { err: err.message },
          '[CheckpointManager] Failed to load checkpoints from DuckDB',
        );
        // P0: DuckDB unavailable — checkpoints will be loaded from SQLite via drawCheckpointsFromShards()
        this.checkpointWriteFailures++;
      }
    }
  }

  /**
   * Persist a checkpoint entry to DuckDB (upsert).
   * Falls back gracefully to memory-only mode on persistent failure.
   */
  async saveCheckpoint(tableKey: string, maxRowId: number, rowCount: number): Promise<void> {
    if (!this.duckDB.isAvailable || !this.checkpointTableReady) return;
    if (this.checkpointWriteFailures > 5) return;

    try {
      const safeKey = tableKey.replace(/'/g, "''");
      // Use DELETE + INSERT instead of INSERT OR REPLACE to avoid DuckDB
      // sqlite_scanner MERGE/ON CONFLICT limitations (the scanner extension
      // does not support upsert patterns on tables resolved via scanner schema).
      await this.duckDB.execRaw(
        `DELETE FROM main.${CheckpointManager.CP_TABLE} WHERE table_key = '${safeKey}'`,
      );
      await this.duckDB.execRaw(
        `INSERT INTO main.${CheckpointManager.CP_TABLE} (table_key, max_rowid, row_count, status)
         VALUES ('${safeKey}', ${maxRowId}, ${rowCount}, 'active')`,
      );
      this.checkpointWriteFailures = 0;
    } catch (err: any) {
      this.checkpointWriteFailures++;
      logger.warn(
        { err: err.message, tableKey, failures: this.checkpointWriteFailures },
        '[CheckpointManager] Checkpoint write failed',
      );
      // The >5 guard above aborts before any further write is attempted, so
      // `checkpointWriteFailures` saturates at 6. Emit the disabling notice at
      // the moment the circuit breaker trips (was previously guarded by an
      // unreachable `>= 10` that could never fire).
      if (this.checkpointWriteFailures === 6) {
        logger.warn('[CheckpointManager] Too many failures — disabling checkpoint persistence');
      }
    }
  }

  /**
   * Get the highest checkpoint rowid stored in DuckDB for a specific shard.
   */
  async getDuckMaxCheckpoint(shardId: number): Promise<number> {
    if (!this.duckDB.isAvailable || !this.checkpointTableReady) return 0;

    try {
      const res = await this.duckDB.execute(
        `SELECT COALESCE(MAX(max_rowid), 0) AS max_id
         FROM main.${CheckpointManager.CP_TABLE}
         WHERE table_key LIKE '${shardId}:%'`,
      );
      return Number(res.rows[0]?.max_id ?? 0);
    } catch (err: any) {
      logger.warn(
        { shardId, err: err.message },
        '[CheckpointManager] getDuckMaxCheckpoint failed',
      );
      return 0;
    }
  }

  // ──────────────────────────────────────────────
  //  In-memory checkpoint accessors
  // ──────────────────────────────────────────────

  /**
   * Build a composite checkpoint key from shard and table name.
   * Exposed so callers can format their own keys.
   */
  checkpointKey(shardId: number, tableName: string): string {
    return `${shardId}:${tableName}`;
  }

  /**
   * Get the persisted rowid checkpoint for a table (memory, not DuckDB).
   * Returns 0 when no checkpoint exists (triggers full sync).
   */
  getCheckpoint(shardId: number, tableName: string): number {
    return this.checkpoint.byTable.get(this.checkpointKey(shardId, tableName)) ?? 0;
  }

  /**
   * Set the persisted rowid checkpoint for a table (memory only).
   * Call saveCheckpoint() separately to persist to DuckDB.
   */
  setCheckpoint(shardId: number, tableName: string, value: number): void {
    this.checkpoint.byTable.set(this.checkpointKey(shardId, tableName), value);
  }

  /**
   * Get per-shard change counters accumulated during the current bridge session.
   */
  shardCounters(shardId: number): { inserted: number; updated: number; deleted: number } {
    return (
      this.checkpoint.counters.get(`shard_${shardId}`) ?? {
        inserted: 0,
        updated: 0,
        deleted: 0,
      }
    );
  }

  /**
   * Return a reference to the internal checkpoint so DataBridge can update
   * counters and checkpoint values in-place without going through accessors.
   *
   * ⚠️ Mutable reference — only DataBridge internals should use this.
   */
  ensureCheckpoint(): {
    byTable: Map<string, number>;
    counters: Map<string, { inserted: number; updated: number; deleted: number }>;
  } {
    return this.checkpoint;
  }

  /** Number of checkpoint write failures (for metrics). */
  getWriteFailures(): number {
    return this.checkpointWriteFailures;
  }

  // ──────────────────────────────────────────────
  //  P0: SQLite Shard Checkpoint Redundancy
  // ──────────────────────────────────────────────

  /**
   * Create the `_sqlvec_checkpoints` table in a single shard if it does not exist.
   * Safe to call multiple times.
   */
  ensureCheckpointTableInShard(shard: ShardHandle): void {
    try {
      shard.db.exec(
        `CREATE TABLE IF NOT EXISTS ${CheckpointManager.SQLITE_CP_TABLE} (
          table_key   TEXT PRIMARY KEY,
          max_rowid   INTEGER NOT NULL,
          row_count   INTEGER DEFAULT 0,
          status      TEXT DEFAULT 'active',
          updated_at  INTEGER NOT NULL
        )`,
      );
    } catch (err: any) {
      logger.warn(
        { shardId: shard.shardId, err: err.message },
        '[CheckpointManager] Cannot create SQLite checkpoint table in shard',
      );
    }
  }

  /**
   * Create `_sqlvec_checkpoints` tables in all registered shards.
   */
  ensureCheckpointTableInAllShards(shardManager: ShardManager): void {
    const shardIds = shardManager.getShardIds();
    for (const sid of shardIds) {
      const shard = shardManager.getShard(sid);
      if (shard) {
        this.ensureCheckpointTableInShard(shard);
      }
    }
  }

  /**
   * Persist a checkpoint entry to the SQLite shard (UPSERT).
   * Provides crash recovery fallback when DuckDB checkpoint table is unavailable.
   */
  saveCheckpointToShard(shard: ShardHandle, tableKey: string, maxRowId: number, rowCount: number): void {
    try {
      const safeKey = tableKey.replace(/'/g, "''");
      shard.db.prepare(
        `INSERT INTO ${CheckpointManager.SQLITE_CP_TABLE} (table_key, max_rowid, row_count, status, updated_at)
         VALUES (?, ?, ?, 'active', ?)
         ON CONFLICT(table_key) DO UPDATE SET
           max_rowid = excluded.max_rowid,
           row_count = excluded.row_count,
           updated_at = excluded.updated_at`
      ).run(safeKey, maxRowId, rowCount, Date.now());
    } catch (err: any) {
      logger.warn(
        { shardId: shard.shardId, tableKey, err: err.message },
        '[CheckpointManager] SQLite checkpoint write failed (non-fatal)',
      );
    }
  }

  /**
   * Load checkpoints from all shards' SQLite `_sqlvec_checkpoints` tables.
   * Used as fallback when DuckDB checkpoint table is unavailable (e.g., after crash).
   *
   * @returns Map of table_key → max_rowid loaded from shards
   */
  drawCheckpointsFromShards(shardManager: ShardManager): Map<string, number> {
    const loaded = new Map<string, number>();
    const shardIds = shardManager.getShardIds();
    for (const sid of shardIds) {
      const shard = shardManager.getShard(sid);
      if (!shard) continue;
      try {
        const rows = shard.db.prepare(
          `SELECT table_key, max_rowid FROM ${CheckpointManager.SQLITE_CP_TABLE} WHERE status = 'active'`
        ).all() as { table_key: string; max_rowid: number }[];
        for (const row of rows) {
          if (row.max_rowid > 0) {
            loaded.set(row.table_key, row.max_rowid);
          }
        }
      } catch (err: any) {
        // Table may not exist yet — non-fatal
        logger.debug(
          { shardId: sid, err: err.message },
          '[CheckpointManager] drawCheckpointsFromShards skipped',
        );
      }
    }
    if (loaded.size > 0) {
      logger.info(
        { tablesLoaded: loaded.size, source: 'sqlite_shards' },
        '[CheckpointManager] Loaded checkpoints from SQLite shard redundancy',
      );
    }
    return loaded;
  }
}
