/**
 * ReplicationSlotShim — PostgreSQL replication slot compatibility shim for SQLite.
 *
 * PostgreSQL supports replication slots (`pg_create_physical_replication_slot`,
 * `pg_create_logical_replication_slot`, `pg_drop_replication_slot`, and
 * querying `pg_replication_slots`) to ensure WAL segments are not removed
 * before they are consumed by replicas. SQLite has no replication concept.
 *
 * This shim detects PG replication slot SQL and rewrites it to use a real
 * in-memory {@link ReplicationSlotTracker} that tracks slot lifecycle,
 * providing PG-compatible slot names, types, and LSN positions.
 *
 * ## Strategy
 *
 * | Input                                                       | Output                       | sql    | rewritten |
 * |-------------------------------------------------------------|------------------------------|--------|-----------|
 * | `SELECT pg_create_physical_replication_slot('slot_name');`  | (tracker state updated)      | null   | true      |
 * | `SELECT pg_create_logical_replication_slot('s', 'pgoutput');` | (tracker state updated)    | null   | true      |
 * | `SELECT pg_drop_replication_slot('slot_name');`             | (tracker state updated)      | null   | true      |
 * | `SELECT * FROM pg_replication_slots;`                       | UNION ALL of tracked slots   | SQL    | true      |
 * | `SELECT 1;`                                                 | (pass-through)               | orig   | false     |
 * | `CREATE TABLE t (id INT);`                                  | (pass-through)               | orig   | false     |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-replication-slot SQL
 * - Case-insensitive matching for function names
 * - PinoLogger integration for debugging and audit trails
 *
 * @module ReplicationSlotShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { ReplicationSlotTracker } from '../storage/ReplicationSlotTracker';

const logger = PinoLogger.forComponent('ReplicationSlotShim');
const tracker = ReplicationSlotTracker.getInstance();

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ReplSlotResult {
  /**
   * Rewritten SQL, or `null` if no SQL needs to be executed (the operation
   * was purely a state mutation, e.g. create/drop slot).
   *
   * - `null` → no SQL to execute; the caller should skip execution entirely
   * - `string` → the rewritten SQL to execute (e.g. UNION ALL of slots)
   */
  sql: string | null;
  /** Whether the statement was detected as a replication slot operation and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches `SELECT pg_create_physical_replication_slot('...')` with optional
 * whitespace and argument. Captures the slot name in group 1.
 *
 * Pattern: SELECT <optional whitespace> pg_create_physical_replication_slot( 'name' )
 * Case-insensitive.
 */
const CREATE_PHYSICAL_SLOT = /^\s*SELECT\s+pg_create_physical_replication_slot\s*\(\s*'([^']*)'\s*\)/i;

/**
 * Matches `SELECT pg_create_logical_replication_slot('...', '...')` with
 * optional whitespace and arguments. Captures the slot name in group 1.
 *
 * Pattern: SELECT <optional whitespace> pg_create_logical_replication_slot( 'name', 'plugin' )
 * Case-insensitive.
 */
const CREATE_LOGICAL_SLOT = /^\s*SELECT\s+pg_create_logical_replication_slot\s*\(\s*'([^']*)'\s*,/i;

/**
 * Matches `SELECT pg_drop_replication_slot('...')` with optional whitespace
 * and argument. Captures the slot name in group 1.
 *
 * Pattern: SELECT <optional whitespace> pg_drop_replication_slot( 'name' )
 * Case-insensitive.
 */
const DROP_REPLICATION_SLOT = /^\s*SELECT\s+pg_drop_replication_slot\s*\(\s*'([^']*)'\s*\)/i;

/**
 * Matches `SELECT * FROM pg_replication_slots` (or `SELECT ... FROM pg_replication_slots`).
 *
 * This covers queries against the pg_replication_slots system catalog:
 *   SELECT * FROM pg_replication_slots
 *   SELECT slot_name, active FROM pg_replication_slots
 *   SELECT * FROM pg_replication_slots WHERE slot_name = 'x'
 *
 * Pattern: SELECT ... FROM <optional schema> pg_replication_slots
 * Case-insensitive.
 */
const QUERY_REPLICATION_SLOTS = /^\s*SELECT\b[\s\S]*?\bFROM\s+(?:pg_catalog\.)?pg_replication_slots\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL replication
 * slot operation.
 *
 * The following patterns are detected:
 * - `SELECT pg_create_physical_replication_slot(...)`
 * - `SELECT pg_create_logical_replication_slot(...)`
 * - `SELECT pg_drop_replication_slot(...)`
 * - `SELECT ... FROM pg_replication_slots`
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a replication slot operation
 *
 * @example
 * ```ts
 * detectReplSlot("SELECT pg_create_physical_replication_slot('slot1');");        // true
 * detectReplSlot("SELECT pg_create_logical_replication_slot('s', 'pgoutput');");  // true
 * detectReplSlot("SELECT pg_drop_replication_slot('slot1');");                    // true
 * detectReplSlot("SELECT * FROM pg_replication_slots;");                          // true
 * detectReplSlot("SELECT 1;");                                                    // false
 * detectReplSlot("CREATE TABLE t (id INT);");                                     // false
 * ```
 */
