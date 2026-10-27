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

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

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
 * The three PG cast syntaxes this shim rewrites:
 *
 *   - expr::type            — `x::int`, `(a+b)::numeric(10,2)`, `COUNT(*)::bigint`
 *   - CAST(expr AS type)    — `CAST(x AS integer)`
 *   - type 'literal'        — `DATE '2024-01-01'`, `BOOLEAN 'true'`
 *
 * These are matched by the scanner below (see `findNextTypeCast`), not by
 * regex, so string literals, quoted identifiers, dollar-quoted strings and
 * comments never fool the matcher, and nested parentheses in the operator's
 * left operand (or a cast expression) are balanced correctly.
 */

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
  return findNextTypeCast(sql.trim(), 0) !== null;
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
  return findNextTypeCast(sql.trim(), 0, 'operator') !== null;
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
  return findNextTypeCast(sql.trim(), 0, 'function') !== null;
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
  return findNextTypeCast(sql.trim(), 0, 'literal') !== null;
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

  let result = '';
  let cursor = 0;
  let rewritten = false;
  const len = trimmed.length;

  while (cursor < len) {
    const found = findNextTypeCast(trimmed, cursor);
    if (found === null) {
      result += trimmed.slice(cursor);
      break;
    }

    result += trimmed.slice(cursor, found.start);
    result += found.replacement;
    rewritten = true;
    cursor = found.end;
  }

  if (rewritten) {
    result = result.replace(/\s{2,}/g, ' ').trim();
    logger.debug({ original: trimmed, rewritten: result }, 'Type cast rewritten');
  }

  return { sql: result, rewritten };
}

// ── Internal scanner ─────────────────────────────────────────────

type CastSyntax = 'operator' | 'function' | 'literal';

interface LocatedTypeCast {
  /** Index of the first character of the matched construct. */
  start: number;
  /** Index just past the matched construct. */
  end: number;
  /** The SQLite-compatible replacement expression. */
  replacement: string;
}

/**
 * Literal-prefix type names, in order. `DOUBLE PRECISION` (two words) must be
 * matched before the single word `DOUBLE`, so it is listed first.
 */
const LITERAL_PREFIX_TYPES = [
  'DOUBLE PRECISION',
  'TIMESTAMP',
  'BOOLEAN',
  'INTEGER',
  'SMALLINT',
  'BIGINT',
  'VARCHAR',
  'INTERVAL',
  'DATE',
  'TIME',
  'FLOAT',
  'REAL',
  'TEXT',
  'INT',
  'NUMERIC',
  'DECIMAL',
  'JSON',
  'JSONB',
  'INET',
  'CIDR',
];

/**
 * Find the next PG type-cast construct at or after `from`, skipping string
 * literals, quoted identifiers, dollar-quoted strings and comments.
 *
 * When `only` is given, only that syntax kind is considered (used by the three
 * `detect*` helpers).
 *
 * @returns The located construct, or `null` if none remain.
 */
function findNextTypeCast(sql: string, from: number, only?: CastSyntax): LocatedTypeCast | null {
  const len = sql.length;

  for (let i = from; i < len; ) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    const ch = sql[i];

    // `::` operator.
    if (ch === ':' && sql[i + 1] === ':' && (!only || only === 'operator')) {
      const found = matchCastOperator(sql, i);
      if (found) return found;
    }

    // CAST( ... AS ... ).
    if (
      (!only || only === 'function') &&
      isWordStart(sql, i) &&
      sql.slice(i, i + 4).toLowerCase() === 'cast'
    ) {
      const found = matchCastFunction(sql, i);
      if (found) return found;
    }

    // type 'literal'.
    if (!only || only === 'literal') {
      const found = matchLiteralPrefix(sql, i);
      if (found) return found;
    }

    i++;
  }

  return null;
}

/**
 * Try to parse an `expr::type` operator whose `::` begins at `i`.
 */
function matchCastOperator(sql: string, i: number): LocatedTypeCast | null {
  // Locate the left operand's start by scanning backwards.
  const leftStart = backscanLeftOperand(sql, i);
  if (leftStart === -1) return null;

  const expr = sql.slice(leftStart, i).trim();
  if (expr.length === 0) return null;

  // Locate the type name after `::`.
  const typeInfo = scanTypeName(sql, i + 2);
  if (!typeInfo) return null;

  const replacement = mapTypeToSQLite(expr, typeInfo.name);

  return { start: leftStart, end: typeInfo.end, replacement };
}

/**
 * Try to parse `CAST(expr AS type)` whose `CAST` keyword begins at `i`.
 */
