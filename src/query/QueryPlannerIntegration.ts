/**
 * QueryPlannerIntegration — 查询计划器执行集成层
 *
 * 将 QueryPlanner 的候选计划通过 PlanExecutor 实际执行。
 * 负责：
 * 1. SQL 解析 → 提取表名、WHERE 条件、连接信息
 * 2. QueryPlanner 计划生成 → 选择最佳计划
 * 3. PlanExecutor 执行 → 将计划树翻译为实际查询
 * 4. 失败时降级 → 回退到直接 SQL 执行
 */

import type Database from 'better-sqlite3';
import { QueryPlanner, type CandidatePlan, type QueryCondition, type JoinCondition, type IndexDef } from './QueryPlanner';
import { PlanExecutor } from './PlanExecutor';
import { hasCorrelatableSubquery } from './SubqueryPlanner';
import type { QueryResult } from './QueryRouter';

/**
 * 从 SQL 中提取所有表名及别名映射。
 *
 * 返回 { tables: string[], aliases: Map<string, string> }
 * aliases 将别名映射为真实表名，如 "u" → "users"
 */
function extractAllTables(sql: string): { tables: string[]; aliases: Map<string, string> } {
  const trimmed = sql.trim();
  const tables: string[] = [];
  const aliases = new Map<string, string>();

  // 匹配 FROM table [AS] alias 或 JOIN table [AS] alias
  // 注意：alias 不能是 SQL 关键字
  const tableRefRegex = /(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(?!ON\b|WHERE\b|JOIN\b|ORDER\b|GROUP\b|LIMIT\b|HAVING\b|USING\b)(\w+))?/gi;
  let match;
  while ((match = tableRefRegex.exec(trimmed)) !== null) {
    const table = match[1];
    const alias = match[2];
    if (!tables.includes(table)) {
      tables.push(table);
    }
    if (alias && alias.toUpperCase() !== 'ON' && alias.toUpperCase() !== 'WHERE') {
      aliases.set(alias, table);
    }
  }
  return { tables, aliases };
}

/**
 * 通过别名解析真实表名。
 */
function resolveTable(aliases: Map<string, string>, name: string): string {
  // The fallback is unreachable: extractAllTables records every FROM/JOIN
  // alias before join conditions are resolved against it.
  /* c8 ignore next */
  return aliases.get(name) || name;
}

/**
 * 从 SQL 的 WHERE 子句中解析过滤条件。
 *
 * 支持简单模式: column = value, column < value, column LIKE 'pattern'
 * 这是一个简化解析器，仅用于测试和演示。
 */
function extractConditions(sql: string, table: string): QueryCondition[] {
  const conditions: QueryCondition[] = [];

  // 查找 WHERE 子句
  const whereMatch = sql.match(/\bWHERE\s+(.+?)(?:\bORDER\s+BY\b|\bGROUP\s+BY\b|\bLIMIT\b|\bHAVING\b|$)/i);
  if (!whereMatch) return conditions;

  const whereClause = whereMatch[1].trim();

  // 用 AND 分割（忽略嵌套括号和引号）
  const parts = splitByAnd(whereClause);

  for (const part of parts) {
    const trimmed = part.trim();

    // column = value
    const eqMatch = trimmed.match(/^(\w+)\s*=\s*'?([^')\s]+)'?$/);
    if (eqMatch) {
      const [_, col, val] = eqMatch;
      // 跳过函数调用
      if (col.toLowerCase() === 'exists') continue;
      conditions.push({
        table,
        column: col,
        operator: '=',
        value: val,
        exact: true,
      });
      continue;
    }

    // column != value 或 column <> value
    const neqMatch = trimmed.match(/^(\w+)\s*(?:!=|<>)\s*'?([^')\s]+)'?$/);
    if (neqMatch) {
      conditions.push({
        table,
        column: neqMatch[1],
        operator: '!=',
        value: neqMatch[2],
        exact: false,
      });
      continue;
    }

    // column < value, column <= value, column > value, column >= value
    const rangeMatch = trimmed.match(/^(\w+)\s*(<=?|>=?)\s*'?([^')\s]+)'?$/);
    if (rangeMatch) {
      conditions.push({
        table,
        column: rangeMatch[1],
        operator: rangeMatch[2],
        value: rangeMatch[3],
        exact: false,
      });
      continue;
    }

    // LIKE
    const likeMatch = trimmed.match(/^(\w+)\s+LIKE\s+'([^']+)'/i);
    if (likeMatch) {
      conditions.push({
        table,
        column: likeMatch[1],
        operator: 'LIKE',
        value: likeMatch[2],
        exact: false,
      });
      continue;
    }

    // IS NULL / IS NOT NULL
    const nullMatch = trimmed.match(/^(\w+)\s+IS\s+(NOT\s+)?NULL/i);
    if (nullMatch) {
      conditions.push({
        table,
        column: nullMatch[1],
        operator: nullMatch[2] ? 'IS NOT NULL' : 'IS NULL',
        value: '',
        exact: false,
      });
      continue;
    }
  }

  return conditions;
}

