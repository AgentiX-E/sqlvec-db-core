/**
 * WALArchiveShim — PostgreSQL WAL archiving configuration compatibility shim
 * for SQLite.
 *
 * PostgreSQL uses Write-Ahead Log (WAL) archiving to support point-in-time
 * recovery (PITR) and replication.  Administrators configure archiving
 * through several GUC parameters and query archive-related information
 * via dedicated functions:
 *
 * ```sql
 * SET archive_mode = on;
 * SET archive_command = 'cp %p /archive/%f';
 * SET archive_timeout = 60;
 * SHOW archive_mode;
 * SHOW archive_command;
 * SHOW archive_timeout;
 * SELECT pg_walfile_name('0/ABCDEF');
 * SELECT pg_walfile_name_offset('0/ABCDEF');
 * ```
 *
 * SQLite has no WAL archiving mechanism — its WAL mode is purely for
 * concurrent read/write support, not for PITR or replication.  This shim
 * detects WAL-archive-related SQL and rewrites each variant to a valid
 * SQLite-compatible no-op that returns a sensible placeholder result.
 *
 * > **Note:** `pg_switch_wal()`, `pg_current_wal_lsn()`,
 * > `pg_wal_replay_pause()` and related functions are handled in
 * > `HAPromotionShim`, `ReplicationLagShim`, and `PITRShim` respectively.
 * > This shim covers only the **WAL archiving configuration** surface.
 *
 * ## Strategy
 *
 * | Input (case-insensitive)                                         | Output                                                  | Rewritten |
 * |------------------------------------------------------------------|---------------------------------------------------------|-----------|
 * | `SET archive_mode = on`                                          | `SELECT 1` (state updated)                              | true      |
 * | `SET archive_mode = off`                                         | `SELECT 1` (state updated)                              | true      |
 * | `SET archive_command = '...'`                                    | `SELECT 1` (state updated)                              | true      |
 * | `SET archive_timeout = 60`                                       | `SELECT 1` (state updated)                              | true      |
 * | `SELECT pg_walfile_name('0/ABCDEF')`                             | `SELECT '<file_name>' as file_name`                     | true      |
 * | `SELECT pg_walfile_name_offset('0/ABCDEF')`                      | `SELECT '<file_name>' as file_name, <off> as file_offset`| true      |
 * | `SHOW archive_mode`                                              | `SELECT 'on|off' as archive_mode`                       | true      |
 * | `SHOW archive_command`                                           | `SELECT '<cmd>' as archive_command`                     | true      |
 * | `SHOW archive_timeout`                                           | `SELECT '<N>' as archive_timeout`                       | true      |
 * | `SELECT 1`                                                       | (pass-through)                                          | false     |
 * | `CREATE TABLE t (id INT)`                                        | (pass-through)                                          | false     |
 * | `SELECT pg_walfile_name FROM t` (column ref, not a call)         | (pass-through)                                          | false     |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-WAL-archive SQL
 * - Case-insensitive matching for SET/SHOW/function keywords
 * - PinoLogger integration for debugging and audit trails
 *
 * @module WALArchiveShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { WALStateManager } from '../storage/WALStateManager';

const logger = PinoLogger.forComponent('WALArchiveShim');
const wsm = WALStateManager.getInstance();

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface WALArchiveResult {
  /** Rewritten SQL (rewritten version if rewritten, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as WAL-archive-related and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches `SET archive_mode = on|off` or `SET archive_mode TO on|off`.
 *
 * PostgreSQL GUC syntax:
 *   SET archive_mode = on;
 *   SET archive_mode TO 'on';
 *   SET archive_mode = off;
 *
 * The pattern:
 * - Case-insensitive
 * - Allows leading whitespace (but not consumed outside the anchor)
 * - Accepts both `=` and `TO` assignment syntax
 * - Accepts optional single quotes around the value (PG allows both forms)
 * - Allows optional trailing semicolon
 */
