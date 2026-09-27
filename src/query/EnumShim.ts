/**
 * EnumShim — PostgreSQL ENUM type real implementation for SQLite.
 *
 * Real logic (G11):
 * - create(name, values) — register enum in `__enums` system table + in-memory registry
 * - validate(value, enumName) — check that a value is in the enum's allowed values
 *
 * SQLite stores enum values as TEXT. This shim provides runtime validation
 * to ensure only allowed values are inserted/updated.
 *
 * @module EnumShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('EnumShim');

// ── Types ────────────────────────────────────────────────────────

export interface EnumResult {
  sql: string | null;
  rewritten: boolean;
  values?: string[];
  typeName?: string;
}

export interface EnumDef {
  name: string;
  values: string[];
}

// ── Constants ────────────────────────────────────────────────────

const ALTER_ENUM_ADD_VALUE_RE = /^\s*ALTER\s+TYPE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+VALUE\s+/i;
const DROP_TYPE_RE = /^\s*DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i;
const ENUM_DDL_RE = /^\s*(CREATE\s+TYPE.+AS\s+ENUM|ALTER\s+TYPE.+ADD\s+VALUE|ALTER\s+TYPE.+RENAME\s+VALUE|DROP\s+TYPE)\s/i;

/** Virtual system table schema for enum definitions */
const ENUM_META_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS __enums (
    name TEXT PRIMARY KEY,
    values_json TEXT NOT NULL
  )
`;

// ── In-memory registry ───────────────────────────────────────────

const enumRegistry = new Map<string, string[]>();

// ── Public API ───────────────────────────────────────────────────

export function detectEnumStmt(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  return ENUM_DDL_RE.test(sql.trim());
}

export function handleEnumStmt(sql: string): EnumResult {
  if (!sql || typeof sql !== 'string') return { sql, rewritten: false };
  const trimmed = sql.trim();

  const createMatch = parseCreateEnum(trimmed);
  if (createMatch) {
    return {
      sql: null,
      rewritten: true,
      values: createMatch.values,
      typeName: createMatch.typeName,
    };
  }

  const renameValueResult = handleAlterTypeRenameValue(trimmed);
  if (renameValueResult !== null) {
    return { sql: renameValueResult, rewritten: true };
  }

  const alterMatch = trimmed.match(ALTER_ENUM_ADD_VALUE_RE);
  if (alterMatch) {
    return { sql: null, rewritten: true, typeName: alterMatch[1] };
  }

  const dropMatch = trimmed.match(DROP_TYPE_RE);
  if (dropMatch) {
    return { sql: null, rewritten: true, typeName: dropMatch[1] };
  }

  return { sql: trimmed, rewritten: false };
}

/**
 * Literal-aware parser for `CREATE TYPE <name> AS ENUM ( 'v1', 'v2', ... )`.
 *
 * Unlike a bare regex, this correctly handles:
 *   - quoted type names (`CREATE TYPE "my type" AS ENUM (...)`)
 *   - enum values containing `)`, `,`, or escaped quotes (`''`)
 *
 * Returns the parsed type name and values, or `null` if the statement is not
 * a well-formed `CREATE TYPE ... AS ENUM`.
 */
export function parseCreateEnum(sql: string): { typeName: string; values: string[] } | null {
  let i = skipWs(sql, 0);

  if (!matchKeyword(sql, i, 'CREATE')) return null;
  i = skipWs(sql, i + 6);
  if (!matchKeyword(sql, i, 'TYPE')) return null;
  i = skipWs(sql, i + 4);

  // Type name: quoted identifier or bare identifier.
  let typeName: string;
  if (sql[i] === '"') {
    const qid = readQuotedIdentifier(sql, i);
    if (!qid) return null;
    typeName = qid.value;
    i = skipWs(sql, qid.next);
  } else {
    const m = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!m) return null;
    typeName = m[0];
    i = skipWs(sql, i + m[0].length);
  }
  if (!typeName) return null;

  if (!matchKeyword(sql, i, 'AS')) return null;
  i = skipWs(sql, i + 2);
  if (!matchKeyword(sql, i, 'ENUM')) return null;
  i = skipWs(sql, i + 4);

  if (sql[i] !== '(') return null;
  i = skipWs(sql, i + 1);

  const values: string[] = [];
  // Parse the value list, allowing a trailing comma (PostgreSQL accepts it).
  while (i < sql.length) {
    i = skipWs(sql, i);
    if (sql[i] === ')') {
      i++;
      break;
    }
    if (sql[i] !== "'") return null; // enum values must be string literals
    const lit = readStringLiteral(sql, i);
    if (!lit) return null;
    values.push(lit.value);
    i = skipWs(sql, lit.next);
    if (sql[i] === ',') {
      i++;
      continue;
    }
    // Next must be the closing paren or end of statement.
    if (sql[i] === ')') {
      i++;
      break;
    }
    return null;
  }

  // Trailing `;` and/or whitespace only.
  i = skipWs(sql, i);
  if (sql[i] === ';') i = skipWs(sql, i + 1);
  if (i !== sql.length) return null;

  return { typeName, values };
}

/** Skip whitespace starting at `pos`. */
function skipWs(sql: string, pos: number): number {
  while (pos < sql.length && /\s/.test(sql[pos])) pos++;
  return pos;
}

/**
 * Read a single-quoted string literal starting at `pos` (which must be `'`).
 * Returns the decoded value and the index just past the closing quote, or
 * `null` if the literal is unterminated.
 */
