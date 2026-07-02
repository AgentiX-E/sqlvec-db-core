/**
 * ReplicationLagShim — PostgreSQL replication lag monitoring compatibility shim
 * for SQLite.
 *
 * PostgreSQL provides several system catalogs and functions for monitoring
 * replication lag:
 *
 * ```sql
 * SELECT * FROM pg_stat_replication;
 * SELECT pg_wal_lsn_diff(l1, l2);
 * SELECT pg_current_wal_lsn();
 * SELECT pg_last_wal_receive_lsn();
 * SELECT pg_last_wal_replay_lsn();
 * SELECT pg_is_in_recovery();
 * ```
 *
 * SQLite has no replication concept — it is single-node by design. This shim
 * detects PG replication-lag SQL and rewrites each variant to a valid
 * SQLite-compatible no-op that returns a sensible placeholder result.
 *
 * ## Strategy
 *
 * | Input                                                    | Output                                       | rewritten |
 * |----------------------------------------------------------|----------------------------------------------|-----------|
 * | `SELECT * FROM pg_stat_replication`                      | `SELECT 1 AS pid, '' AS application_name, 'streaming' AS state` | true |
 * | `SELECT pg_wal_lsn_diff('0/0', '0/0')`                   | `SELECT <diff>`                              | true |
 * | `SELECT pg_current_wal_lsn()`                            | `SELECT '<lsn>'`                              | true |
 * | `SELECT pg_last_wal_receive_lsn()`                       | `SELECT '<lsn>'` (from WALStateManager) | true |
 * | `SELECT pg_last_wal_replay_lsn()`                        | `SELECT '<lsn>'` (from WALStateManager) | true |
 * | `SELECT pg_is_in_recovery()`                             | `SELECT false`                               | true |
 * | `SELECT 1;`                                              | (pass-through)                               | false |
 * | `CREATE TABLE t (id INT);`                               | (pass-through)                               | false |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-replication-lag SQL
 * - Case-insensitive matching for function names
 * - Multi-statement and sub-expression usage beyond the scope of this shim
 *   (callers should pre-separate statements before routing here)
 * - PinoLogger integration for debugging and audit trails
 *
 * @module ReplicationLagShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { WALStateManager } from '../storage/WALStateManager';

const logger = PinoLogger.forComponent('ReplicationLagShim');
const wsm = WALStateManager.getInstance();

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ReplLagResult {
  /** Rewritten SQL (placeholder if rewritten, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as a replication-lag operation and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches `SELECT ... FROM pg_stat_replication` (with optional schema prefix).
 *
 * Covers:
 *   SELECT * FROM pg_stat_replication
 *   SELECT pid, state FROM pg_stat_replication
 *   SELECT * FROM pg_catalog.pg_stat_replication
 *   SELECT * FROM pg_stat_replication WHERE ...
 *
 * Pattern: `SELECT ... FROM [pg_catalog.]pg_stat_replication`
 * Case-insensitive.
 */
const QUERY_STAT_REPLICATION =
  /^\s*SELECT\b[\s\S]*?\bFROM\s+(?:pg_catalog\.)?pg_stat_replication\b/i;

/**
 * Matches `SELECT pg_wal_lsn_diff(...)` as a top-level statement.
 *
 * The function accepts two LSN arguments. We only care about the function
 * call itself, not its arguments.
 *
 * Pattern: `SELECT pg_wal_lsn_diff( ... )`
 * Case-insensitive.
 */
