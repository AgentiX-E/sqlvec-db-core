/**
 * DataBridge — CDC 增量同步引擎 (slim v4)
 *
 * Orchestrates CDC sync between SQLite shards and DuckDB columnar tables.
 * CDC operations are delegated to CDCEngine, checkpoint persistence to CheckpointManager.
 *
 * ## v4 Improvements
 * - **Extracted**: CDCEngine (CDC triggers, changelog), CheckpointManager (checkpoint DB)
 * - **Same interface**: all exports unchanged
 */

import { PinoLogger } from '../logger/PinoLogger';
import { DuckDBAnalyticsManager } from './DuckDBAnalyticsManager';
import { OLAPSchemaManager } from './OLAPSchemaManager';
import { ShardManager, ShardHandle } from '../storage/ShardManager';
import { CDCEngine } from './CDCEngine';
import { CheckpointManager } from './CheckpointManager';
import * as crypto from 'crypto';

const logger = PinoLogger.forComponent('DataBridge');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface SyncResult {
  shardsProcessed: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
  durationMs: number;
  /** Estimated lag between SQLite and DuckDB in milliseconds (0 when caught up) */
  synchronizationLagMs: number;
}

export interface TableChanges {
  tableName: string;
  inserts: any[];
  updates: { rowid: number; row: any }[];
  deletes: number[];
  /** Primary key column name (for deletes from CDC — rowid = PK value) */
  pkCol?: string;
}

// ──────────────────────────────────────────────
//  Configuration
// ──────────────────────────────────────────────

export interface DataBridgeConfig {
  enabled: boolean;
  mode: 'incremental' | 'batch' | 'off';
  tickIntervalMs: number;
  batchSize: number;
  fullSyncOnStart: boolean;
  fullSyncIfStaleMs: number;
  localColumnar: { enabled: boolean };
}

export const DEFAULT_DATA_BRIDGE_CONFIG: DataBridgeConfig = {
  enabled: true,
  mode: 'incremental',
  tickIntervalMs: 100,
  batchSize: 500,
  fullSyncOnStart: true,
  fullSyncIfStaleMs: 3_600_000,
  localColumnar: { enabled: true },
};

// ──────────────────────────────────────────────
//  DataBridge
// ──────────────────────────────────────────────

export type DataBridgeState = 'created' | 'awaiting_deps' | 'syncing' | 'caught_up' | 'stopped';

export interface DataBridgeStatus {
  state: DataBridgeState;
  lastTickAt: number | null;
  pendingRows: number;
  synchronizationLagMs: number;
}

export interface DataBridgeMetrics {
  totalTicks: number;
  totalErrors: number;
  checkpointWriteFailures: number;
  schemaChangesDetected: number;
  tablesSynced: number;
  totalRowsInserted: number;
}

export class DataBridge {
  private running = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private deferredFullSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncCount = 0;

  /** Pending OLAP table registrations (retried on each tick until success) */
  private readonly pendingRegistrations: Array<{ shardId: number; tableName: string; shardPath: string; retries: number }> = [];

  /** Delegated CDC engine */
  private readonly cdcEngine: CDCEngine;
  /** Delegated checkpoint manager */
  private readonly checkpointManager: CheckpointManager;

  // ── Phase 3: state machine ──
  private _status: DataBridgeStatus = {
    state: 'created',
    lastTickAt: null,
    pendingRows: 0,
    synchronizationLagMs: 0,
  };
  private _metrics: DataBridgeMetrics = {
    totalTicks: 0,
    totalErrors: 0,
    checkpointWriteFailures: 0,
    schemaChangesDetected: 0,
    tablesSynced: 0,
    totalRowsInserted: 0,
  };
  private lastTransitionAt = Date.now();

  // P2: tick counter for periodic checksum verification
  private tickCounter = 0;

