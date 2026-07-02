/**
 * ExplainHandler — EXPLAIN / EXPLAIN ANALYZE execution plan output
 *
 * Intercepts EXPLAIN and EXPLAIN ANALYZE statements and produces
 * a structured execution plan tree, modeled after PostgreSQL's EXPLAIN output.
 *
 * Plan node types:
 *   - Seq Scan       : Full table scan
 *   - Index Scan     : Index-backed lookup
 *   - Vector Search  : Vector similarity search
 *   - Sort           : ORDER BY sorting
 *   - Aggregate      : GROUP BY / aggregate functions
 *   - Limit          : LIMIT clause
 *   - Hash Join      : Hash-based JOIN
 *   - Nested Loop    : Nested loop JOIN
 *   - Subquery Scan  : Subquery scan
 *
 * Usage (after integration):
 *   const handler = new ExplainHandler();
 *   const plan = handler.buildPlan(parsedStatement);
 *   // For ANALYZE:
 *   const plan = handler.buildPlan(parsedStatement, executionResult);
 */

import { parse } from 'pgsql-ast-parser';
import type Database from 'better-sqlite3';
import { PgStatCollector, TableStats } from './PgStatCollector';
import { CostModel } from './CostModel';
import type { TableStats as CostModelStats } from './CostModel';

// ============================================================
//  Types
// ============================================================

/**
 * ExplainNode — PostgreSQL-style execution plan node (public type).
 *
 * Matches PostgreSQL's EXPLAIN output structure, supporting both
 * estimated and actual (ANALYZE) statistics.
 *
 * This is the canonical public type returned by buildExplainPlan().
 */
export interface ExplainNode {
  /** Node type (e.g., 'Seq Scan', 'Index Scan', 'Aggregate', 'Sort', 'Limit', 'Hash Join') */
  NodeType: string;
  /** Estimated startup cost before first row is returned */
  StartupCost: number;
  /** Estimated total cost to process all rows */
  TotalCost: number;
  /** Estimated number of output rows */
  PlanRows: number;
  /** Estimated average row width in bytes */
  PlanWidth: number;
  /** Relation name (table name for scans, or relation for DML) */
  RelationName?: string;
  /** Output columns list (VERBOSE mode) */
  OutputColumns?: string[];
  /** Filter condition (WHERE clause) */
  Filter?: string;
  /** Index name (Index Scan only) */
  IndexName?: string;
  /** Index condition (Index Scan only) */
  IndexCond?: string;
  /** One-time filter */
  OneTimeFilter?: string;
  /** Sort key description (Sort node) */
  SortKey?: string;
  /** Aggregate strategy (Aggregate node) */
  Strategy?: string;
  /** Hash condition (Hash Join) */
  HashCond?: string;
  /** Join type (Hash Join, Nested Loop, Merge Join) */
  JoinType?: string;
  /** Subquery alias */
  Alias?: string;

  // EXPLAIN ANALYZE fields
  ActualStartupTime?: number;
  ActualTotalTime?: number;
  ActualRows?: number;
  ActualLoops?: number;

  /** Child plan nodes */
  Plans?: ExplainNode[];
}

/**
 * Format options parsed from EXPLAIN (FORMAT ...) clause.
 */
export interface ExplainFormatOptions {
  analyze: boolean;
  verbose: boolean;
  costs: boolean;
  timing: boolean;
  buffers: boolean;
  format: 'text' | 'json' | 'yaml';
}

export interface PlanNode {
  /** Node type (e.g., 'Seq Scan', 'Index Scan', 'Vector Search') */
  nodeType: string;
  /** Relation name (table or index) */
  relationName?: string;
  /** Estimated startup cost */
  startupCost: number;
  /** Estimated total cost */
  totalCost: number;
  /** Estimated number of rows */
  planRows: number;
  /** Estimated row width in bytes */
  planWidth: number;
  /** Actual startup time in ms (EXPLAIN ANALYZE only) */
  actualStartupTime?: number;
  /** Actual total time in ms (EXPLAIN ANALYZE only) */
  actualTotalTime?: number;
  /** Actual rows returned (EXPLAIN ANALYZE only) */
  actualRows?: number;
  /** Actual loops executed (EXPLAIN ANALYZE only) */
  actualLoops?: number;
  /** Filter condition (WHERE clause) */
  filter?: string;
  /** Index name (for Index Scan) */
  indexName?: string;
  /** Index condition (for Index Scan) */
  indexCond?: string;
  /** Sort key (for Sort node) */
  sortKey?: string;
  /** Aggregate type (for Aggregate node) */
  strategy?: string;
  /** Hash condition (for Hash Join) */
  hashCond?: string;
  /** Join type (for Join nodes) */
  joinType?: string;
  /** Subquery plan name */
  alias?: string;
  /** Child plan nodes */
  plans?: PlanNode[];
}

export interface ExplainOptions {
  /** Enable ANALYZE mode (measure actual execution) */
  analyze?: boolean;
  /** Enable verbose output */
  verbose?: boolean;
  /** Enable costs display */
  costs?: boolean;
  /** Enable timing display */
  timing?: boolean;
  /** Enable buffers display */
  buffers?: boolean;
  /** Output format (text, json, yaml) */
  format?: 'text' | 'json' | 'yaml';
}

export const DEFAULT_EXPLAIN_OPTIONS: ExplainOptions = {
  analyze: false,
  verbose: false,
  costs: true,
  timing: true,
  buffers: false,
};

/**
 * Parse EXPLAIN (FORMAT JSON), EXPLAIN (FORMAT YAML), or EXPLAIN (ANALYZE, FORMAT JSON) etc.
 *
 * Examples:
 *   EXPLAIN (FORMAT JSON) SELECT ...
 *   EXPLAIN (FORMAT YAML) SELECT ...
 *   EXPLAIN (ANALYZE, FORMAT JSON) SELECT ...
 *   EXPLAIN VERBOSE SELECT ...
 *   EXPLAIN (ANALYZE, VERBOSE) SELECT ...
 */
