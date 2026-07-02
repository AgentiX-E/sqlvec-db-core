/**
 * PrecomputeShim — PostgreSQL precompute / materialized-query compatibility shim for SQLite.
 *
 * Some PostgreSQL deployments (e.g., TimescaleDB, custom forks) support precompute /
 * auto-materialization features controlled via GUC parameters and ALTER TABLE options.
 * These constructs have no equivalent in SQLite, so matching statements are detected
 * and rewritten to safe no-ops (`SELECT 1`) or placeholder return values.
 *
 * ## Supported patterns
 *
 * | Pattern                                                | Output           | rewritten |
 * |--------------------------------------------------------|------------------|-----------|
 * | `SET enable_precompute = on`                           | `SELECT 1`       | true      |
 * | `SET enable_precompute = off`                          | `SELECT 1`       | true      |
 * | `SET precompute_threshold = 5000`                      | `SELECT 1`       | true      |
 * | `SET precompute_max_tables = 10`                       | `SELECT 1`       | true      |
 * | `ALTER TABLE t SET (precompute_agg = true)`            | `SELECT 1`       | true      |
 * | `ALTER TABLE t SET (precompute_columns = 'a,b')`       | `SELECT 1`       | true      |
 * | `SHOW enable_precompute`                               | `SELECT 'off'`   | true      |
 * | `SHOW precompute_threshold`                            | `SELECT '1000'`  | true      |
 * | `SHOW precompute_max_tables`                           | `SELECT '10'`    | true      |
 * | Unrelated SQL (e.g. `SELECT * FROM t`)                 | (pass-through)   | false     |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite
 * - No false positives on identifiers or strings containing precompute keywords
 * - Detection is conservative: only top-level statements ending with semicolon or EOS
 * - PinoLogger integration for debugging and audit trails
 *
 * @module PrecomputeShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { SecurityNoticeCollector } from './SecurityNoticeCollector';

const logger = PinoLogger.forComponent('PrecomputeShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface PrecomputeResult {
  /** Rewritten SQL (no-op `SELECT 1` / placeholder, or original if not handled) */
  sql: string;
  /** Whether a precompute-related statement was detected and processed */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants – Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches: SET enable_precompute = on|off
 *
 * Case-insensitive. Allows optional whitespace around '='.
 * Trailing semicolons are tolerated.
 */
const SET_ENABLE_PRECOMPUTE_RE =
  /^\s*SET\s+enable_precompute\s*=\s*(on|off)\s*;?\s*$/im;

/**
 * Matches: SET precompute_threshold = <integer>
 *
 * Case-insensitive. Accepts any positive integer value.
 */
const SET_PRECOMPUTE_THRESHOLD_RE =
  /^\s*SET\s+precompute_threshold\s*=\s*(\d+)\s*;?\s*$/im;

/**
 * Matches: SET precompute_max_tables = <integer>
 *
 * Case-insensitive. Accepts any positive integer value.
 */
const SET_PRECOMPUTE_MAX_TABLES_RE =
  /^\s*SET\s+precompute_max_tables\s*=\s*(\d+)\s*;?\s*$/im;

/**
 * Matches: ALTER TABLE ... SET (precompute_agg = true|false)
 *
 * Case-insensitive. The table name is captured (group 1) but not used for rewriting.
 * The boolean value (group 2) is captured for logging/audit purposes.
 */
const ALTER_PRECOMPUTE_AGG_RE =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s(]+)\s+SET\s*\(\s*precompute_agg\s*=\s*(true|false)\s*\)\s*;?\s*$/im;

/**
 * Matches: ALTER TABLE ... SET (precompute_columns = 'col1,col2,...')
 *
 * Case-insensitive. The table name (group 1) and column list (group 2) are captured
 * for logging/audit purposes.
 */
const ALTER_PRECOMPUTE_COLUMNS_RE =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s(]+)\s+SET\s*\(\s*precompute_columns\s*=\s*'([^']*)'\s*\)\s*;?\s*$/im;

/**
 * Matches: SHOW enable_precompute
 *
 * Returns `SELECT 'off'` (the safe default for SQLite — precompute disabled).
 */
const SHOW_ENABLE_PRECOMPUTE_RE =
  /^\s*SHOW\s+enable_precompute\s*;?\s*$/im;

/**
 * Matches: SHOW precompute_threshold
 *
 * Returns `SELECT '1000'` (the typical PostgreSQL default threshold).
 */
const SHOW_PRECOMPUTE_THRESHOLD_RE =
  /^\s*SHOW\s+precompute_threshold\s*;?\s*$/im;

/**
 * Matches: SHOW precompute_max_tables
 *
 * Returns `SELECT '10'` (the typical PostgreSQL default max tables).
 */
const SHOW_PRECOMPUTE_MAX_TABLES_RE =
  /^\s*SHOW\s+precompute_max_tables\s*;?\s*$/im;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detects whether a given SQL statement is a precompute-related command.
 *
 * Covers SET/ALTER TABLE/SHOW statements in the precompute family.
 * Returns `true` if any known pattern matches.
 *
 * @param sql - The raw SQL statement to inspect (can include trailing semicolons).
 * @returns `true` if the statement is a precompute-related command.
 */
