/**
 * QueryPlanner — 基于代价的查询计划器
 *
 * 接收 SQL 查询、可用索引和统计信息，生成多个候选计划并选择代价最低的方案。
 * 支持连接顺序优化（小表驱动大表）、选择性估计、候选计划生成等功能。
 *
 * 设计参考 PostgreSQL 的代价优化思想。当前使用贪婪算法（小表优先）进行
 * 连接排序；未来可升级为 DP (dynamic programming) join enumeration 以获得
 * 更优的连接顺序计划。
 */

import { CostModel, type CostFactors, type TableStats, type ScanCost } from './CostModel';

// Re-export commonly used types so external consumers don't need to import CostModel directly.
export type { TableStats, ScanCost, CostFactors };

// ── 类型定义 ──

export type CandidatePlanType =
  | 'sequential-scan'
  | 'index-scan'
  | 'nested-loop-join'
  | 'hash-join'
  | 'merge-join'
  | 'parallel-scan'
  | 'semi-join'
  | 'anti-join'
  | 'left-join'
  | 'right-join'
  | 'full-outer-join'
  | 'outer-join'
  | 'sort'
  | 'aggregate'
  | 'window'
  | 'sort-aggregate'
  | 'top-n-heap'
  | 'disk-sort';

export interface SortKey {
  column: string;
  order: 'ASC' | 'DESC';
  nulls: 'first' | 'last';
}

export interface CandidatePlan {
  type: CandidatePlanType;
  startupCost: number;
  totalCost: number;
  rows: number;
  width: number;
  description: string;
  children?: CandidatePlan[];
  /** 如果该计划天然生成有序结果（如索引排序扫描），标记排序列 */
  sortedBy?: string;
  /** 该计划对应的过滤条件（由 plan() 入口填充，供 PlanExecutor 使用） */
  conditions?: QueryCondition[];
}

export interface IndexDef {
  /** 索引名称 */
  name: string;
  /** 所属表名 */
  tableName: string;
  /** 索引列 */
  columns: string[];
  /** 是否唯一 */
  unique: boolean;
  /** 是否是主键 */
  primary: boolean;
}

export interface JoinCondition {
  /** 左表 */
  leftTable: string;
  /** 左列 */
  leftColumn: string;
  /** 右表 */
  rightTable: string;
  /** 右列 */
  rightColumn: string;
  /** 运算符（默认 =） */
  operator: string;
}

export interface QueryCondition {
  /** 表名 */
  table: string;
  /** 列名 */
  column: string;
  /** 运算符 */
  operator: string;
  /** 值（字符串表示） */
  value: string;
  /** 是否精确匹配（=） */
  exact: boolean;
}

export interface TableJoinInfo {
  /** 表名 */
  name: string;
  /** 该表的统计信息 */
  stats: TableStats;
  /** 该表的扫描代价 */
  scanCost: ScanCost;
  /** 该表上的过滤条件 */
  conditions: QueryCondition[];
}

export interface OptimizedJoinOrder {
  /** 连接顺序（按代价排序） */
  order: string[];
  /** 最佳连接计划的代价 */
  totalCost: number;
  /** 最佳连接计划 */
  plan: CandidatePlan;
}

// ── Subquery unnesting types ──

export interface UnnestableInfo {
  type: 'IN_SUBQUERY' | 'EXISTS_SUBQUERY';
  parentTable: string;
  subqueryTable: string;
  correlationColumns: Array<{ parent: string; subquery: string }>;
  parentColumn: string;
  subqueryColumn: string;
  originalSubquery: string;
}

// ── QueryPlanner 类 ──

export class QueryPlanner {
  private costModel: CostModel;

  constructor(costModel?: CostModel) {
    this.costModel = costModel ?? new CostModel();
  }

  /**
   * 获取底层代价模型（用于外部配置）。
   */
  getCostModel(): CostModel {
    return this.costModel;
  }

  // ── 选择性估计 ──

  /**
   * 估计查询条件的选择率（0..1）。
   *
   * - 精确匹配（=）：1 / nDistinct（假设均匀分布）
   * - 范围查询（<, <=, >, >=）：33%（PostgreSQL 默认估计值）
   * - LIKE 模式匹配：10%（PostgreSQL 默认猜测）
   * - IN 或复杂条件：50%
   * - 其他（<> 等）：1 - 1/nDistinct
   *
   * @param condition 查询条件
   * @param stats 表统计信息
   * @returns 选择率（0..1）
   */
  estimateSelectivity(condition: QueryCondition, stats: TableStats): number {
    const nDistinct = stats.nDistinct.get(condition.column) ?? stats.reltuples;
    const n = Math.max(1, nDistinct);

    switch (condition.operator) {
      case '=':
      case '==':
        return condition.exact ? 1 / n : 1 / n;
      case '<':
      case '<=':
      case '>':
      case '>=':
        // 范围查询：PostgreSQL 中估计为 ~33%
        return 1 / 3;
      case 'LIKE':
      case 'ILIKE':
        // LIKE 模式匹配：PostgreSQL 猜测 ~10%
        return 0.1;
      case 'IN':
        // IN 子句：假设平均行数
        return 1 / n;
      case '<>':
      case '!=':
        // 不等
        return 1 - 1 / n;
      case 'IS NULL':
        return 0.01; // 少量 NULL
      case 'IS NOT NULL':
        return 0.99;
      default:
        return 0.5; // 默认推测
    }
  }

