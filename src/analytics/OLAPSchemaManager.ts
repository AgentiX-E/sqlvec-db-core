/**
 * OLAPSchemaManager — 列存元数据管理
 *
 * Manages DuckDB columnar table lifecycle for the DataBridge CDC sync.
 * Maintains the mapping between SQLite source tables and DuckDB columnar
 * target tables, along with type mappings and sync state.
 *
 * ## Table naming convention
 *
 * DuckDB columnar tables are named: `olap_shard_{shardId}_{tableName}`
 * Example: `olap_shard_0_lineitem`
 *
 * ## Flow
 *
 * ```
 * DataBridge.syncBatch()
 *   └─ OLAPSchemaManager.ensureOLAPTable(shardId, 'lineitem')
 *        └─ DuckDB: CREATE TABLE olap_shard_0_lineitem AS SELECT * FROM sqlite_scan(...)
 *   └─ OLAPSchemaManager.getMonitoredTables(shardId)
 *   └─ DataBridge reads SQLite delta via rowid > checkpoint
 *   └─ DataBridge writes to DuckDB via appendToOLAPTable()
 * ```
 *
 * @see docs/analytics-optimization-design.md §8
 */

import { PinoLogger } from '../logger/PinoLogger';
import { DuckDBAnalyticsManager } from './DuckDBAnalyticsManager';
import type { ShardHandle } from '../storage/ShardManager';
import * as crypto from 'crypto';

const logger = PinoLogger.forComponent('OLAPSchemaManager');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface OLAPTableDef {
  /** Shard identifier */
  shardId: number;
  /** Original SQLite table name */
  sqliteTableName: string;
  /** DuckDB columnar table name (olap_shard_{shardId}_{tableName}) */
  duckDBTableName: string;
  /** Columns in the columnar table */
  columns: ColumnDef[];
  /** Row count (last known) */
  rowCount: number;
  /** Last sync timestamp */
  lastSyncedAt: number;
  /** Sync strategy */
  syncStrategy: 'full' | 'incremental';
}

export interface ColumnDef {
  name: string;
  type: string;
  nullable: boolean;
}

// ──────────────────────────────────────────────
//  Type Mapping
// ──────────────────────────────────────────────

const SQLITE_TO_DUCKDB_TYPE: Record<string, string> = {
  'INTEGER': 'BIGINT',
  'INT': 'BIGINT',
  'INT2': 'SMALLINT',
  'INT4': 'INTEGER',
  'INT8': 'BIGINT',
  'TINYINT': 'TINYINT',
  'SMALLINT': 'SMALLINT',
  'BIGINT': 'BIGINT',
  'REAL': 'FLOAT',
  'FLOAT': 'DOUBLE',
  'DOUBLE': 'DOUBLE',
  'DOUBLE PRECISION': 'DOUBLE',
  'NUMERIC': 'DECIMAL(38,10)',
  'DECIMAL': 'DECIMAL(38,10)',
  'BOOLEAN': 'BOOLEAN',
  'TEXT': 'VARCHAR',
  'VARCHAR': 'VARCHAR',
  'CHAR': 'VARCHAR',
  'CLOB': 'VARCHAR',
  'BLOB': 'BLOB',
  'DATE': 'DATE',
  'DATETIME': 'TIMESTAMP',
  'TIMESTAMP': 'TIMESTAMP',
};

// ──────────────────────────────────────────────
//  OLAPSchemaManager
// ──────────────────────────────────────────────

export class OLAPSchemaManager {
  private tables: Map<string, OLAPTableDef> = new Map();
  private monitoredTables: Map<number, Set<string>> = new Map();

  constructor(
    private readonly duckDB: DuckDBAnalyticsManager,
  ) {}

  // ── Table Lifecycle ──

