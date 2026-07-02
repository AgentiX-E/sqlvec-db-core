/**
 * MVCCShim — PostgreSQL MVCC compatibility shim for SQLite.
 *
 * PostgreSQL relies heavily on MVCC (Multi-Version Concurrency Control) for
 * transaction isolation and vacuum management. SQLite has a simpler locking
 * model (serialised at the file level) and does not support:
 *
 *   - Transaction isolation level configuration (always SERIALIZABLE)
 *   - Snapshot functions (`pg_current_snapshot`, `pg_snapshot_xmin`)
 *   - The `pg_stat_all_tables` system view
 *   - Storage parameters on CREATE TABLE (`autovacuum_enabled`, `fillfactor`,
 *     `toast_tuple_target`, and other PG-specific table storage options)
 *   - Autovacuum configuration (`SET vacuum_cost_delay`, `SET autovacuum_*`)
 *   - Runtime MVCC parameter inspection (`SHOW`)
 *
 * This shim detects and rewrites the above PG-MVCC statements into
 * SQLite-compatible equivalents.
 *
 * ## Strategy
 *
 * | PG Statement                                                    | SQLite-compatible output             |
 * |:----------------------------------------------------------------|:-------------------------------------|
 * | `SET default_transaction_isolation = '...'`                     | `SELECT 1`                           |
 * | `SET vacuum_cost_delay = ...`                                   | `SELECT 1`                           |
 * | `SET autovacuum_<param> = ...`                                  | `SELECT 1`                           |
 * | `CREATE TABLE ... WITH (autovacuum_enabled = false, ...)`       | Strip storage params from WITH clause |
 * | `CREATE TABLE ... WITH (fillfactor = 90, ...)`                  | Strip storage params from WITH clause |
 * | `CREATE TABLE ... WITH (toast_tuple_target = 128, ...)`        | Strip storage params from WITH clause |
 * | `SELECT pg_current_snapshot()`                                  | `SELECT '0:0:' AS snapshot`          |
 * | `SELECT pg_snapshot_xmin(pg_current_snapshot())`                | `SELECT 0 AS xmin`                   |
 * | `SELECT * FROM pg_stat_all_tables`                              | Mock columns (empty result)          |
 * | `SHOW default_transaction_isolation`                            | `SELECT 'read committed' AS ...`     |
 * | `SHOW vacuum_cost_delay`                                        | `SELECT '0' AS vacuum_cost_delay`    |
 * | `SHOW autovacuum`                                               | `SELECT 'off' AS autovacuum`         |
 * | `SHOW <other_mvcc_param>`                                       | `SELECT '<default>' AS <param>`      |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite syntax
 * - Detection is conservative — only top-level, MVCC-related patterns
 * - CREATE TABLE WITH clause preserves non-storage WITH options (e.g. OIDS)
 * - If all WITH options are storage params, the entire WITH clause is removed
 * - Non-MVCC SQL passes through unchanged
 * - PinoLogger integration for debugging and audit trails
 *
 * @module query/MVCCShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import type { GlobalMvccStats, SessionMvccStats } from './MVCCExecutor';
import { parseWithComments, locationOf } from 'pgsql-ast-parser';

// ── Logger ──────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('MVCCShim');

// ── Types ──────────────────────────────────────────────────────

export interface MVCCResult {
  /** Rewritten SQL string (unchanged if no rewriting was needed) */
  sql: string;
  /** Whether an MVCC-related rewrite was performed */
  rewritten: boolean;
}

// ── Constants — PG storage parameter names ──────────────────────
//
// These are table storage parameters that PostgreSQL supports in
// CREATE TABLE ... WITH (...) but have no meaning in SQLite.

const STORAGE_PARAM_SET = new Set([
  // Autovacuum parameters
  'autovacuum_enabled',
  'autovacuum_vacuum_threshold',
  'autovacuum_vacuum_scale_factor',
  'autovacuum_vacuum_insert_threshold',
  'autovacuum_vacuum_insert_scale_factor',
  'autovacuum_analyze_threshold',
  'autovacuum_analyze_scale_factor',
  'autovacuum_vacuum_cost_delay',
  'autovacuum_vacuum_cost_limit',
  'autovacuum_freeze_min_age',
  'autovacuum_freeze_max_age',
  'autovacuum_freeze_table_age',
  'autovacuum_multixact_freeze_min_age',
  'autovacuum_multixact_freeze_max_age',
  'autovacuum_multixact_freeze_table_age',
  'autovacuum_log_level',
  // Table storage parameters
  'fillfactor',
  'toast_tuple_target',
  'parallel_workers',
  'vacuum_truncate',
  'user_catalog_table',
]);

/** Known MVCC-related SHOW parameters and their default mock values */
const MVCC_SHOW_DEFAULTS: Record<string, string> = {
  default_transaction_isolation: 'read committed',
  transaction_isolation: 'read committed',
  vacuum_cost_delay: '0',
  vacuum_cost_limit: '200',
  vacuum_cost_page_hit: '1',
  vacuum_cost_page_miss: '10',
  vacuum_cost_page_dirty: '20',
  autovacuum: 'on',
  autovacuum_vacuum_threshold: '50',
  autovacuum_vacuum_scale_factor: '0.2',
  autovacuum_vacuum_insert_threshold: '1000',
  autovacuum_vacuum_insert_scale_factor: '0.2',
  autovacuum_analyze_threshold: '50',
  autovacuum_analyze_scale_factor: '0.1',
  autovacuum_vacuum_cost_delay: '2',
  autovacuum_vacuum_cost_limit: '-1',
  autovacuum_freeze_min_age: '50000000',
  autovacuum_freeze_max_age: '200000000',
  autovacuum_freeze_table_age: '150000000',
  autovacuum_multixact_freeze_min_age: '5000000',
  autovacuum_multixact_freeze_max_age: '400000000',
  autovacuum_multixact_freeze_table_age: '300000000',
};