  constructor(
    private readonly duckDB: DuckDBAnalyticsManager,
    private readonly schemaManager: OLAPSchemaManager,
    private readonly shardManager: ShardManager,
    private readonly config: DataBridgeConfig = DEFAULT_DATA_BRIDGE_CONFIG,
  ) {
    this.cdcEngine = new CDCEngine(shardManager, schemaManager, config);
    this.checkpointManager = new CheckpointManager(duckDB, schemaManager);
  }

  // ── Lifecycle ──

  /**
   * Schedule a table for OLAP registration retry on the next tick.
   * Used when onTableCreated fires before Raft applies the DDL to SQLite,
   * causing sqlite_scanner to not find the table yet.
   */
  scheduleRetryOLAPRegistration(shardId: number, tableName: string, shardPath: string): void {
    // Avoid duplicates — if already pending, don't add again
    const exists = this.pendingRegistrations.some(
      r => r.shardId === shardId && r.tableName === tableName
    );
    if (!exists) {
      this.pendingRegistrations.push({ shardId, tableName, shardPath, retries: 0 });
      logger.debug({ shardId, tableName }, '[DataBridge] Scheduled OLAP registration retry');
    }
  }

  /**
   * Start the background sync loop.
   * On first start, performs full synchronization if configured.
   * Checkpoints are drawn from DuckDB persistence layer (if available).
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.transition('awaiting_deps');

    // Phase 3: wait for dependencies with 10s timeout
    await this.waitForDuckDB(10_000);
    await this.waitForSchemaManager(10_000);

    // Initialize checkpoint metadata table
    await this.checkpointManager.ensureCheckpointTable();

    // P0: Create SQLite checkpoint redundancy tables in all shards
    this.checkpointManager.ensureCheckpointTableInAllShards(this.shardManager);

    // Draw persisted checkpoints to avoid full resync on restart
    await this.checkpointManager.drawCheckpoints();

    // P0: If DuckDB checkpoints were empty, try loading from SQLite shard redundancy
    const cpCount = this.checkpointManager.ensureCheckpoint().byTable.size;
    if (cpCount === 0) {
      const shardCp = this.checkpointManager.drawCheckpointsFromShards(this.shardManager);
      if (shardCp.size > 0) {
        const memCp = this.checkpointManager.ensureCheckpoint();
        for (const [key, val] of shardCp) {
          memCp.byTable.set(key, val);
        }
        logger.info(
          { fallbackLoaded: shardCp.size },
          '[DataBridge] Restored checkpoints from SQLite shard redundancy',
        );
      }
    }

    // Start tick loop
    this.tickTimer = setInterval(() => {
      this.tick().catch(err => {
        logger.error({ err: err.message }, '[DataBridge] Tick error');
      });
    }, this.config.tickIntervalMs);

    // Deferred full sync: wait 500ms for dependencies (DuckDB, SchemaManager)
    if (this.config.fullSyncOnStart) {
      this.deferredFullSyncTimer = setTimeout(async () => {
        try {
          logger.info('[DataBridge] Performing deferred full sync...');
          await this.fullSyncAll();
          this.transition('syncing');
          logger.info('[DataBridge] Deferred full sync complete');
        } catch (err: any) {
          logger.error({ err: err.message }, '[DataBridge] Deferred full sync failed');
        }
      }, 500).unref();
    } else {
      this.transition('syncing');
    }

    logger.info({
      tickIntervalMs: this.config.tickIntervalMs,
      mode: this.config.mode,
    }, '[DataBridge] Started');
  }

  /**
   * Stop the background sync loop.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.transition('stopped');
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.deferredFullSyncTimer) {
      clearTimeout(this.deferredFullSyncTimer);
      this.deferredFullSyncTimer = null;
    }
    logger.info('[DataBridge] Stopped');
  }

  // ── Phase 3: Status & Metrics ──

  /** Get current bridge state. */
  getStatus(): DataBridgeStatus {
    return { ...this._status };
  }

  /** Get cumulative bridge metrics. */
  getMetrics(): DataBridgeMetrics {
    return {
      ...this._metrics,
      checkpointWriteFailures: this.checkpointManager.getWriteFailures(),
    };
  }