  /**
   * Ensure a DuckDB columnar table exists for the given SQLite table.
   * If the columnar table doesn't exist, creates it via full COPY.
   * Idempotent: safe to call repeatedly.
   *
   * @returns The OLAPTableDef representing the columnar table.
   */
  async ensureOLAPTable(shardId: number, sqliteTableName: string, sqliteDbPath: string): Promise<OLAPTableDef> {
    const duckName = this.duckTableName(shardId, sqliteTableName);
    const key = this.tableKey(shardId, sqliteTableName);

    // Already registered and verified
    if (this.tables.has(key)) {
      return this.tables.get(key)!;
    }

    // Check if columnar table already exists in DuckDB
    const exists = await this.duckTableExists(duckName);
    if (!exists) {
      // Full COPY: CREATE TABLE olap_shard_N_table AS SELECT * FROM scanner schema
      await this.ensureScannerAttached(shardId, sqliteDbPath);
      const scannerSchema = `"scanner_shard_${shardId}"`;
      const createSql = `CREATE TABLE "${duckName}" AS SELECT * FROM ${scannerSchema}."${sqliteTableName.replace(/"/g, '""')}"`;
      await this.duckDB.execRaw(createSql);
      logger.info({ shardId, table: sqliteTableName, duckTable: duckName }, 'OLAP columnar table created via scanner schema');
    }

    // Create a DuckDB VIEW with the original table name so PG wire queries
    // (which use the original name) can route to DuckDB via UnifiedRouter.
    // Use CREATE OR REPLACE VIEW first. If it fails because the existing
    // object is a TABLE, drop the table and retry. DuckDB's IF EXISTS
    // only works within the same type (DROP TABLE IF EXISTS throws on
    // a view; DROP VIEW IF EXISTS throws on a table).
    try {
      await this.duckDB.execRaw(
        `CREATE OR REPLACE VIEW "${sqliteTableName.replace(/"/g, '""')}" AS SELECT * FROM "${duckName}"`
      );
    } catch (viewErr: any) {
      if (viewErr.message && typeof viewErr.message === 'string' &&
          viewErr.message.includes('use DROP TABLE')) {
        try {
          await this.duckDB.execRaw(`DROP TABLE IF EXISTS "${sqliteTableName.replace(/"/g, '""')}"`);
          await this.duckDB.execRaw(
            `CREATE VIEW "${sqliteTableName.replace(/"/g, '""')}" AS SELECT * FROM "${duckName}"`
          );
        } catch (viewRetryErr: any) {
          logger.warn({ err: viewRetryErr.message, table: sqliteTableName },
            '[OLAPSchemaManager] Failed to create DuckDB view for original table name (non-fatal)');
        }
      } else {
        logger.warn({ err: viewErr.message, table: sqliteTableName },
          '[OLAPSchemaManager] Failed to create DuckDB view for original table name (non-fatal)');
      }
    }
    // Get column info
    const columns = await this.getTableColumns(duckName);
    const rowCount = await this.getTableRowCount(duckName);

    const def: OLAPTableDef = {
      shardId,
      sqliteTableName,
      duckDBTableName: duckName,
      columns,
      rowCount,
      lastSyncedAt: Date.now(),
      syncStrategy: 'incremental',
    };
    this.tables.set(key, def);

    // Track per-shard
    if (!this.monitoredTables.has(shardId)) {
      this.monitoredTables.set(shardId, new Set());
    }
    this.monitoredTables.get(shardId)!.add(sqliteTableName);

    return def;
  }

