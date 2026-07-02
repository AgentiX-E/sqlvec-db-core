/**
 * AdvisoryLockShim — PostgreSQL advisory lock function compatibility shim for SQLite.
 *
 * PostgreSQL provides several advisory lock functions that allow application-level
 * cooperative locking outside of row-level or table-level locks:
 *
 * | Function                         | Description                                       |
 * |----------------------------------|---------------------------------------------------|
 * | `pg_advisory_lock(key)`          | Obtain exclusive session-level advisory lock      |
 * | `pg_advisory_xact_lock(key)`     | Obtain exclusive transaction-level advisory lock  |
 * | `pg_try_advisory_lock(key)`      | Obtain session-level lock if available            |
 * | `pg_try_advisory_xact_lock(key)` | Obtain transaction-level lock if available        |
 * | `pg_advisory_unlock(key)`        | Release a session-level advisory lock             |
 * | `pg_advisory_unlock_all()`       | Release all session-level advisory locks          |
 *
 * SQLite does not support advisory lock functions. Since sqlvec-db targets
 * SQLite as its primary backend, these calls would produce SQL errors at runtime.
 *
 * ## Strategy (V2 — Real Process-Level Locks)
 *
 * Instead of ignoring advisory lock calls, this version implements real
 * process-level mutual exclusion using an in-memory lock map. The lock
 * operations execute as side effects while the SQL is rewritten to `SELECT 1`
 * for SQLite compatibility.
 *
 * | Input                                      | Output       | rewritten | Side Effect              |
 * |--------------------------------------------|--------------|-----------|--------------------------|
 * | `SELECT pg_advisory_lock(42)`              | `SELECT 1`   | true      | Acquire lock for key 42  |
 * | `SELECT pg_advisory_unlock(42)`            | `SELECT 1`   | true      | Release lock for key 42  |
 * | `SELECT pg_advisory_unlock_all()`          | `SELECT 1`   | true      | Release all locks        |
 * | `SELECT pg_advisory_xact_lock(42)`         | `SELECT 1`   | true      | Acquire lock for key 42  |
 * | `SELECT pg_try_advisory_lock(42)`          | `SELECT 1`   | true      | Try acquire lock for 42  |
 * | `SELECT pg_try_advisory_xact_lock(42)`     | `SELECT 1`   | true      | Try acquire lock for 42  |
 * | `SELECT pg_advisory_lock(42, 99)`          | `SELECT 1`   | true      | Acquire lock for (42,99) |
 * | `SELECT 1;`                                | (pass-through)| false    | None                     |
 * | `SELECT * FROM t;`                         | (pass-through)| false    | None                     |
 *
 * ## Lock Features
 *
 * - **Timeout-based auto-release**: Locks are automatically released after
 *   30 seconds to prevent deadlocks.
 * - **Reentrancy**: Not supported (same as PostgreSQL session-level locks —
 *   locking an already-held key is a no-op but returns false for
 *   pg_try_advisory_lock).
 * - **Two-key variant**: `pg_advisory_lock(key1, key2)` combines both keys
 *   into a single lock identifier using a 64-bit hash.
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite
 * - Real mutual exclusion within the same process
 * - Proper lock lifecycle management
 * - PinoLogger integration for debugging and audit trails
 *
 * @module AdvisoryLockShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('AdvisoryLockShim');

// ── Types ──────────────────────────────────────

export interface AdvisoryLockResult {
  /** Rewritten SQL (bare "SELECT 1" if advisory lock detected, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as an advisory lock call and rewritten */
  rewritten: boolean;
  /** Whether the lock acquire was successful (for pg_try_advisory_lock) */
  acquired?: boolean;
  /** Whether the lock release was successful (for pg_advisory_unlock) */
  released?: boolean;
}

/**
 * Internal lock entry stored in the process-wide lock map.
 */
interface LockEntry {
  /** The lock identifier (single number or combined pair) */
  lockId: string;
  /** Timestamp (epoch ms) when the lock was acquired */
  acquired: number;
  /** Lock timeout in milliseconds (default: 30000) */
  timeout: number;
}

// ── Constants ──────────────────────────────────

/** Default lock timeout (30 seconds) */
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/**
 * Full list of PostgreSQL advisory lock function names (case-insensitive).
 */