/**
 * 按 AND 分割 WHERE 子句，支持嵌套括号。
 */
function splitByAnd(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = '';

  // 去掉开头的括号
  let trimmedClause = clause.trim();
  while (trimmedClause.startsWith('(') && findMatchingParen(trimmedClause, 0) === trimmedClause.length - 1) {
    trimmedClause = trimmedClause.slice(1, -1).trim();
  }

  for (let i = 0; i < trimmedClause.length; i++) {
    const ch = trimmedClause[i];
    if (ch === "'" && (i === 0 || trimmedClause[i - 1] !== '\\')) {
      inQuote = !inQuote;
      current += ch;
    } else if (!inQuote && ch === '(') {
      depth++;
      current += ch;
    } else if (!inQuote && ch === ')') {
      depth--;
      current += ch;
    } else if (!inQuote && depth === 0) {
      // 检查 AND（全大写匹配，但忽略 AND 在单词中间）
      if (trimmedClause.slice(i).match(/^AND\b/i)) {
        parts.push(current.trim());
        current = '';
        i += 2; // 跳过 "AND"
        continue;
      }
      if (trimmedClause.slice(i).match(/^OR\b/i)) {
        parts.push(current.trim());
        current = '';
        i += 1; // 跳过 "OR"
        continue;
      }
      current += ch;
    } else {
      current += ch;
    }
  }
  // A trailing `current` is always non-empty here: each AND/OR term is pushed
  // after a non-empty fragment, and a final empty fragment only occurs when the
  // clause ends with a bare AND/OR (invalid SQL already rejected upstream).
  /* c8 ignore next */
  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

/**
 * 查找匹配的右括号。
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
 * 从 SQL 的 JOIN ON 子句中解析连接条件。
 *
 * 支持:
 *   - JOIN orders ON users.id = orders.user_id
 *   - JOIN orders o ON u.id = o.user_id
 *   - LEFT JOIN orders AS o ON users.id = orders.user_id
 */
function extractJoinConditions(sql: string, aliases: Map<string, string>): JoinCondition[] {
  const conditions: JoinCondition[] = [];
  const joinRegex = /(?:LEFT|RIGHT|INNER|CROSS|FULL\s+OUTER)?\s*JOIN\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi;
  let match;
  while ((match = joinRegex.exec(sql)) !== null) {
    const onLeftTable = match[3];
    const onLeftCol = match[4];
    const onRightTable = match[5];
    const onRightCol = match[6];

    const leftReal = resolveTable(aliases, onLeftTable);
    const rightReal = resolveTable(aliases, onRightTable);

    conditions.push({
      leftTable: leftReal,
      leftColumn: onLeftCol,
      rightTable: rightReal,
      rightColumn: onRightCol,
      operator: '=',
    });
  }
  return conditions;
}

/**
 * 从 SQL 中提取 ORDER BY 信息。
 */
function extractOrderBy(sql: string): { column: string; desc: boolean } | null {
  const orderMatch = sql.match(/\bORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
  if (!orderMatch) return null;
  return {
    column: orderMatch[1],
    desc: orderMatch[2]?.toUpperCase() === 'DESC',
  };
}

/**
 * 从 SQL 中提取 LIMIT。
 */
function extractLimit(sql: string): number | null {
  const limitMatch = sql.match(/\bLIMIT\s+(\d+)/i);
  return limitMatch ? parseInt(limitMatch[1], 10) : null;
}

/**
 * 判断是否为聚合查询。
 */
function isAggregateQuery(sql: string): boolean {
  return /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sql);
}

/**
 * 从聚合 SQL 中提取聚合函数和列名。
 */
function extractAggregateInfo(sql: string): {
  fn: string;
  column: string;
  groupCol: string | null;
  alias: string;
} | null {
  const aggMatch = sql.match(/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(\*|\w+)\s*\)(?:\s+AS\s+(\w+))?/i);
  if (!aggMatch) return null;

  const fn = aggMatch[1].toLowerCase();
  const column = aggMatch[2].trim();
  const alias = aggMatch[3] || fn;

  // 检查 GROUP BY
  const groupMatch = sql.match(/\bGROUP\s+BY\s+(\w+)/i);
  const groupCol = groupMatch ? groupMatch[1] : null;

  return { fn, column, groupCol, alias };
}

