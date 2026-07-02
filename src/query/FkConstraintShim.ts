/**
 * FkConstraintShim — PostgreSQL FOREIGN KEY extension compatibility shim + real enforcement.
 *
 * SQLite supports basic FOREIGN KEY syntax but not PG extensions (MATCH, DEFERRABLE, etc.)
 *
 * Real logic (G11):
 * - Store foreign key definitions in `__foreign_keys` system table
 * - onInsert(table, row) — check referenced tables for FK violations
 * - onDelete(table, where) — check for referencing rows
 * - onUpdate(table, row, oldRow) — check referential integrity
 *
 * @module FkConstraintShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('FkConstraintShim');

// ── Types ────────────────────────────────────────────────────────

export interface FkConstraintResult {
  sql: string;
  rewritten: boolean;
}

export interface FkDef {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';
  onUpdate: 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';
}

/** Virtual system table schema */
const FK_META_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS __foreign_keys (
    name TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    ref_table TEXT NOT NULL,
    ref_columns_json TEXT NOT NULL,
    on_delete TEXT NOT NULL DEFAULT 'NO ACTION',
    on_update TEXT NOT NULL DEFAULT 'NO ACTION'
  )
`;

// ── In-memory registry ───────────────────────────────────────────

const fkRegistry = new Map<string, FkDef>();

// ── Constants ────────────────────────────────────────────────────

const MATCH_CLAUSE_RE = /\bMATCH\s+(FULL|PARTIAL|SIMPLE)\b/i;
const DEFERRABLE_RE = /\b(?:NOT\s+)?DEFERRABLE\b/i;
const INITIALLY_RE = /\bINITIALLY\s+(DEFERRED|IMMEDIATE)\b/i;
const PG_FK_EXT_RE = /\bMATCH\s+(FULL|PARTIAL|SIMPLE)\b|\b(?:NOT\s+)?DEFERRABLE\b|\bINITIALLY\s+(DEFERRED|IMMEDIATE)\b/i;

// ── Public API (existing) ────────────────────────────────────────

export function detectPgFkExt(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  return PG_FK_EXT_RE.test(sql.trim());
}

export function rewritePgFkExt(sql: string): FkConstraintResult {
  if (!sql || typeof sql !== 'string') return { sql, rewritten: false };
  const trimmed = sql.trim();
  if (!PG_FK_EXT_RE.test(trimmed)) return { sql: trimmed, rewritten: false };

  let rewritten = trimmed;
  rewritten = rewritten.replace(MATCH_CLAUSE_RE, '');
  rewritten = rewritten.replace(DEFERRABLE_RE, '');
  rewritten = rewritten.replace(INITIALLY_RE, '');
  rewritten = rewritten.replace(/\s{2,}/g, ' ').trim();

  logger.debug('Rewrote PG FK extension: original=%s rewritten=%s', trimmed, rewritten);
  return { sql: rewritten, rewritten: true };
}

// ── Real enforcement API (G11) ───────────────────────────────────

/**
 * Ensure the metadata table exists.
 */
export async function ensureMetaTable(queryFn: (sql: string) => Promise<any>): Promise<void> {
  try {
    await queryFn(FK_META_TABLE_DDL);
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to create foreign_keys meta table');
    throw err;
  }
}

/**
 * Register a foreign key constraint definition.
 */
export async function addFkDef(
  def: FkDef,
  queryFn?: (sql: string) => Promise<any>,
): Promise<void> {
  fkRegistry.set(`${def.table}.${def.name}`.toLowerCase(), def);

  if (queryFn) {
    await ensureMetaTable(queryFn);
    const cols = JSON.stringify(def.columns);
    const refCols = JSON.stringify(def.refColumns);
    await queryFn(`
      INSERT OR REPLACE INTO __foreign_keys (name, table_name, columns_json, ref_table, ref_columns_json, on_delete, on_update)
      VALUES (
        '${escapeSql(def.name)}',
        '${escapeSql(def.table)}',
        '${escapeSql(cols)}',
        '${escapeSql(def.refTable)}',
        '${escapeSql(refCols)}',
        '${escapeSql(def.onDelete)}',
        '${escapeSql(def.onUpdate)}'
      )
    `);
  }

  logger.debug({ table: def.table, refTable: def.refTable, columns: def.columns }, 'FK constraint registered');
}

/**
 * Remove foreign key definition(s) for a table.
 */
export async function removeFkDefs(
  tableName: string,
  queryFn?: (sql: string) => Promise<any>,
): Promise<void> {
  // Remove from registry
  for (const [key] of fkRegistry) {
    if (key.startsWith(tableName.toLowerCase() + '.')) {
      fkRegistry.delete(key);
    }
  }

  if (queryFn) {
    await ensureMetaTable(queryFn);
    await queryFn(`DELETE FROM __foreign_keys WHERE table_name = '${escapeSql(tableName)}'`);
  }

  logger.debug({ table: tableName }, 'FK definitions removed');
}

/**
 * Get all FK definitions for a table.
 */
export function getFkDefs(tableName: string): FkDef[] {
  const defs: FkDef[] = [];
  for (const [key, def] of fkRegistry) {
    if (key.startsWith(tableName.toLowerCase() + '.')) {
      defs.push(def);
    }
  }
  return defs;
}

/**
 * Get all FK definitions that reference a table.
 */
export function getReferencingFkDefs(refTableName: string): FkDef[] {
  return Array.from(fkRegistry.values()).filter(
    (def) => def.refTable.toLowerCase() === refTableName.toLowerCase(),
  );
}

/**
 * Check foreign key constraints on INSERT.
 * Verifies that referenced values exist in the referenced table.
 *
 * @param table - The table being inserted into
 * @param row - The row values (object of column -> value)
 * @param queryFn - Function to execute SQL queries
 * @throws If a FK violation is detected
 */
export async function onInsert(
  table: string,
  row: Record<string, any>,
  queryFn: (sql: string) => Promise<any>,
): Promise<void> {
  const defs = getFkDefs(table);
  for (const def of defs) {
    // Extract FK column values from the row
    const colValues = def.columns.map((c) => row[c]);
    // Check if any FK value is NULL (NULL FK values are allowed in SQL)
    if (colValues.every((v) => v === null || v === undefined)) {
      continue;
    }

    // Build a WHERE clause to check existence in the referenced table
    const conditions = def.columns.map((col, i) => {
      const refCol = def.refColumns[i] || col;
      if (colValues[i] === null || colValues[i] === undefined) {
        return `"${refCol}" IS NULL`;
      }
      return `"${refCol}" = ${escapeValue(colValues[i])}`;
    });

    const checkSql = `SELECT 1 FROM "${def.refTable}" WHERE ${conditions.join(' AND ')} LIMIT 1`;
    const result = await queryFn(checkSql);

    const exists = checkRows(result, 1);
    if (!exists) {
      const errMsg = `insert or update on table "${table}" violates foreign key constraint "${def.name}": key (${def.columns.join(', ')}) = (${colValues.join(', ')}) is not present in table "${def.refTable}"`;
      logger.warn({ constraint: def.name, table, refTable: def.refTable }, errMsg);
      throw new Error(errMsg);
    }
  }
}

/**
 * Check foreign key constraints on DELETE.
 * Verifies that no rows reference the deleted values.
 *
 * @param table - The table being deleted from
 * @param where - The WHERE clause values (column -> value)
 * @param queryFn - Function to execute SQL queries
 */
export async function onDelete(
  table: string,
  where: Record<string, any>,
  queryFn: (sql: string) => Promise<any>,
): Promise<void> {
  // Find all FK constraints that reference this table
  const refDefs = getReferencingFkDefs(table);

  for (const def of refDefs) {
    // Build conditions to find referencing rows
    const conditions = def.refColumns.map((refCol, i) => {
      const thisCol = def.columns[i];
      const whereVal = where[thisCol] ?? where[refCol];
      if (whereVal === null || whereVal === undefined) {
        return `"${refCol}" IS NULL`;
      }
      return `"${refCol}" = ${escapeValue(whereVal)}`;
    });

    const checkSql = `SELECT 1 FROM "${def.table}" WHERE ${conditions.join(' AND ')} LIMIT 1`;
    const result = await queryFn(checkSql);
    const exists = checkRows(result, 1);

    if (exists) {
      const action = def.onDelete.toUpperCase();
      switch (action) {
        case 'CASCADE':
          // Delete referencing rows
          await queryFn(`DELETE FROM "${def.table}" WHERE ${conditions.join(' AND ')}`);
          logger.debug({ table: def.table, constraint: def.name }, 'CASCADE delete applied');
          break;
        case 'SET NULL':
          await queryFn(
            `UPDATE "${def.table}" SET ${def.refColumns.map((c) => `"${c}" = NULL`).join(', ')} WHERE ${conditions.join(' AND ')}`,
          );
          break;
        case 'RESTRICT':
        case 'NO ACTION':
        default: {
          const errMsg = `update or delete on table "${table}" violates foreign key constraint "${def.name}" on table "${def.table}"`;
          logger.warn({ constraint: def.name, table, refTable: def.table }, errMsg);
          throw new Error(errMsg);
        }
      }
    }
  }
}

/**
 * Check foreign key constraints on UPDATE.
 *
 * @param table - The table being updated
 * @param row - The new row values
 * @param oldRow - The old row values
 * @param queryFn - Function to execute SQL queries
 */
export async function onUpdate(
  table: string,
  row: Record<string, any>,
  oldRow: Record<string, any>,
  queryFn: (sql: string) => Promise<any>,
): Promise<void> {
  // Check outgoing FK constraints (FK from this table)
  const defs = getFkDefs(table);
  for (const def of defs) {
    const colValues = def.columns.map((c) => row[c]);
    if (colValues.every((v) => v === null || v === undefined)) {
      continue;
    }

    const conditions = def.columns.map((col, i) => {
      const refCol = def.refColumns[i] || col;
      if (colValues[i] === null || colValues[i] === undefined) {
        return `"${refCol}" IS NULL`;
      }
      return `"${refCol}" = ${escapeValue(colValues[i])}`;
    });

    const checkSql = `SELECT 1 FROM "${def.refTable}" WHERE ${conditions.join(' AND ')} LIMIT 1`;
    const result = await queryFn(checkSql);
    const exists = checkRows(result, 1);
    if (!exists) {
      const errMsg = `update on table "${table}" violates foreign key constraint "${def.name}"`;
      logger.warn({ constraint: def.name, table }, errMsg);
      throw new Error(errMsg);
    }
  }

  // Check incoming FK constraints (FK referencing this table)
  const refDefs = getReferencingFkDefs(table);
  for (const def of refDefs) {
    const action = def.onUpdate.toUpperCase();

    // Build conditions based on the OLD row values
    const oldConditions = def.refColumns.map((refCol, i) => {
      const thisCol = def.columns[i];
      const oldVal = oldRow[thisCol] ?? oldRow[refCol];
      if (oldVal === null || oldVal === undefined) {
        return `"${refCol}" IS NULL`;
      }
      return `"${refCol}" = ${escapeValue(oldVal)}`;
    });

    // Check for referencing rows
    const checkSql = `SELECT 1 FROM "${def.table}" WHERE ${oldConditions.join(' AND ')} LIMIT 1`;
    const result = await queryFn(checkSql);
    const exists = checkRows(result, 1);

    if (exists) {
      switch (action) {
        case 'CASCADE': {
          // Update referencing rows to new values
          const setClause = def.refColumns.map((refCol, i) => {
            const thisCol = def.columns[i];
            const newVal = row[thisCol];
            return `"${refCol}" = ${escapeValue(newVal)}`;
          });
          await queryFn(`UPDATE "${def.table}" SET ${setClause.join(', ')} WHERE ${oldConditions.join(' AND ')}`);
          break;
        }
        case 'SET NULL': {
          await queryFn(
            `UPDATE "${def.table}" SET ${def.refColumns.map((c) => `"${c}" = NULL`).join(', ')} WHERE ${oldConditions.join(' AND ')}`,
          );
          break;
        }
        case 'RESTRICT':
        case 'NO ACTION':
        default: {
          const errMsg = `update on table "${table}" violates foreign key constraint "${def.name}" on table "${def.table}"`;
          logger.warn({ constraint: def.name, table, refTable: def.table }, errMsg);
          throw new Error(errMsg);
        }
      }
    }
  }
}

/**
 * Load FK definitions from the system table into the in-memory registry.
 */
export async function loadFromDB(queryFn: (sql: string) => Promise<any>): Promise<void> {
  try {
    await ensureMetaTable(queryFn);
    const result = await queryFn('SELECT name, table_name, columns_json, ref_table, ref_columns_json, on_delete, on_update FROM __foreign_keys');

    let rows: any[] = [];
    if (Array.isArray(result)) {
      rows = result;
    } else if (result && result.rows) {
      rows = result.rows;
    }

    for (const row of rows) {
      const def: FkDef = {
        name: row.name || row[0],
        table: row.table_name || row[1],
        columns: JSON.parse(row.columns_json || row[2] || '[]'),
        refTable: row.ref_table || row[3],
        refColumns: JSON.parse(row.ref_columns_json || row[4] || '[]'),
        onDelete: (row.on_delete || row[5] || 'NO ACTION').toUpperCase() as any,
        onUpdate: (row.on_update || row[6] || 'NO ACTION').toUpperCase() as any,
      };
      fkRegistry.set(`${def.table}.${def.name}`.toLowerCase(), def);
    }

    logger.debug({ count: fkRegistry.size }, 'FK definitions loaded from DB');
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Failed to load FK defs from DB');
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
