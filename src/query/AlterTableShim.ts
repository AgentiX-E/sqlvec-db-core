/**
 * AlterTableShim — Detects and handles PostgreSQL-specific ALTER TABLE statements
 * for SQLite compatibility.
 *
 * SQLite supports only a subset of ALTER TABLE syntax:
 * - `ALTER TABLE t RENAME TO new_name`
 * - `ALTER TABLE t ADD [COLUMN] col type`
 * - `ALTER TABLE t RENAME COLUMN old TO new`
 * - `ALTER TABLE t DROP COLUMN col`
 *
 * PostgreSQL extends ALTER TABLE with many variants that are not supported by
 * SQLite. This shim detects those variants and returns them as no-ops (null),
 * preventing runtime errors when PG-specific ALTER TABLE statements are
 * encountered in a SQLite-backed environment.
 *
 * ## Strategy
 *
 * All PG-specific ALTER TABLE actions are treated as no-ops (safely ignored):
 *
 * | PG-specific action                          | Handling |
 * |---------------------------------------------|----------|
 * | `ALTER COLUMN c TYPE new_type`              | no-op    |
 * | `ALTER COLUMN c SET DEFAULT x`              | pass-through (SQLite 3.28+) |
 * | `ALTER COLUMN c DROP DEFAULT`               | pass-through (SQLite 3.38+) |
 * | `ALTER COLUMN c SET NOT NULL`               | needsRecreate              |
 * | `ALTER COLUMN c DROP NOT NULL`              | needsRecreate              |
 * | `ALTER COLUMN c SET STATISTICS x`           | no-op    |
 * | `ALTER COLUMN c SET STORAGE mode`           | no-op    |
 * | `ALTER COLUMN c SET (attoptions)`           | no-op    |
 * | `ALTER COLUMN c RESET (attoptions)`         | no-op    |
 * | `RENAME CONSTRAINT old TO new`              | no-op    |
 * | `VALIDATE CONSTRAINT c`                     | no-op    |
 * | `DROP CONSTRAINT c`                         | no-op    |
 * | `SET SCHEMA new_schema`                     | no-op    |
 * | `SET WITHOUT CLUSTER`                       | no-op    |
 * | `SET TABLESPACE name`                       | no-op    |
 * | `SET (storage_parameter = value)`           | no-op    |
 * | `RESET (storage_parameter)`                 | no-op    |
 * | `SET ACCESS METHOD method`                  | no-op    |
 * | `SET LOGGED` / `SET UNLOGGED`              | no-op    |
 * | `ENABLE/DISABLE [ALWAYS] TRIGGER name`      | no-op    |
 * | `CLUSTER ON index`                          | no-op    |
 * | `OWNER TO new_owner`                        | no-op    |
 *
 * SQLite-compatible ALTER TABLE actions pass through unchanged.
 *
 * ## Key guarantees
 *
 * - All handled output is valid (null = skip execution)
 * - No false positives on non-ALTER TABLE SQL
 * - Detection is conservative: only top-level ALTER TABLE statements
 * - PinoLogger integration for debugging and audit trails
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('AlterTableShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface AlterTableResult {
  /** Rewritten SQL (null for no-op, original SQL if pass-through) */
  sql: string | null;
  /** Whether the statement was detected and processed */
  rewritten: boolean;
  /**
   * True when the change requires a full table recreate because SQLite's ALTER
   * TABLE does not support this operation natively. The caller should:
   * 1. Read the current table schema via PRAGMA table_info
   * 2. Apply the column modification
   * 3. Execute: CREATE TABLE new_t (...), INSERT INTO new_t SELECT * FROM t,
   *    DROP TABLE t, ALTER TABLE new_t RENAME TO t
   */
  needsRecreate?: boolean;
  /** The table name for a needsRecreate operation */
  recreateTableName?: string;
  /** The column name to modify during recreate */
  recreateColumnName?: string;
  /**
   * The type of column change during recreate:
   * - 'set-not-null': Add NOT NULL constraint
   * - 'drop-not-null': Remove NOT NULL constraint
   */
  recreateChangeType?: 'set-not-null' | 'drop-not-null';
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches the start of any ALTER TABLE statement.
 * Captures the entire statement up to the table name.
 *
 * Patterns covered:
 *   ALTER TABLE t ...
 *   ALTER TABLE IF EXISTS t ...
 *   ALTER TABLE schema.t ...
 *   ALTER TABLE IF EXISTS schema.t ...
 */
