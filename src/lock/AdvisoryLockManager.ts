/**
 * AdvisoryLockManager — PostgreSQL-style advisory lock for SQLite.
 *
 * Implements cooperative application-level locking using `async-mutex`.
 * Mirrors the PostgreSQL advisory lock API:
 *
 * | Function                       | Description                                     |
 * |--------------------------------|-------------------------------------------------|
 * | pg_advisory_lock(key)          | Session-level exclusive lock (blocks)           |
 * | pg_try_advisory_lock(key)      | Session-level non-blocking lock                 |
 * | pg_advisory_unlock(key)        | Release a session-level lock                    |
 * | pg_advisory_xact_lock(key)     | Transaction-level lock (auto-released)          |
 * | pg_try_advisory_xact_lock(key) | Transaction-level non-blocking lock             |
 *
 * ## Lock scopes
 *
 * - **Session-level**: Held until explicitly unlocked via `pg_advisory_unlock`.
 * - **Transaction-level**: Automatically released when the transaction ends
 *   (via `releaseTransactionLocks`).
 *
 * Both scopes support reentrancy: the same session can acquire the same lock
 * multiple times. Each `acquire` must be matched by a corresponding `release`.
 *
 * ## Usage
 *
 * ```ts
 * const manager = new AdvisoryLockManager();
 *
 * // Session-level blocking lock
 * await manager.acquire('session', 42n, 'sess-1');
 * manager.release('session', 42n, 'sess-1');
 *
 * // Transaction-level lock (auto-released on txn end)
 * await manager.acquire('transaction', 99n, 'sess-2');
 * manager.releaseTransactionLocks('sess-2');
 *
 * // Non-blocking try-acquire
 * const acquired = await manager.tryAcquire('session', 42n, 'sess-3');
 * ```
 *
 * @module lock/AdvisoryLockManager
 */

import { Mutex, type MutexInterface } from 'async-mutex';
import { PinoLogger } from '../logger/PinoLogger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LockScope = 'session' | 'transaction';

interface LockState {
  mutex: MutexInterface;
  heldBy: Map<string, number>; // sessionId -> reentrant count
  transactionSessions: Set<string>; // sessionIds holding transaction-level locks
}

export interface AdvisoryLockResult {
  acquired: boolean;
  lockKey: string;
  scope: LockScope;
}

// ── AdvisoryLockManager ───────────────────────────────────────────────────────

export class AdvisoryLockManager {
  private readonly logger = PinoLogger.forComponent('AdvisoryLockManager');

  /** Internal lock map: bigint key -> LockState */
  private locks: Map<bigint, LockState> = new Map();

  // ── Core acquire / release ───────────────────────────────────────────────────

  /**
   * Acquire an advisory lock (blocking).
   *
   * Corresponds to `pg_advisory_lock(key)` (session-level) or
   * `pg_advisory_xact_lock(key)` (transaction-level).
   *
   * Supports reentrancy: if the same session already holds the lock,
   * the call succeeds immediately (incrementing the reentrant count).
   *
   * @param scope      - 'session' or 'transaction'.
   * @param key        - Lock key (bigint).
   * @param sessionId  - Unique session identifier.
   * @param timeoutMs  - Optional timeout in ms (0 = no timeout / wait forever).
   * @returns `true` if the lock was acquired.
   */
  async acquire(
    scope: LockScope,
    key: bigint,
    sessionId: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    const state = this.getOrCreateState(key);

    // Reentrant: same session already holds the lock
    if (state.heldBy.has(sessionId)) {
      state.heldBy.set(sessionId, state.heldBy.get(sessionId)! + 1);
      return true;
    }

    try {
      if (timeoutMs && timeoutMs > 0) {
        // Use a Promise.race for timeout
        await Promise.race([
          state.mutex.acquire(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Lock timeout')), timeoutMs),
          ),
        ]);
      } else {
        await state.mutex.acquire();
      }

      state.heldBy.set(sessionId, 1);
      if (scope === 'transaction') {
        state.transactionSessions.add(sessionId);
      }

      this.logger.debug(
        { key: String(key), sessionId, scope },
        'Advisory lock acquired',
      );

      return true;
    } catch {
      this.logger.warn(
        { key: String(key), sessionId, timeoutMs },
        'Advisory lock acquisition failed (timeout)',
      );
      return false;
    }
  }