export function detectPrecompute(sql: string): boolean {
  const trimmed = sql.trim();
  if (!trimmed) {
    return false;
  }

  const matched =
    SET_ENABLE_PRECOMPUTE_RE.test(trimmed) ||
    SET_PRECOMPUTE_THRESHOLD_RE.test(trimmed) ||
    SET_PRECOMPUTE_MAX_TABLES_RE.test(trimmed) ||
    ALTER_PRECOMPUTE_AGG_RE.test(trimmed) ||
    ALTER_PRECOMPUTE_COLUMNS_RE.test(trimmed) ||
    SHOW_ENABLE_PRECOMPUTE_RE.test(trimmed) ||
    SHOW_PRECOMPUTE_THRESHOLD_RE.test(trimmed) ||
    SHOW_PRECOMPUTE_MAX_TABLES_RE.test(trimmed);

  if (matched) {
    logger.debug({ sql: trimmed }, 'detectPrecompute: matched precompute statement');
  }

  return matched;
}

/**
 * Rewrites a precompute-related SQL statement to a safe no-op or placeholder result.
 *
 * | Pattern                                        | Output             |
 * |------------------------------------------------|--------------------|
 * | SET enable_precompute = on/off                 | `SELECT 1`         |
 * | SET precompute_threshold = N                   | `SELECT 1`         |
 * | SET precompute_max_tables = N                  | `SELECT 1`         |
 * | ALTER TABLE ... SET (precompute_agg = ...)     | `SELECT 1`         |
 * | ALTER TABLE ... SET (precompute_columns = ...) | `SELECT 1`         |
 * | SHOW enable_precompute                         | `SELECT 'off'`     |
 * | SHOW precompute_threshold                      | `SELECT '1000'`    |
 * | SHOW precompute_max_tables                     | `SELECT '10'`      |
 * | (any non-precompute statement)                 | (pass-through)     |
 *
 * Non-matching SQL is returned unchanged with `rewritten: false`.
 *
 * @param sql - The raw SQL statement to potentially rewrite.
 * @returns A `PrecomputeResult` with the (possibly rewritten) SQL and a flag.
 */
export function rewritePrecompute(sql: string): PrecomputeResult {
  const trimmed = sql.trim();

  if (!trimmed) {
    return { sql, rewritten: false };
  }

  // ── SHOW statements come first because they have unique outputs ──

  if (SHOW_ENABLE_PRECOMPUTE_RE.test(trimmed)) {
    logger.info({ sql: trimmed }, 'rewritePrecompute: SHOW enable_precompute → SELECT \'off\'');
    SecurityNoticeCollector.add('precompute', 'Precompute is not implemented by this database vendor');
    return { sql: "SELECT 'off'", rewritten: true };
  }

  if (SHOW_PRECOMPUTE_THRESHOLD_RE.test(trimmed)) {
    logger.info({ sql: trimmed }, 'rewritePrecompute: SHOW precompute_threshold → SELECT \'1000\'');
    SecurityNoticeCollector.add('precompute', 'Precompute is not implemented by this database vendor');
    return { sql: "SELECT '1000'", rewritten: true };
  }

  if (SHOW_PRECOMPUTE_MAX_TABLES_RE.test(trimmed)) {
    logger.info({ sql: trimmed }, 'rewritePrecompute: SHOW precompute_max_tables → SELECT \'10\'');
    SecurityNoticeCollector.add('precompute', 'Precompute is not implemented by this database vendor');
    return { sql: "SELECT '10'", rewritten: true };
  }

  // ── SET / ALTER TABLE statements → SELECT 1 no-op ──

  if (SET_ENABLE_PRECOMPUTE_RE.test(trimmed)) {
    logger.info({ sql: trimmed }, 'rewritePrecompute: SET enable_precompute → SELECT 1');
    SecurityNoticeCollector.add('precompute', 'Precompute is not implemented by this database vendor');
    return { sql: 'SELECT 1', rewritten: true };
  }

  if (SET_PRECOMPUTE_THRESHOLD_RE.test(trimmed)) {
    logger.info({ sql: trimmed }, 'rewritePrecompute: SET precompute_threshold → SELECT 1');
    SecurityNoticeCollector.add('precompute', 'Precompute is not implemented by this database vendor');
    return { sql: 'SELECT 1', rewritten: true };
  }

  if (SET_PRECOMPUTE_MAX_TABLES_RE.test(trimmed)) {
    logger.info({ sql: trimmed }, 'rewritePrecompute: SET precompute_max_tables → SELECT 1');
    SecurityNoticeCollector.add('precompute', 'Precompute is not implemented by this database vendor');
    return { sql: 'SELECT 1', rewritten: true };
  }

  if (ALTER_PRECOMPUTE_AGG_RE.test(trimmed)) {
    logger.info({ sql: trimmed }, 'rewritePrecompute: ALTER TABLE SET (precompute_agg) → SELECT 1');
    SecurityNoticeCollector.add('precompute', 'Precompute is not implemented by this database vendor');
    return { sql: 'SELECT 1', rewritten: true };
  }

  if (ALTER_PRECOMPUTE_COLUMNS_RE.test(trimmed)) {
    logger.info({ sql: trimmed }, 'rewritePrecompute: ALTER TABLE SET (precompute_columns) → SELECT 1');
    SecurityNoticeCollector.add('precompute', 'Precompute is not implemented by this database vendor');
    return { sql: 'SELECT 1', rewritten: true };
  }

  // ── No match — pass through ──

  return { sql, rewritten: false };
}
