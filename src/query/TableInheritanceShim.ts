/**
 * TableInheritanceShim — PostgreSQL table inheritance (INHERITS) support shim.
 *
 * PostgreSQL supports table inheritance:
 * ```sql
 * CREATE TABLE parent (id INT, name TEXT);
 * CREATE TABLE child (age INT) INHERITS (parent);
 * ```
 *
 * When a table inherits from a parent, the child automatically gets all columns
 * of the parent. SELECT queries on the parent automatically include child rows.
 * `SELECT FROM ONLY parent` restricts to just the parent table.
 *
 * ## What this shim provides
 *
 * - Detection of `CREATE TABLE ... INHERITS (...)` syntax
 * - Rewriting: strip INHERITS clause, copy parent columns to child
 * - Inheritance chain registration: `_sqlvec_inheritance` meta table
 * - Child table resolution (recursive)
 * - SELECT rewriting: `FROM parent` → `FROM (SELECT * FROM parent UNION ALL SELECT * FROM child) AS parent`
 * - ONLY modifier handling
 * - ALTER TABLE ... INHERIT / NO INHERIT support
 *
 * ## Integration
 *
 * Integrates in QueryRouter after Step 1k (CreateTableLike):
 * - detectInherits → rewriteCreateTableInherits + registerInheritance
 * - rewriteSelectForInheritance (on SELECT execution path)
 * - detectAlterInherit → handleAlterInherit
 *
 * @module TableInheritanceShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('TableInheritanceShim');

// ── Types ────────────────────────────────────────────────────────

export interface InheritsResult {
  sql: string;
  rewritten: boolean;
  childTable?: string;
  parentTables?: string[];
}

export interface AlterInheritResult {
  sql: string | null; // null → no-op (handled internally)
  rewritten: boolean;
  action: 'INHERIT' | 'NO INHERIT' | null;
  childTable?: string;
  parentTable?: string;
}

export interface InheritanceInfo {
  childTable: string;
  parentTable: string;
  seqno: number;
}

// ── Constants — Regex Patterns ──────────────────────────────────

/**
 * Detect CREATE TABLE preamble (up to the column definition paren).
 * Used to extract the table name; the column content and INHERITS clause
 * are handled via paren-matching (since columns can contain nested parens
 * from CHECK, DEFAULT expressions, etc.).
 *
 * Matches:
 *   CREATE TABLE child (age INT) INHERITS (parent)
 *   CREATE TABLE child () INHERITS (parent)
 *   CREATE TABLE IF NOT EXISTS child (age INT) INHERITS (parent)
 *   CREATE TABLE "Child" (id INT) INHERITS ("Parent")
 *
 * Capture groups:
 *   [1] The full preamble up to and including the opening `(`
 *   [2] Table name (unquoted)
 *   [3] Table name (double-quoted, fallback)
 */
const CREATE_TABLE_PREAMBLE_RE =
  /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?|"([^"]+)")\s*\(/i;

/**
 * ALTER TABLE ... INHERIT detection.
 *
 * Matches:
 *   ALTER TABLE child INHERIT parent
 *   ALTER TABLE child NO INHERIT parent
 *   ALTER TABLE IF EXISTS child INHERIT parent
 *
 * Capture groups:
 *   [1] Table name (child)
 *   [2] 'INHERIT' or 'NO INHERIT'
 *   [3] Parent table name
 */
const ALTER_INHERIT_RE =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s+(NO\s+)?INHERIT\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s*;?\s*$/i;

/**
 * SELECT FROM ONLY detection.
 */
const ONLY_RE = /\bFROM\s+ONLY\s+/i;

/**
 * Trailing semicolons.
 */
const TRAILING_SEMICOLON_RE = /\s*;+\s*$/;

// ── Meta table name ─────────────────────────────────────────────

export const INHERITANCE_META_TABLE = '_sqlvec_inheritance';

export const INHERITANCE_META_DDL = `
  CREATE TABLE IF NOT EXISTS ${INHERITANCE_META_TABLE} (
    child_table TEXT NOT NULL,
    parent_table TEXT NOT NULL,
    seqno INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (child_table, parent_table)
  )
`;

// ── SQLite -> PG type mapping (for column copying) ──────────────