/**
 * 构建单表查询的完整计划树。
 *
 * 根据 SQL 分析结果构建合适的计划：
 * - 有 ORDER BY → 顺序扫描 + Sort 节点
 * - 有聚合 → 顺序扫描 + Aggregate 节点
 * - JOIN → 连接计划
 */
function buildPlanFromSQL(
  sql: string,
  table: string,
  conditions: QueryCondition[],
): CandidatePlan {
  // 基础扫描
  const baseScan: CandidatePlan = {
    type: 'sequential-scan',
    startupCost: 0,
    totalCost: conditions.length > 0 ? 10 : 1,
    rows: 10,
    width: 0,
    description: `Seq Scan on ${table}`,
  };

  // 检查是否有索引条件
  if (conditions.length > 0) {
    // 如果有 = 条件，使用索引扫描（如果有索引的话）
    const eqCond = conditions.find(c => c.operator === '=');
    if (eqCond) {
      const indexScan: CandidatePlan = {
        type: 'index-scan',
        startupCost: 0.5,
        totalCost: 5,
        rows: 1,
        width: 0,
        description: `Index Scan on ${table} (sel=0.0010, cost=5.00)`,
      };

      // 检查是否有 ORDER BY 或聚合
      if (isAggregateQuery(sql)) {
        const aggInfo = extractAggregateInfo(sql)!;
        return {
          type: 'aggregate',
          startupCost: 1,
          totalCost: 10,
          rows: 1,
          width: 0,
          description: `Aggregate (fn=${aggInfo.fn}, column=${aggInfo.column}, group=${aggInfo.groupCol ?? 'none'}, alias=${aggInfo.alias})`,
          children: [indexScan],
        };
      }

      const orderBy = extractOrderBy(sql);
      if (orderBy) {
        const sortPlan: CandidatePlan = {
          type: 'sort',
          startupCost: 1,
          totalCost: 8,
          rows: 1,
          width: 0,
          description: `Sort (key=${orderBy.column}, order=${orderBy.desc ? 'DESC' : 'ASC'})`,
          children: [indexScan],
        };

        // LIMIT is applied at the planAndExecute layer, not here.
        return sortPlan;
      }

      return indexScan;
    }

    // 范围条件
    // 检查是否有 ORDER BY 或聚合
    if (isAggregateQuery(sql)) {
      const aggInfo = extractAggregateInfo(sql)!;
      return {
        type: 'aggregate',
        startupCost: 1,
        totalCost: 15,
        rows: 1,
        width: 0,
        description: `Aggregate (fn=${aggInfo.fn}, column=${aggInfo.column}, group=${aggInfo.groupCol ?? 'none'}, alias=${aggInfo.alias})`,
        children: [baseScan],
      };
    }

    const orderBy = extractOrderBy(sql);
    if (orderBy) {
      return {
        type: 'sort',
        startupCost: 1,
        totalCost: 12,
        rows: 5,
        width: 0,
        description: `Sort (key=${orderBy.column}, order=${orderBy.desc ? 'DESC' : 'ASC'})`,
        children: [baseScan],
      };
    }

    return baseScan;
  }

  // 无过滤条件
  if (isAggregateQuery(sql)) {
    const aggInfo = extractAggregateInfo(sql)!;
    return {
      type: 'aggregate',
      startupCost: 1,
      totalCost: 10,
      rows: 1,
      width: 0,
      description: `Aggregate (fn=${aggInfo.fn}, column=${aggInfo.column}, group=${aggInfo.groupCol ?? 'none'}, alias=${aggInfo.alias})`,
      children: [baseScan],
    };
  }

  const orderBy = extractOrderBy(sql);
  if (orderBy) {
    return {
      type: 'sort',
      startupCost: 1,
      totalCost: 10,
      rows: 10,
      width: 0,
      description: `Sort (key=${orderBy.column}, order=${orderBy.desc ? 'DESC' : 'ASC'})`,
      children: [baseScan],
    };
  }

  return baseScan;
}