  /**
   * Try to acquire an advisory lock without blocking.
   *
   * Corresponds to `pg_try_advisory_lock(key)` (session-level) or
   * `pg_try_advisory_xact_lock(key)` (transaction-level).
   *
   * @param scope      - 'session' or 'transaction'.
   * @param key        - Lock key (bigint).
   * @param sessionId  - Unique session identifier.
   * @returns `true` if the lock was acquired immediately.
   */
  async tryAcquire(scope: LockScope, key: bigint, sessionId: string): Promise<boolean> {
    const state = this.getOrCreateState(key);

    // Reentrant
    if (state.heldBy.has(sessionId)) {
      state.heldBy.set(sessionId, state.heldBy.get(sessionId)! + 1);
      return true;
    }

    if (state.mutex.isLocked()) {
      this.logger.debug(
        { key: String(key), sessionId },
        'tryAcquire: lock is held by another session',
      );
      return false;
    }

    try {
      await state.mutex.acquire();
      state.heldBy.set(sessionId, 1);
      if (scope === 'transaction') {
        state.transactionSessions.add(sessionId);
      }
      this.logger.debug(
        { key: String(key), sessionId, scope },
        'Advisory lock acquired (try)',
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Release an advisory lock.
   *
   * Corresponds to `pg_advisory_unlock(key)`.
   *
   * For reentrant locks: decrements the hold count. The underlying mutex
   * is only released when the hold count reaches zero.
   *
   * @param key        - Lock key (bigint).
   * @param sessionId  - Unique session identifier.
   * @returns `true` if the lock was released (or hold count decremented).
   */
  release(key: bigint, sessionId: string): boolean {
    const state = this.locks.get(key);
    if (!state) return false;

    const count = state.heldBy.get(sessionId);
    if (count === undefined) return false;

    if (count <= 1) {
      // Fully release
      state.heldBy.delete(sessionId);
      state.transactionSessions.delete(sessionId);
      state.mutex.release();

      // Clean up empty lock states. Because the underlying mutex is exclusive,
      // `heldBy` can only ever contain a single session, so this condition is
      // always true after the sole holder is deleted.
      /* v8 ignore next */
      if (state.heldBy.size === 0) {
        this.locks.delete(key);
      }

      this.logger.debug(
        { key: String(key), sessionId },
        'Advisory lock released',
      );
    } else {
      // Reentrant: decrement count
      state.heldBy.set(sessionId, count - 1);
      this.logger.debug(
        { key: String(key), sessionId, remaining: count - 1 },
        'Advisory lock reentrant count decremented',
      );
    }

    return true;
  }

  // ── Transaction lifecycle ────────────────────────────────────────────────────

  /**
   * Release all transaction-level locks held by a session.
   *
   * Called when a transaction commits or rolls back. Only affects locks
   * acquired with scope='transaction'.
   *
   * @param sessionId - Session whose transaction locks to release.
   * @returns Number of locks released.
   */
  releaseTransactionLocks(sessionId: string): number {
    let released = 0;
    const keysToRelease: bigint[] = [];

    for (const [key, state] of this.locks) {
      if (state.transactionSessions.has(sessionId)) {
        keysToRelease.push(key);
      }
    }

    for (const key of keysToRelease) {
      // Force release regardless of reentrant count
      const state = this.locks.get(key);
      // `key` is collected from iterating `this.locks`, so `state` is always
      // defined here; the guard is defensive only.
      /* v8 ignore next */
      if (state) {
        state.heldBy.delete(sessionId);
        state.transactionSessions.delete(sessionId);
        state.mutex.release();
        // Same rationale as `release`: the exclusive mutex guarantees a single
        // holder, so the map is empty once the only session is removed.
        /* v8 ignore next */
        if (state.heldBy.size === 0) {
          this.locks.delete(key);
        }
        released++;
      }
    }

    if (released > 0) {
      this.logger.debug({ sessionId, released }, 'Transaction locks released');
    }

    return released;
  }

  /**
   * Release all locks held by a session (both session-level and transaction-level).
   *
   * Called when a session disconnects.
   *
   * @param sessionId - Session to clean up.
   * @returns Number of locks released.
   */
  releaseAllBySession(sessionId: string): number {
    let released = 0;
    const keysToRelease: bigint[] = [];

    for (const [key, state] of this.locks) {
      if (state.heldBy.has(sessionId)) {
        keysToRelease.push(key);
      }
    }

    for (const key of keysToRelease) {
      // `key` is filtered by `heldBy.has(sessionId)`, so `release` always
      // returns true here; the conditional is defensive only.
      /* v8 ignore next */
      if (this.release(key, sessionId)) {
        released++;
      }
    }

    this.logger.debug({ sessionId, released }, 'All locks released for session');
    return released;
  }

  // ── Query helpers ────────────────────────────────────────────────────────────

  /**
   * Return the number of distinct lock keys currently tracked.
   */
  get lockCount(): number {
    return this.locks.size;
  }

  /**
   * Check if a lock key is currently held by any session.
   */
  isLocked(key: bigint): boolean {
    const state = this.locks.get(key);
    return state !== undefined && state.heldBy.size > 0;
  }

  /**
   * Get the sessions currently holding a lock.
   */
  getLockHolders(key: bigint): string[] {
    const state = this.locks.get(key);
    if (!state) return [];
    return Array.from(state.heldBy.keys());
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Release all locks and reset state.
   */
  reset(): void {
    // Release all mutexes
    for (const state of this.locks.values()) {
      try { state.mutex.release(); } catch { /* ignore */ }
    }
    this.locks.clear();
    this.logger.info('AdvisoryLockManager reset');
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private getOrCreateState(key: bigint): LockState {
    let state = this.locks.get(key);
    if (!state) {
      state = {
        mutex: new Mutex(),
        heldBy: new Map(),
        transactionSessions: new Set(),
      };
      this.locks.set(key, state);
    }
    return state;
  }
}
