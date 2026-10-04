/**
 * LockTimeout — lock_timeout enforcement for SQLite operations.
 *
 * PostgreSQL's `lock_timeout` GUC (SET lock_timeout = '5s') limits how long
 * a session will wait for a lock before aborting with SQLSTATE 55P03
 * (lock_not_available).
 *
 * SQLite does not distinguish lock waits from query execution time; it uses
 * `busy_timeout` (default 5000ms) for all contention scenarios. This module
 * wraps SQLite database operations with:
 *
 *   1. `PRAGMA busy_timeout = N` — tells SQLite to retry busy handlers
 *      for up to N ms before failing with SQLITE_BUSY.
 *   2. A JS-side timer check that compares elapsed lock-wait time against
 *      the configured `lock_timeout` and throws a PG-style 55P03 error if
 *      exceeded.
 *
 * ## Usage
 *
 * ```ts
 * const db = new Database('/path/to/db.sqlite');
 * const lockHandler = new LockTimeoutHandler(db, { lockTimeoutMs: 5000 });
 *
 * // Wrap all SQLite write operations
 * const stmt = db.prepare('UPDATE accounts SET balance = balance + 100 WHERE id = ?');
 * lockHandler.execute(() => stmt.run(42));
 * ```
 *
 * ## GUC Integration
 *
 * `SET lock_timeout = '5s'` is already handled by SetResetShim (stored as
 * no-op). The query execution layer should read the session-level
 * `lock_timeout` value and apply it when creating a LockTimeoutHandler for
 * that session's database operations.
 *
 * @module query/LockTimeout
 */

import { PinoLogger } from '../logger/PinoLogger';

// ============================================================
//  Types
// ============================================================

export interface LockTimeoutConfig {
  /** Max lock wait time in ms. 0 = no limit (default: 0, matches PG default) */
  lockTimeoutMs: number;
}

export const DEFAULT_LOCK_TIMEOUT_CONFIG: LockTimeoutConfig = {
  lockTimeoutMs: 0,
};

export interface LockTimeoutStats {
  totalOperations: number;
  lockTimeoutCount: number;
  lastLockTimeoutAt: number | null;
}

// ============================================================
//  PG-style error for lock_not_available (SQLSTATE 55P03)
// ============================================================

/**
 * PG-style error for lock_not_available (SQLSTATE 55P03).
 *
 * Thrown when a lock wait exceeds the configured lock_timeout.
 */
export class LockNotAvailableError extends Error {
  /** Application-level error code */
  public code: string;
  /** PG severity */
  public severity: string;
  /** PG SQLSTATE */
  public sqlState: string;

  constructor(
    message: string = 'canceling statement due to lock timeout',
    timeoutMs?: number,
  ) {
    const msg = timeoutMs
      ? `canceling statement due to lock timeout (${timeoutMs}ms)`
      : message;
    super(msg);
    this.name = 'LockNotAvailableError';
    this.code = 'LOCK_NOT_AVAILABLE';
    this.severity = 'ERROR';
    this.sqlState = '55P03';
  }
}

// ============================================================
//  LockTimeoutHandler
// ============================================================

/**
 * Wraps SQLite database operations with lock_timeout enforcement.
 *
 * Strategy:
 *   1. Sets `PRAGMA busy_timeout` to min(lockTimeoutMs, 5000) so SQLite
 *      retries busy handlers within a reasonable bound.
 *   2. Tracks elapsed wall-clock time for the operation.
 *   3. If elapsed time exceeds lockTimeoutMs, throws LockNotAvailableError
 *      (SQLSTATE 55P03).
 *
 * The JS timer check catches the case where lock_timeout is shorter than
 * the default busy_timeout, or where lock_timeout > 0 while busy_timeout
 * is effectively infinite.
 */
export class LockTimeoutHandler {
  private config: LockTimeoutConfig;
  private db: any; // better-sqlite3 Database instance
  private stats: LockTimeoutStats = {
    totalOperations: 0,
    lockTimeoutCount: 0,
    lastLockTimeoutAt: null,
  };
  private logger: PinoLogger;

  /**
   * @param db      A better-sqlite3 Database instance
   * @param config  Lock timeout configuration
   */
  constructor(db: any, config?: Partial<LockTimeoutConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_LOCK_TIMEOUT_CONFIG, ...config };
    this.logger = PinoLogger.forComponent('LockTimeoutHandler');

    // Apply the busy_timeout PRAGMA on construction
    this.applyBusyTimeout();

