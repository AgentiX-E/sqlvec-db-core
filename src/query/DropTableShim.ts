/**
 * DropTableShim — PostgreSQL DROP TABLE ... , compatibility shim for SQLite.
 *
 * PostgreSQL supports dropping multiple tables in a single statement:
 *   DROP TABLE [IF EXISTS] t1, t2, t3, ...;
 *
 * SQLite requires one table per DROP:
 *   DROP TABLE IF EXISTS t1;
 *   DROP TABLE IF EXISTS t2;
 *   ...
 *
 * This shim rewrites the PostgreSQL comma-separated form into a series
 * of individual DROP TABLE statements. When used during the SQL rewrite
 * pipeline, the rewritten string (with semicolons) is handled by calling
 * the SQLite exec() method which supports multi-statement strings natively.
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('DropTableShim');

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches DROP TABLE with comma-separated table names.
 *
 * Captures:
 *   Group 1: "IF EXISTS " (or empty string)
 *   Group 2: The first table name (including optional schema qualifier)
 *   Group 3: The remaining comma-separated table names
 *
 * Examples that match:
 *   DROP TABLE t1, t2;
 *   DROP TABLE IF EXISTS t1, t2, t3, t4;
 *   DROP TABLE "pgbench_accounts", "pgbench_branches";
 *
 * Non-matching (pass-through):
 *   DROP TABLE t1;                         — single table
 *   DROP TABLE IF EXISTS t1;               — single table with IF EXISTS
 *   DROP VIEW t1;                          — not a TABLE
 */
const DROP_TABLE_MULTI = /^\s*DROP\s+TABLE\s+(IF\s+EXISTS\s+)?([`"']?\w+[`"']?(?:\s*\.\s*[`"']?\w+[`"']?)?)\s*,\s*([^;]+);?\s*$/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

export interface DropTableResult {
  /** Rewritten SQL (null if already SQLite-compatible) */
  sql: string | null;
  /** Whether the statement was detected and rewritten */
  rewritten: boolean;
}

/**
 * Detect whether the given SQL string contains a PostgreSQL DROP TABLE
 * with multiple comma-separated table names.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL has comma-separated tables after DROP TABLE
 */
export function detectMultiTableDrop(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return DROP_TABLE_MULTI.test(sql.trim());
}

/**
 * Rewrite a PostgreSQL multi-table DROP TABLE into individual statements
 * separated by semicolons.
 *
 * Example:
 *   Input:  "DROP TABLE IF EXISTS pgbench_accounts, pgbench_branches, pgbench_history, pgbench_tellers"
 *   Output: "DROP TABLE IF EXISTS pgbench_accounts; DROP TABLE IF EXISTS pgbench_branches; DROP TABLE IF EXISTS pgbench_history; DROP TABLE IF EXISTS pgbench_tellers"
 *
 * @param sql   The raw SQL string to process
 * @returns     A DropTableResult with the rewritten SQL
 */
export function rewriteMultiTableDrop(sql: string): DropTableResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: null, rewritten: false };
  }

  const trimmed = sql.trim();

  const match = DROP_TABLE_MULTI.exec(trimmed);
  if (!match) {
    return { sql: null, rewritten: false };
  }

  const ifExists = match[1] || '';
  const firstTable = match[2];
  const restStr = match[3];

  // Parse remaining table names (split by comma)
  const tableNames = restStr
    .split(',')
    .map((t) => t.trim().replace(/[;]$/, '').trim())
    .filter(Boolean);

  // Build individual DROP TABLE statements
  const parts: string[] = [
    `DROP TABLE ${ifExists}${firstTable}`,
    ...tableNames.map((t) => `DROP TABLE ${ifExists}${t}`),
  ];

  const result = parts.join('; ');

  logger.debug(
    { original: trimmed, rewritten: result, tableCount: parts.length },
    'Multi-table DROP TABLE expanded into individual statements',
  );

  return { sql: result, rewritten: true };
}