function matchCastFunction(sql: string, i: number): LocatedTypeCast | null {
  // Ensure the keyword is not a prefix of a longer identifier (e.g. `casted`).
  if (i + 4 < sql.length && /[A-Za-z0-9_]/.test(sql[i + 4])) return null;

  // Skip whitespace to the opening parenthesis.
  let p = i + 4;
  while (p < sql.length && /\s/.test(sql[p])) p++;
  if (p >= sql.length || sql[p] !== '(') return null;

  const close = findMatchingParen(sql, p);
  if (close === -1) return null;

  const inner = sql.slice(p + 1, close);

  // Split `expr AS type` at the top-level `AS`.
  const asIdx = findTopLevelAs(inner);
  if (asIdx === -1) return null;

  const expr = inner.slice(0, asIdx).trim();
  const typeName = inner.slice(asIdx + 2).trim();
  if (expr.length === 0 || typeName.length === 0) return null;

  const replacement = mapTypeToSQLite(expr, stripTypeParams(typeName));

  return { start: i, end: close + 1, replacement };
}

/**
 * Try to parse `TYPE 'literal'` whose type name begins at `i`.
 */
function matchLiteralPrefix(sql: string, i: number): LocatedTypeCast | null {
  if (!isWordStart(sql, i)) return null;

  for (const typeName of LITERAL_PREFIX_TYPES) {
    const slice = sql.slice(i, i + typeName.length);
    if (slice.toUpperCase() !== typeName) continue;

    // Ensure the type name ends at a word boundary (not `DATE_x`).
    const after = i + typeName.length;
    if (after < sql.length && /[A-Za-z0-9_]/.test(sql[after])) continue;

    // Skip whitespace to the string literal.
    let p = after;
    while (p < sql.length && /\s/.test(sql[p])) p++;

    if (p >= sql.length || sql[p] !== "'") continue;

    const litEnd = skipSqlLiteral(sql, p);
    if (litEnd === -1) continue;

    const raw = sql.slice(p, litEnd);
    // An unterminated string literal (skipSqlLiteral returns `len`) yields a
    // `raw` that does not end with a closing quote; skip it rather than
    // slicing off a phantom character.
    if (raw.length < 2 || !raw.endsWith("'")) continue;

    // Extract the literal body (strip quotes), honoring `''` escapes.
    const literal = raw.slice(1, -1).replace(/''/g, "'");

    const replacement = renderLiteralPrefix(typeName, literal);
    return { start: i, end: litEnd, replacement };
  }

  return null;
}

/**
 * Render the SQLite equivalent of a PG `TYPE 'literal'` construct.
 */
function renderLiteralPrefix(typeName: string, literal: string): string {
  switch (typeName) {
    case 'DATE':
      return `DATE('${literal.replace(/'/g, "''")}')`;
    case 'TIMESTAMP':
      return `DATETIME('${literal.replace(/'/g, "''")}')`;
    case 'TIME':
      return `TIME('${literal.replace(/'/g, "''")}')`;
    case 'BOOLEAN': {
      const v = literal.toLowerCase();
      return v === 'true' || v === 't' ? '1' : '0';
    }
    case 'INTEGER':
    case 'INT':
    case 'BIGINT':
    case 'SMALLINT':
      return `CAST('${literal.replace(/'/g, "''")}' AS INTEGER)`;
    case 'REAL':
    case 'FLOAT':
    case 'DOUBLE PRECISION':
      return `CAST('${literal.replace(/'/g, "''")}' AS REAL)`;
    case 'TEXT':
    case 'VARCHAR':
    case 'INTERVAL':
      // Pass through as a string literal.
      return `'${literal.replace(/'/g, "''")}'`;
    case 'NUMERIC':
    case 'DECIMAL':
      return `CAST('${literal.replace(/'/g, "''")}' AS REAL)`;
    case 'JSON':
    case 'JSONB':
      // JSON literal → the JSON text itself (JSONB is stored as TEXT).
      return `'${literal.replace(/'/g, "''")}'`;
    case 'INET':
    case 'CIDR':
      // inet/cidr have no native SQLite type; the value is stored/consumed as
      // TEXT. Emit a plain string literal so downstream inet functions receive
      // the exact literal (InetShim parses strings, not a synthetic type).
      return `'${literal.replace(/'/g, "''")}'`;
    default:
      return `'${literal.replace(/'/g, "''")}'`;
  }
}

/**
 * SQL keywords that must never be treated as the left operand of a `::` cast.
 * Without this guard, a malformed fragment like `SELECT ::int` would rewrite to
 * `CAST(SELECT AS INTEGER)`. The list covers the keywords most likely to appear
 * in the token position immediately before a stray `::`.
 */
const SQL_KEYWORDS = new Set([
  'select', 'distinct', 'from', 'where', 'and', 'or', 'not', 'as', 'by',
  'in', 'on', 'set', 'values', 'insert', 'update', 'delete', 'case', 'when',
  'then', 'else', 'end', 'group', 'order', 'having', 'limit', 'offset',
  'union', 'intersect', 'except', 'join', 'left', 'right', 'inner', 'outer',
  'cross', 'full', 'null', 'is', 'like', 'between', 'exists', 'asc', 'desc',
  'into', 'returning', 'using', 'natural',
]);

/**
 * Scan backwards from the character before `::` to find the start of the left
 * operand (an identifier chain, a parenthesized expression, or a function call).
 *
 * Returns the index of the first character of the operand, or `-1` if there is
 * no valid left operand.
 */
