/**
 * SubqueryPlanner — 子查询去关联化
 *
 * 使用 pgsql-ast-parser 的 AST 解析来检测和重写子查询：
 * - IN (SELECT ...)    → Semi Join（非相关） / 保留（相关）
 * - NOT IN (SELECT ...) → Anti Join（非相关） / 保留（相关）
 * - EXISTS (SELECT ...) → Semi Join（非相关） / 保留（相关）
 * - NOT EXISTS (SELECT ...) → Anti Join（非相关） / 保留（相关）
 *
 * 关联引用检测：子查询 WHERE 引用外层表列 → 保留为相关子查询
 * 非相关子查询：完全展开为 Join
 * 相关子查询：保留原样（SQLite 可处理）
 */

import { parseFirst } from 'pgsql-ast-parser';

// ── 类型定义 ──

export interface SubqueryRewriteResult {
  /** 重写后的计划类型，或 undefined 表示保持原样 */
  rewrittenPlanType?: 'semi-join' | 'anti-join' | 'sequential-scan';
  /** 重写后的 JoinCondition */
  joinCondition?: {
    leftTable: string;
    leftColumn: string;
    rightTable: string;
    rightColumn: string;
  };
  /** 是否需要重写 */
  rewritten: boolean;
  /** 原始子查询 SQL 片段（用于识别） */
  originalSubquery?: string;
  /** 是否检测到关联引用 */
  hasCorrelation?: boolean;
}

// ── 公共 API ──

/**
 * 检测 SQL 是否包含可展开的子查询（正则快速预检）。
 */