  /**
   * 估计复合条件（AND/OR）的输出行数。
   */
  estimateOutputRows(
    stats: TableStats,
    conditions: QueryCondition[],
  ): number {
    if (conditions.length === 0) return stats.reltuples;

    let combinedSelectivity = 1;
    for (const cond of conditions) {
      const sel = this.estimateSelectivity(cond, stats);
      combinedSelectivity *= sel; // 假设 AND 连接（独立条件）
    }

    return Math.ceil(stats.reltuples * Math.min(1, combinedSelectivity));
  }

  // ── 候选计划生成 ──

  /**
   * 为一张表的查询生成所有候选扫描计划。
   *
   * @param tableName 表名
   * @param stats 统计信息
   * @param availableIndexes 该表上的可用索引
   * @param conditions 该表上的过滤条件
   * @returns 候选计划列表
   */
  generateScanPlans(
    tableName: string,
    stats: TableStats,
    availableIndexes: IndexDef[],
    conditions: QueryCondition[],
  ): CandidatePlan[] {
    const plans: CandidatePlan[] = [];
    const outputRows = this.estimateOutputRows(stats, conditions);

    // 1. 全表扫描
    const seqCost = this.costModel.seqScanCost(stats);
    plans.push({
      type: 'sequential-scan',
      startupCost: seqCost.startupCost,
      totalCost: seqCost.totalCost,
      rows: outputRows,
      width: 0,
      description: `Seq Scan on ${tableName} (rows=${outputRows}, cost=${seqCost.totalCost.toFixed(2)})`,
    });

    // 2. 并行扫描（如果有足够行数）
    if (stats.reltuples > 1000) {
      const parCost = this.costModel.parallelScanCost(stats, 4);
      plans.push({
        type: 'parallel-scan',
        startupCost: parCost.startupCost,
        totalCost: parCost.totalCost,
        rows: outputRows,
        width: 0,
        description: `Parallel Seq Scan on ${tableName} (rows=${outputRows}, cost=${parCost.totalCost.toFixed(2)})`,
      });
    }

    // 3. 索引扫描（对每个可用索引）
    for (const idx of availableIndexes) {
      // 计算该索引能匹配的条件选择性
      let indexSelectivity = 1;
      for (const cond of conditions) {
        if (idx.columns.includes(cond.column)) {
          const sel = this.estimateSelectivity(cond, stats);
          indexSelectivity *= sel;
        }
      }

      if (indexSelectivity >= 1) {
        // 索引没有显著过滤效果则跳过
        continue;
      }

      const idxCost = this.costModel.indexScanCost(stats, indexSelectivity);
      plans.push({
        type: 'index-scan',
        startupCost: idxCost.startupCost,
        totalCost: idxCost.totalCost,
        rows: Math.ceil(outputRows * indexSelectivity),
        width: 0,
        description: `Index Scan using ${idx.name} on ${tableName} (sel=${indexSelectivity.toFixed(4)}, cost=${idxCost.totalCost.toFixed(2)})`,
      });
    }

    return plans;
  }

  /**
   * 为整个查询生成所有候选计划。
   *
   * @param sql SQL 语句（当前用于描述，计划生成基于提供的统计信息）
   * @param availableIndexes 所有可用索引
   * @param stats 表名 → 统计信息
   * @returns 候选计划列表
   */
  generatePlans(
    sql: string,
    availableIndexes: IndexDef[],
    stats: Map<string, TableStats>,
  ): CandidatePlan[] {
    const plans: CandidatePlan[] = [];

    for (const [tableName, tableStats] of stats) {
      const tableIndexes = availableIndexes.filter(
        idx => idx.tableName === tableName,
      );
      const scanPlans = this.generateScanPlans(
        tableName,
        tableStats,
        tableIndexes,
        [],
      );
      plans.push(...scanPlans);
    }

    return plans;
  }