/**
 * Map a SQLite column type string to a PostgreSQL-friendly type name.
 */
export function _mapSqliteTypeToPgType(sqliteType: string | null): string {
  if (!sqliteType) return 'TEXT';
  const upper = sqliteType.toUpperCase().trim();
  if (upper.includes('INT')) return 'INTEGER';
  if (upper.includes('CHAR') || upper.includes('TEXT') || upper.includes('CLOB')) return 'TEXT';
  if (upper.includes('BLOB')) return 'BLOB';
  if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB')) return 'REAL';
  if (upper === 'BOOLEAN' || upper === 'BOOL') return 'BOOLEAN';
  if (upper.includes('DATE') || upper.includes('TIME')) return 'TIMESTAMP';
  if (upper.includes('NUMERIC') || upper.includes('DECIMAL')) return 'NUMERIC';
  return 'TEXT';
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a CREATE TABLE with INHERITS clause.
 *
 * @param sql - The raw SQL string to inspect.
 * @returns `true` if a CREATE TABLE INHERITS pattern is detected.
 */
export function detectInherits(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;

  // Must start with CREATE TABLE and contain INHERITS keyword
  const trimmed = sql.trim();
  if (!/^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s/i.test(trimmed)) return false;

  // Scan for the INHERITS keyword outside string literals, quoted
  // identifiers, dollar-quoted strings, and comments. A bare `\bINHERITS\s*\(`
  // would false-positive on text like `DEFAULT 'INHERITS (x)'`.
  for (let i = 0; i < trimmed.length; i++) {
    const skip = skipSqlLiteral(trimmed, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    if (isWordStart(trimmed, i) && trimmed.startsWith('INHERITS', i)) {
      const after = i + 'INHERITS'.length;
      if (/^\s*\(/.test(trimmed.substring(after))) return true;
    }
  }
  return false;
}

/**
 * Whether `pos` is the start of a word (not preceded by an identifier char).
 */
function isWordStart(sql: string, pos: number): boolean {
  if (pos === 0) return true;
  const prev = sql[pos - 1];
  return !/[A-Za-z0-9_]/.test(prev);
}

/**
 * Extract child table name and parent table names from a CREATE TABLE INHERITS statement.
 *
 * @param sql - The SQL string to examine.
 * @returns An object with `childTable` and `parentTables` arrays, or null if not matched.
 */
export function extractInheritsTables(sql: string): { childTable: string; parentTables: string[] } | null {
  if (!detectInherits(sql)) return null;

  const trimmed = sql.trim();

  // Match the table name via preamble regex
  const preMatch = trimmed.match(CREATE_TABLE_PREAMBLE_RE);
  if (!preMatch) return null;

  const childTable = preMatch[1] || preMatch[2] || '';
  const parenStart = preMatch.index! + preMatch[0].length - 1; // position of '('

  // Use literal-aware paren-matching to find the column definition block.
  // A `)` inside a string literal (e.g. a DEFAULT value) must not close the
  // column-definition parentheses early.
  let depth = 1;
  let colContentEnd = -1;
  for (let i = parenStart + 1; i < trimmed.length; i++) {
    const skip = skipSqlLiteral(trimmed, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    if (trimmed[i] === '(') depth++;
    else if (trimmed[i] === ')') {
      depth--;
      if (depth === 0) {
        colContentEnd = i;
        break;
      }
    }
  }

  if (colContentEnd === -1) return null; // Unbalanced parens

  // The remaining SQL after the closing paren
  const afterCol = trimmed.substring(colContentEnd + 1).trim();

  // Check for INHERITS keyword
  const inheritsMatch = afterCol.match(/^INHERITS\s*\(([^)]+)\)/i);
  if (!inheritsMatch) return null;

  const parentList = inheritsMatch[1];
  const parentTables = _parseParentTableList(parentList);

  return { childTable, parentTables };
}

/**
 * Parse a comma-separated list of (possibly quoted) parent table names.
 *
 * Handles quoted identifiers containing spaces or other special characters
 * (e.g. `"Parent Table"`), which a bare `[A-Za-z0-9_]*` regex would split on
 * the space. Backtick and double-quote delimiters are supported, and doubled
 * double-quotes (`""`) are treated as an escaped quote.
 */
export function _parseParentTableList(parentList: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | '`' | null = null;
  let i = 0;

  while (i < parentList.length) {
    const ch = parentList[i];

    if (quote) {
      if (quote === '"' && ch === '"' && parentList[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    if (ch === '"' || ch === '`') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === ',') {
      const name = current.trim();
      if (name) result.push(name);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }

  const name = current.trim();
  if (name) result.push(name);
  return result;
}

/**
 * Initialize the inheritance meta table.
 *
 * @param db - A better-sqlite3 database instance.
 */
export function initInheritanceMeta(db: any): void {
  if (!db) return;

  try {
    db.exec(INHERITANCE_META_DDL);
    logger.debug('Inheritance meta table initialised');
  /* v8 ignore next -- catch is non-fatal defensive fallback */  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to initialise inheritance meta table');
  }
}

/**
 * Register an inheritance relationship.
 *
 * @param db - A better-sqlite3 database instance.
 * @param childTable - The child table name.
 * @param parentTable - The parent table name.
 * @param seqno - Optional sequence number (default: 0).
 */
export function registerInheritance(db: any, childTable: string, parentTable: string, seqno: number = 0): void {
  if (!db) return;

  initInheritanceMeta(db);

  try {
    db.prepare(
      `INSERT OR REPLACE INTO ${INHERITANCE_META_TABLE} (child_table, parent_table, seqno) VALUES (?, ?, ?)`,
    ).run(childTable.toLowerCase(), parentTable.toLowerCase(), seqno);
    logger.debug({ childTable, parentTable, seqno }, 'Inheritance relationship registered');
  /* v8 ignore next -- catch is non-fatal defensive fallback */  } catch (err: any) {
    logger.warn({ err: err.message, childTable, parentTable }, 'Failed to register inheritance');
  }
}

/**
 * Unregister an inheritance relationship.
 *
 * @param db - A better-sqlite3 database instance.
 * @param childTable - The child table name.
 * @param parentTable - Optional parent table name. If omitted, removes all parents for this child.
 */
export function unregisterInheritance(db: any, childTable: string, parentTable?: string): boolean {
  if (!db) return false;

  try {
    if (parentTable) {
      const result = db.prepare(
        `DELETE FROM ${INHERITANCE_META_TABLE} WHERE child_table = ? AND parent_table = ?`,
      ).run(childTable.toLowerCase(), parentTable.toLowerCase());
      return result.changes > 0;
    } else {
      const result = db.prepare(
        `DELETE FROM ${INHERITANCE_META_TABLE} WHERE child_table = ?`,
      ).run(childTable.toLowerCase());
      return result.changes > 0;
    }
  /* v8 ignore next -- catch is non-fatal defensive fallback */  } catch (err: any) {
    logger.warn({ err: err.message, childTable, parentTable }, 'Failed to unregister inheritance');
    return false;
  }
}

/**
 * Get the immediate parent table name for a child table.
 *
 * @param db - A better-sqlite3 database instance.
 * @param tableName - The table name to look up.
 * @returns The parent table name, or null if the table has no parent.
 */
export function getParentTable(db: any, tableName: string): string | null {
  if (!db) return null;

  try {
    initInheritanceMeta(db);
    const row = db.prepare(
      `SELECT parent_table FROM ${INHERITANCE_META_TABLE} WHERE child_table = ? ORDER BY seqno LIMIT 1`,
    ).get(tableName.toLowerCase()) as { parent_table: string } | undefined;

    return row ? row.parent_table : null;
  /* v8 ignore next -- catch is defensive fallback */
  } catch {
    return null;
  }
}

/**
 * Check whether a table is a child table (has a parent).
 *
 * @param db - A better-sqlite3 database instance.
 * @param tableName - The table name to check.
 * @returns `true` if the table inherits from a parent.
 */
export function isChildTable(db: any, tableName: string): boolean {
  return getParentTable(db, tableName) !== null;
}

/**
 * Get all parent tables for a child table (supports multiple inheritance).
 *
 * @param db - A better-sqlite3 database instance.
 * @param tableName - The child table name.
 * @returns Array of parent table names.
 */
export function getParentTables(db: any, tableName: string): string[] {
  if (!db) return [];

  try {
    initInheritanceMeta(db);
    const rows = db.prepare(
      `SELECT parent_table FROM ${INHERITANCE_META_TABLE} WHERE child_table = ? ORDER BY seqno`,
    ).all(tableName.toLowerCase()) as { parent_table: string }[];

    return rows.map(r => r.parent_table);
  /* v8 ignore next -- catch is defensive fallback */
  } catch {
    return [];
  }
}

/**
 * Get all direct child tables for a parent table.
 *
 * @param db - A better-sqlite3 database instance.
 * @param tableName - The parent table name.
 * @returns Array of direct child table names.
 */
export function getChildTables(db: any, tableName: string): string[] {
  if (!db) return [];

  try {
    initInheritanceMeta(db);
    const rows = db.prepare(
      `SELECT child_table FROM ${INHERITANCE_META_TABLE} WHERE parent_table = ? ORDER BY child_table`,
    ).all(tableName.toLowerCase()) as { child_table: string }[];

    return rows.map(r => r.child_table);
  /* v8 ignore next -- catch is defensive fallback */
  } catch {
    return [];
  }
}

/**
 * Recursively get all descendant tables (children, grandchildren, etc.)
 *
 * @param db - A better-sqlite3 database instance.
 * @param tableName - The table name to resolve.
 * @returns Array of all descendant table names.
 */
export function getAllDescendants(db: any, tableName: string): string[] {
  const results: string[] = [];
  const visited = new Set<string>();

  const traverse = (t: string) => {
    if (visited.has(t.toLowerCase())) return;
    visited.add(t.toLowerCase());

    const children = getChildTables(db, t);
    for (const child of children) {
      if (!visited.has(child)) {
        results.push(child);
        traverse(child);
      }
    }
  };

  traverse(tableName);
  return results;
}

/**
 * Resolve inheritance: return the table and all its descendant tables.
 *
 * @param db - A better-sqlite3 database instance.
 * @param tableName - The table name to resolve.
 * @returns Array of [table, child1, child2, ...].
 */
export function resolveInheritance(db: any, tableName: string): string[] {
  return [tableName, ...getAllDescendants(db, tableName)];
}

/**
 * Get column definitions from an existing table.
 *
 * Uses PRAGMA table_info to retrieve columns.
 *
 * @param db - A better-sqlite3 database instance.
 * @param tableName - The table name.
 * @returns Array of column definitions: { name, type, notnull, dflt_value }
 */
export function getTableColumns(
  db: any,
  tableName: string,
): Array<{ name: string; type: string; notnull: boolean; dflt_value: string | null }> {
  if (!db) return [];

  try {
    const columns = db.prepare(`PRAGMA table_info('${tableName.replace(/'/g, "''")}')`).all() as any[];
    return columns.map((col: any) => ({
      name: col.name,
      type: col.type || 'TEXT',
      notnull: col.notnull === 1,
      dflt_value: col.dflt_value,
    }));
  /* v8 ignore next -- catch is defensive fallback */
  } catch {
    return [];
  }
}

/**
 * Generate a CREATE TABLE SQL statement that includes columns from the parent table.
 *
 * Merges child's own columns with parent's columns. Child columns take precedence
 * (if a column with the same name exists in both child and parent, the child's
 * definition is used).
 *
 * @param db - A better-sqlite3 database instance.
 * @param childTable - The child table name.
 * @param childColumns - The child's own column definitions (from the CREATE TABLE).
 * @param parentTables - Array of parent table names.
 * @returns SQL that creates the child table with all columns.
 */
export function buildCreateTableWithParentColumns(
  db: any,
  childTable: string,
  childColumns: Array<{ name: string; type: string; notnull: boolean; dflt_value: string | null }>,
  parentTables: string[],
): string {
  const allColumns = new Map<string, { name: string; type: string; notnull: boolean; dflt_value: string | null }>();

  // Add parent columns (in order of parent tables)
  for (const parent of parentTables) {
    const parentCols = getTableColumns(db, parent);
    for (const col of parentCols) {
      if (!allColumns.has(col.name.toLowerCase())) {
        allColumns.set(col.name.toLowerCase(), col);
      }
    }
  }

  // Add child columns (override parent columns with same name)
  for (const col of childColumns) {
    allColumns.set(col.name.toLowerCase(), col);
  }

  // Build SQL
  const colDefs: string[] = [];
  for (const [, col] of allColumns) {
    let colDef = `"${col.name}" ${_mapSqliteTypeToPgType(col.type)}`;
    if (col.notnull) colDef += ' NOT NULL';
    if (col.dflt_value !== null && col.dflt_value !== undefined) {
      colDef += ` DEFAULT ${col.dflt_value}`;
    }
    colDefs.push(colDef);
  }

  return `CREATE TABLE "${childTable}" (${colDefs.join(', ')})`;
}

/**
 * Rewrite a CREATE TABLE ... INHERITS statement into SQLite-compatible SQL.
 *
 * The INHERITS clause is stripped, and if the meta table already has the parent's
 * column info, they are merged into the child. Returns the rewritten SQL and the
 * parent table names so the caller can register the inheritance.
 *
 * @param sql - The SQL string to process.
 * @param db - Optional database instance. If provided, parent columns are merged.
 * @returns An InheritsResult with the rewritten SQL and metadata.
 */
export function rewriteCreateTableInherits(sql: string, db?: any): InheritsResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: '', rewritten: false };
  }

  const trimmed = sql.trim();

  if (!detectInherits(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  const extracted = extractInheritsTables(trimmed);
  if (!extracted || extracted.parentTables.length === 0) {
    logger.warn({ sql: trimmed }, 'INHERITS detected but could not extract tables');
    return { sql: trimmed, rewritten: false };
  }

  const { childTable, parentTables } = extracted;

  // Extract child's own column definitions using paren-matching
  const childColumns: Array<{ name: string; type: string; notnull: boolean; dflt_value: string | null }> = [];

  // Find the column definition block between outer parens
  const preMatch = trimmed.match(CREATE_TABLE_PREAMBLE_RE);
  if (preMatch) {
    const parenStart = preMatch.index! + preMatch[0].length - 1;
    let depth = 1;
    let colEnd = -1;
    for (let i = parenStart + 1; i < trimmed.length; i++) {
      const skip = skipSqlLiteral(trimmed, i);
      if (skip !== -1) {
        i = skip - 1;
        continue;
      }
      if (trimmed[i] === '(') depth++;
      else if (trimmed[i] === ')') {
        depth--;
        if (depth === 0) {
          colEnd = i;
          break;
        }
      }
    }

    if (colEnd !== -1) {
      const rawCols = trimmed.substring(parenStart + 1, colEnd).trim();
      if (rawCols.length > 0) {
        const colParts = _splitColumnDefs(rawCols);
        for (const part of colParts) {
          const parsed = _parseSimpleColumnDef(part.trim());
          if (parsed) {
            childColumns.push(parsed);
          }
        }
      }
    }
  }

  let resultSql: string;

  if (db) {
    // Merge parent columns into the child table
    resultSql = buildCreateTableWithParentColumns(db, childTable, childColumns, parentTables);
  } else {
    // No DB available — just strip the INHERITS clause
    // Replace INHERITS (...) with just the column definition
    resultSql = trimmed.replace(/\s*INHERITS\s*\([^)]+\)\s*;?\s*$/i, '');
    resultSql = resultSql.replace(TRAILING_SEMICOLON_RE, '');
  }

  logger.debug(
    { before: trimmed, after: resultSql, childTable, parentTables },
    'CREATE TABLE INHERITS rewritten',
  );

  return {
    sql: resultSql,
    rewritten: true,
    childTable,
    parentTables,
  };
}

/**
 * Rewrite a SELECT statement to include UNION ALL of child tables.
 *
 * `SELECT * FROM parent WHERE x` becomes
 * `SELECT * FROM (SELECT * FROM parent UNION ALL SELECT * FROM child) AS parent WHERE x`
 *
 * @param sql - The SQL string to process.
 * @param db - A better-sqlite3 database instance for looking up child tables.
 * @returns Rewritten SQL string (unchanged if no children found).
 */
export function rewriteSelectForInheritance(sql: string, db: any): string {
  if (typeof sql !== 'string' || sql.trim().length === 0 || !db) return sql;

  const trimmed = sql.trim();

  const fromInfo = _findTopLevelFrom(trimmed);
  if (!fromInfo) return sql;

  // Check if this table has descendants
  const children = getAllDescendants(db, fromInfo.tableName);
  if (children.length === 0) return sql;

  // Check for ONLY modifier on this specific FROM — if ONLY is present, we
  // don't expand children.
  if (fromInfo.only) {
    return sql;
  }

  // Build the UNION ALL subquery
  const allTables = [fromInfo.tableName, ...children];
  const unionParts = allTables.map(t => `SELECT * FROM "${t}"`);
  const unionAll = unionParts.join(' UNION ALL ');

  const alias = fromInfo.alias || fromInfo.tableName;

  // Replace exactly the FROM ... [alias] span we located, leaving the
  // SELECT-list text (which may contain string literals with "FROM") intact.
  const rewritten =
    trimmed.substring(0, fromInfo.start) +
    `FROM (${unionAll}) AS ${alias}` +
    trimmed.substring(fromInfo.end);

  logger.debug({ before: trimmed, after: rewritten, tableName: fromInfo.tableName, children }, 'SELECT rewritten for inheritance');

  return rewritten;
}

/**
 * Locate the first top-level `FROM` clause in a SELECT statement, along with
 * its table name, optional alias, and the exact `[start, end)` span of the
 * `FROM [ONLY] <table> [AS <alias>]` text.
 *
 * The scan is literal-aware: string literals, quoted identifiers, dollar-quoted
 * strings, and comments are skipped so that a `FROM` or table name appearing
 * inside them is never mistaken for real syntax. Nested parenthesised
 * subqueries (depth > 0) are also skipped so we match only the outer SELECT's
 * FROM clause.
 */
export function _findTopLevelFrom(
  sql: string,
): { start: number; end: number; tableName: string; alias: string; only: boolean } | null {
  let depth = 0;

  for (let i = 0; i < sql.length; i++) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }

    const ch = sql[i];
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth !== 0) continue;

    // Look for a top-level FROM keyword.
    if (!/FROM\b/i.test(sql.substring(i, i + 5))) continue;

    // Match the FROM keyword precisely.
    const kwMatch = /^FROM\b/i.exec(sql.substring(i));
    if (!kwMatch) continue;

    const fromEnd = i + kwMatch[0].length;
    const rest = sql.substring(fromEnd);

    // Optional ONLY keyword, then the table name.
    const tableMatch = /^\s*(ONLY\s+)?(\"([^\"]+)\"|`([^`]+)`|[A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (!tableMatch) continue;

    const only = !!tableMatch[1];
    const tableName = tableMatch[3] || tableMatch[4] || tableMatch[2] || '';
    if (!tableName) continue;

    let end = fromEnd + tableMatch[0].length;

    // Optional alias: AS alias or bare alias (not followed by a keyword).
    const afterTable = sql.substring(end);
    const aliasMatch = /^\s+(?:AS\s+)?(\"([^\"]+)\"|`([^`]+)`|[A-Za-z_][A-Za-z0-9_]*)/.exec(afterTable);
    let alias = '';
    if (aliasMatch) {
      // Avoid swallowing a trailing WHERE/JOIN/etc. keyword as an alias.
      const candidate = aliasMatch[1];
      if (!/^(WHERE|JOIN|LEFT|RIGHT|INNER|CROSS|ON|GROUP|ORDER|LIMIT|OFFSET|UNION|HAVING|NATURAL|FULL)$/i.test(candidate)) {
        alias = aliasMatch[2] || aliasMatch[3] || aliasMatch[1];
        end = end + aliasMatch[0].length;
      }
    }

    return { start: i, end, tableName, alias, only };
  }

  return null;
}

/**
 * Handle SELECT FROM ONLY by stripping the ONLY keyword.
 *
 * `SELECT * FROM ONLY parent` → `SELECT * FROM parent`
 *
 * @param sql - The SQL string to process.
 * @returns SQL with ONLY keyword removed.
 */
export function rewriteSelectOnly(sql: string): string {
  if (typeof sql !== 'string' || sql.trim().length === 0) return sql;

  const trimmed = sql.trim();

  if (!ONLY_RE.test(trimmed)) return sql;

  const rewritten = trimmed.replace(/\bFROM\s+ONLY\b/i, 'FROM');

  logger.debug({ before: trimmed, after: rewritten }, 'ONLY keyword stripped');

  return rewritten;
}

/**
 * Detect ALTER TABLE ... INHERIT / NO INHERIT.
 *
 * @param sql - The SQL string to inspect.
 * @returns `true` if an ALTER TABLE INHERIT/NO INHERIT is detected.
 */
export function detectAlterInherit(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  return ALTER_INHERIT_RE.test(sql.trim());
}

/**
 * Handle ALTER TABLE ... INHERIT / NO INHERIT.
 *
 * For 'INHERIT': registers the inheritance and copies parent columns if needed.
 * For 'NO INHERIT': unregisters the inheritance.
 *
 * @param sql - The SQL string to process.
 * @param db - A better-sqlite3 database instance.
 * @returns An AlterInheritResult indicating the action taken.
 */
export function handleAlterInherit(sql: string, db: any): AlterInheritResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: null, rewritten: false, action: null };
  }

  const trimmed = sql.trim();

  if (!detectAlterInherit(trimmed)) {
    return { sql: trimmed, rewritten: false, action: null };
  }

  const match = trimmed.match(ALTER_INHERIT_RE);

  if (!match) {
    return { sql: trimmed, rewritten: false, action: null };
  }

  const childTable = match[1] || match[2] || match[3] || '';
  const isNoInherit = !!match[4]; // 'NO ' prefix captures if present
  const parentTable = match[5] || match[6] || match[7] || '';

  if (!childTable || !parentTable) {
    logger.warn({ sql: trimmed }, 'ALTER TABLE INHERIT: could not extract table names');
    return { sql: trimmed, rewritten: false, action: null };
  }

  if (!db) {
    // No database — still return the parsed action info
    return {
      sql: null,
      rewritten: true,
      action: isNoInherit ? 'NO INHERIT' : 'INHERIT',
      childTable,
      parentTable,
    };
  }

  const action: 'INHERIT' | 'NO INHERIT' = isNoInherit ? 'NO INHERIT' : 'INHERIT';

  if (action === 'INHERIT') {
    // Register inheritance
    // Also add parent columns to child if they don't exist
    registerInheritance(db, childTable, parentTable, 0);

    // Add missing parent columns to the child table
    addMissingParentColumns(db, childTable, parentTable);
  } else {
    // Unregister inheritance
    unregisterInheritance(db, childTable, parentTable);
  }

  logger.debug({ childTable, parentTable, action }, 'ALTER TABLE inheritance handled');

  return {
    sql: null, // Null → no-op (handled internally via meta table + ALTER TABLE)
    rewritten: true,
    action,
    childTable,
    parentTable,
  };
}