// ── Constants — Mock for pg_stat_all_tables ─────────────────────
//
// Provides an empty result set with the most commonly queried columns
// from the PostgreSQL system view.

const PG_STAT_ALL_TABLES_MOCK_SELECT =
  'SELECT ' +
  [
    '0 AS relid',
    "'' AS schemaname",
    "'' AS relname",
    '0 AS seq_scan',
    '0 AS seq_tup_read',
    '0 AS idx_scan',
    '0 AS idx_tup_fetch',
    '0 AS n_tup_ins',
    '0 AS n_tup_upd',
    '0 AS n_tup_del',
    '0 AS n_tup_hot_upd',
    '0 AS n_live_tup',
    '0 AS n_dead_tup',
    '0 AS n_mod_since_analyze',
    'NULL AS last_vacuum',
    'NULL AS last_autovacuum',
    'NULL AS last_analyze',
    'NULL AS last_autoanalyze',
    '0 AS vacuum_count',
    '0 AS autovacuum_count',
    '0 AS analyze_count',
    '0 AS autoanalyze_count',
  ].join(', ') +
  ' WHERE 1=0';

// ── Phase 4: MVCCExecutor reference for pg_stat_* views ────────

let mvccExecutorRef: any = null;

/**
 * Set a reference to the MVCCExecutor for dynamic pg_stat_* mock generation.
 * When set, pg_stat_database and pg_stat_activity queries will return real stats.
 */
export function setMvccExecutor(executor: any): void {
  mvccExecutorRef = executor;
}

/**
 * Generate a mock pg_stat_database SQL query with real/existing MVCC stats.
 * Exported for testing.
 */
export function generatePgStatDatabaseSql(): string {
  let xactCommit = 0;
  let xactRollback = 0;
  let deadlocks = 0;
  let conflicts = 0;
  let numbackends = 0;

  if (mvccExecutorRef && typeof mvccExecutorRef.getGlobalStats === 'function') {
    try {
      const globalStats: GlobalMvccStats = mvccExecutorRef.getGlobalStats();
      xactCommit = globalStats.committedCount;
      xactRollback = globalStats.rolledBackCount;
      deadlocks = globalStats.deadlockCount;
      conflicts = globalStats.conflictCount;
      numbackends = globalStats.sessions;
    } catch {
      // Fall through to defaults
    }
  }

  return `SELECT ` +
    `0 AS datid, ` +
    `'postgres' AS datname, ` +
    `${numbackends} AS numbackends, ` +
    `${xactCommit} AS xact_commit, ` +
    `${xactRollback} AS xact_rollback, ` +
    `${deadlocks} AS deadlocks, ` +
    `${conflicts} AS conflicts, ` +
    `0 AS blks_read, ` +
    `0 AS blks_hit, ` +
    `0 AS tup_returned, ` +
    `0 AS tup_fetched, ` +
    `0 AS tup_inserted, ` +
    `0 AS tup_updated, ` +
    `0 AS tup_deleted, ` +
    `0 AS temp_files, ` +
    `0 AS temp_bytes, ` +
    `0 AS blk_read_time, ` +
    `0 AS blk_write_time, ` +
    `'2026-01-01 00:00:00' AS stats_reset`;
}

/**
 * Generate a mock pg_stat_activity SQL query with real/existing MVCC session stats.
 * Exported for testing.
 */
export function generatePgStatActivitySql(): string {
  let rows: string[] = [];

  if (mvccExecutorRef && typeof mvccExecutorRef.getActiveSessions === 'function') {
    try {
      const sessions: string[] = mvccExecutorRef.getActiveSessions();
      for (const sid of sessions) {
        const stats: SessionMvccStats | null = mvccExecutorRef.getSessionStats(sid);
        if (!stats) continue;
        const state = stats.waitingFor ? 'active' : (stats.deadlocked ? 'idle in transaction (deadlocked)' : 'idle');
        const query = stats.waitingFor ? `'waiting for lock: ${stats.waitingFor}'` : 'NULL';
        rows.push(`SELECT ` +
          `0 AS datid, ` +
          `'postgres' AS datname, ` +
          `${10000 + stats.xid} AS pid, ` +
          `'postgres' AS usename, ` +
          `'sqlvec' AS application_name, ` +
          `'client backend' AS backend_type, ` +
          `${stats.started} AS backend_start, ` +
          `${stats.started} AS xact_start, ` +
          `${stats.started} AS query_start, ` +
          `${Date.now()} AS state_change, ` +
          `'${state}' AS state, ` +
          `NULL AS wait_event_type, ` +
          `NULL AS wait_event, ` +
          `'${stats.xid}' AS backend_xid, ` +
          `NULL AS backend_xmin, ` +
          `${query} AS query, ` +
          `'${sid}' AS session_id`);
      }
    } catch (_e) {
      // Fall through to empty
    }
  }

  if (rows.length === 0) {
    // Return empty mock
    return `SELECT ` +
      `0 AS datid, ` +
      `'' AS datname, ` +
      `0 AS pid, ` +
      `'' AS usename, ` +
      `'' AS application_name, ` +
      `'' AS backend_type, ` +
      `0 AS backend_start, ` +
      `NULL AS xact_start, ` +
      `0 AS query_start, ` +
      `0 AS state_change, ` +
      `'' AS state, ` +
      `NULL AS wait_event_type, ` +
      `NULL AS wait_event, ` +
      `NULL AS backend_xid, ` +
      `NULL AS backend_xmin, ` +
      `NULL AS query, ` +
      `'' AS session_id ` +
      `WHERE 1=0`;
  }

  return rows.join(' UNION ALL ');
}

/**
 * Matches `SET default_transaction_isolation = <value>`.
 */
const SET_DEFAULT_ISOLATION = /^\s*SET\s+default_transaction_isolation\s*=/i;

/**
 * Matches the beginning of a CREATE TABLE statement.
 * Supports TEMP/TEMPORARY and IF NOT EXISTS.
 * Used as a gate before checking for WITH storage params.
 */
