/**
 * PgDumpCompatibilityShim — Detects and rewrites PostgreSQL pg_dump-specific
 * SQL syntax for SQLite compatibility.
 *
 * PostgreSQL's pg_dump utility exports SQL using several PG-specific syntax
 * extensions that are not supported by standard SQL or SQLite. This shim
 * detects those patterns and rewrites them with safe equivalents or no-ops.
 *
 * ## Strategy
 *
 * Conservative pattern matching: each PG-specific construct is identified by
 * a dedicated regex, then either stripped entirely or replaced with a safe
 * no-op (typically `SELECT 1`). The goal is to enable importing the
 * DDL-heavy portions of a pg_dump output without modifying the pg_dump
 * source.
 *
 * ## Supported patterns
 *
 * | Pattern                                    | Rewrite                                   |
 * |--------------------------------------------|-------------------------------------------|
 * | `ALTER TABLE ONLY t ...`                   | `ALTER TABLE t ...` (strips ONLY keyword) |
 * | `ALTER TABLE IF EXISTS t ...`              | Retained as-is (SQLite-compatible)        |
 * | `SET TABLESPACE name`                      | Stripped (no-op)                          |
 * | `SELECT pg_catalog.set_config(...)`        | `SELECT 1` (no-op)                        |
 * | `RESET ALL`                                | `SELECT 1` (no-op)                        |
 * | `COMMENT ON ... IS ...`                    | `SELECT 1` (no-op)                        |
 * | `ALTER FUNCTION ... DEPENDS ON EXTENSION`  | Stripped (no-op)                          |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQL (SELECT 1 = safe no-op)
 * - No false positives on identifiers containing 'ONLY' or 'TABLESPACE'
 * - Detection is conservative: only top-level statements
 * - PinoLogger integration for debugging and audit trails
 */

import { PinoLogger } from '../logger/PinoLogger';
import { GucSystem } from '../core/GucSystem';

const logger = PinoLogger.forComponent('PgDumpCompatibilityShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface PgDumpResult {
  /** Rewritten SQL (SELECT 1 for no-op, original SQL if pass-through) */
  sql: string;
  /** Whether rewriting was performed */
  rewritten: boolean;
  /** Detected pg_dump syntax categories (present when rewritten=true) */
  foundTypes?: string[];
}

// ──────────────────────────────────────────────
//  COMMENT ON — In-memory comment storage
// ──────────────────────────────────────────────

/**
 * Represents a stored COMMENT ON entry.
 */
export interface CommentEntry {
  objectType: string;
  objectName: string;
  comment: string;
  timestamp: number;
}

/**
 * In-memory comment store. Maps `objectType:objectName` → CommentEntry.
 * This simulates the `_sqlvec_comments` system table.
 */
const commentStore = new Map<string, CommentEntry>();

/**
 * Store a comment for a database object.
 */
export function storeComment(objectType: string, objectName: string, comment: string): void {
  const key = `${objectType.toLowerCase()}:${objectName.toLowerCase()}`;
  if (comment.length === 0 || comment === "''" || comment === '') {
    commentStore.delete(key);
    logger.debug({ objectType, objectName }, 'COMMENT ON — comment removed (empty)');
    return;
  }
  commentStore.set(key, { objectType, objectName, comment, timestamp: Date.now() });
  logger.debug({ objectType, objectName, comment }, 'COMMENT ON — comment stored');
}

/**
 * Retrieve a comment for a database object.
 * Returns the comment text, or null if no comment exists.
 */
export function getComment(objectType: string, objectName: string): string | null {
  const key = `${objectType.toLowerCase()}:${objectName.toLowerCase()}`;
  const entry = commentStore.get(key);
  return entry?.comment ?? null;
}

/**
 * Get all stored comments.
 */
export function getAllComments(): CommentEntry[] {
  return Array.from(commentStore.values());
}

/**
 * Clear all stored comments (useful for testing).
 */
export function clearAllComments(): void {
  commentStore.clear();
}