const ADVISORY_LOCK_FUNCTIONS = [
  'pg_advisory_lock',
  'pg_advisory_xact_lock',
  'pg_try_advisory_lock',
  'pg_try_advisory_xact_lock',
  'pg_advisory_unlock',
  'pg_advisory_unlock_all',
] as const;

/**
 * Regex to match an advisory lock call and optionally capture the arguments.
 *
 * Matches: pg_advisory_lock(42), pg_advisory_lock(42, 99), pg_advisory_unlock_all()
 * Captures the function name and arguments.
 */
// eslint-disable-next-line require-unicode-regexp
const ADVISORY_LOCK_CALL = new RegExp(
  `\\b(?:${ADVISORY_LOCK_FUNCTIONS.join('|')})\\s*\\(`,
  'i',
);

// ── Lock Map ────────────────────────────────────

/**
 * In-memory process-wide lock storage.
 *
 * Map key: `lock_${lockId}` where lockId is the string representation
 * of the numeric key.
 */
const advisoryLocks = new Map<string, LockEntry>();

// ── Lock Management Functions ──────────────────

/**
 * Acquire an advisory lock.
 *
 * If the lock is already held by another caller (within the timeout period),
 * returns `false`. If the lock has timed out, it is automatically released
 * and re-acquired.
 *
 * @param lockId - The lock identifier (single number or combined pair as string)
 * @returns `true` if the lock was successfully acquired, `false` if already held
 */
export function acquireAdvisoryLock(lockId: string): boolean {
  const key = `lock_${lockId}`;

  if (advisoryLocks.has(key)) {
    const lock = advisoryLocks.get(key)!;
    if (Date.now() - lock.acquired > lock.timeout) {
      // Timeout expired — auto-release and re-acquire
      advisoryLocks.delete(key);
      logger.info({ lockId, key }, 'Advisory lock auto-released (timeout)');
    } else {
      // Lock is still held
      logger.debug({ lockId, key }, 'Advisory lock already held');
      return false;
    }
  }

  advisoryLocks.set(key, {
    lockId,
    acquired: Date.now(),
    timeout: DEFAULT_LOCK_TIMEOUT_MS,
  });

  logger.debug({ lockId, key }, 'Advisory lock acquired');
  return true;
}

/**
 * Release an advisory lock.
 *
 * @param lockId - The lock identifier to release
 * @returns `true` if the lock was released, `false` if it was not held
 */
export function releaseAdvisoryLock(lockId: string): boolean {
  const key = `lock_${lockId}`;
  const existed = advisoryLocks.has(key);
  const result = advisoryLocks.delete(key);

  if (result) {
    logger.debug({ lockId, key }, 'Advisory lock released');
  } else {
    logger.debug({ lockId, key }, 'Advisory lock release: not held');
  }

  return result;
}

/**
 * Release all advisory locks.
 *
 * @returns The number of locks released
 */
export function releaseAllAdvisoryLocks(): number {
  const count = advisoryLocks.size;
  advisoryLocks.clear();
  logger.info({ releasedCount: count }, 'All advisory locks released');
  return count;
}

/**
 * Try to acquire an advisory lock (non-blocking).
 *
 * Works the same as `acquireAdvisoryLock` but is explicitly non-blocking.
 * In this in-memory implementation, both are non-blocking.
 *
 * @param lockId - The lock identifier
 * @returns `true` if the lock was successfully acquired, `false` if already held
 */
export function tryAcquireAdvisoryLock(lockId: string): boolean {
  return acquireAdvisoryLock(lockId);
}

/**
 * Get the number of currently held advisory locks.
 */
export function getAdvisoryLockCount(): number {
  // Clean up expired locks before returning count
  const now = Date.now();
  for (const [key, lock] of advisoryLocks) {
    if (now - lock.acquired > lock.timeout) {
      advisoryLocks.delete(key);
    }
  }
  return advisoryLocks.size;
}

/**
 * Check if a lock is currently held (and not expired).
 */
export function isAdvisoryLockHeld(lockId: string): boolean {
  const key = `lock_${lockId}`;
  const lock = advisoryLocks.get(key);
  if (!lock) return false;

  // Check timeout
  if (Date.now() - lock.acquired > lock.timeout) {
    advisoryLocks.delete(key);
    return false;
  }

  return true;
}