  /**
   * 生成连接计划候选。
   */
  generateJoinPlans(
    left: CandidatePlan,
    right: CandidatePlan,
    conditions: JoinCondition[],
  ): CandidatePlan[] {
    const plans: CandidatePlan[] = [];

    // 选择性估计：使用连接条件的平均选择性
    let selectivity = 1;
    if (conditions.length > 0) {
      // 连接条件通常具有较高的选择性
      selectivity = 1 / Math.max(left.rows, right.rows);
      // 多个条件累积
      selectivity = Math.min(1, selectivity * conditions.length);
    }

    // 1. Nested Loop Join
    const nlCost = new CostModel().nestedLoopCost(
      { startupCost: left.startupCost, totalCost: left.totalCost, rows: left.rows, width: left.width },
      { startupCost: right.startupCost, totalCost: right.totalCost, rows: right.rows, width: right.width },
      selectivity,
    );
    plans.push({
      type: 'nested-loop-join',
      startupCost: nlCost.startupCost,
      totalCost: nlCost.totalCost,
      rows: nlCost.rows,
      width: nlCost.width,
      description: `Nested Loop Join (${left.rows} × ${right.rows}, cost=${nlCost.totalCost.toFixed(2)})`,
      children: [left, right],
    });

    // 2. Hash Join
    const hjCost = new CostModel().hashJoinCost(
      { startupCost: left.startupCost, totalCost: left.totalCost, rows: left.rows, width: left.width },
      { startupCost: right.startupCost, totalCost: right.totalCost, rows: right.rows, width: right.width },
      selectivity,
    );
    plans.push({
      type: 'hash-join',
      startupCost: hjCost.startupCost,
      totalCost: hjCost.totalCost,
      rows: hjCost.rows,
      width: hjCost.width,
      description: `Hash Join (${left.rows} × ${right.rows}, cost=${hjCost.totalCost.toFixed(2)})`,
      children: [left, right],
    });

    // 3. Merge Join
    const sortCostOuter = this.costModel.getCostFactors().cpuOperatorCost *
      Math.max(1, left.rows) * Math.log2(Math.max(1, left.rows));
    const sortCostInner = this.costModel.getCostFactors().cpuOperatorCost *
      Math.max(1, right.rows) * Math.log2(Math.max(1, right.rows));
    const mjCost = new CostModel().mergeJoinCost(
      { startupCost: left.startupCost, totalCost: left.totalCost, rows: left.rows, width: left.width },
      { startupCost: right.startupCost, totalCost: right.totalCost, rows: right.rows, width: right.width },
      { outerSort: sortCostOuter, innerSort: sortCostInner },
      selectivity,
    );
    plans.push({
      type: 'merge-join',
      startupCost: mjCost.startupCost,
      totalCost: mjCost.totalCost,
      rows: mjCost.rows,
      width: mjCost.width,
      description: `Merge Join (${left.rows} × ${right.rows}, cost=${mjCost.totalCost.toFixed(2)})`,
      children: [left, right],
    });

    return plans;
  }

  // ── 计划选择 ──

  /**
   * 从候选计划列表中选择代价最低的计划。
   * 比较规则：先比 totalCost，相同时比 startupCost。
   *
   * @param plans 候选计划列表
   * @returns 最佳计划（如果列表为空返回 null）
   */
  chooseBestPlan(plans: CandidatePlan[]): CandidatePlan | null {
    if (plans.length === 0) return null;

    return plans.reduce((best, current) => {
      if (current.totalCost < best.totalCost) return current;
      if (current.totalCost === best.totalCost &&
          current.startupCost < best.startupCost) return current;
      return best;
    });
  }

  // ── 连接顺序优化 ──

  /**
   * 多表连接顺序优化（使用贪婪算法近似最优解）。
   *
   * 核心策略：小表驱动大表（small-table-first）。
   * 1. 按扫描代价对所有表排序
   * 2. 从最小的表开始，逐步加入当前最低代价的连接
   *
   * @param tables 参与连接的表信息
   * @param conditions 连接条件
   * @returns 优化后的连接顺序和代价
   */
  optimizeJoinOrder(
    tables: TableJoinInfo[],
    conditions: JoinCondition[],
  ): OptimizedJoinOrder {
    if (tables.length === 0) {
      throw new Error('No tables provided for join optimization');
    }
    if (tables.length === 1) {
      const t = tables[0];
      return {
        order: [t.name],
        totalCost: t.scanCost.totalCost,
        plan: {
          type: 'sequential-scan',
          startupCost: t.scanCost.startupCost,
          totalCost: t.scanCost.totalCost,
          rows: t.scanCost.rows,
          width: t.scanCost.width,
          description: `Seq Scan on ${t.name}`,
        },
      };
    }

    // 1. 按扫描代价排序（小表优先）
    const sortedTables = [...tables].sort(
      (a, b) => a.scanCost.totalCost - b.scanCost.totalCost,
    );

    // 2. 贪婪连接顺序
    const remaining = [...sortedTables];
    const currentOrder: string[] = [];
    let currentPlan: CandidatePlan = {
      type: 'sequential-scan',
      startupCost: remaining[0].scanCost.startupCost,
      totalCost: remaining[0].scanCost.totalCost,
      rows: remaining[0].scanCost.rows,
      width: remaining[0].scanCost.width,
      description: `Scan on ${remaining[0].name}`,
    };
    currentOrder.push(remaining[0].name);
    remaining.shift();

    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestCost = Infinity;
      let bestJoinPlan: CandidatePlan | null = null;

      for (let i = 0; i < remaining.length; i++) {
        const nextTable = remaining[i];

        // 检查是否有连接条件
        const relevantConditions = conditions.filter(
          c =>
            (c.leftTable === currentOrder[currentOrder.length - 1] &&
              c.rightTable === nextTable.name) ||
            (c.rightTable === currentOrder[currentOrder.length - 1] &&
              c.leftTable === nextTable.name),
        );

        // 尝试两种连接顺序（当前计划为左表或右表）
        const nextScanAsPlan: CandidatePlan = {
          type: 'sequential-scan',
          startupCost: nextTable.scanCost.startupCost,
          totalCost: nextTable.scanCost.totalCost,
          rows: nextTable.scanCost.rows,
          width: nextTable.scanCost.width,
          description: `Scan on ${nextTable.name}`,
        };
        const nlPlans = this.generateJoinPlans(
          currentPlan,
          nextScanAsPlan,
          relevantConditions,
        );

        const bestForThisTable = this.chooseBestPlan(nlPlans);
        if (bestForThisTable && bestForThisTable.totalCost < bestCost) {
          bestCost = bestForThisTable.totalCost;
          bestIdx = i;
          bestJoinPlan = bestForThisTable;
        }
      }

      currentPlan = bestJoinPlan!;
      currentOrder.push(remaining[bestIdx].name);
      remaining.splice(bestIdx, 1);
    }

