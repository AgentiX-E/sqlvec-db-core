/**
 * ASTParser — Wrapper around pgsql-ast-parser for SQL parsing
 *
 * Provides a clean API over the raw pgsql-ast-parser library:
 *  - parse(sql) → ParsedStatement | null
 *  - getStatementType(sql) → statement type string
 *  - extractTableName(stmt) → table name | null
 *  - extractWhereClause(stmt) → WHERE clause string | null
 *
 * Includes error position (line/col) information and regex fallback
 * for edge cases that the PG parser cannot handle.
 */

import { parse, toSql } from 'pgsql-ast-parser';

// ── Re-export SqlParser types for downstream compatibility ──────
export type {
  ParsedStatement,
  SelectStatement,
  InsertStatement,
  UpdateStatement,
  DeleteStatement,
  DDLStatement,
  TransactionStatement,
  PrepareStatement,
  ExecuteStatement,
  DeallocateStatement,
  CursorStatement,
  UnknownStatement,
} from './SqlParser';

// ── Error types ────────────────────────────────────────────────

export interface ParseErrorInfo {
  message: string;
  line: number;
  col: number;
  offset: number;
}

export class SQLParseError extends Error {
  public readonly line: number;
  public readonly col: number;
  public readonly offset: number;

  constructor(info: ParseErrorInfo) {
    super(info.message);
    this.name = 'SQLParseError';
    this.line = info.line;
    this.col = info.col;
    this.offset = info.offset;
  }

  /**
   * Create a human-readable error message with position info.
   */
  toFormattedMessage(sql: string): string {
    const lines = sql.split('\n');
    const line = Math.min(this.line, lines.length);
    const lineContent = lines[line - 1] || '';
    const pointer = ' '.repeat(Math.max(0, this.col - 1)) + '^';
    return [
      `Syntax error at line ${line} col ${this.col}:`,
      '',
      `${line}  ${lineContent}`,
      `    ${pointer}`,
      '',
      this.message,
    ].join('\n');
  }
}

// ── Parsed result type ─────────────────────────────────────────

export interface ASTParseResult {
  /** The parsed statement (null if parsing failed entirely). */
  statement: import('./SqlParser').ParsedStatement | null;
  /** Error info if parsing failed (null on success). */
  error: ParseErrorInfo | null;
  /** The original SQL string. */
  sql: string;
  /** Whether the AST parser was used (vs regex fallback). */
  usedAST: boolean;
}

// ── Parser ─────────────────────────────────────────────────────

/**
 * Parse a SQL string into a typed ParsedStatement.
 * Uses pgsql-ast-parser for structured AST, falls back to regex.
 * Returns null only if both AST and regex fallback fail.
 */
export function parseSQL(sql: string): ASTParseResult {
  const trimmed = sql.trim();
  if (!trimmed) {
    return { statement: null, error: null, sql, usedAST: false };
  }

  try {
    const ast = parse(trimmed);
    /* istanbul ignore next -- pgsql-ast-parser never returns an empty array; an
       empty input throws instead of producing zero statements */
    if (!ast || ast.length === 0) {
      // Fallback to regex
      return {
        statement: fallbackParse(trimmed) as any,
        error: null,
        sql,
        usedAST: false,
      };
    }

    const stmt = ast[0];
    const parsed = astToParsedStatement(stmt, trimmed);
    return { statement: parsed, error: null, sql, usedAST: true };
  /* v8 ignore next -- catch is defensive fallback */
  } catch (err: any) {
    // Extract position info from pgsql-ast-parser errors
    const errorInfo = extractErrorInfo(err, trimmed);
    // Fallback to regex on AST failure
    const fallback = fallbackParse(trimmed);
    /* istanbul ignore else -- fallbackParse returns a non-null UNKNOWN statement
       for any non-empty input, so the null-return branch is unreachable */
    if (fallback) {
      return {
        statement: fallback as any,
        error: errorInfo,
        sql,
        usedAST: false,
      };
    } else {
      return { statement: null, error: errorInfo, sql, usedAST: false };
    }
  }
}

/**
 * Get the statement type string from raw SQL.
 * Avoids full AST parse when only type is needed.
 */