  // ── Delegated Accessors (for tests) ──

  /** Access inner checkpoint map for test compatibility. */
  getCheckpointMap(): Map<string, number> {
    return this.checkpointManager.ensureCheckpoint().byTable;
  }

  /** Get CDC engine instance (for tests). */
  getCDCEngine(): CDCEngine {
    return this.cdcEngine;
  }

  /** Get checkpoint manager instance (for tests). */
  getCheckpointManager(): CheckpointManager {
    return this.checkpointManager;
  }

  // ── Dependency Guards ──

  /**
   * Wait until DuckDB is available, with timeout.
   * Polls `duckDB.isAvailable` every 100ms.
   */
  private async waitForDuckDB(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.duckDB.isAvailable) return;
      await new Promise(r => setTimeout(r, 100));
    }
    logger.warn('[DataBridge] DuckDB not available within timeout — continuing anyway');
  }

  /**
   * Wait until SchemaManager has at least one monitored table, with timeout.
   * Polls `getMonitoredTables` every 100ms.
   * Non-blocking: continues after timeout even if no tables registered.
   */
  private async waitForSchemaManager(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const shardIds = this.shardManager.getShardIds();
      for (const sid of shardIds) {
        if (this.schemaManager.getMonitoredTables(sid).length > 0) return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    logger.debug('[DataBridge] No tables registered within timeout — tick loop will start when tables appear');
  }

  // ── State Machine ──

  private transition(newState: DataBridgeState): void {
    const prev = this._status.state;
    this._status.state = newState;
    this.lastTransitionAt = Date.now();
    logger.debug({ from: prev, to: newState }, '[DataBridge] State transition');
  }

  // ── Tick ──

  /**
   * Single sync tick: read incremental changes from all shards and apply to DuckDB.
   * After writing each table, persists the checkpoint to DuckDB.
   */
  async tick(): Promise<SyncResult> {
    if (!this.duckDB.isAvailable) {
      return { shardsProcessed: 0, rowsInserted: 0, rowsUpdated: 0, rowsDeleted: 0, durationMs: 0, synchronizationLagMs: 0 };
    }

    const start = Date.now();
    let totalInserted = 0;
    let totalUpdated = 0;
    let totalDeleted = 0;
    let shardsProcessed = 0;
    let maxLagMs = 0;

    const shardIds = this.shardManager.getShardIds();
    for (const shardId of shardIds) {
      const shard = this.shardManager.getShard(shardId);
      if (!shard) continue;

      // Log if db is not open
      if (!shard.db.open) {
      }

      // Ensure CDC infrastructure on first access to this shard
      this.cdcEngine.ensureCDCTables(shard);

      // Retry pending OLAP registrations (created before Raft applied the DDL)
      for (let i = this.pendingRegistrations.length - 1; i >= 0; i--) {
        const reg = this.pendingRegistrations[i];
        if (reg.shardId !== shardId) continue;
        if (reg.retries >= 10) {
          // Remove after 10 retries (~1s of ticks) — give up
          logger.warn({ shardId, tableName: reg.tableName },
            '[DataBridge] Giving up on OLAP registration after 10 retries');
          this.pendingRegistrations.splice(i, 1);
          continue;
        }
        try {
          // Use fullSyncTable (DROP + re-COPY) instead of ensureOLAPTable to ensure
          // the DuckDB table reflects all rows written since table creation, not just
          // the (potentially empty) snapshot captured by the initial onTableCreated callback.
          const rowCount = await this.schemaManager.fullSyncTable(reg.shardId, reg.tableName, reg.shardPath, shard);
          if (rowCount >= 0) {
            const def = this.schemaManager.getOLAPTable(reg.shardId, reg.tableName);
            if (!def) {
              // fullSyncTable succeeded but table still not registered — edge case, retry
              reg.retries++;
              continue;
            }
            logger.info({ shardId, tableName: reg.tableName, duckTable: def.duckDBTableName },
              '[DataBridge] Deferred OLAP registration succeeded');
            // Initialize checkpoint
            const maxRowId = this.cdcEngine.getMaxRowId(shard, reg.tableName);
            if (rowCount > 0 && maxRowId > 0) {
              const cpKey = this.checkpointManager.checkpointKey(reg.shardId, reg.tableName);
              this.checkpointManager.setCheckpoint(reg.shardId, reg.tableName, maxRowId);
              await this.checkpointManager.saveCheckpoint(cpKey, maxRowId, rowCount);
              // P0: Redundant SQLite checkpoint write
              this.checkpointManager.saveCheckpointToShard(shard, cpKey, maxRowId, rowCount);
            }
            this.pendingRegistrations.splice(i, 1); // Remove on success
          }
        } catch (pendingErr: any) {
          reg.retries++;
          logger.info({ shardId, tableName: reg.tableName, retry: reg.retries, err: pendingErr.message },
            '[DataBridge] OLAP registration retry failed, will retry next tick');
        }
      }

      try {
        // Phase 2: schema change detection — per-table, per-tick
        const monitoredTables = this.schemaManager.getMonitoredTables(shardId);
        for (const tbl of monitoredTables) {
          if (this.cdcEngine.detectSchemaChange(shard, tbl)) {
            logger.info({ shardId, table: tbl },
              '[DataBridge] Full resync triggered for schema change');
            this._metrics.schemaChangesDetected++;
            void this.markFullResyncNeeded(shardId, tbl).catch(
              (err: any) => logger.warn({ err: err.message, shardId, table: tbl },
                '[DataBridge] markFullResyncNeeded failed'));
            const rowCount = await this.schemaManager.fullSyncTable(shardId, tbl, shard.path, shard);
            if (rowCount > 0) {
              const maxRowId = this.cdcEngine.getMaxRowId(shard, tbl);
              this.checkpointManager.setCheckpoint(shardId, tbl, maxRowId);
              const cpKey = this.checkpointManager.checkpointKey(shardId, tbl);
              await this.checkpointManager.saveCheckpoint(
                cpKey,
                maxRowId,
                rowCount,
              );
              // P0: Redundant SQLite checkpoint write
              this.checkpointManager.saveCheckpointToShard(shard, cpKey, maxRowId, rowCount);
            }
          }
        }

        // Use trigger-based CDC (preferred) when changelog exists.
        // This captures INSERT/UPDATE/DELETE events reliably.
        // If CDC found no pending events, fall through to rowid gap detection
        // for any pre-existing rows that were inserted before triggers were installed.
        const cdcResult = this.cdcEngine.hasCDCTable(shard) ? this.cdcEngine.readChangelog(shard) : null;
        let changes = cdcResult?.changes ?? [];
        let shardWasProcessed = true;

        if (changes.length > 0) {
          // CDC mode: advance rowid checkpoint to prevent duplicates if
          // the next tick falls through to rowid mode.
          for (const tc of changes) {
            const maxRowId = this.cdcEngine.getMaxRowId(shard, tc.tableName);
            const currentCp = this.checkpointManager.getCheckpoint(shard.shardId, tc.tableName);
            if (maxRowId > currentCp) {
              this.checkpointManager.setCheckpoint(shard.shardId, tc.tableName, maxRowId);
            }
          }
        } else {
          // No CDC events — use rowid gap for un-synced pre-trigger rows
          changes = await this.cdcEngine.readChangesFromShard(shard, this.checkpointManager.ensureCheckpoint().byTable);
          shardWasProcessed = true;
        }

        if (shardWasProcessed) shardsProcessed++;

        // Debug: log CDC changes before applying
        if (changes.length > 0) {
          const summary = changes.map(tc =>
            `${tc.tableName}(I:${tc.inserts.length},U:${tc.updates.length},D:${tc.deletes.length})`
          ).join(', ');
          logger.info({ shardId, changes: summary, cdcSeq: cdcResult?.maxSeq ?? 0 },
            '[DataBridge] CDC apply batch');
        }

        // Apply to DuckDB
        for (const tc of changes) {
          const def = this.schemaManager.getOLAPTable(shardId, tc.tableName);
          if (!def) continue; // Not yet monitored—skip

          // Apply inserts
          if (tc.inserts.length > 0) {
            await this.duckDB.appendToOLAPTable(def.duckDBTableName, tc.inserts);
            totalInserted += tc.inserts.length;
          }

          // Apply updates (per-row — Phase P1 uses batch upsert)
          // Uses PK-based update with inline values. DuckDB execRaw doesn't support
          // prepared statement parameters, so we stringify values inline with proper quoting.
          for (const u of tc.updates) {
            const pkCol = this.cdcEngine.getPKCol(shard, tc.tableName);
            const inlineVal = (v: any) =>
              typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(Number(v));
            if (pkCol && u.row[pkCol] != null) {
              const setClauses = Object.keys(u.row)
                .filter(k => k !== pkCol && k !== 'rowid')
                .map(k => `"${k.replace(/"/g, '""')}" = ${inlineVal(u.row[k])}`);
              await this.duckDB.updateOLAPTableByPK(def.duckDBTableName, setClauses, [pkCol], [[Number(u.row[pkCol])]]);
            } else {
              const setClauses = Object.keys(u.row)
                .filter(k => k !== 'rowid')
                .map(k => `"${k.replace(/"/g, '""')}" = ${inlineVal(u.row[k])}`);
              await this.duckDB.updateOLAPTable(def.duckDBTableName, setClauses, [u.rowid]);
            }
            totalUpdated++;
          }

          // Apply deletes — PK-based when pkCol known, rowid-based fallback
          if (tc.deletes.length > 0) {
            const pkCol = this.cdcEngine.getPKCol(shard, tc.tableName);
            if (pkCol) {
              const pkVals = tc.deletes.map(d => [d]);
              await this.duckDB.deleteFromOLAPTableByPK(def.duckDBTableName, [pkCol], pkVals);
            } else {
              await this.duckDB.deleteFromOLAPTable(def.duckDBTableName, tc.deletes);
            }
            totalDeleted += tc.deletes.length;
          }

          // Persist checkpoint to DuckDB after data is written
          const cpKey = this.checkpointManager.checkpointKey(shardId, tc.tableName);
          const currentCp = this.checkpointManager.getCheckpoint(shardId, tc.tableName);
          if (currentCp > 0) {
            await this.checkpointManager.saveCheckpoint(cpKey, currentCp, tc.inserts.length);
            // P0: Redundant checkpoint write to SQLite shard for crash recovery
            this.checkpointManager.saveCheckpointToShard(shard, cpKey, currentCp, tc.inserts.length);
          }
        }

        // CDC GC: delete processed changelog entries only after successful apply.
        // This ensures failed apply does not lose changelog events.
        if (cdcResult && cdcResult.maxSeq > 0) {
          try {
            const result = shard.db.prepare(`DELETE FROM ${CDCEngine.CDC_TABLE} WHERE seq <= ?`).run(cdcResult.maxSeq);
            // Periodic GC log for observability
            if (result.changes > 0 && (cdcResult.maxSeq % 500 < this.config.batchSize || cdcResult.maxSeq > 5000)) {
              logger.debug({ shardId, maxSeq: cdcResult.maxSeq, deleted: result.changes },
                '[DataBridge] CDC GC completed');
            }
  /* v8 ignore next -- catch is non-fatal defensive fallback */          } catch (gcErr: any) {
            logger.warn({ shardId, err: gcErr.message }, '[DataBridge] CDC GC failed (non-fatal)');
          }
        }

        // Calculate synchronization lag for this shard
        if (this.duckDB.isAvailable) {
          try {
            const firstTable = this.schemaManager.getMonitoredTables(shard.shardId)[0] || '';
            const sqliteMaxRow = this.cdcEngine.getMaxRowId(shard, firstTable);
            const duckMaxRow = await this.checkpointManager.getDuckMaxCheckpoint(shardId);
            if (sqliteMaxRow > duckMaxRow && shardsProcessed > 0) {
              const lag = Math.round((sqliteMaxRow - duckMaxRow) * 0.1); // rough est: 0.1ms per row
              if (lag > maxLagMs) maxLagMs = lag;
            }
  /* v8 ignore next -- catch is non-fatal defensive fallback */          } catch (err: any) {
            logger.debug({ err: err.message }, '[DataBridge] Lag estimate failed (non-fatal)');
          }
        }

        // Update per-shard counters
        const counters = this.checkpointManager.shardCounters(shardId);
        counters.inserted += totalInserted;
        counters.updated += totalUpdated;
        counters.deleted += totalDeleted;

  /* v8 ignore next -- catch is non-fatal defensive fallback */      } catch (err: any) {
        logger.warn({ shardId, err: err.message }, '[DataBridge] Shard sync error (continuing)');
        this._metrics.totalErrors++;
        // Individual shard failure does not stop the tick
      }
    }

    const durationMs = Date.now() - start;

    // Phase 3: update metrics + status
    this._status.lastTickAt = Date.now();
    this._status.synchronizationLagMs = maxLagMs;
    this._metrics.totalTicks++;
    this._metrics.totalRowsInserted += totalInserted;

    // Determine pending rows across all shards
    let totalPending = 0;
    for (const shardId of shardIds) {
      const shard = this.shardManager.getShard(shardId);
      if (!shard) continue;
      for (const tbl of this.schemaManager.getMonitoredTables(shardId)) {
        const cp = this.checkpointManager.getCheckpoint(shardId, tbl);
        const maxRow = this.cdcEngine.getMaxRowId(shard, tbl);
        totalPending += Math.max(0, maxRow - cp);
      }
    }
    this._status.pendingRows = totalPending;

    // State transition: caught_up when no pending rows
    if (totalPending === 0 && shardsProcessed > 0 && this._status.state === 'syncing') {
      this.transition('caught_up');
    }

    // P2: Periodic checksum verification — every 600 ticks (~60s at 100ms tick)
    this.tickCounter++;
    if (this.tickCounter % 600 === 0) {
      this.runChecksumCheck().catch((err: any) =>
        logger.warn({ err: err.message }, '[DataBridge] Periodic checksum check failed')
      );
    }

    // Log periodically
    this.syncCount++;
    if (this.syncCount % 100 === 0 || totalInserted > 0) {
      logger.debug({
        shardsProcessed,
        rowsInserted: totalInserted,
        rowsUpdated: totalUpdated,
        rowsDeleted: totalDeleted,
        durationMs,
        synchronizationLagMs: maxLagMs,
      }, '[DataBridge] Tick complete');
    }

    return {
      shardsProcessed,
      rowsInserted: totalInserted,
      rowsUpdated: totalUpdated,
      rowsDeleted: totalDeleted,
      durationMs,
      synchronizationLagMs: maxLagMs,
    };
  }

  /**
   * Manually trigger a sync batch (for testing or forced sync).
   */
  async syncBatch(): Promise<SyncResult> {
    return this.tick();
  }

  // ── Full Sync ──

  /**
   * Full synchronization: register all tables from all shards.
   */
  async fullSyncAll(): Promise<void> {
    if (!this.duckDB.isAvailable) return;

    const shardIds = this.shardManager.getShardIds();
    for (const shardId of shardIds) {
      const shard = this.shardManager.getShard(shardId);
      if (!shard) continue;

      try {
        await this.fullSyncShard(shard);
  /* v8 ignore next -- catch is non-fatal defensive fallback */      } catch (err: any) {
        logger.warn({ shardId, err: err.message }, '[DataBridge] Full sync shard error');
      }
    }
  }

  /**
   * Full sync a single shard: discover all user tables and create columnar copies.
   * After full sync, persists checkpoint to DuckDB.
   */
  private async fullSyncShard(shard: ShardHandle): Promise<void> {
    const tableNames = this.cdcEngine.listShardTables(shard);

    for (const tableName of tableNames) {
      // Skip internal SqlVec tables
      if (tableName.startsWith('__') || tableName.startsWith('_cdc_') || tableName.startsWith('_sqlvec_') || tableName === 'sqlite_sequence') continue;

      // Use fullSyncTable (DROP + re-COPY via scanner) instead of ensureOLAPTable
      // because ensureOLAPTable's IF NOT EXISTS skips tables already created by
      // onTableCreated callback (which fires before the INSERT). The scanner copy
      // at table creation time captures 0 rows; the deferred full sync at ~500ms
      // post-startup must force a fresh copy to include any rows written by then.
      const rowCount = await this.schemaManager.fullSyncTable(shard.shardId, tableName, shard.path, shard);
      const maxRowId = this.cdcEngine.getMaxRowId(shard, tableName);
      if (maxRowId > 0 && rowCount > 0) {
        const cpKey = this.checkpointManager.checkpointKey(shard.shardId, tableName);
        this.checkpointManager.setCheckpoint(shard.shardId, tableName, maxRowId);
        await this.checkpointManager.saveCheckpoint(cpKey, maxRowId, rowCount);
        // P0: Redundant SQLite checkpoint write
        this.checkpointManager.saveCheckpointToShard(shard, cpKey, maxRowId, rowCount);
      }
    }
  }

  /**
   * Mark a table checkpoint for full resync (e.g., after schema change).
   */
  async markFullResyncNeeded(shardId: number, tableName: string): Promise<void> {
    const cpKey = this.checkpointManager.checkpointKey(shardId, tableName);
    this.checkpointManager.setCheckpoint(shardId, tableName, 0);

    if (this.duckDB.isAvailable) {
      try {
        await this.duckDB.execRaw(
          `INSERT OR REPLACE INTO main.${CheckpointManager.CP_TABLE}
            (table_key, max_rowid, row_count, status)
           VALUES ('${cpKey.replace(/'/g, "''")}', 0, 0, 'full_resync_needed')`,
        );
  /* v8 ignore next -- catch is non-fatal defensive fallback */      } catch (err: any) {
        logger.warn({ cpKey, err: err.message }, '[DataBridge] markFullResyncNeeded failed (best-effort)');
      }
    }
  }

  // ──────────────────────────────────────────────
  //  P2: Periodic Checksum Verification
  // ──────────────────────────────────────────────

  /**
   * Run periodic checksum verification on all monitored OLAP tables.
   * Logs SHA256 checksum for each table to provide data integrity observability.
   * Non-blocking — failures do not affect tick processing.
   */
  private async runChecksumCheck(): Promise<void> {
    if (!this.duckDB.isAvailable) return;

    const shardIds = this.shardManager.getShardIds();
    for (const shardId of shardIds) {
      const shard = this.shardManager.getShard(shardId);
      if (!shard) continue;

      const tables = this.schemaManager.getMonitoredTables(shardId);
      for (const tableName of tables) {
        const def = this.schemaManager.getOLAPTable(shardId, tableName);
        if (!def) continue;

        try {
          const cs = await this.schemaManager.computeTableChecksum(def.duckDBTableName);
          if (cs) {
            logger.info({
              shardId,
              table: tableName,
              duckTable: def.duckDBTableName,
              rowCount: cs.rowCount,
              checksum: cs.checksum,
              computedAt: cs.computedAt,
            }, '[DataBridge] OLAP table checksum');
          }
  /* v8 ignore next -- catch is non-fatal defensive fallback */        } catch (err: any) {
          logger.warn({
            shardId,
            table: tableName,
            err: err.message,
          }, '[DataBridge] checksum verification failed (non-fatal)');
        }
      }
    }
  }
}
