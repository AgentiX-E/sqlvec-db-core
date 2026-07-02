/**
 * CDCEngine — CDC 触发器管理和变更日志读取引擎
 *
 * Manages SQLite trigger-based Change Data Capture (CDC) infrastructure
 * and provides methods to read changelog entries from shard databases.
 *
 * Extracted from DataBridge to provide clean separation of CDC concerns.
 *
 * ## Responsibilities
 * - Ensure CDC changelog table (_cdc_operations) exists per shard
 * - Install/uninstall AFTER INSERT / AFTER UPDATE / BEFORE DELETE triggers
 * - Read pending changelog events grouped by table + operation type
 * - Fall back to rowid-based gap detection when no CDC table exists
 * - Detect schema changes via SHA256 hashing of table_info pragma
 *
 * @see DataBridge
 */

import { PinoLogger } from '../logger/PinoLogger';
import { OLAPSchemaManager } from './OLAPSchemaManager';
import { ShardManager, ShardHandle } from '../storage/ShardManager';
import { DataBridgeConfig } from './DataBridge';
import { TableChanges } from './DataBridge';
import * as crypto from 'crypto';

const logger = PinoLogger.forComponent('CDCEngine');

// ──────────────────────────────────────────────
//  CDCEngine
// ──────────────────────────────────────────────

export class CDCEngine {
  // ── Constants ──

  /** Name of the CDC changelog table in each SQLite shard. */
  static readonly CDC_TABLE = '_cdc_operations';

  /** Prefix for CDC trigger names (full name: `{prefix}_{I|U|D}_{tableName}`). */
  static readonly CDC_TRIGGER_PREFIX = '_cdc_trig';

  /**
   * Maximum age (ms) for cached schema hashes before a re-check is forced.
   * Schema detection is cheap per-tick (table_info pragma), but this prevents
   * infinite re-hashing on every tick if the schema never changes.
   */
  static readonly MAX_SCHEMA_HASH_AGE_MS = 5_000;

  // ── Private State ──

  /** Cached SHA256 hashes of table schemas for change detection. */
  private schemaHashes = new Map<string, { hash: string; checkedAt: number }>();

  /** Cached primary key column names per table (`{shardId}:{tableName}` → pkColName). */
  private pkColCache = new Map<string, string>();

  /**
   * Internal checkpoint map for rowid-based fallback reads.
   * Tracks the maximum rowid already returned by `readChangesFromShard()`
   * for each table in each shard.
   * Format: `{shardId}:{tableName}` → number.
   */
  private checkpointByTable = new Map<string, number>();

  // ── Constructor ──

  constructor(
    private readonly shardManager: ShardManager,
    private readonly schemaManager: OLAPSchemaManager,
    private readonly config: DataBridgeConfig,
  ) {}

  // ──────────────────────────────────────────────
  //  CDC Trigger Infrastructure
  // ──────────────────────────────────────────────

  /**
   * Ensure the CDC changelog table exists in the shard database.
   * Creates `_cdc_operations` if not present.
   *
   * The table stores one row per DML operation captured by triggers:
   * - seq: auto-incrementing ordering key
   * - table_name: source table that was modified
   * - op_type: 'I' (INSERT), 'U' (UPDATE), or 'D' (DELETE)
   * - row_id: rowid (or PK value for INTEGER PRIMARY KEY tables)
   * - created_at: wall-clock timestamp of the event
   */
  ensureCDCTable(shard: ShardHandle): void {
    shard.db.exec(
      `CREATE TABLE IF NOT EXISTS ${CDCEngine.CDC_TABLE} (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT    NOT NULL,
        op_type    TEXT    NOT NULL,
        row_id     INTEGER NOT NULL,
        created_at TEXT    DEFAULT (datetime('now'))
      )`,
    );
  }