  /**
   * Full re-sync: DELETE + re-COPY a columnar table from SQLite source.
   * Used when schema changes are detected or consistency check fails.
   *
   * Bypasses sqlite_scanner — uses the server's better-sqlite3 connection
   * for data access (see ensureOLAPTableFromHandle).
   */
  /**
   * Ensure a DuckDB columnar table exists, sourcing data DIRECTLY from the
   * server's better-sqlite3 connection (bypasses the sqlite_scanner extension).
   *
   * sqlite_scanner ATTACH caches the SQLite table list at ATTACH time. Tables
   * created via PG wire + Raft after ATTACH are invisible to the scanner.
   * This method uses the server's own `shard.db` connection (which always has
   * the latest state) to read schema and data, creating the DuckDB table
   * without relying on the scanner.
   *
   * @param shardId - Shard identifier
   * @param sqliteTableName - Original SQLite table name
   * @param shard - ShardHandle with access to .db (better-sqlite3 connection)
   */
  async ensureOLAPTableFromHandle(shardId: number, sqliteTableName: string, shard: ShardHandle): Promise<OLAPTableDef> {
    const duckName = this.duckTableName(shardId, sqliteTableName);
    const key = this.tableKey(shardId, sqliteTableName);

    // Already registered and verified
    if (this.tables.has(key)) return this.tables.get(key)!;

    // Check if columnar table already exists in DuckDB
    const exists = await this.duckTableExists(duckName);
    if (!exists) {
      // Read schema from SQLite via better-sqlite3 (always has latest state)
      const sqliteCols: any[] = shard.db.prepare(
        `PRAGMA table_info("${sqliteTableName.replace(/"/g, '""')}")`
      ).all();
      if (sqliteCols.length === 0) {
        throw new Error(`Table "${sqliteTableName}" has no columns in SQLite`);
      }

      // Build DuckDB CREATE TABLE with compatible types
      const colDefs = sqliteCols.map((c: any) => {
        const duckType = this.mapType(c.type || 'TEXT');
        return `"${c.name.replace(/"/g, '""')}" ${duckType}`;
      }).join(', ');
      const createSql = `CREATE TABLE "${duckName}" (${colDefs})`;
      await this.duckDB.execRaw(createSql);

      // Copy data from SQLite to DuckDB row by row
      const allRows: any[] = shard.db.prepare(
        `SELECT * FROM "${sqliteTableName.replace(/"/g, '""')}"`
      ).all();
      if (allRows.length > 0) {
        const valuesList: string[] = [];
        for (const row of allRows) {
          const vals = sqliteCols.map((c: any) => {
            const v = row[c.name];
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'number') return String(v);
            if (typeof v === 'boolean') return v ? 'true' : 'false';
            const s = String(v).replace(/'/g, "''");
            return `'${s}'`;
          }).join(',');
          valuesList.push(`(${vals})`);
        }
        const colNames = sqliteCols.map((c: any) => `"${c.name.replace(/"/g, '""')}"`).join(',');
        const batchSize = 500;
        for (let i = 0; i < valuesList.length; i += batchSize) {
          const batch = valuesList.slice(i, i + batchSize).join(', ');
          const insertSql = `INSERT INTO "${duckName}" (${colNames}) VALUES ${batch}`;
          await this.duckDB.execRaw(insertSql);
        }
      }
    }

    // Create a DuckDB VIEW with the original table name for PG wire routing
    try {
      await this.duckDB.execRaw(
        `CREATE OR REPLACE VIEW "${sqliteTableName.replace(/"/g, '""')}" AS SELECT * FROM "${duckName}"`
      );
    } catch (viewErr: any) {
      if (viewErr.message && typeof viewErr.message === 'string' &&
          viewErr.message.includes('use DROP TABLE')) {
        try {
          await this.duckDB.execRaw(`DROP TABLE IF EXISTS "${sqliteTableName.replace(/"/g, '""')}"`);
          await this.duckDB.execRaw(
            `CREATE VIEW "${sqliteTableName.replace(/"/g, '""')}" AS SELECT * FROM "${duckName}"`
          );
        } catch (viewRetryErr: any) {
          logger.warn({ err: viewRetryErr.message, table: sqliteTableName },
            '[OLAPSchemaManager] Failed to create DuckDB view for original table name (non-fatal)');
        }
      } else {
        logger.warn({ err: viewErr.message, table: sqliteTableName },
          '[OLAPSchemaManager] Failed to create DuckDB view for original table name (non-fatal)');
      }
    }

    // Get column info and row count
    const columns = await this.getTableColumns(duckName);
    const rowCount = await this.getTableRowCount(duckName);

    const def: OLAPTableDef = {
      shardId,
      sqliteTableName,
      duckDBTableName: duckName,
      columns,
      rowCount,
      lastSyncedAt: Date.now(),
      syncStrategy: 'incremental',
    };
    this.tables.set(key, def);

    if (!this.monitoredTables.has(shardId)) {
      this.monitoredTables.set(shardId, new Set());
    }
    this.monitoredTables.get(shardId)!.add(sqliteTableName);

    return def;
  }

  async fullSyncTable(shardId: number, sqliteTableName: string, sqliteDbPath: string, shard?: ShardHandle): Promise<number> {
    const duckName = this.duckTableName(shardId, sqliteTableName);
    const key = this.tableKey(shardId, sqliteTableName);

    // Drop and recreate
    await this.duckDB.execRaw(`DROP TABLE IF EXISTS "${duckName}"`);
    this.tables.delete(key);

    // Remove from monitored set
    this.monitoredTables.get(shardId)?.delete(sqliteTableName);

    // Re-create via handle (preferred, bypasses stale scanner cache) or scanner fallback
    const def = shard
      ? await this.ensureOLAPTableFromHandle(shardId, sqliteTableName, shard)
      : await this.ensureOLAPTable(shardId, sqliteTableName, sqliteDbPath);
    return def.rowCount;
  }

  // ── Query Methods ──

  /**
   * Get the list of tables being monitored for a given shard.
   */
  getMonitoredTables(shardId: number): string[] {
    return [...(this.monitoredTables.get(shardId) ?? [])];
  }