const ALTER_TABLE_PREFIX = /^\s*ALTER\s+TABLE\s+/i;

/**
 * Full pattern for ALTER TABLE with optional IF EXISTS and optional schema
 * qualification on the table name.
 *
 * Groups:
 *   1 – IF EXISTS (optional)
 *   2 – Schema name or first part of table name
 *   3 – Separator dot (optional)
 *   4 – Table name (simple identifier)
 *
 * We don't actually need the groups for matching, just for structural parsing.
 */
const ALTER_TABLE_HEADER =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:["'`]?\w+["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?)\s+/i;

/**
 * Matches SQLite-compatible ALTER TABLE actions.
 * These statements should pass through unchanged.
 *
 * SQLite supported actions:
 *   RENAME TO new_name
 *   ADD [COLUMN] col_definition
 *   RENAME [COLUMN] old_name TO new_name
 *   DROP [COLUMN] col_name
 */
const SQLITE_ALTER_ACTION =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:["'`]?\w+["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?)\s+(RENAME\s+TO|ADD(?:\s+COLUMN)?|RENAME\s+COLUMN|DROP\s+COLUMN)\b/i;

/**
 * PostgreSQL-specific ALTER TABLE action patterns.
 * These are all actions that SQLite does not support.
 *
 * We check each PG-specific pattern individually for clear logging,
 * then group them into a single combined pattern for efficient matching.
 */

// ── ALTER COLUMN variants ────────────────────

