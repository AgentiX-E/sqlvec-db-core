/**
 * UniqueConstraintShim — PostgreSQL UNIQUE constraint + real enforcement for SQLite.
 *
 * Syntax Shim:
 *   Strips PG-specific UNIQUE extensions (NULLS NOT DISTINCT, DEFERRABLE, etc.)
 *
 * Real Logic (G11):
 * - Store unique constraint definitions in `__unique_constraints` system table
 * - onInsert(table, columns, row) — check for duplicate values
 * - onUpdate(table, columns, row, oldRow) — check uniqueness of new values
 *
 * @module UniqueConstraintShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('UniqueConstraintShim');

// ── Types ────────────────────────────────────────────────────────

export interface UniqueConstraintResult {
  sql: string;
  rewritten: boolean;
  constraints?: string[];
}

export interface UniqueConstraintDef {
  name: string;
  table: string;
  columns: string[];
  /** Whether NULLS NOT DISTINCT was specified (PG 15+) */
  nullsNotDistinct: boolean;
}

/** Virtual system table schema */
const UNIQUE_META_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS __unique_constraints (
    name TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    nulls_not_distinct INTEGER NOT NULL DEFAULT 0
  )
`;

// ── Constants — Regex Patterns ──────────────────────────────────

const NULLS_NOT_DISTINCT_RE = /\bNULLS\s+NOT\s+DISTINCT\b/i;
const DEFERRABLE_RE = /\bDEFERRABLE\b/i;
const INITIALLY_RE = /\bINITIALLY\s+(?:DEFERRED|IMMEDIATE)\b/i;
const USING_INDEX_TABLESPACE_RE = /\bUSING\s+INDEX\s+TABLESPACE\s+[A-Za-z_][A-Za-z0-9_$]*\b/i;
const WITH_OPTIONS_RE = /\bWITH\s*\([^)]*\)/i;
const ANY_PG_EXTENSION_RE = /\b(?:NULLS\s+NOT\s+DISTINCT|DEFERRABLE|INITIALLY\s+(?:DEFERRED|IMMEDIATE)|USING\s+INDEX\s+TABLESPACE|WITH\s*\()/i;
const UNIQUE_EXTENSION_DETECT_RE = /\bUNIQUE\b[\s\S]*?\b(?:NULLS\s+NOT\s+DISTINCT|DEFERRABLE|INITIALLY\s+(?:DEFERRED|IMMEDIATE)|USING\s+INDEX\s+TABLESPACE|WITH\s*\()/i;

const PG_EXT_ALT = '(?:NULLS\\s+NOT\\s+DISTINCT|DEFERRABLE|INITIALLY\\s+(?:DEFERRED|IMMEDIATE)|USING\\s+INDEX\\s+TABLESPACE\\s+[A-Za-z_][A-Za-z0-9_$]*|WITH\\s*\\([^)]*\\))';

const TABLE_LEVEL_WITH_EXT_RE = new RegExp(
  `(\\bUNIQUE\\s*\\([^)]+\\))\\s*((?:${PG_EXT_ALT})(?:\\s+(?:${PG_EXT_ALT}))*)\\s*`,
  'gi',
);

const INLINE_WITH_EXT_RE = new RegExp(
  `\\bUNIQUE\\s+(?!\\()((?:${PG_EXT_ALT})(?:\\s+(?:${PG_EXT_ALT}))*)`,
  'gi',
);

// ── In-memory registry ───────────────────────────────────────────

const uniqueDefs = new Map<string, UniqueConstraintDef>();

// ── Public API (existing syntax shim) ────────────────────────────

export function detectUniqueExtension(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  if (!/\bUNIQUE\b/i.test(sql)) return false;
  return UNIQUE_EXTENSION_DETECT_RE.test(sql);
}

export function rewriteUniqueConstraint(sql: string): UniqueConstraintResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }
  const trimmed = sql.trim();
  if (!detectUniqueExtension(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  const constraints = extractUniqueConstraints(trimmed);
  let rewritten = trimmed.replace(TABLE_LEVEL_WITH_EXT_RE, (match, baseConstraint: string) => {
    logger.debug({ original: match, stripped: baseConstraint }, 'Rewriting table-level UNIQUE constraint');
    return baseConstraint;
  });
  rewritten = rewritten.replace(INLINE_WITH_EXT_RE, () => 'UNIQUE');

  if (rewritten === trimmed) {
    return { sql: trimmed, rewritten: false, constraints };
  }

  return { sql: rewritten, rewritten: true, constraints };
}

export function extractUniqueConstraints(sql: string): string[] | undefined {
  if (typeof sql !== 'string' || sql.trim().length === 0) return undefined;
  const results: string[] = [];

  const tableLevelRe = /(?:\bCONSTRAINT\s+\w+\s+)?\bUNIQUE\s*\([^)]+\)(?:\s+(?:NULLS\s+NOT\s+DISTINCT|DEFERRABLE|INITIALLY\s+(?:DEFERRED|IMMEDIATE)|USING\s+INDEX\s+TABLESPACE\s+\w+|WITH\s*\([^)]*\)))*/gi;
  let match: RegExpExecArray | null;
  while ((match = tableLevelRe.exec(sql)) !== null) {
    results.push(match[0].trim());
  }

  const inlineExtRe = /\bUNIQUE\s+(?!\()((?:NULLS\s+NOT\s+DISTINCT|DEFERRABLE|INITIALLY\s+(?:DEFERRED|IMMEDIATE)|USING\s+INDEX\s+TABLESPACE\s+\w+|WITH\s*\([^)]*\))(?:\s+(?:NULLS\s+NOT\s+DISTINCT|DEFERRABLE|INITIALLY\s+(?:DEFERRED|IMMEDIATE)|USING\s+INDEX\s+TABLESPACE\s+\w+|WITH\s*\([^)]*\)))*)/gi;
  while ((match = inlineExtRe.exec(sql)) !== null) {
    results.push(`UNIQUE ${match[1].trim()}`);
  }
  return results.length > 0 ? results : undefined;
}

// ── Real enforcement API (G11) ───────────────────────────────────

/**
 * Ensure the metadata table exists.
 */
export async function ensureMetaTable(queryFn: (sql: string) => Promise<any>): Promise<void> {
  try {
    await queryFn(UNIQUE_META_TABLE_DDL);
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to create unique_constraints meta table');
    throw err;
  }
}

/**
 * Register a unique constraint definition.
 */
export async function addConstraint(
  def: UniqueConstraintDef,
  queryFn?: (sql: string) => Promise<any>,
): Promise<void> {
  uniqueDefs.set(`${def.table.toLowerCase()}.${def.name.toLowerCase()}`, def);

  if (queryFn) {
    await ensureMetaTable(queryFn);
    const cols = JSON.stringify(def.columns);
    await queryFn(`
      INSERT OR REPLACE INTO __unique_constraints (name, table_name, columns_json, nulls_not_distinct)
      VALUES (
        '${escapeSql(def.name)}',
        '${escapeSql(def.table)}',
        '${escapeSql(cols)}',
        ${def.nullsNotDistinct ? 1 : 0}
      )
    `);
  }

  logger.debug({ table: def.table, columns: def.columns }, 'Unique constraint registered');
}

/**
 * Remove unique constraint(s) for a table.
 */
export async function removeConstraints(
  tableName: string,
  queryFn?: (sql: string) => Promise<any>,
): Promise<void> {
  const prefix = tableName.toLowerCase() + '.';
  for (const [key] of uniqueDefs) {
    if (key.startsWith(prefix)) {
      uniqueDefs.delete(key);
    }
  }

  if (queryFn) {
    await ensureMetaTable(queryFn);
    await queryFn(`DELETE FROM __unique_constraints WHERE table_name = '${escapeSql(tableName)}'`);
  }

  logger.debug({ table: tableName }, 'Unique constraints removed');
}

/**
 * Get all unique constraint definitions for a table.
 */
export function getConstraints(tableName: string): UniqueConstraintDef[] {
  const defs: UniqueConstraintDef[] = [];
  const prefix = tableName.toLowerCase() + '.';
  for (const [key, def] of uniqueDefs) {
    if (key.startsWith(prefix)) {
      defs.push(def);
    }
  }
  return defs;
}

/**
 * Check unique constraints on INSERT.
 *
 * @param table - The table being inserted into
 * @param columns - Column names involved in the unique constraint
 * @param row - The new row values
 * @param queryFn - Function to execute SQL queries
 * @throws If a uniqueness violation is detected
 */
export async function onInsert(
  table: string,
  columns: string[],
  row: Record<string, any>,
  queryFn: (sql: string) => Promise<any>,
): Promise<void> {
  const defs = getConstraints(table);
  for (const def of defs) {
    // Build WHERE clause for this unique constraint
    const conditions = def.columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) {
        if (def.nullsNotDistinct) {
          return `"${col}" IS NULL`;
        }
        // SQL standard: NULLs are distinct in UNIQUE constraints
        return '1=0';
      }
      return `"${col}" = ${escapeValue(val)}`;
    });

    const checkSql = `SELECT 1 FROM "${table}" WHERE ${conditions.join(' AND ')} LIMIT 1`;
    const result = await queryFn(checkSql);

    if (checkRows(result, 1)) {
      const vals = def.columns.map((c) => row[c]);
      const errMsg = `duplicate key value violates unique constraint "${def.name}": key (${def.columns.join(', ')}) = (${vals.join(', ')}) already exists`;
      logger.warn({ constraint: def.name, table, values: vals }, errMsg);
      throw new Error(errMsg);
    }
  }
}

/**
 * Check unique constraints on UPDATE.
 *
 * @param table - The table being updated
 * @param columns - Column names involved in the unique constraint
 * @param row - The new row values
 * @param oldRow - The old row values
 * @param queryFn - Function to execute SQL queries
 * @throws If a uniqueness violation is detected
 */
export async function onUpdate(
  table: string,
  columns: string[],
  row: Record<string, any>,
  oldRow: Record<string, any>,
  queryFn: (sql: string) => Promise<any>,
): Promise<void> {
  const defs = getConstraints(table);
  for (const def of defs) {
    // Check if any of the unique columns actually changed
    const changed = def.columns.some((col) => String(row[col]) !== String(oldRow[col]));
    if (!changed) {
      continue; // No change in unique columns, skip check
    }

    // Build WHERE clause excluding the current row
    const conditions: string[] = def.columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) {
        if (def.nullsNotDistinct) {
          return `"${col}" IS NULL`;
        }
        return '1=0';
      }
      return `"${col}" = ${escapeValue(val)}`;
    });

    // Exclude the current row (by old values)
    const excludeConditions = def.columns.map((col, i) => {
      const oldVal = oldRow[col];
      if (oldVal === null || oldVal === undefined) {
        return `"${col}" IS NULL`;
      }
      return `"${col}" = ${escapeValue(oldVal)}`;
    });

    const checkSql = `SELECT 1 FROM "${table}" WHERE ${conditions.join(' AND ')} AND NOT (${excludeConditions.join(' AND ')}) LIMIT 1`;
    const result = await queryFn(checkSql);

    if (checkRows(result, 1)) {
      const vals = def.columns.map((c) => row[c]);
      const errMsg = `duplicate key value violates unique constraint "${def.name}": key (${def.columns.join(', ')}) = (${vals.join(', ')}) already exists`;
      logger.warn({ constraint: def.name, table, values: vals }, errMsg);
      throw new Error(errMsg);
    }
  }
}

/**
 * Load unique constraint definitions from the system table.
 */
export async function loadFromDB(queryFn: (sql: string) => Promise<any>): Promise<void> {
  try {
    await ensureMetaTable(queryFn);
    const result = await queryFn('SELECT name, table_name, columns_json, nulls_not_distinct FROM __unique_constraints');

    let rows: any[] = [];
    if (Array.isArray(result)) {
      rows = result;
    } else if (result && result.rows) {
      rows = result.rows;
    }

    for (const row of rows) {
      const def: UniqueConstraintDef = {
        name: row.name || row[0],
        table: row.table_name || row[1],
        columns: JSON.parse(row.columns_json || row[2] || '[]'),
        nullsNotDistinct: (row.nulls_not_distinct || row[3]) === 1 || (row.nulls_not_distinct || row[3]) === true,
      };
      uniqueDefs.set(`${def.table.toLowerCase()}.${def.name.toLowerCase()}`, def);
    }

    logger.debug({ count: uniqueDefs.size }, 'Unique constraints loaded from DB');
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Failed to load unique defs from DB');
  }
}

// ── Internal Helpers ─────────────────────────────────────────────

function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}

function escapeValue(value: any): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${escapeSql(String(value))}'`;
}

function checkRows(result: any, minCount: number): boolean {
  if (Array.isArray(result)) return result.length >= minCount;
  if (result && result.rows) return result.rows.length >= minCount;
  return false;
}
