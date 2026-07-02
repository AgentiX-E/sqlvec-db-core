/**
 * LockTableShim — PostgreSQL LOCK TABLE compatibility shim for SQLite.
 *
 * PostgreSQL supports explicit table-level locking via `LOCK TABLE` with
 * various lock modes:
 *
 * ```sql
 * LOCK TABLE table_name IN ACCESS EXCLUSIVE MODE;
 * LOCK TABLE table1, table2 IN SHARE MODE NOWAIT;
 * LOCK table_name;
 * ```
 *
 * SQLite does not support explicit table-level locking at the statement
 * level — it relies on its own internal locking during transactions
 * (deferred/immediate/exclusive). Since sqlvec-db's SQLite backend
 * uses serialised writes within transactional context, explicit PG-style
 * table locks are unnecessary and can be safely elided.
 *
 * ## Strategy
 *
 * All LOCK TABLE statements are rewritten to `SELECT 1`, a valid no-op
 * that returns a single-row result (avoids breaking code that expects
 * a result set from the statement).
 *
 * | Input                                              | Output     | rewritten |
 * |----------------------------------------------------|------------|-----------|
 * | `LOCK TABLE t`                                     | `SELECT 1` | true      |
 * | `LOCK TABLE t IN ACCESS EXCLUSIVE MODE`            | `SELECT 1` | true      |
 * | `LOCK TABLE t, u IN SHARE MODE NOWAIT`            | `SELECT 1` | true      |
 * | `LOCK t`                                           | `SELECT 1` | true      |
 * | `LOCK TABLE t IN ACCESS EXCLUSIVE MODE NOWAIT`     | `SELECT 1` | true      |
 * | `SELECT 1;`                                        | (pass-through) | false |
 * | `INSERT INTO t VALUES (1);`                        | (pass-through) | false |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-LOCK SQL (e.g. column named `lock`)
 * - Detection is conservative: only top-level LOCK [TABLE] statements
 * - PinoLogger integration for debugging and audit trails
 *
 * @module LockTableShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('LockTableShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface LockTableInfo {
  /** Table names to lock (parsed from LOCK TABLE statement) */
  tableNames: string[];
  /** Lock mode (e.g. 'ACCESS EXCLUSIVE', 'SHARE', etc.) */
  lockMode: string;
  /** Whether NOWAIT was specified */
  nowait: boolean;
}

export interface LockTableResult {
  /** Rewritten SQL ("SELECT 1" if rewritten to no-op, null if table-level locking) */
  sql: string | null;
  /** Whether the statement was detected as LOCK TABLE and rewritten */
  rewritten: boolean;
  /** If true, the caller should use `lockInfo` to invoke MVCCExecutor.lockTable() */
  useTableLock: boolean;
  /** Table lock details (only set when useTableLock is true) */
  lockInfo?: LockTableInfo;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches the start of any LOCK TABLE statement.
 *
 * Case-insensitive, allows leading whitespace.
 * Matches both:
 *   LOCK TABLE name ...
 *   LOCK name ...            (PostgreSQL allows omitting TABLE keyword)
 *
 * We require that `LOCK` is followed by either:
 *   - `TABLE` keyword + table name, OR
 *   - a direct identifier (table name without TABLE keyword)
 *
 * This avoids false matches on identifiers or expressions containing "lock".
 */
const LOCK_TABLE_PREFIX = /^\s*LOCK\s+(?:TABLE\s+)?[A-Za-z_][A-Za-z0-9_]*\s*/i;

/**
 * Full LOCK TABLE pattern with all components.
 *
 * PostgreSQL syntax:
 *   LOCK [TABLE] [ONLY] name [,...] [IN lockmode MODE] [NOWAIT]
 *
 * Groups:
 *   1 — Table name list (captures everything between LOCK [TABLE] and IN/NOWAIT/;)
 *
 * Lock modes (all PG-specific, all ignored by this shim):
 *   ACCESS SHARE, ROW SHARE, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE,
 *   SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE
 *
 * The pattern is intentionally broad to catch all variants.
 */
const LOCK_TABLE_FULL = /^\s*LOCK\s+(?:TABLE\s+)?(.+?)(?:\s+IN\s+(?:ACCESS\s+)?(?:SHARE|ROW\s+SHARE|ROW\s+EXCLUSIVE|SHARE\s+UPDATE\s+EXCLUSIVE|SHARE|SHARE\s+ROW\s+EXCLUSIVE|EXCLUSIVE|ACCESS\s+EXCLUSIVE)\s+MODE)?(?:\s+NOWAIT)?\s*;?\s*$/i;

/**
 * Extracts the table name list from a LOCK TABLE statement.
 *
 * This is used by {@link extractLockTableNames} to parse out individual
 * table identifiers. The regex captures everything between
 * `LOCK [TABLE]` and the optional `IN ... MODE` / `NOWAIT` suffix.
 */
const LOCK_TABLE_NAMES = /^\s*LOCK\s+(?:TABLE\s+)?(.+?)(?:\s+IN\s+.+)?(?:\s+NOWAIT)?\s*;?\s*$/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string is a LOCK TABLE statement.
 *
 * Performs a case-insensitive check for LOCK [TABLE] as the first keyword
 * pair in the statement.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a LOCK TABLE statement
 *
 * @example
 * ```ts
 * detectLockTable('LOCK TABLE users');                              // true
 * detectLockTable('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');    // true
 * detectLockTable('LOCK TABLE users, posts IN SHARE MODE NOWAIT'); // true
 * detectLockTable('LOCK users');                                    // true
 * detectLockTable('SELECT * FROM users');                           // false
 * detectLockTable('-- lock comment');                               // false
 * ```
 */
export function detectLockTable(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Case-insensitive prefix check for LOCK
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('LOCK ')) {
    return false;
  }