  /**
   * Ensure CDC triggers exist for a specific table in a shard.
   * Creates three triggers if they do not already exist:
   * - **AFTER INSERT**: captures the new row's rowid
   * - **AFTER UPDATE**: captures the updated row's rowid
   * - **BEFORE DELETE**: captures the rowid before the row is removed
   *
   * Idempotent — uses `CREATE TRIGGER IF NOT EXISTS`.
   */
  ensureTableTriggers(shard: ShardHandle, tableName: string): void {
    const safeName = tableName.replace(/"/g, '""');

    // AFTER INSERT trigger
    shard.db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${CDCEngine.CDC_TRIGGER_PREFIX}_I_${tableName}
       AFTER INSERT ON "${safeName}"
       BEGIN
         INSERT INTO ${CDCEngine.CDC_TABLE}(table_name, op_type, row_id)
         VALUES ('${tableName.replace(/'/g, "''")}', 'I', NEW.rowid);
       END`,
    );

    // AFTER UPDATE trigger
    shard.db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${CDCEngine.CDC_TRIGGER_PREFIX}_U_${tableName}
       AFTER UPDATE ON "${safeName}"
       BEGIN
         INSERT INTO ${CDCEngine.CDC_TABLE}(table_name, op_type, row_id)
         VALUES ('${tableName.replace(/'/g, "''")}', 'U', NEW.rowid);
       END`,
    );