export function hasCorrelatableSubquery(sql: string): boolean {
  return /(?:IN|NOT IN|EXISTS|NOT EXISTS)\s*\(\s*SELECT\b/i.test(sql);
}

/**
 * 解析 SQL 中的子查询，判断是否可以去关联化。
 *
 * 分析策略：
 * 1. 用 pgsql-ast-parser 解析外层 SELECT 的 WHERE 条件
 * 2. 识别 IN / NOT IN / EXISTS / NOT EXISTS 子查询
 * 3. 对 IN / NOT IN：检查右操作数类型是否为 select（而非 list）
 * 4. 对 EXISTS / NOT EXISTS：解包 call(function=exists) / unary(NOT) 结构
 * 5. 遍历子查询 AST 检测对外层表的相关引用
 * 6. 非相关 → 可重写为 semi-join / anti-join
 * 7. 相关 → 保持原样
 *
 * @param sql       原始 SQL
 * @param tableName 外层主表名
 * @returns 分析结果，null 表示无法解析或不存在子查询
 */
export function analyzeSubquery(
  sql: string,
  tableName: string,
): SubqueryRewriteResult | null {
  try {
    // parseFirst returns a Statement or throws — it never yields null. The
    // try/catch below absorbs parse errors, so a successful call always
    // produces a well-formed AST object.
    const stmt = parseFirst(sql);

    // 只处理 SELECT 语句
    if ((stmt as any).type !== 'select') return null;

    const selectStmt = stmt as any;
    if (!selectStmt.where) return null;

    const whereExpr = selectStmt.where;

    // The outer table may be referenced by its real name or by an alias
    // (e.g. "FROM orders o" makes "o.id" a reference to "orders"). Collect every
    // identifier that can designate the outer table so correlation detection and
    // join-condition extraction match aliased references correctly — matching
    // only the real name silently misclassifies correlated subqueries as
    // uncorrelated and rewrites them into semantically wrong joins.
    const outerKeys = collectOuterTableKeys(selectStmt, tableName);

    // ── 1. IN / NOT IN 子查询 ──
    const inResult = analyzeInSubquery(whereExpr, outerKeys, tableName);
    if (inResult !== undefined) return inResult;

    // ── 2. EXISTS / NOT EXISTS 子查询 ──
    const existsResult = analyzeExistsSubquery(whereExpr, outerKeys, tableName);
    if (existsResult !== undefined) return existsResult;

    // 没有检测到子查询
    return null;
  /* v8 ignore next -- catch is defensive fallback */
  } catch {
    // 解析失败，返回 null （不做重写）
    return null;
  }
}

/**
 * 获取子查询中的 SELECT 列名（用于构造 JoinCondition）。
 * 只提取第一个列引用。
 */
export function extractSubqueryColumn(subquerySql: string): string | null {
  try {
    const stmt = parseFirst(subquerySql);
    if ((stmt as any).type !== 'select') return null;

    const selectStmt = stmt as any;
    const firstCol = selectStmt.columns?.[0]?.expr;
    if (!firstCol) return null;

    // A bare `*` parses as `{ type: 'ref', name: '*' }`, which is not a concrete
    // column name and cannot form a join condition.
    if (firstCol.type === 'ref' && firstCol.name !== '*') {
      return firstCol.name as string;
    }

    // 处理星号或表达式 — 无法确定具体列名
    return null;
  /* v8 ignore next -- catch is defensive fallback */
  } catch {
    return null;
  }
}

// ── 内部分析函数 ──

/**
 * 分析 IN / NOT IN 子查询表达式。
 * 返回 undefined 表示不是 IN/NOT IN 类型。
 */
function analyzeInSubquery(
  whereExpr: any,
  outerKeys: string[],
  outerTable: string,
): SubqueryRewriteResult | undefined {
  // 必须是 binary 操作，并且操作符为 IN 或 NOT IN
  if (
    whereExpr.type !== 'binary' ||
    (whereExpr.op !== 'IN' && whereExpr.op !== 'NOT IN')
  ) {
    return undefined;
  }

  // 右操作数必须是 select 子查询（而非 list 值列表）
  if (!whereExpr.right || whereExpr.right.type !== 'select') {
    return undefined;
  }

  const subquery = whereExpr.right;
  const isNotIn = whereExpr.op === 'NOT IN';

  // 提取子查询中的表名
  const subqueryTable = extractSubqueryTable(subquery);
  if (!subqueryTable) {
    return { rewritten: false };
  }

  // 提取外层列（IN 左侧）
  const leftRef = whereExpr.left;
  if (!leftRef || leftRef.type !== 'ref') {
    return { rewritten: false };
  }
  const leftColumn = leftRef.name as string;

  // 提取子查询 SELECT 列（第一个列）
  const rightColumn = extractSubquerySelectColumn(subquery);
  if (!rightColumn) {
    return { rewritten: false };
  }

  // 检测子查询是否引用外层表（相关子查询）
  const hasCorrelation = referencesOuterTable(subquery, outerKeys);

  const joinCondition = {
    leftTable: outerTable,
    leftColumn,
    rightTable: subqueryTable,
    rightColumn,
  };

  // 提取原始子查询 SQL 文本（用于 toString）
  const originalSubquery = serializeSelect(subquery);

  return {
    rewrittenPlanType: isNotIn ? 'anti-join' : 'semi-join',
    joinCondition,
    rewritten: !hasCorrelation, // 非相关 → 可重写
    originalSubquery,
    hasCorrelation,
  };
}

/**
 * 分析 EXISTS / NOT EXISTS 子查询表达式。
 * 返回 undefined 表示不是 EXISTS/NOT EXISTS 类型。
 */
function analyzeExistsSubquery(
  whereExpr: any,
  outerKeys: string[],
  outerTable: string,
): SubqueryRewriteResult | undefined {
  // NOT EXISTS: unary(NOT) → call(exists) → select
  if (whereExpr.type === 'unary' && whereExpr.op === 'NOT') {
    const callExpr = extractExistsCall(whereExpr.operand);
    if (callExpr) {
      return buildExistsResult(callExpr, outerKeys, outerTable, true);
    }
    return undefined;
  }

  // EXISTS: call(exists) → select
  const callExpr = extractExistsCall(whereExpr);
  if (callExpr) {
    return buildExistsResult(callExpr, outerKeys, outerTable, false);
  }

  return undefined;
}

/**
 * 从 EXISTS call 表达式构建重写结果。
 */
function buildExistsResult(
  subquery: any,
  outerKeys: string[],
  outerTable: string,
  notExists: boolean,
): SubqueryRewriteResult {
  const subqueryTable = extractSubqueryTable(subquery);
  if (!subqueryTable) {
    return { rewritten: false };
  }

  // 检测是否引用外层表
  const hasCorrelation = referencesOuterTable(subquery, outerKeys);

  // 尝试从子查询 WHERE 中提取关联条件作为连接条件
  const innerKeys = extractSubqueryTableKeys(subquery);
  let joinCondition = extractCorrelationCondition(subquery, outerKeys, innerKeys, outerTable, subqueryTable);

  // 如果子查询没有指向外部表的引用（非相关），但有可用的 WHERE 条件，
  // 尝试从 WHERE 中提取第一个简单的列引用作为默认连接列
  if (!joinCondition && subquery.columns?.[0]?.expr?.type === 'ref') {
    const subqueryCol = subquery.columns[0].expr.name as string;
    // 从子查询的 FROM 表中提取第一个列作为备选
    joinCondition = {
      leftTable: outerTable,
      leftColumn: '',
      rightTable: subqueryTable,
      rightColumn: subqueryCol,
    };
  }

  const originalSubquery = serializeSelect(subquery);

  return {
    rewrittenPlanType: notExists ? 'anti-join' : 'semi-join',
    joinCondition: joinCondition ?? undefined,
    rewritten: !hasCorrelation,
    originalSubquery,
    hasCorrelation,
  };
}

// ── AST 工具函数 ──

/**
 * 收集外层表的所有可能标识符（真实表名 + 所有别名）。
 *
 * 子查询中对 `FROM orders o` 的外层列引用会被解析为 `ref.table.name === 'o'`
 * （别名），而 `ref.table.name === 'orders'` 只在未加别名时出现。只收集真实
 * 表名会漏掉别名引用，导致相关子查询被误判为非相关。
 */
function collectOuterTableKeys(selectStmt: any, tableName: string): string[] {
  const keys = new Set<string>([tableName]);
  for (const fromItem of selectStmt.from ?? []) {
    // A `table` FROM item always carries a `name` object with `name`/`alias`.
    if (fromItem.type === 'table') {
      keys.add(fromItem.name.name);
      if (fromItem.name.alias) keys.add(fromItem.name.alias);
    }
  }
  return [...keys];
}

/**
 * 提取子查询内的表名（第一个 FROM 中的表）。
 */
function extractSubqueryTable(subquery: any): string | null {
  if (!subquery.from || subquery.from.length === 0) return null;
  const fromItem = subquery.from[0];
  if (fromItem.type === 'table' && fromItem.name?.name) {
    return fromItem.name.name;
  }
  return null;
}

/**
 * 提取子查询内表的所有可能标识符（真实表名 + 别名）。
 */
function extractSubqueryTableKeys(subquery: any): string[] {
  const keys: string[] = [];
  // The sole caller (buildExistsResult) guarantees a non-empty `from` via
  // extractSubqueryTable before reaching this point.
  for (const fromItem of subquery.from) {
    // A `table` FROM item always carries a `name` object with `name`/`alias`.
    if (fromItem.type === 'table') {
      keys.push(fromItem.name.name);
      if (fromItem.name.alias) keys.push(fromItem.name.alias);
    }
  }
  return keys;
}

/**
 * 提取子查询 SELECT 子句中的第一个列名。
 */
function extractSubquerySelectColumn(subquery: any): string | null {
  const firstCol = subquery.columns?.[0]?.expr;
  if (!firstCol) return null;
  if (firstCol.type === 'ref') {
    return firstCol.name as string;
  }
  return null;
}

/**
 * 从 exists call 表达式中解包子查询 select 语句。
 * 结构：{ type: 'call', function: { name: 'exists' }, args: [ selectStmt ] }
 */
function extractExistsCall(expr: any): any | null {
  if (!expr) return null;
  if (
    expr.type === 'call' &&
    expr.function?.name &&
    expr.function.name.toLowerCase() === 'exists'
  ) {
    const args = expr.args;
    if (Array.isArray(args) && args.length > 0 && args[0].type === 'select') {
      return args[0];
    }
  }
  return null;
}

/**
 * 检查子查询 AST 中是否包含引用外层表的列。
 *
 * 遍历子查询的 WHERE（以及 HAVING）AST 树，
 * 寻找 type='ref' 且 table.name === outerTable 的节点。
 */
function referencesOuterTable(subquery: any, outerKeys: string[]): boolean {
  // 只在 WHERE 和 HAVING 中检查相关性
  const checkNodes: any[] = [];
  if (subquery.where) checkNodes.push(subquery.where);
  if (subquery.having) checkNodes.push(subquery.having);

  for (const node of checkNodes) {
    const found = findRefToTable(node, outerKeys);
    if (found) return true;
  }
  return false;
}

/**
 * 在 AST 子树中查找对指定表的列引用。
 */
function findRefToTable(ast: any, tableKeys: string[]): boolean {
  if (!ast || typeof ast !== 'object') return false;

  if (
    ast.type === 'ref' &&
    ast.table?.name &&
    tableKeys.includes(ast.table.name)
  ) {
    return true;
  }

  for (const key of Object.keys(ast)) {
    if (key === 'type' || key === 'op' || key === 'name') continue;
    const val = ast[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (findRefToTable(item, tableKeys)) return true;
      }
    } else if (typeof val === 'object') {
      if (findRefToTable(val, tableKeys)) return true;
    }
  }

  return false;
}

