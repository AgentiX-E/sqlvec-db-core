/**
 * SyncReplShim — PostgreSQL synchronous replication compatibility shim for
 * SQLite.
 *
 * PostgreSQL supports synchronous replication via the
 * `synchronous_standby_names` GUC parameter, along with system catalogs
 * like `pg_stat_replication.sync_state` and functions like
 * `pg_sync_replication_status()`. SQLite has no replication concept — it
 * is single-node by design. This shim detects synchronous-replication SQL
 * and rewrites each variant to a valid SQLite-compatible result, reading
 * real standby node names from the `SYNC_STANDBY_NAMES` environment
 * variable when available.
 *
 * ## Strategy
 *
 * | Input                                                        | Output                                         | rewritten |
 * |--------------------------------------------------------------|-------------------------------------------------|-----------|
 * | `SET synchronous_standby_names = '...'`                      | `SELECT 1`                                      | true      |
 * | `SHOW synchronous_standby_names`                             | `SELECT '<env>' AS synchronous_standby_names`   | true      |
 * | `SELECT sync_state FROM pg_stat_replication`                 | `SELECT '' AS sync_state`                       | true      |
 * | `SELECT pg_sync_replication_status()`                        | `SELECT 'async'`                                | true      |
 * | `SELECT 1;`                                                  | (pass-through)                                  | false     |
 * | `CREATE TABLE t (id INT);`                                   | (pass-through)                                  | false     |
 *
 * @module SyncReplShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { SyncReplicationManager, SyncReplMode } from '../replication/SyncReplicationManager';

const logger = PinoLogger.forComponent('SyncReplShim');

// ──────────────────────────────────────────────
//  Global instance (set during app bootstrap)
// ──────────────────────────────────────────────

let globalSyncReplManager: SyncReplicationManager | null = null;

/**
 * Set the global SyncReplicationManager instance for use by the shim.
 * Must be called during application startup.
 */
export function setSyncReplicationManager(mgr: SyncReplicationManager): void {
  globalSyncReplManager = mgr;
}

/**
 * Get the global SyncReplicationManager instance.
 */