function parseExplainOptions(sql: string, baseOptions: ExplainOptions): { innerSql: string; options: ExplainOptions } {
  const options = { ...baseOptions };
  let innerSql = sql;

  // Match EXPLAIN (option1, option2, ...) inner_STATEMENT
  // Supported options: ANALYZE, VERBOSE, COSTS, TIMING, BUFFERS, FORMAT JSON/YAML
  const parentheticalMatch = sql.match(
    /^\s*EXPLAIN\s+\(([^)]+)\)\s+(.*)/is,
  );

  if (parentheticalMatch) {
    const optsStr = parentheticalMatch[1].toUpperCase();
    innerSql = parentheticalMatch[2];

    // Parse individual options
    const parts = optsStr.split(',').map(s => s.trim());

    for (const part of parts) {
      if (part === 'ANALYZE') {
        options.analyze = true;
      } else if (part === 'VERBOSE') {
        options.verbose = true;
      } else if (part === 'COSTS') {
        options.costs = true;
      } else if (part === 'COSTS FALSE' || part === 'COSTS OFF') {
        options.costs = false;
      } else if (part === 'TIMING') {
        options.timing = true;
      } else if (part === 'TIMING FALSE' || part === 'TIMING OFF') {
        options.timing = false;
      } else if (part === 'BUFFERS') {
        options.buffers = true;
      } else if (/^FORMAT\s+JSON$/i.test(part)) {
        options.format = 'json';
      } else if (/^FORMAT\s+YAML$/i.test(part)) {
        options.format = 'yaml';
      } else if (/^FORMAT\s+TEXT$/i.test(part)) {
        options.format = 'text';
      }
    }

    return { innerSql, options };
  }

  // Also handle "EXPLAIN VERBOSE SELECT ..." (non-parenthetical)
  const verboseMatch = sql.match(/^\s*EXPLAIN\s+VERBOSE\s+(.*)/is);
  if (verboseMatch) {
    options.verbose = true;
    innerSql = verboseMatch[1];
    return { innerSql, options };
  }

  return { innerSql, options };
}

export interface ExplainResult {
  /** The plan tree as formatted text */
  planText: string;
  /** Structured plan nodes */
  planNodes: PlanNode[];
  /** Planning time in ms */
  planningTime: number;
  /** Execution time in ms (ANALYZE only) */
  executionTime?: number;
  /** Aggregated statistics */
  summary: ExplainSummary;
  /** Analysis details from ANALYZE execution (G12) */
  analysis?: {
    actualRows: number;
    actualTime: number;
    loops: number;
  };
  /** Output format (text, json, yaml) */
  outputFormat: 'text' | 'json' | 'yaml';
}

export interface ExplainSummary {
  totalEstimatedRows: number;
  totalEstimatedCost: number;
  nodeCount: number;
  deepestLevel: number;
  scanTypeCounts: Record<string, number>;
  hasVectorSearch: boolean;
}

/**
 * Real execution statistics from ANALYZE mode (P0-4).
 * Replaces simulated random data with actual measured values.
 */
export interface QueryExecutionStats {
  /** Actual rows returned */
  actualRows: number;
  /** Actual execution time in ms */
  execTimeMs: number;
  /** Actual query result rows (for analysis) */
  resultRows?: any[];
}

// ============================================================
//  ExplainHandler
// ============================================================

export class ExplainHandler {
  private options: ExplainOptions;
  private db?: Database.Database;
  private statCollector?: PgStatCollector;
  private costModel: CostModel;

  constructor(options?: Partial<ExplainOptions>, db?: Database.Database, statCollector?: PgStatCollector) {
    this.options = { ...DEFAULT_EXPLAIN_OPTIONS, ...options };
    this.db = db;
    this.statCollector = statCollector;
    this.costModel = new CostModel({}, true);
  }

  /**
   * Check if a SQL statement is an EXPLAIN or EXPLAIN ANALYZE.
   */
  static isExplainStatement(sql: string): boolean {
    const trimmed = sql.trim().toUpperCase();
    return trimmed.startsWith('EXPLAIN');
  }

  /**
   * Strip EXPLAIN prefix from SQL to get the inner statement.
   * e.g., "EXPLAIN ANALYZE SELECT * FROM t" -> "SELECT * FROM t"
   * e.g., "EXPLAIN (FORMAT JSON) SELECT * FROM t" -> "SELECT * FROM t"
   * e.g., "EXPLAIN (ANALYZE, FORMAT YAML) SELECT * FROM t" -> "SELECT * FROM t"
   */
  static stripExplain(sql: string): { innerSql: string; options: ExplainOptions } {
    const trimmed = sql.trim();
    let options: ExplainOptions = { ...DEFAULT_EXPLAIN_OPTIONS };

    // Try parenthetical format: EXPLAIN (ANALYZE, FORMAT JSON) ...
    const parentheticalMatch = trimmed.match(
      /^\s*EXPLAIN\s+\(([^)]+)\)\s+(.*)/is,
    );
    if (parentheticalMatch) {
      return parseExplainOptions(sql, options);
    }

    // Standard prefix format: EXPLAIN ANALYZE / EXPLAIN VERBOSE / EXPLAIN
    const upper = trimmed.toUpperCase().replace(/\s+/g, ' ');
    let prefixLen = 0;

    if (upper.startsWith('EXPLAIN ANALYZE VERBOSE ')) {
      options.analyze = true;
      options.verbose = true;
      prefixLen = 'EXPLAIN ANALYZE VERBOSE '.length;
    } else if (upper.startsWith('EXPLAIN ANALYZE ')) {
      options.analyze = true;
      prefixLen = 'EXPLAIN ANALYZE '.length;
    } else if (upper.startsWith('EXPLAIN VERBOSE ')) {
      options.verbose = true;
      prefixLen = 'EXPLAIN VERBOSE '.length;
    } else if (upper.startsWith('EXPLAIN ')) {
      prefixLen = 'EXPLAIN '.length;
    } else if (upper === 'EXPLAIN') {
      return { innerSql: '', options };
    }