// ──────────────────────────────────────────────
//  Helper: Parse set_config arguments
// ──────────────────────────────────────────────

/**
 * Parse `SELECT pg_catalog.set_config('name', 'value', is_local)` args.
 * Returns [name, value, isLocal] or null on failure.
 */
export function parseSetConfigArgs(sql: string): [string, string, boolean] | null {
  const match = sql.trim().match(
    /^\s*SELECT\s+(?:pg_catalog\.)?set_config\s*\(\s*'([^']*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*(\w+)\s*\)\s*;?\s*$/i,
  );
  if (!match) return null;
  const name = match[1];
  const value = match[2].replace(/''/g, "'"); // unescape double single quotes
  const isLocal = match[3].toLowerCase() === 'true' || match[3] === '1';
  return [name, value, isLocal];
}

/**
 * Parse `COMMENT ON <object_type> <object_name> IS '<comment>'` args.
 * Returns [objectType, objectName, comment] or null on failure.
 */
export function parseCommentOnArgs(sql: string): [string, string, string] | null {
  const match = sql.trim().match(
    /^\s*COMMENT\s+ON\s+(\w+(?:\s+\w+)?)\s+(.+?)\s+IS\s+'(.*)'\s*;?\s*$/i,
  );
  if (!match) return null;
  const objectType = match[1];
  const objectName = match[2].trim();
  // Unescape SQL single quotes ('' → ')
  const comment = match[3].replace(/''/g, "'");
  return [objectType, objectName, comment];
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches top-level ALTER TABLE ONLY statements.
 *
 * pg_dump uses `ALTER TABLE ONLY t ...` instead of `ALTER TABLE t ...`
 * to indicate the operation should affect only the named table, not
 * any inherited children. SQLite does not support table inheritance,
 * so the `ONLY` keyword is safe to strip.
 *
 * Capture groups:
 *   1 – IF EXISTS (optional)
 *   2 – Table name (with optional schema qualification)
 *   3 – Rest of ALTER statement
 *
 * Examples:
 *   ALTER TABLE ONLY t ADD CONSTRAINT ...
 *   ALTER TABLE ONLY schema.t ALTER COLUMN ...
 *   ALTER TABLE IF EXISTS ONLY t ...  (rare, but covered)
 *
 * We deliberately capture the table name and everything after so we can
 * reconstruct: ALTER TABLE <name> <rest>
 */
const ALTER_TABLE_ONLY_PATTERN =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?ONLY\s+((?:["'`]?\w+["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?))\s+(.+)$/i;

/**
 * Detects ALTER TABLE IF EXISTS (not exclusive to pg_dump but commonly
 * emitted by it). This pattern is retained as-is since some SQLite
 * engines support IF EXISTS, but we flag it for compatibility tracking.
 */
const ALTER_TABLE_IF_EXISTS_PATTERN =
  /^\s*ALTER\s+TABLE\s+IF\s+EXISTS\s+/i;

/**
 * Matches SET TABLESPACE statements.
 *
 * TABLESPACE is a PG concept for physical storage location. It has no
 * equivalent in SQLite, so we strip these statements entirely.
 *
 * Patterns:
 *   ALTER TABLE t SET TABLESPACE ts_name;
 *   ALTER INDEX i SET TABLESPACE ts_name;
 *   SET TABLESPACE ts_name;  (standalone is rare but covered)
 *
 * We match SET TABLESPACE in the context of ALTER TABLE/INDEX as well
 * as standalone (for thoroughness).
 */
const SET_TABLESPACE_PATTERN =
  /^\s*ALTER\s+(?:TABLE|INDEX|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?(?:["'`]?\w+["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?)\s+SET\s+TABLESPACE\s+/i;

/**
 * Matches a standalone SET TABLESPACE statement (less common in pg_dump
 * but possible with some PG configurations).
 *
 *   SET TABLESPACE ts_name;
 *   SET DEFAULT TABLESPACE ts_name;
 */
const SET_TABLESPACE_STANDALONE_PATTERN =
  /^\s*SET\s+(?:DEFAULT\s+)?TABLESPACE\s+/i;

/**
 * Matches SELECT pg_catalog.set_config(...) calls.
 *
 * pg_dump often starts with:
 *   SELECT pg_catalog.set_config('search_path', '', false);
 *
 * This is PG-specific configuration. We replace it with SELECT 1.
 *
 * Pattern covers:
 *   SELECT pg_catalog.set_config(...)
 *   SELECT set_config(...)  (without schema prefix, less common)
 */
const SET_CONFIG_PATTERN =
  /^\s*SELECT\s+(?:pg_catalog\.)?set_config\s*\(/i;

/**
 * Matches RESET ALL statements.
 *
 * pg_dump emits RESET ALL to reset session parameters after DDL.
 * We replace it with SELECT 1 as a safe no-op.
 *
 * Pattern covers:
 *   RESET ALL;
 */
const RESET_ALL_PATTERN = /^\s*RESET\s+ALL\s*;?\s*$/im;

/**
 * Matches COMMENT ON statements.
 *
 * pg_dump emits COMMENT ON for all objects (tables, columns, functions,
 * etc.). Comments are informational only and should be preserved in
 * context-aware environments, but for compatibility purposes we treat
 * them as no-ops.
 *
 * Patterns:
 *   COMMENT ON TABLE t IS 'description';
 *   COMMENT ON COLUMN t.c IS 'description';
 *   COMMENT ON FUNCTION f(...) IS 'description';
 *   COMMENT ON INDEX i IS 'description';
 *   COMMENT ON SEQUENCE s IS 'description';
 *   COMMENT ON VIEW v IS 'description';
 *   COMMENT ON DATABASE d IS 'description';
 *   COMMENT ON SCHEMA s IS 'description';
 *   COMMENT ON TYPE t IS 'description';
 *   COMMENT ON DOMAIN d IS 'description';
 *   COMMENT ON CONSTRAINT c ON t IS 'description';
 *   COMMENT ON POLICY p ON t IS 'description';
 *   COMMENT ON RULE r ON t IS 'description';
 *   COMMENT ON TRIGGER t ON tbl IS 'description';
 *
 * We also support COMMENT ON without a trailing IS (rare but defensive):
 *   COMMENT ON EXTENSION e IS '';
 */
const COMMENT_ON_PATTERN = /^\s*COMMENT\s+ON\s+/i;

/**
 * Matches ALTER FUNCTION ... DEPENDS ON EXTENSION statements.
 *
 * pg_dump emits these to track function-to-extension dependencies.
 * They have no meaning in SQLite and should be stripped.
 *
 * Patterns:
 *   ALTER FUNCTION f() DEPENDS ON EXTENSION e;
 *   ALTER FUNCTION schema.f() DEPENDS ON EXTENSION e;
 */
const ALTER_FUNCTION_DEPENDS_ON_EXTENSION_PATTERN =
  /^\s*ALTER\s+FUNCTION\s+(?:\w+(?:\s*\.\s*\w+)?\s*\([^)]*\))\s+DEPENDS\s+ON\s+EXTENSION\s+/i;

/**
 * Matches ALTER FUNCTION for more flexible detection (used by detect function).
 */
const ALTER_FUNCTION_DEPENDS_LOOSE_PATTERN =
  /ALTER\s+FUNCTION\s+.*?DEPENDS\s+ON\s+EXTENSION/i;

/**
 * Combined detection patterns keyed by syntax type name.
 * Used for listing found types in the rewrite result.
 *
 * Order matters: more specific patterns should appear before broader ones
 * to yield the most descriptive type name.
 */
const DETECTION_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'ALTER TABLE ONLY', regex: ALTER_TABLE_ONLY_PATTERN },
  { name: 'ALTER TABLE IF EXISTS', regex: ALTER_TABLE_IF_EXISTS_PATTERN },
  { name: 'SET TABLESPACE', regex: SET_TABLESPACE_PATTERN },
  { name: 'SET TABLESPACE (standalone)', regex: SET_TABLESPACE_STANDALONE_PATTERN },
  { name: 'SELECT set_config', regex: SET_CONFIG_PATTERN },
  { name: 'RESET ALL', regex: RESET_ALL_PATTERN },
  { name: 'COMMENT ON', regex: COMMENT_ON_PATTERN },
  { name: 'ALTER FUNCTION DEPENDS ON EXTENSION', regex: ALTER_FUNCTION_DEPENDS_LOOSE_PATTERN },
];

// ──────────────────────────────────────────────
//  Table extraction — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches CREATE TABLE statements to extract the table name.
 *
 * Patterns:
 *   CREATE TABLE t (...)
 *   CREATE TABLE IF NOT EXISTS t (...)
 *   CREATE TEMPORARY TABLE t (...)
 *   CREATE UNLOGGED TABLE t (...)
 *   CREATE TABLE schema.t (...)
 *
 * Capture group 1 = table name (with optional schema prefix)
 */
const CREATE_TABLE_PATTERN =
  /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(["'`]?\w+["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?)\s*\(/i;

/**
 * Matches ALTER TABLE statements to extract the table name.
 *
 * Patterns:
 *   ALTER TABLE t ...
 *   ALTER TABLE ONLY t ...
 *   ALTER TABLE IF EXISTS t ...
 *   ALTER TABLE schema.t ...
 *
 * Capture group 1 = table name (with optional schema and ONLY prefix)
 *
 * NOTE: This matches more broadly than ALTER_TABLE_ONLY_PATTERN above;
 * it covers all ALTER TABLE variants including SQLite-compatible ones.
 */
const ALTER_TABLE_NAME_PATTERN =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(["'`]?\w+["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?)\s/i;

/**
 * Matches INSERT INTO statements to extract the table name.
 *
 * Patterns:
 *   INSERT INTO t ...
 *   INSERT INTO schema.t ...
 *
 * Capture group 1 = table name (with optional schema prefix)
 */
const INSERT_INTO_PATTERN =
  /^\s*INSERT\s+INTO\s+(["'`]?\w+["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?)\s/i;

/**
 * Matches COMMENT ON TABLE / COLUMN etc. to extract table name.
 *
 * Patterns:
 *   COMMENT ON TABLE t IS ...
 *   COMMENT ON COLUMN t.c IS ...
 *
 * Capture group 1 = table name (for TABLE variant)
 * Capture group 2 = table name (for COLUMN variant before the dot)
 */
const COMMENT_ON_TABLE_PATTERN =
  /^\s*COMMENT\s+ON\s+(?:TABLE\s+(["'`]?\w+["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?)|COLUMN\s+(["'`]?\w+["'`]?(?:\s*\.\s*["'`]?\w+["'`]?)?)\.)/i;

/**
 * Combined table extraction patterns used by extractPgDumpTables.
 */
const TABLE_NAME_EXTRACTORS: Array<(sql: string) => string | null> = [
  // CREATE TABLE
  (sql) => {
    const m = sql.match(CREATE_TABLE_PATTERN);
    return m?.[1] ?? null;
  },
  // ALTER TABLE
  (sql) => {
    const m = sql.match(ALTER_TABLE_NAME_PATTERN);
    return m?.[1] ?? null;
  },
  // INSERT INTO
  (sql) => {
    const m = sql.match(INSERT_INTO_PATTERN);
    return m?.[1] ?? null;
  },
  // COMMENT ON TABLE / COLUMN
  (sql) => {
    const m = sql.match(COMMENT_ON_TABLE_PATTERN);
    if (m) {
      return m[1] ?? m[2] ?? null;
    }
    return null;
  },
];

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains pg_dump-specific syntax.
 *
 * Checks for known pg_dump patterns including:
 * - ALTER TABLE ONLY
 * - ALTER TABLE IF EXISTS
 * - SET TABLESPACE
 * - SELECT pg_catalog.set_config(...)
 * - RESET ALL
 * - COMMENT ON ...
 * - ALTER FUNCTION ... DEPENDS ON EXTENSION
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if pg_dump-specific syntax is detected
 *
 * @example
 * ```ts
 * detectPgDumpSyntax('ALTER TABLE ONLY t ADD CONSTRAINT ...');    // true
 * detectPgDumpSyntax('SELECT pg_catalog.set_config(...)');        // true
 * detectPgDumpSyntax('CREATE TABLE t (id int)');                  // false
 * ```
 */
export function detectPgDumpSyntax(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  for (const { regex } of DETECTION_PATTERNS) {
    if (regex.test(trimmed)) {
      logger.debug({ sql: trimmed }, `pg_dump syntax detected via pattern`);
      return true;
    }
  }

  return false;
}

/**
 * Rewrite pg_dump-specific SQL syntax for SQLite compatibility.
 *
 * Each known pg_dump pattern is handled according to the following rules:
 *
 * | Pattern                                    | Rewrite                                   |
 * |--------------------------------------------|-------------------------------------------|
 * | `ALTER TABLE ONLY t ...`                   | `ALTER TABLE t ...` (strips ONLY keyword) |
 * | `ALTER TABLE IF EXISTS t ...`              | Retained as-is (compatible)               |
 * | `ALTER TABLE t SET TABLESPACE ts`          | `SELECT 1` (no-op)                        |
 * | `ALTER INDEX i SET TABLESPACE ts`          | `SELECT 1` (no-op)                        |
 * | `SELECT pg_catalog.set_config(...)`        | `SELECT 1` (no-op)                        |
 * | `RESET ALL`                                | `SELECT 1` (no-op)                        |
 * | `COMMENT ON ... IS ...`                    | `SELECT 1` (no-op)                        |
 * | `ALTER FUNCTION ... DEPENDS ON EXTENSION`  | `SELECT 1` (no-op)                        |
 * | Non-pg_dump SQL                            | `<original>` (pass-through)               |
 *
 * Multiple foundTypes can be reported when a single SQL statement matches
 * more than one pattern (though this is rare in practice).
 *
 * @param sql   The raw SQL string to rewrite
 * @returns     A PgDumpResult indicating the handling outcome
 *
 * @example
 * ```ts
 * const r1 = rewritePgDumpSql('ALTER TABLE ONLY t ADD CONSTRAINT pk PRIMARY KEY (id)');
 * // → { sql: 'ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY (id)', rewritten: true, foundTypes: ['ALTER TABLE ONLY'] }
 *
 * const r2 = rewritePgDumpSql('SELECT pg_catalog.set_config(\'search_path\', \'\', false)');
 * // → { sql: 'SELECT 1', rewritten: true, foundTypes: ['SELECT set_config'] }
 *
 * const r3 = rewritePgDumpSql('CREATE TABLE t (id int)');
 * // → { sql: 'CREATE TABLE t (id int)', rewritten: false }
 * ```
 */
export function rewritePgDumpSql(sql: string): PgDumpResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();
  const foundTypes: string[] = [];

  // ── 1. ALTER TABLE ONLY t ... → ALTER TABLE t ... ──────────

  const alterTableOnlyMatch = trimmed.match(ALTER_TABLE_ONLY_PATTERN);
  if (alterTableOnlyMatch) {
    const tableName = alterTableOnlyMatch[1];
    const rest = alterTableOnlyMatch[2];
    const rewritten = `ALTER TABLE ${tableName} ${rest}`;
    foundTypes.push('ALTER TABLE ONLY');
    logger.debug(
      { original: trimmed, rewritten, tableName },
      'ALTER TABLE ONLY detected — stripped ONLY keyword',
    );
    return {
      sql: rewritten,
      rewritten: true,
      foundTypes,
    };
  }

  // ── 2. ALTER TABLE IF EXISTS — retained but tracked ─────────

  // This is compatible with some SQLite engines, so we pass it through.
  // We still flag it for compatibility tracking.
  if (ALTER_TABLE_IF_EXISTS_PATTERN.test(trimmed)) {
    foundTypes.push('ALTER TABLE IF EXISTS');
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE IF EXISTS detected — passing through (SQLite-compatible)',
    );
    return {
      sql: trimmed,
      rewritten: false,
      foundTypes,
    };
  }

  // ── 3. SET TABLESPACE — strip entirely (no-op) ─────────────

  if (SET_TABLESPACE_PATTERN.test(trimmed)) {
    foundTypes.push('SET TABLESPACE');
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE/INDEX SET TABLESPACE detected — no-op (SELECT 1)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
      foundTypes,
    };
  }

  if (SET_TABLESPACE_STANDALONE_PATTERN.test(trimmed)) {
    foundTypes.push('SET TABLESPACE (standalone)');
    logger.debug(
      { sql: trimmed },
      'SET TABLESPACE (standalone) detected — no-op (SELECT 1)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
      foundTypes,
    };
  }

  // ── 4. SELECT pg_catalog.set_config(...) → set real GUC ──

  if (SET_CONFIG_PATTERN.test(trimmed)) {
    foundTypes.push('SELECT set_config');
    const parsed = parseSetConfigArgs(trimmed);
    if (parsed) {
      const [name, value, isLocal] = parsed;
      try {
        const gucSystem = GucSystem.getDefaultInstance();
        const err = gucSystem.registry.set(name, value);
        if (err) {
          logger.warn({ sql: trimmed, name, value, error: err }, 'SELECT set_config — GUC set returned error');
        } else {
          logger.debug({ sql: trimmed, name, value, isLocal }, 'SELECT set_config — GUC value updated');
        }
      } catch (err: any) {
        logger.error({ err: err.message, sql: trimmed, name, value }, 'SELECT set_config — GUC set failed');
      }
    } else {
      logger.warn({ sql: trimmed }, 'SELECT set_config — could not parse arguments');
    }
    return {
      sql: 'SELECT 1',
      rewritten: true,
      foundTypes,
    };
  }

  // ── 5. RESET ALL → reset all GUCs ─────────────────────────

  if (RESET_ALL_PATTERN.test(trimmed)) {
    foundTypes.push('RESET ALL');
    try {
      GucSystem.getDefaultInstance().registry.resetAllToDefaults();
      logger.debug({ sql: trimmed }, 'RESET ALL — all GUCs reset to defaults');
    } catch (err: any) {
      logger.error({ err: err.message, sql: trimmed }, 'RESET ALL — failed');
    }
    return {
      sql: 'SELECT 1',
      rewritten: true,
      foundTypes,
    };
  }

  // ── 6. COMMENT ON ... → store in comment store ────────────

  if (COMMENT_ON_PATTERN.test(trimmed)) {
    foundTypes.push('COMMENT ON');
    const parsed = parseCommentOnArgs(trimmed);
    if (parsed) {
      const [objectType, objectName, comment] = parsed;
      storeComment(objectType, objectName, comment);
      logger.debug({ objectType, objectName, comment }, 'COMMENT ON — stored');
    } else {
      logger.warn({ sql: trimmed }, 'COMMENT ON — could not parse, storing raw');
      // Fallback: store the raw SQL as a comment on a generic key
      storeComment('unknown', `raw:${trimmed.substring(0, 100)}`, trimmed);
    }
    return {
      sql: 'SELECT 1',
      rewritten: true,
      foundTypes,
    };
  }

  // ── 7. ALTER FUNCTION ... DEPENDS ON EXTENSION → SELECT 1 ──

  if (ALTER_FUNCTION_DEPENDS_ON_EXTENSION_PATTERN.test(trimmed) ||
      ALTER_FUNCTION_DEPENDS_LOOSE_PATTERN.test(trimmed)) {
    foundTypes.push('ALTER FUNCTION DEPENDS ON EXTENSION');
    logger.debug(
      { sql: trimmed },
      'ALTER FUNCTION DEPENDS ON EXTENSION detected — no-op (SELECT 1)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
      foundTypes,
    };
  }

  // ── Not pg_dump-specific SQL — pass through ─────────────────

  return {
    sql: trimmed,
    rewritten: false,
  };
}

/**
 * Extract table names from a pg_dump SQL string.
 *
 * Parses the SQL for common DDL/DML patterns that reference table names:
 * - CREATE TABLE t (...)
 * - ALTER TABLE t ...
 * - INSERT INTO t ...
 * - COMMENT ON TABLE t ...
 * - COMMENT ON COLUMN t.col ...
 *
 * The function deduplicates results (each table appears only once)
 * and normalizes quoting by stripping surrounding quotes from identifiers.
 *
 * @param sql   The raw SQL string to parse
 * @returns     An array of unique, unquoted table names found in the SQL
 *
 * @example
 * ```ts
 * extractPgDumpTables('CREATE TABLE users (id int); INSERT INTO users VALUES (1);');
 * // → ['users']
 *
 * extractPgDumpTables('ALTER TABLE ONLY t ADD CONSTRAINT pk PRIMARY KEY (id)');
 * // → ['t']
 *
 * extractPgDumpTables('SELECT 1');
 * // → []
 * ```
 */
export function extractPgDumpTables(sql: string): string[] {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return [];
  }

  const tables = new Set<string>();
  const trimmed = sql.trim();

  // Split multi-statement SQL into individual statements
  // We handle this by checking each statement-like segment.
  // For simplicity, we use a heuristic: split on ';' boundaries.
  const statements: string[] = [];

  // If the SQL contains multiple statements (separated by ;)
  if (trimmed.includes(';')) {
    // Simple split — this works for pg_dump output which has
    // one statement per line.
    const parts = trimmed.split(';');
    for (const part of parts) {
      const stmt = part.trim();
      if (stmt.length > 0) {
        statements.push(stmt);
      }
    }
  } else {
    statements.push(trimmed);
  }

  for (const stmt of statements) {
    for (const extractor of TABLE_NAME_EXTRACTORS) {
      const tableName = extractor(stmt);
      if (tableName !== null) {
        // Normalize: strip surrounding double-quotes, backticks, or single-quotes
        const normalized = tableName.replace(/^["'`]|["'`]$/g, '');
        tables.add(normalized);
        break; // Only first matching extractor per statement
      }
    }
  }

  return Array.from(tables);
}

// ──────────────────────────────────────────────
//  Internal helpers (exported for testing)
// ──────────────────────────────────────────────

/**
 * Check whether a statement is an ALTER TABLE ONLY variant.
 *
 * @internal Exported for unit testing only.
 *
 * @param sql   The raw SQL string
 * @returns     `true` if the statement is an ALTER TABLE ONLY
 */
export function _isAlterTableOnly(sql: string): boolean {
  return ALTER_TABLE_ONLY_PATTERN.test(sql.trim());
}

/**
 * Check whether a statement is a COMMENT ON variant.
 *
 * @internal Exported for unit testing only.
 *
 * @param sql   The raw SQL string
 * @returns     `true` if the statement is a COMMENT ON
 */
export function _isCommentOn(sql: string): boolean {
  return COMMENT_ON_PATTERN.test(sql.trim());
}

/**
 * Check whether a statement is an ALTER FUNCTION ... DEPENDS ON EXTENSION.
 *
 * @internal Exported for unit testing only.
 *
 * @param sql   The raw SQL string
 * @returns     `true` if the statement is an ALTER FUNCTION ... DEPENDS ON EXTENSION
 */
export function _isAlterFunctionDependsOnExtension(sql: string): boolean {
  return ALTER_FUNCTION_DEPENDS_LOOSE_PATTERN.test(sql.trim());
}