export function detectReplSlot(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Check for pg_create_physical_replication_slot(...)
  if (CREATE_PHYSICAL_SLOT.test(trimmed)) {
    return true;
  }

  // Check for pg_create_logical_replication_slot(...)
  if (CREATE_LOGICAL_SLOT.test(trimmed)) {
    return true;
  }

  // Check for pg_drop_replication_slot(...)
  if (DROP_REPLICATION_SLOT.test(trimmed)) {
    return true;
  }

  // Check for SELECT ... FROM pg_replication_slots
  if (QUERY_REPLICATION_SLOTS.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL replication slot operation using the real
 * {@link ReplicationSlotTracker}.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not a replication slot operation, return unchanged with
 *    `rewritten: false`.
 * 2. If it is `SELECT pg_create_physical_replication_slot('name')`, create
 *    a physical slot in the tracker and return `{ sql: null, rewritten: true }`.
 *    The caller should skip SQL execution (the operation is purely a state
 *    mutation).
 * 3. If it is `SELECT pg_create_logical_replication_slot('name', 'plugin')`,
 *    create a logical slot in the tracker and return `{ sql: null, rewritten: true }`.
 * 4. If it is `SELECT pg_drop_replication_slot('name')`, drop the slot from
 *    the tracker and return `{ sql: null, rewritten: true }`.
 * 5. If it is `SELECT ... FROM pg_replication_slots`, return a UNION ALL
 *    query of all tracked slots with `rewritten: true`.
 * 6. Otherwise, pass through unchanged.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link ReplSlotResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteReplSlot("SELECT pg_create_physical_replication_slot('slot1');");
 * // → { sql: null, rewritten: true }
 * // Tracker now has a physical slot named 'slot1'
 *
 * rewriteReplSlot("SELECT * FROM pg_replication_slots;");
 * // → { sql: "SELECT 'slot1' AS slot_name, 'physical' AS slot_type, ...", rewritten: true }
 *
 * rewriteReplSlot("SELECT 1;");
 * // → { sql: 'SELECT 1;', rewritten: false }
 * ```
 */
export function rewriteReplSlot(sql: string): ReplSlotResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Check for pg_create_physical_replication_slot ──

  const physMatch = trimmed.match(CREATE_PHYSICAL_SLOT);
  if (physMatch) {
    const slotName = physMatch[1];
    logger.debug(
      { sql: trimmed, slotName },
      'pg_create_physical_replication_slot detected — creating physical slot',
    );
    try {
      tracker.createPhysical(slotName);
    } catch (err: any) {
      // Slot already exists — PG would error too
      logger.warn({ slotName, err: err.message }, 'Failed to create physical replication slot');
    }
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ── Step 2: Check for pg_create_logical_replication_slot ───

  const logicalMatch = trimmed.match(CREATE_LOGICAL_SLOT);
  if (logicalMatch) {
    const slotName = logicalMatch[1];
    logger.debug(
      { sql: trimmed, slotName },
      'pg_create_logical_replication_slot detected — creating logical slot',
    );
    try {
      tracker.createLogical(slotName);
    } catch (err: any) {
      // Slot already exists
      logger.warn({ slotName, err: err.message }, 'Failed to create logical replication slot');
    }
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ── Step 3: Check for pg_drop_replication_slot ─────────────

  const dropMatch = trimmed.match(DROP_REPLICATION_SLOT);
  if (dropMatch) {
    const slotName = dropMatch[1];
    logger.debug(
      { sql: trimmed, slotName },
      'pg_drop_replication_slot detected — dropping slot',
    );
    tracker.drop(slotName);
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ── Step 4: Check for SELECT ... FROM pg_replication_slots ─

  if (QUERY_REPLICATION_SLOTS.test(trimmed)) {
    const slotSql = tracker.getSlotSQL();
    logger.debug(
      { sql: trimmed, slotCount: tracker.count() },
      'pg_replication_slots query detected — rewriting to slot query',
    );
    return {
      sql: slotSql,
      rewritten: true,
    };
  }

  // ── Step 5: Not a replication slot operation — pass through ─

  return {
    sql: trimmed,
    rewritten: false,
  };
}
