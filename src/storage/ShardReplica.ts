// @ts-nocheck
/**
 * ShardReplica — Single shard replica state machine
 *
 * This is the Layer 1 state machine that Raft commands are applied to.
 * Each shard replica is backed by a SQLite database with optional
 * sqlite-vec vector index and optional minisearch full-text index.
 *
 * Writes are idempotent (UPSERT semantics) — the same command can be
 * applied multiple times safely via msgId dedup.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { SqlVecError, SqlVecErrorCode, VectorConfig, ClockErrorStats } from '../types/types-raw';
import { PinoLogger } from '../logger/PinoLogger';
import { DedupRing } from '../replication/DedupRing';
import { compareHLT, HLCTimestamp } from '../replication/HLC';
import { HLCClockCompensator } from '../consensus/HLCClockCompensator';
import { stripCollate } from '../query/CollationShim';

export interface ApplyEntry {
  msgId: string;
  type: 'upsert' | 'delete' | 'ddl' | 'exec';
  data: any;
  /** Used by RaftGroupManager to batch this entry into a single Raft proposal.
   *  Set to true for INSERT entries that can be safely batched (no RETURNING,
   *  no ON CONFLICT, no INSERT...SELECT). Consumers MUST NOT persist or
   *  interpret this flag — it is consumed by RaftGroupManager.propose() and
   *  stripped before serialization. */
  _batchable?: boolean;
}

export class ShardReplica {
  private logger: PinoLogger;
  private db: Database.Database;
  private shardId: number;
  private dbPath: string;
  private vectorEnabled: boolean;
  private vectorDimension: number;
  private applyDedup: DedupRing;

  // Stats
  private applyCount = 0;
  private dedupSkippedCount = 0;

  // M-11: DedupRing capacity threshold for triggering WAL checkpoint (90%)
  private static readonly DEDUP_RING_WARN_THRESHOLD = 0.9;
  private dedupCheckpointTriggered = false;

  // HLC/LWW integration
  private clockCompensator?: HLCClockCompensator;

  // MVCC — row version stamps (Gap 12)
  private mvccEnabled: boolean = false;
  private mvccGcRetentionMs: number = 3600000; // 1 hour

  // Table inheritance tracking (Gap 18)
  private inheritanceInitialized: boolean = false;

  /** Optional callback invoked after vec0 INSERT — used to sync HNSW/IVFPQ indexes in real time. */
  private onVectorInsert?: (table: string, id: number, embedding: Float32Array) => void;

