/**
 * TypeCastShim — PostgreSQL type cast compatibility shim for SQLite.
 *
 * PostgreSQL supports multiple type cast syntaxes:
 *   - CAST(expr AS type)
 *   - expr::type
 *   - type 'literal'  (e.g., DATE '2024-01-01', TIMESTAMP '2024-01-01 12:00:00')
 *
 * SQLite has its own CAST() function but with different type support.
 * This shim translates PG cast syntax into SQLite-compatible equivalents.
 *
 * ## Type mapping
 *
 * | PG type            | SQLite target       | Translation                                              |
 * |--------------------|---------------------|----------------------------------------------------------|
 * | INTEGER, INT       | INTEGER             | CAST(expr AS INTEGER)                                    |
 * | BIGINT             | INTEGER             | CAST(expr AS INTEGER)                                    |
 * | SMALLINT           | INTEGER             | CAST(expr AS INTEGER)                                    |
 * | TEXT, VARCHAR(n)   | TEXT                | CAST(expr AS TEXT)                                       |
 * | BOOLEAN            | INTEGER (0/1)       | CASE WHEN expr THEN 1 ELSE 0 END                         |
 * | FLOAT, DOUBLE      | REAL                | CAST(expr AS REAL)                                       |
 * | NUMERIC(p,s)       | REAL                | CAST(expr AS REAL)                                       |
 * | DATE               | TEXT                | DATE(expr)                                               |
 * | TIMESTAMP          | TEXT                | DATETIME(expr)                                           |
 * | TIMESTAMPTZ        | TEXT                | DATETIME(expr)                                           |
 * | TIME               | TEXT                | TIME(expr)                                               |
 * | INTERVAL           | TEXT                | (stored as literal, no direct SQLite equivalent)         |
 * | JSON, JSONB        | TEXT                | CAST(expr AS TEXT)                                       |
 * | BYTEA              | BLOB                | (use hex/x'...' literals)                                |
 *
 * ## Literal prefix syntax
 *
 * | PG syntax                 | SQLite equivalent           |
 * |---------------------------|-----------------------------|
 * | DATE '2024-01-01'         | DATE('2024-01-01')          |
 * | TIMESTAMP '2024-01-01'    | DATETIME('2024-01-01')      |
 * | TIME '12:00:00'           | TIME('12:00:00')            |
 * | INTERVAL '1 day'          | '1 day' (pass through)      |
 * | BOOLEAN 'true'            | 1                           |
 * | BOOLEAN 'false'           | 0                           |
 *
 * @module TypeCastShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('TypeCastShim');

// ── Types ────────────────────────────────────────────────────────

export interface TypeCastResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * Detects expr::type syntax.
 *
 * Examples:
 *   x::int
 *   x::text
 *   x::integer
 *   x::varchar(255)
 *   x::numeric(10,2)
 *   x::boolean
 *   x::date
 *   x::timestamp
 *   x::timestamptz
 *   x::bigint
 *   x::smallint
 *   x::double precision
 *   x::float
 *   x::real
 *   x::jsonb
 *   x::json
 *   (expr)::type
 *   COUNT(*)::int
 *   COUNT(DISTINCT x)::bigint
 *   MAX(x)::text
 */
const CAST_OPERATOR_RE = /((?:\w+(?:\.\w+)*)\([^)]+\)|\([^)]+\)|\w+(?:\.\w+)*)\s*::\s*([A-Za-z_]\w*(?:\s*(?:PRECISION|precision))?(?:\s*\([^)]*\))?)/gi;

/**
 * Detects CAST(expr AS type) syntax.
 *
 * Handles standard SQL CAST syntax with various PG type names.
 */
const CAST_FUNC_RE = /\bCAST\s*\(\s*([\s\S]*?)\s+AS\s+([A-Za-z_]\w*(?:\s+(?:PRECISION|precision))?(?:\s*\([^)]*\))?)\s*\)/gi;

/**
 * Detects PG literal prefix syntax: type 'literal'
 *
 * Examples:
 *   DATE '2024-01-01'
 *   TIMESTAMP '2024-01-01 12:00:00'
 *   TIME '12:00:00'
 *   BOOLEAN 'true'
 *   INTEGER '42'
 *   REAL '3.14'
 */
