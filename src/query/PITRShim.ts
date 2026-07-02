/**
 * PITRShim — PostgreSQL Point-In-Time Recovery compatibility shim for SQLite.
 *
 * PostgreSQL provides a set of functions for managing WAL-based point-in-time
 * recovery (PITR):
 *
 * ```sql
 * SELECT pg_create_restore_point('name');  -- Create a named restore point
 * SELECT pg_wal_replay_pause();             -- Pause WAL replay (standby)
 * SELECT pg_wal_replay_resume();            -- Resume WAL replay (standby)
 * SELECT * FROM pg_backup_label;            -- Query current backup label
 * ```
 *
 * SQLite has no WAL archiving or PITR mechanism. Since sqlvec-db uses
 * SQLite under the hood, these PostgreSQL-specific PITR management functions
 * are unnecessary and can be safely rewritten to no-ops that produce valid
 * SQLite-compatible results.
 *
 * ## Strategy
 *
 * | Input                                                           | Output                              | rewritten |
 * |-----------------------------------------------------------------|-------------------------------------|-----------|
 * | `SELECT pg_create_restore_point('my_label')`                    | `SELECT '<lsn>' as lsn`                   | true      |
 * | `select pg_create_restore_point('x')`                           | `SELECT '<lsn>' as lsn`                   | true      |
 * | `SELECT PG_CREATE_RESTORE_POINT('x')`                           | `SELECT '<lsn>' as lsn`                   | true      |
 * | `SELECT pg_wal_replay_pause()`                                  | `SELECT 1` (state updated)          | true      |
 * | `SELECT pg_wal_replay_resume()`                                 | `SELECT 1` (state updated)          | true      |
 * | `SELECT * FROM pg_backup_label`                                 | `SELECT 'label' as label`           | true      |
 * | `select * from pg_backup_label`                                 | `SELECT 'label' as label`           | true      |
 * | `SELECT * FROM pg_backup_label WHERE label = 'x'`               | `SELECT 'label' as label`           | true      |
 * | `SELECT 1`                                                      | (pass-through)                      | false     |
 * | `CREATE TABLE t (id INT)`                                       | (pass-through)                      | false     |
 * | `SELECT pg_create_restore_point FROM dual;` (column ref)        | (pass-through — not a call)         | false     |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-PITR SQL
 * - Case-insensitive matching for function names and keywords
 * - PinoLogger integration for debugging and audit trails
 *
 * @module PITRShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { WALStateManager } from '../storage/WALStateManager';

const logger = PinoLogger.forComponent('PITRShim');
const wsm = WALStateManager.getInstance();

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface PITRResult {
  /** Rewritten SQL (rewritten version if rewritten, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as PITR-related and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches `SELECT pg_create_restore_point('name')` with a string literal
 * argument.
 *
 * PostgreSQL syntax:
 *   SELECT pg_create_restore_point('restore_point_name')
 *
 * The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Matches the function call specifically (not a bare column reference)
 * - The single-quoted argument is captured but not needed for the rewrite
 * - Allows optional whitespace around parentheses
 * - Allows optional trailing semicolon
 */
const CREATE_RESTORE_POINT = /^\s*SELECT\s+pg_create_restore_point\s*\(\s*'[^']*'\s*\)\s*;?\s*$/i;

/**
 * Matches `SELECT pg_wal_replay_pause()` with no arguments.
 *
 * PostgreSQL syntax:
 *   SELECT pg_wal_replay_pause()
 *
 * The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Requires empty parentheses (function call, no args)
 * - Allows optional whitespace inside parentheses
 * - Allows optional trailing semicolon
 */
const WAL_REPLAY_PAUSE = /^\s*SELECT\s+pg_wal_replay_pause\s*\(\s*\)\s*;?\s*$/i;

/**
 * Matches `SELECT pg_wal_replay_resume()` with no arguments.
 *
 * PostgreSQL syntax:
 *   SELECT pg_wal_replay_resume()
 *
 * Same pattern structure as WAL_REPLAY_PAUSE.
 * Case-insensitive, allows leading whitespace and optional semicolon.
 */
const WAL_REPLAY_RESUME = /^\s*SELECT\s+pg_wal_replay_resume\s*\(\s*\)\s*;?\s*$/i;

/**
 * Matches `SELECT ... FROM pg_backup_label`.
 *
 * PostgreSQL syntax:
 *   SELECT * FROM pg_backup_label
 *   SELECT label, start_time FROM pg_backup_label
 *   SELECT * FROM pg_backup_label WHERE ...
 *
 * The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Handles any SELECT columns and any optional WHERE/ORDER BY clauses
 * - Targets the `pg_backup_label` system relation
 */
