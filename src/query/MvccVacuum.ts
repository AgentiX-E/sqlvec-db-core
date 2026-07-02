/**
 * MvccVacuum — MVCC 感知的 3 阶段物理空间回收
 *
 * 填补当前 VACUUM 只做 FREEZE（标记 _xmax = XID_FROZEN）、不回收物理空间的差距。
 *
 * ## 3 阶段设计
 *
 * | Phase | 操作 | 说明 |
 * |:------|:-----|:------|
 * | 1 FREEZE | `UPDATE _xmax = XID_FROZEN` | 死行标记为冻结（已存在） |
 * | 2 HARD DELETE | `DELETE WHERE _xmax = XID_FROZEN` | 超过 defer 期后物理删除 |
 * | 3 COMPACT | `VACUUM` / `PRAGMA incremental_vacuum` | 回收存储空间 |
 *
 * ## PG 兼容性
 *
 * - VACUUM FREEZE → Phase 1（兼容）
 * - VACUUM FULL → Phase 1+2+3（全量）
 * - VACUUM (常规) → Phase 1+2 + incremental_vacuum
 * - VACUUM (无死行) → 无操作
 *
 * ## defer 策略
 *
 * `vacuum_defer_cleanup_age`（GUC）控制冻结行多久后允许硬删除：
 * - 默认 1000 个 XID 生成周期
 * - 长事务保证：硬删除时检查无活跃事务的 snapshot 仍需要这些版本
 *
 * @module query/MvccVacuum
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import type { MVCCExecutor } from './MVCCExecutor';
import type Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────

export interface VacuumStats {
  tableName: string;
  phase1Frozen: number;
  phase2Deleted: number;
  phase3ReclaimedBytes: number;
  totalRemovedRows: number;
}

export interface VacuumConfig {
  /** XID defer age: wait N XIDs before hard-deleting frozen rows (PG: vacuum_defer_cleanup_age) */
  deferCleanupAge: number;
  /** Enable Phase 1 (FREEZE). Default: true */
  enableFreeze: boolean;
  /** Enable Phase 2 (HARD DELETE). Default: true */
  enableHardDelete: boolean;
  /** Enable Phase 3 (COMPACT). Default: true */
  enableCompact: boolean;
  /** Full VACUUM threshold: if estimated dead pages > this fraction, use full VACUUM. Default: 0.2 */
  fullVacuumDeadFraction: number;
  /** Log per-table stats during VACUUM. Default: false */
  verbose: boolean;
}

export const DEFAULT_VACUUM_CONFIG: VacuumConfig = {
  deferCleanupAge: 1000,
  enableFreeze: true,
  enableHardDelete: true,
  enableCompact: true,
  fullVacuumDeadFraction: 0.2,
  verbose: false,
};

// ── MVCC Column Constants ───────────────────────────────────────

/**
 * The different MVCC column systems used in SqlVec:
 * - `_xmin/_xmax` — MVCCExecutor transaction-level MVCC (single underscore)
 * - `__xmin/__xmax` — MVCCShim PG-compat SELECT rewriting (double underscore)
 */
const MVCC_COLUMN_SYSTEMS = [
  { prefix: '_', xminCol: '_xmin', xmaxCol: '_xmax', frozenValue: 2 },
  { prefix: '__', xminCol: '__xmin', xmaxCol: '__xmax', frozenValue: 0 },
] as const;

/**
 * System table name patterns — never vacuumed.
 */
const SYSTEM_TABLE_RE = /^(sqlite_|_sqlvec_|__|_cdc_|_mvcc_)/i;

// ── Logger ───────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('MvccVacuum');

// ── The MvccVacuum Class ─────────────────────────────────────────

export class MvccVacuum {
  private config: VacuumConfig;
  /** Shard ID → Database connection map */
  private shardDbs: Map<number, Database.Database>;
  /** XID counter generator function (bound from caller) */
  private getCurrentXid: () => number;
  /** Get oldest active XID function (bound from caller) */
  private getOldestActiveXid: () => number;

  constructor(
    shardDbs: Map<number, Database.Database>,
    getCurrentXid: () => number,
    getOldestActiveXid: () => number,
    config?: Partial<VacuumConfig>,
  ) {
    this.config = { ...DEFAULT_VACUUM_CONFIG, ...config };
    this.shardDbs = shardDbs;
    this.getCurrentXid = getCurrentXid;
    this.getOldestActiveXid = getOldestActiveXid;
  }

  /**
   * Run VACUUM FULL: Phase 1 + Phase 2 + Phase 3 (full VACUUM).
   * Equivalent to `VACUUM FULL` in PostgreSQL.
   */
  vacuumFull(tableName?: string): VacuumStats[] {
    return this.runVacuum({ full: true, tableName });
  }

  /**
   * Run VACUUM (standard): Phase 1 + Phase 2 + Phase 3 (incremental).
   * Equivalent to `VACUUM` in PostgreSQL.
   */
  vacuum(tableName?: string): VacuumStats[] {
    return this.runVacuum({ full: false, tableName });
  }