  // Confirm with regex — verifies it's LOCK [TABLE] followed by an identifier
  return LOCK_TABLE_PREFIX.test(trimmed);
}

/**
 * Extract the lock mode from a LOCK TABLE SQL statement.
 *
 * PostgreSQL lock modes:
 *   ACCESS SHARE, ROW SHARE, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE,
 *   SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE
 *
 * @param sql   The raw SQL string
 * @returns     The lock mode string (upper-cased), or default 'ACCESS EXCLUSIVE' if not specified
 *
 * @example
 * ```ts
 * extractLockMode('LOCK TABLE users');                              // 'ACCESS EXCLUSIVE'
 * extractLockMode('LOCK TABLE users IN SHARE MODE');                 // 'SHARE'
 * extractLockMode('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');     // 'ACCESS EXCLUSIVE'
 * extractLockMode('SELECT 1');                                       // 'ACCESS EXCLUSIVE' (default)
 * ```
 */
export function extractLockMode(sql: string): string {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return 'ACCESS EXCLUSIVE';
  }

  const trimmed = sql.trim();
  // Match IN <lockmode> MODE — capture the full mode name between "IN " and " MODE"
  const modeMatch = trimmed.match(/IN\s+(.+?)\s+MODE/i);
  if (modeMatch) {
    const mode = modeMatch[1].trim().toUpperCase();
    // Validate that it's a known PG lock mode
    const validModes = [
      'ACCESS SHARE', 'ROW SHARE', 'ROW EXCLUSIVE',
      'SHARE UPDATE EXCLUSIVE', 'SHARE', 'SHARE ROW EXCLUSIVE',
      'EXCLUSIVE', 'ACCESS EXCLUSIVE',
    ];
    if (validModes.includes(mode)) {
      return mode;
    }
    // Fallback to default for unrecognized modes
    return 'ACCESS EXCLUSIVE';
  }
  return 'ACCESS EXCLUSIVE';
}

/**
 * Extract NOWAIT flag from a LOCK TABLE SQL statement.
 *
 * @param sql   The raw SQL string
 * @returns     true if NOWAIT is present
 *
 * @example
 * ```ts
 * extractLockNowait('LOCK TABLE users NOWAIT');                      // true
 * extractLockNowait('LOCK TABLE users');                              // false
 * extractLockNowait('LOCK TABLE users IN SHARE MODE NOWAIT');        // true
 * ```
 */
export function extractLockNowait(sql: string): boolean {
  if (typeof sql !== 'string') return false;
  return /\bNOWAIT\b/i.test(sql.trim());
}

