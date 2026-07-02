/**
 * HAPromotionShim — PostgreSQL HA (High Availability) / promotion
 * orchestration compatibility shim for SQLite.
 *
 * PostgreSQL provides several administrative functions for replication and
 * high-availability management:
 *
 *   - `pg_promote()`          — Promote a standby server to primary
 *   - `pg_ctl promote`        — Equivalent shell/text form
 *   - `pg_reload_conf()`      — Reload server configuration files
 *   - `pg_rotate_logfile()`   — Rotate the server log file
 *   - `pg_switch_wal()`       — Force switch to a new WAL segment
 *   - `pg_switch_xlog()`      — Older alias for pg_switch_wal()
 *
 * SQLite has no replication or WAL archiving architecture, so these
 * functions have no meaningful equivalent.  This shim rewrites them
 * to no-op SELECT statements that return compatible result shapes,
 * allowing HA-aware client code (e.g. connection pool heartbeats,
 * failover scripts) to run against SQLite without errors.
 *
 * ## Strategy
 *
 * Detect HA orchestration function calls by function name and replace
 * the entire statement with a stub SELECT that returns plausible
 * placeholder values.
 *
 * | Input                                          | Output                    | Rewritten |
 * |------------------------------------------------|---------------------------|-----------|
 * | `SELECT pg_promote()`                          | `SELECT 1 as promoted`   | true      |
 * | `SELECT pg_ctl promote`                        | `SELECT 1 as promoted`   | true      |
 * | `SELECT pg_reload_conf()`                      | `SELECT true as reloaded`| true      |
 * | `SELECT pg_rotate_logfile()`                   | `SELECT true as rotated` | true      |
 * | `SELECT pg_switch_wal()`                       | `SELECT '<lsn>' as wal`  | true      |
 * | `SELECT pg_switch_xlog()`                      | `SELECT '<lsn>' as wal`  | true      |
 * | `SELECT * FROM t;`                             | (pass-through)            | false     |
 * | Non-HA SQL                                     | (pass-through)            | false     |
 * | Empty / whitespace                             | (pass-through)            | false     |
 *
 * ## Key limitations
 *
 * - The shim uses regex-based detection and does not parse full SQL
 *   grammar.  Edge cases (e.g. HA function names appearing in string
 *   literals or comments) may produce false positives.
 * - Rewritten statements are no-ops — actual HA orchestration actions
 *   (promotion, config reload, log rotation, WAL switching) will NOT
 *   occur.  Any workload that genuinely depends on these effects must
 *   run against a real PostgreSQL server.
 * - Schema-qualified calls (`pg_catalog.pg_promote()`) are matched by
 *   the bare function name and are rewritten identically.
 *
 * @module HAPromotionShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { WALStateManager } from '../storage/WALStateManager';

const logger = PinoLogger.forComponent('HAPromotionShim');
const wsm = WALStateManager.getInstance();

// ---- Types ------------------------------------------------------------

export interface HAPromotionResult {
  /** Rewritten SQL (original if no HA orchestration constructs found) */
  sql: string;
  /** Whether any HA orchestration rewrite was applied */
  rewritten: boolean;
}

// ── Config reload callback (used by pg_reload_conf()) ─────────────

/**
 * Global callback invoked when `pg_reload_conf()` is detected.
 * Registered by {@link QueryRouter} with a {@link ConfigWatcher.reloadNow}
 * so that the SQL command triggers an actual config reload instead of
 * just returning a stub.
 */
let configReloadCallback: (() => void) | null = null;

/**
 * Register a callback that will be invoked every time a
 * `pg_reload_conf()` statement is detected in the query pipeline.
 *
 * @param cb  The callback (typically {@link ConfigWatcher.reloadNow})
 */
export function setConfigReloadCallback(cb: () => void): void {
  configReloadCallback = cb;
}

/**
 * Clear the previously-registered config reload callback.
 */
export function clearConfigReloadCallback(): void {
  configReloadCallback = null;
}

// ---- Internal helpers -------------------------------------------------

/**
 * Remove outer whitespace and trailing semicolons to normalise the
 * input before regex matching.
 */
function normalise(sql: string): string {
  return sql.replace(/;+\s*$/, '').trim();
}

// ---- Regex constants (no `g` flag — no lastIndex mutation needed) -----

/**
 * Matches `pg_promote()` with optional schema qualification and
 * optional parentheses.
 *
 * Accepts:
 *   - pg_promote()
 *   - pg_catalog.pg_promote()
 *   - "pg_promote"()
 */
const RE_PROMOTE = /\bpg_promote\s*\(\s*\)/i;

/**
 * Matches the text form `pg_ctl promote` appearing as a string literal
 * or bare text within a SELECT.
 */
const RE_CTL_PROMOTE = /\bpg_ctl\s+promote\b/i;

/**
 * Matches `pg_reload_conf()` with optional schema qualification.
 */
const RE_RELOAD_CONF = /\bpg_reload_conf\s*\(\s*\)/i;

/**
 * Matches `pg_rotate_logfile()` with optional schema qualification.
 */
const RE_ROTATE_LOGFILE = /\bpg_rotate_logfile\s*\(\s*\)/i;

/**
 * Matches `pg_switch_wal()` or `pg_switch_xlog()` with optional
 * schema qualification.
 */
const RE_SWITCH_WAL = /\bpg_switch_(?:wal|xlog)\s*\(\s*\)/i;

/**
 * Generic HA function name pattern — matches any recognised HA
 * orchestration function call.
 */