const SET_ARCHIVE_MODE = /^\s*SET\s+archive_mode\s+(?:=|TO)\s+['"]?(?:on|off|true|false|0|1)['"]?\s*;?\s*$/i;

/**
 * Matches `SET archive_command = '...'` or `SET archive_command TO '...'`.
 *
 * PostgreSQL GUC syntax:
 *   SET archive_command = 'cp %p /archive/%f';
 *   SET archive_command TO '';
 *
 * The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Accepts both `=` and `TO` assignment syntax
 * - Accepts a quoted string value (single or double quotes)
 * - Also accepts an unquoted single-quoted string
 * - Allows optional trailing semicolon
 */
const SET_ARCHIVE_COMMAND = /^\s*SET\s+archive_command\s+(?:=|TO)\s+'.*?'\s*;?\s*$/i;

/**
 * Matches `SET archive_timeout = N` or `SET archive_timeout TO N`.
 *
 * PostgreSQL GUC syntax:
 *   SET archive_timeout = 60;
 *   SET archive_timeout TO '60';
 *   SET archive_timeout = 0;
 *
 * The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Accepts both `=` and `TO` assignment syntax
 * - Accepts an integer value (optionally quoted)
 * - Allows optional trailing semicolon
 */
const SET_ARCHIVE_TIMEOUT = /^\s*SET\s+archive_timeout\s+(?:=|TO)\s+['"]?\d+['"]?\s*;?\s*$/i;

/**
 * Matches `SELECT pg_walfile_name('lsn')` with a string literal argument.
 *
 * PostgreSQL syntax:
 *   SELECT pg_walfile_name('0/ABCDEF');
 *   SELECT pg_walfile_name(pg_current_wal_lsn()); -- (sub-expression not handled here)
 *
 * The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Matches the function call specifically (not a bare column reference)
 * - Requires at least one argument inside parentheses
 * - Allows optional whitespace around parentheses
 * - Allows optional trailing semicolon
 */
const WALFILE_NAME = /^\s*SELECT\s+pg_walfile_name\s*\(\s*.+?\s*\)\s*;?\s*$/i;

/**
 * Matches `SELECT pg_walfile_name_offset('lsn')` with a string literal
 * argument.
 *
 * PostgreSQL syntax:
 *   SELECT pg_walfile_name_offset('0/ABCDEF');
 *
 * The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Matches the function call specifically (not a bare column reference)
 * - Requires at least one argument inside parentheses
 * - Allows optional whitespace around parentheses
 * - Allows optional trailing semicolon
 */
const WALFILE_NAME_OFFSET = /^\s*SELECT\s+pg_walfile_name_offset\s*\(\s*.+?\s*\)\s*;?\s*$/i;

/**
 * Matches `SHOW archive_mode`.
 *
 * PostgreSQL syntax:
 *   SHOW archive_mode;
 *
 * The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Targets exactly `SHOW archive_mode`
 * - Allows optional trailing semicolon
 */
const SHOW_ARCHIVE_MODE = /^\s*SHOW\s+archive_mode\s*;?\s*$/i;

/**
 * Matches `SHOW archive_command`.
 *
 * PostgreSQL syntax:
 *   SHOW archive_command;
 *
 * The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Targets exactly `SHOW archive_command`
 * - Allows optional trailing semicolon
 */
const SHOW_ARCHIVE_COMMAND = /^\s*SHOW\s+archive_command\s*;?\s*$/i;

/**
 * Matches `SHOW archive_timeout`.
 *
 * PostgreSQL syntax:
 *   SHOW archive_timeout;
 *
 * The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Targets exactly `SHOW archive_timeout`
 * - Allows optional trailing semicolon
 */
const SHOW_ARCHIVE_TIMEOUT = /^\s*SHOW\s+archive_timeout\s*;?\s*$/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL WAL archiving
 * configuration operation.
 *
 * The following patterns are detected:
 * - `SET archive_mode = on|off`
 * - `SET archive_command = '...'`
 * - `SET archive_timeout = N`
 * - `SELECT pg_walfile_name('lsn')`
 * - `SELECT pg_walfile_name_offset('lsn')`
 * - `SHOW archive_mode`
 * - `SHOW archive_command`
 * - `SHOW archive_timeout`
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a WAL archive operation
 *
 * @example
 * ```ts
 * detectWALArchive("SET archive_mode = on;");                    // true
 * detectWALArchive("SET archive_command = 'cp %p /a/%f';");      // true
 * detectWALArchive("SET archive_timeout = 60;");                 // true
 * detectWALArchive("SELECT pg_walfile_name('0/ABCDEF');");       // true
 * detectWALArchive("SELECT pg_walfile_name_offset('0/ABCDEF');");// true
 * detectWALArchive("SHOW archive_mode;");                        // true
 * detectWALArchive("SHOW archive_command;");                     // true
 * detectWALArchive("SHOW archive_timeout;");                    // true
 * detectWALArchive("SELECT 1;");                                // false
 * detectWALArchive("CREATE TABLE t (id INT);");                 // false
 * ```
 */
export function detectWALArchive(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Check SET archive_mode = on/off
  if (SET_ARCHIVE_MODE.test(trimmed)) {
    return true;
  }

  // Check SET archive_command = '...'
  if (SET_ARCHIVE_COMMAND.test(trimmed)) {
    return true;
  }

  // Check SET archive_timeout = N
  if (SET_ARCHIVE_TIMEOUT.test(trimmed)) {
    return true;
  }

  // Check SELECT pg_walfile_name('lsn')
  if (WALFILE_NAME.test(trimmed)) {
    return true;
  }

  // Check SELECT pg_walfile_name_offset('lsn')
  if (WALFILE_NAME_OFFSET.test(trimmed)) {
    return true;
  }

  // Check SHOW archive_mode
  if (SHOW_ARCHIVE_MODE.test(trimmed)) {
    return true;
  }

  // Check SHOW archive_command
  if (SHOW_ARCHIVE_COMMAND.test(trimmed)) {
    return true;
  }

  // Check SHOW archive_timeout
  if (SHOW_ARCHIVE_TIMEOUT.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL WAL archiving configuration SQL statement to a
 * SQLite-compatible no-op.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not a WAL archive operation, return unchanged with
 *    `rewritten: false`.
 * 2. If it is `SET archive_mode = on|off`, update {@link WALStateManager}
 *    and return `SELECT 1` with `rewritten: true`.
 * 3. If it is `SET archive_command = '...'`, update {@link WALStateManager}
 *    and return `SELECT 1` with `rewritten: true`.
 * 4. If it is `SET archive_timeout = N`, update {@link WALStateManager}
 *    and return `SELECT 1` with `rewritten: true`.
 * 5. If it is `SELECT pg_walfile_name('lsn')`, delegate to
 *    {@link WALStateManager.lsnToFileName} and return the real file name
 *    with `rewritten: true`.
 * 6. If it is `SELECT pg_walfile_name_offset('lsn')`, delegate to
 *    {@link WALStateManager.lsnToFileOffset} and return the real file name
 *    and offset with `rewritten: true`.
 * 7. If it is `SHOW archive_mode`, delegate to
 *    {@link WALStateManager.getArchiveMode} and return the actual value
 *    with `rewritten: true`.
 * 8. If it is `SHOW archive_command`, delegate to
 *    {@link WALStateManager.getArchiveCommand} and return the actual value
 *    with `rewritten: true`.
 * 9. If it is `SHOW archive_timeout`, delegate to
 *    {@link WALStateManager.getArchiveTimeout} and return the actual value
 *    with `rewritten: true`.
 * 10. Otherwise, pass through unchanged.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link WALArchiveResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteWALArchive("SET archive_mode = on;");
 * // → { sql: 'SELECT 1', rewritten: true }
 * // WALStateManager.archiveMode is now 'on'
 *
 * rewriteWALArchive("SET archive_command = 'cp %p /a/%f';");
 * // → { sql: 'SELECT 1', rewritten: true }
 * // WALStateManager.archiveCommand is now 'cp %p /a/%f'
 *
 * rewriteWALArchive("SET archive_timeout = 60;");
 * // → { sql: 'SELECT 1', rewritten: true }
 * // WALStateManager.archiveTimeout is now 60
 *
 * rewriteWALArchive("SELECT pg_walfile_name('0/1000000');");
 * // → { sql: "SELECT '000000010000000000000001' as file_name", rewritten: true }
 *
 * rewriteWALArchive("SELECT pg_walfile_name_offset('0/1000000');");
 * // → { sql: "SELECT '000000010000000000000001' as file_name, 0 as file_offset", rewritten: true }
 *
 * rewriteWALArchive("SHOW archive_mode;");
 * // → { sql: "SELECT 'on' as archive_mode", rewritten: true }
 *
 * rewriteWALArchive("SHOW archive_command;");
 * // → { sql: "SELECT 'cp %p /a/%f' as archive_command", rewritten: true }
 *
 * rewriteWALArchive("SHOW archive_timeout;");
 * // → { sql: "SELECT '60' as archive_timeout", rewritten: true }
 *
 * rewriteWALArchive("SELECT 1;");
 * // → { sql: 'SELECT 1;', rewritten: false }
 * ```
 */
export function rewriteWALArchive(sql: string): WALArchiveResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: SET archive_mode = on/off ─────────────────────────

  if (SET_ARCHIVE_MODE.test(trimmed)) {
    // Extract the value. The outer regex accepts on|off|true|false|0|1, so
    // normalize each synonym to its canonical boolean: on/true/1 -> 'on',
    // off/false/0 -> 'off'. Without this, `SET archive_mode = 1` (valid PG
    // shorthand for "on") fell through to the default 'off'.
    const modeMatch = trimmed.match(/['"]?(on|off|true|false|0|1)['"]?/i);
    /* c8 ignore next — modeMatch always matches once SET_ARCHIVE_MODE passed */
    const raw = modeMatch ? modeMatch[1].toLowerCase() : 'off';
    const mode: 'on' | 'off' =
      raw === 'on' || raw === 'true' || raw === '1' ? 'on' : 'off';
    wsm.setArchiveMode(mode);
    logger.debug(
      { sql: trimmed, archiveMode: mode },
      'SET archive_mode detected — state updated',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 2: SET archive_command = '...' ───────────────────────

  if (SET_ARCHIVE_COMMAND.test(trimmed)) {
    // Extract the command string from single quotes. The outer regex already
    // guarantees a single-quoted value, so the inner `'([^']*)'` always
    // matches (the `false` arm of this ternary is unreachable).
    const cmdMatch = trimmed.match(/'([^']*)'/);
    /* c8 ignore next */
    const cmd = cmdMatch ? cmdMatch[1] : '';
    wsm.setArchiveCommand(cmd);
    logger.debug(
      { sql: trimmed, archiveCommand: cmd },
      'SET archive_command detected — state updated',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 3: SET archive_timeout = N ───────────────────────────

  if (SET_ARCHIVE_TIMEOUT.test(trimmed)) {
    // Extract the integer timeout value. The outer regex guarantees at least
    // one digit, so the inner `(\d+)` always matches (the `false` arm of this
    // ternary is unreachable).
    const timeoutMatch = trimmed.match(/(\d+)/);
    /* c8 ignore next */
    const timeout = timeoutMatch ? parseInt(timeoutMatch[1], 10) : 0;
    wsm.setArchiveTimeout(timeout);
    logger.debug(
      { sql: trimmed, archiveTimeout: timeout },
      'SET archive_timeout detected — state updated',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 4: SELECT pg_walfile_name('lsn') ─────────────────────

  if (WALFILE_NAME.test(trimmed)) {
    // Extract the LSN argument from the function call
    const lsnMatch = trimmed.match(/pg_walfile_name\s*\(\s*'([^']+)'\s*\)/i);
    if (lsnMatch) {
      const fileName = wsm.lsnToFileName(lsnMatch[1]);
      logger.debug(
        { sql: trimmed, lsn: lsnMatch[1], fileName },
        'pg_walfile_name detected — computing real file name',
      );
      return {
        sql: `SELECT '${fileName}' as file_name`,
        rewritten: true,
      };
    }
    logger.debug(
      { sql: trimmed },
      'pg_walfile_name detected — could not extract LSN, using default',
    );
    return {
      sql: "SELECT '000000010000000000000000' as file_name",
      rewritten: true,
    };
  }

  // ── Step 5: SELECT pg_walfile_name_offset('lsn') ──────────────

  if (WALFILE_NAME_OFFSET.test(trimmed)) {
    // Extract the LSN argument from the function call
    const lsnMatch = trimmed.match(/pg_walfile_name_offset\s*\(\s*'([^']+)'\s*\)/i);
    if (lsnMatch) {
      const { fileName, fileOffset } = wsm.lsnToFileOffset(lsnMatch[1]);
      logger.debug(
        { sql: trimmed, lsn: lsnMatch[1], fileName, fileOffset },
        'pg_walfile_name_offset detected — computing real file name and offset',
      );
      return {
        sql: `SELECT '${fileName}' as file_name, ${fileOffset} as file_offset`,
        rewritten: true,
      };
    }
    logger.debug(
      { sql: trimmed },
      'pg_walfile_name_offset detected — could not extract LSN, using defaults',
    );
    return {
      sql: "SELECT '000000010000000000000000' as file_name, 0 as file_offset",
      rewritten: true,
    };
  }

  // ── Step 6: SHOW archive_mode ─────────────────────────────────

  if (SHOW_ARCHIVE_MODE.test(trimmed)) {
    const mode = wsm.getArchiveMode();
    logger.debug(
      { sql: trimmed, archiveMode: mode },
      'SHOW archive_mode detected — returning actual state',
    );
    return {
      sql: `SELECT '${mode}' as archive_mode`,
      rewritten: true,
    };
  }

  // ── Step 7: SHOW archive_command ──────────────────────────────

  if (SHOW_ARCHIVE_COMMAND.test(trimmed)) {
    const cmd = wsm.getArchiveCommand();
    logger.debug(
      { sql: trimmed, archiveCommand: cmd },
      'SHOW archive_command detected — returning actual state',
    );
    return {
      sql: `SELECT '${cmd}' as archive_command`,
      rewritten: true,
    };
  }

  // ── Step 8: SHOW archive_timeout ──────────────────────────────

  if (SHOW_ARCHIVE_TIMEOUT.test(trimmed)) {
    const timeout = wsm.getArchiveTimeout();
    logger.debug(
      { sql: trimmed, archiveTimeout: timeout },
      'SHOW archive_timeout detected — returning actual state',
    );
    return {
      sql: `SELECT '${timeout}' as archive_timeout`,
      rewritten: true,
    };
  }

  // ── Step 9: Not a WAL archive operation — pass through ────────

  return {
    sql: trimmed,
    rewritten: false,
  };
}