export function getStatementType(sql: string): 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'ALTER' | 'DROP' | 'UNKNOWN' {
  const trimmed = sql.trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^SELECT\b/i.test(trimmed)) return 'SELECT';
  if (/^INSERT\b/i.test(trimmed)) return 'INSERT';
  if (/^UPDATE\b/i.test(trimmed)) return 'UPDATE';
  if (/^DELETE\b/i.test(trimmed)) return 'DELETE';
  if (/^CREATE\b/i.test(trimmed)) return 'CREATE';
  if (/^ALTER\b/i.test(trimmed)) return 'ALTER';
  if (/^DROP\b/i.test(trimmed)) return 'DROP';
  return 'UNKNOWN';
}

/**
 * Extract table name from a parsed statement.
 * Returns null if no table name can be determined.
 */
export function extractTableName(stmt: import('./SqlParser').ParsedStatement): string | null {
  if (!stmt) return null;
  switch (stmt.type) {
    case 'SELECT':
      return stmt.tables.length > 0 ? stmt.tables[0] : null;
    case 'INSERT':
      return stmt.table || null;
    case 'UPDATE':
      return stmt.table || null;
    case 'DELETE':
      return stmt.table || null;
    case 'DDL':
      return stmt.table || null;
    default:
      return null;
  }
}

/**
 * Extract the WHERE clause from a parsed statement as a SQL string.
 * Re-serializes the WHERE expression back to SQL string.
 * Returns null if no WHERE clause exists or it cannot be serialized.
 */
export function extractWhereClause(stmt: import('./SqlParser').ParsedStatement): string | null {
  if (!stmt) return null;

  // For SELECT/UPDATE/DELETE, try to reconstruct WHERE from the original SQL
  // pgsql-ast-parser doesn't directly expose the WHERE clause AST node as text,
  // so we extract it via string matching on the original SQL
  const sql = (stmt as any).originalSql;
  if (!sql || typeof sql !== 'string') return null;

  const whereMatch = sql.match(/\bWHERE\b\s+(.+?)(?:\s+(?:ORDER\s+BY|LIMIT|GROUP\s+BY|HAVING|WINDOW|FETCH|FOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE))|$)/is);
  if (whereMatch) {
    return whereMatch[1].trim();
  }

  return null;
}

// ── Internal helpers ──────────────────────────────────────────

/**
 * Convert a pgsql-ast-parser AST statement node to a SqlParser-style ParsedStatement.
 */
function astToParsedStatement(astStmt: any, sql: string): import('./SqlParser').ParsedStatement {
  switch (astStmt.type) {
    case 'select':
      return selectToParsed(astStmt, sql);
    case 'insert':
      return insertToParsed(astStmt, sql);
    case 'update':
      return updateToParsed(astStmt, sql);
    case 'delete':
      return deleteToParsed(astStmt, sql);
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
    case 'truncate table':
    case 'truncate':
      return ddlToParsed(astStmt, sql);
    case 'prepare':
      return prepareToParsed(astStmt, sql);
    default:
      return { type: 'UNKNOWN', originalSql: sql };
  }
}

function selectToParsed(stmt: any, sql: string): import('./SqlParser').SelectStatement {
  const tables = extractSelectTables(stmt);
  const hasJoin = detectJoin(stmt);
  return {
    type: 'SELECT',
    originalSql: sql,
    tables,
    hasJoin,
    isMultiShard: hasJoin && tables.length > 1,
    orderBy: extractOrderBy(stmt),
    limit: extractLimit(stmt),
  };
}