const CREATE_TABLE_PREFIX = /^\s*CREATE\s+(?:TEMP|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i;

/**
 * Matches a `WITH (...)` clause at or near the end of a CREATE TABLE statement.
 * Captures the content inside the parentheses.
 *
 * Group 1 — The text before the WITH clause (column defs, etc.)
 * Group 2 — The full WITH clause including parentheses and trailing content
 * Group 3 — The content inside WITH(...)
 *
 * This regex matches simple WITH clauses without nested parentheses.
 * Complex cases (e.g. WITH containing subqueries) are not expected in
 * storage parameter contexts.
 */
const WITH_CLAUSE_CAPTURE = /^(.*?)\s+WITH\s*\(([^()]*)\)\s*(.*)$/i;

/**
 * Matches `SELECT pg_current_snapshot()` (possibly with trailing semicolon).
 */
const PG_CURRENT_SNAPSHOT = /^\s*SELECT\s+pg_current_snapshot\s*\(\s*\)\s*;?\s*$/i;

/**
 * Matches `SELECT pg_snapshot_xmin(pg_current_snapshot())`.
 */
const PG_SNAPSHOT_XMIN = /^\s*SELECT\s+pg_snapshot_xmin\s*\(\s*pg_current_snapshot\s*\(\s*\)\s*\)\s*;?\s*$/i;

/**
 * Matches queries referencing `pg_stat_all_tables`.
 */
const PG_STAT_ALL_TABLES_REF = /^\s*SELECT\s+.*?\bpg_stat_all_tables\b/i;

/**
 * Matches `SELECT * FROM pg_stat_all_tables`.
 */
const PG_STAT_ALL_TABLES_STAR = /^\s*SELECT\s+\*\s+FROM\s+pg_stat_all_tables\s*;?\s*$/i;

/**
 * Matches `SELECT count(*) FROM pg_stat_all_tables`.
 */
const PG_STAT_ALL_TABLES_COUNT =
  /^\s*SELECT\s+count\s*\(\s*(?:\*\s*|\w+\s*)\)\s+FROM\s+pg_stat_all_tables\s*;?\s*$/i;

/**
 * Matches queries referencing `pg_stat_database`.
 */
const PG_STAT_DATABASE_REF = /^\s*SELECT\s+.*?\bpg_stat_database\b/i;

/**
 * Matches queries referencing `pg_stat_activity` (not already handled by PgStatExporter).
 * This catches the shim-level SQL that references pg_stat_activity directly.
 */
const PG_STAT_ACTIVITY_REF = /^\s*SELECT\s+.*?\bpg_stat_activity\b/i;

/**
 * Matches `SET vacuum_cost_delay = <value>` or `SET vacuum_cost_delay TO <value>`.
 */
const SET_VACUUM_COST = /^\s*SET\s+vacuum_cost_delay\s*(?:=|TO)\s*/i;

/**
 * Matches `SET autovacuum_<something> = <value>`.
 */
const SET_AUTOVACUUM = /^\s*SET\s+autovacuum_\w+\s*(?:=|TO)\s*/i;

/**
 * Matches any `SHOW <param>` statement.
 */
const SHOW = /^\s*SHOW\s+/i;

/**
 * Extracts the parameter name from a SHOW statement.
 * Group 1 — The parameter name (strips whitespace and trailing semicolon).
 */
const SHOW_PARAM = /^\s*SHOW\s+(\S[\w_.]*)/i;

// ── Helper — Parse and process WITH clause parameters ───────────

/**
 * Parses the content inside a WITH(...) clause and returns individual
 * key=value / key options as an array of trimmed strings.
 *
 * The parsing is comma-aware but does not handle nested parentheses
 * or quoted commas within the option values (these do not occur for
 * storage parameters in practice).
 *
 * @param withContent - The raw text between the parentheses after `WITH (`.
 * @returns Array of individual option strings (e.g. `["fillfactor = 90", "oids = false"]`).
 */
function parseWithOptions(withContent: string): string[] {
  const options: string[] = [];
  let depth = 0;
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < withContent.length; i++) {
    const ch = withContent[i];

    // Track string literals so we don't split on commas inside quotes
    if (inQuote !== null) {
      current += ch;
      if (ch === inQuote && i > 0 && withContent[i - 1] !== '\\') {
        inQuote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      current += ch;
      continue;
    }

    // Track nested parentheses (for future-proofing)
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    }

    // Split on top-level commas
    if (ch === ',' && depth === 0) {
      options.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  const last = current.trim();
  if (last.length > 0) {
    options.push(last);
  }

  return options;
}

/**
 * Extracts the parameter name from a WITH option string like
 * `"fillfactor = 90"` or `"oids = false"`.
 *
 * @param option - A single WITH option string.
 * @returns The parameter name (lowercased).
 */
function extractParamName(option: string): string {
  const eqIdx = option.indexOf('=');
  if (eqIdx === -1) {
    // Boolean-style option like `OIDS` or `NO OIDS`
    return option.trim().toLowerCase();
  }
  return option.substring(0, eqIdx).trim().toLowerCase();
}

/**
 * Checks whether an option string is a PG storage parameter.
 *
 * @param option - A single WITH option string.
 * @returns `true` if the option is a storage parameter to be stripped.
 */
function isStorageParam(option: string): boolean {
  const name = extractParamName(option);
  if (STORAGE_PARAM_SET.has(name)) return true;

  // Catch any other autovacuum_* parameters not explicitly listed
  if (name.startsWith('autovacuum_')) return true;

  return false;
}

/**
 * Strips PG storage parameters from the WITH clause of a CREATE TABLE
 * statement. Preserves non-storage WITH options.
 *
 * @param sql - The full CREATE TABLE SQL statement.
 * @returns The rewritten SQL with storage parameters removed, or the
 *          original if no storage parameters were found.
 */
function stripStorageParams(sql: string): string {
  const match = sql.match(WITH_CLAUSE_CAPTURE);
  if (!match) return sql;

  const beforeWith = match[1];
  const withContent = match[2];
  const afterWith = match[3];

  const options = parseWithOptions(withContent);
  const keptOptions = options.filter((opt) => !isStorageParam(opt));

  // If no storage params were stripped, return original unchanged
  if (keptOptions.length === options.length) return sql;

  // Rebuild the SQL
  if (keptOptions.length === 0) {
    // All options were storage params → remove the entire WITH clause
    const rebuilt = `${beforeWith.trimEnd()} ${afterWith.trimStart()}`.trim();
    // Clean up extra whitespace
    return rebuilt.replace(/\s{2,}/g, ' ').replace(/\s*;\s*$/, ';');
  }

  const keptContent = keptOptions.join(', ');
  const rebuilt = `${beforeWith} WITH (${keptContent}) ${afterWith}`.trim();
  return rebuilt.replace(/\s{2,}/g, ' ').replace(/\s*;\s*$/, ';');
}

/**
 * Rewrites a SHOW statement to return a mock value for MVCC-related parameters.
 *
 * @param sql - The SHOW SQL statement.
 * @returns An MVCCResult if the parameter is recognised, or `null` to
 *          signal that the SHOW is not MVCC-related.
 */
function rewriteShowStatement(sql: string): MVCCResult | null {
  const paramMatch = sql.match(SHOW_PARAM);
  if (!paramMatch) return null;

  const param = paramMatch[1].toLowerCase().replace(/;+$/, '').trim();

  // Check if this is a known MVCC parameter
  for (const key of Object.keys(MVCC_SHOW_DEFAULTS)) {
    if (param === key || param.endsWith(`.${key}`)) {
      const value = MVCC_SHOW_DEFAULTS[key];
      logger.debug('Rewriting SHOW %s → mock value %s', param, value);
      return { sql: `SELECT '${value}' AS ${paramMatch[1].replace(/;+$/, '').trim()}`, rewritten: true };
    }
  }

  // Also handle autovacuum_* parameters not explicitly in the map
  if (param.startsWith('autovacuum_')) {
    logger.debug('Rewriting SHOW %s → mock value (autovacuum default)', param);
    return { sql: `SELECT '50' AS ${paramMatch[1].replace(/;+$/, '').trim()}`, rewritten: true };
  }

  return null;
}

/**
 * Checks whether a SET statement is MVCC-related.
 *
 * @param trimmed - Trimmed SQL string.
 * @returns `true` if the SET statement should be handled by this shim.
 */
function isMvccSetStatement(trimmed: string): boolean {
  if (SET_DEFAULT_ISOLATION.test(trimmed)) return true;
  if (SET_VACUUM_COST.test(trimmed)) return true;
  if (SET_AUTOVACUUM.test(trimmed)) return true;
  return false;
}

/**
 * Checks whether a CREATE TABLE statement contains storage parameters.
 *
 * @param sql - The CREATE TABLE SQL statement.
 * @returns `true` if storage parameters are present.
 */
function hasStorageParams(sql: string): boolean {
  const match = sql.match(WITH_CLAUSE_CAPTURE);
  if (!match) return false;
  const content = match[2];
  return parseWithOptions(content).some((opt) => isStorageParam(opt));
}

/**
 * Checks whether a SHOW statement references an MVCC-related parameter.
 *
 * @param trimmed - Trimmed SQL string.
 * @returns `true` if the SHOW target is an MVCC parameter.
 */
function isMvccShowStatement(trimmed: string): boolean {
  const paramMatch = trimmed.match(SHOW_PARAM);
  if (!paramMatch) return false;

  const param = paramMatch[1].toLowerCase().replace(/;+$/, '').trim();
  if (param.startsWith('autovacuum_')) return true;
  if (param.startsWith('vacuum_cost_')) return true;
  if (param === 'default_transaction_isolation') return true;
  if (param === 'transaction_isolation') return true;
  if (param === 'autovacuum') return true;

  return false;
}

/**
 * Replaces a `pg_stat_all_tables` query with a mock SQLite-compatible query.
 *
 * Handles:
 *   - `SELECT * FROM pg_stat_all_tables`
 *   - `SELECT count(*) FROM pg_stat_all_tables`
 *   - Other `SELECT ... FROM pg_stat_all_tables` queries (wraps in a
 *     subquery to preserve column references)
 *
 * @param trimmed - The original SQL string.
 * @returns The rewritten SQL with mock data for pg_stat_all_tables.
 */
function rewritePgStatAllTables(trimmed: string): MVCCResult {
  // Simple cases first
  if (PG_STAT_ALL_TABLES_STAR.test(trimmed)) {
    logger.debug('Rewriting SELECT * FROM pg_stat_all_tables → mock');
    return { sql: PG_STAT_ALL_TABLES_MOCK_SELECT, rewritten: true };
  }

  if (PG_STAT_ALL_TABLES_COUNT.test(trimmed)) {
    logger.debug('Rewriting SELECT count(*) FROM pg_stat_all_tables → 0');
    return { sql: 'SELECT 0 AS count', rewritten: true };
  }

  // For other queries referencing pg_stat_all_tables, replace the table
  // with an empty subquery that has the right column names.
  // This preserves the column selection while returning no rows.
  logger.debug('Rewriting pg_stat_all_tables reference → wrapped in empty mock');
  const wrappedQuery = trimmed.replace(
    /\bpg_stat_all_tables\b/g,
    `(${PG_STAT_ALL_TABLES_MOCK_SELECT}) AS pg_stat_all_tables`,
  );
  return { sql: wrappedQuery, rewritten: wrappedQuery !== trimmed };
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Detects whether a given SQL statement contains PG-MVCC constructs
 * that need to be rewritten for SQLite compatibility.
 *
 * @param sql - The SQL statement to inspect.
 * @returns `true` if the SQL statement is MVCC-related.
 *
 * @example
 * ```ts
 * detectMVCC("SET default_transaction_isolation = 'serializable'");
 * // → true
 *
 * detectMVCC("SELECT * FROM users WHERE id = 1");
 * // → false
 * ```
 */
export function detectMVCC(sql: string): boolean {
  const trimmed = sql.trim();

  // SET default_transaction_isolation / vacuum_cost_delay / autovacuum_*
  if (isMvccSetStatement(trimmed)) return true;

  // CREATE TABLE with storage parameters
  if (CREATE_TABLE_PREFIX.test(trimmed) && hasStorageParams(trimmed)) return true;

  // pg_current_snapshot()
  if (PG_CURRENT_SNAPSHOT.test(trimmed)) return true;

  // pg_snapshot_xmin(pg_current_snapshot())
  if (PG_SNAPSHOT_XMIN.test(trimmed)) return true;

  // pg_stat_all_tables queries
  if (PG_STAT_ALL_TABLES_REF.test(trimmed)) return true;

  // pg_stat_database queries
  if (PG_STAT_DATABASE_REF.test(trimmed)) return true;

  // pg_stat_activity queries (shim-level only — PgStatExporter handles higher-level)
  if (PG_STAT_ACTIVITY_REF.test(trimmed)) return true;

  // SHOW for MVCC-related parameters
  if (SHOW.test(trimmed) && isMvccShowStatement(trimmed)) return true;

  return false;
}

/**
 * Rewrites a PG-MVCC SQL statement into a SQLite-compatible equivalent.
 *
 * If the statement is not MVCC-related, it is returned unchanged
 * with `rewritten: false`.
 *
 * ## Supported transformations
 *
 * | Input                                                       | Output                                  |
 * |:------------------------------------------------------------|:----------------------------------------|
 * | `SET default_transaction_isolation = '...'`                 | `SELECT 1`                              |
 * | `SET vacuum_cost_delay = ...`                               | `SELECT 1`                              |
 * | `SET autovacuum_<param> = ...`                              | `SELECT 1`                              |
 * | `CREATE TABLE ... WITH (autovacuum_enabled = false, ...)`   | Stripped storage params                 |
 * | `CREATE TABLE ... WITH (fillfactor = 90, ...)`              | Stripped storage params                 |
 * | `CREATE TABLE ... WITH (toast_tuple_target = 128, ...)`     | Stripped storage params                 |
 * | `SELECT pg_current_snapshot()`                              | `SELECT '0:0:' AS snapshot`             |
 * | `SELECT pg_snapshot_xmin(pg_current_snapshot())`            | `SELECT 0 AS xmin`                      |
 * | `SELECT * FROM pg_stat_all_tables`                          | Mock columns (empty result)             |
 * | `SELECT count(*) FROM pg_stat_all_tables`                   | `SELECT 0 AS count`                     |
 * | `SHOW default_transaction_isolation`                        | `SELECT 'read committed' AS ...`       |
 * | `SHOW vacuum_cost_delay`                                    | `SELECT '0' AS vacuum_cost_delay`       |
 * | `SHOW autovacuum`                                           | `SELECT 'on' AS autovacuum`             |
 * | Other SQL                                                   | Pass-through unchanged                  |
 *
 * @param sql - The SQL statement to rewrite.
 * @returns An {@link MVCCResult} containing the (possibly rewritten) SQL.
 *
 * @example
 * ```ts
 * rewriteMVCC("SET default_transaction_isolation = 'serializable'");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteMVCC("SELECT * FROM users WHERE id = 1");
 * // → { sql: "SELECT * FROM users WHERE id = 1", rewritten: false }
 * ```
 */
export function rewriteMVCC(sql: string): MVCCResult {
  const trimmed = sql.trim();

  // ── 1. SET default_transaction_isolation = '...' → SELECT 1 ──
  if (SET_DEFAULT_ISOLATION.test(trimmed)) {
    logger.debug('Rewriting SET default_transaction_isolation → SELECT 1');
    return { sql: 'SELECT 1', rewritten: true };
  }

  // ── 2–4. CREATE TABLE ... WITH (storage_params) → strip ──
  if (CREATE_TABLE_PREFIX.test(trimmed)) {
    const rewritten = stripStorageParams(trimmed);
    if (rewritten !== trimmed) {
      logger.debug('Rewritten CREATE TABLE — removed PG storage parameters');
      return { sql: rewritten, rewritten: true };
    }
  }

  // ── 5. SELECT pg_current_snapshot() → mock snapshot ──
  if (PG_CURRENT_SNAPSHOT.test(trimmed)) {
    logger.debug('Rewriting pg_current_snapshot() → mock snapshot');
    return { sql: "SELECT '0:0:' AS snapshot", rewritten: true };
  }

  // ── 6. SELECT pg_snapshot_xmin(pg_current_snapshot()) → mock xmin ──
  if (PG_SNAPSHOT_XMIN.test(trimmed)) {
    logger.debug('Rewriting pg_snapshot_xmin(pg_current_snapshot()) → 0');
    return { sql: 'SELECT 0 AS xmin', rewritten: true };
  }

  // ── 7. SELECT ... FROM pg_stat_all_tables → mock ──
  if (PG_STAT_ALL_TABLES_REF.test(trimmed)) {
    return rewritePgStatAllTables(trimmed);
  }

  // ── 7b. SELECT ... FROM pg_stat_database → mock ──
  if (PG_STAT_DATABASE_REF.test(trimmed)) {
    logger.debug('Rewriting pg_stat_database → mock');
    return { sql: generatePgStatDatabaseSql(), rewritten: true };
  }

  // ── 7c. SELECT ... FROM pg_stat_activity → mock ──
  if (PG_STAT_ACTIVITY_REF.test(trimmed)) {
    logger.debug('Rewriting pg_stat_activity → mock');
    return { sql: generatePgStatActivitySql(), rewritten: true };
  }

  // ── 8. SET vacuum_cost_delay / SET autovacuum_* → SELECT 1 ──
  if (SET_VACUUM_COST.test(trimmed) || SET_AUTOVACUUM.test(trimmed)) {
    logger.debug('Rewriting SET vacuum/autovacuum → SELECT 1');
    return { sql: 'SELECT 1', rewritten: true };
  }

  // ── 9. SHOW <mvcc_param> → mock value ──
  if (SHOW.test(trimmed)) {
    const result = rewriteShowStatement(trimmed);
    if (result) return result;
  }

  // Pass-through for non-MVCC SQL
  return { sql: trimmed, rewritten: false };
}
/**
 * MvccShim — MVCC SQL Rewrite Pipeline
 *
 * Transforms SQL to add __xmin/__xmax/__ctid columns and MVCC visibility.
 * Operates as the LAST shim in the QueryRouter pipeline.
 *
 * Two-phase approach:
 *   Phase 1 (static): CREATE TABLE rewrite — adds MVCC columns, no session context
 *   Phase 2 (context-dependent): SELECT/INSERT/UPDATE/DELETE rewrite — takes XID params
 *
 * Transformations:
 *   1. CREATE TABLE: adds __xmin INTEGER DEFAULT 0, __xmax INTEGER DEFAULT 0, __ctid INTEGER
 *   2. SELECT: adds WHERE (__xmin BETWEEN :xmin AND :xmax) AND (__xmax = 0 OR __xmax > :snapshot_xmin)
 *   3. INSERT: adds __xmin, __xmax, __ctid with VALUES (currentXid, 0, NULL)
 *   4. UPDATE: adds __xmax = 0 condition to WHERE (prevents updating invisible rows)
 *      Actual UPDATE→INSERT rewriting is done by MvccExecutor at PlanExecutor level
 *   5. DELETE: rewrites to UPDATE SET __xmax = currentXid
 *   6. VACUUM: rewrites to DELETE dead rows
 *
 * XID values are inlined directly at shim time (no SQLite UDFs needed for session context).
 */

// Note: PinoLogger imported above; MvccContext import shared.

export interface MvccContext {
  currentXid: number;
  snapshotXmin: number;
  snapshotXmax: number;
  xipList: number[];
}

export const MVCC_COLUMNS = ['__xmin', '__xmax', '__ctid'] as const;
export const SYSTEM_COLUMNS = ['__xmin', '__xmax', '__ctid', 'rowid'];

/**
 * Detect if SQL needs MVCC transformation.
 */
export function detectMvcc(sql: string): boolean {
  const upper = sql.trimStart().toUpperCase();
  return (
    upper.startsWith('CREATE TABLE') ||
    upper.startsWith('SELECT') ||
    upper.startsWith('INSERT') ||
    upper.startsWith('UPDATE') ||
    upper.startsWith('DELETE') ||
    upper.startsWith('VACUUM')
  );
}

/**
 * Phase 1: Add __xmin, __xmax, __ctid to CREATE TABLE statements.
 * Also adds an index on (__xmin, __xmax) for fast visibility checks.
 * No session context needed.
 */
export function rewriteCreateTable(sql: string): string {
  // Skip system/internal tables
  if (/CREATE\s+TABLE\s+(__|pg_|sqlite_)/i.test(sql)) return sql;
  if (/VIRTUAL\s+TABLE/i.test(sql)) return sql;

  const lastParen = sql.lastIndexOf(')');
  if (lastParen === -1) return sql;

  const before = sql.substring(0, lastParen);
  const after = sql.substring(lastParen);

  // Check if MVCC columns already exist
  if (/__xmin/i.test(before)) return sql;

  // Extract table name to create the index
  const tableMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?(\w+)/i);
  const tableName = tableMatch?.[1] || 't';

  return `${before},
  __xmin INTEGER DEFAULT 0,
  __xmax INTEGER DEFAULT 0,
  __ctid INTEGER${after};

CREATE INDEX IF NOT EXISTS idx_${tableName}__mvcc ON ${tableName}(__xmin, __xmax)`;
}

/**
 * Phase 2a: Wrap SELECT with MVCC visibility WHERE clause.
 * Requires session context for XID/snapshot values.
 *
 * Generates:
 *   SELECT ... FROM t WHERE [mvcc_filter] AND [user_conditions]
 *
 * mvcc_filter for READ COMMITTED:
 *   (__xmin > 0 AND __xmin <= {snapshotXmax} AND (__xmax = 0 OR __xmax > {snapshotXmin} OR __xmax = {currentXid}))
 *
 * Simplified for auto-commit:
 *   (__xmin > 0 AND __xmax = 0)
 */
export function wrapSelectWithMvcc(sql: string, ctx: MvccContext): string {
  const upperTrim = sql.trimStart();

  // Skip subqueries, set-returning functions, system tables
  if (!/\bFROM\b/i.test(sql)) return sql;
  if (/FROM\s+(__|sqlite_)/i.test(sql)) return sql;
  if (/WHERE.*__xmin/i.test(sql)) return sql; // Already wrapped
  if (/CREATE\s+.*\bAS\b.*\bSELECT\b/i.test(sql)) return sql; // CREATE TABLE AS SELECT

  if (ctx.currentXid === 0) {
    // Auto-commit: only visible rows (not deleted)
    const mvccFilter = '(__xmin > 0 AND __xmax = 0)';
    return injectWhereClause(sql, mvccFilter);
  }

  // In a transaction: use snapshot
  // __xmin must be ≤ snapshot.xmax (visible at snapshot time)
  // AND (__xmax must be 0 (not deleted) OR > snapshot.xmin (deleted after snapshot))
  const mvccFilter = `(__xmin > 0 AND __xmin <= ${ctx.snapshotXmax} AND (__xmax = 0 OR __xmax > ${ctx.snapshotXmin} OR __xmax = ${ctx.currentXid}))`;
  return injectWhereClause(sql, mvccFilter);
}

/**
 * Phase 2b: Rewrite INSERT to add __xmin, __xmax, __ctid values.
 * Requires session context for currentXid.
 *
 * INSERT INTO t (a, b) VALUES (1, 2)
 *   → INSERT INTO t (__xmin, __xmax, __ctid, a, b) VALUES ({ctx.currentXid}, 0, NULL, 1, 2)
 */
export function rewriteInsertWithMvcc(sql: string, ctx: MvccContext): string {
  // Skip system tables
  if (/INSERT\s+INTO\s+(__|sqlite_)/i.test(sql)) return sql;

  // Match INSERT INTO table [(cols)] VALUES|SELECT|DEFAULT
  const match = sql.match(/^(INSERT\s+INTO\s+\S+?)\s*(?:\(([^)]*)\))?\s*(VALUES|SELECT|DEFAULT)\s*/i);
  if (!match) return sql;

  const insertInto = match[1];
  const existingCols = match[2]?.trim() || '';
  const insertType = match[3].toUpperCase();

  // Skip if already has MVCC columns
  if (/__xmin/i.test(sql)) return sql;

  if (existingCols) {
    // Prepend MVCC columns
    const newCols = `__xmin, __xmax, __ctid, ${existingCols}`;
    const rest = sql.substring(match.index! + match[0].length);

    if (insertType === 'VALUES') {
      // Add 3 placeholder values at the beginning of each value tuple
      const processedValues = rest.replace(/\(([^)]*)\)/g, (_, inner) => {
        return `(${ctx.currentXid}, 0, NULL, ${inner.trim()})`;
      });
      return `${insertInto} (${newCols}) VALUES ${processedValues}`;
    }
    // SELECT: just add MVCC columns
    return `${insertInto} (${newCols}) SELECT ${ctx.currentXid} AS __xmin, 0 AS __xmax, NULL AS __ctid, ${rest.replace(/^select\s+/i, '')}`;
  } else {
    // No columns: add MVCC as first values
    if (insertType === 'VALUES') {
      const valuesIdx = sql.search(/VALUES\s*/i);
      if (valuesIdx === -1) return sql;
      const valuesPart = sql.substring(valuesIdx + 6).trim();
      const processedValues = valuesPart.replace(/\(([^)]*)\)/g, (_, inner) => {
        return `(${ctx.currentXid}, 0, NULL, ${inner.trim()})`;
      });
      return `${insertInto} (__xmin, __xmax, __ctid) VALUES ${processedValues}`;
    }
    if (insertType === 'SELECT') {
      // INSERT INTO t SELECT ... → add MVCC column prefix
      const selectIdx = sql.search(/SELECT\s+/i);
      if (selectIdx === -1) return sql;
      const selectPart = sql.substring(selectIdx);
      // Add MVCC constants as leading columns in SELECT
      const modifiedSelect = selectPart.replace(/^SELECT\s+/i, `SELECT ${ctx.currentXid} AS __xmin, 0 AS __xmax, NULL AS __ctid, `);
      return `${insertInto} (__xmin, __xmax, __ctid) ${modifiedSelect}`;
    }
  }

  return sql;
}

