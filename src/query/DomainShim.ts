// @ts-nocheck
/**
 * DomainShim — PostgreSQL DOMAIN type real implementation for SQLite.
 *
 * Real logic (G11):
 * - create(name, baseType, constraints) — register domain in `__domains` system table
 * - validate(value, domainName) — execute CHECK constraints against a value
 *
 * SQLite does not support CREATE DOMAIN / DROP DOMAIN / ALTER DOMAIN natively.
 * This shim stores domain definitions in a `__domains` system table and provides
 * runtime validation.
 *
 * Domain constraints are stored as SQL expressions (CHECK clauses) that can be
 * evaluated at value validation time.
 *
 * @module DomainShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { ConstraintEvaluator } from '../constraint/ConstraintEvaluator';

const logger = PinoLogger.forComponent('DomainShim');

// ── Shared evaluator instance ───────────────────────────────────
// @ts-expect-error ConstraintEvaluator is a JS constructor function
const evaluator = new ConstraintEvaluator();

// ── Types ────────────────────────────────────────────────────────

export interface DomainResult {
  sql: string | null;
  rewritten: boolean;
  isDomainDDL: boolean;
}

export interface DomainDef {
  name: string;
  baseType: string;
  constraints: DomainConstraint[];
}

export interface DomainConstraint {
  /** CHECK expression as a SQL fragment (e.g., "VALUE > 0") */
  expression: string;
  /** Optional constraint name */
  name?: string;
}

// ── Constants ────────────────────────────────────────────────────

const CREATE_DOMAIN_RE = /^\s*CREATE\s+DOMAIN\s+/i;
const DROP_DOMAIN_RE = /^\s*DROP\s+DOMAIN\s+/i;
const ALTER_DOMAIN_RE = /^\s*ALTER\s+DOMAIN\s+/i;
const DOMAIN_DDL_RE = /^\s*(CREATE|DROP|ALTER)\s+DOMAIN\s+/i;

const DOMAIN_BASE_TYPES: Record<string, string> = {
  integer: 'INTEGER', int: 'INTEGER', bigint: 'INTEGER', smallint: 'INTEGER',
  text: 'TEXT', varchar: 'TEXT', char: 'TEXT', character: 'TEXT',
  boolean: 'INTEGER', bool: 'INTEGER',
  numeric: 'REAL', decimal: 'REAL', real: 'REAL', float: 'REAL',
  double: 'REAL', date: 'TEXT', timestamp: 'TEXT', timestamptz: 'TEXT',
  time: 'TEXT', interval: 'TEXT', json: 'TEXT', jsonb: 'TEXT',
  uuid: 'TEXT', bytea: 'BLOB', blob: 'BLOB',
};

/** Virtual system table schema for domain definitions */
const DOMAIN_META_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS __domains (
    name TEXT PRIMARY KEY,
    base_type TEXT NOT NULL,
    constraints_json TEXT NOT NULL DEFAULT '[]'
  )