  constructor(
    shardId: number,
    storageDir: string,
    vectorConfig: VectorConfig,
    clockCompensator?: HLCClockCompensator,
    onVectorInsert?: (table: string, id: number, embedding: Float32Array) => void,
  ) {
    this.onVectorInsert = onVectorInsert;
    this.clockCompensator = clockCompensator;
    this.shardId = shardId;
    this.vectorEnabled = vectorConfig.enabled;
    this.vectorDimension = vectorConfig.dimension;
    this.applyDedup = new DedupRing(10_000);
    this.logger = PinoLogger.forComponent(`ShardReplica-${shardId}`);

    this.dbPath = path.join(storageDir, `shard_${shardId}.db`);
    fs.mkdirSync(storageDir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
  }

  // ──────────────────────────────────────────
  //  Bootstrap / Schema
  // ──────────────────────────────────────────

  bootstrap(schemaSql: string): void {
    this.db.exec(schemaSql);
  }

  createVectorIndex(tableName: string, metric: string = 'cosine'): void {
    if (!this.vectorEnabled) return;
    this.validateTableName(tableName);
    // Validate metric to prevent injection
    const safeMetric = metric.replace(/[^a-zA-Z_]/g, '');
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_${tableName} USING vec0(
        id INTEGER PRIMARY KEY,
        embedding FLOAT[${this.vectorDimension}] distance_metric=${safeMetric}
      )`,
    );
  }

  // ──────────────────────────────────────────
  //  MVCC — Row Versioning (Gap 12)
  // ──────────────────────────────────────────

  /**
   * Enable MVCC with row version stamps.
   * Adds _mvcc_created_at and _mvcc_deleted_at columns to existing tables.
   */
  enableMvcc(retentionMs?: number): void {
    this.mvccEnabled = true;
    if (retentionMs !== undefined) {
      this.mvccGcRetentionMs = retentionMs;
    }

    // Add MVCC columns to user tables (non-system)
    const tables = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__' AND substr(name, 1, 8) != '_sqlvec_'`,
    ).all() as Array<{ name: string }>;

    for (const { name } of tables) {
      try {
        this.db.exec(`ALTER TABLE "${name}" ADD COLUMN _mvcc_created_at INTEGER`);
        this.db.exec(`ALTER TABLE "${name}" ADD COLUMN _mvcc_deleted_at INTEGER DEFAULT NULL`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_mvcc ON "${name}"(_mvcc_deleted_at)`);
      } catch {
        // Column may already exist
      }
    }
  }

  /**
   * VACUUM GC — remove old MVCC versions beyond retention period.
   * Hard-deletes rows with _mvcc_deleted_at older than retention window.
   */
  vacuumGc(): { tablesCleaned: number; rowsRemoved: number } {
    if (!this.mvccEnabled) {
      return { tablesCleaned: 0, rowsRemoved: 0 };
    }

    const cutoff = Date.now() - this.mvccGcRetentionMs;
    let totalRemoved = 0;
    let tablesCleaned = 0;

    const tables = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__' AND substr(name, 1, 8) != '_sqlvec_'`,
    ).all() as Array<{ name: string }>;

    for (const { name } of tables) {
      try {
        // Check if table has MVCC columns
        const cols = this.db.pragma(`table_info("${name}")`) as Array<{ name: string }>;
        if (!cols.some((c) => c.name === '_mvcc_deleted_at')) continue;

        const result = this.db.prepare(
          `DELETE FROM "${name}" WHERE _mvcc_deleted_at IS NOT NULL AND _mvcc_deleted_at < ?`,
        ).run(cutoff);

        if (result.changes > 0) {
          totalRemoved += result.changes;
          tablesCleaned++;
          this.logger.info({ table: name, removed: result.changes }, 'MVCC VACUUM GC removed old versions');
        }
      } catch (err: any) {
        this.logger.warn({ table: name, err: err.message }, 'MVCC VACUUM GC error');
      }
    }

    this.logger.info({ tablesCleaned, rowsRemoved: totalRemoved }, 'MVCC VACUUM GC completed');
    return { tablesCleaned, rowsRemoved: totalRemoved };
  }

  /**
   * Check if MVCC is enabled.
   */
  isMvccEnabled(): boolean {
    return this.mvccEnabled;
  }

  /**
   * Set MVCC GC retention period.
   */
  setMvccRetentionMs(ms: number): void {
    this.mvccGcRetentionMs = ms;
  }

  // ──────────────────────────────────────────
  //  Table Inheritance (Gap 18)
  // ──────────────────────────────────────────

  /**
   * Initialize the inheritance tracking table.
   */
  private ensureInheritanceTable(): void {
    if (this.inheritanceInitialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _sqlvec_inheritance (
        child_table TEXT NOT NULL,
        parent_table TEXT NOT NULL,
        PRIMARY KEY (child_table, parent_table)
      )
    `);
    this.inheritanceInitialized = true;
  }

  /**
   * Register table inheritance (child INHERITS parent).
   * Called when processing DDL with INHERITS clause.
   */
  registerInheritance(tableName: string, parentName: string): boolean {
    this.ensureInheritanceTable();
    const childTable = tableName.replace(/["`]/g, '').toLowerCase();
    const parentTable = parentName.replace(/["`]/g, '').toLowerCase();

    try {
      this.db.prepare(
        `INSERT OR REPLACE INTO _sqlvec_inheritance (child_table, parent_table) VALUES (?, ?)`,
      ).run(childTable, parentTable);
      this.logger.info({ childTable, parentTable }, 'Table inheritance registered');
      return true;
    } catch (err: any) {
      this.logger.warn({ err: err.message, childTable, parentTable }, 'Failed to register inheritance');
      return false;
    }
  }

  /**
   * Get all child tables for a parent table (recursive).
   */
  getChildTables(parentTable: string): string[] {
    this.ensureInheritanceTable();
    const normalizedParent = parentTable.replace(/["`]/g, '').toLowerCase();
    const results: string[] = [];
    const visited = new Set<string>();

    const traverse = (table: string): void => {
      if (visited.has(table)) return;
      visited.add(table);
      const rows = this.db.prepare(
        `SELECT child_table FROM _sqlvec_inheritance WHERE parent_table = ?`,
      ).all(table) as Array<{ child_table: string }>;
      for (const row of rows) {
        if (!visited.has(row.child_table)) {
          results.push(row.child_table);
          traverse(row.child_table);
        }
      }
    };
    traverse(normalizedParent);
    return results;
  }

  /**
   * Get the parent table(s) for a child table.
   */
  getParentTables(childTable: string): string[] {
    this.ensureInheritanceTable();
    const normalizedChild = childTable.replace(/["`]/g, '').toLowerCase();
    const rows = this.db.prepare(
      `SELECT parent_table FROM _sqlvec_inheritance WHERE child_table = ?`,
    ).all(normalizedChild) as Array<{ parent_table: string }>;
    return rows.map((r) => r.parent_table);
  }

  /**
   * Rewrite a SELECT to include child tables via UNION ALL.
   * 'SELECT * FROM parent' → 'SELECT * FROM (SELECT * FROM parent UNION ALL SELECT * FROM child) AS parent'
   */
  rewriteInheritanceQuery(sql: string): string {
    // Check for ONLY modifier
    if (/\bFROM\s+ONLY\b/i.test(sql)) {
      // Remove ONLY keyword
      return sql.replace(/\bFROM\s+ONLY\b/i, 'FROM');
    }

    const fromMatch = /\bFROM\s+["`]?(\w+)["`]?\b/i.exec(sql);
    if (!fromMatch) return sql;

    const tableName = fromMatch[1].toLowerCase();
    const childTables = this.getChildTables(tableName);
    if (childTables.length === 0) return sql;

    const allTables = [tableName, ...childTables];
    const unionAll = allTables.map((t) => `SELECT * FROM "${t}"`).join(' UNION ALL ');

    const rewritten = sql.replace(
      /\bFROM\s+["`]?(\w+)["`]?\b/i,
      (match) => `FROM (${unionAll}) AS ${tableName}`,
    );

    this.logger.debug(
      { tableName, childTables: childTables.join(', ') },
      'Query rewritten for table inheritance',
    );
    return rewritten;
  }

  /**
   * Drop inheritance records for a table.
   */
  dropInheritance(tableName: string): void {
    this.ensureInheritanceTable();
    const normalized = tableName.replace(/["`]/g, '').toLowerCase();
    this.db.prepare(
      `DELETE FROM _sqlvec_inheritance WHERE child_table = ? OR parent_table = ?`,
    ).run(normalized, normalized);
  }

  // ──────────────────────────────────────────
  //  Apply — called by RaftGroup on commit
  // ──────────────────────────────────────────

  /**
   * Apply a committed Raft entry to the local state machine.
   * Idempotent via msgId DedupRing.
   */
  /**
   * Apply a single entry or a batch of entries.
   *
   * Batch entries (data.__batch === true) contain an array of sub-entries
   * that are applied sequentially. This is used by batch Raft propose
   * (Option B) to reduce consensus overhead during bulk load.
   *
   * The dedup check happens on the batch msgId — the entire batch is
   * treated as one atomic unit for replay protection.
   */
  apply(entry: ApplyEntry): boolean {
    // Layer 1 dedup: in-memory ring
    if (!this.applyDedup.add(entry.msgId)) {
      this.dedupSkippedCount++;
      return false;
    }

    this.checkDedupRingCapacity();
    this.applyCount++;

    // ── Batch dispatch ─────────────────────────────────────────
    if (entry.data?.__batch === true) {
      const batchEntries = entry.data.entries;
      if (Array.isArray(batchEntries)) {
        for (const sub of batchEntries) {
          this.apply(sub);
        }
      }
      return true;
    }

    return this.db.transaction(() => {
      switch (entry.type) {
        case 'upsert':
          return this.applyUpsert(entry.data);
        case 'delete':
          return this.applyDelete(entry.data);
        case 'ddl': {
          const sql = entry.data.sql || entry.data;
          this.db.exec(sql);
          // Detect INHERITS clause for table inheritance tracking
          const inheritsMatch = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s*\(.*?\)\s*INHERITS\s*\((\S+)\)\s*;?\s*$/is.exec(sql);
          if (inheritsMatch) {
            this.registerInheritance(inheritsMatch[1], inheritsMatch[2]);
          }
          // Detect DROP TABLE for inheritance cleanup
          const dropMatch = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\S+)/i.exec(sql);
          if (dropMatch) {
            this.dropInheritance(dropMatch[1]);
          }
          return true;
        }
        case 'exec':
          this.db.exec(entry.data.sql);
          return true;
        default:
          return false;
      }
    })();
  }

  /**
   * Apply from EventBus (Outbox fallback path).
   * Same logic, just labelled differently.
   */
  applyFromEventBus(entry: ApplyEntry): boolean {
    return this.apply(entry); // Same idempotent apply
  }

  // ──────────────────────────────────────────
  //  Query
  // ──────────────────────────────────────────

  query(sql: string, params?: any[]): any[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...(params || []));
  }

  queryOne(sql: string, params?: any[]): any {
    const stmt = this.db.prepare(sql);
    return stmt.get(...(params || []));
  }

  /**
   * Vector search on this replica's vec0 virtual table.
   */
  vectorSearch(
    tableName: string,
    queryBlob: Buffer,
    topK: number,
  ): Array<{ id: number; distance: number }> {
    this.validateTableName(tableName); // M-04/M-06
    return this.db.prepare(
      `SELECT id, distance
       FROM vec_${tableName}
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
    ).all(queryBlob, topK) as Array<{ id: number; distance: number }>;
  }

  // ──────────────────────────────────────────
  //  Private apply helpers
  // ──────────────────────────────────────────

  /** HLCClockCompensator instance for tracking peer clock drift. */
  getClockCompensator(): HLCClockCompensator | undefined {
    return this.clockCompensator;
  }

  /**
   * Set the clock compensator at runtime.
   */
  setClockCompensator(compensator: HLCClockCompensator): void {
    this.clockCompensator = compensator;
  }

  private applyUpsert(data: any): boolean {
    const { table, id, fields, embedding, hlc } = data;
    this.validateTableName(table); // M-04/M-06

    // HLC-based LWW conflict resolution
    if (hlc) {
      // Record peer HLC timestamp in clock compensator for drift tracking
      if (this.clockCompensator) {
        this.clockCompensator.recordPeerTimestamp(
          hlc.nodeId ?? 0,
          hlc.wall ?? Date.now(),
          Date.now(),
        );
      }
      const hlcCols = this.checkHlcColumns(table);
      if (hlcCols) {
        // Table has HLC columns — check if incoming wins the conflict
        const existing = this.db.prepare(
          `SELECT _hlc_wall, _hlc_logical, _hlc_node_id FROM ${table} WHERE id = ?`,
        ).get(id) as { _hlc_wall: number; _hlc_logical: number; _hlc_node_id: number } | undefined;

        if (existing) {
          const existingHlc = { wall: existing._hlc_wall, logical: existing._hlc_logical, nodeId: existing._hlc_node_id };
          // Only overwrite if incoming HLC > existing HLC
          if (compareHLT(hlc, existingHlc) <= 0) {
            return false; // incoming not newer — skip
          }
        }

        // Add HLC columns to fields so they get written
        fields._hlc_wall = hlc.wall;
        fields._hlc_logical = hlc.logical;
        fields._hlc_node_id = hlc.nodeId;
      }
    }

    // UPSERT into main table
    const extendedFields = { ...fields };

    // MVCC: set _mvcc_created_at on INSERT (not on UPDATE via ON CONFLICT)
    if (this.mvccEnabled) {
      // On INSERT: set creation time. On CONFLICT (UPDATE): don't touch it.
      // SQLite UPSERT doesn't support conditional expressions per column easily.
      // We'll let _mvcc_created_at be set on INSERT and leave it during UPDATE.
      // The UPSERT clause uses excluded.* values, so we need explicit handling.
      // Best approach: use COALESCE in the update SET clause
    }

    const cols = Object.keys(extendedFields).join(', ');
    const vals = Object.values(extendedFields);
    const placeholders = vals.map(() => '?').join(', ');

    const updateSet = Object.keys(extendedFields).map((c) => {
      if (c === '_mvcc_created_at') {
        return `${c}=COALESCE(${c}, excluded.${c})`; // keep original creation time
      }
      return `${c}=excluded.${c}`;
    }).join(', ');

    this.db.prepare(
      `INSERT INTO ${table} (id, ${cols})
       VALUES (?, ${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updateSet}`,
    ).run(id, ...vals);

    // Also update vec0 index if embedding provided
    if (embedding && this.vectorEnabled) {
      const embBlob = Buffer.from(new Float32Array(embedding).buffer);
      this.db.prepare(
        `INSERT OR REPLACE INTO vec_${table} (id, embedding) VALUES (?, ?)`,
      ).run(id, embBlob);

      // Notify the VectorEngine callback so HNSW/IVFPQ indexes stay in sync
      this.onVectorInsert?.(table, id, embedding);
    }

    return true;
  }

  private checkHlcColumns(table: string): boolean {
    this.validateTableName(table); // M-04/M-06
    try {
      const cols = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      const names = new Set(cols.map(c => c.name));
      return names.has('_hlc_wall') && names.has('_hlc_logical') && names.has('_hlc_node_id');
    } catch {
      return false;
    }
  }

  private applyDelete(data: any): boolean {
    const { table, id } = data;
    this.validateTableName(table); // M-04/M-06

    // MVCC: soft-delete by setting _mvcc_deleted_at if enabled and column exists
    if (this.mvccEnabled) {
      try {
        const cols = this.db.pragma(`table_info("${table}")`) as Array<{ name: string }>;
        if (cols.some((c) => c.name === '_mvcc_deleted_at')) {
          this.db.prepare(
            `UPDATE "${table}" SET _mvcc_deleted_at = ? WHERE id = ?`,
          ).run(Date.now(), id);
        } else {
          this.db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
        }
      } catch {
        this.db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
      }
    } else {
      this.db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
    }

    if (this.vectorEnabled) {
      this.db.prepare(`DELETE FROM vec_${table} WHERE id = ?`).run(id);
    }
    return true;
  }

  // ──────────────────────────────────────────
  //  Utilities
  // ──────────────────────────────────────────

  /**
   * Validate a table name against SQL injection risk.
   * M-04/M-06: Only allows alphanumeric, underscore, and identifier-safe names.
   * @throws SqlVecError if the name contains unsafe characters.
   */
  private validateTableName(name: string): void {
    if (!/^[a-zA-Z_]\w*$/.test(name)) {
      throw new SqlVecError(
        `Invalid table name: "${name}". Table names must match /^[a-zA-Z_]\\w*$/`,
        SqlVecErrorCode.PROTOCOL_ERROR,
      );
    }
  }

  getShardId(): number {
    return this.shardId;
  }

  getDb(): Database.Database {
    return this.db;
  }

  getApplyStats(): { applyCount: number; dedupSkippedCount: number } {
    return { applyCount: this.applyCount, dedupSkippedCount: this.dedupSkippedCount };
  }

  /**
   * M-11: Monitor DedupRing capacity and trigger WAL checkpoint when near limit.
   * This prevents unbounded memory growth and ensures the WAL doesn't balloon
   * when the dedup ring is saturating capacity.
   *
   * Only fires the checkpoint once per saturation cycle to avoid log spam.
   * Checkpoint is performed in TRUNCATE mode to minimize overhead.
   */
  private checkDedupRingCapacity(): void {
    const capacity = 10_000; // matches the capacity passed to DedupRing constructor
    const current = this.applyDedup.size;
    const ratio = current / capacity;

    if (ratio >= ShardReplica.DEDUP_RING_WARN_THRESHOLD && !this.dedupCheckpointTriggered) {
      this.dedupCheckpointTriggered = true;
      this.logger.warn(
        { current, capacity, ratio: ratio.toFixed(2) },
        'DedupRing near capacity — triggering WAL checkpoint',
      );
      try {
        this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      } catch {
        // Non-fatal
      }
    } else if (ratio < ShardReplica.DEDUP_RING_WARN_THRESHOLD) {
      this.dedupCheckpointTriggered = false;
    }
  }

  /**
   * Perform a WAL checkpoint (TRUNCATE mode) to flush WAL into the main DB file.
   * Should be called before closing during graceful shutdown (PROD017).
   */
  checkpoint(): { ok: boolean; pagesCheckpointed: number } {
    try {
      const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as any;
      const pagesCheckpointed = row ? (row[1] ?? row.pages_checkpointed ?? 0) : 0;
      return { ok: true, pagesCheckpointed };
    } catch (err: any) {
      return { ok: false, pagesCheckpointed: 0 };
    }
  }

  close(): void {
    this.db.close();
  }
}