/**
 * Rewrite a PostgreSQL LOCK TABLE statement to a SQLite-compatible no-op,
 * or signal table-level locking if the caller supports it.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not a LOCK TABLE statement, return unchanged with
 *    `rewritten: false`.
 * 2. If it is a LOCK TABLE statement, returns:
 *    - `sql: null` — no SQL to execute (caller should call MVCCExecutor.lockTable)
 *    - `useTableLock: true` — signals the caller to use mvccExecutor.lockTable()
 *    - `lockInfo` — the parsed lock details
 *
 * Fallback (if caller doesn't support table-level locking):
 *    - QueryRouter can still use `sql: 'SELECT 1'` as a no-op if it chooses
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link LockTableResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteLockTable('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
 * // → { sql: null, rewritten: true, useTableLock: true,
 * //     lockInfo: { tableNames: ['users'], lockMode: 'ACCESS EXCLUSIVE', nowait: false } }
 *
 * rewriteLockTable('LOCK TABLE users, posts NOWAIT');
 * // → { sql: null, rewritten: true, useTableLock: true,
 * //     lockInfo: { tableNames: ['users', 'posts'], lockMode: 'ACCESS EXCLUSIVE', nowait: true } }
 *
 * rewriteLockTable('SELECT * FROM users');
 * // → { sql: 'SELECT * FROM users', rewritten: false, useTableLock: false }
 * ```
 */
export function rewriteLockTable(sql: string): LockTableResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
      useTableLock: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Is this even a LOCK TABLE statement? ────────────────

  if (!detectLockTable(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'Not a LOCK TABLE statement — passing through unchanged',
    );
    return {
      sql: trimmed,
      rewritten: false,
      useTableLock: false,
    };
  }

  // ── Step 2: Extract lock details ─────────────────────────────────

  const tableNames = extractLockTableNames(trimmed);
  const lockMode = extractLockMode(trimmed);
  const nowait = extractLockNowait(trimmed);

  logger.debug(
    { tableNames, lockMode, nowait, sql: trimmed },
    'LOCK TABLE detected — returning table lock info for MVCCExecutor',
  );

  if (tableNames.length === 0) {
    // Fallback to no-op if we can't parse table names
    return {
      sql: 'SELECT 1',
      rewritten: true,
      useTableLock: false,
    };
  }

  return {
    sql: null,
    rewritten: true,
    useTableLock: true,
    lockInfo: {
      tableNames,
      lockMode,
      nowait,
    },
  };
}

/**
 * Extract the list of table names from a LOCK TABLE SQL statement.
 *
 * Parses the comma-separated table names from the LOCK TABLE statement
 * and returns them as an array of strings. Identifiers are trimmed of
 * surrounding whitespace.
 *
 * @param sql   The raw SQL string
 * @returns     Array of extracted table names, or empty array if parsing fails
 *
 * @example
 * ```ts
 * extractLockTableNames('LOCK TABLE users');                        // ['users']
 * extractLockTableNames('LOCK TABLE users, posts IN SHARE MODE');  // ['users', 'posts']
 * extractLockTableNames('LOCK TABLE t IN ACCESS EXCLUSIVE MODE');  // ['t']
 * extractLockTableNames('LOCK t');                                  // ['t']
 * extractLockTableNames('SELECT 1');                                // []
 * ```
 */
export function extractLockTableNames(sql: string): string[] {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return [];
  }

  const trimmed = sql.trim();

  // Must be a LOCK TABLE statement
  if (!detectLockTable(trimmed)) {
    return [];
  }

  // Extract the table name portion between LOCK [TABLE] and the optional
  // IN ... MODE / NOWAIT suffix
  const match = trimmed.match(LOCK_TABLE_NAMES);
  if (!match || !match[1]) {
    return [];
  }

  const namePart = match[1].trim();

  // Strip trailing IN ... MODE / NOWAIT if it wasn't stripped by the regex
  // (defensive cleanup for edge cases)
  const cleaned = namePart
    .replace(/\s+IN\s+(?:ACCESS\s+)?(?:SHARE|ROW\s+SHARE|ROW\s+EXCLUSIVE|SHARE\s+UPDATE\s+EXCLUSIVE|SHARE|SHARE\s+ROW\s+EXCLUSIVE|EXCLUSIVE|ACCESS\s+EXCLUSIVE)\s+MODE\s*/i, '')
    .replace(/\s+NOWAIT\s*/i, '')
    .trim();

  if (cleaned.length === 0) {
    return [];
  }

  // Split by comma and clean each identifier
  return cleaned
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}
