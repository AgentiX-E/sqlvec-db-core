/**
 * PartitionPruningShim — Detects and handles PostgreSQL partition pruning related
 * GUC statements for SQLite compatibility.
 *
 * PostgreSQL provides two GUC (Grand Unified Configuration) parameters that control
 * partition pruning behavior:
 *
 * - **`enable_partition_pruning`** (boolean): Enables or disables the query planner's
 *   ability to prune (skip scanning) partitions based on filter conditions.
 * - **`constraint_exclusion`** (enum: on / off / partition): Controls constraint
 *   exclusion, which is the older mechanism that partition pruning supersedes.
 *   The default is `partition` (exclude only for partitioned tables).
 *
 * SQLite has no concept of partition pruning or constraint exclusion.
 *
 * ## Strategy
 * 1. `SET enable_partition_pruning = on/off` → Rewrite as `SELECT 1` (no-op)
 * 2. `SET constraint_exclusion = on/off/partition` → Rewrite as `SELECT 1` (no-op)
 * 3. `SHOW enable_partition_pruning` → Rewrite as `SELECT 'off' as enable_partition_pruning`
 * 4. `SHOW constraint_exclusion` → Rewrite as `SELECT 'off' as constraint_exclusion`
 * 5. All other SQL → Passthrough (unchanged)
 *
 * ## Supported patterns
 *
 * ### SET enable_partition_pruning variants:
 * ```sql
 * SET enable_partition_pruning = on;
 * SET enable_partition_pruning = off;
 * SET enable_partition_pruning TO on;
 * SET enable_partition_pruning TO off;
 * SET SESSION enable_partition_pruning = on;
 * SET LOCAL enable_partition_pruning = off;
 * ```
 *
 * ### SET constraint_exclusion variants:
 * ```sql
 * SET constraint_exclusion = on;
 * SET constraint_exclusion = off;
 * SET constraint_exclusion = partition;
 * SET constraint_exclusion TO on;
 * SET constraint_exclusion TO off;
 * SET constraint_exclusion TO partition;
 * SET SESSION constraint_exclusion = on;
 * SET LOCAL constraint_exclusion = off;
 * ```
 *
 * ### SHOW variants:
 * ```sql
 * SHOW enable_partition_pruning;
 * SHOW constraint_exclusion;
 * ```
 *
 * ## Key guarantees
 * - No false positives on SQL containing 'enable_partition_pruning' or
 *   'constraint_exclusion' in identifiers, strings, or comments
 * - Detection is case-insensitive
 * - PinoLogger integration for debugging and audit trails
 *
 * @module PartitionPruningShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('PartitionPruningShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface PartitionPruningResult {
  /** Rewritten SQL (original SQL if not rewritten) */
  sql: string;
  /** Whether partition pruning was detected and processed */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants – Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches a SET statement for enable_partition_pruning.
 *
 * Captures: the value (on/off/true/false/0/1)
 *
 * Covers:
 *   SET enable_partition_pruning = on
 *   SET enable_partition_pruning = off
 *   SET enable_partition_pruning TO on
 *   SET enable_partition_pruning TO off
 *   SET SESSION enable_partition_pruning = on
 *   SET LOCAL enable_partition_pruning = off
 */
const SET_ENABLE_PARTITION_PRUNING_PATTERN =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+|TEMP(?:ORARY)?\s+)?enable_partition_pruning\s*(?:[=:]\s*|\s+TO\s+)(\S+?)\s*;?\s*$/i;

/**
 * Matches a SET statement for constraint_exclusion.
 *
 * Captures: the value (on/off/partition)
 *
 * Covers:
 *   SET constraint_exclusion = on
 *   SET constraint_exclusion = off
 *   SET constraint_exclusion = partition
 *   SET constraint_exclusion TO on
 *   SET constraint_exclusion TO off
 *   SET constraint_exclusion TO partition
 *   SET SESSION constraint_exclusion = on
 *   SET LOCAL constraint_exclusion = off
 */
const SET_CONSTRAINT_EXCLUSION_PATTERN =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+|TEMP(?:ORARY)?\s+)?constraint_exclusion\s*(?:[=:]\s*|\s+TO\s+)(\S+?)\s*;?\s*$/i;

/**
 * Matches a SHOW statement for enable_partition_pruning.
 *
 * Covers:
 *   SHOW enable_partition_pruning;
 */
const SHOW_ENABLE_PARTITION_PRUNING_PATTERN =
  /^\s*SHOW\s+enable_partition_pruning\s*;?\s*$/i;

/**
 * Matches a SHOW statement for constraint_exclusion.
 *
 * Covers:
 *   SHOW constraint_exclusion;
 */
const SHOW_CONSTRAINT_EXCLUSION_PATTERN =
  /^\s*SHOW\s+constraint_exclusion\s*;?\s*$/i;

/**
 * Broad detection pattern — matches any statement containing
 * "enable_partition_pruning" or "constraint_exclusion" as significant tokens.
 * Used by `detectPartitionPruning` for early fast-path detection.
 */