const LITERAL_PREFIX_RE = /\b(DATE|TIMESTAMP|TIME|BOOLEAN|INTEGER|INT|BIGINT|SMALLINT|REAL|FLOAT|DOUBLE\s+PRECISION|TEXT|VARCHAR|INTERVAL)\s+'([^']*)'/gi;

// ── Type mapping ─────────────────────────────────────────────────

type TargetType = 'INTEGER' | 'TEXT' | 'REAL' | 'BLOB' | 'EXPR';

interface TypeMapping {
  target: TargetType;
  /** Custom expression template. Use $expr for the input expression placeholder */
  customExpr?: string;
}

const PG_TO_SQLITE_TYPE: Record<string, TypeMapping> = {
  // Integer types
  'integer': { target: 'INTEGER' },
  'int': { target: 'INTEGER' },
  'int4': { target: 'INTEGER' },
  'bigint': { target: 'INTEGER' },
  'int8': { target: 'INTEGER' },
  'smallint': { target: 'INTEGER' },
  'int2': { target: 'INTEGER' },
  // Text types
  'text': { target: 'TEXT' },
  'varchar': { target: 'TEXT' },
  'char': { target: 'TEXT' },
  'character': { target: 'TEXT' },
  'name': { target: 'TEXT' },
  // Float/real types
  'real': { target: 'REAL' },
  'float': { target: 'REAL' },
  'float4': { target: 'REAL' },
  'float8': { target: 'REAL' },
  'double': { target: 'REAL' },
  'double precision': { target: 'REAL' },
  'numeric': { target: 'REAL' },
  'decimal': { target: 'REAL' },
  'money': { target: 'REAL' },
  // Boolean
  'boolean': { target: 'INTEGER', customExpr: 'CASE WHEN $expr THEN 1 ELSE 0 END' },
  'bool': { target: 'INTEGER', customExpr: 'CASE WHEN $expr THEN 1 ELSE 0 END' },
  // Date/time types (stored as TEXT in SQLite)
  'date': { target: 'TEXT', customExpr: "DATE($expr)" },
  'timestamp': { target: 'TEXT', customExpr: "DATETIME($expr)" },
  'timestamptz': { target: 'TEXT', customExpr: "DATETIME($expr)" },
  'timestamp with time zone': { target: 'TEXT', customExpr: "DATETIME($expr)" },
  'timestamp without time zone': { target: 'TEXT', customExpr: "DATETIME($expr)" },
  'time': { target: 'TEXT', customExpr: "TIME($expr)" },
  'timetz': { target: 'TEXT', customExpr: "TIME($expr)" },
  'interval': { target: 'TEXT' },
  // JSON
  'json': { target: 'TEXT' },
  'jsonb': { target: 'TEXT' },
  // Binary
  'bytea': { target: 'BLOB' },
  // Misc
  'uuid': { target: 'TEXT' },
  'xml': { target: 'TEXT' },
  'inet': { target: 'TEXT' },
  'cidr': { target: 'TEXT' },
  'macaddr': { target: 'TEXT' },
  'oid': { target: 'INTEGER' },
  'regproc': { target: 'TEXT' },
  'regclass': { target: 'TEXT' },
  'regtype': { target: 'TEXT' },
  'regrole': { target: 'TEXT' },
  'regnamespace': { target: 'TEXT' },
  'anyarray': { target: 'TEXT' },
};

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL contains any PG type cast syntax.
 *
 * Detects:
 *   - expr::type
 *   - CAST(expr AS type)
 *   - type 'literal' (DATE '...', TIMESTAMP '...', etc.)
 *
 * @param sql - The SQL text to check.
 * @returns `true` if any PG cast syntax is detected.
 */
export function detectTypeCast(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  const trimmed = sql.trim();

  // Check :: operator
  CAST_OPERATOR_RE.lastIndex = 0;
  if (CAST_OPERATOR_RE.test(trimmed)) return true;

  // Check CAST function
  CAST_FUNC_RE.lastIndex = 0;
  if (CAST_FUNC_RE.test(trimmed)) return true;

  // Check literal prefix
  LITERAL_PREFIX_RE.lastIndex = 0;
  if (LITERAL_PREFIX_RE.test(trimmed)) return true;

  return false;
}

/**
 * Detect whether the given SQL contains the ::cast operator.
 *
 * @param sql - The SQL text to check.
 * @returns `true` if :: syntax is detected.
 */