    const innerSql = trimmed.slice(prefixLen).trim();
    return { innerSql, options };
  }

  /**
   * Build an execution plan from a SQL statement.
   * Generates estimated costs based on query structure.
   *
   * @param sql - The EXPLAIN SQL (or inner SQL if already stripped)
   * @param executionResult - Optional actual result for ANALYZE mode
   * @returns A structured ExplainResult with plan tree, timing, and summary
   */
  buildPlan(sql: string, executionResult?: any[] | QueryExecutionStats): ExplainResult {
    const startTime = performance.now();

    // If this is still an EXPLAIN SQL, strip it
    const { innerSql, options } = ExplainHandler.isExplainStatement(sql)
      ? ExplainHandler.stripExplain(sql)
      : { innerSql: sql, options: { ...this.options } };

    // Merge detected options with configured options
    this.options = { ...this.options, ...options };

    // Parse the inner SQL to determine the plan
    // P0-4: Convert QueryExecutionStats to array format for the plan builder
    const planResult = !Array.isArray(executionResult) && executionResult
      ? (executionResult as QueryExecutionStats).resultRows ?? []
      : executionResult as any[] | undefined;
    const planTree = this.buildPlanTree(innerSql, planResult);

    const planningTime = performance.now() - startTime;

    // Format the plan as text
    const planText = this.formatPlanTree(planTree);

    // Compute summary
    const summary = this.computeSummary(planTree);

    return {
      planText,
      planNodes: this.flattenPlanTree(planTree),
      planningTime,
      executionTime: this.options.analyze
        ? planTree.actualTotalTime ?? undefined
        : undefined,
      summary,
      outputFormat: this.options.format || 'text',
    };
  }

  /**
   * Build the execution plan tree for a SQL statement.
   */
  private buildPlanTree(sql: string, executionResult?: any[] | QueryExecutionStats): PlanNode {
    const upper = sql.trim().toUpperCase();

    // Vector search detection
    if (upper.includes('VEC_SEARCH') || upper.includes('VECTOR_DISTANCE')) {
      return this.buildVectorSearchPlan(sql, executionResult);
    }

    try {
      const ast = parse(sql.trim());
      if (!ast || ast.length === 0) {
        return this.buildUnknownPlan(sql);
      }

      const stmt = ast[0];

      switch ((stmt as any).type) {
        case 'select':
          return this.buildSelectPlan(stmt, executionResult, sql);
        case 'insert':
          return this.buildInsertPlan(stmt);
        case 'update':
          return this.buildUpdatePlan(stmt);
        case 'delete':
          return this.buildDeletePlan(stmt);
        case 'create table':
        case 'create index':
        case 'alter table':
        case 'drop':
          return this.buildDDLPlan(stmt);
        default:
          return this.buildUnknownPlan(sql);
      }
    } catch {
      return this.buildUnknownPlan(sql);
    }
  }

  /**
   * Build a SELECT plan tree.
   * Walks the AST bottom-up to create a realistic plan.
   */
  private buildSelectPlan(
    stmt: any,
    executionResult?: any[] | QueryExecutionStats,
    rawSql?: string,
  ): PlanNode {
    const children: PlanNode[] = [];

    // Determine FROM clause: extract table names
    const tableNames: string[] = [];
    let hasJoin = false;
    let joinCondition: string | undefined;

    if (stmt.from) {
      for (const fromItem of stmt.from) {
        // pgsql-ast-parser: simple table
        if (fromItem.type === 'table' && fromItem.name) {
          tableNames.push(fromItem.name.name || 'unknown');
        }

        // pgsql-ast-parser: table with JOIN (second item has .join)
        if (fromItem.join) {
          // The join.table gives the joined table name
          const joinTable = fromItem.join.table;
          if (joinTable?.name) {
            tableNames.push(joinTable.name);
          }
          hasJoin = true;
          joinCondition = fromItem.join.on
            ? this.exprToString(fromItem.join.on)
            : undefined;
        }

        // Legacy: joined tables in a `joins` array
        if (fromItem.joins) {
          for (const join of fromItem.joins) {
            if (join.table?.name) tableNames.push(join.table.name);
            hasJoin = true;
            joinCondition = join.on ? this.exprToString(join.on) : joinCondition;
          }
        }

        // Legacy: fromItem itself is a join type
        if (fromItem.type === 'join') {
          if (fromItem.table?.name) tableNames.push(fromItem.table.name);
          hasJoin = true;
          joinCondition = fromItem.on ? this.exprToString(fromItem.on) : undefined;
        }
      }
    }

    // Step 1: Scan nodes
    if (hasJoin) {
      // For joins, create scan nodes for each table
      for (const tbl of tableNames) {
        const scan = this.makeScanNode(tbl, stmt.where, rawSql);
        children.push(scan);
      }
    } else {
      // Single table scan
      const scan = this.makeScanNode(
        tableNames[0] || 'unknown',
        stmt.where,
        rawSql,
      );
      children.push(scan);
    }

    // Step 2: If WHERE exists and no join, add filter info to the scan
    if (stmt.where && !hasJoin && children.length > 0) {
      children[0].filter = this.exprToString(stmt.where);
    }

    // Step 3: Aggregate node (GROUP BY or aggregate functions)
    const hasAggregate = this.detectAggregate(stmt);
    if (hasAggregate) {
      const aggNode: PlanNode = {
        nodeType: 'Aggregate',
        startupCost: this.sumChildCost(children).startup + (hasJoin ? 5 : 2),
        totalCost: this.sumChildCost(children).total + (hasJoin ? 15 : 5),
        planRows: Math.ceil(
          children.reduce(
            (sum, c) => sum + c.planRows,
            0,
          ) * 0.1,
        ),
        planWidth: 32,
        strategy: hasAggregate === 'hash' ? 'HashAggregate' : 'GroupAggregate',
        plans: children.length > 0 ? [...children] : undefined,
      };
      children.length = 0;
      children.push(aggNode);
    }

    // Step 4: Sort node (ORDER BY)
    if (stmt.orderBy && stmt.orderBy.length > 0) {
      const sortKey = stmt.orderBy
        .map((ob: any) => {
          const key = this.exprToString(ob.expr);
          return ob.type === 'desc' ? `${key} DESC` : `${key} ASC`;
        })
        .join(', ');

      const sortNode: PlanNode = {
        nodeType: 'Sort',
        startupCost: this.sumChildCost(children).total + 1,
        totalCost: this.sumChildCost(children).total + Math.log(children[0]?.planRows || 100) * 5,
        planRows: children[0]?.planRows || 100,
        planWidth: 32,
        sortKey,
        plans: children.length > 0 ? [...children] : undefined,
      };
      children.length = 0;
      children.push(sortNode);
    }

    // Step 5: Limit node
    const limitValue = this.extractLimitValue(stmt);
    if (limitValue !== undefined) {
      const limitNode: PlanNode = {
        nodeType: 'Limit',
        startupCost: this.sumChildCost(children).total,
        totalCost: this.sumChildCost(children).total + 0.01,
        planRows: limitValue,
        planWidth: 32,
        plans: children.length > 0 ? [...children] : undefined,
      };
      children.length = 0;
      children.push(limitNode);
    }

    // If no aggregate/sort/limit was added and there's a join, wrap scans in a join node
    if (hasJoin && children.length <= 2 && !children.some(c => c.nodeType === 'Hash Join' || c.nodeType === 'Nested Loop')) {
      const joinNode: PlanNode = {
        nodeType: 'Hash Join',
        joinType: 'INNER',
        hashCond: joinCondition,
        startupCost: this.sumChildCost(children).startup + 2,
        totalCost: this.sumChildCost(children).total + 10,
        planRows: Math.ceil(children.reduce((sum, c) => sum + c.planRows, 0) * 0.8),
        planWidth: 48,
        plans: children.length > 0 ? [...children] : undefined,
      };
      children.length = 0;
      children.push(joinNode);
    }

    // If ANALYZE and result provided, fill in actuals
    if (this.options.analyze && executionResult) {
      // P0-4: Convert QueryExecutionStats to array for applyActuals
      const actualsInput = !Array.isArray(executionResult)
        ? [(executionResult as QueryExecutionStats)]
        : executionResult;
      this.applyActuals(children.length > 0 ? children[0] : undefined as any, actualsInput);
    }

    return children[0] || this.makeScanNode('unknown');
  }

  /**
   * Get actual table row count from the database if available.
   * Falls back to 1000 if no db or query fails.
   * Uses PgStatCollector if available for cached stats.
   */
  private getTableStats(table: string): { rows: number } {
    // Use PgStatCollector cached stats first
    if (this.statCollector) {
      const stats = this.statCollector.getTableStats(table);
      if (stats) {
        return { rows: stats.rowCount };
      }
    }

    if (!this.db) {
      return { rows: 1000 };
    }
    try {
      const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '');
      if (!safeTable) return { rows: 1000 };
      const row = this.db.prepare(`SELECT COUNT(*) AS cnt FROM "${safeTable}"`).get() as { cnt: number } | undefined;
      const count = row?.cnt ?? 1000;
      return { rows: Math.max(1, count) };
    } catch {
      return { rows: 1000 };
    }
  }

  /**
   * Enhanced selectivity estimation using PgStatCollector.
   */
  private getSelectivity(table: string, where: any): number {
    if (!this.statCollector || !where) return 1.0;

    try {
      const expr = where.type === 'binary' ? where : null;
      if (!expr) return 1.0;

      const col = expr.left?.type === 'ref' ? expr.left.name : null;
      if (!col) return 1.0;

      const op = expr.op || expr.operator || '';
      const value = expr.right?.value ?? expr.right?.name ?? undefined;

      return this.statCollector.estimateSelectivity(table, col, op, value);
    } catch {
      return 1.0;
    }
  }

  /**
   * Create a scan node (Seq Scan or Index Scan) with CostModel-based costs.
   */
  private makeScanNode(
    table: string,
    where?: any,
    rawSql?: string,
  ): PlanNode {
    // Estimate rows: if WHERE clause has equality on likely PK, ~1 row
    // Otherwise estimate using selectivity from stats
    const hasEqualityPK = where && this.detectEqualityOnPK(where, rawSql);
    const selectivity = this.getSelectivity(table, where);
    const tableRows = this.getTableStats(table).rows;
    const rows = hasEqualityPK ? 1 : Math.max(1, Math.round(tableRows * selectivity));

    // Build CostModel-compatible stats from available row count
    const avgRowWidth = 32; // conservative estimate for EXPLAIN display
    const costStats: CostModelStats = {
      reltuples: tableRows,
      relpages: Math.max(1, Math.ceil((tableRows * avgRowWidth) / 8192)),
      nDistinct: new Map(),
      correlation: new Map(),
    };

    // Use CostModel for PG-style cost estimation
    let scanCost;
    if (hasEqualityPK && table !== 'unknown') {
      const pkSelectivity = 1 / Math.max(1, tableRows);
      scanCost = this.costModel.indexScanCost(costStats, pkSelectivity);
    } else {
      scanCost = this.costModel.seqScanCost(costStats);
    }

    const scanNode: PlanNode = {
      nodeType: hasEqualityPK && table !== 'unknown' ? 'Index Scan' : 'Seq Scan',
      relationName: table,
      startupCost: scanCost.startupCost,
      totalCost: scanCost.totalCost,
      planRows: rows,
      planWidth: avgRowWidth,
    };

    if (hasEqualityPK) {
      scanNode.indexName = `${table}_pkey`;
      scanNode.indexCond = this.exprToString(where);
    }

    return scanNode;
  }

  /**
   * Build vector search plan.
   */
  private buildVectorSearchPlan(
    sql: string,
    executionResult?: any[] | QueryExecutionStats,
  ): PlanNode {
    const tableMatch = sql.match(/FROM\s+`?(\w+)`?/i);
    const tableName = tableMatch?.[1] || 'unknown';
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    const topK = limitMatch ? parseInt(limitMatch[1], 10) : 10;

    const scan: PlanNode = {
      nodeType: 'Seq Scan',
      relationName: tableName,
      startupCost: 0.0,
      totalCost: 100,
      planRows: 1000,
      planWidth: 32,
    };

    const vectorNode: PlanNode = {
      nodeType: 'Vector Search',
      relationName: tableName,
      startupCost: 1.0,
      totalCost: 1.0 + 0.1 * 1000, // ~101
      planRows: topK,
      planWidth: 64,
      filter: `embedding MATCH vector`,
      plans: [scan],
    };

    const limitNode: PlanNode = {
      nodeType: 'Limit',
      startupCost: vectorNode.totalCost,
      totalCost: vectorNode.totalCost + 0.01,
      planRows: topK,
      planWidth: 64,
      plans: [vectorNode],
    };

    return limitNode;
  }

  // ──────────────────────────────────────────────
  //  INSERT, UPDATE, DELETE, DDL plans
  // ──────────────────────────────────────────────

  private buildInsertPlan(stmt: any): PlanNode {
    const tableName = stmt.into?.name || 'unknown';
    return {
      nodeType: 'Insert',
      relationName: tableName,
      startupCost: 0.0,
      totalCost: 0.01,
      planRows: 0,
      planWidth: 0,
    };
  }

  private buildUpdatePlan(stmt: any): PlanNode {
    const tableName = stmt.table?.name || 'unknown';
    const whereClause = stmt.where ? this.exprToString(stmt.where) : undefined;

    const tableRows = this.getTableStats(tableName || 'unknown').rows;
    const scan: PlanNode = {
      nodeType: 'Seq Scan',
      relationName: tableName,
      startupCost: 0.0,
      totalCost: 0.0 + (whereClause ? 1 : tableRows) * 0.01,
      planRows: whereClause ? 1 : tableRows,
      planWidth: 32,
      filter: whereClause,
    };

    return {
      nodeType: 'Update',
      relationName: tableName,
      startupCost: scan.totalCost,
      totalCost: scan.totalCost + 0.5,
      planRows: 0,
      planWidth: 0,
      plans: [scan],
    };
  }

  private buildDeletePlan(stmt: any): PlanNode {
    const tableName = stmt.from?.name || 'unknown';
    const whereClause = stmt.where ? this.exprToString(stmt.where) : undefined;

    const tableRows = this.getTableStats(tableName || 'unknown').rows;
    const scan: PlanNode = {
      nodeType: 'Seq Scan',
      relationName: tableName,
      startupCost: 0.0,
      totalCost: 0.0 + (whereClause ? 1 : tableRows) * 0.01,
      planRows: whereClause ? 1 : tableRows,
      planWidth: 32,
      filter: whereClause,
    };

    return {
      nodeType: 'Delete',
      relationName: tableName,
      startupCost: scan.totalCost,
      totalCost: scan.totalCost + 0.5,
      planRows: 0,
      planWidth: 0,
      plans: [scan],
    };
  }

  private buildDDLPlan(stmt: any): PlanNode {
    const tableName =
      stmt.name?.name || stmt.table?.name || stmt.names?.[0]?.name || 'unknown';
    const ddlType = (stmt.type || 'unknown').replace(/\b\w/g, (c: string) => c.toUpperCase());

    return {
      nodeType: ddlType,
      relationName: tableName,
      startupCost: 0.0,
      totalCost: 0.1,
      planRows: 0,
      planWidth: 0,
    };
  }

  private buildUnknownPlan(sql: string): PlanNode {
    return {
      nodeType: 'Custom Scan',
      startupCost: 0.0,
      totalCost: 1.0,
      planRows: 0,
      planWidth: 0,
    };
  }

  // ──────────────────────────────────────────────
  //  Plan tree formatting
  // ──────────────────────────────────────────────

  /**
   * Format a PlanNode tree into PostgreSQL-style text.
   */
  formatPlanTree(node: PlanNode, indent: number = 0): string {
    const prefix = '  '.repeat(indent);
    const arrow = indent === 0 ? '  ->  ' : '      ';
    const lines: string[] = [];

    // Node header
    const costPart = this.options.costs
      ? `  (cost=${node.startupCost.toFixed(2)}..${node.totalCost.toFixed(2)} rows=${node.planRows} width=${node.planWidth})`
      : '';

    const actualPart =
      this.options.analyze &&
      node.actualTotalTime !== undefined
        ? `  (actual time=${node.actualStartupTime?.toFixed(3) ?? '0.000'}..${node.actualTotalTime.toFixed(3)} rows=${node.actualRows ?? node.planRows} loops=1)`
        : '';

    const timingInfo = actualPart || costPart;

    let header = `${prefix}${arrow}${node.nodeType}`;
    if (node.relationName) {
      header += ` on ${node.relationName}`;
    }
    if (node.alias) {
      header += ` ${node.alias}`;
    }
    header += timingInfo;

    lines.push(header);

    // Node properties
    if (node.filter) {
      lines.push(`${prefix}        Filter: ${node.filter}`);
    }
    if (node.indexName) {
      lines.push(`${prefix}        Index: ${node.indexName}`);
    }
    if (node.indexCond) {
      lines.push(`${prefix}        Index Cond: ${node.indexCond}`);
    }
    if (node.sortKey) {
      lines.push(`${prefix}        Sort Key: ${node.sortKey}`);
    }
    if (node.strategy) {
      lines.push(`${prefix}        Strategy: ${node.strategy}`);
    }
    if (node.hashCond) {
      lines.push(`${prefix}        Hash Cond: ${node.hashCond}`);
    }
    if (node.joinType) {
      lines.push(`${prefix}        Join Type: ${node.joinType}`);
    }

    // Child nodes
    if (node.plans && node.plans.length > 0) {
      for (const child of node.plans) {
        // Child indentation is one level deeper
        const childLines = this.formatPlanTree(child, indent + 1);
        lines.push(childLines);
      }
    }

    return lines.join('\n');
  }

  // ──────────────────────────────────────────────
  //  Helpers
  // ──────────────────────────────────────────────

  private exprToString(expr: any): string {
    if (!expr || typeof expr !== 'object') return String(expr ?? '');

    if (expr.type === 'ref') return expr.name || '?';
    if (expr.type === 'integer') return String(expr.value);
    if (expr.type === 'string') return `'${expr.value}'`;
    if (expr.type === 'float') return String(expr.value);
    if (expr.type === 'boolean') return String(expr.value);
    if (expr.type === 'null') return 'NULL';
    if (expr.type === 'star') return '*';
    if (expr.type === 'binary') {
      const op = expr.op || expr.operator || '?';
      const left = this.exprToString(expr.left);
      const right = this.exprToString(expr.right);
      return `${left} ${op} ${right}`;
    }
    if (expr.type === 'unary') {
      return `${expr.operator} ${this.exprToString(expr.operand)}`;
    }
    if (expr.type === 'call') {
      const args = (expr.args || []).map((a: any) => this.exprToString(a)).join(', ');
      return `${expr.function?.name || ''}(${args})`;
    }
    if (expr.type === 'in') {
      const left = this.exprToString(expr.left);
      const values = (expr.values || [])
        .map((v: any) => this.exprToString(v))
        .join(', ');
      const not = expr.not ? 'NOT ' : '';
      return `${left} ${not}IN (${values})`;
    }

    try {
      const { toSql } = require('pgsql-ast-parser');
      return toSql.expr(expr);
    } catch {
      return '?';
    }
  }

  private sumChildCost(children: PlanNode[]): { startup: number; total: number } {
    return children.reduce(
      (sum, c) => ({
        startup: sum.startup + c.startupCost,
        total: sum.total + c.totalCost,
      }),
      { startup: 0, total: 0 },
    );
  }

  private detectAggregate(stmt: any): string | false {
    if (!stmt) return false;
    const cols = stmt.columns || stmt.select || [];
    for (const col of cols) {
      const expr = col.expr;
      if (expr?.type === 'call') {
        const fn = String(expr.function?.name || '').toUpperCase();
        if (['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(fn)) {
          return 'hash'; // hash aggregate
        }
      }
    }
    if (stmt.groupBy && stmt.groupBy.length > 0) {
      return 'hash';
    }
    return false;
  }

  private detectEqualityOnPK(where: any, rawSql?: string): boolean {
    // 1) Try AST-level detection (pgsql-ast-parser uses `.op`, not `.operator`)
    if (where && typeof where === 'object') {
      if (where.type === 'binary' && (where.op === '=' || where.operator === '=')) {
        const left = where.left;
        if (left?.type === 'ref') {
          const name = left.name || '';
          if (name === 'id' || name.endsWith('_id')) return true;
        }
      }
    }

    // 2) Fallback: string-level detection
    if (rawSql) {
      const upper = rawSql.toUpperCase();
      return /WHERE\s+(?:id\s*=|.*?_id\s*=)/i.test(upper);
    }

    return false;
  }

  private extractLimitValue(stmt: any): number | undefined {
    if (!stmt.limit) return undefined;
    // pgsql-ast-parser v12: stmt.limit.limit.value
    if (stmt.limit?.limit?.value !== undefined) return stmt.limit.limit.value;
    // pgsql-ast-parser v11: stmt.limit.value
    if (stmt.limit.value !== undefined) return stmt.limit.value;
    // Other
    if (typeof stmt.limit === 'number') return stmt.limit;
    return undefined;
  }

  private applyActuals(node: PlanNode | undefined, executionResult: any[]): void {
    if (!node) return;
    // P0-4: Extract real execution stats from the result array
    // The first element is either a QueryExecutionStats or a regular row
    let execTime = 0.5;
    let actualRows = node.planRows;
    if (executionResult.length > 0) {
      const first = executionResult[0];
      if (first && typeof first.execTimeMs === 'number' && typeof first.actualRows === 'number') {
        // QueryExecutionStats format
        execTime = Math.max(0.01, first.execTimeMs);
        actualRows = first.actualRows;
      } else {
        // Regular row format - use result count as row estimate
        execTime = Math.max(0.01, 0.5); // default for actual rows data
        actualRows = executionResult.length || node.planRows;
      }
    }
    const startupFraction = execTime > 0.6 ? 0.3 : 0.2;
    node.actualStartupTime = execTime * startupFraction;
    node.actualTotalTime = execTime;
    node.actualRows = actualRows;
    node.actualLoops = 1;

    if (node.plans) {
      for (const child of node.plans) {
        this.applyActuals(child, executionResult);
      }
    }
  }

  private flattenPlanTree(node: PlanNode): PlanNode[] {
    const nodes: PlanNode[] = [node];
    if (node.plans) {
      for (const child of node.plans) {
        nodes.push(...this.flattenPlanTree(child));
      }
    }
    return nodes;
  }

  private computeSummary(root: PlanNode): ExplainSummary {
    const nodes = this.flattenPlanTree(root);
    const scanTypeCounts: Record<string, number> = {};
    let deepestLevel = 0;

    for (const node of nodes) {
      scanTypeCounts[node.nodeType] = (scanTypeCounts[node.nodeType] || 0) + 1;
      deepestLevel = Math.max(
        deepestLevel,
        this.getNodeDepth(root, node),
      );
    }

    return {
      totalEstimatedRows: root.planRows,
      totalEstimatedCost: root.totalCost,
      nodeCount: nodes.length,
      deepestLevel,
      scanTypeCounts,
      hasVectorSearch: nodes.some((n) => n.nodeType === 'Vector Search'),
    };
  }

  private getNodeDepth(root: PlanNode, target: PlanNode, depth: number = 0): number {
    if (root === target) return depth;
    if (!root.plans) return -1;
    for (const child of root.plans) {
      const d = this.getNodeDepth(child, target, depth + 1);
      if (d >= 0) return d;
    }
    return -1;
  }

  // ══════════════════════════════════════════════════════════════
  //  buildExplainPlan — Public PostgreSQL-style plan tree builder
  // ══════════════════════════════════════════════════════════════

  /**
   * buildExplainPlan — Build a PostgreSQL-style EXPLAIN plan tree from a SQL statement.
   *
   * Returns an ExplainNode tree conforming to the PostgreSQL EXPLAIN output structure,
   * with proper Node Type, cost estimation, row estimates, and nested child plans.
   *
   * Supports:
   * - SELECT (single table, JOIN, GROUP BY, ORDER BY, LIMIT)
   * - INSERT / UPDATE / DELETE
   * - DDL statements
   * - Vector Search
   * - EXPLAIN ANALYZE (with actual timing when executionResult is provided)
   *
   * @param sql - The inner SQL statement (without EXPLAIN prefix)
   * @param executionResult - Optional actual execution result for ANALYZE mode
   * @returns ExplainNode tree (PostgreSQL-compatible structure)
   */
  buildExplainPlan(
    sql: string,
    executionResult?: any[] | QueryExecutionStats,
  ): ExplainNode {
    // Use the existing buildPlanTree under the hood, then convert
    const planNode = this.buildPlanTree(sql, executionResult);
    return ExplainHandler.planNodeToExplainNode(planNode);
  }

  /**
   * Convert an internal PlanNode to the public ExplainNode structure.
   * Handles all node types and preserves child plan trees.
   */
  static planNodeToExplainNode(plan: PlanNode): ExplainNode {
    const node: ExplainNode = {
      NodeType: plan.nodeType,
      StartupCost: plan.startupCost,
      TotalCost: plan.totalCost,
      PlanRows: plan.planRows,
      PlanWidth: plan.planWidth,
      RelationName: plan.relationName,
      Filter: plan.filter,
      IndexName: plan.indexName,
      IndexCond: plan.indexCond,
      SortKey: plan.sortKey,
      Strategy: plan.strategy,
      HashCond: plan.hashCond,
      JoinType: plan.joinType,
      Alias: plan.alias,
      ActualStartupTime: plan.actualStartupTime,
      ActualTotalTime: plan.actualTotalTime,
      ActualRows: plan.actualRows,
      ActualLoops: plan.actualLoops !== undefined ? plan.actualLoops : 1,
    };

    // Convert children
    if (plan.plans && plan.plans.length > 0) {
      node.Plans = plan.plans.map(child => ExplainHandler.planNodeToExplainNode(child));
    }

    return node;
  }

  /**
   * Serialize an ExplainNode tree to a JSON-compatible plain object.
   * Matches PostgreSQL's EXPLAIN (FORMAT JSON) output structure.
   */
  static explainNodeToJson(
    node: ExplainNode,
  ): Record<string, any> {
    const result: Record<string, any> = {
      'Node Type': node.NodeType,
      'Startup Cost': node.StartupCost,
      'Total Cost': node.TotalCost,
      'Plan Rows': node.PlanRows,
      'Plan Width': node.PlanWidth,
    };

    if (node.RelationName) result['Relation Name'] = node.RelationName;
    if (node.OutputColumns && node.OutputColumns.length > 0) result['Output Columns'] = node.OutputColumns;
    if (node.Filter) result['Filter'] = node.Filter;
    if (node.IndexName) result['Index Name'] = node.IndexName;
    if (node.IndexCond) result['Index Cond'] = node.IndexCond;
    if (node.OneTimeFilter) result['One-Time Filter'] = node.OneTimeFilter;
    if (node.SortKey) result['Sort Key'] = node.SortKey;
    if (node.Strategy) result['Strategy'] = node.Strategy;
    if (node.HashCond) result['Hash Cond'] = node.HashCond;
    if (node.JoinType) result['Join Type'] = node.JoinType;
    if (node.Alias) result['Alias'] = node.Alias;

    // EXPLAIN ANALYZE fields
    if (node.ActualStartupTime !== undefined) result['Actual Startup Time'] = node.ActualStartupTime;
    if (node.ActualTotalTime !== undefined) result['Actual Total Time'] = node.ActualTotalTime;
    if (node.ActualRows !== undefined) result['Actual Rows'] = node.ActualRows;
    if (node.ActualLoops !== undefined) result['Actual Loops'] = node.ActualLoops;

    // Child plans
    if (node.Plans && node.Plans.length > 0) {
      result['Plans'] = node.Plans.map(child => ExplainHandler.explainNodeToJson(child));
    }

    return result;
  }

  /**
   * Render an ExplainNode tree as YAML-formatted string.
   * Matches PostgreSQL's EXPLAIN (FORMAT YAML) output structure.
   */
  static explainNodeToYaml(node: ExplainNode, depth: number = 0): string[] {
    const indent = '  '.repeat(depth);
    const lines: string[] = [];

    lines.push(`${indent}- `);
    lines.push(`${indent}  Node Type: ${node.NodeType}`);
    lines.push(`${indent}  Startup Cost: ${node.StartupCost}`);
    lines.push(`${indent}  Total Cost: ${node.TotalCost}`);
    lines.push(`${indent}  Plan Rows: ${node.PlanRows}`);
    lines.push(`${indent}  Plan Width: ${node.PlanWidth}`);

    if (node.RelationName) lines.push(`${indent}  Relation Name: ${node.RelationName}`);
    if (node.OutputColumns && node.OutputColumns.length > 0) {
      lines.push(`${indent}  Output Columns:`);
      for (const col of node.OutputColumns) {
        lines.push(`${indent}    - ${col}`);
      }
    }
    if (node.Filter) lines.push(`${indent}  Filter: ${node.Filter}`);
    if (node.IndexName) lines.push(`${indent}  Index Name: ${node.IndexName}`);
    if (node.IndexCond) lines.push(`${indent}  Index Cond: ${node.IndexCond}`);
    if (node.SortKey) lines.push(`${indent}  Sort Key: ${node.SortKey}`);
    if (node.Strategy) lines.push(`${indent}  Strategy: ${node.Strategy}`);
    if (node.HashCond) lines.push(`${indent}  Hash Cond: ${node.HashCond}`);
    if (node.JoinType) lines.push(`${indent}  Join Type: ${node.JoinType}`);

    // ANALYZE
    if (node.ActualStartupTime !== undefined) lines.push(`${indent}  Actual Startup Time: ${node.ActualStartupTime}`);
    if (node.ActualTotalTime !== undefined) lines.push(`${indent}  Actual Total Time: ${node.ActualTotalTime}`);
    if (node.ActualRows !== undefined) lines.push(`${indent}  Actual Rows: ${node.ActualRows}`);
    if (node.ActualLoops !== undefined) lines.push(`${indent}  Actual Loops: ${node.ActualLoops}`);

    // Children
    if (node.Plans && node.Plans.length > 0) {
      lines.push(`${indent}  Plans:`);
      for (const child of node.Plans) {
        const childLines = ExplainHandler.explainNodeToYaml(child, depth + 2);
        lines.push(...childLines);
      }
    }

    return lines;
  }

  /**
   * Format the full explain result as the requested output format.
   * Used for EXPLAIN (FORMAT JSON) and EXPLAIN (FORMAT YAML) modes.
   */
  formatExplainOutput(
    explainNode: ExplainNode,
    planningTime?: number,
    executionTime?: number,
  ): string {
    const format = this.options.format || 'text';

    switch (format) {
      case 'json': {
        const result: Record<string, any> = {};
        result['Query Plan'] = ExplainHandler.explainNodeToJson(explainNode);
        if (planningTime !== undefined) result['Planning Time'] = Math.round(planningTime * 100) / 100;
        if (executionTime !== undefined) result['Execution Time'] = Math.round(executionTime * 100) / 100;
        return JSON.stringify(result, null, 2);
      }

      case 'yaml': {
        const lines: string[] = [];
        lines.push('Query Plan:');
        const planLines = ExplainHandler.explainNodeToYaml(explainNode, 1);
        lines.push(...planLines);
        if (planningTime !== undefined) {
          lines.push(`Planning Time: ${Math.round(planningTime * 100) / 100}`);
        }
        if (executionTime !== undefined) {
          lines.push(`Execution Time: ${Math.round(executionTime * 100) / 100}`);
        }
        return lines.join('\n');
      }

      case 'text':
      default: {
        return this.formatPlanTree(
          this.buildPlanTree(
            '', // dummy — we already have the plan
          ),
        );
      }
    }
  }

  /**
   * Build full ExplainResult including plan tree text, JSON, and summary.
   * Enhanced version of buildPlan() that supports FORMAT JSON and FORMAT YAML.
   */
  buildPlanWithFormat(sql: string, executionResult?: any[] | QueryExecutionStats): ExplainResult {
    // Parse EXPLAIN options from SQL if present
    const { innerSql, options } = ExplainHandler.isExplainStatement(sql)
      ? ExplainHandler.stripExplain(sql)
      : { innerSql: sql, options: this.options };

    this.options = { ...this.options, ...options };

    // Build the plan tree
    const planResult = !Array.isArray(executionResult) && executionResult
      ? (executionResult as QueryExecutionStats).resultRows ?? []
      : executionResult as any[] | undefined;

    // Build internal PlanNode for summary computation
    const planNode = this.buildPlanTree(innerSql, planResult);

    // Convert to ExplainNode for output
    const explainNode = ExplainHandler.planNodeToExplainNode(planNode);

    const planningTime = performance.now() - (executionResult ? 0 : 0);
    const formatStart = performance.now();

    // Format according to output format
    let planText: string;
    const format = this.options.format || 'text';

    switch (format) {
      case 'json': {
        const jsonObj: Record<string, any> = {};
        jsonObj['Query Plan'] = ExplainHandler.explainNodeToJson(explainNode);
        jsonObj['Planning Time'] = Math.round((performance.now() - formatStart) * 100) / 100;
        if (this.options.analyze && explainNode.ActualTotalTime !== undefined) {
          jsonObj['Execution Time'] = Math.round(explainNode.ActualTotalTime * 100) / 100;
        }
        planText = JSON.stringify(jsonObj, null, 2);
        break;
      }

      case 'yaml': {
        const yamlLines: string[] = [];
        yamlLines.push('Query Plan:');
        const planLines = ExplainHandler.explainNodeToYaml(explainNode, 0);
        yamlLines.push(...planLines);
        planText = yamlLines.join('\n');
        break;
      }

      case 'text':
      default: {
        planText = this.formatPlanTree(planNode);
        break;
      }
    }

    const summary = this.computeSummary(planNode);

    return {
      planText,
      planNodes: this.flattenPlanTree(planNode),
      planningTime,
      executionTime: this.options.analyze
        ? planNode.actualTotalTime ?? undefined
        : undefined,
      summary,
      outputFormat: this.options.format || 'text',
    };
  }

  // ══════════════════════════════════════════════════════════════
  //  P17e: EXPLAIN output formatters (PostgreSQL-compatible)
  // ══════════════════════════════════════════════════════════════

  /**
   * Convert the plan tree into rows suitable for PG wire protocol response.
   *
   * Each line of the formatted plan becomes one row with a "QUERY PLAN" column,
   * matching PostgreSQL's `EXPLAIN (FORMAT TEXT)` output.
   *
   * @param planText  The formatted plan text (from `formatPlanTree`)
   * @returns         Array of rows, each with { "QUERY PLAN": "<line>" }
   */
  static toQueryPlanRows(planText: string): Array<{ 'QUERY PLAN': string }> {
    return planText
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ 'QUERY PLAN': line }));
  }

  /**
   * Serialize the plan tree as a JSON-compatible object.
   *
   * Each PlanNode is converted to a plain object with all properties,
   * and child plans are nested recursively. This can be used for
   * `EXPLAIN (FORMAT JSON)` output.
   *
   * @param node  The root PlanNode to serialize
   * @returns     A plain JSON-serializable object
   */
  static planNodeToJson(node: PlanNode): Record<string, any> {
    const result: Record<string, any> = {
      'Node Type': node.nodeType,
      'Startup Cost': node.startupCost,
      'Total Cost': node.totalCost,
      'Plan Rows': node.planRows,
      'Plan Width': node.planWidth,
    };

    if (node.relationName) result['Relation Name'] = node.relationName;
    if (node.filter) result['Filter'] = node.filter;
    if (node.indexName) result['Index Name'] = node.indexName;
    if (node.indexCond) result['Index Cond'] = node.indexCond;
    if (node.sortKey) result['Sort Key'] = node.sortKey;
    if (node.strategy) result['Strategy'] = node.strategy;
    if (node.hashCond) result['Hash Cond'] = node.hashCond;
    if (node.joinType) result['Join Type'] = node.joinType;
    if (node.alias) result['Alias'] = node.alias;

    // EXPLAIN ANALYZE fields
    if (node.actualStartupTime !== undefined) result['Actual Startup Time'] = node.actualStartupTime;
    if (node.actualTotalTime !== undefined) result['Actual Total Time'] = node.actualTotalTime;
    if (node.actualRows !== undefined) result['Actual Rows'] = node.actualRows;

    // Child plans
    if (node.plans && node.plans.length > 0) {
      result['Plans'] = node.plans.map((child) => ExplainHandler.planNodeToJson(child));
    }

    return result;
  }

  /**
   * Convert the full plan tree to a JSON structure (suitable for FORMAT JSON).
   *
   * @param root           The root PlanNode
   * @param options        The explain options (to include Timing, etc.)
   * @param planningTime   Planning time in ms
   * @param executionTime  Optional execution time in ms
   * @returns              A JSON-serializable object
   */
  static planTreeToJson(
    root: PlanNode,
    options?: ExplainOptions,
    planningTime?: number,
    executionTime?: number,
  ): Record<string, any> {
    const result: Record<string, any> = {
      'Query Plan': ExplainHandler.planNodeToJson(root),
      'Planning Time': planningTime !== undefined ? Math.round(planningTime * 100) / 100 : undefined,
    };

    if (executionTime !== undefined) {
      result['Execution Time'] = Math.round(executionTime * 100) / 100;
    }

    // Options metadata
    if (options) {
      result['Options'] = {
        'Analyze': options.analyze || false,
        'Verbose': options.verbose || false,
        'Costs': options.costs !== false,
        'Timing': options.timing !== false,
        'Format': options.format || 'text',
      };
    }

    return result;
  }

  /**
   * Convert an ExplainResult into PostgreSQL-compatible query result rows.
   *
   * For text format (default): returns rows with "QUERY PLAN" column,
   * one row per line of plan text.
   *
   * For JSON format: returns a single row with the JSON serialization
   * as the "QUERY PLAN" value.
   *
   * For YAML format: returns a single row with the YAML serialization
   * as the "QUERY PLAN" value.
   *
   * @param explainResult  The ExplainResult from buildPlan()
   * @returns              Array of row objects for protocol response
   */
  static explainResultToRows(
    explainResult: ExplainResult,
  ): Array<Record<string, any>> {
    if (explainResult.outputFormat === 'json') {
      // JSON format: single row with JSON as text
      const jsonObj = ExplainHandler.planTreeToJson(
        explainResult.planNodes[0],
        { format: 'json' },
        explainResult.planningTime,
        explainResult.executionTime,
      );
      return [{ 'QUERY PLAN': JSON.stringify(jsonObj, null, 2) }];
    }

    // For YAML/text, use the planText which is already properly formatted
    return ExplainHandler.toQueryPlanRows(explainResult.planText);
  }
}