    // BEFORE DELETE trigger (need rowid before row is removed)
    shard.db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${CDCEngine.CDC_TRIGGER_PREFIX}_D_${tableName}
       BEFORE DELETE ON "${safeName}"
       BEGIN
         INSERT INTO ${CDCEngine.CDC_TABLE}(table_name, op_type, row_id)
         VALUES ('${tableName.replace(/'/g, "''")}', 'D', OLD.rowid);
       END`,
    );
  }

  /**
   * Ensure CDC tables and triggers for all user tables in a shard.
   * Called on startup and when new shards are discovered.
   *
   * Skips internal tables (`_cdc_*` and `sqlite_sequence`).
   * On failure, logs a warning and returns — caller should fall back
   * to rowid-based change detection.
   */
  ensureCDCTables(shard: ShardHandle): void {
    try {
      this.ensureCDCTable(shard);
      const tables = this.listShardTables(shard);
      for (const tbl of tables) {
        if (tbl.startsWith('_cdc_') || tbl === 'sqlite_sequence') continue;
        this.ensureTableTriggers(shard, tbl);
      }
    } catch (err: any) {
      logger.warn({ shardId: shard.shardId, err: err.message },
        '[CDCEngine] CDC trigger setup failed — will use rowid fallback');
    }
  }

  // ──────────────────────────────────────────────
  //  CDC Changelog Reading
  // ──────────────────────────────────────────────

  /**
   * Check if the CDC changelog table exists in a shard.
   * Queries `sqlite_master` for `_cdc_operations`.
   * Returns false on any error (query failed or table absent).
   */
  hasCDCTable(shard: ShardHandle): boolean {
    try {
      const row = shard.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
      ).get(CDCEngine.CDC_TABLE) as any;
      return !!row;
    } catch (err: any) {
      logger.warn({ err: err.message, shardId: shard.shardId }, '[CDCEngine] hasCDCTable failed');
      return false;
    }
  }

  /**
   * Read all pending changes (INSERT, UPDATE, DELETE) using trigger-based CDC.
   *
   * Reads from `_cdc_operations` changelog (populated by SQLite triggers),
   * groups events by table and operation type, then reads the actual row
   * data from the source tables for INSERT and UPDATE events.
   *
   * DELETE events do not have corresponding row data — only the rowid/PK value
   * is available from the changelog.
   *
   * **GC note**: This method does NOT delete processed changelog entries.
   * The caller is responsible for GC after successfully applying the changes
   * to the downstream system.
   *
   * @returns Grouped changes by monitored table, plus the maximum seq so
   *          the caller knows which entries to clean up.
   */
  readChangelog(shard: ShardHandle): { changes: TableChanges[]; maxSeq: number } {
    if (!this.hasCDCTable(shard)) return { changes: [], maxSeq: 0 };

    const tables = this.schemaManager.getMonitoredTables(shard.shardId);
    if (tables.length === 0) return { changes: [], maxSeq: 0 };

    // Read all pending changelog events, ordered by seq, capped at batchSize
    const ops = shard.db.prepare(
      `SELECT seq, table_name, op_type, row_id
       FROM ${CDCEngine.CDC_TABLE}
       ORDER BY seq
       LIMIT ?`,
    ).all(this.config.batchSize) as Array<{ seq: number; table_name: string; op_type: string; row_id: number }>;

    if (ops.length === 0) return { changes: [], maxSeq: 0 };

    // Group by table + op_type
    const tableChanges = new Map<string, { inserts: number[]; updates: number[]; deletes: number[] }>();
    let maxSeq = 0;

    for (const op of ops) {
      if (op.seq > maxSeq) maxSeq = op.seq;
      // Skip tables not yet registered with SchemaManager
      if (!tables.includes(op.table_name)) continue;
      // Skip CDC-internal tables
      if (op.table_name.startsWith('_cdc_')) continue;

      let entry = tableChanges.get(op.table_name);
      if (!entry) {
        entry = { inserts: [], updates: [], deletes: [] };
        tableChanges.set(op.table_name, entry);
      }

      switch (op.op_type) {
        case 'I': entry.inserts.push(op.row_id); break;
        case 'U': entry.updates.push(op.row_id); break;
        case 'D': entry.deletes.push(op.row_id); break;
      }
    }

    // Build results — read actual row data for inserts/updates from source
    const results: TableChanges[] = [];
    for (const tableName of tables) {
      const entry = tableChanges.get(tableName);
      if (!entry || (entry.inserts.length === 0 && entry.updates.length === 0 && entry.deletes.length === 0)) continue;

      const safeName = tableName.replace(/"/g, '""');
      const inserts: any[] = [];
      const updates: { rowid: number; row: any }[] = [];

      // Batch-read row data from source table
      // NOTE: better-sqlite3 omits implicit rowid for INTEGER PRIMARY KEY tables.
      // For IPK tables, the changelog's row_id IS the PK value.
      // Use PK values directly for the rowid-based position tracking.
      if (entry.inserts.length > 0 || entry.updates.length > 0) {
        const allRids = [...new Set([...entry.inserts, ...entry.updates])];
        const sourceRows = shard.db.prepare(
          `SELECT rowid, * FROM "${safeName}" WHERE rowid IN (${allRids.join(',')})`,
        ).all() as any[];

        // Build lookup keyed by rowid.
        // For non-IPK tables: rowid appears as a result column from SELECT rowid, *
        // For IPK tables: rowid is aliased to the PK column, so fall back to first col value
        const rowMap = new Map<number, any>();
        for (const r of sourceRows) {
          const rid = r.rowid != null ? Number(r.rowid) : Number(r[Object.keys(r)[0]]);
          if (rid != null && !isNaN(rid)) rowMap.set(rid, r);
        }

        // INSERTS: use row data from source
        for (const insertRid of entry.inserts) {
          const row = rowMap.get(insertRid);
          if (row) {
            const { rowid: _rid, ...data } = row;
            inserts.push(data);
          }
        }

        // UPDATES: use row data from source
        // MVCC soft-delete detection: MVCC rewrites DELETE as UPDATE t SET _xmax=xid,
        // so the BEFORE DELETE trigger never fires and the AFTER UPDATE trigger
        // incorrectly records 'U'. Detect this by checking if the row has _xmax != 0
        // (indicating an MVCC tombstone / soft-delete) and reclassify as 'D'.
        const mvccDeleteRids: number[] = [];
        for (const updRid of entry.updates) {
          const row = rowMap.get(updRid);
          if (row) {
            // MVCC soft-delete check: _xmax is a non-zero XID (row tombstoned)
            if (row._xmax !== undefined && row._xmax !== null && Number(row._xmax) !== 0) {
              mvccDeleteRids.push(updRid);
            } else {
              updates.push({ rowid: updRid, row: { ...row } });
            }
          }
        }
        // Add MVCC-soft-deleted rows to deletes
        for (const rid of mvccDeleteRids) {
          entry.deletes.push(rid);
        }
      }

      results.push({
        tableName,
        inserts,
        updates,
        deletes: [...entry.deletes],
      });
    }

    // GC is NOT done here — the caller (typically DataBridge tick) is
    // responsible for deleting processed changelog entries after
    // successfully applying changes to DuckDB.
    return { changes: results, maxSeq };
  }

  /**
   * Read changes using trigger-based CDC (from `_cdc_operations`).
   *
   * Reads up to `batchSize` changelog entries, classifies by operation type,
   * reads actual row data for INSERT and UPDATE events from the source table.
   *
   * **Note**: Unlike `readChangelog()`, this method ALSO performs CDC GC
   * (marks processed entries as deleted) after reading. This is the simpler
   * self-contained variant; `readChangelog()` delegates GC to the caller.
   */
  readChangesFromCDC(shard: ShardHandle): TableChanges[] {
    const tables = this.schemaManager.getMonitoredTables(shard.shardId);
    if (tables.length === 0) return [];

    // Read from changelog sorted by seq
    const ops = shard.db.prepare(
      `SELECT seq, table_name, op_type, row_id
       FROM ${CDCEngine.CDC_TABLE}
       ORDER BY seq
       LIMIT ?`,
    ).all(this.config.batchSize) as Array<{ seq: number; table_name: string; op_type: string; row_id: number }>;

    if (ops.length === 0) return [];

    // Group by table
    const tableOps = new Map<string, { inserts: number[]; updates: number[]; deletes: number[] }>();
    let maxSeq = 0;

    for (const op of ops) {
      if (op.seq > maxSeq) maxSeq = op.seq;
      if (!tables.includes(op.table_name)) continue; // Not monitored — skip
      if (op.table_name.startsWith('_cdc_')) continue;

      let entry = tableOps.get(op.table_name);
      if (!entry) {
        entry = { inserts: [], updates: [], deletes: [] };
        tableOps.set(op.table_name, entry);
      }

      switch (op.op_type) {
        case 'I': entry.inserts.push(op.row_id); break;
        case 'U': entry.updates.push(op.row_id); break;
        case 'D': entry.deletes.push(op.row_id); break;
      }
    }

    // Build results — read actual row data for I and U
    const results: TableChanges[] = [];
    for (const tableName of tables) {
      const ops2 = tableOps.get(tableName);
      if (!ops2 || (ops2.inserts.length === 0 && ops2.updates.length === 0 && ops2.deletes.length === 0)) continue;

      const safeName = tableName.replace(/"/g, '""');
      const inserts: any[] = [];

      if (ops2.inserts.length > 0) {
        // Batch-read inserts
        const insertRows = shard.db.prepare(
          `SELECT * FROM "${safeName}" WHERE rowid IN (${ops2.inserts.join(',')})`,
        ).all() as any[];
        for (const r of insertRows) {
          const { rowid, ...data } = r;
          inserts.push(data);
        }
      }

      const updates: { rowid: number; row: any }[] = [];
      // MVCC soft-delete detection (same rationale as readChangelog above)
      const mvccDeleteRids: number[] = [];
      if (ops2.updates.length > 0) {
        const updateRows = shard.db.prepare(
          `SELECT * FROM "${safeName}" WHERE rowid IN (${ops2.updates.join(',')})`,
        ).all() as any[];
        const updateMap = new Map<number, any>();
        for (const r of updateRows) {
          const { rowid, ...data } = r;
          updateMap.set(rowid, data);
        }
        for (const rid of ops2.updates) {
          const row = updateMap.get(rid);
          if (row) {
            if (row._xmax !== undefined && row._xmax !== null && Number(row._xmax) !== 0) {
              mvccDeleteRids.push(rid);
            } else {
              updates.push({ rowid: rid, row });
            }
          }
        }
        // Add MVCC-soft-deleted rows to deletes
        ops2.deletes.push(...mvccDeleteRids);
      }

      results.push({
        tableName,
        inserts,
        updates,
        deletes: [...ops2.deletes],
      });
    }

    // Mark processed entries as deleted (DELETE by seq range)
    if (maxSeq > 0) {
      shard.db.exec(`DELETE FROM ${CDCEngine.CDC_TABLE} WHERE seq <= ${maxSeq}`);
    }

    return results;
  }

  /**
   * Read incremental changes from a shard via `SELECT WHERE rowid > checkpoint`.
   *
   * This is the rowid-based fallback used when the trigger-based CDC table
   * is not available or has no pending events. It detects new rows inserted
   * before CDC triggers were installed.
   *
   * Uses a read-only transaction to avoid blocking OLTP writes.
   * Range-bounded to `batchSize` to prevent memory spikes.
   *
   * Handles INTEGER PRIMARY KEY tables correctly: the PK column shadows
   * rowid in better-sqlite3, so we use the PK column value as the rowid proxy.
   */
  async readChangesFromShard(shard: ShardHandle, externalCheckpoint?: Map<string, number>): Promise<TableChanges[]> {
    const tables = this.schemaManager.getMonitoredTables(shard.shardId);
    if (tables.length === 0) return [];

    const results: TableChanges[] = [];

    for (const tableName of tables) {
      const cpKey = `${shard.shardId}:${tableName}`;
      // Use externalCheckpoint (from CheckpointManager) when provided,
      // fall back to internal checkpointByTable for backward compatibility.
      const cp = externalCheckpoint ? (externalCheckpoint.get(cpKey) ?? 0) : (this.checkpointByTable.get(cpKey) ?? 0);
      const upperBound = cp + this.config.batchSize;

      // Detect if this table has INTEGER PRIMARY KEY — that column shadows rowid
      // in better-sqlite3's result objects. For such tables, use the PK column
      // value directly as rowid proxy; otherwise use built-in rowid.
      const tableInfo = shard.db.pragma(`table_info("${tableName.replace(/"/g, '""')}")`) as any[];
      const intPkCol = tableInfo.find((c: any) => c.pk > 0 && c.type === 'INTEGER')?.name;
      const rowidExpr = intPkCol ? `"${intPkCol.replace(/"/g, '""')}"` : 'rowid';

      const rows = shard.db.transaction(() => {
        // v3: range-bounded — never read more than batchSize rows at once
        return shard.db.prepare(
          `SELECT *, ${rowidExpr} AS __rid FROM "${tableName.replace(/"/g, '""')}"
           WHERE rowid > ? AND rowid <= ?
           ORDER BY rowid`,
        ).all(cp, upperBound);
      })();

      if (rows.length === 0) continue;

      // Determine new max rowid from __rid field
      let maxRowId = 0;
      for (const r of rows) {
        const ridVal = (r as any).__rid ?? 0;
        const rid = typeof ridVal === 'bigint' ? Number(ridVal) : Number(ridVal);
        if (rid > maxRowId) maxRowId = rid;
      }
      this.checkpointByTable.set(cpKey, maxRowId);
      if (externalCheckpoint) externalCheckpoint.set(cpKey, maxRowId);

      // Classify changes — all new rows are inserts
      const inserts = rows.map((r: any) => {
        const { __rid, ...data } = r;
        return data;
      });

      results.push({
        tableName,
        inserts,
        updates: [],
        deletes: [],
      });
    }

    return results;
  }

  // ──────────────────────────────────────────────
  //  Schema Introspection
  // ──────────────────────────────────────────────

  /**
   * Detect the primary key column for a shard table.
   *
   * Specifically looks for an **INTEGER PRIMARY KEY** column, since:
   * - For IPK tables, the PK shadows rowid in SQLite
   * - CDC rowid values can be used as PK values directly
   * - This enables PK-based upserts in the downstream OLAP layer
   *
   * Results are cached in `pkColCache` to avoid repeated pragma queries.
   *
   * @returns The INTEGER PRIMARY KEY column name, or `undefined` if no IPK exists.
   */
  getPKCol(shard: ShardHandle, tableName: string): string | undefined {
    const key = `${shard.shardId}:${tableName}`;
    let col = this.pkColCache.get(key);
    if (col !== undefined) return col || undefined;

    try {
      const tableInfo = shard.db.pragma(`table_info("${tableName.replace(/"/g, '""')}")`) as any[];
      const pkCol = tableInfo.find((c: any) => c.pk > 0 && c.type === 'INTEGER')?.name;
      this.pkColCache.set(key, pkCol ?? '');
      return pkCol || undefined;
    } catch (err: any) {
      logger.warn({ err: err.message, key }, '[CDCEngine] getPKColumn failed');
      this.pkColCache.set(key, '');
      return undefined;
    }
  }

  /**
   * Get the maximum rowid for a table in a shard.
   * Used to initialize checkpoints after full sync.
   *
   * @returns The max rowid, or 0 if the table is empty or unavailable.
   */
  getMaxRowId(shard: ShardHandle, tableName: string): number {
    try {
      const row = shard.db.prepare(
        `SELECT MAX(rowid) AS max_id FROM "${tableName.replace(/"/g, '""')}"`,
      ).get() as any;
      return row?.max_id != null ? Number(row.max_id) : 0;
    } catch (err: any) {
      logger.warn({ shardId: shard.shardId, tableName, err: err.message },
        '[CDCEngine] getMaxRowId failed');
      return 0;
    }
  }

  /**
   * List user tables in a shard database.
   * Queries `sqlite_master` for all tables, excluding sqlite_* internal tables.
   *
   * @returns Array of table names, or empty on error.
   */
  listShardTables(shard: ShardHandle): string[] {
    try {
      const rows = shard.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      ).all() as any[];
      return rows.map((r: any) => r.name);
    } catch (err: any) {
      logger.warn({ shardId: shard.shardId, err: err.message }, '[CDCEngine] listShardTables failed');
      return [];
    }
  }

  // ──────────────────────────────────────────────
  //  Schema Change Detection
  // ──────────────────────────────────────────────

  /**
   * Schema change detection — computes a SHA256 hash of the SQLite table schema
   * and compares it against a cached value.
   *
   * Called once per table per tick. Returns `true` if the schema has changed
   * since the last check, indicating that a full resync is needed.
   *
   * The schema hash is computed from the table's column definitions
   * (name + type) returned by `table_info` pragma.
   *
   * @returns `true` if the schema hash differs from the cached value,
   *          meaning the caller should trigger a full resync.
   */
  detectSchemaChange(shard: ShardHandle, tableName: string): boolean {
    try {
      const cols = shard.db.pragma(`table_info("${tableName.replace(/"/g, '""')}")`) as any[];
      const schemaStr = cols.map((c: any) => `${c.name}:${c.type}`).join(',');
      const hash = crypto.createHash('sha256').update(schemaStr).digest('hex');
      const key = `${shard.shardId}:${tableName}`;
      const prev = this.schemaHashes.get(key);

      if (!prev) {
        this.schemaHashes.set(key, { hash, checkedAt: Date.now() });
        return false;
      }

      if (prev.hash !== hash) {
        logger.info({ shardId: shard.shardId, tableName },
          '[CDCEngine] Schema change detected');
        this.schemaHashes.set(key, { hash, checkedAt: Date.now() });
        return true;
      }

      return false;
    } catch (err: any) {
      logger.warn({ shardId: shard.shardId, tableName, err: err.message },
        '[CDCEngine] Schema detection error');
      return false;
    }
  }
}