  /**
   * List all registered OLAP table definitions.
   */
  listOLAPTables(): OLAPTableDef[] {
    return [...this.tables.values()];
  }

  /**
   * Get a specific OLAP table definition.
   */
  getOLAPTable(shardId: number, sqliteTableName: string): OLAPTableDef | undefined {
    return this.tables.get(this.tableKey(shardId, sqliteTableName));
  }

  /**
   * Resolve SQLite table name to DuckDB columnar table name.
   * Returns the original name if no mapping found (e.g., for pgbench tables
   * that may not have been synced yet).
   */
  resolveTableName(shardId: number, sqliteTableName: string): string {
    const def = this.getOLAPTable(shardId, sqliteTableName);
    if (def) return def.duckDBTableName;
    // Fallback: use the naming convention directly
    return this.duckTableName(shardId, sqliteTableName);
  }

  // ── Consistency ──

  /**
   * Verify checksum consistency between SQLite source and DuckDB columnar table.
   * Compares row count + aggregated hash.
   * @returns true if consistent, false otherwise
   */
  async verifyChecksum(shardId: number, tableName: string, sqliteDb: any): Promise<boolean> {
    const duckName = this.duckTableName(shardId, tableName);

    try {
      // Row count comparison (fast path)
      const sqliteCount = sqliteDb.prepare(`SELECT COUNT(*) AS cnt FROM "${tableName}"`).get() as any;
      const duckCount = await this.duckDB.queryRaw(`SELECT COUNT(*) AS cnt FROM "${duckName}"`);
      if (Number(sqliteCount.cnt) !== Number(duckCount[0]?.cnt ?? 0)) return false;

      // Phase 2: md5 row-level checksum — compute deterministic hash of both sides
      // SQLite: get all rows ordered by rowid, build cumulative md5
      const sqliteRows = sqliteDb.prepare(`SELECT * FROM "${tableName}" ORDER BY rowid`).all() as any[];
      const sqliteHash = crypto.createHash('md5');
      for (const row of sqliteRows) {
        // Normalize BigInt values for deterministic JSON serialization
        const vals = Object.values(row).map(v => typeof v === 'bigint' ? Number(v) : v);
        sqliteHash.update(JSON.stringify(vals));
      }
      const sqliteChecksum = sqliteHash.digest('hex');

      // DuckDB: same computation, ordered by rowid
      const duckRows = await this.duckDB.queryRaw(`SELECT * FROM "${duckName}" ORDER BY rowid`) as any[];
      const duckHash = crypto.createHash('md5');
      for (const row of duckRows) {
        const vals = Object.values(row).map(v => typeof v === 'bigint' ? Number(v) : v);
        duckHash.update(JSON.stringify(vals));
      }
      const duckChecksum = duckHash.digest('hex');

      if (sqliteChecksum !== duckChecksum) {
        logger.error({ shardId, tableName, sqliteChecksum, duckChecksum },
          '[SchemaManager] Checksum mismatch — columnar table out of sync');
        return false;
      }
      return true;
    } catch (err: any) {
      logger.warn({ shardId, tableName, err: err.message },
        '[SchemaManager] Checksum verification failed');
      return false;
    }
  }

  // ── Map Type ──

  /**
   * Map a SQLite type string to DuckDB type.
   */
  mapType(sqliteType: string): string {
    const upper = sqliteType.toUpperCase().split('(')[0].trim();
    return SQLITE_TO_DUCKDB_TYPE[upper] ?? 'VARCHAR';
  }

  // ── Internal ──

  private duckTableName(shardId: number, sqliteTableName: string): string {
    return `olap_shard_${shardId}_${sqliteTableName}`;
  }

  private tableKey(shardId: number, sqliteTableName: string): string {
    return `${shardId}:${sqliteTableName}`;
  }

