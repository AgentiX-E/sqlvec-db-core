/**
 * ForUpdateExecutor — Apply row-level locks from FOR UPDATE / FOR SHARE
 * clauses to SELECT results using MVCCExecutor or RowLockManager.
 *
 * After SQLite returns the raw SELECT results (with FOR UPDATE clause stripped),
 * this executor acquires locks on the matching rows.
 *
 * Lock semantics (PostgreSQL-compatible):
 *   - FOR UPDATE:          Exclusive write lock (blocks all other FOR UPDATE/SHARE)
 *   - FOR NO KEY UPDATE:   Write lock (doesn't block FOR KEY SHARE)
 *   - FOR SHARE:           Shared read lock (blocks FOR UPDATE, not other SHARE)
 *   - FOR KEY SHARE:       Key-level shared lock (only blocks FOR UPDATE)
 *
 * Row-level lock conflict matrix:
 *   Requested → | FOR UPDATE | NO KEY UPDATE | FOR SHARE | FOR KEY SHARE
 *   Held ↓      |            |               |           |
 *   ────────────|────────────|───────────────|───────────|──────────────
 *   FOR UPDATE  |    ❌      |     ❌        |    ❌     |     ❌
 *   NO KEY UPDATE | ❌      |     ❌        |    ❌     |     ✅
 *   FOR SHARE   |    ❌      |     ❌        |    ✅     |     ✅
 *   FOR KEY SHARE | ❌      |     ✅        |    ✅     |     ✅
 *
 * Error codes:
 *   55P03 — lock_not_available (used for NOWAIT failures)
 *   40P01 — deadlock detected
 *
 * @module query/ForUpdateExecutor
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { RowLockManager, LockMode as RowLockMode } from '../consensus/RowLockManager';
import { MVCCExecutor } from './MVCCExecutor';
import type { ForUpdateClause } from './ForUpdateShim';

const logger = PinoLogger.forComponent('ForUpdateExecutor');

// ── Types ────────────────────────────────────────────────────────

export interface ApplyForUpdateArgs {
  /** Session ID for the executing transaction */
  sessionId: string;
  /** Original SQL (for logging) */
  sql: string;
  /** Row set from the stripped-SELECT execution */
  rows: any[];
  /** The table being locked */
  tableName: string;
  /** Parsed FOR UPDATE clause */
  forUpdate: ForUpdateClause;
  /** Shard ID for the lock */
  shardId?: number;
}

export interface ApplyForUpdateResult {
  /** Filtered row set (SKIP LOCKED may remove rows) */
  rows: any[];
  /** Error information if locking failed */
  error?: { code: string; message: string };
}

// ── Error helper ─────────────────────────────────────────────────

/**
 * Create a lock-not-available error (PostgreSQL error code 55P03).
 */
function lockNotAvailableError(tableName: string, rowId: any): { code: string; message: string } {
  return {
    code: '55P03',
    message: `could not obtain lock on row in relation "${tableName}" (row: ${String(rowId)})`,
  };
}

/**
 * Create a deadlock error (PostgreSQL error code 40P01).
 */
function deadlockDetectedError(tableName: string): { code: string; message: string } {
  return {
    code: '40P01',
    message: `deadlock detected when trying to obtain lock on row in relation "${tableName}"`,
  };
}

// ── Lock mode mapping ────────────────────────────────────────────

/**
 * Determine if a lock strength is a write lock (FOR_UPDATE or FOR_NO_KEY_UPDATE)
 * or a read/shared lock (FOR_SHARE or FOR_KEY_SHARE).
 */
function isWriteLock(forUpdate: ForUpdateClause): boolean {
  return forUpdate.lockStrength === 'UPDATE' || forUpdate.lockStrength === 'NO_KEY_UPDATE';
}

// ── Row ID extraction ────────────────────────────────────────────

/**
 * Extract a numeric row identifier from a result row.
 * Prefers: id > ctid > first column value > index.
 */
