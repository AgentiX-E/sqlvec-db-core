/**
 * UnloggedTableShim — PostgreSQL UNLOGGED TABLE compatibility shim for SQLite.
 *
 * PostgreSQL supports `CREATE UNLOGGED TABLE` to create tables that do not
 * write to the Write-Ahead Log (WAL), providing faster writes at the cost
 * of crash-safety. The `UNLOGGED` keyword can also appear alongside
 * `TEMP`/`TEMPORARY`:
 *
 * ```sql
 * CREATE UNLOGGED TABLE t (id int);
 * CREATE TEMP UNLOGGED TABLE t (id int);
 * CREATE TEMPORARY UNLOGGED TABLE t (id int);
 * ```
 *
 * SQLite does not support the UNLOGGED keyword — it has no concept of WAL
 * logging at the table level. Since sqlvec-db's backend always operates
 * with SQLite's WAL mode enabled at the connection level, the UNLOGGED
 * keyword is semantically irrelevant and can be safely stripped.
 *
 * ## Strategy
 *
 * Strip the UNLOGGED keyword from DDL statements while preserving all other
 * SQL structure. The `TEMP`/`TEMPORARY` modifier, if present, is preserved.
 *
 * | Input                                                     | Output                                    | rewritten |
 * |-----------------------------------------------------------|-------------------------------------------|-----------|
 * | `CREATE UNLOGGED TABLE t (id int)`                       | `CREATE TABLE t (id int)`                 | true      |
 * | `CREATE TEMP UNLOGGED TABLE t (id int)`                  | `CREATE TEMP TABLE t (id int)`            | true      |
 * | `CREATE TEMPORARY UNLOGGED TABLE t (id int)`             | `CREATE TEMPORARY TABLE t (id int)`       | true      |
 * | `CREATE TABLE t (id int)`                                | (pass-through)                            | false     |
 * | `SELECT 1;`                                              | (pass-through)                            | false     |
 * | `INSERT INTO t VALUES (1);`                              | (pass-through)                            | false     |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-CREATE-TABLE SQL
 * - Detection is case-insensitive (SQL keywords are case-insensitive)
 * - PinoLogger integration for debugging and audit trails
 *
 * @module UnloggedTableShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('UnloggedTableShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface UnloggedTableResult {
  /** The (potentially rewritten) SQL string */
  sql: string;
  /** Whether the statement was detected as UNLOGGED TABLE and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches a CREATE ... UNLOGGED TABLE statement.
 *
 * Case-insensitive. Captures the optional TEMP/TEMPORARY modifier so it
 * can be preserved after stripping UNLOGGED.
 *
 * Capture groups:
 *   1 — `CREATE\s+` prefix
 *   2 — Optional `TEMP\s+` or `TEMPORARY\s+` modifier
 *   3 — The `TABLE` keyword (boundary-safe)
 *
 * The full pattern matches:
 *   CREATE [TEMP|TEMPORARY] UNLOGGED TABLE
 *
 * @see {@link rewriteUnloggedTable} for usage
 */
const UNLOGGED_TABLE_PATTERN = /\b(CREATE\s+)((?:TEMP|TEMPORARY)\s+)?UNLOGGED\s+(TABLE\b)/i;

/**
 * Simplified detection-only pattern — checks whether the SQL contains a
 * `CREATE ... UNLOGGED TABLE` construct at all.
 *
 * Case-insensitive, requires `CREATE`, optional `TEMP`/`TEMPORARY`,
 * then `UNLOGGED TABLE`.
 */
const UNLOGGED_TABLE_DETECT = /\bCREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?UNLOGGED\s+TABLE\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a `CREATE UNLOGGED TABLE`
 * statement.
 *
 * Performs a case-insensitive check for the `CREATE [TEMP|TEMPORARY]
 * UNLOGGED TABLE` pattern. Returns `true` only when UNLOGGED appears
 * between CREATE and TABLE — this avoids false positives on identifiers
 * or comments containing the word `unlogged`.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL contains a CREATE UNLOGGED TABLE statement
 *
 * @example
 * ```ts
 * detectUnloggedTable('CREATE UNLOGGED TABLE t (id int)');              // true
 * detectUnloggedTable('CREATE TEMP UNLOGGED TABLE t (id int)');        // true
 * detectUnloggedTable('CREATE TEMPORARY UNLOGGED TABLE t (id int)');   // true
 * detectUnloggedTable('CREATE TABLE t (id int)');                       // false
 * detectUnloggedTable('SELECT * FROM t');                               // false
 * detectUnloggedTable('');                                              // false
 * ```
 */
export function detectUnloggedTable(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Quick prefix check — avoids running regex on every statement
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('CREATE ')) {
    return false;
  }

  return UNLOGGED_TABLE_DETECT.test(trimmed);
}

/**
 * Rewrite a PostgreSQL `CREATE UNLOGGED TABLE` statement to a
 * SQLite-compatible `CREATE TABLE` statement.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not a CREATE UNLOGGED TABLE statement, return unchanged
 *    with `rewritten: false`.
 * 2. If it is a CREATE UNLOGGED TABLE statement, strip the `UNLOGGED`
 *    keyword while preserving all other SQL structure (including optional
 *    `TEMP`/`TEMPORARY` modifiers).
 *
 * The replacement preserves the original whitespace and casing of all
 * non-UNLOGGED parts.
 *
 * @param sql   The raw SQL string to process
 * @returns     An {@link UnloggedTableResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteUnloggedTable('CREATE UNLOGGED TABLE t (id int)');
 * // → { sql: 'CREATE TABLE t (id int)', rewritten: true }
 *
 * rewriteUnloggedTable('CREATE TEMP UNLOGGED TABLE t (id int)');
 * // → { sql: 'CREATE TEMP TABLE t (id int)', rewritten: true }
 *
 * rewriteUnloggedTable('CREATE TABLE t (id int)');
 * // → { sql: 'CREATE TABLE t (id int)', rewritten: false }
 * ```
 */
export function rewriteUnloggedTable(sql: string): UnloggedTableResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Is this even a CREATE UNLOGGED TABLE statement? ─────

  if (!detectUnloggedTable(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'Not a CREATE UNLOGGED TABLE statement — passing through unchanged',
    );
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 2: Rewrite by stripping the UNLOGGED keyword ──────────

  const rewritten = trimmed.replace(
    UNLOGGED_TABLE_PATTERN,
    (_match, create: string, temp: string | undefined, table: string) => {
      // $1 = "CREATE " (preserved)
      // $2 = "TEMP " or "TEMPORARY " or undefined (preserved if present)
      // $3 = "TABLE" (preserved)
      return `${create}${temp ?? ''}${table}`;
    },
  );

  logger.debug(
    { original: trimmed, rewritten },
    'UNLOGGED TABLE detected — stripping UNLOGGED keyword',
  );

  return {
    sql: rewritten,
    rewritten: true,
  };
}
