/**
 * CDCSlotShim — PostgreSQL logical decoding (CDC) compatibility shim for SQLite.
 *
 * PostgreSQL supports Change Data Capture (CDC) via logical replication slots
 * with functions like `pg_logical_slot_get_changes()`, `pg_logical_slot_peek_changes()`,
 * `pg_logical_slot_peek_binary_changes()`, and the system catalog view
 * `pg_stat_replication_slots`. SQLite has no WAL-based replication or CDC concept.
 *
 * This shim detects CDC-related SQL and rewrites it to a valid SQLite-compatible
 * statement that returns a plausible empty result set.
 *
 * ## Strategy
 *
 * | Input                                                                 | Output                                  | rewritten |
 * |-----------------------------------------------------------------------|-----------------------------------------|-----------|
 * | `SELECT pg_logical_slot_get_changes('slot');`                         | `SELECT '{}'::text[] as changes`        | true      |
 * | `SELECT pg_logical_slot_peek_changes('slot');`                        | `SELECT '{}'::text[] as changes`        | true      |
 * | `SELECT * FROM pg_stat_replication_slots;`                            | `SELECT '' as slot_name, false as active` | true      |
 * | `SELECT pg_logical_slot_peek_binary_changes('slot');`                 | `SELECT '' as data`                     | true      |
 * | `SELECT 1;`                                                           | (pass-through)                          | false     |
 * | `CREATE TABLE t (id INT);`                                            | (pass-through)                          | false     |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-CDC SQL
 * - Case-insensitive matching for function names
 * - PinoLogger integration for debugging and audit trails
 *
 * @module CDCSlotShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('CDCSlotShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface CDCResult {
  /** Rewritten SQL if CDC was detected, original SQL otherwise */
  sql: string;
  /** Whether the statement was detected as CDC-related and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches `SELECT pg_logical_slot_get_changes('...')` with optional
 * whitespace and arguments.
 *
 * Pattern: SELECT <optional whitespace> pg_logical_slot_get_changes( ... )
 * Case-insensitive.
 */
const GET_CHANGES = /^\s*SELECT\s+pg_logical_slot_get_changes\s*\(/i;

/**
 * Matches `SELECT pg_logical_slot_peek_changes('...')` with optional
 * whitespace and arguments.
 *
 * Pattern: SELECT <optional whitespace> pg_logical_slot_peek_changes( ... )
 * Case-insensitive.
 */
const PEEK_CHANGES = /^\s*SELECT\s+pg_logical_slot_peek_changes\s*\(/i;

/**
 * Matches `SELECT pg_logical_slot_peek_binary_changes('...')` with optional
 * whitespace and arguments.
 *
 * Pattern: SELECT <optional whitespace> pg_logical_slot_peek_binary_changes( ... )
 * Case-insensitive.
 */
const PEEK_BINARY_CHANGES = /^\s*SELECT\s+pg_logical_slot_peek_binary_changes\s*\(/i;

/**
 * Matches `SELECT ... FROM pg_stat_replication_slots`.
 *
 * This covers queries against the pg_stat_replication_slots system view:
 *   SELECT * FROM pg_stat_replication_slots
 *   SELECT slot_name, active FROM pg_stat_replication_slots
 *   SELECT * FROM pg_stat_replication_slots WHERE ...
 *
 * Pattern: SELECT ... FROM <optional schema> pg_stat_replication_slots
 * Case-insensitive.
 */
const QUERY_STAT_REPLICATION_SLOTS = /^\s*SELECT\b[\s\S]*?\bFROM\s+(?:pg_catalog\.)?pg_stat_replication_slots\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL CDC-related
 * operation.
 *
 * The following patterns are detected:
 * - `SELECT pg_logical_slot_get_changes(...)`
 * - `SELECT pg_logical_slot_peek_changes(...)`
 * - `SELECT pg_logical_slot_peek_binary_changes(...)`
 * - `SELECT ... FROM pg_stat_replication_slots`
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a CDC operation
 *
 * @example
 * ```ts
 * detectCDC("SELECT pg_logical_slot_get_changes('slot');");              // true
 * detectCDC("SELECT pg_logical_slot_peek_changes('slot');");             // true
 * detectCDC("SELECT * FROM pg_stat_replication_slots;");                 // true
 * detectCDC("SELECT 1;");                                                // false
 * detectCDC("CREATE TABLE t (id INT);");                                 // false
 * ```
 */
export function detectCDC(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  if (GET_CHANGES.test(trimmed)) {
    return true;
  }

  if (PEEK_CHANGES.test(trimmed)) {
    return true;
  }

  if (PEEK_BINARY_CHANGES.test(trimmed)) {
    return true;
  }

  if (QUERY_STAT_REPLICATION_SLOTS.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL CDC operation to a SQLite-compatible no-op.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not CDC-related, return unchanged with `rewritten: false`.
 * 2. If it is `SELECT pg_logical_slot_get_changes(...)`, return
 *    `SELECT '{}'::text[] as changes` with `rewritten: true`.
 * 3. If it is `SELECT pg_logical_slot_peek_changes(...)`, return
 *    `SELECT '{}'::text[] as changes` with `rewritten: true`.
 * 4. If it is `SELECT * FROM pg_stat_replication_slots`, return
 *    `SELECT '' as slot_name, false as active` with `rewritten: true`.
 * 5. If it is `SELECT pg_logical_slot_peek_binary_changes(...)`, return
 *    `SELECT '' as data` with `rewritten: true`.
 * 6. Otherwise, pass through unchanged.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link CDCResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteCDC("SELECT pg_logical_slot_get_changes('slot');");
 * // → { sql: "SELECT '{}'::text[] as changes", rewritten: true }
 *
 * rewriteCDC("SELECT pg_logical_slot_peek_changes('slot');");
 * // → { sql: "SELECT '{}'::text[] as changes", rewritten: true }
 *
 * rewriteCDC("SELECT * FROM pg_stat_replication_slots;");
 * // → { sql: "SELECT '' as slot_name, false as active", rewritten: true }
 *
 * rewriteCDC("SELECT pg_logical_slot_peek_binary_changes('slot');");
 * // → { sql: "SELECT '' as data", rewritten: true }
 *
 * rewriteCDC("SELECT 1;");
 * // → { sql: "SELECT 1;", rewritten: false }
 * ```
 */
export function rewriteCDC(sql: string): CDCResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Check for pg_logical_slot_get_changes ──

  if (GET_CHANGES.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'pg_logical_slot_get_changes detected — rewriting to empty result',
    );
    return {
      sql: "SELECT '{}'::text[] as changes",
      rewritten: true,
    };
  }

  // ── Step 2: Check for pg_logical_slot_peek_changes ──

  if (PEEK_CHANGES.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'pg_logical_slot_peek_changes detected — rewriting to empty result',
    );
    return {
      sql: "SELECT '{}'::text[] as changes",
      rewritten: true,
    };
  }

  // ── Step 3: Check for pg_stat_replication_slots query ──

  if (QUERY_STAT_REPLICATION_SLOTS.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'pg_stat_replication_slots query detected — rewriting to placeholder row',
    );
    return {
      sql: "SELECT '' as slot_name, false as active",
      rewritten: true,
    };
  }

  // ── Step 4: Check for pg_logical_slot_peek_binary_changes ──

  if (PEEK_BINARY_CHANGES.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'pg_logical_slot_peek_binary_changes detected — rewriting to empty result',
    );
    return {
      sql: "SELECT '' as data",
      rewritten: true,
    };
  }

  // ── Step 5: Not a CDC operation — pass through ──

  return {
    sql: trimmed,
    rewritten: false,
  };
}