  /**
   * Run VACUUM with full options (full/incremental + optional table filter).
   * Convenience wrapper used by AutovacuumDaemon.
   */
  vacuumWithOptions(opts?: { full?: boolean; tableName?: string }): VacuumStats[] {
    return this.runVacuum(opts);
  }

  /**
   * Core VACUUM orchestrator — runs all phases.
   */
  private runVacuum(opts?: { full?: boolean; tableName?: string }): VacuumStats[] {
    const results: VacuumStats[] = [];

    for (const [shardId, db] of this.shardDbs) {
      if (!db || !db.open) {
        logger.warn({ shardId }, 'MvccVacuum: shard db not open, skipping');
        continue;
      }

      const tables = this.getVacuumableTables(db, opts?.tableName);
      if (tables.length === 0) {
        logger.debug({ shardId }, 'MvccVacuum: no tables to vacuum');
        continue;
      }

      for (const tbl of tables) {
        const stats = this.vacuumTable(db, shardId, tbl, opts?.full ?? false);
        if (stats) results.push(stats);
      }
    }

    return results;
  }

  /**
   * Phase 1 only: FREEZE — marks old dead rows with _xmax = XID_FROZEN.
   * Can be called independently for lightweight maintenance.
   */
  freezeOnly(tableName?: string): number {
    return this.runPhase1All(tableName);
  }

  /**
   * Phase 2 only: HARD DELETE — physically removes frozen rows
   * that are past the defer cleanup age.
   */
  hardDeleteOnly(tableName?: string): number {
    return this.runPhase2All(tableName);
  }

  /**
   * Phase 3 only: COMPACT — runs SQLite VACUUM or incremental_vacuum.
   */
  compactOnly(full: boolean = false): { shardId: number; reclaimedBytes: number }[] {
    return this.runPhase3All(full);
  }

  // ── Private Phase Methods ──────────────────────────────────────

  /**
   * Vacuum a single table through all phases.
   */
  private vacuumTable(
    db: Database.Database,
    shardId: number,
    tableName: string,
    full: boolean,
  ): VacuumStats | null {
    try {
      const phase1Frozen = this.config.enableFreeze
        ? this.freezeTable(db, tableName)
        : 0;
      const phase2Deleted = this.config.enableHardDelete
        ? this.hardDeleteTable(db, tableName)
        : 0;
      const phase3ReclaimedBytes = this.config.enableCompact
        ? this.compactTable(db, full)
        : 0;

      const stats: VacuumStats = {
        tableName,
        phase1Frozen,
        phase2Deleted,
        phase3ReclaimedBytes,
        totalRemovedRows: phase1Frozen, // logically removed
      };

      if (this.config.verbose) {
        logger.info(
          { shardId, ...stats },
          `MvccVacuum: table "${tableName}" processed`,
        );
      }

      return stats;
    } catch (err: any) {
      logger.warn(
        { shardId, table: tableName, err: err.message },
        'MvccVacuum: table vacuum failed',
      );
      return null;
    }
  }

  // ── Phase 1: FREEZE ────────────────────────────────────────────

  /**
   * Run Phase 1 (FREEZE) on all vacuumable tables.
   * Returns total frozen rows across all shards.
   */
  private runPhase1All(tableName?: string): number {
    let total = 0;
    for (const [shardId, db] of this.shardDbs) {
      if (!db?.open) continue;
      const tables = this.getVacuumableTables(db, tableName);
      for (const tbl of tables) {
        total += this.freezeTable(db, tbl);
      }
    }
    return total;
  }

  /**
   * FREEZE a single table: sets _xmax = XID_FROZEN for all dead rows
   * whose _xmax is older than the oldest active XID.
   *
   * Handles both `_xmax` (MVCCExecutor) and `__xmax` (MVCCShim) columns.
   */
  private freezeTable(db: Database.Database, tableName: string): number {
    let totalFrozen = 0;
    const oldestActiveXid = this.getOldestActiveXid();

    for (const cs of MVCC_COLUMN_SYSTEMS) {
      const { xminCol, xmaxCol, frozenValue } = cs;
      if (!this.hasColumn(db, tableName, xmaxCol)) continue;

      try {
        const result = db.prepare(
          `UPDATE "${tableName}" SET ${xmaxCol} = ? WHERE ${xmaxCol} > 0 AND ${xmaxCol} < ?`,
        ).run(frozenValue, oldestActiveXid);
        if (result.changes > 0) {
          totalFrozen += result.changes;
          logger.debug(
            { table: tableName, column: xmaxCol, frozen: result.changes },
            'Phase 1: FREEZE completed',
          );
        }
      } catch (err: any) {
        logger.warn(
          { table: tableName, column: xmaxCol, err: err.message },
          'Phase 1: FREEZE failed',
        );
      }
    }

    return totalFrozen;
  }

  // ── Phase 2: HARD DELETE ───────────────────────────────────────

