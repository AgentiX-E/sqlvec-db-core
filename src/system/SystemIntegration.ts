/**
 * SystemIntegration — Registers all system views, functions, and types
 * with SqlVecDatabase's query pipeline.
 *
 * Provides a `SystemQueryExecutor` that can intercept queries to
 * information_schema / pg_catalog and system functions before they
 * reach the shard router. Designed to be plugged into the query
 * execution path with minimal changes to existing code.
 *
 * Integration point:
 *   1. Call `SystemIntegration.executeSystemQuery(sql)` from the
 *      QueryRouter's `executeUnknown` or the main `execute` method
 *      to intercept system queries.
 *   2. If it returns a non-null result, return it directly.
 *   3. If it returns null, proceed with normal shard routing.
 *
 * Usage:
 *   import { SystemIntegration } from '../system/SystemIntegration';
 *   const result = SystemIntegration.executeSystemQuery(sql);
 *   if (result) return result;
 */

import { SystemTypeRegistry } from './SystemTypes';
import { SystemFunctionRegistry, SysFnInfo } from './SystemFunctions';
import { SystemCatalog, SystemViewRow } from './SystemCatalog';
import { PgCatalog } from './PgCatalog';

export interface SystemQueryResult {
  rows: SystemViewRow[];
  rowCount: number;
  columns: string[];
  columnTypes: string[];
}

// ──────────────────────────────────────────────
//  SQL-like expression evaluator (simple)
// ──────────────────────────────────────────────

interface SelectColumn {
  expr: string;
  alias?: string;
}

/**
 * Evaluate a simple SELECT expression (system function call).
 * Handles patterns like:
 *   SELECT current_schema()
 *   SELECT version()
 *   SELECT pg_size_pretty(1024)
 *   SELECT current_user
 *   SELECT 1
 *   SELECT 'text'
 */
