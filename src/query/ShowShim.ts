/**
 * ShowShim.ts — Handle SHOW commands by rewriting to SELECT
 *
 * SQLite doesn't understand `SHOW server_version` (PG-specific syntax).
 * This shim rewrites common SHOW commands to SELECT queries that
 * return PG-compatible results.
 */

// Map of SHOW parameter names to their values
const SHOW_VALUES: Record<string, string> = {
  'server_version': '16.4',
  'server_version_num': '160004',
  'server_encoding': 'UTF8',
  'client_encoding': 'UTF8',
  'standard_conforming_strings': 'on',
  'session_authorization': 'postgres',
  'is_superuser': 'on',
  'TimeZone': 'UTC',
  'DateStyle': 'ISO, MDY',
  'IntervalStyle': 'postgres',
  'integer_datetimes': 'on',
  'lc_collate': 'en_US.UTF-8',
  'lc_ctype': 'en_US.UTF-8',
  'lc_messages': 'en_US.UTF-8',
  'lc_monetary': 'en_US.UTF-8',
  'lc_numeric': 'en_US.UTF-8',
  'lc_time': 'en_US.UTF-8',
  'max_connections': '100',
  'block_size': '8192',
  'data_checksums': 'off',
  'debug_assertions': 'off',
  'default_transaction_read_only': 'off',
  'in_hot_standby': 'off',
  'max_function_args': '100',
  'max_index_keys': '32',
  'max_prepared_transactions': '0',
  'max_replication_slots': '10',
  'max_wal_senders': '10',
  'row_security': 'on',
  'statement_timeout': '0',
  'transaction_isolation': 'read committed',
  'transaction_read_only': 'off',
  'wal_buffers': '4MB',
  'wal_level': 'replica',
  'ssl': 'off',
  'sslmode': 'disable',
};

/**
 * SHOW prefix patterns for fast filtering
 */
const SHOW_PREFIX = /^\s*SHOW\s+/i;

/**
 * Extract param name from `SHOW param_name` (with optional trailing semicolon)
 */
const SHOW_PARAM_RE = /^\s*SHOW\s+(\w+(?:\.\w+)?)\s*;?\s*$/i;

/**
 * Returns true if the SQL is a simple `SHOW param` statement.
 */
export function detectShow(sql: string): boolean {
  if (typeof sql !== 'string') return false;
  return SHOW_PREFIX.test(sql.trim());
}

/**
 * Rewrite a SHOW command to a SELECT statement.
 *
 * Returns the rewritten SQL if the parameter is known,
 * or the original SQL if unknown (will fail at SQLite layer, which is fine).
 */
export function rewriteShow(sql: string): string | null {
  if (typeof sql !== 'string') return null;

  const match = sql.trim().match(SHOW_PARAM_RE);
  if (!match) return null;

  const paramName = match[1].toLowerCase();
  const value = SHOW_VALUES[paramName];
  if (value === undefined) return null; // unknown param, let SQLite handle it

  return `SELECT '${value}' AS "${match[1]}"`;
}
