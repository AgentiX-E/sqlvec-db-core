/**
 * CreateTableAsShim — Support PostgreSQL CREATE TABLE AS / SELECT INTO
 * with TEMP / UNLOGGED keywords for SQLite compatibility.
 *
 * ## Background
 *
 * PostgreSQL supports:
 * ```sql
 * CREATE [TEMP | UNLOGGED] TABLE table_name AS SELECT ...
 * SELECT * INTO [TEMP | UNLOGGED] table_name FROM ...
 * ```
 *
 * SQLite supports:
 * ```sql
 * CREATE [TEMP] TABLE table_name AS SELECT ...
 * ```
 *
 * SQLite does NOT support:
 * - CREATE UNLOGGED TABLE
 * - SELECT INTO
 *
 * ## Transformations
 *
 * | Input                                | Output                                  |
 * |--------------------------------------|-----------------------------------------|
 * | `CREATE TABLE t AS SELECT * FROM s`  | (pass-through)                          |
 * | `CREATE TEMP TABLE t AS SELECT *`    | (pass-through — SQLite supports TEMP)   |
 * | `CREATE TEMPORARY TABLE t AS SELECT` | (pass-through — SQLite supports TEMP)   |
 * | `CREATE UNLOGGED TABLE t AS SELECT`  | `CREATE TABLE t AS SELECT ...`          |
 * | `SELECT * INTO t FROM s`             | `CREATE TABLE t AS SELECT * FROM s`     |
 * | `SELECT * INTO TEMP t FROM s`        | `CREATE TEMP TABLE t AS SELECT * FROM s`|
 * | `SELECT * INTO UNLOGGED t FROM s`    | `CREATE TABLE t AS SELECT * FROM s`     |
 * | `SELECT * INTO TEMPORARY t FROM s`   | `CREATE TEMP TABLE t AS SELECT * FROM s`|
 *
 * @module CreateTableAsShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('CreateTableAsShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface CreateTableAsResult {
  /** Rewritten SQL string */
  sql: string;
  /** Whether rewriting was applied */
  rewritten: boolean;
  /** The type of rewrite applied */
  type: 'select-into' | 'create-table-as-unlogged' | 'none';
  /** Target table name (if detected) */
  tableName?: string;
  /** Whether TEMP was specified */
  isTemp: boolean;
}

// ──────────────────────────────────────────────
//  Regex patterns
// ──────────────────────────────────────────────

/**
 * Detect SELECT INTO [TEMP|UNLOGGED|TEMPORARY] <table> FROM ...
 * 
 * Matches:
 *   SELECT ... INTO t FROM ...
 *   SELECT ... INTO TEMP t FROM ...
 *   SELECT ... INTO UNLOGGED t FROM ...
 *   SELECT ... INTO TEMPORARY t FROM ...
 * 
 * Group 1: optional storage keyword (TEMP, UNLOGGED, TEMPORARY) or absent
 * Group 2: target table name
 */
const SELECT_INTO_RE = /^\s*(SELECT\s+.+?)\s+INTO\s+(?:(TEMP|TEMPORARY|UNLOGGED)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+(FROM\s+.+)/is;

/**
 * Detect CREATE [TEMP|UNLOGGED|TEMPORARY] TABLE name AS SELECT/DEFAULT
 * 
 * Matches:
 *   CREATE TABLE t AS SELECT ...
 *   CREATE TEMP TABLE t AS SELECT ...
 *   CREATE UNLOGGED TABLE t AS SELECT ...
 *   CREATE TEMPORARY TABLE t AS SELECT ...
 * 
 * Group 1: optional storage keyword (TEMP, UNLOGGED, TEMPORARY) or absent
 * Group 2: table name
 * Group 3: AS ... rest (SELECT, VALUES, etc.)
 */
const CREATE_TABLE_AS_RE = /^\s*CREATE\s+(?:(TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+(AS\s+.+)$/is;

/**
 * Check if a CREATE TABLE ... AS statement has TEMP/TEMPORARY but not UNLOGGED.
 */
const CREATE_TABLE_TEMP_RE = /^\s*CREATE\s+(?:TEMP|TEMPORARY)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-zA-Z_][a-zA-Z0-9_]*\s+AS\s+/i;

/**
 * Check if a CREATE TABLE ... AS statement has UNLOGGED.
 */
const CREATE_TABLE_UNLOGGED_RE = /^\s*CREATE\s+UNLOGGED\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-zA-Z_][a-zA-Z0-9_]*\s+AS\s+/i;

/**
 * Check for plain CREATE TABLE ... AS (no TEMP/UNLOGGED prefix)
 */
const CREATE_TABLE_PLAIN_AS_RE = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-zA-Z_][a-zA-Z0-9_]*\s+AS\s+/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the SQL creates a table via SELECT INTO.
 * 
 * @param sql Raw SQL string
 * @returns `true` if the SQL is a SELECT INTO statement
 * 
 * @example
 * ```ts
 * detectSelectInto('SELECT * INTO t FROM users');          // true
 * detectSelectInto('SELECT id, name INTO TEMP t FROM u'); // true
 * detectSelectInto('SELECT * FROM t');                     // false
 * ```
 */
export function detectSelectInto(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  if (!sql.trim().toUpperCase().startsWith('SELECT')) return false;
  // Must have INTO keyword between SELECT and FROM
  const trimmed = sql.trim();
  return SELECT_INTO_RE.test(trimmed);
}