function insertToParsed(stmt: any, sql: string): import('./SqlParser').InsertStatement {
  /* istanbul ignore next -- `into` is always present on a parsed insert */
  const table = stmt.into?.name || '';
  /* istanbul ignore next -- `columns` is always an array on a parsed insert */
  const columns = (stmt.columns || []).map((c: any) => c.name);
  const hasReturning = !!stmt.returning && stmt.returning.length > 0;
  const { keyColumn, keyValues } = extractInsertKeys(stmt, columns);
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

function updateToParsed(stmt: any, sql: string): import('./SqlParser').UpdateStatement {
  /* istanbul ignore next -- `table` is always present on a parsed update */
  const table = stmt.table?.name || '';
  const whereColumns = extractWhereRefColumns(stmt.where);
  return {
    type: 'UPDATE',
    originalSql: sql,
    table,
    whereColumns,
  };
}

function deleteToParsed(stmt: any, sql: string): import('./SqlParser').DeleteStatement {
  /* istanbul ignore next -- `from` is always present on a parsed delete */
  const table = stmt.from?.name || '';
  const whereColumns = extractWhereRefColumns(stmt.where);
  return {
    type: 'DELETE',
    originalSql: sql,
    table,
    whereColumns,
  };
}

function ddlToParsed(stmt: any, sql: string): import('./SqlParser').DDLStatement {
  let ddlType: import('./SqlParser').DDLStatement['ddlType'] = 'OTHER';
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
    case 'drop':
    case 'drop table':
    case 'drop index':
    case 'drop view':
    case 'drop schema':
    case 'drop sequence':
    case 'drop extension':
      ddlType = 'DROP';
      break;
    case 'truncate table':
    case 'truncate':
      ddlType = 'TRUNCATE' as any;
      break;
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

function extractSelectTables(stmt: any): string[] {
  const tables: string[] = [];
  if (!stmt.from) return tables;
  for (const fromItem of stmt.from) {
    if (fromItem.type === 'table') {
      // Use the real table name (not the alias). The `tables` list is consumed
      // by downstream routing, which indexes metadata by real table name;
      // extracting an alias (e.g. `FROM users AS u` → "u") would break that.
      const name = fromItem.name?.name;
      if (name) tables.push(name);
    }
    // pgsql-ast-parser v12 attaches a JOIN as a `join` property on the second
    // from entry (e.g. `FROM t1 JOIN t2 ON ...` → t2 has `join: { type, on }`).
    // The legacy `join.table` and `joins` array shapes below are unreachable
    // defensive compatibility for older parser formats.
    /* istanbul ignore next */
    if (fromItem.join && fromItem.join.table?.name) {
      tables.push(fromItem.join.table.name);
    }
    // Also check the older joins array format for forward compatibility.
    /* istanbul ignore next */
    if (fromItem.joins) {
      for (const join of fromItem.joins) {
        if (join.table?.name) tables.push(join.table.name);
      }
    }
  }
  return [...new Set(tables)];
}

function detectJoin(stmt: any): boolean {
  if (!stmt.from) return false;
  for (const fromItem of stmt.from) {
    /* istanbul ignore next -- legacy `type === 'join'` shape is not produced by
       pgsql-ast-parser v12 (joins appear as a `join` prop on a table entry) */
    if (fromItem.type === 'join') return true;
    /* istanbul ignore next -- legacy `joins` array shape (see above) */
    if (fromItem.joins && fromItem.joins.length > 0) return true;
    if (fromItem.join) return true;
  }
  return stmt.from.length > 1;
}

function extractLimit(stmt: any): number | undefined {
  // pgsql-ast-parser v12 wraps LIMIT as `stmt.limit = { limit?: { type, value } }`.
  const limitNode = stmt.limit;
  if (!limitNode) return undefined;
  const inner = limitNode.limit;
  if (inner && typeof inner.value === 'number') return inner.value;
  // Parameterized LIMIT ($1) has no constant numeric value.
  return undefined;
}

function extractOrderBy(stmt: any): string | undefined {
  if (!stmt.orderBy || stmt.orderBy.length === 0) return undefined;
  const parts = stmt.orderBy.map((ob: any) => {
    try {
      // v12 exposes { by: { name }, order: 'ASC' | 'DESC' }.
      const expr = toSql.expr(ob.by);
      return ob.order === 'DESC' ? `${expr} DESC` : `${expr} ASC`;
  /* v8 ignore next -- catch is defensive fallback */
    } catch {
      return '';
    }
  }).filter(Boolean);
  /* istanbul ignore next -- orderBy is non-empty here, so at least one part
     survives the mapping and parts.length > 0 always holds */
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function extractInsertKeys(stmt: any, columns: string[]): { keyColumn?: string; keyValues?: any[] } {
  const idColIndex = columns.findIndex(
    (c: string) => c === 'id' || c.endsWith('_id') || c.toLowerCase() === 'user_id',
  );
  if (idColIndex === -1) return {};
  const keyColumn = columns[idColIndex];
  const insert = stmt.insert;
  if (insert?.type === 'values' && insert.values && insert.values.length > 0) {
    const keyValues: any[] = [];
    for (const row of insert.values) {
      if (row && row[idColIndex] !== undefined) {
        const val = row[idColIndex];
        if (val && val.type === 'integer') keyValues.push(String(val.value));
        else if (val && val.value !== undefined) keyValues.push(String(val.value));
        else keyValues.push(String(val));
      }
    }
    return { keyColumn, keyValues: keyValues.length > 0 ? keyValues : undefined };
  }
  return { keyColumn };
}

function extractWhereRefColumns(where: any): string[] | undefined {
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
  if (expr.left) collectRefColumns(expr.left, columns);
  if (expr.right) collectRefColumns(expr.right, columns);
  if (expr.operand) collectRefColumns(expr.operand, columns);
  if (expr.args && Array.isArray(expr.args)) {
    for (const arg of expr.args) collectRefColumns(arg, columns);
  }
}

function extractDDLTable(stmt: any): string | undefined {
  if (stmt.name?.name) return stmt.name.name;
  if (stmt.table?.name) return stmt.table.name;
  // TRUNCATE uses a plural `tables: [{ name }]` array (type 'truncate table').
  if (stmt.tables && stmt.tables.length > 0) return stmt.tables[0].name;
  if (stmt.names && stmt.names.length > 0) return stmt.names[0].name;
  return undefined;
}

function prepareToParsed(stmt: any, sql: string): import('./SqlParser').ParsedStatement {
  // pgsql-ast-parser v12 exposes `{ name: { name }, statement: <inner AST> }`.
  /* istanbul ignore next -- `name` is always present on a parsed prepare */
  const name = stmt.name?.name || '';
  /* istanbul ignore next -- a parsed prepare always carries an inner statement */
  const innerSql = stmt.statement ? toSql.statement(stmt.statement) : sql;
  return {
    type: 'PREPARE' as any,
    originalSql: sql,
    name: String(name),
    paramTypes: [],
    innerSql,
  };
}

function rewriteSERIAL(stmt: any, originalSql: string): string | undefined {
  if (stmt.type !== 'create table' || !stmt.columns) return undefined;

  let hasSerial = false;
  for (const col of stmt.columns) {
    if (col.dataType && col.dataType.name && col.dataType.name.toLowerCase() === 'serial') {
      hasSerial = true;
      break;
    }
  }
  if (!hasSerial) return undefined;

  // pgsql-ast-parser's toSql cannot serialize the SQLite-specific AUTOINCREMENT
  // constraint (`{ type: 'autoinc' }` throws NotSupported / is silently dropped),
  // so reconstruct via string replacement instead — matching SqlParser.rewriteSERIAL.
  // PostgreSQL SERIAL is semantically `INTEGER NOT NULL` with an implicit
  // sequence, which maps to SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`. A column
  // written `SERIAL PRIMARY KEY` collapses to a single AUTOINCREMENT clause.
  return originalSql
    .replace(/\bSERIAL\s+PRIMARY\s+KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/\bSERIAL\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
}

/**
 * Extract error position info from a pgsql-ast-parser error.
 */
function extractErrorInfo(err: any, sql: string): ParseErrorInfo {
  // Default position
  let line = 1;
  let col = 1;
  let offset = 0;
  /* istanbul ignore next -- pgsql always throws an Error with a non-empty
     message; the `|| 'Unknown parse error'` fallback is defensive only */
  const message = err?.message || 'Unknown parse error';

  // pgsql-ast-parser throws a plain Error whose `message` embeds the position
  // as "Syntax error at line <N> col <M>: ..."; it does NOT expose structured
  // token/offset properties. Parse the position out of the message text.
  const posMatch = message.match(/\bline\s+(\d+)\s+col\s+(\d+)\b/i);
  if (posMatch) {
    line = parseInt(posMatch[1], 10);
    col = parseInt(posMatch[2], 10);
    // Compute a 0-based character offset from the reported line/col.
    const lines = sql.split('\n');
    let acc = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) {
      acc += lines[i].length + 1; // +1 for the newline
    }
    offset = acc + (col - 1);
  }

  // Clean up the error message to just the first line
  const firstLine = message.split('\n')[0];

  return {
    message: firstLine.trim(),
    line,
    col,
    offset,
  };
}

// ── Fallback parse (regex-based) ───────────────────────────────

function fallbackParse(sql: string): import('./SqlParser').ParsedStatement | null {
  const trimmed = sql.trim();
  /* istanbul ignore next -- parseSQL guards non-empty input before ever
     calling fallbackParse, so an empty/whitespace input never reaches here */
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase().replace(/\s+/g, ' ');

  if (upper.startsWith('SELECT')) {
    const tables = extractTableNamesHeuristic(sql);
    const hasJoin = /\bJOIN\b/i.test(upper);
    return {
      type: 'SELECT',
      originalSql: sql,
      tables,
      hasJoin,
      isMultiShard: hasJoin && tables.length > 1,
    } as import('./SqlParser').SelectStatement;
  }

  if (upper.startsWith('INSERT')) {
    // Match against `trimmed` (not `upper`) so the extracted table name keeps
    // its original casing, consistent with extractTableNamesHeuristic.
    const tableMatch = trimmed.match(/INSERT\s+INTO\s+`?(\w+)`?/i);
    return {
      type: 'INSERT',
      originalSql: sql,
      table: tableMatch?.[1] || '',
      columns: [],
      hasReturning: /\bRETURNING\b/i.test(upper),
    } as import('./SqlParser').InsertStatement;
  }

  if (upper.startsWith('UPDATE')) {
    const tableMatch = trimmed.match(/UPDATE\s+`?(\w+)`?/i);
    return {
      type: 'UPDATE',
      originalSql: sql,
      /* istanbul ignore next -- an UPDATE always names a table, so tableMatch is
         always non-null here */
      table: tableMatch?.[1] || '',
    } as import('./SqlParser').UpdateStatement;
  }

  if (upper.startsWith('DELETE')) {
    const tableMatch = trimmed.match(/DELETE\s+FROM\s+`?(\w+)`?/i);
    return {
      type: 'DELETE',
      originalSql: sql,
      table: tableMatch?.[1] || '',
    } as import('./SqlParser').DeleteStatement;
  }

  if (upper.startsWith('CREATE TABLE')) {
    const tableMatch = trimmed.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i);
    const rewritten = sql.replace(/\bSERIAL\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
    return {
      type: 'DDL',
      originalSql: sql,
      /* istanbul ignore next -- the undefined side covers the no-SERIAL case,
         which the AST path already handles without reaching this fallback */
      rewrittenSql: rewritten !== sql ? rewritten : undefined,
      table: tableMatch?.[1],
      ddlType: 'CREATE_TABLE',
    } as import('./SqlParser').DDLStatement;
  }

  if (upper.startsWith('CREATE INDEX') || upper.startsWith('CREATE VIRTUAL')) {
    return {
      type: 'DDL',
      originalSql: sql,
      ddlType: 'CREATE_INDEX',
    } as import('./SqlParser').DDLStatement;
  }

  if (upper.startsWith('ALTER')) {
    const tableMatch = trimmed.match(/ALTER\s+TABLE\s+`?(\w+)`?/i);
    return {
      type: 'DDL',
      originalSql: sql,
      table: tableMatch?.[1],
      ddlType: 'ALTER',
    } as import('./SqlParser').DDLStatement;
  }

  if (upper.startsWith('DROP')) {
    const tableMatch = trimmed.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/i);
    return {
      type: 'DDL',
      originalSql: sql,
      /* istanbul ignore next -- the DROP TABLE shape always names a table, so
         tableMatch is always non-null here */
      table: tableMatch?.[1],
      ddlType: 'DROP',
    } as import('./SqlParser').DDLStatement;
  }

  if (upper.startsWith('PREPARE')) return { type: 'PREPARE', originalSql: sql, name: '', paramTypes: [], innerSql: '' } as any;
  if (upper.startsWith('EXECUTE')) return { type: 'EXECUTE', originalSql: sql, name: '', params: [] } as any;
  if (upper.startsWith('DEALLOCATE')) return { type: 'DEALLOCATE', originalSql: sql, name: '' } as any;

  return { type: 'UNKNOWN', originalSql: sql };
}

function extractTableNamesHeuristic(sql: string): string[] {
  const tables: string[] = [];
  const fromMatch = sql.match(/FROM\s+`?(\w+)`?/i);
  if (fromMatch) tables.push(fromMatch[1]);
  const joinMatches = sql.matchAll(/JOIN\s+`?(\w+)`?\s*/gi);
  for (const match of joinMatches) tables.push(match[1]);
  return [...new Set(tables)];
}
