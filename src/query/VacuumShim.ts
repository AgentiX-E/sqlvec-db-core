/**
 * VacuumShim — PostgreSQL VACUUM compatibility shim for SQLite.
 *
 * PostgreSQL supports VACUUM with multiple options (FULL, VERBOSE, ANALYZE,
 * FREEZE, parenthesized option lists, and optional table names). SQLite
 * supports only basic VACUUM syntax:
 *
 * ```sql
 * VACUUM;                  -- SQLite-compatible
 * VACUUM schema-name;      -- SQLite 3.36+ (schema name only)
 * VACUUM INTO filename;    -- SQLite 3.27+
 * ```
 *
 * This shim detects PG-specific VACUUM variants and strips the
 * incompatible options, producing a bare `VACUUM` statement that
 * SQLite can execute.
 *
 * ## Strategy
 *
 * | Input                                              | Output       | rewritten |
 * |----------------------------------------------------|--------------|-----------|
 * | `VACUUM FULL;`                                     | `VACUUM`     | true      |
 * | `VACUUM VERBOSE;`                                  | `VACUUM`     | true      |
 * | `VACUUM ANALYZE;`                                  | `VACUUM`     | true      |
 * | `VACUUM FREEZE;`                                   | `VACUUM`     | true      |
 * | `VACUUM FULL VERBOSE ANALYZE my_table;`            | `VACUUM`     | true      |
 * | `VACUUM (FULL, VERBOSE, ANALYZE);`                 | `VACUUM`     | true      |
 * | `VACUUM;`                                          | `VACUUM`     | false     |
 * | `VACUUM main;`                                     | `VACUUM main`| false     |
 * | `VACUUM INTO backup.db;`                           | (pass-through)| false    |
 * | `SELECT 1;`                                        | (pass-through)| false    |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-VACUUM SQL
 * - SQLite-compatible VACUUM variants pass through unchanged
 * - PinoLogger integration for debugging and audit trails
 *
 * ## Autovacuum Hook
 *
 * A mutation notification callback can be registered via
 * `setVacuumMutationHook()`. When a VACUUM is detected (either stripped
 * PG variant or SQLite-compatible), the hook is called with the table
 * name so the AutovacuumDaemon can reset its dead tuple counters.
 *
 * @module VacuumShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('VacuumShim');

// ──────────────────────────────────────────────
//  Mutation Hook (for AutovacuumDaemon integration)
// ──────────────────────────────────────────────

/**
 * Callback type for vacuum mutation notifications.
 * Called when a VACUUM operation is processed.
 */
export type VacuumHookCallback = (tableName?: string) => void;

/** Registered autovacuum hook (null if not set) */
let vacuumMutationHook: VacuumHookCallback | null = null;

/**
 * Register a callback to be notified when VACUUM is processed.
 * Used by AutovacuumDaemon to reset internal dead tuple counters.
 *
 * @param hook  The callback to invoke on VACUUM detection, or null to clear
 */