function readStringLiteral(sql: string, pos: number): { value: string; next: number } | null {
  const end = skipSqlLiteral(sql, pos);
  // skipSqlLiteral returns sql.length for an unterminated literal. A properly
  // terminated literal ends with a closing `'` right before `end`.
  if (end === sql.length && sql[sql.length - 1] !== "'") {
    return null;
  }
  const value = sql.slice(pos + 1, end - 1).replace(/''/g, "'");
  return { value, next: end };
}

/**
 * Read a double-quoted identifier starting at `pos` (which must be `"`).
 * Returns the decoded identifier and the index just past the closing quote,
 * or `null` if the identifier is unterminated.
 */
function readQuotedIdentifier(sql: string, pos: number): { value: string; next: number } | null {
  const end = skipSqlLiteral(sql, pos);
  if (end === sql.length && sql[sql.length - 1] !== '"') {
    return null;
  }
  const value = sql.slice(pos + 1, end - 1).replace(/""/g, '"');
  return { value, next: end };
}

/** Case-insensitive keyword match at `pos`. */
function matchKeyword(sql: string, pos: number, keyword: string): boolean {
  const sub = sql.slice(pos, pos + keyword.length);
  return sub.toLowerCase() === keyword.toLowerCase();
}

/**
 * Literal-aware parser for `ALTER TYPE <name> RENAME VALUE 'old' TO 'new'`.
 *
 * Handles quoted type names and enum values containing escaped quotes (`''`),
 * which the previous bare regex could not parse.
 */
export function parseAlterRenameValue(sql: string): {
  typeName: string;
  oldValue: string;
  newValue: string;
} | null {
  let i = skipWs(sql, 0);

  if (!matchKeyword(sql, i, 'ALTER')) return null;
  i = skipWs(sql, i + 5);
  if (!matchKeyword(sql, i, 'TYPE')) return null;
  i = skipWs(sql, i + 4);

  // Type name: quoted identifier or bare identifier.
  let typeName: string;
  if (sql[i] === '"') {
    const qid = readQuotedIdentifier(sql, i);
    if (!qid) return null;
    typeName = qid.value;
    i = skipWs(sql, qid.next);
  } else {
    const m = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!m) return null;
    typeName = m[0];
    i = skipWs(sql, i + m[0].length);
  }
  if (!typeName) return null;

  if (!matchKeyword(sql, i, 'RENAME')) return null;
  i = skipWs(sql, i + 6);
  if (!matchKeyword(sql, i, 'VALUE')) return null;
  i = skipWs(sql, i + 5);

  // old value literal
  if (sql[i] !== "'") return null;
  const oldLit = readStringLiteral(sql, i);
  if (!oldLit) return null;
  const oldValue = oldLit.value;
  i = skipWs(sql, oldLit.next);

  if (!matchKeyword(sql, i, 'TO')) return null;
  i = skipWs(sql, i + 2);

  // new value literal
  if (sql[i] !== "'") return null;
  const newLit = readStringLiteral(sql, i);
  if (!newLit) return null;
  const newValue = newLit.value;
  i = skipWs(sql, newLit.next);

  // Trailing `;` and/or whitespace only.
  if (sql[i] === ';') i = skipWs(sql, i + 1);
  if (i !== sql.length) return null;

  return { typeName, oldValue, newValue };
}

