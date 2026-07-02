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
  } catch (err: any) {
    // Extract position info from pgsql-ast-parser errors
    const errorInfo = extractErrorInfo(err, trimmed);
    // Fallback to regex on AST failure
    const fallback = fallbackParse(trimmed);
    if (fallback) {
      return {
        statement: fallback as any,
        error: errorInfo,
        sql,
        usedAST: false,
      };
    }
    return { statement: null, error: errorInfo, sql, usedAST: false };
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
  const table = stmt.into?.name || '';
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
      const name = fromItem.name?.alias || fromItem.name?.name;
      if (name) tables.push(name);
    }
    // JOIN can be a child property on a from entry
    if (fromItem.join && fromItem.join.table?.name) {
      tables.push(fromItem.join.table.name);
    }
    // Also check the old joins array format
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
    if (fromItem.type === 'join') return true;
    if (fromItem.joins && fromItem.joins.length > 0) return true;
    if (fromItem.join) return true;
  }
  return stmt.from.length > 1;
}

function extractLimit(stmt: any): number | undefined {
  if (stmt.limit && typeof stmt.limit.value === 'number') return stmt.limit.value;
  if (stmt.limit && stmt.limit.value?.value !== undefined) return stmt.limit.value.value;
  return undefined;
}

function extractOrderBy(stmt: any): string | undefined {
  if (!stmt.orderBy || stmt.orderBy.length === 0) return undefined;
  const parts = stmt.orderBy.map((ob: any) => {
    try {
      const expr = toSql.expr(ob.expr);
      return ob.type === 'desc' ? `${expr} DESC` : `${expr} ASC`;
    } catch {
      return '';
    }
  }).filter(Boolean);
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
  if (stmt.from?.name) return stmt.from.name;
  if (stmt.names && stmt.names.length > 0) return stmt.names[0].name;
  return undefined;
}

function prepareToParsed(stmt: any, sql: string): import('./SqlParser').ParsedStatement {
  const name = stmt.name || '';
  const innerSql = stmt.innerSql || sql;
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
  let modified = false;
  for (const col of stmt.columns) {
    if (col.dataType && col.dataType.name && col.dataType.name.toLowerCase() === 'serial') {
      col.dataType.name = 'INTEGER';
      const hasPK = col.constraints?.some((c: any) =>
        c.type === 'primary key' || c.type === 'primary key constraint',
      );
      if (!hasPK) {
        if (!col.constraints) col.constraints = [];
        col.constraints.push({ type: 'primary key' });
      }
      if (!col.constraints) col.constraints = [];
      col.constraints.push({ type: 'autoinc' });
      modified = true;
    }
  }
  if (modified) {
    try {
      return toSql.statement(stmt);
    } catch {
      return originalSql.replace(/\bSERIAL\b/gi, 'INTEGER');
    }
  }
  return undefined;
}

/**
 * Extract error position info from a pgsql-ast-parser error.
 */
function extractErrorInfo(err: any, sql: string): ParseErrorInfo {
  // Default position
  let line = 1;
  let col = 1;
  let offset = 0;
  let message = err.message || 'Unknown parse error';

  // pgsql-ast-parser v12 errors have offset and token properties
  if (err.token) {
    line = err.token.line || 1;
    col = err.token.col || 1;
    offset = err.token.offset || 0;
  } else if (err.offset !== undefined) {
    // Fallback: try to compute line/col from offset
    offset = err.offset;
    const lines = sql.split('\n');
    let currentOffset = 0;
    for (let i = 0; i < lines.length; i++) {
      if (currentOffset + lines[i].length + 1 > offset) {
        line = i + 1;
        col = offset - currentOffset + 1;
        break;
      }
      currentOffset += lines[i].length + 1;
    }
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
    const tableMatch = upper.match(/INSERT\s+INTO\s+`?(\w+)`?/i);
    return {
      type: 'INSERT',
      originalSql: sql,
      table: tableMatch?.[1] || '',
      columns: [],
      hasReturning: /\bRETURNING\b/i.test(upper),
    } as import('./SqlParser').InsertStatement;
  }

  if (upper.startsWith('UPDATE')) {
    const tableMatch = upper.match(/UPDATE\s+`?(\w+)`?/i);
    return {
      type: 'UPDATE',
      originalSql: sql,
      table: tableMatch?.[1] || '',
    } as import('./SqlParser').UpdateStatement;
  }

  if (upper.startsWith('DELETE')) {
    const tableMatch = upper.match(/DELETE\s+FROM\s+`?(\w+)`?/i);
    return {
      type: 'DELETE',
      originalSql: sql,
      table: tableMatch?.[1] || '',
    } as import('./SqlParser').DeleteStatement;
  }

  if (upper.startsWith('CREATE TABLE')) {
    const tableMatch = upper.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i);
    const rewritten = sql.replace(/\bSERIAL\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
    return {
      type: 'DDL',
      originalSql: sql,
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
    const tableMatch = upper.match(/ALTER\s+TABLE\s+`?(\w+)`?/i);
    return {
      type: 'DDL',
      originalSql: sql,
      table: tableMatch?.[1],
      ddlType: 'ALTER',
    } as import('./SqlParser').DDLStatement;
  }

  if (upper.startsWith('DROP')) {
    const tableMatch = upper.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?`?(\w+)`?/i);
    return {
      type: 'DDL',
      originalSql: sql,
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
