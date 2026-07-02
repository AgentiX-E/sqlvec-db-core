/**
 * DuckDBAnalyticsManager — Persistent DuckDB analytics engine with sqlite_scanner
 *
 * Manages a persistent DuckDB database file for analytical queries and PG-compatible
 * SQL execution. Uses sqlite_scanner to read SQLite shard files on-demand, providing
 * strong consistency without data duplication.
 *
 * Two access patterns:
 *   1. sqlite_scanner ATTACH — Attach SQLite shard files as virtual tables
 *   2. Direct DuckDB tables — For cached/transformed analytics data
 *
 * Gracefully degrades when DuckDB native binary or sqlite_scanner extension
 * is unavailable (e.g., in test/CI environments without compiled binaries).
 *
 * @emits `available` — true when DuckDB + sqlite_scanner initialized successfully
 */

import duckdb from 'duckdb';
import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('DuckDBAnalytics');
const SQLITE_SCANNER_EXT = 'sqlite_scanner';

export interface DuckDBColumn {
  name: string;
  type: string;
}

export interface DuckDBRow {
  [column: string]: any;
}

export interface DuckDBResult {
  columns: DuckDBColumn[];
  rows: DuckDBRow[];
  rowCount: number;
}

export type DuckDBAvailability = 'unavailable' | 'available' | 'no-scanner';

export class DuckDBAnalyticsManager {
  private db: duckdb.Database | null = null;
  private conn: duckdb.Connection | null = null;
  private _availability: DuckDBAvailability = 'unavailable';
  private primarySchema: string | null = null;
  private readonly dbPath: string;
  private attachedShards: Map<number, string> = new Map();

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  // ──────────────────────────────────────────────
  //  Lifecycle
  // ──────────────────────────────────────────────

  /**
   * Initialize DuckDB database and load sqlite_scanner extension.
   * Opens a persistent file-based database (not :memory:) so analytics data
   * survives restarts.
   */
  async init(): Promise<void> {
    // Step 1: Open DuckDB database (native binary required)
    try {
      this.db = new duckdb.Database(this.dbPath);
      this.conn = this.db.connect();
      logger.debug({ dbPath: this.dbPath }, 'DuckDB persistent database opened');
    } catch (err: any) {
      logger.warn({ err: err.message }, '[DuckDBAnalytics] DuckDB native binary unavailable');
      this._availability = 'unavailable';
      return;
    }

    // Step 2: Load sqlite_scanner extension for SQLite shard ATTACH support.
    // If loading fails (e.g., extension not compiled for this platform, or
    // database file state conflicts), fall back to 'no-scanner' mode where
    // shard ATTACH is unavailable but native DuckDB queries still work.
    try {
      await this.execSQL('LOAD sqlite_scanner');
      this._availability = 'available';
      logger.debug('[DuckDBAnalytics] Initialized (sqlite_scanner loaded)');
    } catch (err: any) {
      this._availability = 'no-scanner';
      logger.warn({ err: err.message }, '[DuckDBAnalytics] sqlite_scanner unavailable, shard ATTACH deferred');
    }
  }

  /**
   * Close DuckDB connection and database.
   */
  async close(): Promise<void> {
    if (this.conn) {
      try { this.conn.close(); } catch { /* ignore */ }
      this.conn = null;
    }
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
    this._availability = 'unavailable';
    logger.debug('[DuckDBAnalytics] Closed');
  }

  // ──────────────────────────────────────────────
  //  Shard Management
  // ──────────────────────────────────────────────

  /**
   * Attach a SQLite shard file as a virtual table in DuckDB using sqlite_scanner.
   * Once attached, tables in the shard are queryable via `shard_N.table_name`.
   *
   * @param shardId  Shard identifier
   * @param dbPath   Absolute path to the SQLite shard file
   */
  async attachShard(shardId: number, dbPath: string): Promise<void> {
    if (this._availability !== 'available') return;
    if (this.attachedShards.has(shardId)) return;

    try {
      const attachName = `shard_${shardId}`;
      await this.execSQL(`ATTACH '${dbPath.replace(/'/g, "''")}' AS ${attachName} (TYPE SQLITE)`);
      this.attachedShards.set(shardId, dbPath);
      // Set primary schema so unqualified table names resolve to this shard
      if (!this.primarySchema) {
        this.primarySchema = attachName;
        await this.execSQL(`SET schema = ${attachName}`);
      }
      logger.debug({ shardId, attachName }, 'Shard attached to DuckDB');
    } catch (err: any) {
      logger.warn({ shardId, err: err.message }, 'Failed to attach shard to DuckDB');
    }
  }