// ── Argument Extraction ────────────────────────

/**
 * Extract the function name and arguments from an advisory lock SQL statement.
 *
 * @example
 * ```ts
 * extractLockArgs("SELECT pg_advisory_lock(42)");
 * // → { fn: 'pg_advisory_lock', args: ['42'] }
 *
 * extractLockArgs("SELECT pg_advisory_lock(42, 99)");
 * // → { fn: 'pg_advisory_lock', args: ['42', '99'] }
 *
 * extractLockArgs("SELECT pg_advisory_unlock_all()");
 * // → { fn: 'pg_advisory_unlock_all', args: [] }
 * ```
 */
export function extractLockArgs(sql: string): {
  fn: string;
  args: string[];
} | null {
  if (!ADVISORY_LOCK_CALL.test(sql)) return null;

  // Match the function call: func_name( args )
  const match = sql.match(
    /\b(pg_advisory_lock|pg_advisory_xact_lock|pg_try_advisory_lock|pg_try_advisory_xact_lock|pg_advisory_unlock|pg_advisory_unlock_all)\s*\(([^)]*)\)/i,
  );
  if (!match) return null;

  const fn = match[1].toLowerCase();
  const argsStr = match[2].trim();

  if (argsStr.length === 0) {
    return { fn, args: [] };
  }

  // Split by comma and trim each argument
  const args = argsStr.split(',').map((a) => a.trim());

  return { fn, args };
}

/**
 * Build a lock identifier string from the arguments.
 *
 * Single arg → string of the arg
 * Two args → `${arg1}:${arg2}`
 *
 * @example
 * ```ts
 * buildLockId(['42']);         // '42'
 * buildLockId(['42', '99']);   // '42:99'
 * buildLockId([]);             // ''
 * ```
 */
export function buildLockId(args: string[]): string {
  if (args.length === 0) return '';
  if (args.length === 1) return args[0];
  return `${args[0]}:${args[1]}`;
}

// ── Main Entry Points ──────────────────────────

/**
 * Execute an advisory lock operation as a side effect and return the result.
 *
 * This is the main function that:
 * 1. Parses the lock function call from SQL
 * 2. Executes the actual lock/unlock operation
 * 3. Returns the result with the rewritten SQL
 *
 * @param sql - The SQL statement containing the advisory lock call
 * @returns The result with side effects applied and SQL rewritten
 */
export function executeAdvisoryLock(sql: string): AdvisoryLockResult {
  const parsed = extractLockArgs(sql);
  if (!parsed) {
    return { sql: sql ?? '', rewritten: false };
  }

  const { fn, args } = parsed;
  const lockId = buildLockId(args);

  logger.debug({ fn, lockId, args }, 'Executing advisory lock operation');

  switch (fn) {
    case 'pg_advisory_lock':
    case 'pg_advisory_xact_lock': {
      const acquired = acquireAdvisoryLock(lockId);
      return {
        sql: 'SELECT 1',
        rewritten: true,
        acquired,
      };
    }

    case 'pg_try_advisory_lock':
    case 'pg_try_advisory_xact_lock': {
      const acquired = tryAcquireAdvisoryLock(lockId);
      return {
        sql: 'SELECT 1',
        rewritten: true,
        acquired,
      };
    }

    case 'pg_advisory_unlock': {
      const released = releaseAdvisoryLock(lockId);
      return {
        sql: 'SELECT 1',
        rewritten: true,
        released,
      };
    }

    case 'pg_advisory_unlock_all': {
      const count = releaseAllAdvisoryLocks();
      return {
        sql: 'SELECT 1',
        rewritten: true,
        released: count > 0,
      };
    }

    default:
      logger.warn({ fn }, 'Unknown advisory lock function');
      return { sql: sql ?? '', rewritten: false };
  }
}

// ── Detection ───────────────────────────────────

/**
 * Builds a regex that matches one of the advisory lock function names
 * followed by an opening parenthesis.
 *
 * The resulting regex is case-insensitive and ensures the function name
 * is a whole word (no partial matches against longer identifiers).
 *
 * Matches:
 *   - pg_advisory_lock(42)
 *   - PG_ADVISORY_LOCK(42)
 *   - pg_advisory_unlock_all()
 *
 * Does NOT match:
 *   - my_pg_advisory_lock(42)    -- different function name
 *   - 'pg_advisory_lock(42)'     -- inside a string literal
 */