function getRowId(row: any, index: number): bigint {
  if (row == null) return BigInt(index);
  if (row.id !== undefined) return BigInt(row.id);
  if (row.ctid !== undefined) return BigInt(row.ctid);
  if (typeof row === 'object') {
    const keys = Object.keys(row);
    if (keys.length > 0) {
      const val = row[keys[0]];
      if (val != null) {
        const num = Number(val);
        if (!isNaN(num)) return BigInt(num);
      }
    }
  }
  return BigInt(index);
}

// ── ForUpdateExecutor ────────────────────────────────────────────

export class ForUpdateExecutor {
  private readonly rowLockManager: RowLockManager | null;
  private readonly mvcc: MVCCExecutor | null;
  private readonly logger = PinoLogger.forComponent('forupdateexecutor');

  constructor(lockManager: RowLockManager | null);
  constructor(lockManager: RowLockManager | null, mvcc: MVCCExecutor | null);
  constructor(lockManager: RowLockManager | null, mvcc?: MVCCExecutor | null);
  constructor(lockManager: RowLockManager | null, mvcc?: MVCCExecutor | null) {
    // Detect if a single argument is actually an MVCCExecutor
    if (lockManager && typeof (lockManager as any).acquireRowWriteLock === 'function') {
      this.rowLockManager = null;
      this.mvcc = lockManager as any as MVCCExecutor;
    } else {
      this.rowLockManager = lockManager;
      this.mvcc = mvcc || null;
    }
  }

