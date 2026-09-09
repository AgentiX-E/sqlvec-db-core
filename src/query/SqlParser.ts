/**
 * SqlParser — Full SQL parser using pgsql-ast-parser
 *
 * Replaces string-matching heuristics with proper AST-based parsing.
 * Supports:
 * - SELECT (with JOIN detection for multi-shard routing)
 * - INSERT (with value extraction for hash routing)
 * - UPDATE / DELETE (with WHERE clause)
 * - DDL (CREATE TABLE, CREATE INDEX, ALTER, etc.)
 * - Transaction statements (BEGIN, COMMIT, ROLLBACK)
 * - SERIAL → INTEGER AUTOINCREMENT rewrite (I2)
 */

import { parse, toSql } from 'pgsql-ast-parser';

// ──────────────────────────────────────────────
//  AST Cache — template-based LRU
//  Normalizes SQL by replacing literal values with
//  placeholders, then caches the parsed result by template.
//  Dramatically reduces parse time for -M simple mode
//  where pgbench sends structurally identical queries
//  with varying parameter values.
// ──────────────────────────────────────────────

const AST_CACHE_MAX = 256;
const astCache = new Map<string, ParsedStatement>();

/**
 * Normalize SQL by replacing literal values with '?' placeholders.
 * This enables cache hits across queries that differ only in parameter values.
 *
 * Examples:
 *   SELECT * FROM t WHERE id = 42   →  SELECT * FROM t WHERE id = ?
 *   INSERT INTO t VALUES(1,'foo')   →  INSERT INTO t VALUES(?,?)
 *   UPDATE t SET x = 1.5 WHERE y    →  UPDATE t SET x = ? WHERE y
 */
function normalizeSqlTemplate(sql: string): string {
  return sql
    // Replace numeric literals (integers, floats, negatives)
    .replace(/(?<=\s|^|,|\(|=|>|<|!)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|$|,|\)|;)/g, '?')
    // Replace quoted string literals (single quotes, including escaped quotes)
    .replace(/'[^']*(?:''[^']*)*'/g, "'?'")
    // Replace dollar-quoted strings: $tag$...$tag$
    .replace(/\$[^$]*\$[^$]*\$[^$]*\$/g, '?')
    // Replace boolean literals
    .replace(/\b(true|false)\b/gi, '?')
    // Replace NULL literal
    .replace(/\bNULL\b/gi, '?')
    // Collapse multiple consecutive '?' into single '?'
    .replace(/\?\s*\?/g, '?');
}

function getCachedAST(sql: string): ParsedStatement | undefined {
  const normalized = normalizeSqlTemplate(sql);
  const cached = astCache.get(normalized);
  if (cached) {
    // Clone the cached result with the original SQL
    return { ...cached, originalSql: sql } as ParsedStatement;
  }
  return undefined;
}