/**
 * Phase 2c: Rewrite UPDATE to add MVCC safety guard.
 * Adds `__xmin > 0 AND __xmax = 0` to WHERE clause.
 *
 * Actual UPDATE→INSERT rewriting happens in MvccExecutor at PlanExecutor level,
 * since it needs access to row IDs and column values.
 */
export function rewriteUpdateWithMvcc(sql: string, _ctx: MvccContext): string {
  // Skip system tables
  if (/UPDATE\s+(__|sqlite_)/i.test(sql)) return sql;
  if (/__xmax\s*=/.test(sql)) return sql; // Already has MVCC

  const whereIdx = sql.search(/\bWHERE\b/i);
  if (whereIdx === -1) {
    return sql + ' WHERE __xmin > 0 AND __xmax = 0';
  }

  const beforeWhere = sql.substring(0, whereIdx + 6);
  const afterWhere = sql.substring(whereIdx + 6).trim();
  return beforeWhere + ` (__xmin > 0 AND __xmax = 0) AND (` + afterWhere + (afterWhere.endsWith(')') ? '' : ')');
}

/**
 * Phase 2d: Rewrite DELETE to UPDATE __xmax = currentXid.
 * Soft-delete: marks row as deleted instead of actually removing it.
 */
export function rewriteDeleteWithMvcc(sql: string, ctx: MvccContext): string {
  // Skip system tables
  if (/DELETE\s+FROM\s+(__|sqlite_)/i.test(sql)) return sql;

  const match = sql.match(/^DELETE\s+FROM\s+(\S+)(?:\s+WHERE\s+(.*))?/i);
  if (!match) return sql;

  const tableName = match[1];
  const whereClause = match[2] || '1=1';

  return `UPDATE ${tableName} SET __xmax = ${ctx.currentXid} WHERE __xmin > 0 AND __xmax = 0 AND (${whereClause})`;
}