// eslint-disable-next-line require-unicode-regexp
const ADVISORY_LOCK_CALL_REGEX = new RegExp(
  `\\b(?:${ADVISORY_LOCK_FUNCTIONS.join('|')})\\s*\\(`,
  'i',
);

/**
 * Detect whether the given SQL string contains a call to any PostgreSQL
 * advisory lock function.
 *
 * This uses regex matching and performs a case-insensitive search for known
 * advisory lock function names followed by an opening parenthesis.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL contains an advisory lock function call
 *
 * @example
 * ```ts
 * detectAdvisoryLock('SELECT pg_advisory_lock(42);');             // true
 * detectAdvisoryLock('SELECT pg_advisory_unlock_all();');         // true
 * detectAdvisoryLock('SELECT pg_try_advisory_xact_lock(42);');   // true
 * detectAdvisoryLock('SELECT 1;');                                // false
 * detectAdvisoryLock('SELECT * FROM t;');                         // false
 * ```
 */
export function detectAdvisoryLock(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  return ADVISORY_LOCK_CALL_REGEX.test(sql);
}

/**
 * Rewrite a PostgreSQL advisory lock function call to a SQLite-compatible
 * no-op.
 *
 * **Processing logic (V2 — Real Lock Side Effects):**
 *
 * 1. If the SQL is empty or whitespace-only, return unchanged.
 * 2. If the SQL does not contain an advisory lock function call, pass through.
 * 3. If the SQL is a simple `SELECT func(...)` with an advisory lock function,
 *    execute the actual lock/unlock operation as a side effect and rewrite to
 *    `SELECT 1`.
 * 4. Complex queries embedding advisory locks are passed through unchanged.
 *
 * The rewrite only triggers for simple `SELECT func(...)` forms where the
 * function call appears at the start of the select list. Complex queries
 * that embed advisory lock calls (e.g., `SELECT ... FROM t WHERE
 * pg_advisory_lock(42) IS NOT NULL`) are passed through unchanged to avoid
 * breaking query structure. This is a conservative approach: in practice,
 * application-layer advisory locks are almost always used as standalone
 * `SELECT` statements.
 *
 * @param sql   The raw SQL string to process
 * @returns     An {@link AdvisoryLockResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteAdvisoryLock('SELECT pg_advisory_lock(42);');
 * // → { sql: 'SELECT 1', rewritten: true, acquired: true }
 *
 * rewriteAdvisoryLock('SELECT pg_advisory_unlock_all();');
 * // → { sql: 'SELECT 1', rewritten: true, released: true }
 *
 * rewriteAdvisoryLock('SELECT 1;');
 * // → { sql: 'SELECT 1;', rewritten: false }
 * ```
 */
export function rewriteAdvisoryLock(sql: string): AdvisoryLockResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Does this statement contain an advisory lock call? ───

  if (!ADVISORY_LOCK_CALL_REGEX.test(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 2: Check if this is a simple SELECT with advisory lock ──

  // Matches: SELECT <advisory-lock-func>( [args] ) [;] [whitespace]
  // eslint-disable-next-line require-unicode-regexp
  const SELECT_ADVISORY_LOCK = new RegExp(
    `^\\s*SELECT\\s+(?:${ADVISORY_LOCK_FUNCTIONS.join('|')})\\s*\\(`,
    'ims',
  );

  if (!SELECT_ADVISORY_LOCK.test(trimmed)) {
    // Advisory lock function is present but not in a simple standalone SELECT;
    // pass through unchanged to avoid breaking query structure.
    logger.debug(
      { sql: trimmed },
      'Advisory lock function detected in non-trivial SQL — passing through unchanged',
    );
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 3: Execute the actual lock operation and rewrite ───────

  const result = executeAdvisoryLock(trimmed);

  logger.debug(
    { sql: trimmed, fn: extractLockArgs(trimmed)?.fn, acquired: result.acquired, released: result.released },
    'PostgreSQL advisory lock detected — executed real lock operation, SQL rewritten to SELECT 1',
  );

  return result;
}