`;

// ── In-memory registry ───────────────────────────────────────────

const domainRegistry = new Map<string, DomainDef>();

// ── Public API ───────────────────────────────────────────────────

export function detectDomainStmt(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  return DOMAIN_DDL_RE.test(sql.trim());
}

export function handleDomainStmt(sql: string): DomainResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false, isDomainDDL: false };
  }
  const trimmed = sql.trim();

  if (CREATE_DOMAIN_RE.test(trimmed)) {
    logger.debug('Suppressing CREATE DOMAIN statement: %s', trimmed);
    return { sql: null, rewritten: false, isDomainDDL: true };
  }
  if (DROP_DOMAIN_RE.test(trimmed)) {
    logger.debug('Suppressing DROP DOMAIN statement: %s', trimmed);
    return { sql: null, rewritten: false, isDomainDDL: true };
  }
  if (ALTER_DOMAIN_RE.test(trimmed)) {
    logger.debug('Suppressing ALTER DOMAIN statement: %s', trimmed);
    return { sql: null, rewritten: false, isDomainDDL: true };
  }
  return { sql: trimmed, rewritten: false, isDomainDDL: false };
}

export function detectDomainTypeRef(typeName: string): boolean {
  if (!typeName || typeof typeName !== 'string') return false;
  const normalized = typeName.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (DOMAIN_BASE_TYPES[normalized] !== undefined) return false;

  return !/^[a-z][a-z0-9_]*$/i.test(normalized) ? false : true;
}

/**
 * Ensure the metadata table exists in the database.
 */
export async function ensureMetaTable(queryFn: (sql: string) => Promise<any>): Promise<void> {
  try {
    await queryFn(DOMAIN_META_TABLE_DDL);
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to create domains meta table');
    throw err;
  }
}

/**
 * Create a domain: extract definition from a CREATE DOMAIN SQL and register it.
 *
 * @param name - Domain name
 * @param baseType - Base SQL type (e.g., 'INTEGER', 'TEXT')
 * @param constraints - Array of CHECK constraint definitions
 * @param queryFn - Optional function to persist to system table
 */
export async function create(
  name: string,
  baseType: string,
  constraints: DomainConstraint[],
  queryFn?: (sql: string) => Promise<any>,
): Promise<DomainDef> {
  const def: DomainDef = { name, baseType, constraints };
  domainRegistry.set(name.toLowerCase(), def);

  if (queryFn) {
    await ensureMetaTable(queryFn);
    const constraintsJson = JSON.stringify(constraints);
    await queryFn(`
      INSERT OR REPLACE INTO __domains (name, base_type, constraints_json)
      VALUES ('${escapeSql(name)}', '${escapeSql(baseType)}', '${escapeSql(constraintsJson)}')
    `);
  }

  logger.info({ name, baseType, constraintCount: constraints.length }, 'Domain created');
  return def;
}

/**
 * Validate a value against a domain's constraints.
 *
 * @param value - The value to validate
 * @param domainName - The domain name to validate against
 * @returns true if the value satisfies all constraints
 * @throws If the domain is not found
 */
export function validate(value: any, domainName: string): boolean {
  const def = domainRegistry.get(domainName.toLowerCase());
  if (!def) {
    throw new Error(`Domain "${domainName}" not found`);
  }

  for (const constraint of def.constraints) {
    if (!evaluateConstraint(constraint.expression, value)) {
      logger.warn(
        { domain: domainName, value, constraint: constraint.expression },
        'Domain constraint violation',
      );
      return false;
    }
  }

  return true;
}

/**
 * Parse a CREATE DOMAIN SQL and extract the definition.
 * Example: CREATE DOMAIN positive_int AS INTEGER CHECK (VALUE > 0);
 *
 * @param sql - The CREATE DOMAIN SQL
 * @returns Parsed DomainDef
 */
export function parseDomainSQL(sql: string): DomainDef | null {
  const trimmed = sql.trim();
  const match = trimmed.match(
    /^\s*CREATE\s+DOMAIN\s+([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+(\w+)(.*)$/i,
  );
  if (!match) return null;

  const name = match[1];
  const baseType = match[2].toUpperCase();
  const rest = match[3];

  // Extract CHECK constraints from the rest
  const constraints: DomainConstraint[] = [];
  const checkRe = /CHECK\s*\(\s*([^)]+)\s*\)/gi;
  let checkMatch: RegExpExecArray | null;

  while ((checkMatch = checkRe.exec(rest)) !== null) {
    const expr = checkMatch[1].trim();
    constraints.push({ expression: expr });
  }

  return { name, baseType, constraints };
}

/**
 * Drop a domain from the registry and optionally from the system table.
 */
export async function drop(
  name: string,
  queryFn?: (sql: string) => Promise<any>,
): Promise<void> {
  const key = name.toLowerCase();
  const existed = domainRegistry.delete(key);

  if (queryFn) {
    await ensureMetaTable(queryFn);
    await queryFn(`DELETE FROM __domains WHERE name = '${escapeSql(name)}'`);
  }

  if (existed) {
    logger.info({ name }, 'Domain dropped');
  }
}

/**
 * List all registered domains.
 */
export function list(): DomainDef[] {
  return Array.from(domainRegistry.values());
}

/**
 * Get a domain definition.
 */
export function get(name: string): DomainDef | undefined {
  return domainRegistry.get(name.toLowerCase());
}

/**
 * Load domains from the system table into the in-memory registry.
 */
export async function loadFromDB(queryFn: (sql: string) => Promise<any>): Promise<void> {
  try {
    await ensureMetaTable(queryFn);
    const result = await queryFn('SELECT name, base_type, constraints_json FROM __domains');

    let rows: any[] = [];
    if (Array.isArray(result)) {
      rows = result;
    } else if (result && result.rows) {
      rows = result.rows;
    }

    for (const row of rows) {
      const name = row.name || row[0];
      const baseType = row.base_type || row[1];
      const constraintsJson = row.constraints_json || row[2] || '[]';
      const constraints: DomainConstraint[] = JSON.parse(
        typeof constraintsJson === 'string' ? constraintsJson : '[]',
      );
      domainRegistry.set(name.toLowerCase(), { name, baseType, constraints });
    }

    logger.debug({ count: domainRegistry.size }, 'Domains loaded from DB');
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Failed to load domains from DB (table may not exist yet)');
  }
}

// ── Internal Helpers ─────────────────────────────────────────────

function evaluateConstraint(expression: string, value: any): boolean {
  // Domain CHECK expressions use VALUE as the placeholder for the value
  // Convert to a column reference that ConstraintEvaluator can handle
  const sqlExpr = expression.replace(/\bVALUE\b/gi, '__val');

  try {
    return evaluator.evaluateCheck(sqlExpr, { __val: value });
  } catch {
    logger.warn({ expression, value }, 'Domain constraint evaluation error, passing by default');
    return true;
  }
}

function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}