/**
 * Phase 2e: Rewrite VACUUM to delete dead rows.
 * Dead rows are those where __xmax ≠ 0 AND the deleting XID is committed.
 * We approximate this as: __xmax != 0 AND __xmax < currentXid.
 */
export function rewriteVacuumWithMvcc(sql: string, ctx: MvccContext): string {
  const isFull = /\bFULL\b/i.test(sql);
  const tableMatch = sql.match(/^VACUUM\s+(?:FULL\s+)?(\S+)?/i);
  const tableName = tableMatch?.[1] || null;

  let result = '';
  if (tableName) {
    result = `DELETE FROM ${tableName} WHERE __xmax != 0 AND __xmax < ${ctx.currentXid - 1}`;
  } else {
    // VACUUM on all tables - gather from sqlite_master
    result = `DELETE FROM sqlite_master WHERE 1=0`; // Placeholder
  }

  if (isFull && tableName) {
    result += '; VACUUM'; // SQLite VACUUM reclaims space
  }

  return result || 'SELECT 1';
}

/**
 * Main entry point: apply ALL static MVCC rewrites (CREATE TABLE).
 * No session context needed.
 */
export function rewriteMvccStatic(sql: string): string {
  const upper = sql.trimStart().toUpperCase();

  if (upper.startsWith('CREATE TABLE')) {
    return rewriteCreateTable(sql);
  }

  return sql;
}

