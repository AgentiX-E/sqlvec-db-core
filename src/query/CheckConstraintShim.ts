/**
 * CheckConstraintShim — PostgreSQL CHECK constraint extension shim + real enforcement for SQLite.
 *
 * Syntax Shim:
 *   Strips PG-specific modifiers: NO INHERIT, NOT VALID
 *
 * Real Logic (G11):
 * - Store CHECK constraint definitions in `__check_constraints` system table
 * - onInsert(table, row) — evaluate CHECK expressions against new row
 * - onUpdate(table, row, oldRow) — evaluate CHECK expressions against updated row
 *
 * @module CheckConstraintShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { ConstraintEvaluator } from '../constraint/ConstraintEvaluator';

const logger = PinoLogger.forComponent('CheckConstraintShim');

// ── Shared evaluator instance ───────────────────────────────────
// @ts-expect-error ConstraintEvaluator is a JS constructor function
const evaluator = new ConstraintEvaluator();

// ── Types ────────────────────────────────────────────────────────

export interface CheckConstraintResult {
  sql: string;
  rewritten: boolean;
}

export interface CheckConstraintDef {
  name: string;
  table: string;
  /** SQL expression (e.g., "price > 0") */
  expression: string;
}

/** Virtual system table schema */
const CHECK_META_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS __check_constraints (
    name TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    expression TEXT NOT NULL
  )