const QUERY_BACKUP_LABEL = /^\s*SELECT\b[\s\S]*?\bFROM\s+(?:pg_catalog\.)?pg_backup_label\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL PITR management
 * operation.
 *
 * The following patterns are detected:
 * - `SELECT pg_create_restore_point('name')`
 * - `SELECT pg_wal_replay_pause()`
 * - `SELECT pg_wal_replay_resume()`
 * - `SELECT ... FROM pg_backup_label`
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a PITR operation
 *
 * @example
 * ```ts
 * detectPITR("SELECT pg_create_restore_point('my_point');");     // true
 * detectPITR("SELECT pg_wal_replay_pause();");                     // true
 * detectPITR("SELECT pg_wal_replay_resume();");                    // true
 * detectPITR("SELECT * FROM pg_backup_label;");                    // true
 * detectPITR("SELECT 1;");                                         // false
 * detectPITR("CREATE TABLE t (id INT);");                          // false
 * ```
 */
export function detectPITR(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Check for pg_create_restore_point('name')
  if (CREATE_RESTORE_POINT.test(trimmed)) {
    return true;
  }

  // Check for pg_wal_replay_pause()
  if (WAL_REPLAY_PAUSE.test(trimmed)) {
    return true;
  }

  // Check for pg_wal_replay_resume()
  if (WAL_REPLAY_RESUME.test(trimmed)) {
    return true;
  }

  // Check for SELECT ... FROM pg_backup_label
  if (QUERY_BACKUP_LABEL.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL PITR management SQL statement to a SQLite-compatible
 * no-op.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not a PITR operation, return unchanged with
 *    `rewritten: false`.
 * 2. If it is `SELECT pg_create_restore_point('name')`, extract the
 *    restore point name, delegate to {@link WALStateManager.createRestorePoint},
 *    and return the actual LSN as `SELECT '<lsn>' as lsn` with
 *    `rewritten: true`.
 * 3. If it is `SELECT pg_wal_replay_pause()`, update
 *    {@link WALStateManager} to paused state and return `SELECT 1`
 *    with `rewritten: true`.
 * 4. If it is `SELECT pg_wal_replay_resume()`, update
 *    {@link WALStateManager} to resumed state and return `SELECT 1`
 *    with `rewritten: true`.
 * 5. If it is `SELECT ... FROM pg_backup_label`, return
 *    `SELECT 'label' as label` (providing a single-row, single-column
 *    result) with `rewritten: true`.
 * 6. Otherwise, pass through unchanged.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link PITRResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewritePITR("SELECT pg_create_restore_point('my_point');");
 * // → { sql: "SELECT '0/1000000' as lsn", rewritten: true }
 * // (LSN from WALStateManager.createRestorePoint)
 *
 * rewritePITR("SELECT pg_wal_replay_pause();");
 * // → { sql: 'SELECT 1', rewritten: true }
 * // WALStateManager.replayPaused is now true
 *
 * rewritePITR("SELECT pg_wal_replay_resume();");
 * // → { sql: 'SELECT 1', rewritten: true }
 * // WALStateManager.replayPaused is now false
 *
 * rewritePITR("SELECT * FROM pg_backup_label;");
 * // → { sql: "SELECT 'label' as label", rewritten: true }
 *
 * rewritePITR("SELECT 1;");
 * // → { sql: 'SELECT 1;', rewritten: false }
 * ```
 */
export function rewritePITR(sql: string): PITRResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Check for pg_create_restore_point ─────────────────

  if (CREATE_RESTORE_POINT.test(trimmed)) {
    // Extract the restore point name from the function call
    const nameMatch = trimmed.match(/pg_create_restore_point\s*\(\s*'([^']*)'\s*\)/i);
    const pointName = nameMatch ? nameMatch[1] : 'restore_point';
    const lsn = wsm.createRestorePoint(pointName);
    logger.debug(
      { sql: trimmed, pointName, lsn },
      'pg_create_restore_point detected — creating restore point with real LSN',
    );
    return {
      sql: `SELECT '${lsn}' as lsn`,
      rewritten: true,
    };
  }

  // ── Step 2: Check for pg_wal_replay_pause ─────────────────────

  if (WAL_REPLAY_PAUSE.test(trimmed)) {
    wsm.setReplayPaused(true);
    logger.debug(
      { sql: trimmed },
      'pg_wal_replay_pause detected — state updated to paused',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 3: Check for pg_wal_replay_resume ────────────────────

  if (WAL_REPLAY_RESUME.test(trimmed)) {
    wsm.setReplayPaused(false);
    logger.debug(
      { sql: trimmed },
      'pg_wal_replay_resume detected — state updated to resumed',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 4: Check for SELECT ... FROM pg_backup_label ─────────

  if (QUERY_BACKUP_LABEL.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'pg_backup_label query detected — rewriting to SELECT label placeholder',
    );
    return {
      sql: "SELECT 'label' as label",
      rewritten: true,
    };
  }

  // ── Step 5: Not a PITR operation — pass through ───────────────

  return {
    sql: trimmed,
    rewritten: false,
  };
}