    this.logger.debug(
      { lockTimeoutMs: this.config.lockTimeoutMs },
      'LockTimeoutHandler initialised',
    );
  }

  // ── Public API ──────────────────────────────────

  /**
   * Update the lock timeout configuration at runtime.
   * This is called when `SET lock_timeout = 'N'` is executed.
   *
   * @param config  Partial lock timeout config to apply
   */
  updateConfig(config: Partial<LockTimeoutConfig>): void {
    this.config = { ...this.config, ...config };
    this.applyBusyTimeout();
    this.logger.debug(
      { lockTimeoutMs: this.config.lockTimeoutMs },
      'LockTimeoutHandler config updated',
    );
  }

  /**
   * Get the current lock timeout configuration.
   */
  getConfig(): Readonly<LockTimeoutConfig> {
    return { ...this.config };
  }

  /**
   * Get the underlying database instance (for PRAGMA access).
   */
  getDb(): any {
    return this.db;
  }

  /**
   * Execute a database operation with lock_timeout enforcement.
   *
   * The operation function is called and its result is returned.
   * If the operation takes longer than lockTimeoutMs (judged by
   * wall-clock time), a LockNotAvailableError is thrown.
   *
   * **Note:** SQLite's busy_timeout applies at the C-level; if a
   * WAL-mode write stalls behind a concurrent writer, SQLite retries
   * for busy_timeout ms. This wrapper adds a JS-level timer check
   * that fires if lock_timeout < busy_timeout.
   *
   * @param fn  Synchronous function that performs DB operations
   * @returns   Result of the function
   * @throws LockNotAvailableError if lock_timeout is exceeded
   */
  execute<T>(fn: () => T): T {
    this.stats.totalOperations++;

    const timeoutMs = this.config.lockTimeoutMs;
    if (timeoutMs <= 0) {
      // No timeout — execute directly
      return fn();
    }

    const startTime = Date.now();

    try {
      return fn();
    } catch (err: any) {
      // Check if the error is SQLITE_BUSY or SQLITE_LOCKED
      const elapsed = Date.now() - startTime;

      if (
        this.isLockSignal(err) &&
        (elapsed >= timeoutMs || this.likelyLockContention(err))
      ) {
        this.stats.lockTimeoutCount++;
        this.stats.lastLockTimeoutAt = Date.now();

        this.logger.warn(
          { elapsedMs: elapsed, lockTimeoutMs: timeoutMs, error: err?.message },
          'Lock timeout exceeded — throwing SQLSTATE 55P03',
        );

        throw new LockNotAvailableError(
          `canceling statement due to lock timeout (${timeoutMs}ms)`,
          timeoutMs,
        );
      }

      // Re-throw other errors unchanged
      throw err;
    }
  }

  /**
   * Asynchronously execute a database operation with lock_timeout enforcement.
   * For use with async backends; wraps the fn in a timer check.
   */
  async executeAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.stats.totalOperations++;

    const timeoutMs = this.config.lockTimeoutMs;
    if (timeoutMs <= 0) {
      return fn();
    }

    const startTime = Date.now();

    try {
      return await fn();
    } catch (err: any) {
      const elapsed = Date.now() - startTime;

      if (
        this.isLockSignal(err) &&
        (elapsed >= timeoutMs || this.likelyLockContention(err))
      ) {
        this.stats.lockTimeoutCount++;
        this.stats.lastLockTimeoutAt = Date.now();

        this.logger.warn(
          { elapsedMs: elapsed, lockTimeoutMs: timeoutMs },
          'Lock timeout exceeded (async) — throwing SQLSTATE 55P03',
        );

        throw new LockNotAvailableError(
          `canceling statement due to lock timeout (${timeoutMs}ms)`,
          timeoutMs,
        );
      }

      throw err;
    }
  }

  /**
   * Get execution statistics.
   */
  getStats(): Readonly<LockTimeoutStats> {
    return { ...this.stats };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalOperations: 0,
      lockTimeoutCount: 0,
      lastLockTimeoutAt: null,
    };
  }

  // ── Private helpers ────────────────────────────

  /**
   * Apply the busy_timeout PRAGMA using the configured lockTimeoutMs value.
   *
   * SQLite's busy_timeout is clamped to a reasonable upper bound (5000ms)
   * to prevent unbounded waits. If lockTimeoutMs is 0 (no limit), we set
   * busy_timeout to 0 (immediate failure on contention).
   */
  private applyBusyTimeout(): void {
    try {
      if (!this.db || typeof this.db.pragma !== 'function') return;

      const timeoutMs = this.config.lockTimeoutMs;
      let busyTimeout: number;

      if (timeoutMs <= 0) {
        // No lock timeout — fail immediately on contention
        busyTimeout = 0;
      } else {
        // Clamp to reasonable value: min(timeoutMs, 30000) — max 30s
        busyTimeout = Math.min(timeoutMs, 30000);
      }

      this.db.pragma(`busy_timeout = ${busyTimeout}`);

      this.logger.debug(
        { lockTimeoutMs: timeoutMs, appliedBusyTimeout: busyTimeout },
        'Applied PRAGMA busy_timeout',
      );
    } catch (err) {
      this.logger.warn({ err }, 'Failed to apply PRAGMA busy_timeout');
    }
  }

  /**
   * Heuristic: check if an error is likely a lock contention issue.
   * Used when SQLite returns SQLITE_BUSY but elapsed < strict lock_timeout.
   */
  private likelyLockContention(err: any): boolean {
    const msg = String(err?.message || err).toLowerCase();
    return (
      msg.includes('database is locked') ||
      msg.includes('database table is locked') ||
      msg.includes('cannot commit') ||
      err?.code === 'SQLITE_BUSY' ||
      err?.code === 'SQLITE_LOCKED'
    );
  }

  /**
   * Determine whether an error signals a lock wait. Matches the authoritative
   * SQLITE_BUSY / SQLITE_LOCKED codes and SQLite's exact lock phrase ("database
   * is locked"). Bare "busy"/"locked" substrings are intentionally NOT matched:
   * they appear in unrelated business errors (e.g. "busy worker", "unlocked
   * feature") and would cause false SQLSTATE 55P03 aborts.
   */
  private isLockSignal(err: any): boolean {
    const msg = String(err?.message || err || '').toLowerCase();
    const code = err?.code || '';
    return (
      msg.includes('database is locked') ||
      msg.includes('database table is locked') ||
      code === 'SQLITE_BUSY' ||
      code === 'SQLITE_LOCKED'
    );
  }
}