const PARTITION_PRUNING_TOKEN_PATTERN =
  /enable_partition_pruning|constraint_exclusion/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string references partition pruning configuration.
 *
 * Performs a case-insensitive check for the tokens `enable_partition_pruning`
 * or `constraint_exclusion` anywhere in the statement. Intentionally broad to
 * catch both SET and SHOW variants.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL references partition pruning configuration
 *
 * @example
 * ```ts
 * detectPartitionPruning("SET enable_partition_pruning = on;");   // true
 * detectPartitionPruning("SET constraint_exclusion = partition;"); // true
 * detectPartitionPruning("SHOW enable_partition_pruning;");       // true
 * detectPartitionPruning("SHOW constraint_exclusion;");           // true
 * detectPartitionPruning("SELECT * FROM users");                  // false
 * ```
 */
export function detectPartitionPruning(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast keyword check before regex matching
  if (!PARTITION_PRUNING_TOKEN_PATTERN.test(trimmed)) {
    return false;
  }

  // Confirm it's either a SET or SHOW targeting partition pruning params
  return (
    SET_ENABLE_PARTITION_PRUNING_PATTERN.test(trimmed) ||
    SET_CONSTRAINT_EXCLUSION_PATTERN.test(trimmed) ||
    SHOW_ENABLE_PARTITION_PRUNING_PATTERN.test(trimmed) ||
    SHOW_CONSTRAINT_EXCLUSION_PATTERN.test(trimmed)
  );
}

/**
 * Rewrite a PostgreSQL partition pruning related SQL statement for SQLite compatibility.
 *
 * **Processing rules:**
 * | Input                                           | Output                                              | rewritten |
 * |-------------------------------------------------|-----------------------------------------------------|-----------|
 * | `SET enable_partition_pruning = on`             | `SELECT 1`                                          | true      |
 * | `SET enable_partition_pruning = off`            | `SELECT 1`                                          | true      |
 * | `SET enable_partition_pruning TO on`            | `SELECT 1`                                          | true      |
 * | `SET SESSION enable_partition_pruning = on`     | `SELECT 1`                                          | true      |
 * | `SET LOCAL enable_partition_pruning = off`      | `SELECT 1`                                          | true      |
 * | `SET constraint_exclusion = on`                 | `SELECT 1`                                          | true      |
 * | `SET constraint_exclusion = off`                | `SELECT 1`                                          | true      |
 * | `SET constraint_exclusion = partition`          | `SELECT 1`                                          | true      |
 * | `SET constraint_exclusion TO on`                | `SELECT 1`                                          | true      |
 * | `SET SESSION constraint_exclusion = partition`  | `SELECT 1`                                          | true      |
 * | `SHOW enable_partition_pruning`                 | `SELECT 'off' as enable_partition_pruning`          | true      |
 * | `SHOW constraint_exclusion`                     | `SELECT 'off' as constraint_exclusion`              | true      |
 * | Non-partition-pruning SQL                       | `<original>`                                        | false     |
 * | Empty string                                    | `''`                                                | false     |
 *
 * @param sql   The raw SQL string to process
 * @returns     A PartitionPruningResult indicating the handling outcome
 *
 * @example
 * ```ts
 * const result = rewritePartitionPruning("SET enable_partition_pruning = off");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * const result = rewritePartitionPruning("SET constraint_exclusion = partition");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * const result = rewritePartitionPruning("SHOW enable_partition_pruning");
 * // → { sql: "SELECT 'off' as enable_partition_pruning", rewritten: true }
 *
 * const result = rewritePartitionPruning("SHOW constraint_exclusion");
 * // → { sql: "SELECT 'off' as constraint_exclusion", rewritten: true }
 *
 * const result = rewritePartitionPruning("SELECT * FROM users");
 * // → { sql: "SELECT * FROM users", rewritten: false }
 * ```
 */
export function rewritePartitionPruning(sql: string): PartitionPruningResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Fast-path: no partition pruning token at all ──

  if (!PARTITION_PRUNING_TOKEN_PATTERN.test(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Check SHOW patterns first ─────────────────────────────

  if (SHOW_ENABLE_PARTITION_PRUNING_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SHOW enable_partition_pruning detected — rewriting to SELECT',
    );
    return {
      sql: "SELECT 'off' as enable_partition_pruning",
      rewritten: true,
    };
  }

  if (SHOW_CONSTRAINT_EXCLUSION_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SHOW constraint_exclusion detected — rewriting to SELECT',
    );
    return {
      sql: "SELECT 'off' as constraint_exclusion",
      rewritten: true,
    };
  }

  // ── Check SET patterns ────────────────────────────────────

  if (SET_ENABLE_PARTITION_PRUNING_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SET enable_partition_pruning detected — rewriting to SELECT 1',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  if (SET_CONSTRAINT_EXCLUSION_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SET constraint_exclusion detected — rewriting to SELECT 1',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Token present but not a SET/SHOW we handle → passthrough ──

  logger.debug(
    { sql: trimmed },
    'Partition pruning token found but not a handled pattern — passing through',
  );

  return {
    sql: trimmed,
    rewritten: false,
  };
}