  /**
   * Detach a previously attached shard.
   */
  async detachShard(shardId: number): Promise<void> {
    if (!this.attachedShards.has(shardId)) return;
    try {
      await this.execSQL(`DETACH shard_${shardId}`);
      this.attachedShards.delete(shardId);
    } catch (err: any) {
      logger.warn({ shardId, err: err.message }, 'Failed to detach shard');
    }
  }

  /**
   * Re-attach all previously attached shards (useful after reopen).
   */
  async reattachAll(): Promise<void> {
    const shards = [...this.attachedShards.entries()];
    this.attachedShards.clear();
    for (const [shardId, dbPath] of shards) {
      await this.attachShard(shardId, dbPath);
    }
  }

  // ──────────────────────────────────────────────
  //  Query Execution
  // ──────────────────────────────────────────────

  /**
   * Execute an analytical SQL query against DuckDB.
   * Queries can reference attached SQLite shards (`shard_N.table`) or
   * DuckDB-native tables.
   *
   * @returns DuckDBResult with typed columns and row data
   */
  async execute(sql: string): Promise<DuckDBResult> {
    this.ensureReady();

    // Ensure schema is set for unqualified table references
    if (this.primarySchema) {
      await this.execSQL(`SET schema = ${this.primarySchema}`);
    }

    return new Promise<DuckDBResult>((resolve, reject) => {
      const startMs = Date.now();
      this.conn!.all(sql, (err: any, rows: any[]) => {
        const elapsed = Date.now() - startMs;
        if (err) {
          logger.error({ err: err.message, sql: sql.substring(0, 60), elapsedMs: elapsed }, '[DuckDBAnalytics] Query failed');
          reject(new Error(`DuckDB query failed: ${err.message}`));
          return;
        }
        logger.info({ sql: sql.substring(0, 60), elapsedMs: elapsed, rows: (rows || []).length }, '[DuckDBAnalytics] Query ok');
        const rowData = (rows || []) as DuckDBRow[];
        resolve({
          columns: rowData.length > 0
            ? Object.keys(rowData[0]).map(name => ({ name, type: typeof rowData[0][name] }))
            : [],
          rows: rowData,
          rowCount: rowData.length,
        });
      });
    });
  }

  /**
   * Execute a query and return raw array of rows (for internal use).
   */
  async queryRaw(sql: string): Promise<any[]> {
    this.ensureReady();
    return new Promise<any[]>((resolve, reject) => {
      this.conn!.all(sql, (err: any, rows: any[]) => {
        if (err) reject(new Error(`DuckDB query failed: ${err.message}`));
        else resolve(rows || []);
      });
    });
  }

  // ──────────────────────────────────────────────
  //  Metadata
  // ──────────────────────────────────────────────

  /**
   * List all tables visible in DuckDB (including attached shards).
   */
  async listTables(): Promise<string[]> {
    if (this._availability === 'unavailable') return [];
    try {
      const rows = await this.queryRaw(
        "SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_type = 'BASE TABLE' OR table_type = 'VIEW'"
      );
      return rows.map((r: any) => r.name);
    } catch {
      return [];
    }
  }