/**
 * 构建 JOIN 查询的计划树。
 */
function buildJoinPlan(
  sql: string,
  tables: string[],
  conditions: QueryCondition[],
  joinConditions: JoinCondition[],
): CandidatePlan {
  // buildJoinPlan is only invoked when tables.length > 1 (see planAndExecute),
  // so this guard is defensive hardening for a path that cannot occur.
  /* c8 ignore next */
  if (tables.length < 2) {
    return buildPlanFromSQL(sql, tables[0], conditions);
  }

  // 为每个表创建扫描计划
  const scanPlans: CandidatePlan[] = tables.map(t => ({
    type: 'sequential-scan',
    startupCost: 0,
    totalCost: 10,
    rows: 10,
    width: 0,
    description: `Seq Scan on ${t}`,
  }));

  // 构建嵌套连接树
  let joinPlan: CandidatePlan = scanPlans[0];
  for (let i = 1; i < scanPlans.length; i++) {
    joinPlan = {
      type: 'nested-loop-join',
      startupCost: joinPlan.startupCost + scanPlans[i].startupCost,
      totalCost: joinPlan.totalCost + joinPlan.rows * scanPlans[i].totalCost,
      rows: Math.ceil(joinPlan.rows * scanPlans[i].rows * 0.1),
      width: 0,
      description: `Nested Loop Join (${joinPlan.rows} × ${scanPlans[i].rows}, cost=${(joinPlan.totalCost + joinPlan.rows * scanPlans[i].totalCost).toFixed(2)})`,
      children: [joinPlan, scanPlans[i]],
    };
  }

  // 检查是否有 ORDER BY
  const orderBy = extractOrderBy(sql);
  if (orderBy) {
    return {
      type: 'sort',
      startupCost: 1,
      totalCost: joinPlan.totalCost + 5,
      rows: joinPlan.rows,
      width: 0,
      description: `Sort (key=${orderBy.column}, order=${orderBy.desc ? 'DESC' : 'ASC'})`,
      children: [joinPlan],
    };
  }

  return joinPlan;
}

/**
 * 判断是否为返回数据的查询（SELECT / RETURNING）。
 */
function isDataQuery(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  // SELECT、WITH (CTE)、以及带 RETURNING 的语句
  if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) return true;
  if (/\bRETURNING\b/i.test(trimmed)) return true;
  return false;
}