function setCachedAST(sql: string, stmt: ParsedStatement): void {
  const normalized = normalizeSqlTemplate(sql);
  // LRU eviction: if at capacity, delete oldest entry
  if (astCache.size >= AST_CACHE_MAX) {
    const firstKey = astCache.keys().next().value;
    if (firstKey !== undefined) astCache.delete(firstKey);
  }
  // Store with original SQL reference for proper template matching
  astCache.set(normalized, { ...stmt, originalSql: sql } as ParsedStatement);
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface SelectStatement {
  type: 'SELECT';
  originalSql: string;
  tables: string[];
  hasJoin: boolean;
  isMultiShard: boolean;
  orderBy?: string;
  limit?: number;
}

export interface InsertStatement {
  type: 'INSERT';
  originalSql: string;
  table: string;
  columns: string[];
  hasReturning: boolean;
  /** Extracted VALUES row(s) for hash routing — first column value if id-like */
  keyColumn?: string;
  keyValues?: any[];
}

export interface UpdateStatement {
  type: 'UPDATE';
  originalSql: string;
  table: string;
  whereColumns?: string[];
}

export interface DeleteStatement {
  type: 'DELETE';
  originalSql: string;
  table: string;
  whereColumns?: string[];
}

export interface DDLStatement {
  type: 'DDL';
  originalSql: string;
  rewrittenSql?: string;
  table?: string;
  ddlType: 'CREATE_TABLE' | 'CREATE_INDEX' | 'ALTER' | 'DROP' | 'OTHER';
}

export interface TransactionStatement {
  type: 'TRANSACTION';
  originalSql: string;
  command: 'BEGIN' | 'COMMIT' | 'ROLLBACK' | 'SET TRANSACTION';
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  accessMode?: 'READ WRITE' | 'READ ONLY';
  deferrable?: boolean;
}

export interface UnknownStatement {
  type: 'UNKNOWN';
  originalSql: string;
}

export interface PrepareStatement {
  type: 'PREPARE';
  originalSql: string;
  name: string;
  paramTypes: string[];
  innerSql: string;
}

export interface ExecuteStatement {
  type: 'EXECUTE';
  originalSql: string;
  name: string;
  params: any[];
}

export interface DeallocateStatement {
  type: 'DEALLOCATE';
  originalSql: string;
  name: string; // 'ALL' for DEALLOCATE ALL
}

export interface CursorStatement {
  type: 'CURSOR';
  originalSql: string;
  action: 'DECLARE' | 'FETCH' | 'MOVE' | 'CLOSE';
  cursorName: string;
  /** For DECLARE: the SELECT SQL */
  innerSql?: string;
  /** For DECLARE: scroll / hold flags */
  scroll?: boolean;
  hold?: boolean;
  /** For FETCH: direction and count */
  direction?:
    | 'NEXT'
    | 'PRIOR'
    | 'FIRST'
    | 'LAST'
    | 'ABSOLUTE'
    | 'RELATIVE'
    | 'FORWARD'
    | 'BACKWARD';
  fetchCount?: number;
}

export type ParsedStatement =
  | SelectStatement
  | InsertStatement
  | UpdateStatement
  | DeleteStatement
  | DDLStatement
  | TransactionStatement
  | PrepareStatement
  | ExecuteStatement
  | DeallocateStatement
  | CursorStatement
  | UnknownStatement;

// ──────────────────────────────────────────────
//  Parser
// ──────────────────────────────────────────────

/**
 * Parse a SQL string into a structured ParsedStatement.
 * Falls back to simple heuristics if AST parsing fails.
 */
export function parseStatement(sql: string): ParsedStatement {
  const trimmed = sql.trim();
  if (!trimmed) {
    return { type: 'UNKNOWN', originalSql: sql };
  }

  // Check AST cache first. For repeated query patterns (e.g. pgbench TPC-B
  // in -M simple mode), cache hit avoids the 250-355µs pgsql-ast-parser call.
  const cached = getCachedAST(sql);
  if (cached) return cached;

  // Fast path: transaction statements are simple
  const upper = trimmed.toUpperCase().replace(/\s+/g, ' ');
  if (upper.startsWith('BEGIN')) {
    return { type: 'TRANSACTION', originalSql: sql, command: 'BEGIN' };
  }
  if (upper.startsWith('COMMIT') || upper.startsWith('END')) {
    return { type: 'TRANSACTION', originalSql: sql, command: 'COMMIT' };
  }
  if (upper.startsWith('ROLLBACK') || upper.startsWith('ABORT')) {
    return { type: 'TRANSACTION', originalSql: sql, command: 'ROLLBACK' };
  }
  if (/^SET\s+TRANSACTION/i.test(upper)) {
    return { type: 'TRANSACTION', originalSql: sql, command: 'SET TRANSACTION' };
  }

  // Fast path: INSERT — use heuristic regex parse instead of pgsql-ast-parser.
  // pgsql-ast-parser.parse() is very slow on multi-VALUES INSERT (~200ms for 100 rows)
  // INSERT routing only needs table name + columns — trivially extractable by regex.
  if (/^\s*INSERT\b/i.test(trimmed)) {
    return parseInsertHeuristic(trimmed);
  }

  // Fast path: CTE (WITH clause) — parse and extract the inner SELECT
  if (/^\s*WITH\b/i.test(trimmed)) {
    return parseWith(trimmed, sql);
  }

  // Use pgsql-ast-parser for all other statements
  try {
    const ast = parse(trimmed);
    if (!ast || ast.length === 0) {
      return { type: 'UNKNOWN', originalSql: sql };
    }

    const stmt = ast[0];

    let parsed: ParsedStatement;

    switch ((stmt as any).type) {
      case 'select':
        parsed = parseSelect(stmt, trimmed);
        break;
      case 'update':
        parsed = parseUpdate(stmt, trimmed);
        break;
      case 'delete':
        parsed = parseDelete(stmt, trimmed);
        break;
      case 'create table':
      case 'create index':
      case 'create schema':
      case 'create sequence':
      case 'create extension':
      case 'create view':
      case 'alter table':
      case 'alter index':
      case 'drop':
      case 'drop table':
      case 'drop index':
      case 'drop view':
      case 'drop schema':
      case 'drop sequence':
      case 'drop extension':
      case 'truncate':
        parsed = parseDDL(stmt as any, trimmed);
        break;
      default:
        // Check if it's a DDL-like statement by looking for CREATE/ALTER/DROP in original
        if (/^\s*(CREATE|ALTER|DROP|TRUNCATE)\b/i.test(trimmed)) {
          parsed = parseDDL(stmt, trimmed);
          break;
        }
        // Check for PREPARE/DEALLOCATE (not fully supported by pgsql-ast-parser;
        // EXECUTE and cursor statements throw and are handled in fallbackParse).
        if (/^\s*PREPARE\s+/i.test(trimmed)) { parsed = parsePrepare(trimmed); break; }
        if (/^\s*DEALLOCATE\s+/i.test(trimmed)) { parsed = parseDeallocate(trimmed); break; }
        parsed = { type: 'UNKNOWN', originalSql: sql };
    }

    // Cache successful AST parse for future template-based lookups
    setCachedAST(sql, parsed);
    return parsed;
  } catch (err: any) {
    // Fallback: use heuristic parsing for robustness
    const fallback = fallbackParse(trimmed);
    if (fallback) {
      setCachedAST(sql, fallback);
    }
    return fallback || { type: 'UNKNOWN', originalSql: sql };
  }
}

// ──────────────────────────────────────────────
//  SELECT parser
// ──────────────────────────────────────────────

function parseSelect(stmt: any, sql: string): SelectStatement {
  const tables = extractSelectTables(stmt);
  const hasJoin = detectJoin(stmt);
  const limit = extractLimit(stmt);
  const orderBy = extractOrderBy(stmt);

  return {
    type: 'SELECT',
    originalSql: sql,
    tables,
    hasJoin,
    // isMultiShard is set by the router based on shard distribution
    isMultiShard: hasJoin && tables.length > 1,
    orderBy,
    limit,
  };
}

function extractSelectTables(stmt: any): string[] {
  const tables: string[] = [];
  if (!stmt.from) return tables;

  for (const fromItem of stmt.from) {
    if (fromItem.type === 'table') {
      const name = fromItem.name?.alias || fromItem.name?.name;
      if (name) tables.push(name);
    } else if (fromItem.type === 'statement' || fromItem.type === 'with') {
      // Subquery in FROM: extract tables from inner SELECT
      const innerTables = extractTablesFromExpr(fromItem);
      tables.push(...innerTables);
    }
  }

  // Extract tables from ANY/ALL/EXISTS subqueries in WHERE clause
  if (stmt.where) {
    tables.push(...extractSubqueryTablesFromExpr(stmt.where));
  }

  return [...new Set(tables)];
}

/**
 * Extract table names from a SELECT/With statement expression.
 */
function extractTablesFromExpr(expr: any): string[] {
  const tables: string[] = [];
  if (!expr || typeof expr !== 'object') return tables;

  // pgsql-ast-parser v12: 'statement' wraps inner SELECT (subquery in FROM)
  if (expr.type === 'statement' && expr.statement) {
    return extractTablesFromExpr(expr.statement);
  }

  // pgsql-ast-parser v12: select = type 'select', from = array
  if (expr.type === 'select' && expr.from) {
    for (const fi of expr.from) {
      if (fi.type === 'table' && fi.name?.name) tables.push(fi.name.name);
      if (fi.type === 'statement') tables.push(...extractTablesFromExpr(fi));
    }
    // Extract tables from subqueries in WHERE clause
    if (expr.where) {
      tables.push(...extractSubqueryTablesFromExpr(expr.where));
    }
  }
  if (expr.type === 'with' && expr.in) {
    tables.push(...extractTablesFromExpr(expr.in));
    if (expr.bind) {
      for (const cte of expr.bind) {
        if (cte.statement) tables.push(...extractTablesFromExpr(cte.statement));
      }
    }
  }
  return tables;
}

/**
 * Walk an arbitrary expression tree looking for ANY/ALL/EXISTS subqueries
 * and extract their table names.
 */
function extractSubqueryTablesFromExpr(expr: any): string[] {
  const tables: string[] = [];
  if (!expr || typeof expr !== 'object') return tables;

  // 1. SELECT/With as a direct expression (EXISTS (SELECT ...))
  if (expr.type === 'select' || expr.type === 'with') {
    tables.push(...extractTablesFromExpr(expr));
  }

  // 2. Function calls: any(...), all(...), exists(...) with subquery args
  if (expr.type === 'call' && expr.args) {
    const fn = String(expr.function?.name || '').toLowerCase();
    if (fn === 'any' || fn === 'all' || fn === 'exists' || fn === 'some') {
      for (const arg of expr.args) {
        tables.push(...extractSubqueryTablesFromExpr(arg));
      }
    }
  }

  // 3. Recurse into binary/unary/ternary expressions
  if (expr.left) tables.push(...extractSubqueryTablesFromExpr(expr.left));
  if (expr.right) tables.push(...extractSubqueryTablesFromExpr(expr.right));
  if (expr.operand) tables.push(...extractSubqueryTablesFromExpr(expr.operand));
  if (expr.value) tables.push(...extractSubqueryTablesFromExpr(expr.value));
  if (expr.args && Array.isArray(expr.args)) {
    for (const arg of expr.args) {
      tables.push(...extractSubqueryTablesFromExpr(arg));
    }
  }
  // CASE expression: pgsql-ast-parser emits `whens: [{ when: <cond>, value: <result> }]`.
  const whenBranches = expr.whens;
  if (whenBranches && Array.isArray(whenBranches)) {
    for (const w of whenBranches) {
      if (w.value) tables.push(...extractSubqueryTablesFromExpr(w.value));
      if (w.when) tables.push(...extractSubqueryTablesFromExpr(w.when));
    }
  }
  if (expr.else) tables.push(...extractSubqueryTablesFromExpr(expr.else));

  return tables;
}

function detectJoin(stmt: any): boolean {
  if (!stmt.from) return false;

  // pgsql-ast-parser v12 flattens JOINs into a `from` array of `{ type: 'table' }`
  // items, so a multi-table FROM (comma- or JOIN-separated) is the join signal.
  if (stmt.from.length > 1) return true;

  return false;
}

function extractLimit(stmt: any): number | undefined {
  // pgsql-ast-parser v12 wraps LIMIT/OFFSET as `stmt.limit = { limit?: {...}, offset?: {...} }`
  // where each node is `{ type: 'integer'|'parameter', value?: number, name?: string }`.
  const limitNode = stmt.limit;
  if (!limitNode) return undefined;

  // v12 shape: { limit: { type: 'integer', value: 10 } }
  const inner = limitNode.limit;
  if (inner && typeof inner.value === 'number') {
    return inner.value;
  }
  // Parameterized LIMIT ($1) has no constant numeric value.
  return undefined;
}

function extractOrderBy(stmt: any): string | undefined {
  if (!stmt.orderBy || stmt.orderBy.length === 0) return undefined;

  // Convert ORDER BY AST back to string
  const parts = stmt.orderBy.map((ob: any) => {
    // pgsql-ast-parser v12 uses `by` field; older versions use `expr`
    const orderExpr = ob.by || ob.expr;
    if (!orderExpr) return '';
    const expr = toSql.expr(orderExpr);
    return ob.type === 'desc' || ob.order === 'DESC' ? `${expr} DESC` : `${expr} ASC`;
  });
  return parts.join(', ');
}

// ──────────────────────────────────────────────
//  INSERT parser
// ──────────────────────────────────────────────
//  INSERT heuristic parser (fast path, no pgsql-ast-parser)
// ──────────────────────────────────────────────

/**
 * Heuristic regex-based INSERT parser.
 * Avoids pgsql-ast-parser which is very slow on multi-VALUES INSERT.
 * Returns the same InsertStatement shape as the AST-based parseInsert().
 */
function parseInsertHeuristic(sql: string): InsertStatement {
  const trimmed = sql.trim();

  // Extract table name: INSERT [INTO] table_name ...
  const tableMatch = trimmed.match(/INSERT\s+(?:INTO\s+)?[`"']?(\w+)[`"']?\s*(?:\(|\bVALUES\b|\bDEFAULT\b)/i);
  const table = tableMatch ? tableMatch[1] : '';

  // Extract column list if present: INSERT INTO t (col1, col2, ...)
  let columns: string[] = [];
  const colsMatch = trimmed.match(/INSERT\s+(?:INTO\s+)?\S+\s*\(([^)]+)\)\s*(?:VALUES|SELECT|DEFAULT)/i);
  if (colsMatch) {
    columns = colsMatch[1].split(',').map(c => c.trim().replace(/[`"']/g, ''));
  }

  // Check for RETURNING clause
  const hasReturning = /\bRETURNING\b/i.test(trimmed);

  // Extract keyColumn/keyValues for shard routing
  let keyColumn: string | undefined;
  let keyValues: string[] | undefined = undefined;

  if (columns.length > 0) {
    // Find id or *_id column
    const idColIndex = columns.findIndex(
      (c) => c === 'id' || c === 'user_id' || c.endsWith('_id'),
    );
    if (idColIndex !== -1) {
      keyColumn = columns[idColIndex];
      // Extract VALUES tuples
      const valuesMatch = trimmed.match(/VALUES\s*(\([^)]+\)(?:\s*,\s*\([^)]+\))*)/i);
      if (valuesMatch) {
        const tuplesStr = valuesMatch[1];
        // Match each tuple: (val1, val2, ...)
        const tupleRegex = /\(([^)]+)\)/g;
        let tupleMatch: RegExpExecArray | null;
        const extracted: string[] = [];
        while ((tupleMatch = tupleRegex.exec(tuplesStr)) !== null) {
          const values = tupleMatch[1].split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''));
          if (values[idColIndex] !== undefined) {
            extracted.push(values[idColIndex]);
          }
        }
        if (extracted.length > 0) {
          keyValues = extracted;
        }
      }
    }
  }

  return {
    type: 'INSERT',
    originalSql: sql,
    table,
    columns,
    hasReturning,
    keyColumn,
    keyValues,
  };
}

// ──────────────────────────────────────────────
//  UPDATE parser
// ──────────────────────────────────────────────

function parseUpdate(stmt: any, sql: string): UpdateStatement {
  const table = stmt.table?.name || '';
  const whereColumns = extractWhereColumns(stmt.where);

  return {
    type: 'UPDATE',
    originalSql: sql,
    table,
    whereColumns,
  };
}

// ──────────────────────────────────────────────
//  DELETE parser
// ──────────────────────────────────────────────

function parseDelete(stmt: any, sql: string): DeleteStatement {
  const table = stmt.from?.name || '';
  const whereColumns = extractWhereColumns(stmt.where);

  return {
    type: 'DELETE',
    originalSql: sql,
    table,
    whereColumns,
  };
}

// ──────────────────────────────────────────────
//  DDL parser (with SERIAL rewrite for I2)
// ──────────────────────────────────────────────

function parseDDL(stmt: any, sql: string): DDLStatement {
  let ddlType: DDLStatement['ddlType'] = 'OTHER';

  switch (stmt.type) {
    case 'create table':
      ddlType = 'CREATE_TABLE';
      break;
    case 'create index':
      ddlType = 'CREATE_INDEX';
      break;
    case 'alter table':
    case 'alter index':
      ddlType = 'ALTER';
      break;
    case 'drop table':
    case 'drop index':
    case 'drop sequence':
      ddlType = 'DROP';
      break;
    // create schema/view/sequence/extension, truncate table, etc. fall through
    // to the default 'OTHER' (no dedicated DDL type is tracked for them).
  }

  const table = extractDDLTable(stmt);
  const rewrittenSql = rewriteSERIAL(stmt, sql);

  return {
    type: 'DDL',
    originalSql: sql,
    rewrittenSql,
    table,
    ddlType,
  };
}

function extractDDLTable(stmt: any): string | undefined {
  if (stmt.name?.name) return stmt.name.name;
  if (stmt.table?.name) return stmt.table.name;
  if (stmt.from?.name) return stmt.from.name;
  // TRUNCATE uses a plural `tables: [{ name }]` array (type 'truncate table').
  if (stmt.tables && stmt.tables.length > 0) return stmt.tables[0].name;
  if (stmt.names && stmt.names.length > 0) return stmt.names[0].name;
  return undefined;
}

/**
 * Rewrite SERIAL data type to INTEGER (SQLite-compatible).
 * Also strips PRIMARY KEY from SERIAL columns because we add AUTOINCREMENT.
 *
 * SQLite doesn't support SERIAL, but supports INTEGER PRIMARY KEY AUTOINCREMENT.
 * SERIAL in PostgreSQL is shorthand for INTEGER NOT NULL PRIMARY KEY.
 */
function rewriteSERIAL(stmt: any, originalSql: string): string | undefined {
  if (stmt.type !== 'create table' || !stmt.columns) {
    return undefined;
  }

  let modified = false;
  for (const col of stmt.columns) {
    if (col.dataType && col.dataType.name && col.dataType.name.toLowerCase() === 'serial') {
      modified = true;
    }
  }

  if (modified) {
    // pgsql-ast-parser's toSql cannot serialize the SQLite-specific
    // AUTOINCREMENT constraint (`{ type: 'autoinc' }` throws NotSupported).
    // Reconstruct via string replacement instead: PostgreSQL SERIAL is
    // semantically `INTEGER NOT NULL` with an implicit sequence, which maps
    // to SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`.
    //
    // If a column is already written `SERIAL PRIMARY KEY`, collapsing to
    // `INTEGER PRIMARY KEY AUTOINCREMENT PRIMARY KEY` would be wrong, so drop
    // any trailing `PRIMARY KEY` that directly follows the SERIAL keyword.
    return originalSql.replace(
      /\bSERIAL\s+PRIMARY\s+KEY\b/gi,
      'INTEGER PRIMARY KEY AUTOINCREMENT',
    ).replace(/\bSERIAL\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
  }

  return undefined;
}

// ──────────────────────────────────────────────
//  PREPARE / EXECUTE / DEALLOCATE parsers
// ──────────────────────────────────────────────

/**
 * Parse a PREPARE statement.
 * Format: PREPARE name [(type1, type2, ...)] AS sql
 */
function parsePrepare(sql: string): PrepareStatement {
  const trimmed = sql.trim();
  const nameMatch = trimmed.match(/^\s*PREPARE\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*AS\s+/i);
  if (!nameMatch) {
    return { type: 'PREPARE', originalSql: sql, name: '', paramTypes: [], innerSql: '' };
  }

  const name = nameMatch[1];
  const paramTypesStr = nameMatch[2] || '';
  const paramTypes = paramTypesStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Everything after "AS " is the inner SQL
  const asIndex = trimmed.toUpperCase().indexOf(' AS ');
  const innerSql = asIndex >= 0 ? trimmed.slice(asIndex + 4).trim() : '';

  return { type: 'PREPARE', originalSql: sql, name, paramTypes, innerSql };
}

/**
 * Parse an EXECUTE statement.
 * Format: EXECUTE name (val1, val2, ...)
 */
function parseExecute(sql: string): ExecuteStatement {
  const trimmed = sql.trim();
  const nameMatch = trimmed.match(/^\s*EXECUTE\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*;?\s*$/i);
  if (!nameMatch) {
    return { type: 'EXECUTE', originalSql: sql, name: '', params: [] };
  }

  const name = nameMatch[1];
  const paramsStr = nameMatch[2] || '';
  const params = parseParamValues(paramsStr);

  return { type: 'EXECUTE', originalSql: sql, name, params };
}

/**
 * Parse a DEALLOCATE statement.
 * Format: DEALLOCATE name | DEALLOCATE ALL
 */
function parseDeallocate(sql: string): DeallocateStatement {
  const trimmed = sql.trim();
  // Match DEALLOCATE [PREPARE] name | DEALLOCATE ALL
  const allMatch = trimmed.match(/^\s*DEALLOCATE\s+(?:PREPARE\s+)?ALL\s*;?\s*$/i);
  if (allMatch) {
    return { type: 'DEALLOCATE', originalSql: sql, name: 'ALL' };
  }

  const nameMatch = trimmed.match(/^\s*DEALLOCATE\s+(?:PREPARE\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i);
  if (!nameMatch) {
    return { type: 'DEALLOCATE', originalSql: sql, name: '' };
  }

  return { type: 'DEALLOCATE', originalSql: sql, name: nameMatch[1] };
}

/**
 * Parse parameter values from a parenthesized list.
 * Handles string literals, numbers, booleans, NULL.
 */
function parseParamValues(paramsStr: string): any[] {
  if (!paramsStr.trim()) return [];

  const params: any[] = [];
  let current = '';
  let inString = false;

  // parseExecute's outer regex `\(([^)]*)\)` stops at the first ')', so paramsStr
  // never contains parentheses; a top-level comma (depth 0) is the separator.
  for (let i = 0; i < paramsStr.length; i++) {
    const ch = paramsStr[i];
    if (inString) {
      current += ch;
      if (ch === "'" && (i + 1 >= paramsStr.length || paramsStr[i + 1] !== "'")) {
        inString = false;
      }
    } else if (ch === "'") {
      current += ch;
      inString = true;
    } else if (ch === ',') {
      params.push(parseSingleParam(current.trim()));
      current = '';
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last) {
    params.push(parseSingleParam(last));
  }

  return params;
}

function parseSingleParam(val: string): any {
  const upper = val.toUpperCase();
  if (upper === 'NULL') return null;
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  if (/^'/.test(val) && /'$/.test(val)) {
    // String literal — unescape doubled single quotes
    return val.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+\.?\d*$/.test(val)) {
    const num = Number(val);
    if (!isNaN(num)) return num;
  }
  return val;
}

// ──────────────────────────────────────────────
//  Cursor statement parser
// ──────────────────────────────────────────────

/**
 * Parse cursor-related statements: DECLARE, FETCH, MOVE, CLOSE.
 */
function parseCursorStmt(sql: string): CursorStatement {
  const trimmed = sql.trim();

  // DECLARE name [SCROLL] [WITHOUT HOLD|WITH HOLD] CURSOR FOR select_sql
  const declareMatch = trimmed.match(
    /^\s*DECLARE\s+([A-Za-z_][A-Za-z0-9_]*)\s*(SCROLL\s+)?(?:CURSOR\s+)?(WITH\s+HOLD\s+|WITHOUT\s+HOLD\s+)?(?:CURSOR\s+)?FOR\s+(.*)$/is,
  );
  if (declareMatch) {
    return {
      type: 'CURSOR',
      originalSql: sql,
      action: 'DECLARE',
      cursorName: declareMatch[1],
      innerSql: declareMatch[4].trim().replace(/;+$/, ''),
      scroll: !!declareMatch[2],
      hold: !!declareMatch[3] && declareMatch[3].toUpperCase().includes('WITH HOLD'),
    };
  }

  // FETCH [direction [count]] FROM cursor
  const fetchMatch = trimmed.match(
    /^\s*FETCH\s+(?:(NEXT|PRIOR|FIRST|LAST|ABSOLUTE|RELATIVE|FORWARD|BACKWARD)\s+(\d+)\s+FROM\s+|(NEXT|PRIOR|FIRST|LAST|ABSOLUTE|RELATIVE|FORWARD|BACKWARD)\s+FROM\s+|FROM\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i,
  );
  if (fetchMatch) {
    const cursorName = fetchMatch[4] || '';
    const direction = (fetchMatch[1] || fetchMatch[3] || 'NEXT').toUpperCase() as CursorStatement['direction'];
    const count = fetchMatch[2] ? parseInt(fetchMatch[2], 10) : 1;
    return {
      type: 'CURSOR',
      originalSql: sql,
      action: 'FETCH',
      cursorName,
      direction: direction as any,
      fetchCount: count,
    };
  }

  // MOVE [direction [count]] [FROM] cursor
  const moveMatch = trimmed.match(
    /^\s*MOVE\s+(?:(NEXT|PRIOR|FIRST|LAST|ABSOLUTE|RELATIVE|FORWARD|BACKWARD)\s+(\d+)\s+(?:FROM\s+)?|(NEXT|PRIOR|FIRST|LAST|ABSOLUTE|RELATIVE|FORWARD|BACKWARD)\s+(?:FROM\s+)?|FROM\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i,
  );
  if (moveMatch) {
    const cursorName = moveMatch[4] || '';
    return {
      type: 'CURSOR',
      originalSql: sql,
      action: 'MOVE',
      cursorName,
      direction: (moveMatch[1] || moveMatch[3] || 'NEXT').toUpperCase() as any,
      fetchCount: moveMatch[2] ? parseInt(moveMatch[2], 10) : 1,
    };
  }

  // CLOSE cursor
  const closeMatch = trimmed.match(
    /^\s*CLOSE\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i,
  );
  if (closeMatch) {
    return {
      type: 'CURSOR',
      originalSql: sql,
      action: 'CLOSE',
      cursorName: closeMatch[1],
    };
  }

  return {
    type: 'CURSOR',
    originalSql: sql,
    action: 'DECLARE',
    cursorName: '',
  };
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

function extractWhereColumns(where: any): string[] | undefined {
  if (!where) return undefined;

  const columns: string[] = [];
  collectRefColumns(where, columns);
  return columns.length > 0 ? [...new Set(columns)] : undefined;
}

function collectRefColumns(expr: any, columns: string[]): void {
  if (!expr || typeof expr !== 'object') return;

  if (expr.type === 'ref' && expr.name && expr.name !== '*') {
    columns.push(expr.name);
  }

  // ── Generic structure walk: left/right (binary), operand (unary), args (call) ──
  // Same pattern as ASTParser.collectRefColumns — handles all expression types
  // without requiring type-specific branches.
  if (expr.left) collectRefColumns(expr.left, columns);
  if (expr.right) collectRefColumns(expr.right, columns);
  if (expr.operand) collectRefColumns(expr.operand, columns);
  if (expr.args && Array.isArray(expr.args)) {
    for (const arg of expr.args) collectRefColumns(arg, columns);
  }

  // Handle select subqueries
  if (expr.where) collectRefColumns(expr.where, columns);
  if (expr.columns && Array.isArray(expr.columns)) {
    for (const col of expr.columns) {
      if (col.expr) collectRefColumns(col.expr, columns);
    }
  }
}
/**
 * Parse a CTE (WITH clause) query by extracting the inner SELECT statement
 * for routing purposes. pgsql-ast-parser returns { type: 'with', bind: [...], in: { type: 'select', ... } }
 */
function parseWith(trimmed: string, sql: string): ParsedStatement {
  try {
    const ast = parse(trimmed);
    const stmt = ast?.[0] as any;
    if (stmt && stmt.type === 'with' && stmt.in?.type === 'select') {
      const main = parseSelect(stmt.in, trimmed);

      // Collect tables referenced inside each CTE definition (stmt.bind). These
      // are real data tables that the main query depends on transitively and
      // must be included for shard routing (isMultiShard / table presence).
      const cteTables: string[] = [];
      if (Array.isArray(stmt.bind)) {
        for (const cte of stmt.bind) {
          if (cte?.statement) {
            cteTables.push(...extractTablesFromExpr(cte.statement));
          }
        }
      }

      return {
        ...main,
        tables: [...new Set([...main.tables, ...cteTables])],
      };
    }
    return { type: 'UNKNOWN', originalSql: sql };
  } catch {
    return { type: 'UNKNOWN', originalSql: sql };
  }
}

/**
 * Fallback heuristic parser when AST parsing fails.
 */
function fallbackParse(sql: string): ParsedStatement {
  const upper = sql.trim().toUpperCase().replace(/\s+/g, ' ');

  if (upper.startsWith('SELECT')) {
    const tables = extractTableNamesHeuristic(sql);
    const hasJoin = /\bJOIN\b/i.test(upper) || /\bFROM\b[\s\S]*?,/i.test(upper);
    return {
      type: 'SELECT',
      originalSql: sql,
      tables,
      hasJoin,
      isMultiShard: hasJoin && tables.length > 1,
    };
  }

  if (upper.startsWith('UPDATE')) {
    const tableMatch = sql.match(/UPDATE\s+`?(\w+)`?/i);
    // Extract WHERE columns via regex when pgsql-ast-parser fails
    const whereMatch = sql.match(/WHERE\s+(?:`?(\w+)`?\s*=\s*[']?(?:\d+|\$\d+)[']?\b)/i);
    return {
      type: 'UPDATE',
      originalSql: sql,
      table: tableMatch?.[1] || '',
      whereColumns: whereMatch ? [whereMatch[1]] : undefined,
    };
  }

  if (upper.startsWith('DELETE')) {
    const tableMatch = sql.match(/DELETE\s+FROM\s+`?(\w+)`?/i);
    const whereMatch = sql.match(/WHERE\s+(?:`?(\w+)`?\s*=\s*[']?(?:\d+|\$\d+)[']?\b)/i);
    return {
      type: 'DELETE',
      originalSql: sql,
      table: tableMatch?.[1] || '',
      whereColumns: whereMatch ? [whereMatch[1]] : undefined,
    };
  }

  if (upper.startsWith('CREATE TABLE')) {
    const tableMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i);
    const rewritten = sql.replace(/\bSERIAL\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
    return {
      type: 'DDL',
      originalSql: sql,
      rewrittenSql: rewritten !== sql ? rewritten : undefined,
      table: tableMatch?.[1],
      ddlType: 'CREATE_TABLE',
    };
  }

  if (upper.startsWith('CREATE VIRTUAL TABLE')) {
    // SQLite FTS5 virtual tables are still tables — extract their name and
    // classify as CREATE_TABLE (not CREATE_INDEX) for correct shard routing.
    const tableMatch = sql.match(/CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i);
    return {
      type: 'DDL',
      originalSql: sql,
      table: tableMatch?.[1],
      ddlType: 'CREATE_TABLE',
    };
  }

  if (upper.startsWith('CREATE INDEX') || upper.startsWith('CREATE VIRTUAL')) {
    return {
      type: 'DDL',
      originalSql: sql,
      ddlType: 'CREATE_INDEX',
    };
  }

  if (upper.startsWith('ALTER')) {
    const tableMatch = sql.match(/ALTER\s+TABLE\s+`?(\w+)`?/i);
    return {
      type: 'DDL',
      originalSql: sql,
      table: tableMatch?.[1],
      ddlType: 'ALTER',
    };
  }

  if (upper.startsWith('DROP')) {
    const tableMatch = sql.match(/DROP\s+(?:TABLE|INDEX|VIEW|SCHEMA|SEQUENCE|EXTENSION)\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/i);
    return {
      type: 'DDL',
      originalSql: sql,
      table: tableMatch?.[1],
      ddlType: 'DROP',
    };
  }

  if (upper.startsWith('PREPARE')) {
    return parsePrepare(sql);
  }

  if (upper.startsWith('EXECUTE')) {
    return parseExecute(sql);
  }

  if (upper.startsWith('DEALLOCATE')) {
    return parseDeallocate(sql);
  }

  if (/^(DECLARE|FETCH|MOVE|CLOSE)\b/i.test(upper)) {
    return parseCursorStmt(sql);
  }

  return { type: 'UNKNOWN', originalSql: sql };
}

function extractTableNamesHeuristic(sql: string): string[] {
  const tables: string[] = [];
  const fromMatch = sql.match(/FROM\s+`?(\w+)`?/i);
  if (fromMatch) tables.push(fromMatch[1]);
  const joinMatches = sql.matchAll(/JOIN\s+`?(\w+)`?\s*/gi);
  for (const match of joinMatches) {
    tables.push(match[1]);
  }

  // Extract tables from subquery FROM clauses within ANY/ALL/EXISTS
  //   col = ANY(SELECT ... FROM tbl ...)
  //   EXISTS(SELECT ... FROM tbl ...)
  const subqueryFromMatches = sql.matchAll(/\(\s*SELECT\s+.+?\s+FROM\s+`?(\w+)`?\s/gi);
  for (const match of subqueryFromMatches) {
    tables.push(match[1]);
  }

  return [...new Set(tables)];
}

/**
 * Serialize a ParsedStatement back to SQL string (for modified statements).
 */
export function serializeStatement(parsed: ParsedStatement): string {
  return parsed.originalSql;
}

export { parse };

// ════════════════════════════════════════════════════════════════
//  Track B5: Window Function Support
// ════════════════════════════════════════════════════════════════

export interface WindowFunction {
  fn: string;
  args?: string[];
  partitionBy?: string[];
  orderBy?: { key: string; dir: 'ASC' | 'DESC' | 'asc' | 'desc' }[];
  frame?: { type: 'ROWS' | 'RANGE'; start: string; end: string };
}

const AGGREGATE_WINDOW_FNS = new Set(['SUM', 'AVG', 'COUNT', 'MIN', 'MAX']);

function isAggregateWindow(fn: string): boolean {
  return AGGREGATE_WINDOW_FNS.has(fn);
}

/**
 * Extract window function definitions from a SQL statement.
 * Uses pgsql-ast-parser for structured extraction, falls back to regex.
 *
 * pgsql-ast-parser v12 AST structure:
 *   - SELECT nodes have `columns` (not `select`)
 *   - Function calls have `type: 'call'`, `function: { name: 'row_number' }`
 *   - OVER has `over: { partitionBy: [...], orderBy: [...] }`
 *   - ORDER BY entries: `{ by: { name: 'col' }, order: 'DESC' }`
 */
export function extractWindowFunctions(sql: string): WindowFunction[] {
  try {
    const ast = parse(sql);
    if (!ast || ast.length === 0) {
      return fallbackExtractWindowFunctions(sql);
    }

    const stmt = ast[0];
    // pgsql-ast-parser v12: use `columns` key, fallback to `select` for compat
    const cols = (stmt as any).columns || (stmt as any).select;
    if (!cols) return fallbackExtractWindowFunctions(sql);

    const result: WindowFunction[] = [];

    for (const col of cols) {
      const wfs = findWindowFunctionsInExpr(col.expr);
      if (wfs) result.push(...wfs);
    }

    return result;
  } catch {
    return fallbackExtractWindowFunctions(sql);
  }
}

function findWindowFunctionsInExpr(expr: any): WindowFunction[] | null {
  if (!expr || typeof expr !== 'object') return null;

  // pgsql-ast-parser v12: type='call' with function.name and over
  if (expr.type === 'call' && expr.over) {
    const fn = String(expr.function?.name || '').toUpperCase();
    if (!fn) return null;

    const wf: WindowFunction = {
      fn,
      args: (expr.args || [])
        .filter((a: any) => a != null)
        .map((a: any) => {
          try { return toSql.expr(a); } catch { return ''; }
        })
        .filter(Boolean),
      partitionBy: extractPartitionBy(expr.over),
      orderBy: extractOverOrderBy(expr.over),
      frame: extractOverFrame(expr.over),
    };
    return [wf];
  }

  // Recurse
  if (expr.left) { const r = findWindowFunctionsInExpr(expr.left); if (r) return r; }
  if (expr.right) { const r = findWindowFunctionsInExpr(expr.right); if (r) return r; }
  // Function call args may nest window functions (e.g. COALESCE(SUM(x) OVER (), ...)).
  if (expr.args && Array.isArray(expr.args)) {
    for (const a of expr.args) { const r = findWindowFunctionsInExpr(a); if (r) return r; }
  }
  // CASE: pgsql-ast-parser emits `whens: [{ when, value }]` plus `else`.
  const branches = expr.whens;
  if (branches) { for (const w of branches) { const r = findWindowFunctionsInExpr(w.value); if (r) return r; } }
  if (expr.else) { const r = findWindowFunctionsInExpr(expr.else); if (r) return r; }

  return null;
}

function extractPartitionBy(over: any): string[] | undefined {
  if (!over || !over.partitionBy || over.partitionBy.length === 0) return undefined;
  return over.partitionBy.map((p: any) => {
    if (p.name) return String(p.name);  // { type: 'ref', name: 'col' }
    try { return toSql.expr(p); } catch { return ''; }
  }).filter(Boolean);
}

function extractOverOrderBy(over: any): WindowFunction['orderBy'] | undefined {
  if (!over || !over.orderBy || over.orderBy.length === 0) return undefined;
  return over.orderBy.map((ob: any) => {
    // v12: { by: { name: 'col' }, order: 'DESC' }
    const key = ob.by?.name
      ? String(ob.by.name)
      : (() => { try { return toSql.expr(ob.by); } catch { return ''; } })();
    return { key, dir: (ob.order === 'DESC' ? 'DESC' : 'ASC') as 'ASC' | 'DESC' };
  });
}

function extractOverFrame(over: any): WindowFunction['frame'] | undefined {
  // pgsql-ast-parser v12 rejects ROWS/RANGE frame clauses outright (throws on
  // parse), so `over.frame` is never populated; window frames are therefore
  // unavailable in the AST path and always resolve to undefined.
  return undefined;
}

function fallbackExtractWindowFunctions(sql: string): WindowFunction[] {
  const results: WindowFunction[] = [];
  const windowPattern = /(\w+)\s*\(([^)]*)\)\s*OVER\s*\(([^)]*)\)/gi;
  let match;

  while ((match = windowPattern.exec(sql)) !== null) {
    const fn = match[1].toUpperCase();
    const args = match[2]
      ? match[2].split(',').map((a: string) => a.trim()).filter(Boolean)
      : [];
    const overClause = match[3];

    const partitionBy: string[] = [];
    const orderBy: { key: string; dir: 'ASC' | 'DESC' | 'asc' | 'desc' }[] = [];

    const partitionMatch = overClause.match(
      /PARTITION\s+BY\s+(.*?)(?:\s+ORDER\s+BY\s+|$)/i,
    );
    if (partitionMatch) {
      partitionBy.push(
        ...partitionMatch[1].split(',').map((s: string) => s.trim()),
      );
    }

    // Stop at a window frame clause (ROWS/RANGE); pgsql-ast-parser throws on
    // those and routes here, but the frame must not pollute the orderBy key.
    const orderMatch = overClause.match(/ORDER\s+BY\s+(.*?)(?:\s+(?:ROWS|RANGE)\b|$)/i);
    if (orderMatch) {
      orderMatch[1].split(',').forEach((s: string) => {
        const trimmed = s.trim();
        const isDesc = /\bDESC\b/i.test(trimmed);
        const key = trimmed.replace(/\s+(ASC|DESC)$/i, '').trim();
        orderBy.push({ key, dir: isDesc ? 'DESC' : 'ASC' });
      });
    }

    results.push({
      fn,
      args: args.length > 0 ? args : undefined,
      partitionBy: partitionBy.length > 0 ? partitionBy : undefined,
      orderBy: orderBy.length > 0 ? orderBy : undefined,
    });
  }

  return results;
}

/**
 * Rewrite SQL to make window functions compatible with distributed execution.
 *
 * - Aggregate window functions (SUM, AVG, COUNT, MIN, MAX):
 *   strip the OVER clause, turning them into plain aggregate functions.
 * - Ranking window functions (ROW_NUMBER, RANK, DENSE_RANK):
 *   keep the OVER clause for shard-local execution.
 */
export function rewriteWindowSql(sql: string): string {
  try {
    const ast = parse(sql);
    if (!ast || ast.length === 0) return sql;

    const stmt = ast[0];
    const cols = (stmt as any).columns || (stmt as any).select;
    if (!cols) return sql;

    let modified = false;

    function stripOver(expr: any): void {
      if (!expr || typeof expr !== 'object') return;
      if (expr.type === 'call' && expr.function && expr.over) {
        const fn = String(expr.function.name || '').toUpperCase();
        if (isAggregateWindow(fn)) {
          delete expr.over;
          modified = true;
        }
      }
      if (expr.left) stripOver(expr.left);
      if (expr.right) stripOver(expr.right);
      // Function call args may nest window functions.
      if (expr.args && Array.isArray(expr.args)) {
        for (const a of expr.args) stripOver(a);
      }
      // CASE: pgsql-ast-parser emits `whens: [{ when, value }]` plus `else`.
      const branches = expr.whens;
      if (branches && Array.isArray(branches)) {
        for (const w of branches) stripOver(w.value);
      }
      if (expr.else) stripOver(expr.else);
    }

    for (const col of cols) {
      stripOver(col.expr);
    }

    if (modified) {
      try {
        const result = toSql.statement(stmt);
        return result;
      } catch {
        // Fallback: string-level replacement
        return sql.replace(
          /(\b(SUM|AVG|COUNT|MIN|MAX)\s*\([^)]*\))\s*OVER\s*\([^)]*\)/gi,
          '$1',
        );
      }
    }

    return sql;
  } catch {
    return sql;
  }
}

// ════════════════════════════════════════════════════════════════
//  Track B5: CTE (WITH clause) Support
// ════════════════════════════════════════════════════════════════

export interface CteDefinition {
  name: string;
  columns?: string[];
  query: string;
  recursive: boolean;
}

/**
 * Extract CTE definitions from a SQL WITH clause.
 *
 * pgsql-ast-parser v12 CTE AST structure:
 *   { type: 'with', bind: [{ alias: { name: 'cte_name' }, statement: {...} }], in: {...} }
 * Note: The root statement type is 'with', not 'select'.
 */
export function extractCtes(sql: string): CteDefinition[] {
  // First: detect RECURSIVE via string pattern (parser doesn't support it)
  const isRecursive = /^\s*WITH\s+RECURSIVE\b/i.test(sql);

  try {
    const ast = parse(sql);
    if (!ast || ast.length === 0) return [];

    const stmt = ast[0];

    // pgsql-ast-parser v12: root type = 'with', bind = CTE array, in = main query
    if (stmt.type === 'with' && stmt.bind) {
      const ctes: CteDefinition[] = stmt.bind.map((cte: any) => {
        const cteName = cte.alias?.name || '';
        // Serialize the CTE statement back to SQL
        let queryStr = '';
        try {
          queryStr = toSql.statement(cte.statement);
        } catch {
          queryStr = '<unserializable>';
        }
        return {
          name: cteName,
          columns: undefined, // column aliases not available in v12 bind
          query: queryStr,
          recursive: isRecursive,
        };
      });
      return ctes;
    }

    return [];
  } catch {
    return fallbackExtractCtes(sql, isRecursive);
  }
}

function fallbackExtractCtes(sql: string, knownRecursive = false): CteDefinition[] {
  const ctes: CteDefinition[] = [];

  // Match WITH clause (RECURSIVE may or may not be present)
  // Strategy: find CTE definitions like "name [(cols)] AS (subquery)"
  const ctePattern = /(\w+)\s*(?:\(([^)]*)\))?\s*AS\s*\(([^)]*)\)\s*(,|$|SELECT)/gi;
  let match;

  while ((match = ctePattern.exec(sql)) !== null) {
    ctes.push({
      name: match[1],
      columns: match[2]
        ? match[2].split(',').map((s: string) => s.trim())
        : undefined,
      query: match[3].trim(),
      recursive: knownRecursive,
    });
  }

  return ctes;
}

/**
 * Inline non-recursive CTEs as subqueries.
 * For recursive CTEs, throws a descriptive Error.
 */
export function inlineCtes(sql: string): string {
  const ctes = extractCtes(sql);
  if (ctes.length === 0) return sql;

  // Check for recursive CTEs
  const recursiveCte = ctes.find((cte) => cte.recursive);
  if (recursiveCte) {
    throw new Error(
      `Recursive CTE '${recursiveCte.name}' is not supported in distributed mode. ` +
        `Please rewrite the query without a recursive CTE.`,
    );
  }

  // Strategy: rebuild the SQL without the WITH clause
  // Remove "WITH cte_name AS (subquery), ..." from the front
  let result = sql.replace(/^\s*WITH\s+/i, '');
  result = result.replace(/\bRECURSIVE\s+/i, '');

  // Remove each CTE definition and trailing comma
  for (const cte of ctes) {
    const escName = cte.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const colMatch = cte.columns
      ? `\\s*\\(${cte.columns.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*,\\s*')}\\)`
      : '';
    // Match: "cte_name [(cols)] AS (subquery), " (with optional trailing comma)
    const pattern = new RegExp(
      `${escName}${colMatch}\\s*AS\\s*\\([^)]*\\)\\s*,?\\s*`,
      'i',
    );
    result = result.replace(pattern, '');
  }

  // Replace CTE name references in FROM/JOIN with subquery
  for (const cte of ctes) {
    const escName = cte.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // FROM cte_name → FROM (cte_query) AS cte_name
    result = result.replace(
      new RegExp(`\\bFROM\\s+${escName}\\b`, 'i'),
      `FROM (${cte.query}) AS ${cte.name}`,
    );

    // JOIN cte_name → JOIN (cte_query) AS cte_name
    result = result.replace(
      new RegExp(`\\bJOIN\\s+${escName}\\b`, 'i'),
      `JOIN (${cte.query}) AS ${cte.name}`,
    );

    // Comma-separated FROM: , cte_name → , (cte_query) AS cte_name
    result = result.replace(
      new RegExp(`,\\s*${escName}\\b`, 'i'),
      `, (${cte.query}) AS ${cte.name}`,
    );
  }

  return result;
}

// ════════════════════════════════════════════════════════════════
//  Track B5: Full-Text Search Support
// ════════════════════════════════════════════════════════════════

export interface FTSConfig {
  hasFts: boolean;
  configName?: string;
  column?: string;
  queryText?: string;
  operator: '@@' | 'match';
}

/**
 * Detect PostgreSQL full-text search patterns in a SQL query.
 *
 * Detects:
 * - @@ operator: col @@ to_tsquery('...')
 * - to_tsvector() / to_tsquery() functions
 * - plainto_tsquery / phraseto_tsquery
 */
export function detectFTS(sql: string): FTSConfig {
  const upper = sql.toUpperCase();

  // Detect @@ operator (PostgreSQL FTS)
  if (sql.includes('@@')) {
    const tsvectorMatch = sql.match(/to_tsvector\s*\(\s*(?:'(\w+)'\s*,)?\s*(\w+)/i);
    const tsqueryMatch = sql.match(/to_tsquery\s*\(\s*(?:'(\w+)'\s*,)?\s*'([^']+)'/i);
    const plaintoMatch = sql.match(/plainto_tsquery\s*\(\s*(?:'(\w+)'\s*,)?\s*'([^']+)'/i);
    const phrasetoMatch = sql.match(/phraseto_tsquery\s*\(\s*(?:'(\w+)'\s*,)?\s*'([^']+)'/i);

    // Column may be a bare identifier on the left of `@@` (`col @@ to_tsquery(...)`)
    // rather than inside to_tsvector(...). Extract it when tsvectorMatch missed.
    const bareColumnMatch = sql.match(/(\w+)\s*@@/i);

    if (plaintoMatch) {
      return {
        hasFts: true,
        configName: plaintoMatch[1] || 'english',
        column: tsvectorMatch?.[2] || bareColumnMatch?.[1] || undefined,
        queryText: plaintoMatch[2],
        operator: '@@',
      };
    }

    if (phrasetoMatch) {
      return {
        hasFts: true,
        configName: phrasetoMatch[1] || 'english',
        column: tsvectorMatch?.[2] || bareColumnMatch?.[1] || undefined,
        queryText: phrasetoMatch[2],
        operator: '@@',
      };
    }

    if (tsqueryMatch) {
      return {
        hasFts: true,
        configName: tsqueryMatch[1] || 'english',
        column: tsvectorMatch?.[2] || bareColumnMatch?.[1] || undefined,
        queryText: tsqueryMatch[2],
        operator: '@@',
      };
    }

    // @@ detected but couldn't parse details
    return {
      hasFts: true,
      operator: '@@',
    };
  }

  // Detect FTS functions without @@
  const hasTsvector = /\bto_tsvector\s*\(/i.test(upper);
  const hasTsquery = /\bto_tsquery\s*\(/i.test(upper);

  if (hasTsvector || hasTsquery) {
    const configMatch = sql.match(/to_tsvector\s*\(\s*'(\w+)'/i);
    return {
      hasFts: true,
      configName: configMatch?.[1] || 'english',
      operator: '@@',
    };
  }

  return { hasFts: false, operator: '@@' };
}

/**
 * Rewrite PostgreSQL FTS syntax to SQLite FTS5 equivalent.
 */
export function rewriteFTS(sql: string): string {
  const fts = detectFTS(sql);
  if (!fts.hasFts) return sql;

  if (fts.column && fts.queryText) {
    // Rewrite to SQLite FTS5 MATCH. Match the left side either as a
    // to_tsvector(...) call or as a bare column identifier (`col @@ ...`),
    // and the right side as a plainto/phraseto/to_tsquery(...) call.
    const left = `(?:(?:to_tsvector\\s*\\([^)]*\\))|'?(?:${fts.column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})'?)\\s*`;
    const right = '(?:plainto_tsquery|phraseto_tsquery|to_tsquery)\\s*\\([^)]*\\)';
    const re = new RegExp(`${left}@@\\s*${right}`, 'gi');
    return sql.replace(re, `${fts.column} MATCH '${fts.queryText.replace(/'/g, "''")}'`);
  }

  // Generic replacement: convert @@ to MATCH
  if (sql.includes('@@')) {
    return sql.replace(/@@/g, 'MATCH');
  }

  return sql;
}