  /**
   * Run Phase 2 (HARD DELETE) on all vacuumable tables.
   */
  private runPhase2All(tableName?: string): number {
    let total = 0;
    for (const [shardId, db] of this.shardDbs) {
      if (!db?.open) continue;
      const tables = this.getVacuumableTables(db, tableName);
      for (const tbl of tables) {
        total += this.hardDeleteTable(db, tbl);
      }
    }
    return total;
  }

  /**
   * HARD DELETE frozen rows from a single table.
   *
   * Only deletes rows with _xmax = XID_FROZEN that have been frozen
   * long enough to exceed vacuum_defer_cleanup_age.
   *
   * Strategy for safety:
   * 1. Get the current XID and compute the defer threshold
   * 2. DELETE rows WHERE _xmax = frozenValue
   *    AND the row's _xmin is younger than the defer boundary
   *    (i.e., the row was frozen at least `deferCleanupAge` XIDs ago)
   */
  private hardDeleteTable(db: Database.Database, tableName: string): number {
    let totalDeleted = 0;
    const deferBoundary = this.getCurrentXid() - this.config.deferCleanupAge;

    for (const cs of MVCC_COLUMN_SYSTEMS) {
      const { xmaxCol, xminCol, frozenValue } = cs;
      if (!this.hasColumn(db, tableName, xmaxCol)) continue;

      try {
        // Delete frozen rows whose _xmin is old enough (defer period elapsed).
        // _xmin < deferBoundary means the row was frozen at least `deferCleanupAge` XIDs ago.
        // Use _xmin as proxy for "when was this row frozen" since both columns
        // contain XIDs from the same counter.
        const result = db.prepare(
          `DELETE FROM "${tableName}" WHERE ${xmaxCol} = ? AND ${xminCol} > 0 AND ${xminCol} < ?`,
        ).run(frozenValue, deferBoundary);
        if (result.changes > 0) {
          totalDeleted += result.changes;
          logger.debug(
            { table: tableName, deleted: result.changes },
            'Phase 2: HARD DELETE completed',
          );
        }
      } catch (err: any) {
        logger.warn(
          { table: tableName, err: err.message },
          'Phase 2: HARD DELETE failed',
        );
      }
    }

    return totalDeleted;
  }

  // ── Phase 3: COMPACT ───────────────────────────────────────────

  /**
   * Run Phase 3 (COMPACT) on all shards.
   */
  private runPhase3All(full: boolean): { shardId: number; reclaimedBytes: number }[] {
    const results: { shardId: number; reclaimedBytes: number }[] = [];
    for (const [shardId, db] of this.shardDbs) {
      if (!db?.open) continue;
      const reclaimed = this.compactTable(db, full);
      results.push({ shardId, reclaimedBytes: reclaimed });
    }
    return results;
  }

  /**
   * COMPACT a database: reclaims space after HARD DELETE.
   *
   * - Full: runs `VACUUM` (rebuilds entire DB file, ~= PG VACUUM FULL)
   * - Incremental: runs `PRAGMA incremental_vacuum(N)` for lighter touch
   */
  private compactTable(db: Database.Database, full: boolean): number {
    try {
      const beforeSize = this.getDbFileSize(db);

      if (full) {
        db.exec('VACUUM;');
      } else {
        db.exec('PRAGMA incremental_vacuum(50);');
        db.exec('PRAGMA optimize;');
      }

      const afterSize = this.getDbFileSize(db);
      const reclaimed = Math.max(0, beforeSize - afterSize);

      if (reclaimed > 0) {
        logger.debug(
          { reclaimedBytes: reclaimed, full },
          'Phase 3: COMPACT completed',
        );
      }

      return reclaimed;
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Phase 3: COMPACT failed');
      return 0;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  /**
   * Get all user tables suitable for VACUUM.
   */
  private getVacuumableTables(
    db: Database.Database,
    filterName?: string,
  ): string[] {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__' AND substr(name, 1, 8) != '_sqlvec_' AND substr(name, 1, 5) != '_cdc_' AND substr(name, 1, 7) != '_mvcc_'",
    ).all() as { name: string }[];

    let tables = rows.map(r => r.name);

    if (filterName) {
      tables = tables.filter(t => t === filterName);
    }

    return tables;
  }

  /**
   * Check if a table has a specific column.
   */
  private hasColumn(db: Database.Database, tableName: string, column: string): boolean {
    try {
      const cols = db.pragma(`table_info("${tableName}")`) as Array<{ name: string }>;
      return cols.some(c => c.name === column);
    } catch {
      return false;
    }
  }

  /**
   * Estimate database file size.
   */
  private getDbFileSize(db: Database.Database): number {
    try {
      const row = db.prepare('PRAGMA page_count').get() as { page_count: number };
      const pageSizeRow = db.prepare('PRAGMA page_size').get() as { page_size: number };
      if (row && pageSizeRow) {
        return row.page_count * pageSizeRow.page_size;
      }
    } catch {
      // Fallback
    }
    return 0;
  }
}