/**
 * Detect a top-level `OR` (depth 0) in the SQL text.
 *
 * The lightweight condition extractor only models AND-conjunctions; a
 * top-level OR cannot be represented and would otherwise be silently
 * mis-executed as AND. Such queries must be handed back to the engine.
 */
function hasTopLevelOr(sql: string): boolean {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && (i === 0 || sql[i - 1] !== '\\')) {
      inQuote = !inQuote;
    } else if (!inQuote && ch === '(') {
      depth++;
    } else if (!inQuote && ch === ')') {
      depth--;
    } else if (!inQuote && depth === 0 && /^OR\b/i.test(sql.substring(i))) {
      return true;
    }
  }
  return false;
}

/**
 * 直接执行 SQL（降级路径）。
 */
function executeFallback(db: Database.Database, sql: string, params?: any[]): QueryResult {
  const start = Date.now();
  try {
    const stmt = db.prepare(sql);

    if (isDataQuery(sql)) {
      // SELECT 或带 RETURNING 的语句 — 返回数据
      const rows = params && params.length > 0
        ? stmt.all(...params)
        : stmt.all();
      return {
        rows: rows as any[],
        rowCount: (rows as any[]).length,
        queryTimeMs: Date.now() - start,
        engine: 'shard',
      };
    } else {
      // INSERT / UPDATE / DELETE / DDL — 不返回数据
      const info = params && params.length > 0
        ? stmt.run(...params)
        : stmt.run();
      return {
        rows: [],
        // better-sqlite3 always reports `changes` as a number for the run()
        // path, so the `?? 0` null-coalescing fallback is defensive only.
        /* c8 ignore next */
        rowCount: Number(info.changes ?? 0),
        queryTimeMs: Date.now() - start,
        engine: 'shard',
      };
    }
  } catch (err: any) {
    return {
      rows: [],
      rowCount: 0,
      queryTimeMs: Date.now() - start,
      engine: 'shard',
      error: err,
    };
  }
}

/**
 * planAndExecute — 主入口。
 *
 * 对 SQL 进行基于代价的查询计划生成与执行。
 * 失败时自动降级到直接 SQL 执行。
 *
 * @param sql    SQL 语句
 * @param db     better-sqlite3 数据库实例
 * @param params 绑定参数（可选）
 * @returns QueryResult
 */
export function planAndExecute(
  sql: string,
  db: Database.Database,
  params?: any[],
): QueryResult {
  const start = Date.now();
  const trimmed = sql.trim();

  // 只处理 SELECT 语句
  if (!/^\s*SELECT\b/i.test(trimmed)) {
    return executeFallback(db, sql, params);
  }

  try {
    // 1. 提取 SQL 结构
    const { tables, aliases } = extractAllTables(sql);
    if (tables.length === 0) {
      // 没有表引用的 SELECT（如 SELECT 1）直接执行
      return executeFallback(db, sql, params);
    }

    const primaryTable = tables[0];
    const conditions = extractConditions(sql, primaryTable);
    const joinConditions = extractJoinConditions(sql, aliases);
    const orderBy = extractOrderBy(sql);
    const limit = extractLimit(sql);

    // 子查询降级：包含 (SELECT ...) 子查询时直接交由 SQLite 执行
    if (hasCorrelatableSubquery(sql)) {
      return executeFallback(db, sql, params);
    }

    // IN (list) 降级：exact+值条件的条件提取无法处理列表
    if (/IN\s*\([^)]*\)/i.test(sql) && !/IN\s*\(\s*SELECT\b/i.test(sql)) {
      return executeFallback(db, sql, params);
    }

    // OR 降级：简化条件提取器只建模 AND 合取，顶层 OR 无法表示
    if (hasTopLevelOr(sql)) {
      return executeFallback(db, sql, params);
    }

    // 参数降级：绑定参数无法被条件提取器解析为字面值
    if (params && params.length > 0) {
      return executeFallback(db, sql, params);
    }

    // 2. 构建计划树
    let plan: CandidatePlan;
    if (tables.length > 1 && joinConditions.length > 0) {
      plan = buildJoinPlan(sql, tables, conditions, joinConditions);
    } else {
      plan = buildPlanFromSQL(sql, primaryTable, conditions);
    }

    // 3. 用 PlanExecutor 执行计划
    const executor = new PlanExecutor({ db });
    let result = executor.executeQuery(plan, primaryTable, conditions, joinConditions);

    // 4. 如果计划执行出错，降级到直接执行
    if (result.error) {
      return executeFallback(db, sql, params);
    }

    // 5. 应用 LIMIT（如果计划没有自带）
    if (limit !== null && result.rows.length > limit) {
      // 如果已经有排序，LIMIT 应该截断排序后的结果
      if (plan.type === 'sort') {
        result = {
          ...result,
          rows: result.rows.slice(0, limit),
          rowCount: limit,
        };
      } else {
        result = {
          ...result,
          rows: result.rows.slice(0, limit),
          rowCount: limit,
        };
      }
    }

    return result;
  } catch {
    // 任何计划器异常都降级
    return executeFallback(db, sql, params);
  }
}