/**
 * Add parent columns that don't exist in the child table.
 * Uses ALTER TABLE ADD COLUMN for each missing column.
 *
 * @param db - A better-sqlite3 database instance.
 * @param childTable - The child table name.
 * @param parentTable - The parent table name.
 */
export function addMissingParentColumns(db: any, childTable: string, parentTable: string): void {
  if (!db) return;

  try {
    const childCols = getTableColumns(db, childTable);
    const parentCols = getTableColumns(db, parentTable);

    const childColNames = new Set(childCols.map(c => c.name.toLowerCase()));

    for (const pCol of parentCols) {
      if (!childColNames.has(pCol.name.toLowerCase())) {
        const colDef = `"${pCol.name}" ${_mapSqliteTypeToPgType(pCol.type)}`;
        const alterSql = `ALTER TABLE "${childTable}" ADD COLUMN ${colDef}`;
        db.exec(alterSql);
        logger.debug({ childTable, column: pCol.name, alterSql }, 'Added parent column to child table');
      }
    }
  /* v8 ignore next -- catch is non-fatal defensive fallback */  } catch (err: any) {
    logger.warn({ err: err.message, childTable, parentTable }, 'Failed to add parent columns to child');
  }
}

/**
 * Check if a column definition string contains CHECK constraints.
 * Used by TC-INH-10 to validate propagated constraints.
 *
 * @param db - A better-sqlite3 database instance.
 * @param tableName - The table name to inspect.
 * @returns Array of CHECK constraint definitions.
 */