  /**
   * Get the DuckDB version string.
   */
  async getVersion(): Promise<string> {
    if (this._availability === 'unavailable') return 'unavailable';
    try {
      const rows = await this.queryRaw('SELECT version() AS v');
      return rows[0]?.v || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // ──────────────────────────────────────────────
  //  Status
  // ──────────────────────────────────────────────

  get availability(): DuckDBAvailability {
    return this._availability;
  }

  get isAvailable(): boolean {
    return this._availability !== 'unavailable';
  }

  get hasScanner(): boolean {
    return this._availability === 'available';
  }

  get attachedShardIds(): number[] {
    return [...this.attachedShards.keys()];
  }

  // ──────────────────────────────────────────────
  //  Memory Management
  // ──────────────────────────────────────────────

  /**
   * Set DuckDB memory limit to constrain heap usage.
   * @param limitMb  Memory limit in megabytes (default 2048)
   */
  async setMemoryLimit(limitMb: number = 2048): Promise<void> {
    this.ensureReady();
    await this.execSQL(`SET memory_limit = '${limitMb}mb'`);
    logger.debug({ limitMb }, 'DuckDB memory limit set');
  }

  // ──────────────────────────────────────────────
  //  Raw SQL Execution (expanded access for internal components)
  // ──────────────────────────────────────────────

  /**
   * Execute a raw SQL string (DDL or DML) on DuckDB.
   * Used by OLAPSchemaManager and DataBridge for columnar table management.
   * Throws on error; caller is responsible for try/catch.
   */
  async execRaw(sql: string): Promise<void> {
    this.ensureReady();
    return new Promise<void>((resolve, reject) => {
      this.conn!.exec(sql, (err: any) => {
        if (err) reject(new Error(`DuckDB execRaw failed: ${err.message}`));
        else resolve();
      });
    });
  }

  // ──────────────────────────────────────────────
  //  OLAP Columnar Table Writes
  // ──────────────────────────────────────────────

  /**
   * Append rows to a columnar table (used by DataBridge for incremental CDC).
   * Rows are batch-inserted in a single statement for efficiency.
   */
  async appendToOLAPTable(tableName: string, rows: any[]): Promise<void> {
    if (rows.length === 0) return;
    this.ensureReady();

    const cols = Object.keys(rows[0]);
    const colList = cols.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
    const placeholders = rows.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');

    // Use prepared statement for batch insert
    const stmt = this.conn!.prepare(
      `INSERT INTO "${tableName.replace(/"/g, '""')}" (${colList}) VALUES ${placeholders}`,
    );
    const flatValues: any[] = [];
    for (const row of rows) {
      for (const col of cols) {
        flatValues.push(row[col] ?? null);
      }
    }

    return new Promise<void>((resolve, reject) => {
      stmt.run(...flatValues, (err: any) => {
        stmt.finalize();
        if (err) reject(new Error(`DuckDB append failed: ${err.message}`));
        else resolve();
      });
    });
  }

  /**
   * Update rows in a columnar table by rowid (used by DataBridge for UPDATE CDC).
   */
  async updateOLAPTable(tableName: string, setClauses: string[], rowIds: number[]): Promise<void> {
    if (rowIds.length === 0) return;
    this.ensureReady();

    const setStr = setClauses.join(', ');
    const idList = rowIds.join(', ');
    await this.execRaw(
      `UPDATE "${tableName.replace(/"/g, '""')}" SET ${setStr} WHERE rowid IN (${idList})`,
    );
  }

  /**
   * Update rows in a columnar table using primary key columns (Phase 2).
   * Uses column names and values to build a proper WHERE clause,
   * avoiding rowid-based matching which can shift after VACUUM or table rebuild.
   *
   * @param whereCols - Primary key column names (e.g. ['id'])
   * @param whereVals - Corresponding values per row (e.g. [[1], [2], [3]])
   */
  async updateOLAPTableByPK(
    tableName: string,
    setClauses: string[],
    whereCols: string[],
    whereVals: number[][],
  ): Promise<void> {
    if (whereVals.length === 0) return;
    this.ensureReady();

    const setStr = setClauses.join(', ');
    const whereStr = whereVals.map(vals => {
      const conds = vals.map((v, i) => `"${whereCols[i].replace(/"/g, '""')}" = ${v}`);
      return `(${conds.join(' AND ')})`;
    }).join(' OR ');

    await this.execRaw(
      `UPDATE "${tableName.replace(/"/g, '""')}" SET ${setStr} WHERE ${whereStr}`,
    );
  }

  /**
   * Delete rows from a columnar table by rowid (used by DataBridge for DELETE CDC).
   */
  async deleteFromOLAPTable(tableName: string, rowIds: number[]): Promise<void> {
    if (rowIds.length === 0) return;
    this.ensureReady();

    const idList = rowIds.join(', ');
    await this.execRaw(
      `DELETE FROM "${tableName.replace(/"/g, '""')}" WHERE rowid IN (${idList})`,
    );
  }

  /**
   * Delete rows from a columnar table using primary key columns (Phase 2).
   */
  async deleteFromOLAPTableByPK(
    tableName: string,
    whereCols: string[],
    whereVals: number[][],
  ): Promise<void> {
    if (whereVals.length === 0) return;
    this.ensureReady();

    const whereStr = whereVals.map(vals => {
      const conds = vals.map((v, i) => `"${whereCols[i].replace(/"/g, '""')}" = ${v}`);
      return `(${conds.join(' AND ')})`;
    }).join(' OR ');

    await this.execRaw(
      `DELETE FROM "${tableName.replace(/"/g, '""')}" WHERE ${whereStr}`,
    );
  }

  /**
   * Create a temporary table from a result set (used by FederationLayer
   * for merging cross-node query results).
   */
  async createTemporaryTable(name: string, columns: { name: string; type: string }[], rows: any[]): Promise<void> {
    this.ensureReady();

    // Create temp table
    const colDefs = columns.map(c => `"${c.name.replace(/"/g, '""')}" ${c.type}`).join(', ');
    await this.execRaw(`CREATE TEMPORARY TABLE IF NOT EXISTS "${name}" (${colDefs})`);

    // Bulk insert
    await this.appendToOLAPTable(name, rows);
  }

  // ──────────────────────────────────────────────
  //  OLAP Query Execution
  // ──────────────────────────────────────────────

  /**
   * Execute a SELECT on OLAP columnar tables with optional table name rewriting.
   * Rewrites SQLite table names to DuckDB columnar table names via the mapping.
   */
  async executeOnOLAP(sql: string, tableMapping: Map<string, string>): Promise<DuckDBResult> {
    this.ensureReady();
    const rewritten = this.rewriteTableNames(sql, tableMapping);
    return this.execute(rewritten);
  }

  /**
   * Rewrite SQL table names using the provided mapping.
   * e.g., SELECT * FROM lineitem → SELECT * FROM olap_shard_0_lineitem
   */
  private rewriteTableNames(sql: string, tableMapping: Map<string, string>): string {
    let result = sql;
    for (const [sqliteName, duckName] of tableMapping) {
      // Match \bname\b (word boundary) to avoid partial replacements
      const re = new RegExp(`\\b${sqliteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      result = result.replace(re, duckName);
    }
    return result;
  }

  // ──────────────────────────────────────────────
  //  Internal
  // ──────────────────────────────────────────────

  private ensureReady(): void {
    if (!this.db || !this.conn) {
      throw new Error('DuckDBAnalyticsManager not initialized. Call init() first.');
    }
    if (this._availability === 'unavailable') {
      throw new Error('DuckDB native binary not available in this environment');
    }
  }

  // ──────────────────────────────────────────────
  //  P2: Recovery Observability
  // ──────────────────────────────────────────────

  private _recoveryState: {
    isRecovering: boolean;
    tablesRestored: number;
    tablesTotal: number;
    startedAt: number;
  } = {
    isRecovering: false,
    tablesRestored: 0,
    tablesTotal: 0,
    startedAt: 0,
  };

  /** Mark the start of DuckDB recovery from SQLite checkpoints. */
  markRecoveryStart(tablesTotal: number): void {
    this._recoveryState.isRecovering = true;
    this._recoveryState.startedAt = Date.now();
    this._recoveryState.tablesRestored = 0;
    this._recoveryState.tablesTotal = Math.max(1, tablesTotal); // avoid div-by-zero
  }

  /** Update recovery progress. */
  updateRecoveryProgress(tablesDone: number): void {
    this._recoveryState.tablesRestored = tablesDone;
    if (this._recoveryState.tablesRestored >= this._recoveryState.tablesTotal) {
      this._recoveryState.isRecovering = false;
    }
  }

  /** Get current recovery metrics for health endpoint and observability. */
  getRecoveryMetrics(): {
    isAvailable: boolean;
    isRecovering: boolean;
    tablesRestored: number;
    tablesTotal: number;
    recoveryProgress: number;
    estimatedRemainingMs: number;
    recoveryStartedAt: number | null;
  } {
    const progress = this._recoveryState.tablesTotal > 0
      ? Math.min(1, this._recoveryState.tablesRestored / this._recoveryState.tablesTotal)
      : 1.0;
    const elapsed = this._recoveryState.startedAt > 0
      ? Date.now() - this._recoveryState.startedAt
      : 0;
    return {
      isAvailable: this.isAvailable,
      isRecovering: this._recoveryState.isRecovering,
      tablesRestored: this._recoveryState.tablesRestored,
      tablesTotal: this._recoveryState.tablesTotal,
      recoveryProgress: progress,
      estimatedRemainingMs: progress > 0 && progress < 1.0
        ? Math.round((elapsed / progress) * (1 - progress))
        : 0,
      recoveryStartedAt: this._recoveryState.startedAt > 0
        ? this._recoveryState.startedAt
        : null,
    };
  }

  public execSQL(sql: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.conn!.exec(sql, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// ──────────────────────────────────────────────
//  Singleton factory
// ──────────────────────────────────────────────

let defaultInstance: DuckDBAnalyticsManager | null = null;

/**
 * Get or create the singleton DuckDBAnalyticsManager instance.
 */
export function getDuckDBAnalyticsManager(dataDir?: string): DuckDBAnalyticsManager {
  if (!defaultInstance && dataDir) {
    defaultInstance = new DuckDBAnalyticsManager(
      require('path').join(dataDir, 'duckdb_analytics.db')
    );
  }
  if (!defaultInstance) {
    throw new Error('DuckDBAnalyticsManager not initialized. Provide dataDir on first call.');
  }
  return defaultInstance;
}

/**
 * Reset singleton (for testing).
 */
export function resetDuckDBAnalyticsManager(): void {
  if (defaultInstance) {
    defaultInstance.close().catch(() => {});
    defaultInstance = null;
  }
}