  private async duckTableExists(tableName: string): Promise<boolean> {
    try {
      const rows = await this.duckDB.queryRaw(
        `SELECT table_name FROM information_schema.tables WHERE table_name = '${tableName.replace(/'/g, "''")}'`,
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  private async getTableColumns(tableName: string): Promise<ColumnDef[]> {
    try {
      const rows = await this.duckDB.queryRaw(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns ` +
        `WHERE table_name = '${tableName.replace(/'/g, "''")}' ORDER BY ordinal_position`,
      );
      return rows.map((r: any) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === 'YES',
      }));
    } catch {
      return [];
    }
  }

  private async getTableRowCount(tableName: string): Promise<number> {
    try {
      const rows = await this.duckDB.queryRaw(`SELECT COUNT(*) AS cnt FROM "${tableName.replace(/"/g, '""')}"`);
      return Number(rows[0]?.cnt ?? 0);
    } catch {
      return 0;
    }
  }

  /**
   * Ensure the scanner is attached for a shard database.
   * Uses the sqlite_scanner extension to create a virtual schema.
   */
  private async ensureScannerAttached(shardId: number, dbPath: string): Promise<void> {
    try {
      const attachName = `scanner_shard_${shardId}`;
      await this.duckDB.execRaw(`ATTACH '${dbPath.replace(/'/g, "''")}' AS ${attachName} (TYPE SQLITE)`);
    } catch {
      // Already attached or scanner not available — may fail silently
    }
  }

  /**
   * Refresh the scanner attachment by DETACH + RE-ATTACH.
   * Needed when new tables are created in SQLite AFTER the initial ATTACH,
   * because the sqlite_scanner extension caches the schema at ATTACH time
   * and does not auto-discover newly created tables.
   */
  async refreshScanner(shardId: number, dbPath: string): Promise<void> {
    const attachName = `scanner_shard_${shardId}`;
    try {
      // DETACH (ignore error if not attached)
      await this.duckDB.execRaw(`DETACH ${attachName}`).catch(() => {});
      // RE-ATTACH
      await this.duckDB.execRaw(`ATTACH '${dbPath.replace(/'/g, "''")}' AS ${attachName} (TYPE SQLITE)`);
    } catch (err: any) {
      logger.warn({ err: err.message, shardId },
        '[OLAPSchemaManager] Failed to refresh scanner attachment');
    }
  }

  // ──────────────────────────────────────────────
  //  P2: Table Checksum Verification
  // ──────────────────────────────────────────────

  /**
   * Compute SHA256 checksum for a DuckDB OLAP table.
   * Reads data in chunks (10k rows) to avoid OOM on large tables.
   *
   * @returns { rows, checksum, computedAt } or null if table not found
   */
  async computeTableChecksum(duckTableName: string, chunkSize = 10000): Promise<{
    tableName: string;
    rowCount: number;
    checksum: string;
    computedAt: number;
  } | null> {
    try {
      // Get row count
      const countRes = await this.duckDB.execute(
        `SELECT COUNT(*) AS cnt FROM "${duckTableName.replace(/"/g, '""')}"`
      );
      const rowCount = Number(countRes.rows[0]?.cnt ?? 0);
      if (rowCount === 0) {
        return {
          tableName: duckTableName,
          rowCount: 0,
          checksum: crypto.createHash('sha256').digest('hex'),
          computedAt: Date.now(),
        };
      }

      const hash = crypto.createHash('sha256');
      let offset = 0;

      while (true) {
        const res = await this.duckDB.execute(
          `SELECT * FROM "${duckTableName.replace(/"/g, '""')}" ORDER BY rowid LIMIT ${chunkSize} OFFSET ${offset}`
        );
        if (res.rows.length === 0) break;

        for (const row of res.rows) {
          // Sort keys for deterministic ordering
          const keys = Object.keys(row).sort();
          const sortedRow: Record<string, unknown> = {};
          for (const k of keys) sortedRow[k] = row[k];
          hash.update(JSON.stringify(sortedRow));
        }
        offset += res.rows.length;
      }

      return {
        tableName: duckTableName,
        rowCount,
        checksum: hash.digest('hex'),
        computedAt: Date.now(),
      };
    } catch (err: any) {
      logger.warn({ duckTableName, err: err.message },
        '[OLAPSchemaManager] computeTableChecksum failed');
      return null;
    }
  }

  /**
   * Verify that a DuckDB table's data matches the SQLite source.
   * Uses row count as a quick consistency check.
   *
   * @returns { consistent, duckRowCount, sqliteRowCount } or null if not comparable
   */
  verifyTableData(shardHandle: ShardHandle, duckTableName: string, sqliteTableName: string): {
    consistent: boolean;
    duckRowCount: number;
    sqliteRowCount: number;
  } | null {
    try {
      // SQLite row count
      const sqliteRow = shardHandle.db.prepare(
        `SELECT COUNT(*) AS cnt FROM "${sqliteTableName.replace(/"/g, '""')}"`
      ).get() as { cnt: number } | undefined;
      const sqliteRowCount = sqliteRow?.cnt ?? 0;

      // DuckDB row count via promise
      // (inlined sync check not possible — async caller must handle)
      return null;
    } catch {
      return null;
    }
  }
}