export function getCheckConstraints(db: any, tableName: string): string[] {
  if (!db) return [];

  try {
    const rows = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).all(tableName) as { sql: string }[];

    if (rows.length === 0) return [];

    const createSql = rows[0].sql;
    const checks: string[] = [];
    const checkRe = /\bCHECK\s*\(([^)]+)\)/gi;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = checkRe.exec(createSql)) !== null) {
      checks.push(cMatch[1].trim());
    }
    return checks;
  /* v8 ignore next -- catch is defensive fallback */
  } catch {
    return [];
  }
}

/**
 * Get pg_inherits-style rows for system catalog querying.
 * Returns inheritance relationships in the format:
 * { inhrelid: OID, inhparent: OID, inhseqno: number }
 *
 * @param db - A better-sqlite3 database instance.
 * @param tableName - Optional table name filter. If omitted, returns all rows.
 * @returns Array of inheritance rows (with placeholder OIDs).
 */
export function getPgInheritsRows(db: any, tableName?: string): Array<{
  inhrelid: number;
  inhparent: number;
  inhseqno: number;
}> {
  if (!db) return [];

  try {
    initInheritanceMeta(db);

    let query = `SELECT child_table, parent_table, seqno FROM ${INHERITANCE_META_TABLE}`;
    const params: any[] = [];

    if (tableName) {
      query += ` WHERE child_table = ? OR parent_table = ?`;
      params.push(tableName.toLowerCase(), tableName.toLowerCase());
    }

    query += ` ORDER BY parent_table, child_table, seqno`;

    const rows = db.prepare(query).all(...params) as any[];

    // Generate pseudo-OIDs based on hash for determinism
    let oidBase = 50000;
    return rows.map((r: any) => {
      oidBase++;
      const parentOid = _hashTableNameToOid(String(r.parent_table), oidBase);
      const childOid = _hashTableNameToOid(String(r.child_table), oidBase + 1000);
      return {
        inhrelid: childOid,
        inhparent: parentOid,
        inhseqno: Number(r.seqno),
      };
    });
  /* v8 ignore next -- catch is defensive fallback */
  } catch {
    return [];
  }
}

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Simple helper to hash a table name to a deterministic OID.
 */