/**
 * Main entry point: apply ALL context-dependent MVCC rewrites.
 * Requires session context for XID/snapshot values.
 */
export function rewriteMvccContext(sql: string, ctx: MvccContext): string {
  const upper = sql.trimStart().toUpperCase();

  if (upper.startsWith('INSERT')) {
    return rewriteInsertWithMvcc(sql, ctx);
  }
  if (upper.startsWith('UPDATE')) {
    return rewriteUpdateWithMvcc(sql, ctx);
  }
  if (upper.startsWith('DELETE')) {
    return rewriteDeleteWithMvcc(sql, ctx);
  }
  if (upper.startsWith('VACUUM')) {
    return rewriteVacuumWithMvcc(sql, ctx);
  }

  // SELECT: wrapped only if FROM exists
  if (upper.startsWith('SELECT') && /\bFROM\b/i.test(upper)) {
    return wrapSelectWithMvcc(sql, ctx);
  }

  return sql;
}

/**
 * Rewrite multi-statement SQL.
 */
export function rewriteMvccBatch(sql: string, ctx: MvccContext | null): string {
  const statements = sql.split(';').filter(s => s.trim());
  const processed = statements.map(stmt => {
    if (ctx) {
      return rewriteMvccContext(rewriteMvccStatic(stmt.trim()), ctx);
    }
    return rewriteMvccStatic(stmt.trim());
  });
  return processed.join(';\n');
}