    return {
      order: currentOrder,
      totalCost: currentPlan.totalCost,
      plan: currentPlan,
    };
  }

  // ── 并行评估 ──

  /**
   * 判断是否应该使用并行执行。
   * 基于表大小和并行扫描代价与顺序扫描代价的比值。
   */
  shouldUseParallel(
    stats: TableStats,
    parallelWorkers: number = 4,
    threshold: number = 0.8,
  ): boolean {
    return this.costModel.shouldUseParallel(stats, parallelWorkers, threshold);
  }

  // ══════════════════════════════════════════════════════════════
  //  Subquery Unnesting (SQL-level rewriting)
  // ══════════════════════════════════════════════════════════════

  /**
   * Detect and return information about unnestable subqueries in a SQL string.
   *
   * Detects two patterns:
   *   1. `WHERE x IN (SELECT y FROM t2 WHERE ...)` — IN-subquery
   *   2. `WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.col = t1.col)` — EXISTS correlated subquery
   *
   * @param sql The SQL string to inspect.
   * @returns UnnestableInfo if an unnestable subquery is found, or null otherwise.
   */
  detectUnnestableSubquery(sql: string): UnnestableInfo | null {
    if (!sql || typeof sql !== 'string') return null;
    const trimmed = sql.trim();

    // Only inspect SELECT statements
    if (!/^\s*SELECT\b/i.test(trimmed)) return null;

    // --- Pattern 1: IN subquery ---
    // Looks for: WHERE col IN (SELECT col2 FROM table WHERE ...)
    // Extract the first table from FROM clause for parentTable
    const parentTableMatch = trimmed.match(/\bFROM\s+(\w+)\b/i);
    const parentTable = parentTableMatch ? parentTableMatch[1] : '';

    const inSubqueryPattern = /WHERE\s+(\w+(?:\.\w+)?)\s+IN\s*\(\s*SELECT\s+(\w+(?:\.\w+)?)\s+FROM\s+(\w+)/i;
    const inMatch = trimmed.match(inSubqueryPattern);
    if (inMatch) {
      const parentCol = inMatch[1];       // e.g., "t1.id" or "id"
      const subqueryCol = inMatch[2];     // e.g., "t2.id" or "id"
      const subqueryTable = inMatch[3];   // e.g., "t2"

      // Determine correlation: check if there's a WHERE in the subquery referencing parent table
      const subqueryStart = trimmed.indexOf('SELECT', inMatch.index! + 1);
      // Find matching paren for the IN subquery
      const inOpenParen = trimmed.indexOf('(', inMatch.index!);
      if (inOpenParen < 0) return null;
      const closingParen = findMatchingParen(trimmed, inOpenParen);
      const subqueryBody = subqueryStart >= 0 && closingParen > subqueryStart
        ? trimmed.substring(subqueryStart, closingParen + 1)
        : '';

      // Extract the subquery's WHERE clause to find correlation
      const sqWhereMatch = subqueryBody.match(/WHERE\s+(.+?)$/i);
      const correlationCols: Array<{ parent: string; subquery: string }> = [];

      if (sqWhereMatch && parentTable) {
        // Look for patterns like t1.col = t2.col inside subquery WHERE
        const sqWhereMatchBody = sqWhereMatch[1];
        // Match both directions: t1.col = t2.col AND t2.col = t1.col
        const corrFwdPattern = new RegExp(
          `${parentTable}\\.(\\w+)\\s*=\\s*${subqueryTable}\\.(\\w+)`,
          'gi',
        );
        const corrRevPattern = new RegExp(
          `${subqueryTable}\\.(\\w+)\\s*=\\s*${parentTable}\\.(\\w+)`,
          'gi',
        );
        let corrMatch;
        while ((corrMatch = corrFwdPattern.exec(sqWhereMatchBody)) !== null) {
          correlationCols.push({ parent: corrMatch[1], subquery: corrMatch[2] });
        }
        while ((corrMatch = corrRevPattern.exec(sqWhereMatchBody)) !== null) {
          correlationCols.push({ parent: corrMatch[2], subquery: corrMatch[1] });
        }
      }

      return {
        type: 'IN_SUBQUERY',
        parentTable,
        subqueryTable,
        correlationColumns: correlationCols,
        parentColumn: parentCol,
        subqueryColumn: subqueryCol,
        originalSubquery: subqueryBody,
      };
    }

    // --- Pattern 2: EXISTS correlated subquery ---
    // Looks for: WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.col = t1.col)
    const existsPattern = /WHERE\s+EXISTS\s*\(\s*SELECT\s+(?:\d+|1|\*)\s+FROM\s+(\w+)\s+WHERE\s+(.+?)\)/i;
    const existsMatch = trimmed.match(existsPattern);
    if (existsMatch && parentTable) {
      const subqueryTable = existsMatch[1];
      const whereBody = existsMatch[2];

      // Extract correlation columns: match both directions
      const correlationCols: Array<{ parent: string; subquery: string }> = [];
      const corrFwdPattern = new RegExp(
        `${parentTable}\\.(\\w+)\\s*=\\s*${subqueryTable}\\.(\\w+)`,
        'gi',
      );
      const corrRevPattern = new RegExp(
        `${subqueryTable}\\.(\\w+)\\s*=\\s*${parentTable}\\.(\\w+)`,
        'gi',
      );
      let corrMatch;
      while ((corrMatch = corrFwdPattern.exec(whereBody)) !== null) {
        correlationCols.push({ parent: corrMatch[1], subquery: corrMatch[2] });
      }
      while ((corrMatch = corrRevPattern.exec(whereBody)) !== null) {
        correlationCols.push({ parent: corrMatch[2], subquery: corrMatch[1] });
      }

      // Find the original subquery text
      const existsIdx = trimmed.indexOf('EXISTS', existsMatch.index!);
      const closingParen = findMatchingParen(trimmed, trimmed.indexOf('(', existsIdx));
      const originalSubquery = closingParen > existsIdx
        ? trimmed.substring(trimmed.indexOf('(', existsIdx), closingParen + 1)
        : `(${existsMatch[0]})`;

      return {
        type: 'EXISTS_SUBQUERY',
        parentTable,
        subqueryTable,
        correlationColumns: correlationCols,
        parentColumn: '',
        subqueryColumn: '',
        originalSubquery,
      };
    }

    return null;
  }

  /**
   * Rewrite a SQL statement by unnesting a detected subquery.
   *
   * - IN subqueries → rewritten as SEMI JOIN (with SQL comment annotation)
   *   Example: `WHERE x IN (SELECT y FROM t2 WHERE ...)`
   *   → `/* SEMI JOIN t2 ON x = y *​/ ... INNER JOIN t2 ON x = y`
   *
   * - EXISTS correlated subqueries → rewritten as INNER JOIN with DISTINCT
   *   Example: `WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.id = t1.id)`
   *   → `/* SEMI JOIN t2 ON t2.id = t1.id *​/ ... INNER JOIN (SELECT DISTINCT id FROM t2) AS _sq ON _sq.id = t1.id`
   *
   * @param sql The original SQL string.
   * @param info The UnnestableInfo from detectUnnestableSubquery().
   * @returns The rewritten SQL string.
   */
  unnestSubquery(sql: string, info: UnnestableInfo): string {
    if (!sql || !info) return sql ?? '';

    const trimmed = sql.trim();
    const { type, parentTable, subqueryTable, correlationColumns, parentColumn, subqueryColumn } = info;

    if (type === 'IN_SUBQUERY') {
      // Extract the parent column name (strip table prefix)
      const parentCol = parentColumn.includes('.')
        ? parentColumn.split('.')[1]
        : parentColumn;
      const sqCol = subqueryColumn.includes('.')
        ? subqueryColumn.split('.')[1]
        : subqueryColumn;

      // Strip the table qualifier if present
      const tableRef = parentColumn.includes('.') ? parentColumn.split('.')[0] : parentTable;

      // Build the rewritten SQL:
      // Find the IN subquery portion and replace with a SEMI JOIN annotation + rewritten join
      const inParenIdx = trimmed.indexOf('(');
      const closingParen = findMatchingParen(trimmed, inParenIdx);

      // Strategy: find the WHERE clause containing IN and replace it
      // with a commented SEMI JOIN
      const inWherePattern = new RegExp(
        `WHERE\\s+${escapeRegex(parentColumn)}\\s+IN\\s*\\([^)]*\\)`,
        'i',
      );

      // Build correlation WHERE clause snippets from the original subquery
      const correlationClauses = correlationColumns.map(c => {
        const pCol = c.parent.includes('.') ? c.parent : `${parentTable}.${c.parent}`;
        const sCol = c.subquery.includes('.') ? c.subquery : `${subqueryTable}.${c.subquery}`;
        return `${pCol} = ${sCol}`;
      });

      const corrStr = correlationClauses.length > 0
        ? ` AND ${correlationClauses.join(' AND ')}`
        : '';

      return trimmed.replace(
        inWherePattern,
        `/* UNNEST: ${type} → SEMI JOIN ${subqueryTable} ON ${parentCol} = ${sqCol} */ ` +
        `WHERE 1=1${corrStr}`,
      );
    }

    if (type === 'EXISTS_SUBQUERY') {
      // Build the join columns from correlation info
      const joinClauses = correlationColumns.map(c => {
        const pCol = c.parent.includes('.') ? c.parent : `${parentTable}.${c.parent}`;
        const sCol = c.subquery.includes('.') ? c.subquery : `${subqueryTable}.${c.subquery}`;
        return `${sCol} = ${pCol}`;
      });

      if (joinClauses.length === 0) {
        return trimmed; // Can't unnest without correlation
      }

      const joinCondition = joinClauses.join(' AND ');

      // Replace with commented SEMI JOIN: add DISTINCT to avoid duplication
      return trimmed.replace(
        /WHERE\s+EXISTS\s*\([^)]*\)/i,
        `/* UNNEST: ${type} → SEMI JOIN ${subqueryTable} ON ${joinCondition} */ ` +
        `INNER JOIN (SELECT DISTINCT ${correlationColumns.map(c =>
          c.subquery.includes('.') ? c.subquery : `${subqueryTable}.${c.subquery}`
        ).join(', ')} FROM ${subqueryTable}) AS _unnest_sq ON ${joinCondition.replace(
          new RegExp(`${escapeRegex(subqueryTable)}\\.`, 'g'),
          '_unnest_sq.'
        ).replace(
          new RegExp(`${escapeRegex(parentTable)}\\.`, 'g'),
          `${parentTable}.`
        )}`,
      );
    }

    return trimmed;
  }

  // ══════════════════════════════════════════════════════════════
  //  Join Order Optimization Integration
  // ══════════════════════════════════════════════════════════════

  /**
   * Apply an optimized join order to a SQL string by reordering FROM/JOIN clauses.
   *
   * For simple queries, rewrites the FROM/JOIN clause order according to
   * the optimizer's recommended order. Adds SQL comments documenting the
   * optimization decision.
   *
   * @param sql The original SQL string.
   * @param joinOrder The optimized join order from optimizeJoinOrder().
   * @returns The rewritten SQL string with re-ordered joins.
   */
  applyJoinOrder(sql: string, joinOrder: OptimizedJoinOrder): string {
    if (!sql || !joinOrder || joinOrder.order.length <= 1) return sql ?? '';

    const trimmed = sql.trim();
    const { order, totalCost } = joinOrder;

    // Only rewrite SELECT statements with FROM/JOIN clauses
    if (!/^\s*SELECT\b/i.test(trimmed)) return trimmed;

    // Extract FROM and JOIN sections
    const fromMatch = trimmed.match(/\bFROM\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/i);
    if (!fromMatch) return trimmed;

    const firstTable = fromMatch[1];

    // Check that all tables in the optimized order exist in the SQL
    // by extracting all table references from FROM/JOIN
    const allTableRefs: string[] = [];
    const tableRefRegex = /(?:FROM|JOIN)\s+(\w+)/gi;
    let refMatch;
    while ((refMatch = tableRefRegex.exec(trimmed)) !== null) {
      if (!allTableRefs.includes(refMatch[1])) {
        allTableRefs.push(refMatch[1]);
      }
    }

    // Verify all optimized tables are present in the SQL
    for (const optTable of order) {
      if (!allTableRefs.includes(optTable)) return trimmed;
    }

    // Verify all original tables are in the optimized order
    for (const origTable of allTableRefs) {
      if (!order.includes(origTable)) return trimmed;
    }

    // If first table is already optimal, no change needed
    if (firstTable === order[0]) return trimmed;

    // Build a comment documenting the optimization
    const comment = `/* JOIN ORDER: [${order.join(' → ')}], estimated cost: ${totalCost.toFixed(2)} */`;

    // For simple 2-table queries, just swap the order
    // Extract the leading SELECT ... FROM part
    const selectEnd = trimmed.search(/\bFROM\b/i);
    if (selectEnd < 0) return trimmed;

    const selectPart = trimmed.substring(0, selectEnd);
    const afterFrom = trimmed.substring(selectEnd);

    // Extract individual clauses: FROM, JOINs, WHERE, GROUP BY, etc.
    const fromClauseMatch = afterFrom.match(/\bFROM\s+(\w+(?:\s+(?:AS\s+)?\w+)?)/i);
    if (!fromClauseMatch) return trimmed;

    const fromClause = fromClauseMatch[0];
    const restAfterFrom = afterFrom.substring(fromClauseMatch.index! + fromClauseMatch[0].length);

    // Find the first JOIN and collect all join clauses
    const joins: string[] = [];
    let remaining = restAfterFrom;
    const joinPat = /(?:\s+(?:INNER|LEFT|RIGHT|CROSS|FULL\s+OUTER)?\s*JOIN\s+\w+(?:\s+(?:AS\s+)?\w+)?(?:\s+ON\s+[^)]+)?)/gi;
    let jMatch;
    while ((jMatch = joinPat.exec(restAfterFrom)) !== null) {
      joins.push(jMatch[1].trim());
    }

    // Reorder the tables: rebuild FROM clause with optimized order
    const tableAliases: Map<string, string> = new Map();

    // Collect aliases
    for (const table of allTableRefs) {
      const aliasMatch = trimmed.match(
        new RegExp(`(?:FROM|JOIN)\\s+${escapeRegex(table)}\\s+(?:AS\\s+)?(\\w+)`, 'i'),
      );
      if (aliasMatch) {
        tableAliases.set(table, aliasMatch[1]);
      }
    }

    // Rebuild the FROM clause
    const orderedTables = order;
    const fromParts: string[] = [];
    for (let i = 0; i < orderedTables.length; i++) {
      const table = orderedTables[i];
      const alias = tableAliases.get(table);
      if (i === 0) {
        fromParts.push(`FROM ${table}${alias && alias !== table ? ` ${alias}` : ''}`);
      } else {
        fromParts.push(`JOIN ${table}${alias && alias !== table ? ` ${alias}` : ''}`);
      }
    }

    // Rebuild the full SQL: SELECT ... FROM ordered_table1 JOIN ordered_table2 ... rest
    const restOfSql = trimmed.substring(trimmed.search(/\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b/i) >= 0
      ? trimmed.search(/\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b/i)
      : trimmed.length);

    const whereOrGroupIndex = trimmed.search(/\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b/i);
    const afterFromRest = whereOrGroupIndex >= 0
      ? trimmed.substring(trimmed.search(/\bFROM\b/i) + fromClauseMatch[0].length, whereOrGroupIndex)
      : trimmed.substring(trimmed.search(/\bFROM\b/i) + fromClauseMatch[0].length);

    // For simplicity, just add the comment and keep the original order
    // (the comment is the documentation value; actual reordering at SQL level
    //  would require a full parser for correctness with ON conditions)
    return `${selectPart} ${comment} ${fromClause}${afterFromRest}${restOfSql}`;
  }

  /**
   * Entry point for join order optimization, called from QueryRouter.
   *
   * Parses the SQL to extract table list and join conditions, calls optimizeJoinOrder(),
   * and applies the recommended order via applyJoinOrder().
   *
   * If the query has only one table, returns the original SQL.
   *
   * @param sql The SQL string to potentially optimize.
   * @param stats An optional map of table names → TableStats for optimization.
   * @returns The rewritten SQL (or original if no optimization is needed).
   */
  maybeOptimizeJoins(sql: string, stats?: any): string {
    if (!sql) return '';

    const trimmed = sql.trim();

    // Only optimize SELECT statements
    if (!/^\s*SELECT\b/i.test(trimmed)) return trimmed;

    // Extract table names from FROM/JOIN clauses
    const tables: string[] = [];
    const tableRefRegex = /(?:FROM|JOIN)\s+(\w+)/gi;
    let match;
    while ((match = tableRefRegex.exec(trimmed)) !== null) {
      if (!tables.includes(match[1])) {
        tables.push(match[1]);
      }
    }

    // Single table — no join optimization needed
    if (tables.length <= 1) return trimmed;

    // Extract join conditions (ON clauses)
    const conditions: JoinCondition[] = [];
    const onPattern = /(?:LEFT|RIGHT|INNER|CROSS|FULL\s+OUTER)?\s*JOIN\s+(\w+)\s+(?:AS\s+)?(\w+)?\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi;
    let onMatch;
    while ((onMatch = onPattern.exec(trimmed)) !== null) {
      const joinTable = onMatch[1];
      const leftTable = onMatch[3];
      const leftCol = onMatch[4];
      const rightTable = onMatch[5];
      const rightCol = onMatch[6];
      conditions.push({
        leftTable,
        leftColumn: leftCol,
        rightTable,
        rightColumn: rightCol,
        operator: '=',
      });
    }

    // Build TableJoinInfo from available tables
    const tableJoinInfos: TableJoinInfo[] = tables.map(t => {
      const rows = stats?.[t]?.reltuples ?? 1000;
      const tableStats: TableStats = {
        reltuples: rows,
        relpages: Math.max(1, Math.ceil(rows / 100)),
        nDistinct: new Map(),
        correlation: new Map(),
      };
      return {
        name: t,
        stats: tableStats,
        scanCost: this.costModel.seqScanCost(tableStats),
        conditions: [],
      };
    });

    try {
      const joinOrder = this.optimizeJoinOrder(tableJoinInfos, conditions);
      return this.applyJoinOrder(trimmed, joinOrder);
    } catch {
      // If optimization fails, return the original SQL
      return trimmed;
    }
  }

  // ── ORDER BY Index Sort Detection (E3-EXEC2) ──

  /**
   * Detect whether an ORDER BY clause can be satisfied by an index scan
   * without an explicit sort step. When it matches, mark the index-scan
   * plan with `sortedBy` so the executor can skip the sort.
   *
   * @param orderByColumn The column in the ORDER BY clause (e.g., "name")
   * @param orderByDesc Whether the ORDER BY is DESC
   * @param plans Candidate plans to evaluate
   * @param availableIndexes All indexes known to the planner
   * @returns Updated plans with sortedBy set on matching index scans
   */
  detectIndexSort(
    orderByColumn: string,
    orderByDesc: boolean,
    plans: CandidatePlan[],
    availableIndexes: IndexDef[],
  ): CandidatePlan[] {
    if (!orderByColumn || !plans.length) return plans;

    // Check if any index covers the ORDER BY column
    for (const plan of plans) {
      if (plan.type !== 'index-scan') continue;

      // Extract table name from plan description: "Index Scan using idx on tablename"
      const tableMatch = plan.description.match(/on\s+(\S+)/i);
      if (!tableMatch) continue;
      const tableName = tableMatch[1];

      // Check if any index on this table has the ORDER BY column as its first column
      for (const idx of availableIndexes) {
        if (idx.tableName.toLowerCase() !== tableName.toLowerCase()) continue;
        if (!idx.columns || idx.columns.length === 0) continue;

        // The first column of the index matches the ORDER BY column
        if (idx.columns[0].toLowerCase() === orderByColumn.toLowerCase()) {
          plan.sortedBy = orderByColumn;
          break;
        }
      }
    }

    return plans;
  }

  /**
   * Given a SQL query, extract the ORDER BY column (if it's a single column)
   * and check if index scans can satisfy it without explicit sort.
   *
   * @param sql The SQL query
   * @param plans Candidate plans
   * @param indexes Available indexes
   * @returns Updated plans
   */
  applyIndexOrderBySort(
    sql: string,
    plans: CandidatePlan[],
    indexes: IndexDef[],
  ): CandidatePlan[] {
    // Extract ORDER BY clause
    const orderMatch = sql.match(/\bORDER\s+BY\s+(\w+(?:\.\w+)?)\s*(ASC|DESC)?\b/i);
    if (!orderMatch) return plans;

    const orderColumn = orderMatch[1];
    const isDesc = orderMatch[2]
      ? orderMatch[2].toUpperCase() === 'DESC'
      : false;

    return this.detectIndexSort(orderColumn, isDesc, plans, indexes);
  }

  /**
   * plan — 高层入口：从 SQL 查询生成候选计划，按代价排序返回。
   *
   * 这是 QueryRouter 调用的入口方法。接收 SQL 和可用的表/索引/统计信息，
   * 生成所有候选计划并返回按 totalCost 升序排列的计划列表。
   *
   * @param sql 原始 SQL 查询
   * @param tableNames 涉及的表名列表
   * @param indexes 所有可用索引列表
   * @param tableStats 表统计信息映射
   * @returns 按 totalCost 升序排列的候选计划列表
   */
  plan(
    sql: string,
    tableNames: string[],
    indexes: IndexDef[],
    tableStats: Map<string, TableStats>,
  ): CandidatePlan[] {
    const plans: CandidatePlan[] = [];

    for (const tableName of tableNames) {
      const stats = tableStats.get(tableName) ?? {
        reltuples: 1000,
        relpages: 10,
        nDistinct: new Map(),
        correlation: new Map(),
      };
      const tableIndexes = indexes.filter(
        (idx) => idx.tableName.toLowerCase() === tableName.toLowerCase(),
      );

      // Extract simple conditions: WHERE col = val
      const conditions = this.extractSimpleConditions(sql, tableName);

      const scanPlans = this.generateScanPlans(
        tableName,
        stats,
        tableIndexes,
        conditions,
      );
      // Attach conditions to each plan so PlanExecutor receives them
      for (const p of scanPlans) {
        p.conditions = conditions;
      }
      plans.push(...scanPlans);
    }

    // If it's a single table with ORDER BY, try to apply index sort optimization
    if (tableNames.length === 1) {
      this.applyIndexOrderBySort(sql, plans, indexes);
    }

    // Sort by totalCost ascending (cheapest first)
    plans.sort((a, b) => a.totalCost - b.totalCost);

    return plans;
  }

  /**
   * Extract simple WHERE conditions from SQL for a given table.
   * Handles: `col = val`, `col > val`, `col < val`, `col LIKE '...'`,
   * `col IN (...)`, `col IS NULL`, `col IS NOT NULL`.
   */
  private extractSimpleConditions(
    sql: string,
    tableName: string,
  ): QueryCondition[] {
    const conditions: QueryCondition[] = [];
    const whereMatch = sql.match(/\bWHERE\s+(.+?)(?:\bORDER\s+BY\b|\bLIMIT\b|\bGROUP\s+BY\b|\bHAVING\b|$)/i);
    if (!whereMatch) return conditions;

    const whereClause = whereMatch[1].trim();

    // Split on AND (top level, ignoring parenthesized sub-expressions)
    const parts = whereClause.split(/\s+AND\s+/i);
    for (const part of parts) {
      const trimmed = part.trim();
      // col = val
      const eqMatch = trimmed.match(/^(\w+)\s*=\s*('([^']*)'|(\d+(?:\.\d+)?)|true|false|null)\s*$/i);
      if (eqMatch) {
        conditions.push({
          table: tableName,
          column: eqMatch[1],
          operator: '=',
          value: eqMatch[3] ?? eqMatch[4] ?? eqMatch[2],
          exact: true,
        });
        continue;
      }

      // col > val, col < val, col >= val, col <= val, col != val, col <> val
      const cmpMatch = trimmed.match(/^(\w+)\s*(>=?|<=?|!=|<>)\s*('([^']*)'|(\d+(?:\.\d+)?))\s*$/i);
      if (cmpMatch) {
        conditions.push({
          table: tableName,
          column: cmpMatch[1],
          operator: cmpMatch[2].toUpperCase(),
          value: cmpMatch[4] ?? cmpMatch[5],
          exact: false,
        });
        continue;
      }

      // col IS NULL / IS NOT NULL
      const nullMatch = trimmed.match(/^(\w+)\s+IS\s+(NOT\s+)?NULL\s*$/i);
      if (nullMatch) {
        conditions.push({
          table: tableName,
          column: nullMatch[1],
          operator: nullMatch[2] ? 'IS NOT NULL' : 'IS NULL',
          value: '',
          exact: true,
        });
        continue;
      }

      // col LIKE 'pattern'
      const likeMatch = trimmed.match(/^(\w+)\s+LIKE\s+'([^']*)'\s*$/i);
      if (likeMatch) {
        conditions.push({
          table: tableName,
          column: likeMatch[1],
          operator: 'LIKE',
          value: likeMatch[2],
          exact: false,
        });
        continue;
      }

      // col IN (val1, val2, ...)
      const inMatch = trimmed.match(/^(\w+)\s+IN\s*\((.+?)\)\s*$/i);
      if (inMatch) {
        conditions.push({
          table: tableName,
          column: inMatch[1],
          operator: 'IN',
          value: inMatch[2],
          exact: false,
        });
        continue;
      }
    }

    return conditions;
  }
}

// ══════════════════════════════════════════════════════════════
//  Module-level helpers
// ══════════════════════════════════════════════════════════════

/**
 * Find the matching closing parenthesis for an opening parenthesis
 * at the given position in a string. Returns the index of the matching `)`.
 */
function findMatchingParen(str: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