/**
 * Detect whether the SQL is a CREATE TABLE ... AS SELECT with UNLOGGED.
 * 
 * @param sql Raw SQL string
 * @returns `true` if the SQL is a CREATE UNLOGGED TABLE ... AS SELECT
 * 
 * @example
 * ```ts
 * detectUnloggedCreateTableAs('CREATE UNLOGGED TABLE t AS SELECT * FROM s'); // true
 * detectUnloggedCreateTableAs('CREATE TABLE t AS SELECT * FROM s');          // false
 * ```
 */
export function detectUnloggedCreateTableAs(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  return CREATE_TABLE_UNLOGGED_RE.test(sql.trim());
}

/**
 * Rewrite a SELECT INTO or CREATE TABLE AS (with TEMP/UNLOGGED) to
 * SQLite-compatible SQL.
 * 
 * @param sql Raw SQL string
 * @returns Rewrite result with the translated SQL
 * 
 * @example
 * ```ts
 * // SELECT INTO
 * const r1 = rewriteCreateTableAs('SELECT * INTO t FROM users');
 * // → { sql: 'CREATE TABLE t AS SELECT * FROM users', type: 'select-into', isTemp: false, rewritten: true }
 * 
 * // SELECT INTO TEMP
 * const r2 = rewriteCreateTableAs('SELECT * INTO TEMP t FROM users');
 * // → { sql: 'CREATE TEMP TABLE t AS SELECT * FROM users', type: 'select-into', isTemp: true, rewritten: true }
 * 
 * // CREATE UNLOGGED TABLE AS
 * const r3 = rewriteCreateTableAs('CREATE UNLOGGED TABLE t AS SELECT * FROM s');
 * // → { sql: 'CREATE TABLE t AS SELECT * FROM s', type: 'create-table-as-unlogged', isTemp: false, rewritten: true }
 * 
 * // Regular CREATE TABLE AS (no change)
 * const r4 = rewriteCreateTableAs('CREATE TABLE t AS SELECT * FROM s');
 * // → pass-through, rewritten: false
 * ```
 */
export function rewriteCreateTableAs(sql: string): CreateTableAsResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false, type: 'none', isTemp: false };
  }

  const trimmed = sql.trim();

  // ── Case 1: SELECT INTO ────────────────────────────────────────
  const selectMatch = trimmed.match(SELECT_INTO_RE);
  if (selectMatch) {
    const selectPart = selectMatch[1].trim();
    const storageKeyword = selectMatch[2];  // May be undefined (no TEMP/UNLOGGED)
    const tableName = selectMatch[3];
    const fromPart = selectMatch[4].trim();

    const isUnlogged = storageKeyword?.toUpperCase() === 'UNLOGGED';
    const isTemp = !!(storageKeyword && !isUnlogged &&
      ['TEMP', 'TEMPORARY'].includes(storageKeyword.toUpperCase()));

    const tempPrefix = isTemp ? 'TEMP ' : '';
    const rewritten = `CREATE ${tempPrefix}TABLE ${tableName} AS ${selectPart} ${fromPart}`;

    logger.debug(
      { table: tableName, isTemp, isUnlogged, original: trimmed },
      'SELECT INTO rewritten to CREATE TABLE AS',
    );

    return { sql: rewritten, rewritten: true, type: 'select-into', tableName, isTemp };
  }

  // ── Case 2: CREATE UNLOGGED TABLE AS SELECT ────────────────────
  const createUnloggedMatch = trimmed.match(CREATE_TABLE_UNLOGGED_RE);
  if (createUnloggedMatch) {
    // Extract the table name and the rest, handling IF NOT EXISTS
    const tableNameMatch = trimmed.match(
      /^\s*CREATE\s+UNLOGGED\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+(AS\s+.+)$/is,
    );
    if (tableNameMatch) {
      const tableName = tableNameMatch[1];
      const rest = tableNameMatch[2];
      const ifNotExists = /IF\s+NOT\s+EXISTS/i.test(trimmed) ? 'IF NOT EXISTS ' : '';
      const rewritten = `CREATE TABLE ${ifNotExists}${tableName} ${rest}`;

      logger.debug(
        { table: tableName, original: trimmed },
        'CREATE UNLOGGED TABLE AS rewritten to plain CREATE TABLE AS',
      );

      return { sql: rewritten, rewritten: true, type: 'create-table-as-unlogged', tableName, isTemp: false };
    }
  }

  // ── Case 3: CREATE TEMP TABLE AS SELECT (already valid) ───────
  // SQLite supports CREATE TEMP TABLE, so this passes through
  const tempMatch = trimmed.match(CREATE_TABLE_TEMP_RE);
  if (tempMatch) {
    return { sql: trimmed, rewritten: false, type: 'none', isTemp: true };
  }

  // ── Case 4: CREATE TABLE AS SELECT (plain, already valid) ─────
  const plainMatch = trimmed.match(CREATE_TABLE_PLAIN_AS_RE);
  if (plainMatch) {
    return { sql: trimmed, rewritten: false, type: 'none', isTemp: false };
  }

  // ── Not a CREATE TABLE AS / SELECT INTO statement ──────────────
  return { sql: trimmed, rewritten: false, type: 'none', isTemp: false };
}

/**
 * Quick check: does this SQL statement involve CREATE TABLE AS or SELECT INTO
 * that requires rewriting?
 * 
 * @param sql Raw SQL string
 * @returns `true` if rewriting is needed
 */
export function needsRewrite(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  const trimmed = sql.trim();
  return (
    detectSelectInto(trimmed) ||
    detectUnloggedCreateTableAs(trimmed)
  );
}