// ===== Helpers =====

/**
 * AST-aware WHERE clause injection using pgsql-ast-parser.
 *
 * Parses the SQL with location tracking, finds the outermost SELECT's
 * WHERE clause, and injects the MVCC filter at the correct position.
 * Falls back to regex-based injection if AST parsing fails (e.g. for
 * non-SELECT statements that the parser doesn't support).
 *
 * Key advantage over regex-only approach: correctly handles subqueries
 * and CTEs by identifying the *outermost* SELECT's WHERE clause,
 * not the first `\bWHERE\b` occurrence in the text.
 *
 * PG-style `$N` params are accepted; SQLite `?` placeholders are
 * converted to `$N` for parsing only (positions preserved via
 * one-to-one token mapping).
 */
function injectWhereClause(sql: string, mvccFilter: string): string {
  // Try AST-based injection first for SELECT/UNION/WITH
  try {
    // Convert SQLite `?` → PG `$N` for parser compatibility.
    // After injection, convert `$N` back to `?` for the result.
    let paramIdx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++paramIdx}`);
    const result = parseWithComments(pgSql, { locationTracking: true });
    const stmt = result.ast[0];
    if (stmt) {
      // Drill through UNION/INTERSECT/EXCEPT to the last leg
      let outer: any = stmt;
      while (outer.type === 'union' || outer.type === 'intersect' || outer.type === 'except') {
        outer = outer.right;
      }

      // For WITH, the main query's WHERE is on stmt.in
      // For simple SELECT, the WHERE is on outer.where
      // For subqueries, outer.where is the OUTER SELECT's WHERE (correct!)
      const whereNode = outer.type === 'with' ? outer.in?.where : outer.where;

      if (whereNode) {
        const loc = locationOf(whereNode);
        if (typeof loc.start === 'number') {
          // Inject MVCC filter BEFORE the first condition in PG SQL
          const modified = pgSql.slice(0, loc.start) + mvccFilter + ' AND ' + pgSql.slice(loc.start);
          // Convert `$N` back to `?` and return
          return modified.replace(/\$(\d+)/g, '?');
        }
      }
    }
  } catch {
    // AST parse failed — fall through to regex fallback
  }

  // ── Regex fallback (for non-SELECT / parse edge cases) ──
  const whereIdx = sql.search(/\bWHERE\b/i);

  if (whereIdx === -1) {
    // No WHERE: find table expression end
    const fromMatch = sql.match(/\bFROM\s+/i);
    if (!fromMatch) return sql;

    const fromEnd = fromMatch.index! + fromMatch[0].length;
    const rest = sql.substring(fromEnd);
    const endKeywords = /\b(GROUP|ORDER|LIMIT|HAVING|OFFSET|UNION|INTERSECT|EXCEPT|FOR|INTO)\b/i;
    const endMatch = rest.match(endKeywords);

    let tableExpr: string;
    let afterExpr: string;

    if (endMatch) {
      tableExpr = rest.substring(0, endMatch.index!);
      afterExpr = rest.substring(endMatch.index!);
    } else {
      tableExpr = rest;
      afterExpr = '';
    }

    return sql.substring(0, fromEnd) + tableExpr + ` WHERE ${mvccFilter}` + afterExpr;
  } else {
    // Has WHERE: AND the MVCC filter
    const beforeWhere = sql.substring(0, whereIdx);
    const afterWhere: string = sql.substring(whereIdx + 6).trimStart();
    return beforeWhere + `WHERE ${mvccFilter} AND (` + afterWhere + (afterWhere.endsWith(')') ? '' : ')');
  }
}

/**
 * Detects whether a SELECT query needs MVCC row-level visibility injection.
 * This is called during active MVCC transactions to filter out rows that
 * are not visible to the current transaction's snapshot.
 *
 * Currently returns false (visibility filtering is done at the MVCCExecutor
 * layer via predicate locks, not via SQL rewriting).
 */
export function detectMVCCVisible(_sql: string): boolean {
  return false;
}

/**
 * Rewrites a SELECT query to inject MVCC visibility predicates into the
 * WHERE clause. Not currently used (visibility is managed by MVCCExecutor
 * at runtime) — kept as a future optimization path.
 */
export function rewriteMVCCVisible(
  sql: string,
  _snapshot: any,
  _xid: number,
  _isolation: string,
): { rewritten: boolean; sql: string } {
  return { rewritten: false, sql };
}