function evaluateScalarSelect(sql: string): SystemQueryResult | null {
  const trimmed = sql.trim().replace(/;$/, '');

  // Match: SELECT expr [, expr ...]
  const selectMatch = trimmed.match(/^\s*SELECT\s+(.+)$/i);
  if (!selectMatch) return null;

  const selectList = selectMatch[1].trim();

  // Split on comma (handling balanced parentheses)
  const expressions = splitTopLevelCommas(selectList);

  // Also check if it's a "SELECT * FROM information_schema.xxx" or "SELECT * FROM pg_catalog.xxx"
  const fromMatch = trimmed.match(/\bFROM\s+.*/i);
  if (fromMatch) {
    // This is a SELECT ... FROM ... query - will be handled by table routing
    return null;
  }

  const columns: string[] = [];
  const columnTypes: string[] = [];
  const row: Record<string, any> = {};

  for (let i = 0; i < expressions.length; i++) {
    const rawExpr = expressions[i].trim();

    // Check for AS alias first, strip it for evaluation
    const aliasMatch = rawExpr.match(/\s+AS\s+["'`]?(\w+)["'`]?$/i);
    const exprForEval = aliasMatch ? rawExpr.replace(/\s+AS\s+["'`]?(\w+)["'`]?$/i, '') : rawExpr;
    const { name, value, type } = evaluateExpression(exprForEval);

    // Determine column name
    const colName = aliasMatch
      ? aliasMatch[1]
      : (name || rawExpr);

    columns.push(colName);
    columnTypes.push(type || 'text');
    row[colName] = value;
  }

  return {
    rows: [row],
    rowCount: 1,
    columns,
    columnTypes,
  };
}

interface EvalResult {
  name: string | null;
  value: any;
  type: string;
}

function evaluateExpression(expr: string): EvalResult {
  expr = expr.trim();

  // Check for quoted strings: 'text'
  const stringMatch = expr.match(/^'(.*)'$/);
  if (stringMatch) {
    return { name: null, value: stringMatch[1], type: 'text' };
  }

  // Check for integer literals
  const intMatch = expr.match(/^(-?\d+)$/);
  if (intMatch) {
    return { name: null, value: parseInt(intMatch[1], 10), type: 'integer' };
  }

  // Check for float literals
  const floatMatch = expr.match(/^(-?\d+\.\d+)$/);
  if (floatMatch) {
    return { name: null, value: parseFloat(floatMatch[1]), type: 'numeric' };
  }

  // Check for boolean literals
  if (expr.toUpperCase() === 'TRUE') {
    return { name: null, value: true, type: 'boolean' };
  }
  if (expr.toUpperCase() === 'FALSE') {
    return { name: null, value: false, type: 'boolean' };
  }
  if (expr.toUpperCase() === 'NULL') {
    return { name: null, value: null, type: 'text' };
  }

  // Check for arithmetic: 1 + 1, etc.
  const arithMatch = expr.match(/^(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)$/);
  if (arithMatch) {
    const a = parseFloat(arithMatch[1]);
    const op = arithMatch[2];
    const b = parseFloat(arithMatch[3]);
    let result: number;
    switch (op) {
      case '+': result = a + b; break;
      case '-': result = a - b; break;
      case '*': result = a * b; break;
      case '/': result = a / b; break;
      default: return { name: null, value: null, type: 'text' };
    }
    return { name: null, value: result, type: 'numeric' };
  }

  // Check for function calls: func_name(args...)
  const fnMatch = expr.match(/^(\w[\w_]*)\s*\(([^)]*)\)\s*$/);
  if (fnMatch) {
    const fnName = fnMatch[1].toLowerCase();
    const argsStr = fnMatch[2].trim();

    // Parse args
    const args: any[] = [];
    if (argsStr) {
      const argParts = splitTopLevelCommas(argsStr);
      for (const arg of argParts) {
        const evalResult = evaluateExpression(arg.trim());
        args.push(evalResult.value);
      }
    }

    // Try to execute as a system function
    if (SystemFunctionRegistry.isSystemFunction(fnName)) {
      try {
        const value = SystemFunctionRegistry.execute(fnName, args);
        const fnInfo = SystemFunctionRegistry.getFunction(fnName);
        return { name: fnName, value, type: fnInfo?.returnType || 'text' };
      } catch {
        return { name: fnName, value: null, type: 'text' };
      }
    }

    // Fallback: function not recognized
    return { name: fnName, value: null, type: 'text' };
  }

  // Check for table-alias qualified column references (e.g., "t.typname")
  const aliasColMatch = expr.match(/^(?:\w[\w_]*)\.(\w[\w_]*)$/);
  if (aliasColMatch) {
    const name = aliasColMatch[1].toLowerCase();
    return { name, value: null, type: 'text' };
  }

  // Check for bare column references (like current_user, session_user, now)
  const bareNameMatch = expr.match(/^(\w[\w_]*)$/);
  if (bareNameMatch) {
    const name = bareNameMatch[1].toLowerCase();
    // Check for system functions that can be used without parentheses
    if (SystemFunctionRegistry.isSystemFunction(name)) {
      try {
        const value = SystemFunctionRegistry.execute(name, []);
        return { name, value, type: 'text' };
      } catch {
        return { name, value: null, type: 'text' };
      }
    }
    // Built-in constants
    if (name === 'now' || name === 'current_timestamp') {
      return { name, value: new Date().toISOString(), type: 'timestamptz' };
    }
    if (name === 'current_date') {
      return { name, value: new Date().toISOString().split('T')[0], type: 'date' };
    }
    if (name === 'current_time') {
      return { name, value: new Date().toTimeString().split(' ')[0], type: 'time' };
    }
    if (name === 'true') {
      return { name, value: true, type: 'boolean' };
    }
    if (name === 'false') {
      return { name, value: false, type: 'boolean' };
    }
    if (name === 'null') {
      return { name, value: null, type: 'text' };
    }

    // Default: treat as unquoted string column reference
    return { name, value: null, type: 'text' };
  }

  // CAST or other complex expressions
  return { name: null, value: null, type: 'text' };
}

/**
 * Extract column names from a SELECT expression list, stripping table aliases.
 * E.g., "t.typname, e.enumlabel" → ["typname", "enumlabel"]
 *        "*" → []
 */
function extractColumnNamesFromSelect(expr: string): string[] {
  if (!expr || expr.trim() === '*' || expr.trim() === '') return [];
  const parts = splitTopLevelCommas(expr);
  const names: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    // Handle "expr AS alias"
    const asMatch = trimmed.match(/^(?:.+?)\s+AS\s+["'`]?(\w+)["'`]?$/i);
    if (asMatch) {
      names.push(asMatch[1]);
      continue;
    }
    // Handle "table.col" → "col"
    const dotMatch = trimmed.match(/(\w+)$/);
    if (dotMatch) {
      names.push(dotMatch[1]);
    } else {
      names.push(trimmed);
    }
  }
  return names;
}

/**
 * Split a comma-separated expression string at the top level,
 * respecting parentheses nesting.
 */
function splitTopLevelCommas(str: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of str) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  const remaining = current.trim();
  if (remaining) parts.push(remaining);

  return parts;
}

// ──────────────────────────────────────────────
//  SystemQueryExecutor
// ──────────────────────────────────────────────

export class SystemIntegration {
  private static initialized = false;

  /**
   * Initialize all system components.
   * Call once at application start.
   */
  static init(): void {
    if (this.initialized) return;
    this.initialized = true;

    SystemTypeRegistry.init();
    SystemFunctionRegistry.init();
    SystemCatalog.init();
    PgCatalog.init();
  }

  /**
   * Reset all registries (for testing).
   */
  static reset(): void {
    this.initialized = false;
  }

  /**
   * Check if a SQL query targets a system catalog or function.
   * This is the main entry point for query interception.
   *
   * Returns a SystemQueryResult if the query is a system query,
   * or null if it should be routed normally.
   */
  static executeSystemQuery(sql: string): SystemQueryResult | null {
    this.init();

    const trimmed = sql.trim().replace(/;$/, '').trim();

    // Handle DDL no-ops for ORM compatibility
    // CREATE SCHEMA (with optional IF NOT EXISTS) — always succeed silently
    if (/^CREATE\s+SCHEMA\s/i.test(trimmed)) {
      return { rows: [], rowCount: 0, columns: [], columnTypes: [] };
    }
    // DROP SCHEMA — no-op
    if (/^DROP\s+SCHEMA\s/i.test(trimmed)) {
      return { rows: [], rowCount: 0, columns: [], columnTypes: [] };
    }

    // 1. Check for system catalog table queries (SELECT * FROM / SELECT col FROM)
    const tableResult = this.executeSystemTableQuery(trimmed);
    if (tableResult) return tableResult;

    // 2. Check for scalar SELECT (system functions, literals, etc.)
    const scalarResult = evaluateScalarSelect(sql);
    if (scalarResult && scalarResult.rowCount > 0) {
      // Only return scalar results for function calls or simple expressions
      const hasFrom = /\bFROM\b/i.test(trimmed);
      if (!hasFrom) {
        return scalarResult;
      }
    }

    return null;
  }

  /**
   * Execute a query against system catalog tables (information_schema.*, pg_catalog.*).
   */
  private static executeSystemTableQuery(sql: string): SystemQueryResult | null {
    // Normalize SQL
    const upper = sql.toUpperCase().replace(/\s+/g, ' ');
    const trimmed = sql.trim();

    // Handle EXISTS(subquery) patterns for ORM compatibility
    // Prisma/PG clients check namespace/schema existence with:
    //   SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1), ...
    const existsPgMatch = trimmed.match(
      /^SELECT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(?:pg_catalog\.)?pg_namespace\s+WHERE\s+nspname\s*=\s*(\$1|'[^']+'|E'[^']+'|\w+)\s*\).*/i,
    );
    if (existsPgMatch) {
      const nsParam = existsPgMatch[1];
      let exists = false;
      if (nsParam === '$1') {
        exists = true; // Common case: checking for 'public'
      } else {
        const nsName = nsParam.replace(/^E?'|'$/g, '');
        exists = nsName === 'public' || nsName === 'pg_catalog' || nsName === 'information_schema';
      }
      // Build result row: exists=true, version=..., numeric_version=...
      const version = SystemFunctionRegistry.isSystemFunction('version')
        ? SystemFunctionRegistry.execute('version', [])
        : 'PostgreSQL 16.0 (SqlVec DB)';
      return {
        rows: [{ exists, version, numeric_version: 160000 }],
        rowCount: 1,
        columns: ['exists', 'version', 'numeric_version'],
        columnTypes: ['boolean', 'text', 'int4'],
      };
    }

    // Try matching qualified (information_schema.xxx OR pg_catalog.xxx)
    // Match: SELECT ... FROM information_schema.xxx [WHERE ...]
    // Match: SELECT ... FROM pg_catalog.xxx [WHERE ...]
    // Skip JOIN queries — they need special handling, not single-table matching
    let qualifiedMatch: RegExpMatchArray | null = null;
    if (!/\bJOIN\b/i.test(upper)) {
      qualifiedMatch = upper.match(
        /^SELECT\s+(.+?)\s+FROM\s+(information_schema|pg_catalog)\.(\w+)(?:\s+(.+?))?$/i,
      );
    }

    // If no qualified match, try unqualified known pg_catalog table names
    let schema: string;
    let tableName: string;
    let whereClause: string;
    const knownPgTables = /^(pg_trigger|pg_rules|pg_matviews|pg_conversion|pg_aggregate|pg_am|pg_cast|pg_depend|pg_description|pg_extension|pg_available_extensions|pg_tables|pg_indexes|pg_views|pg_settings|pg_stat_activity|pg_class|pg_attribute|pg_type|pg_index|pg_proc|pg_namespace|pg_database|pg_attrdef|pg_sequences|pg_stat_user_tables|pg_stat_user_indexes|pg_stat_database|pg_stat_all_indexes|pg_statio_all_tables|pg_statio_all_indexes|pg_stat_user_functions|pg_stat_xact_user_tables|pg_stat_bgwriter|pg_stat_replication|pg_wait_sampling|pg_stat_progress_vacuum|pg_stat_progress_analyze|pg_stat_progress_cluster|pg_stat_progress_index|pg_stat_progress_create_index|pg_stat_progress_copy|pg_stat_statements|pg_prepared_xacts|pg_opclass|pg_opfamily)$/;

    if (qualifiedMatch) {
      schema = qualifiedMatch[2].toLowerCase();
      tableName = qualifiedMatch[3].toLowerCase();
      whereClause = qualifiedMatch[4] || '';
    } else {
      // Try unqualified match: SELECT ... FROM pg_xxx [alias] [WHERE ...]
      const unqualifiedMatch = upper.match(
        /^SELECT\s+(.+?)\s+FROM\s+(pg_\w+)(?:\s+(?!WHERE)\w+)*\s*(WHERE(?:\s+.*)?)?$/i,
      );
      if (!unqualifiedMatch) return null;

      const rawTableName = unqualifiedMatch[2].toLowerCase();
      if (!knownPgTables.test(rawTableName)) return null;

      schema = 'pg_catalog';
      tableName = rawTableName;
      whereClause = unqualifiedMatch[3] || '';
    }

    const selectExpr = sql.match(/^SELECT\s+(.+?)\s+FROM\s+/i)?.[1] || '';

    let rows: SystemViewRow[] | null = null;

    if (schema === 'information_schema') {
      if (SystemCatalog.isSystemView('information_schema', tableName)) {
        const viewRows = SystemCatalog.getViewRows('information_schema', tableName);
        if (viewRows === null) return null;
        rows = viewRows;
      } else {
        return null;
      }
    } else if (schema === 'pg_catalog') {
      const catalogRows = this.getPgCatalogRows(tableName);
      if (catalogRows === null) {
        // Unknown pg_catalog table — return empty result instead of falling through
        const emptySelectColumns = extractColumnNamesFromSelect(selectExpr);
        const emptyCols = emptySelectColumns.length ? emptySelectColumns : [];
        return { rows: [], rowCount: 0, columns: emptyCols, columnTypes: emptyCols.map(() => 'text') };
      }
      rows = catalogRows;
    } else {
      return null;
    }

    // Apply WHERE filtering (simple column = value)
    if (whereClause) {
      rows = this.applyWhereFilter(rows, whereClause);
    }

    // Determine columns from SELECT list
    const isSelectStar = /^\s*\*\s*$/i.test(selectExpr) || selectExpr.trim() === '*';
    let columns: string[];
    let columnTypes: string[];

    if (isSelectStar) {
      if (rows.length > 0) {
        columns = Object.keys(rows[0]);
        columnTypes = columns.map(() => 'text');
      } else {
        // No rows, try to infer columns from schema definition
        if (schema === 'information_schema') {
          const view = SystemCatalog.getView('information_schema', tableName);
          if (view) {
            columns = view.columns.map(c => c.columnName);
            columnTypes = view.columns.map(c => c.dataType);
          } else {
            return { rows, rowCount: 0, columns: [], columnTypes: [] };
          }
        } else {
          return { rows, rowCount: 0, columns: [], columnTypes: [] };
        }
      }
    } else {
      // Parse SELECT list for specific columns
      const selectParts = splitTopLevelCommas(selectExpr);
      columns = [];
      columnTypes = [];
      // Track original expression for AS aliases (for column projection lookup)
      const colOrigins: string[] = [];
      for (const part of selectParts) {
        const trimmed = part.trim();
        // Handle "col AS alias" pattern
        const asMatch = trimmed.match(/^(.+?)\s+AS\s+["'`]?(\w+)["'`]?$/i);
        if (asMatch) {
          // Evaluate the expression part
          const evalResult = evaluateExpression(asMatch[1].trim());
          columns.push(asMatch[2]);
          columnTypes.push(evalResult.type);
          colOrigins.push(asMatch[1].trim());
        } else {
          // Try as function or column reference
          const evalResult = evaluateExpression(trimmed);
          if (evalResult.name) {
            columns.push(evalResult.name);
            columnTypes.push(evalResult.type);
          } else {
            columns.push(trimmed);
            columnTypes.push('text');
          }
          colOrigins.push(trimmed);
        }
      }

      // Project only selected columns
      rows = rows.map(row => {
        const projected: Record<string, any> = {};
        for (let ci = 0; ci < columns.length; ci++) {
          const col = columns[ci];
          // Use the original expression to look up the row value
          const origin = colOrigins[ci];
          // Strip table alias prefix (e.g., "t.typname" → "typname")
          const strippedCol = origin.includes('.') ? origin.split('.').pop()! : origin;
          projected[col] = row[strippedCol] ?? null;
        }
        return projected;
      });
    }

    return {
      rows,
      rowCount: rows.length,
      columns,
      columnTypes,
    };
  }

  /**
   * Get rows from a pg_catalog table/view.
   */
  private static getPgCatalogRows(tableName: string): SystemViewRow[] | null {
    const name = tableName.toLowerCase();

    switch (name) {
      case 'pg_class':
        return PgCatalog.getClassRows();
      case 'pg_attribute':
        return PgCatalog.getAttributeRows();
      case 'pg_type':
        return PgCatalog.getTypeRows();
      case 'pg_index':
        return PgCatalog.getIndexRows();
      case 'pg_proc':
        return PgCatalog.getProcedureRows();
      case 'pg_namespace':
        return PgCatalog.getNamespaceRows();
      case 'pg_database':
        return PgCatalog.getDatabaseRows();
      case 'pg_tables':
        return PgCatalog.getPgTablesRows();
      case 'pg_indexes':
        return PgCatalog.getPgIndexesRows();
      case 'pg_attrdef':
        return PgCatalog.getPgAttrdefRows();
      case 'pg_sequences':
        return PgCatalog.getPgSequencesRows();
      case 'pg_views':
        return PgCatalog.getPgViewsRows();
      case 'pg_settings':
        return PgCatalog.getPgSettingsRows();
      case 'pg_stat_activity':
        return PgCatalog.getPgStatActivityRows();
      case 'pg_stat_user_tables':
        return PgCatalog.getPgStatUserTablesRows();
      case 'pg_stat_user_indexes':
        return PgCatalog.getPgStatUserIndexesRows();
      case 'pg_stat_database':
        return PgCatalog.getPgStatDatabaseRows();
      case 'pg_constraint':
        return PgCatalog.getPgConstraintRows();
      case 'pg_stat_all_indexes':
        return PgCatalog.getPgStatAllIndexesRows();
      case 'pg_statio_all_tables':
        return PgCatalog.getPgStatIoAllTablesRows();
      case 'pg_statio_all_indexes':
        return PgCatalog.getPgStatIoAllIndexesRows();
      case 'pg_stat_user_functions':
        return PgCatalog.getPgStatUserFunctionsRows();
      case 'pg_stat_xact_user_tables':
        return PgCatalog.getPgStatXactUserTablesRows();
      case 'pg_stat_bgwriter':
        return PgCatalog.getPgStatBgwriterRows();
      case 'pg_stat_replication':
        return PgCatalog.getPgStatReplicationRows();
      case 'pg_wait_sampling':
        return PgCatalog.getPgWaitSamplingRows();
      case 'pg_stat_progress_vacuum':
        return PgCatalog.getPgStatProgressVacuumRows();
      case 'pg_stat_progress_analyze':
        return PgCatalog.getPgStatProgressAnalyzeRows();
      case 'pg_stat_progress_cluster':
        return PgCatalog.getPgStatProgressClusterRows();
      case 'pg_stat_progress_index':
        return PgCatalog.getPgStatProgressIndexRows();
      case 'pg_stat_progress_create_index':
        return PgCatalog.getPgStatProgressCreateIndexRows();
      case 'pg_stat_progress_copy':
        return PgCatalog.getPgStatProgressCopyRows();
      case 'pg_stat_statements':
        return PgCatalog.getPgStatStatementsRows();
      case 'pg_prepared_xacts':
        return PgCatalog.getPgPreparedXactsRows();
      case 'pg_opclass':
        return PgCatalog.getPgOpclassRows();
      case 'pg_opfamily':
        return PgCatalog.getPgOpfamilyRows();
      case 'pg_trigger':
        return PgCatalog.getPgTriggerRows();
      case 'pg_rules':
        return PgCatalog.getPgRulesRows();
      case 'pg_matviews':
        return PgCatalog.getPgMatViewsRows();
      case 'pg_conversion':
        return PgCatalog.getPgConversionRows();
      case 'pg_aggregate':
        return PgCatalog.getPgAggregateRows();
      case 'pg_am':
        return PgCatalog.getPgAmRows();
      case 'pg_cast':
        return PgCatalog.getPgCastRows();
      case 'pg_depend':
        return PgCatalog.getPgDependRows();
      case 'pg_description':
        return PgCatalog.getPgDescriptionRows();
      case 'pg_extension':
        return PgCatalog.getPgExtensionRows();
      case 'pg_available_extensions':
        return PgCatalog.getPgAvailableExtensionsRows();
      default:
        return null;
    }
  }

  /**
   * Apply a simple WHERE clause filter to rows.
   * Supports: column = value, column IS NULL, column IS NOT NULL, column IN (...)
   * Column names and string values are matched case-insensitively.
   */
  private static applyWhereFilter(rows: SystemViewRow[], whereClause: string): SystemViewRow[] {
    const clause = whereClause.trim();

    // Handle trivial conditions
    if (/^WHERE\s*$/i.test(clause)) return rows; // empty WHERE
    if (/^WHERE\s+1\s*=\s*1\b/i.test(clause)) return rows; // WHERE 1=1 → all rows
    if (/^WHERE\s+1\s*=\s*0\b/i.test(clause)) return []; // WHERE 1=0 → no rows

    // Find the column name and value from WHERE clause, matching case-insensitively
    // Since rows use lowercase column names, we compare against all cases

    // Helper: find a row value by case-insensitive column name
    const getColValue = (row: SystemViewRow, colName: string): any => {
      // Strip table alias (e.g., "t.typname" → "typname")
      const stripped = colName.includes('.') ? colName.split('.').pop()! : colName;
      const lowerCol = stripped.toLowerCase();
      const keys = Object.keys(row);
      const key = keys.find(k => k.toLowerCase() === lowerCol);
      return key ? row[key] : undefined;
    };

    // Handle: column = 'value'  (with optional table alias)
    const eqMatch = clause.match(/^WHERE\s+`?(?:\w+\.)?(\w+)`?\s*=\s*'([^']*)'/i);
    if (eqMatch) {
      const col = eqMatch[1];
      const val = eqMatch[2].toLowerCase();
      return rows.filter(r => {
        const v = getColValue(r, col);
        return v !== undefined && String(v).toLowerCase() === val;
      });
    }

    // Handle: column = value (numeric)
    const eqNumMatch = clause.match(/^WHERE\s+`?(?:\w+\.)?(\w+)`?\s*=\s*(\d+)/i);
    if (eqNumMatch) {
      const col = eqNumMatch[1];
      const val = parseInt(eqNumMatch[2], 10);
      return rows.filter(r => getColValue(r, col) === val);
    }

    // Handle: column IS NULL
    const isNullMatch = clause.match(/^WHERE\s+`?(?:\w+\.)?(\w+)`?\s+IS\s+NULL/i);
    if (isNullMatch) {
      const col = isNullMatch[1];
      return rows.filter(r => {
        const v = getColValue(r, col);
        return v === null || v === undefined;
      });
    }

    // Handle: column IS NOT NULL
    const isNotNullMatch = clause.match(/^WHERE\s+`?(?:\w+\.)?(\w+)`?\s+IS\s+NOT\s+NULL/i);
    if (isNotNullMatch) {
      const col = isNotNullMatch[1];
      return rows.filter(r => {
        const v = getColValue(r, col);
        return v !== null && v !== undefined;
      });
    }

    // Handle: column IN ('val1', 'val2')
    const inMatch = clause.match(/^WHERE\s+`?(?:\w+\.)?(\w+)`?\s+IN\s*\(([^)]+)\)/i);
    if (inMatch) {
      const col = inMatch[1];
      const values = inMatch[2].split(',').map(v => v.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
      return rows.filter(r => {
        const v = getColValue(r, col);
        return v !== undefined && values.includes(String(v).toLowerCase());
      });
    }

    // If we can't parse the WHERE clause, return all rows
    return rows;
  }

  /**
   * Get the result of a system function call with specific arguments.
   * Useful for direct testing.
   */
  static evaluateFunction(fnName: string, args: any[]): any {
    this.init();
    return SystemFunctionRegistry.execute(fnName, args);
  }

  /**
   * Check if a table name is a system catalog table.
   */
  static isSystemTable(schema: string, name: string): boolean {
    this.init();
    const lowerSchema = schema.toLowerCase();
    const lowerName = name.toLowerCase();

    if (lowerSchema === 'information_schema') {
      return SystemCatalog.isSystemView('information_schema', lowerName);
    }
    if (lowerSchema === 'pg_catalog') {
      return this.getPgCatalogRows(lowerName) !== null;
    }
    return false;
  }

  /**
   * Get all known system table names (schema-qualified).
   */
  static getAllSystemTableNames(): string[] {
    this.init();
    const names: string[] = [];

    for (const viewName of SystemCatalog.getViewNames()) {
      names.push(viewName);
    }

    // Add pg_catalog tables
    const pgTables = [
      'pg_catalog.pg_class', 'pg_catalog.pg_attribute', 'pg_catalog.pg_type',
      'pg_catalog.pg_index', 'pg_catalog.pg_proc', 'pg_catalog.pg_namespace',
      'pg_catalog.pg_database', 'pg_catalog.pg_tables', 'pg_catalog.pg_indexes',
      'pg_catalog.pg_views', 'pg_catalog.pg_settings', 'pg_catalog.pg_stat_activity',
      'pg_catalog.pg_stat_user_tables', 'pg_catalog.pg_stat_user_indexes', 'pg_catalog.pg_stat_database',
      'pg_catalog.pg_stat_all_indexes', 'pg_catalog.pg_statio_all_tables',
      'pg_catalog.pg_statio_all_indexes',
      'pg_catalog.pg_attrdef', 'pg_catalog.pg_sequences',
      'pg_catalog.pg_stat_user_functions', 'pg_catalog.pg_stat_xact_user_tables',
      'pg_catalog.pg_stat_bgwriter', 'pg_catalog.pg_stat_replication',
      'pg_catalog.pg_wait_sampling',
      'pg_catalog.pg_stat_progress_vacuum', 'pg_catalog.pg_stat_progress_analyze',
      'pg_catalog.pg_stat_progress_cluster', 'pg_catalog.pg_stat_progress_index',
      'pg_catalog.pg_stat_progress_create_index',
      'pg_catalog.pg_stat_progress_copy',
      'pg_catalog.pg_stat_statements',
      'pg_catalog.pg_prepared_xacts',
      'pg_catalog.pg_opclass',
      'pg_catalog.pg_opfamily',
      'pg_catalog.pg_trigger',
      'pg_catalog.pg_rules',
      'pg_catalog.pg_matviews',
      'pg_catalog.pg_conversion',
      'pg_catalog.pg_aggregate',
      'pg_catalog.pg_am',
      'pg_catalog.pg_cast',
      'pg_catalog.pg_depend',
      'pg_catalog.pg_description',
      'pg_catalog.pg_extension',
      'pg_catalog.pg_available_extensions',
    ];

    for (const t of pgTables) {
      if (!names.includes(t)) names.push(t);
    }

    return names;
  }
}