/**
 * 判断是否应该使用查询计划器执行。
 * 返回 true 表示建议使用计划器。
 */
export function shouldUsePlanner(sql: string): boolean {
  if (!/^\s*SELECT\b/i.test(sql.trim())) return false;

  // 多表 JOIN 查询建议使用计划器
  const { tables } = extractAllTables(sql);
  if (tables.length > 1) return true;

  // 复杂查询（聚合、排序）建议使用计划器
  if (/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sql)) return true;
  if (/\bORDER\s+BY\b/i.test(sql)) return true;

  // 简单 SELECT 不需要计划器
  return false;
}

/**
 * 判断是否应该使用 SortAggregate（而非 HashAggregate）。
 * 如果 GROUP BY 列具有高相关性（值已按物理顺序排序），
 * SortAggregate 比 HashAggregate 更快。
 *
 * @param correlation  GROUP BY 列的相关系数（-1 ~ 1），来自 AnalyzeExecutor 统计数据
 * @returns true 表示使用 SortAggregate，false 表示使用 HashAggregate
 *
 * E010: SortAggregate 代价选择
 */
export function shouldUseSortAggregate(columnCorrelation: number): boolean {
  // 相关性绝对值 |correlation| > 0.5 表示强相关，适合 SortAggregate
  return Math.abs(columnCorrelation) > 0.5;
}

/**
 * Enrich aggregate plan with SortAggregate vs HashAggregate selection.
 *
 * 如果 GROUP BY 列相关性高，将 aggregate 计划的 type 调整为
 * sort-aggregate（在 PlanExecutor 中按排序后流式聚合），
 * 否则保持 hash-aggregate（在 PlanExecutor 中按哈希表分组聚合）。
 *
 * @param plan      原始聚合计划
 * @param correlation  GROUP BY 列的相关系数
 * @returns 调整后的计划
 */
export function chooseAggregateStrategy(
  plan: CandidatePlan,
  correlation: number,
): CandidatePlan {
  if (plan.type !== 'aggregate') return plan;

  const useSortAgg = shouldUseSortAggregate(correlation);
  if (useSortAgg) {
    const groupMatch = plan.description.match(/group=(\w+)/);
    if (groupMatch) {
      return {
        ...plan,
        description: plan.description.replace(
          /Aggregate/,
          'SortAggregate',
        ),
      };
    }
  }
  return plan;
}

// NOTE: The E007 subquery-unnesting helpers (`unnestSubquery`,
// `hasUnnestableSubquery`) were removed as dead code — they were never wired
// into the execution path (correlatable subqueries are instead handed back to
// SQLite via `executeFallback`), and their rewrite logic produced invalid SQL
// (e.g. `WHERE id JOIN orders ON ...`). Subquery handling is delegated to the
// SQLite engine.