export function detectEnumTypeRef(typeName: string): boolean {
  if (!typeName || typeof typeName !== 'string') return false;
  const normalized = typeName.trim().toLowerCase();
  if (normalized.length === 0) return false;

  const sqliteBaseTypes = new Set([
    'integer', 'int', 'int2', 'int4', 'int8', 'bigint', 'smallint', 'tinyint',
    'text', 'clob', 'blob', 'real', 'double', 'double precision', 'float',
    'numeric', 'decimal', 'number', 'boolean', 'bool', 'date', 'datetime', 'timestamp',
    'varchar', 'character varying', 'char', 'character',
    'json', 'jsonb', 'uuid', 'bytea', 'money', 'serial', 'bigserial', 'smallserial',
    'float4', 'float8', 'macaddr', 'macaddr8', 'inet', 'cidr',
    'timestamptz', 'timetz', 'interval', 'pg_lsn', 'txid_snapshot',
    'tsvector', 'tsquery', 'name', 'oid', 'regproc', 'regprocedure',
    'regoper', 'regoperator', 'regclass', 'regtype',
    'regconfig', 'regdictionary', 'regnamespace',
    'xid', 'cid', 'tid',
  ]);

  if (sqliteBaseTypes.has(normalized)) return false;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(normalized)) return false;
  if (normalized.length <= 2) return false;

  return true;
}