const RE_ANY_HA = /\b(?:pg_promote|pg_ctl_promote|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_switch_xlog)\s*\(/i;

// ---- Public API -------------------------------------------------------

/**
 * Detect whether the given SQL string references any PostgreSQL HA
 * orchestration function (pg_promote, pg_reload_conf, pg_rotate_logfile,
 * pg_switch_wal, pg_switch_xlog) or the `pg_ctl promote` text form.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL contains a recognised HA orchestration
 *              construct
 *
 * @example
 * ```ts
 * detectHAPromotion('SELECT pg_promote();');            // true
 * detectHAPromotion('SELECT pg_ctl promote');           // true
 * detectHAPromotion('SELECT pg_reload_conf()');         // true
 * detectHAPromotion('SELECT pg_rotate_logfile()');      // true
 * detectHAPromotion('SELECT pg_switch_wal()');          // true
 * detectHAPromotion('SELECT pg_switch_xlog()');         // true
 * detectHAPromotion('SELECT 1;');                       // false
 * detectHAPromotion('');                                // false
 * ```
 */
export function detectHAPromotion(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const cleaned = normalise(sql);

  // Check each known HA function pattern.  Schema-qualified forms
  // (e.g. pg_catalog.pg_promote()) are matched by the bare function
  // name regex.
  if (RE_PROMOTE.test(cleaned)) {
    return true;
  }
  if (RE_CTL_PROMOTE.test(cleaned)) {
    return true;
  }
  if (RE_RELOAD_CONF.test(cleaned)) {
    return true;
  }
  if (RE_ROTATE_LOGFILE.test(cleaned)) {
    return true;
  }
  if (RE_SWITCH_WAL.test(cleaned)) {
    return true;
  }

  return false;
}

/**
 * Rewrite PostgreSQL HA orchestration SQL to SQLite-compatible
 * no-op stubs.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is empty/whitespace, return unchanged.
 * 2. If the SQL does not reference any HA function, pass through
 *    unchanged with `rewritten: false`.
 * 3. If a known HA function is detected, replace the statement
 *    with the appropriate stub SELECT, preserving the original
 *    trailing semicolon convention (applied at the end if the
 *    original ended with `;`).
 *
 * **Detection order matters**: `pg_switch_wal` / `pg_switch_xlog`
 * is checked _before_ `pg_promote` and `pg_reload_conf` to avoid
 * false matches on unrelated function names.  Each regex targets
 * a distinct function family, so in practice the order is safe.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link HAPromotionResult} describing the outcome
 *
 * @example
 * ```ts
 * rewriteHAPromotion('SELECT pg_promote()');
 * // → { sql: 'SELECT 1 as promoted', rewritten: true }
 *
 * rewriteHAPromotion('SELECT pg_reload_conf();');
 * // → { sql: 'SELECT true as reloaded', rewritten: true }
 *
 * rewriteHAPromotion('SELECT pg_switch_wal()');
 * // → { sql: "SELECT '0/1000000' as wal", rewritten: true }
 *
 * rewriteHAPromotion('SELECT 1;');
 * // → { sql: 'SELECT 1;', rewritten: false }
 * ```
 */
export function rewriteHAPromotion(sql: string): HAPromotionResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();
  const cleaned = normalise(trimmed);

  // Track whether the original SQL ended with a semicolon so we can
  // preserve the caller's convention.
  const hadSemicolon = trimmed.endsWith(';');
  const appendSemi = (s: string): string => (hadSemicolon ? `${s};` : s);

  // ---- Detect and rewrite ---------------------------------------

  // Order: check more-specific patterns first, then general.

  // pg_switch_wal / pg_switch_xlog
  if (RE_SWITCH_WAL.test(cleaned)) {
    const newLsn = wsm.switchWAL();
    logger.debug(
      { sql: trimmed, newLSN: newLsn },
      'pg_switch_wal/pg_switch_xlog detected — switching WAL segment',
    );
    return {
      sql: appendSemi(`SELECT '${newLsn}' as wal`),
      rewritten: true,
    };
  }

  // pg_promote()
  if (RE_PROMOTE.test(cleaned)) {
    logger.debug(
      { sql: trimmed },
      'pg_promote detected — rewriting to stub',
    );
    return {
      sql: appendSemi('SELECT 1 as promoted'),
      rewritten: true,
    };
  }

  // pg_ctl promote (text form)
  if (RE_CTL_PROMOTE.test(cleaned)) {
    logger.debug(
      { sql: trimmed },
      'pg_ctl promote detected — rewriting to stub',
    );
    return {
      sql: appendSemi('SELECT 1 as promoted'),
      rewritten: true,
    };
  }

  // pg_reload_conf()
  if (RE_RELOAD_CONF.test(cleaned)) {
    logger.debug(
      { sql: trimmed },
      'pg_reload_conf detected — invoking config reload callback',
    );
    // Fire the real config reload if a callback is registered
    if (configReloadCallback) {
      try {
        configReloadCallback();
      } catch (err: any) {
        logger.error(
          { err: err.message },
          'pg_reload_conf config reload callback failed',
        );
      }
    }
    return {
      sql: appendSemi('SELECT true as reloaded'),
      rewritten: true,
    };
  }

  // pg_rotate_logfile()
  if (RE_ROTATE_LOGFILE.test(cleaned)) {
    logger.debug(
      { sql: trimmed },
      'pg_rotate_logfile detected — rewriting to stub',
    );
    return {
      sql: appendSemi('SELECT true as rotated'),
      rewritten: true,
    };
  }

  // No HA functions found — pass through unchanged.
  return {
    sql: trimmed,
    rewritten: false,
  };
}