export function detectCastOperator(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }
  CAST_OPERATOR_RE.lastIndex = 0;
  return CAST_OPERATOR_RE.test(sql.trim());
}

/**
 * Detect whether the given SQL contains the CAST() function.
 *
 * @param sql - The SQL text to check.
 * @returns `true` if CAST() is detected.
 */
export function detectCastFunction(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }
  CAST_FUNC_RE.lastIndex = 0;
  return CAST_FUNC_RE.test(sql.trim());
}

/**
 * Detect whether the given SQL contains PG literal prefix syntax.
 *
 * @param sql - The SQL text to check.
 * @returns `true` if type 'literal' syntax is detected.
 */
export function detectLiteralPrefix(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }
  LITERAL_PREFIX_RE.lastIndex = 0;
  return LITERAL_PREFIX_RE.test(sql.trim());
}

/**
 * Rewrite PostgreSQL type cast syntax to SQLite-compatible SQL.
 *
 * Handles three cast forms:
 *   1. expr::type           →  CAST(expr AS sqlite_type) or custom expression
 *   2. CAST(expr AS type)   →  CAST(expr AS sqlite_type) or custom expression
 *   3. type 'literal'       →  sqlite_function('literal')
 *
 * @param sql - The SQL statement to rewrite.
 * @returns A TypeCastResult with the rewritten SQL.
 */
export function rewriteTypeCast(sql: string): TypeCastResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();

  // Fast path — no cast syntax present
  if (!detectTypeCast(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  let result = trimmed;
  let rewritten = false;

  // ── Phase 1: Literal prefix: type 'literal' ──────────────────

  LITERAL_PREFIX_RE.lastIndex = 0;
  result = result.replace(LITERAL_PREFIX_RE, (_match, typeName: string, literal: string) => {
    rewritten = true;
    const tn = typeName.toUpperCase();

    switch (tn) {
      case 'DATE':
        return `DATE('${literal}')`;
      case 'TIMESTAMP':
        return `DATETIME('${literal}')`;
      case 'TIME':
        return `TIME('${literal}')`;
      case 'BOOLEAN':
        return literal.toLowerCase() === 'true' || literal === 't' ? '1' : '0';
      case 'INTEGER':
      case 'INT':
      case 'BIGINT':
      case 'SMALLINT':
        return `CAST('${literal}' AS INTEGER)`;
      case 'REAL':
      case 'FLOAT':
      case 'DOUBLE PRECISION':
        return `CAST('${literal}' AS REAL)`;
      case 'TEXT':
      case 'VARCHAR':
        return `'${literal}'`;
      case 'INTERVAL':
        // Pass through as string literal
        return `'${literal}'`;
      default:
        return `'${literal}'`;
    }
  });

  // ── Phase 2: expr::type syntax ───────────────────────────────

  CAST_OPERATOR_RE.lastIndex = 0;
  result = result.replace(CAST_OPERATOR_RE, (_match, expr: string, typeName: string) => {
    rewritten = true;
    const mapped = mapTypeToSQLite(expr.trim(), typeName.trim());
    return mapped;
  });

  // ── Phase 3: CAST(expr AS type) syntax ──────────────────────

  CAST_FUNC_RE.lastIndex = 0;
  result = result.replace(CAST_FUNC_RE, (_match, expr: string, typeName: string) => {
    rewritten = true;
    const mapped = mapTypeToSQLite(expr.trim(), typeName.trim());
    return mapped;
  });

  // ── Normalize whitespace ────────────────────────────────────

  if (rewritten) {
    result = result.replace(/\s{2,}/g, ' ').trim();
    logger.debug({ original: trimmed, rewritten: result }, 'Type cast rewritten');
  }

  return { sql: result, rewritten };
}

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Map a PG type name to a SQLite equivalent and generate the cast expression.
 */
function mapTypeToSQLite(expr: string, typeName: string): string {
  // Normalize: lowercase, strip length parameters
  const normalized = typeName
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .trim();

  const mapping = PG_TO_SQLITE_TYPE[normalized];

  if (!mapping) {
    // Unknown type — use CAST to TEXT as safe default
    logger.debug({ typeName, normalized }, 'Unknown PG type in cast — using TEXT');
    return `CAST(${expr} AS TEXT)`;
  }

  if (mapping.customExpr) {
    return mapping.customExpr.replace(/\$expr/g, expr);
  }

  return `CAST(${expr} AS ${mapping.target})`;
}