export function getSyncReplicationManager(): SyncReplicationManager | null {
  return globalSyncReplManager;
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface SyncReplResult {
  /** Rewritten SQL (placeholder if rewritten, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as a sync-replication operation and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches `SET synchronous_standby_names = '...'` as a top-level statement.
 *
 * Covers:
 *   SET synchronous_standby_names = '...'
 *   SET SESSION synchronous_standby_names = '...'
 *   SET LOCAL synchronous_standby_names = '...'
 *   SET synchronous_standby_names TO '...'
 *
 * Pattern: SET [SESSION|LOCAL] synchronous_standby_names =|TO 'value'
 * Case-insensitive.
 */
const SET_SYNC_STANDBY_NAMES =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?synchronous_standby_names\s*(?:[=:]\s*|\s+TO\s+).+?;?\s*$/i;

/**
 * Matches `SHOW synchronous_standby_names` as a top-level statement.
 *
 * Covers:
 *   SHOW synchronous_standby_names
 *   SHOW synchronous_standby_names;
 *
 * Pattern: SHOW synchronous_standby_names
 * Case-insensitive.
 */
const SHOW_SYNC_STANDBY_NAMES =
  /^\s*SHOW\s+synchronous_standby_names\s*;?\s*$/i;

/**
 * Matches `SELECT ... sync_state [FROM ... pg_stat_replication]`.
 *
 * Covers:
 *   SELECT sync_state FROM pg_stat_replication
 *   SELECT sync_state FROM pg_catalog.pg_stat_replication
 *   SELECT pid, sync_state, ... FROM pg_stat_replication
 *   SELECT ... sync_state ... FROM pg_stat_replication
 *
 * Pattern: SELECT ... sync_state ... FROM [pg_catalog.]pg_stat_replication
 * Case-insensitive.
 */
const SELECT_SYNC_STATE =
  /^\s*SELECT\b[\s\S]*?\bsync_state\b[\s\S]*?\bFROM\s+(?:pg_catalog\.)?pg_stat_replication\b/i;

/**
 * Matches `SELECT pg_sync_replication_status()` as a top-level statement.
 *
 * Pattern: SELECT pg_sync_replication_status()
 * Case-insensitive.
 */
const SELECT_SYNC_REPL_STATUS =
  /^\s*SELECT\s+pg_sync_replication_status\s*\(/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL synchronous
 * replication operation.
 *
 * The following patterns are detected:
 * - `SET synchronous_standby_names = '...'`
 * - `SHOW synchronous_standby_names`
 * - `SELECT ... sync_state FROM pg_stat_replication`
 * - `SELECT pg_sync_replication_status()`
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a synchronous replication operation
 *
 * @example
 * ```ts
 * detectSyncRepl("SET synchronous_standby_names = 's1,s2'");  // true
 * detectSyncRepl('SHOW synchronous_standby_names');           // true
 * detectSyncRepl('SELECT sync_state FROM pg_stat_replication'); // true
 * detectSyncRepl('SELECT pg_sync_replication_status()');      // true
 * detectSyncRepl('SELECT 1;');                                // false
 * detectSyncRepl('CREATE TABLE t (id INT);');                 // false
 * ```
 */
export function detectSyncRepl(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Check SET synchronous_standby_names = '...'
  if (SET_SYNC_STANDBY_NAMES.test(trimmed)) {
    return true;
  }

  // Check SHOW synchronous_standby_names
  if (SHOW_SYNC_STANDBY_NAMES.test(trimmed)) {
    return true;
  }

  // Check SELECT ... sync_state FROM pg_stat_replication
  if (SELECT_SYNC_STATE.test(trimmed)) {
    return true;
  }

  // Check SELECT pg_sync_replication_status()
  if (SELECT_SYNC_REPL_STATUS.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL synchronous replication SQL statement to a SQLite-
 * compatible placeholder.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not a sync-replication operation, return unchanged with
 *    `rewritten: false`.
 * 2. If it is `SET synchronous_standby_names = '...'`, return `SELECT 1`
 *    (a no-op placeholder) with `rewritten: true`.
 * 3. If it is `SHOW synchronous_standby_names`, return
 *    `SELECT '' AS synchronous_standby_names` (empty string placeholder)
 *    with `rewritten: true`.
 * 4. If it is `SELECT ... sync_state FROM pg_stat_replication`, return
 *    `SELECT '' AS sync_state` (empty string placeholder) with
 *    `rewritten: true`.
 * 5. If it is `SELECT pg_sync_replication_status()`, return
 *    `SELECT 'async'` (SQLite runs asynchronously, single-node) with
 *    `rewritten: true`.
 * 6. Otherwise, pass through unchanged.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link SyncReplResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteSyncRepl("SET synchronous_standby_names = 's1,s2'");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteSyncRepl('SHOW synchronous_standby_names');
 * // → { sql: "SELECT '' AS synchronous_standby_names", rewritten: true }
 *
 * rewriteSyncRepl('SELECT sync_state FROM pg_stat_replication');
 * // → { sql: "SELECT '' AS sync_state", rewritten: true }
 *
 * rewriteSyncRepl('SELECT pg_sync_replication_status()');
 * // → { sql: "SELECT 'async'", rewritten: true }
 *
 * rewriteSyncRepl('SELECT 1;');
 * // → { sql: 'SELECT 1;', rewritten: false }
 * ```
 */
export function rewriteSyncRepl(sql: string): SyncReplResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Check SET synchronous_standby_names ─────────────

  if (SET_SYNC_STANDBY_NAMES.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SET synchronous_standby_names detected — rewriting to SELECT 1 (no-op)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 2: Check SHOW synchronous_standby_names ───────────

  if (SHOW_SYNC_STANDBY_NAMES.test(trimmed)) {
    // Use real SyncReplicationManager if available, fall back to env variable
    let standbyNames: string;
    if (globalSyncReplManager) {
      standbyNames = globalSyncReplManager.getStandbyNamesString();
    } else {
      standbyNames = process.env.SYNC_STANDBY_NAMES || '';
    }
    const escaped = standbyNames.replace(/'/g, "''");
    logger.debug(
      { sql: trimmed, standbyNames },
      'SHOW synchronous_standby_names — returning value',
    );
    return {
      sql: `SELECT '${escaped}' AS synchronous_standby_names`,
      rewritten: true,
    };
  }

  // ── Step 3: Check SELECT ... sync_state FROM pg_stat_replication ──

  if (SELECT_SYNC_STATE.test(trimmed)) {
    // Use real SyncReplicationManager if available
    if (globalSyncReplManager) {
      const syncState = globalSyncReplManager.getSyncState();
      logger.debug(
        { sql: trimmed, syncState },
        'SELECT sync_state FROM pg_stat_replication — returning real sync state',
      );
      return {
        sql: `SELECT '${syncState}' AS sync_state`,
        rewritten: true,
      };
    }
    logger.debug(
      { sql: trimmed },
      'SELECT sync_state FROM pg_stat_replication detected — rewriting to empty placeholder',
    );
    return {
      sql: "SELECT '' AS sync_state",
      rewritten: true,
    };
  }

  // ── Step 4: Check SELECT pg_sync_replication_status() ──────

  if (SELECT_SYNC_REPL_STATUS.test(trimmed)) {
    // Use real SyncReplicationManager if available
    if (globalSyncReplManager) {
      const syncState = globalSyncReplManager.getSyncState();
      logger.debug(
        { sql: trimmed, syncState },
        'pg_sync_replication_status detected — returning real state',
      );
      return {
        sql: `SELECT '${syncState}'`,
        rewritten: true,
      };
    }
    logger.debug(
      { sql: trimmed },
      'pg_sync_replication_status detected — rewriting to \'async\' (SQLite single-node)',
    );
    return {
      sql: "SELECT 'async'",
      rewritten: true,
    };
  }

  // ── Step 5: Not a sync-replication operation — pass through ─

  return {
    sql: trimmed,
    rewritten: false,
  };
}