export function _hashTableNameToOid(name: string, base: number): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const chr = name.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return base + Math.abs(hash) % 10000;
}

/**
 * Split a comma-separated column definition list into individual column definitions.
 *
 * Handles nested parentheses (e.g., DEFAULT expressions with parens).
 */
export function _splitColumnDefs(cols: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < cols.length; i++) {
    const skip = skipSqlLiteral(cols, i);
    if (skip !== -1) {
      current += cols.substring(i, skip);
      i = skip - 1;
      continue;
    }

    const ch = cols[i];

    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim().length > 0) {
    parts.push(current);
  }

  return parts;
}

/**
 * Parse a simple column definition string into structured info.
 *
 * Handles: name type [NOT NULL] [DEFAULT value]
 *
 * @param colDef - A single column definition string.
 * @returns Parsed column info or null.
 */
export function _parseSimpleColumnDef(colDef: string): { name: string; type: string; notnull: boolean; dflt_value: string | null } | null {
  if (!colDef || colDef.trim().length === 0) return null;

  const trimmed = colDef.trim();

  // Extract column name: a quoted identifier (double-quote or backtick, which
  // may contain spaces) or a bare word. The quoted branch must be tried first
  // so an opening quote is not mistakenly treated as an optional delimiter
  // around a bare identifier (which would split `"weird name"` at the space).
  const nameMatch = trimmed.match(/^(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s+/);
  if (!nameMatch) return null;

  const name = nameMatch[1] || nameMatch[2] || nameMatch[3] || '';
  let rest = trimmed.substring(nameMatch[0].length).trim();

  // Extract type (next word up to NOT NULL, DEFAULT, CHECK, etc.)
  const typeMatch = rest.match(/^([A-Za-z][A-Za-z0-9_()]*)\s*/i);
  const type = typeMatch ? typeMatch[1] : 'TEXT';
  if (typeMatch) {
    rest = rest.substring(typeMatch[0].length).trim();
  }

  const notnull = /\bNOT\s+NULL\b/i.test(rest);
  const defaultMatch = rest.match(/\bDEFAULT\s+('(?:[^']|'')*'|[^\s,)]+)/i);
  const dflt_value = defaultMatch ? defaultMatch[1] : null;

  return { name, type, notnull: notnull || false, dflt_value };
}