/** ALTER COLUMN ... [SET DATA] TYPE ... */
const PG_ALTER_COLUMN_TYPE =
  /ALTER\s+(?:COLUMN\s+)?["'`]?\w+["'`]?\s+(?:SET\s+DATA\s+)?TYPE\s+/i;

/** ALTER COLUMN ... SET DEFAULT ... */
const PG_ALTER_COLUMN_SET_DEFAULT =
  /ALTER\s+(?:COLUMN\s+)?["'`]?\w+["'`]?\s+SET\s+DEFAULT\s+/i;

/** ALTER COLUMN ... DROP DEFAULT */
const PG_ALTER_COLUMN_DROP_DEFAULT =
  /ALTER\s+(?:COLUMN\s+)?["'`]?\w+["'`]?\s+DROP\s+DEFAULT\b/i;

/** ALTER COLUMN ... [SET] NOT NULL */
const PG_ALTER_COLUMN_SET_NOT_NULL =
  /ALTER\s+(?:COLUMN\s+)?["'`]?\w+["'`]?\s+(?:SET\s+)?NOT\s+NULL\b/i;

/** ALTER COLUMN ... DROP NOT NULL */
const PG_ALTER_COLUMN_DROP_NOT_NULL =
  /ALTER\s+(?:COLUMN\s+)?["'`]?\w+["'`]?\s+DROP\s+NOT\s+NULL\b/i;

/** ALTER COLUMN ... SET STATISTICS ... */
const PG_ALTER_COLUMN_SET_STATISTICS =
  /ALTER\s+(?:COLUMN\s+)?["'`]?\w+["'`]?\s+SET\s+STATISTICS\s+/i;

/** ALTER COLUMN ... SET STORAGE ... */
const PG_ALTER_COLUMN_SET_STORAGE =
  /ALTER\s+(?:COLUMN\s+)?["'`]?\w+["'`]?\s+SET\s+STORAGE\s+/i;

/** ALTER COLUMN ... SET (options) */
const PG_ALTER_COLUMN_SET_OPTIONS =
  /ALTER\s+(?:COLUMN\s+)?["'`]?\w+["'`]?\s+SET\s*\(/i;

/** ALTER COLUMN ... RESET (options) */
const PG_ALTER_COLUMN_RESET_OPTIONS =
  /ALTER\s+(?:COLUMN\s+)?["'`]?\w+["'`]?\s+RESET\s*\(/i;

// ── Constraint variants ──────────────────────

/** RENAME CONSTRAINT old TO new */
const PG_RENAME_CONSTRAINT = /RENAME\s+CONSTRAINT\s+/i;

/** VALIDATE CONSTRAINT name */
const PG_VALIDATE_CONSTRAINT = /VALIDATE\s+CONSTRAINT\s+/i;

/** DROP CONSTRAINT name [IF EXISTS] [RESTRICT|CASCADE] */
const PG_DROP_CONSTRAINT = /DROP\s+CONSTRAINT\s+/i;

// ── Schema / tablespace variants ────────────

/** SET SCHEMA new_schema */
const PG_SET_SCHEMA = /SET\s+SCHEMA\s+/i;

/** SET TABLESPACE name */
const PG_SET_TABLESPACE = /SET\s+TABLESPACE\s+/i;

// ── Trigger variants ─────────────────────────

/** ENABLE [ALWAYS|REPLICA] TRIGGER [name|ALL|USER] */
const PG_ENABLE_TRIGGER = /ENABLE\s+(?:ALWAYS\s+|REPLICA\s+)?TRIGGER\s+/i;

/** DISABLE [ALWAYS|REPLICA] TRIGGER [name|ALL|USER] */
const PG_DISABLE_TRIGGER = /DISABLE\s+(?:ALWAYS\s+|REPLICA\s+)?TRIGGER\s+/i;

// ── Cluster variants ─────────────────────────

/** CLUSTER ON index_name */
const PG_CLUSTER_ON = /CLUSTER\s+ON\s+/i;

/** SET WITHOUT CLUSTER */
const PG_SET_WITHOUT_CLUSTER = /SET\s+WITHOUT\s+CLUSTER\b/i;

// ── Storage parameter variants ──────────────

/** SET (storage_parameter[=value][, ...]) */
const PG_SET_OPTIONS = /SET\s*\(/i;

/** RESET (storage_parameter[, ...]) */
const PG_RESET_OPTIONS = /RESET\s*\(/i;

// ── Other PG-specific variants ───────────────

/** OWNER TO new_owner */
const PG_OWNER_TO = /OWNER\s+TO\s+/i;

/** SET ACCESS METHOD name */
const PG_SET_ACCESS_METHOD = /SET\s+ACCESS\s+METHOD\s+/i;

/** SET LOGGED */
const PG_SET_LOGGED = /SET\s+LOGGED\b/i;

/** SET UNLOGGED */
const PG_SET_UNLOGGED = /SET\s+UNLOGGED\b/i;

/**
 * Combined pattern matching the action keyword (the word immediately after the
 * table name in an ALTER TABLE statement). SQLite-compatible actions are:
 * RENAME, ADD, DROP (when followed by COLUMN).
 *
 * PG-only actions that indicate non-SQLite compatibility use different keywords:
 * VALIDATE, CLUSTER, ENABLE, DISABLE, OWNER.
 *
 * NOTE: ALTER COLUMN is intentionally excluded here because some ALTER COLUMN
 * variants (SET DEFAULT, DROP DEFAULT) are natively supported by SQLite.
 * PG-specific ALTER COLUMN actions (TYPE, SET NOT NULL, DROP NOT NULL, etc.)
 * are caught by the more precise PG_ALTER_ACTION combined regex below.
 *
 * We use this as a fast-path check: if the action keyword is definitely PG-specific,
 * return no-op without further inspection.
 */
const PG_ALTER_ACTION_KEYWORD =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:["'`]?\w+["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?)\s+(VALIDATE\s+CONSTRAINT|CLUSTER\s+ON|ENABLE\s+|DISABLE\s+|OWNER\s+TO)\b/i;

/**
 * Combined pattern matching all PG-specific ALTER TABLE variants.
 * Applied to the portion of SQL after the table name.
 *
 * Matches the start of the action part to determine if it's PG-specific.
 * This is the combined regex for efficient no-op detection.
 *
 * Notably, we exclude SQLite-compatible actions:
 * - RENAME TO → SQLite
 * - ADD [COLUMN] → SQLite
 * - RENAME COLUMN → SQLite
 * - DROP COLUMN → SQLite
 */
const PG_ALTER_ACTION = new RegExp(
  [
    // ALTER COLUMN variants
    PG_ALTER_COLUMN_TYPE.source,
    // NOTE: SET DEFAULT and DROP DEFAULT are NOT included here because SQLite
    // 3.28+ supports ALTER TABLE ... ALTER COLUMN ... SET DEFAULT natively
    // and SQLite 3.38+ supports ALTER TABLE ... ALTER COLUMN ... DROP DEFAULT.
    // These are no longer treated as PG-specific and will pass through to SQLite.
    PG_ALTER_COLUMN_SET_NOT_NULL.source,
    PG_ALTER_COLUMN_DROP_NOT_NULL.source,
    PG_ALTER_COLUMN_SET_STATISTICS.source,
    PG_ALTER_COLUMN_SET_STORAGE.source,
    PG_ALTER_COLUMN_SET_OPTIONS.source,
    PG_ALTER_COLUMN_RESET_OPTIONS.source,
    // Constraint variants
    PG_RENAME_CONSTRAINT.source,
    PG_VALIDATE_CONSTRAINT.source,
    PG_DROP_CONSTRAINT.source,
    // Schema / tablespace
    PG_SET_SCHEMA.source,
    PG_SET_TABLESPACE.source,
    // Trigger variants
    PG_ENABLE_TRIGGER.source,
    PG_DISABLE_TRIGGER.source,
    // Cluster variants
    PG_CLUSTER_ON.source,
    PG_SET_WITHOUT_CLUSTER.source,
    // Storage parameter variants
    PG_SET_OPTIONS.source,
    PG_RESET_OPTIONS.source,
    // Other
    PG_OWNER_TO.source,
    PG_SET_ACCESS_METHOD.source,
    PG_SET_LOGGED.source,
    PG_SET_UNLOGGED.source,
  ].join('|'),
  'i',
);

// ──────────────────────────────────────────────
//  Helper — Parse ALTER TABLE for recreate info
// ──────────────────────────────────────────────

/**
 * Extract the table name from an ALTER TABLE statement.
 * Supports optional IF EXISTS and optional schema qualification.
 *
 * @example
 *   'ALTER TABLE t ALTER COLUMN c SET NOT NULL' → 't'
 *   'ALTER TABLE IF EXISTS myschema.t ALTER ...' → 'myschema.t'
 */
function extractTableName(sql: string): string | null {
  const match = sql.match(
    /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?/i,
  );
  return match ? match[1] : null;
}

/**
 * Extract the column name from an ALTER TABLE ... ALTER COLUMN statement.
 *
 * Scans for `ALTER [COLUMN] <name>` after the table name portion.
 *
 * @example
 *   'ALTER TABLE t ALTER COLUMN my_col SET NOT NULL' → 'my_col'
 */
function extractColumnName(sql: string): string | null {
  // Remove the ALTER TABLE ... prefix so we match only the ALTER COLUMN part
  const afterTable = sql.replace(
    /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:["'`]?\w+["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?)\s+/i,
    '',
  );
  const match = afterTable.match(
    /^ALTER\s+(?:COLUMN\s+)?["'`]?(\w+)["'`]?\s+/i,
  );
  return match ? match[1] : null;
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string is an ALTER TABLE statement.
 *
 * Performs a case-insensitive check for ALTER TABLE as the first keywords
 * in the statement.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is an ALTER TABLE statement
 *
 * @example
 * ```ts
 * detectAlterTable('ALTER TABLE t ALTER COLUMN c TYPE int');   // true
 * detectAlterTable('ALTER TABLE t RENAME TO u');                // true
 * detectAlterTable('SELECT * FROM t');                          // false
 * ```
 */
export function detectAlterTable(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('ALTER TABLE') && !upper.startsWith('ALTER\tTABLE')) {
    return false;
  }

  // Confirm with regex
  return ALTER_TABLE_PREFIX.test(trimmed);
}

/**
 * Handle an ALTER TABLE SQL statement, returning either the original SQL
 * for SQLite-compatible variants or null for PG-specific no-ops.
 *
 * **Processing rules:**
 *
 * | Input                                                      | Output               | rewritten |
 * |------------------------------------------------------------|----------------------|-----------|
 * | `ALTER TABLE t ALTER COLUMN c TYPE int`                    | `null` (no-op)       | true      |
 * | `ALTER TABLE t ALTER COLUMN c SET DEFAULT x`               | `<original>` (pass-through) | false     |
 * | `ALTER TABLE t ALTER COLUMN c DROP DEFAULT`                | `<original>` (pass-through) | false     |
 * | `ALTER TABLE t ALTER COLUMN c SET NOT NULL`                | `null` + needsRecreate | true      |
 * | `ALTER TABLE t ALTER COLUMN c DROP NOT NULL`               | `null` + needsRecreate | true      |
 * | `ALTER TABLE t RENAME CONSTRAINT old TO new`               | `null` (no-op)       | true      |
 * | `ALTER TABLE t VALIDATE CONSTRAINT c`                      | `null` (no-op)       | true      |
 * | `ALTER TABLE t DROP CONSTRAINT c`                          | `null` (no-op)       | true      |
 * | `ALTER TABLE t SET SCHEMA new_schema`                      | `null` (no-op)       | true      |
 * | `ALTER TABLE t SET TABLESPACE name`                        | `null` (no-op)       | true      |
 * | `ALTER TABLE t SET WITHOUT CLUSTER`                        | `null` (no-op)       | true      |
 * | `ALTER TABLE t ENABLE TRIGGER name`                        | `null` (no-op)       | true      |
 * | `ALTER TABLE t DISABLE TRIGGER name`                       | `null` (no-op)       | true      |
 * | `ALTER TABLE t CLUSTER ON idx`                             | `null` (no-op)       | true      |
 * | `ALTER TABLE t SET (param = value)`                        | `null` (no-op)       | true      |
 * | `ALTER TABLE t RESET (param)`                              | `null` (no-op)       | true      |
 * | `ALTER TABLE t OWNER TO new_owner`                         | `null` (no-op)       | true      |
 * | `ALTER TABLE t SET ACCESS METHOD method`                   | `null` (no-op)       | true      |
 * | `ALTER TABLE t SET LOGGED`                                 | `null` (no-op)       | true      |
 * | `ALTER TABLE t SET UNLOGGED`                               | `null` (no-op)       | true      |
 * | `ALTER TABLE t RENAME TO u`                                | `<original>`         | false     |
 * | `ALTER TABLE t ADD COLUMN c int`                           | `<original>`         | false     |
 * | `ALTER TABLE t RENAME COLUMN old TO new`                   | `<original>`         | false     |
 * | `ALTER TABLE t DROP COLUMN c`                              | `<original>`         | false     |
 * | `SELECT * FROM t`                                          | `<original>`         | false     |
 *
 * @param sql   The raw SQL string to process
 * @returns     An AlterTableResult indicating the handling outcome
 *
 * @example
 * ```ts
 * const r1 = handleAlterTable('ALTER TABLE t ALTER COLUMN c TYPE int');
 * // → { sql: null, rewritten: true }
 *
 * const r2 = handleAlterTable('ALTER TABLE t RENAME TO u');
 * // → { sql: 'ALTER TABLE t RENAME TO u', rewritten: false }
 *
 * const r3 = handleAlterTable('SELECT 1');
 * // → { sql: 'SELECT 1', rewritten: false }
 * ```
 */
export function handleAlterTable(sql: string): AlterTableResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Is this even an ALTER TABLE? ──────────────────

  if (!detectAlterTable(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 2: Check for SQLite-compatible actions ───────────

  // If the action matches a SQLite-compatible pattern, pass through unchanged.
  if (SQLITE_ALTER_ACTION.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SQLite-compatible ALTER TABLE detected — passing through',
    );
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 3: Check for ALTER TABLE with DROP followed by non-COLUMN keyword.
  //            This handles `DROP CONSTRAINT` (PG-only).
  //            `DROP COLUMN` is already covered by SQLITE_ALTER_ACTION above.

  const dropConstraintMatch = trimmed.match(PG_DROP_CONSTRAINT);
  if (dropConstraintMatch) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE DROP CONSTRAINT detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ── Step 4: Check for PG-specific ALTER COLUMN actions ────

  // ALTER COLUMN ... [SET DATA] TYPE ...
  if (PG_ALTER_COLUMN_TYPE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE ALTER COLUMN TYPE detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ALTER COLUMN ... SET DEFAULT ...
  // NOTE: SQLite 3.28+ supports ALTER TABLE ... ALTER COLUMN ... SET DEFAULT natively.
  // We intentionally pass this through to SQLite instead of treating it as a no-op.
  if (PG_ALTER_COLUMN_SET_DEFAULT.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE ALTER COLUMN SET DEFAULT detected — passing through to SQLite (3.28+)',
    );
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ALTER COLUMN ... DROP DEFAULT
  // NOTE: SQLite 3.38+ supports ALTER TABLE ... ALTER COLUMN ... DROP DEFAULT natively.
  // We intentionally pass this through instead of treating it as a no-op.
  if (PG_ALTER_COLUMN_DROP_DEFAULT.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE ALTER COLUMN DROP DEFAULT detected — passing through to SQLite (3.38+)',
    );
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ALTER COLUMN ... [SET] NOT NULL
  // NOTE: SQLite does NOT support adding NOT NULL via ALTER TABLE at any version.
  // Requires a full table recreate. We return needsRecreate info for the caller.
  if (PG_ALTER_COLUMN_SET_NOT_NULL.test(trimmed)) {
    const tableName = extractTableName(trimmed) ?? 'unknown';
    const columnName = extractColumnName(trimmed) ?? 'unknown';
    logger.debug(
      { sql: trimmed, tableName, columnName },
      'ALTER TABLE ALTER COLUMN SET NOT NULL detected — requires table recreate',
    );
    return {
      sql: null,
      rewritten: true,
      needsRecreate: true,
      recreateTableName: tableName,
      recreateColumnName: columnName,
      recreateChangeType: 'set-not-null',
    };
  }

  // ALTER COLUMN ... DROP NOT NULL
  // NOTE: SQLite does NOT support dropping NOT NULL via ALTER TABLE at any version.
  // Requires a full table recreate. We return needsRecreate info for the caller.
  if (PG_ALTER_COLUMN_DROP_NOT_NULL.test(trimmed)) {
    const tableName = extractTableName(trimmed) ?? 'unknown';
    const columnName = extractColumnName(trimmed) ?? 'unknown';
    logger.debug(
      { sql: trimmed, tableName, columnName },
      'ALTER TABLE ALTER COLUMN DROP NOT NULL detected — requires table recreate',
    );
    return {
      sql: null,
      rewritten: true,
      needsRecreate: true,
      recreateTableName: tableName,
      recreateColumnName: columnName,
      recreateChangeType: 'drop-not-null',
    };
  }

  // ALTER COLUMN ... SET STATISTICS ...
  if (PG_ALTER_COLUMN_SET_STATISTICS.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE ALTER COLUMN SET STATISTICS detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ALTER COLUMN ... SET STORAGE ...
  if (PG_ALTER_COLUMN_SET_STORAGE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE ALTER COLUMN SET STORAGE detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ALTER COLUMN ... SET (options)
  if (PG_ALTER_COLUMN_SET_OPTIONS.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE ALTER COLUMN SET options detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ALTER COLUMN ... RESET (options)
  if (PG_ALTER_COLUMN_RESET_OPTIONS.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE ALTER COLUMN RESET options detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ── Step 5: Check for constraint-related PG actions ─────────

  // RENAME CONSTRAINT old TO new
  if (PG_RENAME_CONSTRAINT.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE RENAME CONSTRAINT detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // VALIDATE CONSTRAINT name
  if (PG_VALIDATE_CONSTRAINT.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE VALIDATE CONSTRAINT detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ── Step 6: Check for schema / tablespace changes ──────────

  // SET SCHEMA new_schema
  if (PG_SET_SCHEMA.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE SET SCHEMA detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // SET TABLESPACE name
  if (PG_SET_TABLESPACE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE SET TABLESPACE detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ── Step 7: Check for trigger enable/disable ───────────────

  // ENABLE [ALWAYS|REPLICA] TRIGGER [name|ALL|USER]
  if (PG_ENABLE_TRIGGER.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE ENABLE TRIGGER detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // DISABLE [ALWAYS|REPLICA] TRIGGER [name|ALL|USER]
  if (PG_DISABLE_TRIGGER.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE DISABLE TRIGGER detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ── Step 8: Check for cluster operations ───────────────────

  // CLUSTER ON index_name
  if (PG_CLUSTER_ON.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE CLUSTER ON detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // SET WITHOUT CLUSTER
  if (PG_SET_WITHOUT_CLUSTER.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE SET WITHOUT CLUSTER detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ── Step 9: Check for storage parameter actions ────────────

  // SET (storage_parameter[=value][, ...])
  // NOTE: This regex will also match ALTER TABLE ... SET SCHEMA or SET TABLESPACE,
  // but those are already caught earlier in the chain. By the time we reach here,
  // any remaining SET that is followed by '(' is a storage parameter set.
  if (PG_SET_OPTIONS.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE SET (options) detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // RESET (storage_parameter[, ...])
  if (PG_RESET_OPTIONS.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE RESET (options) detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ── Step 10: Check for other PG-specific variants ──────────

  // OWNER TO new_owner
  if (PG_OWNER_TO.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE OWNER TO detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // SET ACCESS METHOD name
  if (PG_SET_ACCESS_METHOD.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE SET ACCESS METHOD detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // SET LOGGED
  if (PG_SET_LOGGED.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE SET LOGGED detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // SET UNLOGGED
  if (PG_SET_UNLOGGED.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE SET UNLOGGED detected — treating as no-op',
    );
    return {
      sql: null,
      rewritten: true,
    };
  }

  // ── Step 11: Fallback — unknown ALTER TABLE action ─────────

  // If we reach here, this is an ALTER TABLE statement that doesn't match
  // any known SQLite-compatible or PG-specific pattern. Log a warning and
  // return the original SQL (pass through with caution).
  logger.warn(
    { sql: trimmed },
    'Unknown ALTER TABLE action — passing through (may fail on SQLite)',
  );
  return {
    sql: trimmed,
    rewritten: false,
  };
}

/**
 * Determine if an ALTER TABLE action is a PostgreSQL-specific variant
 * that SQLite cannot handle.
 *
 * This is an internal helper that checks whether the statement body
 * (everything after ALTER TABLE [IF EXISTS] [schema.]table) contains
 * a PG-specific action keyword.
 *
 * @param sql   The raw ALTER TABLE SQL string
 * @returns     `true` if the action is PG-specific (not SQLite-compatible)
 *
 * @internal Exported for unit testing only.
 */
export function _isPgSpecificAlterAction(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  // First: is it an ALTER TABLE at all?
  if (!ALTER_TABLE_PREFIX.test(sql.trim())) {
    return false;
  }

  const trimmed = sql.trim();

  // Check for SQLite-compatible actions first (fast return)
  if (SQLITE_ALTER_ACTION.test(trimmed)) {
    return false;
  }

  // Check for known PG-specific patterns using the combined regex
  if (PG_ALTER_ACTION.test(trimmed)) {
    return true;
  }

  // Check the action keyword as a fallback — if the first keyword after the
  // table name is PG-specific, it's a PG-specific action.
  if (PG_ALTER_ACTION_KEYWORD.test(trimmed)) {
    return true;
  }

  // Not definitively identified — return false (assume pass-through)
  return false;
}