/**
 * 从子查询 WHERE 条件中提取关联条件（table1.col = table2.col 格式）。
 * 返回连接条件或 null。
 */
function extractCorrelationCondition(
  subquery: any,
  outerKeys: string[],
  innerKeys: string[],
  outerTable: string,
  innerTable: string,
): { leftTable: string; leftColumn: string; rightTable: string; rightColumn: string } | null {
  if (!subquery.where) return null;

  // 遍历 WHERE 树查找 binary op='=' 的节点
  const conditions: Array<{
    outerCol: string;
    innerCol: string;
  }> = [];

  collectEqualsConditions(subquery.where, outerKeys, innerKeys, outerTable, innerTable, conditions);

  if (conditions.length > 0) {
    const c = conditions[0];
    return {
      leftTable: outerTable,
      leftColumn: c.outerCol,
      rightTable: innerTable,
      rightColumn: c.innerCol,
    };
  }

  return null;
}

/**
 * 递归收集 WHERE 中的等值连接条件。
 */
function collectEqualsConditions(
  ast: any,
  outerKeys: string[],
  innerKeys: string[],
  outerTable: string,
  innerTable: string,
  result: Array<{ outerCol: string; innerCol: string }>,
): void {
  if (!ast || typeof ast !== 'object') return;

  const isOuter = (name: string | undefined) => !!name && outerKeys.includes(name);
  const isInner = (name: string | undefined) => !!name && innerKeys.includes(name);

  if (
    ast.type === 'binary' &&
    ast.op === '=' &&
    ast.left?.type === 'ref' &&
    ast.right?.type === 'ref'
  ) {
    const leftTableName = ast.left.table?.name;
    const rightTableName = ast.right.table?.name;

    // outer.col = inner.col
    if (isOuter(leftTableName) && isInner(rightTableName)) {
      result.push({ outerCol: ast.left.name, innerCol: ast.right.name });
      return;
    }
    // inner.col = outer.col
    if (isInner(leftTableName) && isOuter(rightTableName)) {
      result.push({ outerCol: ast.right.name, innerCol: ast.left.name });
      return;
    }
  }

  // 递归遍历子节点
  for (const key of Object.keys(ast)) {
    if (key === 'type' || key === 'op' || key === 'name') continue;
    const val = ast[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        collectEqualsConditions(item, outerKeys, innerKeys, outerTable, innerTable, result);
      }
    } else if (typeof val === 'object') {
      collectEqualsConditions(val, outerKeys, innerKeys, outerTable, innerTable, result);
    }
  }
}

/**
 * 将 select 子查询序列化为 SQL 字符串。
 *
 * `toSql.statement` is the canonical serializer provided by pgsql-ast-parser
 * and never throws for a well-formed select AST. The catch branch returns an
 * empty string as a defensive last resort so a serialization failure degrades
 * to "no original SQL captured" rather than crashing the planner.
 */
function serializeSelect(subquery: any): string {
  if (subquery?.type !== 'select') return '';
  try {
    const { toSql } = require('pgsql-ast-parser');
    return toSql.statement(subquery);
  /* v8 ignore next -- catch is defensive fallback */
  } catch {
    return '';
  }
}