const SELECT_WAL_LSN_DIFF = /^\s*SELECT\s+pg_wal_lsn_diff\s*\(/i;

/**
 * Matches `SELECT pg_current_wal_lsn()` as a top-level statement.
 *
 * Pattern: `SELECT pg_current_wal_lsn()`
 * Case-insensitive.
 */
const SELECT_CURRENT_WAL_LSN = /^\s*SELECT\s+pg_current_wal_lsn\s*\(/i;

/**
 * Matches `SELECT pg_last_wal_receive_lsn()` as a top-level statement.
 *
 * Pattern: `SELECT pg_last_wal_receive_lsn()`
 * Case-insensitive.
 */
const SELECT_LAST_WAL_RECEIVE_LSN =
  /^\s*SELECT\s+pg_last_wal_receive_lsn\s*\(/i;

/**
 * Matches `SELECT pg_last_wal_replay_lsn()` as a top-level statement.
 *
 * Pattern: `SELECT pg_last_wal_replay_lsn()`
 * Case-insensitive.
 */
const SELECT_LAST_WAL_REPLAY_LSN =
  /^\s*SELECT\s+pg_last_wal_replay_lsn\s*\(/i;

/**
 * Matches `SELECT pg_is_in_recovery()` as a top-level statement.
 *
 * Pattern: `SELECT pg_is_in_recovery()`
 * Case-insensitive.
 */
const SELECT_IS_IN_RECOVERY = /^\s*SELECT\s+pg_is_in_recovery\s*\(/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL replication lag
 * monitoring operation.
 *
 * The following patterns are detected:
 * - `SELECT ... FROM pg_stat_replication`
 * - `SELECT pg_wal_lsn_diff(...)`
 * - `SELECT pg_current_wal_lsn()`
 * - `SELECT pg_last_wal_receive_lsn()`
 * - `SELECT pg_last_wal_replay_lsn()`
 * - `SELECT pg_is_in_recovery()`
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a replication lag operation
 *
 * @example
 * ```ts
 * detectReplLag('SELECT * FROM pg_stat_replication;');                         // true
 * detectReplLag("SELECT pg_wal_lsn_diff('0/0', '0/0');");                      // true
 * detectReplLag('SELECT pg_current_wal_lsn();');                               // true
 * detectReplLag('SELECT pg_last_wal_receive_lsn();');                          // true
 * detectReplLag('SELECT pg_last_wal_replay_lsn();');                           // true
 * detectReplLag('SELECT pg_is_in_recovery();');                                // true
 * detectReplLag('SELECT 1;');                                                  // false
 * detectReplLag('CREATE TABLE t (id INT);');                                   // false
 * ```
 */
export function detectReplLag(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Check SELECT ... FROM pg_stat_replication
  if (QUERY_STAT_REPLICATION.test(trimmed)) {
    return true;
  }

  // Check SELECT pg_wal_lsn_diff(...)
  if (SELECT_WAL_LSN_DIFF.test(trimmed)) {
    return true;
  }

  // Check SELECT pg_current_wal_lsn()
  if (SELECT_CURRENT_WAL_LSN.test(trimmed)) {
    return true;
  }

  // Check SELECT pg_last_wal_receive_lsn()
  if (SELECT_LAST_WAL_RECEIVE_LSN.test(trimmed)) {
    return true;
  }

  // Check SELECT pg_last_wal_replay_lsn()
  if (SELECT_LAST_WAL_REPLAY_LSN.test(trimmed)) {
    return true;
  }

  // Check SELECT pg_is_in_recovery()
  if (SELECT_IS_IN_RECOVERY.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL replication lag monitoring SQL statement to a
 * SQLite-compatible no-op placeholder.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not a replication-lag operation, return unchanged with
 *    `rewritten: false`.
 * 2. If it is `SELECT ... FROM pg_stat_replication`, return
 *    `SELECT 1 AS pid, '' AS application_name, 'streaming' AS state`
 *    (a single-row result that mimics a single replication connection in
 *    streaming state) with `rewritten: true`.
 * 3. If it is `SELECT pg_wal_lsn_diff(...)`, delegate to
 *    {@link WALStateManager.lsnDiff} and return the actual difference
 *    with `rewritten: true`.
 * 4. If it is `SELECT pg_current_wal_lsn()`, delegate to
 *    {@link WALStateManager.getCurrentLSN} and return the actual LSN
 *    with `rewritten: true`.
 * 5. If it is `SELECT pg_last_wal_receive_lsn()`, delegate to
 *    {@link WALStateManager.getLastReceiveLSN} and return the actual LSN
 *    with `rewritten: true`.
 * 6. If it is `SELECT pg_last_wal_replay_lsn()`, delegate to
 *    {@link WALStateManager.getLastReplayLSN} and return the actual LSN
 *    with `rewritten: true`.
 * 7. If it is `SELECT pg_is_in_recovery()`, return `SELECT false`
 *    (SQLite is never in recovery because it has no replication) with
 *    `rewritten: true`.
 * 8. Otherwise, pass through unchanged.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link ReplLagResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteReplLag('SELECT * FROM pg_stat_replication;');
 * // → { sql: "SELECT 1 AS pid, '' AS application_name, 'streaming' AS state", rewritten: true }
 *
 * rewriteReplLag("SELECT pg_wal_lsn_diff('0/1000000', '0/0');");
 * // → { sql: 'SELECT 16777216', rewritten: true }
 *
 * rewriteReplLag('SELECT pg_current_wal_lsn();');
 * // → { sql: "SELECT '0/1000000'", rewritten: true }
 *
 * rewriteReplLag('SELECT pg_last_wal_receive_lsn();');
 * // → { sql: "SELECT '0/0'", rewritten: true }  // LSN from WALStateManager
 *
 * rewriteReplLag('SELECT pg_last_wal_replay_lsn();');
 * // → { sql: "SELECT '0/0'", rewritten: true }  // LSN from WALStateManager
 *
 * rewriteReplLag('SELECT pg_is_in_recovery();');
 * // → { sql: 'SELECT false', rewritten: true }
 *
 * rewriteReplLag('SELECT 1;');
 * // → { sql: 'SELECT 1;', rewritten: false }
 * ```
 */
export function rewriteReplLag(sql: string): ReplLagResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Check SELECT ... FROM pg_stat_replication ─────────

  if (QUERY_STAT_REPLICATION.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'pg_stat_replication query detected — rewriting to placeholder row',
    );
    return {
      sql:
        "SELECT 1 AS pid, '' AS application_name, 'streaming' AS state, '' AS client_addr, 0 AS replay_lag",
      rewritten: true,
    };
  }

  // ── Step 2: Check SELECT pg_wal_lsn_diff(...) ─────────────────

  if (SELECT_WAL_LSN_DIFF.test(trimmed)) {
    // Extract the two LSN arguments
    const lsnMatch = trimmed.match(/pg_wal_lsn_diff\s*\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/i);
    if (lsnMatch) {
      const diff = wsm.lsnDiff(lsnMatch[1], lsnMatch[2]);
      logger.debug(
        { sql: trimmed, lsn1: lsnMatch[1], lsn2: lsnMatch[2], diff },
        'pg_wal_lsn_diff detected — computing actual difference',
      );
      return {
        sql: `SELECT ${diff}`,
        rewritten: true,
      };
    }
    logger.debug(
      { sql: trimmed },
      'pg_wal_lsn_diff detected — could not extract LSNs, using 0',
    );
    return {
      sql: 'SELECT 0',
      rewritten: true,
    };
  }

  // ── Step 3: Check SELECT pg_current_wal_lsn() ────────────────

  if (SELECT_CURRENT_WAL_LSN.test(trimmed)) {
    const lsn = wsm.getCurrentLSN();
    logger.debug(
      { sql: trimmed, lsn },
      'pg_current_wal_lsn detected — returning actual LSN',
    );
    return {
      sql: `SELECT '${lsn}'`,
      rewritten: true,
    };
  }

  // ── Step 4: Check SELECT pg_last_wal_receive_lsn() ───────────

  if (SELECT_LAST_WAL_RECEIVE_LSN.test(trimmed)) {
    const lsn = wsm.getLastReceiveLSN();
    logger.debug(
      { sql: trimmed, lsn },
      'pg_last_wal_receive_lsn detected — returning real LSN',
    );
    return {
      sql: `SELECT '${lsn}'`,
      rewritten: true,
    };
  }

  // ── Step 5: Check SELECT pg_last_wal_replay_lsn() ────────────

  if (SELECT_LAST_WAL_REPLAY_LSN.test(trimmed)) {
    const lsn = wsm.getLastReplayLSN();
    logger.debug(
      { sql: trimmed, lsn },
      'pg_last_wal_replay_lsn detected — returning real LSN',
    );
    return {
      sql: `SELECT '${lsn}'`,
      rewritten: true,
    };
  }

  // ── Step 6: Check SELECT pg_is_in_recovery() ─────────────────

  if (SELECT_IS_IN_RECOVERY.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'pg_is_in_recovery detected — rewriting to SELECT false (SQLite never in recovery)',
    );
    return {
      sql: 'SELECT false',
      rewritten: true,
    };
  }

  // ── Step 7: Not a replication-lag operation — pass through ────

  return {
    sql: trimmed,
    rewritten: false,
  };
}
