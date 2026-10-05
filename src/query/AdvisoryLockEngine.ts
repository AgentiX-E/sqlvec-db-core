/**
 * AdvisoryLockEngine — PostgreSQL-style advisory locks backed by async-mutex.
 *
 * Implements the semantics of:
 *   - pg_advisory_lock(key)      -> acquire()  (blocking, optional timeout)
 *   - pg_try_advisory_lock(key)  -> tryAcquire() (non-blocking)
 *   - pg_advisory_unlock(key)    -> release()
 *
 * Each key maps to a single Mutex. Locks are reentrant per session: the same
 * session may acquire a key multiple times and must release it the same number
 * of times before the underlying mutex is actually unlocked.
 */

import { Mutex, withTimeout, E_TIMEOUT } from 'async-mutex';
import { PinoLogger } from '../logger/PinoLogger';

interface LockEntry {
  mutex: InstanceType<typeof Mutex>;
  /** Reentrant hold count per session (`heldBy.size` === number of sessions holding). */
  heldBy: Map<string, number>;
}

export class AdvisoryLockEngine {
  private locks: Map<bigint, LockEntry> = new Map();
  private logger = PinoLogger.forComponent('advisory-lock');

  /**
   * Acquire an advisory lock, blocking until it is available (or until
   * `timeoutMs` elapses).
   *
   * Reentrant: if `sessionId` already holds the lock, its hold count is
   * incremented and the call returns `true` immediately without touching the
   * underlying mutex.
   *
   * @param key       Lock key (the numeric argument passed to pg_advisory_lock).
   * @param sessionId Session that owns the lock (used for reentrancy tracking).
   * @param timeoutMs Optional acquisition timeout. When omitted (or negative),
   *                  the call blocks indefinitely. When provided, the call
   *                  returns `false` once the timeout is reached without
   *                  acquiring the lock.
   * @returns `true` if the lock was (or already was) acquired, `false` on timeout.
   */
  async acquire(key: bigint, sessionId: string, timeoutMs?: number): Promise<boolean> {
    const entry = this.ensureEntry(key);

    // Reentrant: this session already holds the lock — bump the count.
    if (entry.heldBy.has(sessionId)) {
      entry.heldBy.set(sessionId, entry.heldBy.get(sessionId)! + 1);
      return true;
    }

    // A timeout is only meaningful while we are about to block on the mutex.
    const mutex = timeoutMs !== undefined && timeoutMs >= 0
      ? withTimeout(entry.mutex, timeoutMs)
      : entry.mutex;

    try {
      await mutex.acquire();
    } catch (err) {
      if (err === E_TIMEOUT) {
        this.logger.warn({ key: String(key), sessionId, timeoutMs }, 'Advisory lock timeout');
        return false;
      }
      throw err;
    }

    entry.heldBy.set(sessionId, 1);
    this.logger.debug({ key: String(key), sessionId }, 'Advisory lock acquired');
    return true;
  }

  /**
   * Attempt to acquire the lock without blocking.
   *
   * Returns `false` immediately if the lock is currently held by another
   * session. Reentrant acquisition by the same session still succeeds.
   */
  async tryAcquire(key: bigint, sessionId: string): Promise<boolean> {
    const entry = this.ensureEntry(key);

    if (entry.heldBy.has(sessionId)) {
      entry.heldBy.set(sessionId, entry.heldBy.get(sessionId)! + 1);
      return true; // Reentrant
    }

    if (entry.mutex.isLocked()) {
      return false; // Held by another session
    }

    await entry.mutex.acquire();
    entry.heldBy.set(sessionId, 1);
    return true;
  }

  /**
   * Release one hold on the lock for `sessionId`.
   *
   * Reentrancy-aware: a session that acquired the lock N times must call
   * `release` N times; only the final release actually unlocks the mutex and
   * removes the entry.
   *
   * @returns `true` if a hold was released, `false` if the session did not
   *          hold the lock (or no such lock exists).
   */
  release(key: bigint, sessionId: string): boolean {
    const entry = this.locks.get(key);
    if (!entry) {
      return false;
    }

    const count = entry.heldBy.get(sessionId);
    if (count === undefined) {
      return false;
    }

    if (count > 1) {
      entry.heldBy.set(sessionId, count - 1);
      return true;
    }

    // Final hold released by this session. Because each key is backed by a
    // single exclusive Mutex, at most one session can hold it at any time, so
    // clearing this session's entry empties the map and unlocks the key.
    entry.heldBy.delete(sessionId);
    entry.mutex.release();
    this.locks.delete(key);
    this.logger.debug({ key: String(key), sessionId }, 'Advisory lock released');
    return true;
  }

  /** Number of distinct keys currently held by any session. */
  get lockCount(): number {
    return this.locks.size;
  }

  /**
   * Release every hold (including reentrant holds) that `sessionId` has on any
   * key (used when a connection closes).
   *
   * @returns The number of distinct keys that were released.
   */
  releaseAllBySession(sessionId: string): number {
    let count = 0;
    // Snapshot the keys so we can safely delete entries while iterating.
    for (const key of [...this.locks.keys()]) {
      const entry = this.locks.get(key)!;
      if (!entry.heldBy.has(sessionId)) continue;

      // Drop every reentrant hold, then unlock the mutex once.
      entry.heldBy.delete(sessionId);
      entry.mutex.release();
      this.locks.delete(key);
      count++;
    }
    return count;
  }

  /** Lazily create and register the lock entry for `key`. */
  private ensureEntry(key: bigint): LockEntry {
    let entry = this.locks.get(key);
    if (!entry) {
      entry = { mutex: new Mutex(), heldBy: new Map() };
      this.locks.set(key, entry);
    }
    return entry;
  }
}