export function extractEnumValues(raw: string): string[] {
  if (!raw || typeof raw !== 'string') return [];
  const values: string[] = [];
  const valueRe = /'((?:[^']*(?:''[^']*)*))'/g;
  let match: RegExpExecArray | null;
  while ((match = valueRe.exec(raw)) !== null) {
    const val = match[1].replace(/''/g, "'");
    if (val.length > 0) values.push(val);
  }
  return values;
}

/**
 * Ensure the metadata table exists in the database.
 */
export async function ensureMetaTable(queryFn: (sql: string) => Promise<any>): Promise<void> {
  try {
    await queryFn(ENUM_META_TABLE_DDL);
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to create enums meta table');
    throw err;
  }
}

/**
 * Create (register) an enum type.
 *
 * @param name - Enum type name
 * @param values - Allowed values
 * @param queryFn - Optional function to persist to system table
 */
export async function create(
  name: string,
  values: string[],
  queryFn?: (sql: string) => Promise<any>,
): Promise<EnumDef> {
  enumRegistry.set(name.toLowerCase(), [...values]);

  if (queryFn) {
    await ensureMetaTable(queryFn);
    const valuesJson = JSON.stringify(values);
    await queryFn(`
      INSERT OR REPLACE INTO __enums (name, values_json)
      VALUES ('${escapeSql(name)}', '${escapeSql(valuesJson)}')
    `);
  }

  logger.info({ name, valueCount: values.length }, 'Enum type created');
  return { name, values };
}

/**
 * Validate a value against an enum type.
 *
 * @param value - The value to check
 * @param enumName - The enum type name
 * @returns true if the value is a member of the enum
 * @throws If the enum is not found
 */
export function validate(value: any, enumName: string): boolean {
  const values = enumRegistry.get(enumName.toLowerCase());
  if (!values) {
    throw new Error(`Enum type "${enumName}" not found`);
  }

  const strValue = String(value);
  const valid = values.includes(strValue);
  if (!valid) {
    logger.warn(
      { enum: enumName, value: strValue, allowed: values },
      'Enum value not allowed',
    );
  }
  return valid;
}

/**
 * Add a value to an existing enum.
 */
export async function addValue(
  name: string,
  value: string,
  queryFn?: (sql: string) => Promise<any>,
): Promise<void> {
  const key = name.toLowerCase();
  const values = enumRegistry.get(key);
  if (!values) {
    throw new Error(`Enum type "${name}" not found`);
  }

  if (!values.includes(value)) {
    values.push(value);
  }

  if (queryFn) {
    await ensureMetaTable(queryFn);
    const valuesJson = JSON.stringify(values);
    await queryFn(`
      UPDATE __enums SET values_json = '${escapeSql(valuesJson)}'
      WHERE name = '${escapeSql(name)}'
    `);
  }

  logger.info({ name, value }, 'Value added to enum');
}

/**
 * Drop an enum type.
 */
export async function drop(
  name: string,
  queryFn?: (sql: string) => Promise<any>,
): Promise<void> {
  const key = name.toLowerCase();
  const existed = enumRegistry.delete(key);

  if (queryFn) {
    await ensureMetaTable(queryFn);
    await queryFn(`DELETE FROM __enums WHERE name = '${escapeSql(name)}'`);
  }

  if (existed) {
    logger.info({ name }, 'Enum type dropped');
  }
}

/**
 * List all registered enum types.
 */
export function list(): EnumDef[] {
  return Array.from(enumRegistry.entries()).map(([name, values]) => ({
    name,
    values,
  }));
}

/**
 * Get an enum definition.
 */
export function get(name: string): EnumDef | undefined {
  const values = enumRegistry.get(name.toLowerCase());
  return values ? { name, values } : undefined;
}

/**
 * Load enums from the system table into the in-memory registry.
 */
export async function loadFromDB(queryFn: (sql: string) => Promise<any>): Promise<void> {
  try {
    await ensureMetaTable(queryFn);
    const result = await queryFn('SELECT name, values_json FROM __enums');

    let rows: any[] = [];
    if (Array.isArray(result)) {
      rows = result;
    } else if (result && result.rows) {
      rows = result.rows;
    }

    for (const row of rows) {
      const name = row.name || row[0];
      const valuesJson = row.values_json || row[1] || '[]';
      const values: string[] = JSON.parse(typeof valuesJson === 'string' ? valuesJson : '[]');
      enumRegistry.set(name.toLowerCase(), values);
    }

    logger.debug({ count: enumRegistry.size }, 'Enums loaded from DB');
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Failed to load enums from DB (table may not exist yet)');
  }
}

/**
 * Handle ALTER TYPE ... RENAME VALUE statement.
 *
 * Rewrites `ALTER TYPE enum_type RENAME VALUE 'old' TO 'new'` to an
 * UPDATE statement on the __pg_enum table.
 *
 * Since EnumShim stores enum values in both an in-memory registry and
 * optionally the `__enums` meta table, this function produces an SQL
 * UPDATE that modifies the stored values.
 *
 * Strategy:
 *   The UPDATE changes the value only if the enum type exists and the
 *   old value is present. This mirrors PG's behavior where the value
 *   must exist (otherwise PG throws an error).
 *
 * @param sql - The raw SQL string to process
 * @returns Rewritten SQL string, or null if not an ALTER TYPE RENAME VALUE
 *
 * @example
 * ```ts
 * handleAlterTypeRenameValue("ALTER TYPE mood RENAME VALUE 'sad' TO 'depressed'")
 * // → "UPDATE __enums SET values_json = json_set(values_json, ...)"
 *
 * handleAlterTypeRenameValue('SELECT 1')
 * // → null
 * ```
 */
export function handleAlterTypeRenameValue(sql: string): string | null {
  if (!sql || typeof sql !== 'string') {
    return null;
  }

  const parsed = parseAlterRenameValue(sql.trim());
  if (!parsed) {
    return null;
  }

  const { typeName, oldValue, newValue } = parsed;

  if (!typeName || !oldValue || !newValue) {
    logger.warn(
      { typeName, oldValue, newValue },
      'ALTER TYPE RENAME VALUE: missing components',
    );
    return null;
  }

  // Also update the in-memory registry
  const key = typeName.toLowerCase();
  const existing = enumRegistry.get(key);
  if (existing) {
    const idx = existing.indexOf(oldValue);
    if (idx !== -1) {
      existing[idx] = newValue;
      logger.info(
        { typeName, oldValue, newValue },
        'In-memory enum value renamed',
      );
    } else {
      logger.warn(
        { typeName, oldValue },
        'ALTER TYPE RENAME VALUE: old value not found in registry',
      );
    }
  }

  // Generate SQL to update the meta table
  // The __enums table stores values_json as a JSON array.
  // We need to update the array element matching oldValue to newValue.
  const escapedOld = escapeSql(oldValue);
  const escapedNew = escapeSql(newValue);
  const escapedType = escapeSql(typeName);

  const updateSql = `
UPDATE __enums
SET values_json = (
  SELECT json_group_array(
    CASE WHEN value = '${escapedOld}' THEN '${escapedNew}' ELSE value END
  )
  FROM json_each(values_json)
)
WHERE name = '${escapedType}'
  AND EXISTS (
    SELECT 1 FROM json_each(values_json) WHERE value = '${escapedOld}'
  );
`.trim();

  logger.debug(
    { typeName, oldValue, newValue },
    'ALTER TYPE RENAME VALUE rewritten',
  );

  return updateSql;
}

/**
 * Detect if a SQL statement is any ALTER TYPE statement.
 *
 * Matches:
 *   - ALTER TYPE ... ADD VALUE ...
 *   - ALTER TYPE ... RENAME VALUE ...
 *   - ALTER TYPE ... RENAME TO ...
 *   - ALTER TYPE ... SET SCHEMA ...
 *   - ALTER TYPE ... OWNER TO ...
 *
 * @param sql - The raw SQL string to inspect
 * @returns `true` if the statement is an ALTER TYPE
 *
 * @example
 * ```ts
 * detectAlterType("ALTER TYPE mood ADD VALUE 'great'")  // true
 * detectAlterType("ALTER TYPE mood RENAME VALUE 'sad' TO 'depressed'")  // true
 * detectAlterType("SELECT 1")  // false
 * ```
 */
export function detectAlterType(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  // eslint-disable-next-line require-unicode-regexp
  return /^\s*ALTER\s+TYPE\s+/i.test(sql.trim());
}

// ── Internal Helpers ─────────────────────────────────────────────

function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}