function backscanLeftOperand(sql: string, opIdx: number): number {
  let i = opIdx - 1;

  // Skip trailing whitespace.
  while (i >= 0 && /\s/.test(sql[i])) i--;
  if (i < 0) return -1;

  const ch = sql[i];

  // Case 1: operand ends with `)` — a parenthesized expression or function call.
  if (ch === ')') {
    let depth = 0;
    let j = i;
    for (; j >= 0; j--) {
      const c = sql[j];
      if (c === ')') depth++;
      else if (c === '(') {
        depth--;
        if (depth === 0) break;
      }
      // Reverse literal scan is not needed here: the operand is a `)`-terminated
      // construct, and any literal inside it does not affect paren counting.
    }
    if (j < 0) return -1;

    // Only continue back over an identifier chain when the `(` is immediately
    // preceded by an identifier character (a function call like `COUNT(*)` or
    // `schema.fn(...)`). A whitespace gap means the `(` is a standalone grouped
    // expression ((a+b)), and the preceding token (e.g. `SELECT`) is NOT part
    // of the operand.
    const k = j - 1;
    if (k >= 0 && /[A-Za-z0-9_$.]/.test(sql[k])) {
      let m = k;
      while (m >= 0 && /[A-Za-z0-9_$.]/.test(sql[m])) m--;
      return m + 1;
    }
    return j;
  }

  // Case 2: operand ends with a string literal close quote.
  if (ch === "'") {
    // Back over a single-quoted string (handle `''` escapes).
    let j = i; // points at closing `'`
    let k = j - 1;
    for (; k >= 0; k--) {
      if (sql[k] === "'") {
        if (k > 0 && sql[k - 1] === "'") {
          k--; // doubled quote, keep going
        } else {
          break; // opening quote
        }
      }
    }
    if (k < 0) return -1;
    return k;
  }

  // Case 3: a plain identifier chain (e.g. `x`, `t.col`).
  if (/[A-Za-z0-9_$.]/.test(ch)) {
    let j = i;
    while (j >= 0 && /[A-Za-z0-9_$.]/.test(sql[j])) j--;
    const operand = sql.slice(j + 1, i + 1);

    // A SQL keyword preceding a stray `::` is not an operand.
    if (SQL_KEYWORDS.has(operand.toLowerCase())) return -1;

    return j + 1;
  }

  return -1;
}

/**
 * Scan a type name beginning at `from` (just after `::` or `AS`), returning its
 * text (without length parameters) and the index just past it.
 */
function scanTypeName(sql: string, from: number): { name: string; end: number } | null {
  let p = from;
  while (p < sql.length && /\s/.test(sql[p])) p++;

  const m = sql.slice(p).match(/^[A-Za-z_]\w*(?:\s+(?:PRECISION|precision))?/);
  if (!m) return null;

  const rawType = m[0];
  p += rawType.length;

  // Skip an optional length/precision parameter list like `(10,2)`. If the
  // parameter list is unbalanced, the type name cannot be located reliably, so
  // treat the whole construct as malformed and return null.
  if (p < sql.length && sql[p] === '(') {
    const close = findMatchingParen(sql, p);
    if (close === -1) return null;
    p = close + 1;
  }

  return { name: rawType.trim(), end: p };
}

/**
 * Strip a type name of any length/precision parameters (e.g. `numeric(10,2)`).
 */
function stripTypeParams(typeName: string): string {
  return typeName
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .trim();
}

/**
 * Find the index of a top-level `AS` keyword (word-boundary delimited and
 * outside any nested parentheses or literals) within a CAST argument list.
 */
function findTopLevelAs(content: string): number {
  let depth = 0;
  const len = content.length;

  for (let i = 0; i < len; ) {
    const skipped = skipSqlLiteral(content, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    const ch = content[i];
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      i++;
      continue;
    }

    if (
      depth === 0 &&
      (content[i] === 'a' || content[i] === 'A') &&
      isWordStart(content, i) &&
      content.slice(i, i + 2).toUpperCase() === 'AS' &&
      (i + 2 >= len || !/[A-Za-z0-9_]/.test(content[i + 2]))
    ) {
      return i;
    }

    i++;
  }

  return -1;
}

/**
 * Return true if `pos` is a word boundary (previous char is not an identifier
 * character).
 */
function isWordStart(sql: string, pos: number): boolean {
  return pos === 0 || !/[A-Za-z0-9_]/.test(sql[pos - 1]);
}

/**
 * Find the index of the `)` that balances the `(` at `openParen`, honoring
 * literals, quoted identifiers, dollar-quoted strings and comments.
 */
function findMatchingParen(sql: string, openParen: number): number {
  let depth = 0;
  const len = sql.length;

  for (let i = openParen; i < len; ) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Map a PG type name to a SQLite equivalent and generate the cast expression.
 */
function mapTypeToSQLite(expr: string, typeName: string): string {
  // Normalize: lowercase, strip length parameters
  const normalized = stripTypeParams(typeName);

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
