/**
 * RowLockManager — row-level lock acquisition contract.
 *
 * This module defines the *contract* for row-level locking used by
 * `ForUpdateExecutor` when a `SELECT ... FOR UPDATE` runs against a cluster
 * deployment.  The full distributed implementation (with deadlock detection
 * and cross-node wait-for graphs) lives in the cluster layer; this core
 * module only owns the shared types and a single-node null-object default.
 *
 * In single-node operation `ForUpdateExecutor` routes locks through
 * `MVCCExecutor.acquireRowWriteLock` instead, so `RowLockManager` is only
 * instantiated when a cluster layer injects it.  The null-object default
 * therefore exists purely as a safe, type-correct placeholder: it grants
 * every lock immediately (there is no cross-node contention to arbitrate).
 *
 * @module consensus/RowLockManager
 */

/** PostgreSQL row-level lock strength, mapped from a FOR UPDATE/SHARE clause. */
export type LockMode =
  | 'FOR_UPDATE'
  | 'FOR_NO_KEY_UPDATE'
  | 'FOR_SHARE'
  | 'FOR_KEY_SHARE';

/** Request shape accepted by {@link RowLockManager.acquireLocks}. */
export interface AcquireLocksRequest {
  sessionId: string;
  shardId: number;
  tableName: string;
  /** Row identifiers to lock. */
  rowIds: bigint[];
  mode: LockMode;
  /** Fail immediately instead of waiting when a lock is held (NOWAIT). */
  nowait: boolean;
  /** Skip rows that cannot be locked immediately (SKIP LOCKED). */
  skipLocked: boolean;
  /** Max wait time in milliseconds before giving up. */
  timeoutMs: number;
}

/** Result of a lock-acquisition request. */
export interface AcquireLocksResult {
  /** Whether at least one requested lock was granted. */
  granted: boolean;
  /** Row ids that were successfully locked. */
  rowIds: bigint[];
  /** Row ids that could not be locked (due to NOWAIT/SKIP LOCKED). */
  skipped: bigint[];
}

export class RowLockManager {
  private static _instance?: RowLockManager;

  static getInstance(): RowLockManager {
    if (!RowLockManager._instance) {
      RowLockManager._instance = new RowLockManager();
    }
    return RowLockManager._instance;
  }

  /**
   * Acquire row-level locks.
   *
   * The single-node default grants every requested lock immediately (no
   * contention exists); a cluster implementation overrides this with real
   * distributed lock arbitration.
   */
  async acquireLocks(request: AcquireLocksRequest): Promise<AcquireLocksResult> {
    return {
      granted: request.rowIds.length > 0,
      rowIds: [...request.rowIds],
      skipped: [],
    };
  }
}