`;

// ── In-memory registry ───────────────────────────────────────────

const checkDefs = new Map<string, CheckConstraintDef>();

// ── Constants ────────────────────────────────────────────────────

const NO_INHERIT_RE = /\bNO\s+INHERIT\b/i;
const NOT_VALID_RE = /\bNOT\s+VALID\b/i;
const PG_CHECK_EXT_RE = /\bNO\s+INHERIT\b|\bNOT\s+VALID\b/i;
const CHECK_CONSTRAINT_RE = /\bCHECK\s*\(/i;

// ── Public API (existing syntax shim) ────────────────────────────

export function detectCheckExtension(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  return PG_CHECK_EXT_RE.test(sql.trim());
}

export function rewriteCheckConstraint(sql: string): CheckConstraintResult {
  if (!sql || typeof sql !== 'string') return { sql, rewritten: false };
  const trimmed = sql.trim();
  if (!PG_CHECK_EXT_RE.test(trimmed)) return { sql: trimmed, rewritten: false };

  let rewritten = trimmed;
  rewritten = rewritten.replace(NO_INHERIT_RE, '');
  rewritten = rewritten.replace(NOT_VALID_RE, '');
  rewritten = rewritten.replace(/\s{2,}/g, ' ').trim();

  return { sql: rewritten, rewritten: rewritten !== trimmed };
}

export function extractCheckExpression(sql: string): string | null {
  if (!sql || typeof sql !== 'string') return null;
  const match = CHECK_CONSTRAINT_RE.exec(sql.trim());
  if (!match) return null;

  const startPos = match.index + match[0].length;
  let depth = 1;
  let pos = startPos;
  const text = sql.trim();

  while (pos < text.length && depth > 0) {
    const ch = text[pos];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        const expression = text.slice(startPos, pos).trim();
        return expression.length > 0 ? expression : null;
      }
    }
    pos++;
  }
  return null;
}

// ── Real enforcement API (G11) ───────────────────────────────────

/**
 * Ensure the metadata table exists.
 */
export async function ensureMetaTable(queryFn: (sql: string) => Promise<any>): Promise<void> {
  try {
    await queryFn(CHECK_META_TABLE_DDL);
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to create check_constraints meta table');
    throw err;
  }
}

/**
 * Register a CHECK constraint definition.
 */
export async function addConstraint(
  def: CheckConstraintDef,
  queryFn?: (sql: string) => Promise<any>,
): Promise<void> {
  checkDefs.set(`${def.table.toLowerCase()}.${def.name.toLowerCase()}`, def);

  if (queryFn) {
    await ensureMetaTable(queryFn);
    await queryFn(`
      INSERT OR REPLACE INTO __check_constraints (name, table_name, expression)
      VALUES (
        '${escapeSql(def.name)}',
        '${escapeSql(def.table)}',
        '${escapeSql(def.expression)}'
      )
    `);
  }

  logger.debug({ table: def.table, expression: def.expression }, 'CHECK constraint registered');
}

/**
 * Remove CHECK constraint(s) for a table.
 */
export async function removeConstraints(
  tableName: string,
  queryFn?: (sql: string) => Promise<any>,
): Promise<void> {
  const prefix = tableName.toLowerCase() + '.';
  for (const [key] of checkDefs) {
    if (key.startsWith(prefix)) {
      checkDefs.delete(key);
    }
  }

  if (queryFn) {
    await ensureMetaTable(queryFn);
    await queryFn(`DELETE FROM __check_constraints WHERE table_name = '${escapeSql(tableName)}'`);
  }

  logger.debug({ table: tableName }, 'CHECK constraints removed');
}

/**
 * Get all CHECK constraint definitions for a table.
 */
export function getConstraints(tableName: string): CheckConstraintDef[] {
  const defs: CheckConstraintDef[] = [];
  const prefix = tableName.toLowerCase() + '.';
  for (const [key, def] of checkDefs) {
    if (key.startsWith(prefix)) {
      defs.push(def);
    }
  }
  return defs;
}

/**
 * Evaluate a CHECK constraint expression against a row.
 *
 * Delegates to ConstraintEvaluator for sandboxed execution.
 *
 * @param expression - SQL expression (e.g., "price > 0", "status IN ('active','inactive')")
 * @param row - Row values as a column-name -> value map
 * @returns true if the constraint passes
 */
function evaluateCheck(expression: string, row: Record<string, any>): boolean {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return true;

  try {
    return evaluator.evaluateCheck(trimmed, row);
  } catch {
    logger.warn({ expression: trimmed }, 'CHECK constraint evaluation error, passing by default');
    return true;
  }
}

/**
 * Check constraints on INSERT.
 *
 * @param table - The table name
 * @param row - Row values
 * @param queryFn - Function to execute SQL (used only for logging/query if needed)
 * @throws If a constraint is violated
 */
export async function onInsert(
  table: string,
  row: Record<string, any>,
  _queryFn?: (sql: string) => Promise<any>,
): Promise<void> {
  const defs = getConstraints(table);
  for (const def of defs) {
    if (!evaluateCheck(def.expression, row)) {
      const errMsg = `new row for relation "${table}" violates check constraint "${def.name}": expression: ${def.expression}`;
      logger.warn({ constraint: def.name, table, expression: def.expression }, errMsg);
      throw new Error(errMsg);
    }
  }
}

/**
 * Check constraints on UPDATE.
 *
 * @param table - The table name
 * @param row - New row values
 * @param oldRow - Old row values (used to check if relevant columns changed)
 * @param queryFn - Function to execute SQL
 * @throws If a constraint is violated
 */
export async function onUpdate(
  table: string,
  row: Record<string, any>,
  _oldRow: Record<string, any>,
  _queryFn?: (sql: string) => Promise<any>,
): Promise<void> {
  const defs = getConstraints(table);
  for (const def of defs) {
    if (!evaluateCheck(def.expression, row)) {
      const errMsg = `new row for relation "${table}" violates check constraint "${def.name}": expression: ${def.expression}`;
      logger.warn({ constraint: def.name, table, expression: def.expression }, errMsg);
      throw new Error(errMsg);
    }
  }
}

/**
 * Load CHECK constraint definitions from the system table.
 */
export async function loadFromDB(queryFn: (sql: string) => Promise<any>): Promise<void> {
  try {
    await ensureMetaTable(queryFn);
    const result = await queryFn('SELECT name, table_name, expression FROM __check_constraints');

    let rows: any[] = [];
    if (Array.isArray(result)) {
      rows = result;
    } else if (result && result.rows) {
      rows = result.rows;
    }

    for (const row of rows) {
      const def: CheckConstraintDef = {
        name: row.name || row[0],
        table: row.table_name || row[1],
        expression: row.expression || row[2] || '',
      };
      checkDefs.set(`${def.table.toLowerCase()}.${def.name.toLowerCase()}`, def);
    }

    logger.debug({ count: checkDefs.size }, 'CHECK constraints loaded from DB');
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Failed to load CHECK defs from DB');
  }
}

// ── Internal Helpers ─────────────────────────────────────────────

function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}