export function setVacuumMutationHook(hook: VacuumHookCallback | null): void {
  vacuumMutationHook = hook;
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface VacuumResult {
  /** Rewritten SQL (bare "VACUUM" if PG options stripped, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as PG-specific and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches the start of any VACUUM statement.
 * Case-insensitive, allows leading whitespace.
 */
const VACUUM_PREFIX = /^\s*VACUUM\b/i;

/**
 * Matches VACUUM INTO (SQLite 3.27+).
 * This is SQLite-compatible and should pass through unchanged.
 */
const VACUUM_INTO = /^\s*VACUUM\s+INTO\s+/i;

/**
 * Matches VACUUM with a parenthesized option list:
 *   VACUUM (FULL, VERBOSE, ANALYZE);
 *   VACUUM (FULL, FREEZE);
 *
 * Parenthesized options are a PG-only syntax that SQLite does not support.
 */
const VACUUM_PAREN_OPTIONS = /^\s*VACUUM\s*\(/i;

/**
 * Matches VACUUM followed by one or more PG-specific space-separated keywords.
 *
 * PG keywords after VACUUM:
 *   - FULL
 *   - VERBOSE
 *   - ANALYZE
 *   - FREEZE
 *
 * If the first non-whitespace token after VACUUM is one of these keywords,
 * the statement is PG-specific and needs to be stripped.
 */
const VACUUM_PG_KEYWORD = /^\s*VACUUM\s+(?:FULL|VERBOSE|ANALYZE|FREEZE)\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL-specific
 * VACUUM statement (with PG-only options FULL, VERBOSE, ANALYZE, FREEZE,
 * or parenthesized option lists).
 *
 * Bare `VACUUM`, `VACUUM schema-name`, and `VACUUM INTO` (all
 * SQLite-compatible) return `false`.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a PG-specific VACUUM variant
 *
 * @example
 * ```ts
 * detectPgVacuum('VACUUM FULL;');                              // true
 * detectPgVacuum('VACUUM (FULL, VERBOSE);');                  // true
 * detectPgVacuum('VACUUM ANALYZE my_table;');                 // true
 * detectPgVacuum('VACUUM;');                                   // false
 * detectPgVacuum('VACUUM INTO backup.db;');                   // false
 * detectPgVacuum('SELECT * FROM t;');                          // false
 * ```
 */
export function detectPgVacuum(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast path: must start with VACUUM
  if (!VACUUM_PREFIX.test(trimmed)) {
    return false;
  }

  // Check for parenthesized options: VACUUM (options)
  if (VACUUM_PAREN_OPTIONS.test(trimmed)) {
    return true;
  }

  // Check for PG space-separated keywords: VACUUM FULL|VERBOSE|ANALYZE|FREEZE
  if (VACUUM_PG_KEYWORD.test(trimmed)) {
    return true;
  }

  // VACUUM INTO and bare VACUUM / VACUUM schema-name → not PG-specific
  return false;
}

/**
 * Rewrite a PostgreSQL VACUUM statement to SQLite-compatible syntax.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not a VACUUM statement, return unchanged with
 *    `rewritten: false`.
 * 2. If it is `VACUUM INTO` (SQLite 3.27+), pass through unchanged.
 * 3. If it is bare `VACUUM` or `VACUUM schema-name` (SQLite compatible),
 *    pass through unchanged.
 * 4. If it contains PG-specific keywords (FULL, VERBOSE, ANALYZE, FREEZE)
 *    or uses parenthesized option syntax, strip to a bare `VACUUM` with
 *    `rewritten: true`.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link VacuumResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteVacuum('VACUUM FULL VERBOSE ANALYZE my_table;');
 * // → { sql: 'VACUUM', rewritten: true }
 *
 * rewriteVacuum('VACUUM;');
 * // → { sql: 'VACUUM;', rewritten: false }
 *
 * rewriteVacuum('VACUUM INTO backup.db;');
 * // → { sql: 'VACUUM INTO backup.db;', rewritten: false }
 * ```
 */
export function rewriteVacuum(sql: string): VacuumResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Is this even a VACUUM statement? ────────────────

  if (!VACUUM_PREFIX.test(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 2: Extract table name if present (before processing) ─

  // Try to extract table name from various VACUUM forms:
  //   VACUUM FULL VERBOSE ANALYZE my_table;
  //   VACUUM my_schema.my_table;
  //   VACUUM (options) my_table;
  const TABLE_AFTER_VACUUM = /^\s*VACUUM\s+(?:\([^)]*\)\s+)?(?:\w+\s+)*(?:ANALYZE\s+|FREEZE\s+|VERBOSE\s+|FULL\s+)*(?:(\w+(?:\.\w+)?))?/i;
  const tableMatch = TABLE_AFTER_VACUUM.exec(trimmed);
  const extractedTable = tableMatch?.[1] || undefined;

  // ── Step 3: Check for SQLite-compatible VACUUM variants ─────

  // VACUUM INTO filename — SQLite 3.27+, pass through unchanged
  if (VACUUM_INTO.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'VACUUM INTO detected — passing through (SQLite-compatible)',
    );
    // Notify autovacuum hook
    if (vacuumMutationHook) {
      vacuumMutationHook(extractedTable);
    }
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // Bare VACUUM or VACUUM schema-name — SQLite-compatible
  // Only rewrite if PG-specific options are present
  const hasParenOptions = VACUUM_PAREN_OPTIONS.test(trimmed);
  const hasPgKeyword = VACUUM_PG_KEYWORD.test(trimmed);

  if (!hasParenOptions && !hasPgKeyword) {
    logger.debug(
      { sql: trimmed },
      'SQLite-compatible VACUUM detected — passing through',
    );
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 4: PG-specific VACUUM — strip to bare VACUUM ───────

  logger.debug(
    { sql: trimmed, hasParenOptions, hasPgKeyword },
    'PostgreSQL-specific VACUUM detected — stripping options',
  );

  // Notify autovacuum hook that a VACUUM was performed
  if (vacuumMutationHook) {
    vacuumMutationHook(extractedTable);
  }

  return {
    sql: 'VACUUM',
    rewritten: true,
  };
}