  /**
   * Apply row-level locks using MVCCExecutor or RowLockManager.
   *
   * @param args - Arguments for the locking operation.
   * @returns Result with locked (and possibly filtered) rows.
   */
  async applyForUpdate(args: ApplyForUpdateArgs): Promise<ApplyForUpdateResult> {
    const { sessionId, sql: _sql, rows, tableName, forUpdate, shardId = 0 } = args;

    if (rows.length === 0) {
      return { rows };
    }

    // Determine which rows to lock (for OF table restriction)
    const { tables } = forUpdate;
    const shouldLockTable = !tables || tables.length === 0 || tables.some(t => {
      const tUpper = t.toUpperCase().replace(/["`]/g, '');
      const tableUpper = tableName.toUpperCase();
      return tUpper === tableUpper || tUpper.replace(/^ONLY\s+/i, '') === tableUpper;
    });

    if (!shouldLockTable) {
      // OF specifies other tables — skip locking for this table
      return { rows };
    }

    // Collect row IDs (as numbers for MVCCExecutor compatibility)
    const lockedRowIds: bigint[] = rows.map((row, i) => getRowId(row, i));

    this.logger.debug(
      { lockStrength: forUpdate.lockStrength, nowait: forUpdate.nowait, skipLocked: forUpdate.skipLocked, tableName, totalRows: rows.length },
      'Applying row-level locks',
    );

    // Prefer MVCCExecutor lock methods when available
    if (this.mvcc) {
      return this.applyForUpdateViaMvcc(sessionId, tableName, forUpdate, rows, lockedRowIds);
    }

    // Fall back to RowLockManager
    if (this.rowLockManager) {
      return this.applyForUpdateViaRowLockManager(sessionId, tableName, forUpdate, rows, lockedRowIds, shardId);
    }

    // No lock manager available — skip
    this.logger.warn(
      'No lock manager available — row-level locking is not applied. ' +
      'FOR UPDATE clause was stripped but locks were not acquired.',
    );
    return { rows };
  }

  /**
   * Apply locks using MVCCExecutor's acquireRowWriteLock / acquireRowShareLock.
   */
  private async applyForUpdateViaMvcc(
    sessionId: string,
    tableName: string,
    forUpdate: ForUpdateClause,
    rows: any[],
    lockedRowIds: bigint[],
  ): Promise<ApplyForUpdateResult> {
    const isWrite = isWriteLock(forUpdate);
    const lockedIndices: number[] = [];
    const skippedIndices: number[] = [];

    for (let i = 0; i < lockedRowIds.length; i++) {
      const rowIdNum = Number(lockedRowIds[i]);

      let acquired: boolean;
      if (isWrite) {
        const result = this.mvcc!.acquireRowWriteLock(sessionId, tableName, rowIdNum);
        acquired = result === true;
        if (result === 'deadlocked') {
          return {
            rows: [],
            error: deadlockDetectedError(tableName),
          };
        }
      } else {
        acquired = this.mvcc!.acquireRowShareLock(sessionId, tableName, rowIdNum);
      }

      if (acquired) {
        lockedIndices.push(i);
      } else {
        if (forUpdate.nowait) {
          // NOWAIT: fail immediately on first contention
          return {
            rows: [],
            error: lockNotAvailableError(tableName, rowIdNum),
          };
        }
        skippedIndices.push(i);
      }
    }

    // If SKIP LOCKED, filter out rows we couldn't lock
    if (forUpdate.skipLocked && skippedIndices.length > 0) {
      const lockedSet = new Set(lockedIndices);
      const filteredRows = rows.filter((_, idx) => lockedSet.has(idx));
      return { rows: filteredRows };
    }

    // If we had contention without SKIP LOCKED or NOWAIT, return error
    if (skippedIndices.length > 0) {
      return {
        rows: [],
        error: lockNotAvailableError(tableName, Number(lockedRowIds[skippedIndices[0]])),
      };
    }

    return { rows };
  }

  /**
   * Apply locks using RowLockManager's acquireLocks.
   */
  private async applyForUpdateViaRowLockManager(
    sessionId: string,
    tableName: string,
    forUpdate: ForUpdateClause,
    rows: any[],
    lockedRowIds: bigint[],
    shardId: number,
  ): Promise<ApplyForUpdateResult> {
    const mode = this.toRowLockModeForRM(forUpdate);

    this.logger.debug(
      { lockStrength: forUpdate.lockStrength, nowait: forUpdate.nowait, skipLocked: forUpdate.skipLocked, tableName, totalRows: rows.length },
      'Applying row-level locks via RowLockManager',
    );

    try {
      const grant = await this.rowLockManager!.acquireLocks({
        sessionId,
        shardId,
        tableName,
        rowIds: lockedRowIds,
        mode,
        nowait: forUpdate.nowait,
        skipLocked: forUpdate.skipLocked,
        timeoutMs: 10000,
      });

      if (grant.granted || grant.rowIds.length > 0) {
        this.logger.debug(
          { lockedCount: grant.rowIds.length, skippedCount: grant.skipped.length },
          'Row-level locking complete',
        );

        let filteredRows = rows;
        if (forUpdate.skipLocked && grant.skipped.length > 0) {
          const lockedSet = new Set(grant.rowIds.map(id => id.toString()));
          filteredRows = rows.filter((_, idx) => {
            const rowId = getRowId(rows[idx], idx);
            return lockedSet.has(rowId.toString());
          });
        }

        return { rows: filteredRows };
      }

      if (forUpdate.nowait && grant.skipped.length > 0) {
        return {
          rows: [],
          error: lockNotAvailableError(tableName, lockedRowIds[0]),
        };
      }

      return { rows };
    } catch (err: any) {
      if (err.code === 'DeadlockDetected' || (err.message && err.message.includes('Deadlock'))) {
        this.logger.warn({ tableName, sessionId }, 'Deadlock detected during row lock acquisition');
        return {
          rows: [],
          error: deadlockDetectedError(tableName),
        };
      }

      this.logger.error({ error: err.message, tableName }, 'RowLockManager.acquireLocks threw unexpected error');
      return { rows };
    }
  }

  /**
   * Map ForUpdateClause lock strength to RowLockManager LockMode.
   */
  private toRowLockModeForRM(forUpdate: ForUpdateClause): RowLockMode {
    switch (forUpdate.lockStrength) {
      case 'UPDATE':
        return 'FOR_UPDATE';
      case 'NO_KEY_UPDATE':
        return 'FOR_NO_KEY_UPDATE';
      case 'SHARE':
        return 'FOR_SHARE';
      case 'KEY_SHARE':
        return 'FOR_KEY_SHARE';
      default:
        return 'FOR_UPDATE';
    }
  }
}
