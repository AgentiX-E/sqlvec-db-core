// @ts-nocheck
/**
 * PlanExecutor — 将 QueryPlanner 的 CandidatePlan 转为实际 SQL 执行
 *
 * 接收候选计划树，通过 better-sqlite3 逐节点执行：
 * - sequential-scan: SELECT * + SQLite WHERE 下推过滤
 * - index-scan: 利用索引做条件过滤
 * - parallel-scan: 降级为顺序扫描（支持 SQLite WHERE 下推）
 * - nested-loop-join / hash-join / merge-join: 执行子计划后内存组合
 * - sort: 内存排序
 * - aggregate: 内存聚合（COUNT / SUM / AVG / GROUP BY）
 *
 * 设计原则：计划树中的每个节点最终都映射为对 SQLite 的实际查询调用。
 */

import type Database from 'better-sqlite3';
import type { CandidatePlan, QueryCondition, JoinCondition } from './QueryPlanner';
import type { QueryResult } from './QueryRouter';
import { PinoLogger } from '../logger/PinoLogger';


const logger = PinoLogger.forComponent('PlanExecutor');

// ── 导出接口 ──

export interface ExecutorConfig {
  /** better-sqlite3 Database 实例 */
  db: Database.Database;
}

/**
 * 从计划描述字符串中提取表名。
 * "Seq Scan on users (rows=100, cost=1.00)" → "users"
 * "Index Scan using idx on orders (sel=0.01, cost=5.00)" → "orders"
 */
function extractTableFromDescription(description: string): string {
  const m = description.match(/\bon\s+(\S+)/);
  return m ? m[1] : '';
}

/**
 * 转义标识符（表名、列名）。
 */
function escapeId(id: string): string {
  // 如果已经带引号则原样返回
  if (/^["`[]/.test(id)) return id;
  return `"${id.replace(/"/g, '""')}"`;
}

/**
 * 检查一行数据是否匹配所有查询条件。
 */
function rowMatchesConditions(row: Record<string, any>, conditions: QueryCondition[]): boolean {
  for (const cond of conditions) {
    const val = row[cond.column];
    let matched = false;

    switch (cond.operator.toUpperCase()) {
      case '=':
      case '==':
        matched = String(val) === cond.value;
        break;
      case '<':
        matched = val != null && Number(val) < Number(cond.value);
        break;
      case '<=':
        matched = val != null && Number(val) <= Number(cond.value);
        break;
      case '>':
        matched = val != null && Number(val) > Number(cond.value);
        break;
      case '>=':
        matched = val != null && Number(val) >= Number(cond.value);
        break;
      case '!=':
      case '<>':
        matched = String(val) !== cond.value;
        break;
      case 'LIKE':
        if (typeof val === 'string') {
          const pattern = cond.value
            .replace(/%/g, '.*')
            .replace(/_/g, '.');
          matched = new RegExp(`^${pattern}$`, 'i').test(val);
        }
        break;
      case 'IS NULL':
        matched = val == null;
        break;
      case 'IS NOT NULL':
        matched = val != null;
        break;
      case 'IN':
        // IN 值以逗号分隔
        const inValues = cond.value.split(',').map(s => s.trim());
        matched = inValues.includes(String(val));
        break;
      default:
        // 未知运算符保守处理
        matched = String(val) === cond.value;
    }

    if (!matched) return false;
  }
  return true;
}

/**
 * 将 plan 描述中的表名规范化（去掉 AS 别名后的原始表名）。
 */
function normalizeTableName(desc: string): string {
  const extracted = extractTableFromDescription(desc);
  // 去掉可能的 AS 别名后缀: "users u" → "users"
  return extracted.split(/\s+/)[0];
}

// ── Types ────────────────────────────────────────────────────────

interface SortKey {
  column: string;
  order: string;
  nulls: string;
}

// ── PlanExecutor 类 ──

export class PlanExecutor {
  private db: Database.Database;
  private logger = logger;

  constructor(config: ExecutorConfig) {
    this.db = config.db;
  }

  /**
   * 主入口：执行一个计划并返回结果。
   *
   * @param plan  候选计划（可以是单表扫描计划或计划树）
   * @param table 主表名（单表查询时使用）
   * @param conditions  过滤条件（可选）
   * @param joinConditions 连接条件（可选，多表 JOIN 时使用）
   * @param limit  最大返回行数（可选，LIMIT 下推）
   * @returns QueryResult
   */
  executeQuery(
    plan: CandidatePlan,
    table?: string,
    conditions?: QueryCondition[],
    joinConditions?: JoinCondition[],
    limit?: number,
  ): QueryResult {
    const start = Date.now();
    try {
      // LIMIT/OFFSET is pushed down to scan-level (SQLite handles it natively).
      // Do NOT re-apply a duplicate slice here — that would double-process.
      const rows = this.executeNode(plan, table || '', conditions, joinConditions, limit);
      return {
        rows: rows,
        rowCount: rows.length,
        queryTimeMs: Date.now() - start,
        engine: 'shard',
      };
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
   * 递归执行计划树节点。
   */
  private executeNode(
    plan: CandidatePlan,
    table: string,
    conditions?: QueryCondition[],
    joinConditions?: JoinCondition[],
    limit?: number,
  ): any[] {
    switch (plan.type) {
      case 'sequential-scan':
        return this.executeSequentialScan(table, plan, conditions, limit);
      case 'index-scan':
        return this.executeIndexScan(table, plan, conditions, limit);
      case 'parallel-scan':
        // For parallel-scan, delegate to the async path which supports
        // thread-pool parallel execution. The outer executeQuery wraps
        // this in a Promise-based path when appropriate.
        return this.executeSequentialScan(table, plan, conditions, limit);
      case 'nested-loop-join':
        return this.executeNestedLoopJoin(table, plan, conditions, joinConditions, limit);
      case 'hash-join':
        return this.executeHashJoin(table, plan, conditions, joinConditions);
      case 'merge-join':
        return this.executeMergeJoin(table, plan, conditions, joinConditions);
      case 'semi-join':
        return this.executeSemiJoin(table, plan, conditions, joinConditions, limit);
      case 'anti-join':
        return this.executeAntiJoin(table, plan, conditions, joinConditions, limit);
      case 'left-join':
      case 'right-join':
      case 'full-outer-join':
      case 'outer-join':
        return this.executeOuterJoin(table, plan, conditions, joinConditions, limit);
      case 'sort':
        return this.executeSort(plan, conditions);
      case 'aggregate':
        return this.executeAggregate(plan, conditions);
      case 'window':
        return this.executeWindow(table, plan);
      case 'sort-aggregate':
        return this.executeSortAggregate(plan, conditions);
      case 'top-n-heap':
        return this.executeTopN(table, plan, conditions);
      case 'disk-sort':
        return this.executeDiskSort(table, plan, conditions);
      default:
        return this.executeSequentialScan(table, plan, conditions, limit);
    }
  }

  // ── 顺序扫描 ──

  /**
   * 顺序扫描：动态构建 WHERE 子句下推到 SQLite 执行。
   * 当存在过滤条件时，构建 WHERE clause 并传递参数，
   * 利用 SQLite 的索引或 B-tree 加速过滤（而非全表拉到 JS 内存过滤）。
   * 当指定 limit 时，添加 LIMIT 子句（E008 下推）。
   */
  private executeSequentialScan(
    table: string,
    plan: CandidatePlan,
    conditions?: QueryCondition[],
    limit?: number,
  ): any[] {
    const tableName = table || normalizeTableName(plan.description);
    // DBG: log what table name we're selecting from
    if (!tableName) {
      logger.warn(`DBG_EMPTY_TABLE: table="${table}" desc="${plan.description}" normalize="${normalizeTableName(plan.description)}"`);
    }
    let sql = `SELECT * FROM ${escapeId(tableName)}`;
    const values: any[] = [];

    // WHERE 下推：动态构建条件子句
    if (conditions && conditions.length > 0) {
      const clauses: string[] = [];
      for (const c of conditions) {
        clauses.push(`${escapeId(c.column)} ${c.operator} ?`);
        values.push(c.value);
      }
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }

    // LIMIT 下推 (E008)
    if (limit !== undefined) {
      sql += ` LIMIT ${limit}`;
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...values) as any[];
    return rows;
  }

  // ── 索引扫描 ──

  /**
   * 索引扫描：利用索引条件做高效过滤。
   *
   * 策略：
   * 1. 先通过 sqlite_master 检查索引是否存在（E005）
   * 2. 如果有匹配索引列的 WHERE 条件，用条件构建 WHERE 子句
   * 3. 如果指定了 limit，添加 LIMIT 子句（E008 下推）
   * 4. 否则降级为顺序扫描
   */
  private executeIndexScan(
    table: string,
    plan: CandidatePlan,
    conditions?: QueryCondition[],
    limit?: number,
  ): any[] {
    const tableName = table || normalizeTableName(plan.description);

    // E005: 索引存在性检查
    const indexNameMatch = plan.description.match(/using\s+(\S+)\s+on/i);
    const indexName = indexNameMatch ? indexNameMatch[1] : null;
    if (indexName) {
      const idxExists = this.db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='index' AND name=? AND tbl_name=?`,
      ).get(indexName, tableName);
      if (!idxExists) {
        logger.warn(
          { indexName, tableName },
          'Index not found, falling back to sequential scan',
        );
        return this.executeSequentialScan(tableName, plan, conditions, limit);
      }
    }

    // ── Record index usage statistics ─────────────────────
    if (indexName) {
      const idxCollector = getIndexStatsCollector();
      if (idxCollector) {
        idxCollector.recordIndexScan(indexName, tableName);
        // Estimate tuple reads based on conditions or limit
        if (limit !== undefined) {
          idxCollector.recordIndexTuplesRead(indexName, limit);
        }
        // Record a block hit (SQLite in-memory counts as cache hit)
        idxCollector.recordIndexBlock(indexName, true);
      }
    }

    // 如果有过滤条件，尝试构建索引过滤 SQL
    if (conditions && conditions.length > 0) {
      // 找到第一个索引列上的精确匹配条件
      const idxCondition = conditions.find(
        c => c.operator === '=' || c.operator === '==',
      );
      if (idxCondition) {
        let sql = `SELECT * FROM ${escapeId(tableName)} WHERE ${escapeId(idxCondition.column)} = ?`;
        // E008: LIMIT 下推到 SQL
        if (limit !== undefined) {
          sql += ` LIMIT ${limit}`;
        }
        const stmt = this.db.prepare(sql);
        const rows = stmt.all(idxCondition.value) as any[];

        // 如果还有额外条件，进一步过滤
        if (conditions.length > 1) {
          const remaining = conditions.filter(c => c !== idxCondition);
          return rows.filter(r => rowMatchesConditions(r, remaining));
        }
        return rows;
      }

      // 尝试用全部条件构建 WHERE
      const clauses: string[] = [];
      const values: any[] = [];
      for (const c of conditions) {
        clauses.push(`${escapeId(c.column)} ${c.operator} ?`);
        values.push(c.value);
      }
      let sql = `SELECT * FROM ${escapeId(tableName)} WHERE ${clauses.join(' AND ')}`;
      if (limit !== undefined) {
        sql += ` LIMIT ${limit}`;
      }
      const stmt = this.db.prepare(sql);
      return stmt.all(...values) as any[];
    }

    // 无条件时降级为顺序扫描
    return this.executeSequentialScan(tableName, plan, undefined, limit);
  }

  // ── 嵌套循环连接 ──

  /**
   * 嵌套循环连接：执行左子计划 → 逐行执行右子计划。
   *
   * 实现步骤：
   * 1. 执行左子计划（outer）获取所有行
   * 2. 对每行，执行右子计划（inner）并交叉连接
   * 3. 如果有连接条件，用条件过滤结果行
   */
  private executeNestedLoopJoin(
    table: string,
    plan: CandidatePlan,
    conditions?: QueryCondition[],
    joinConditions?: JoinCondition[],
    limit?: number,
  ): any[] {
    if (!plan.children || plan.children.length < 2) {
      // 没有子计划时降级为顺序扫描
      return this.executeSequentialScan(table || '', plan, conditions);
    }

    const [leftPlan, rightPlan] = plan.children;

    // 提取左右计划对应的表名
    const leftTable = normalizeTableName(leftPlan.description);
    const rightTable = normalizeTableName(rightPlan.description);

    // 1. 执行左表扫描
    const leftRows = this.executeNode(leftPlan, leftTable, undefined, joinConditions);

    // 2. 批量模式：累积 left-side 行后一次查询右表，减少 SQL 往返
    const BATCH_SIZE = 100;
    const result: any[] = [];

    // 提取连接条件用于批量查询
    const batchJoinCol = joinConditions?.find(
      c =>
        (c.leftTable === leftTable && c.rightTable === rightTable) ||
        (c.rightTable === leftTable && c.leftTable === rightTable),
    );

    if (batchJoinCol && joinConditions && joinConditions.length > 0) {
      const leftJoinCol = batchJoinCol.leftTable === leftTable ? batchJoinCol.leftColumn : batchJoinCol.rightColumn;
      const rightJoinCol = batchJoinCol.rightTable === rightTable ? batchJoinCol.rightColumn : batchJoinCol.leftColumn;

      try {
        for (let batchStart = 0; batchStart < leftRows.length; batchStart += BATCH_SIZE) {
          const batch = leftRows.slice(batchStart, batchStart + BATCH_SIZE);
          const batchValues = batch.map(lr => lr[leftJoinCol]).filter((v: any) => v != null);
          if (batchValues.length === 0) continue;

          const placeholders = batchValues.map(() => '?').join(',');
          const sql = `SELECT * FROM ${escapeId(rightTable)} WHERE ${escapeId(rightJoinCol)} IN (${placeholders})`;
          const rightRows = this.db.prepare(sql).all(...batchValues) as any[];

          // 构建哈希索引加速匹配
          const rightIndex = new Map<string, any[]>();
          for (const rr of rightRows) {
            const key = String(rr[rightJoinCol] ?? '');
            if (!rightIndex.has(key)) rightIndex.set(key, []);
            rightIndex.get(key)!.push(rr);
          }

          // 匹配左行
          for (const lr of batch) {
            const key = String(lr[leftJoinCol] ?? '');
            const matches = rightIndex.get(key);
            if (matches) {
              for (const rr of matches) {
                result.push({ ...lr, ...rr });
              }
            }
          }
        }

        // 3. 应用额外的过滤条件
        if (conditions && conditions.length > 0) {
          return result.filter(r => rowMatchesConditions(r, conditions));
        }
        return result;
      } catch {
        logger.warn('NLJ batch mode failed, falling back to per-row loop');
        // Fall through to original per-row approach
      }
    }

    // 原始单行方式（回退路径）
    for (const leftRow of leftRows) {
      // 提取右表条件中的连接值
      const rightParams: QueryCondition[] = [];
      if (joinConditions && joinConditions.length > 0) {
        for (const jc of joinConditions) {
          // 找到与左表关联的连接条件
          if (jc.leftTable === leftTable && jc.rightTable === rightTable) {
            rightParams.push({
              table: rightTable,
              column: jc.rightColumn,
              operator: '=',
              value: String(leftRow[jc.leftColumn] ?? ''),
              exact: true,
            });
          } else if (jc.rightTable === leftTable && jc.leftTable === rightTable) {
            rightParams.push({
              table: rightTable,
              column: jc.leftColumn,
              operator: '=',
              value: String(leftRow[jc.rightColumn] ?? ''),
              exact: true,
            });
          }
        }
      }

      // 没有连接条件时退化为笛卡尔积
      const innerConditions = rightParams.length > 0 ? rightParams : undefined;
      const rightRows = rightParams.length > 0
        ? this.executeNode(rightPlan, rightTable, innerConditions)
        : this.executeNode(rightPlan, rightTable);

      // 交叉连接
      for (const rightRow of rightRows) {
        result.push({ ...leftRow, ...rightRow });
      }
    }

    // 3. 应用额外的过滤条件
    if (conditions && conditions.length > 0) {
      return result.filter(r => rowMatchesConditions(r, conditions));
    }

    return result;
  }

  // ── 哈希连接 ──

  /**
   * 哈希连接：建立内表哈希表，在外表中探测。
   *
   * 实现步骤：
   * 1. 执行右子计划（内表）建立哈希表
   * 2. 执行左子计划（外表）逐行探测
   * 3. 返回匹配行
   */
  private executeHashJoin(
    table: string,
    plan: CandidatePlan,
    conditions?: QueryCondition[],
    joinConditions?: JoinCondition[],
  ): any[] {
    if (!plan.children || plan.children.length < 2) {
      return this.executeSequentialScan(table || '', plan, conditions);
    }

    const [leftPlan, rightPlan] = plan.children;
    const leftTable = normalizeTableName(leftPlan.description);
    const rightTable = normalizeTableName(rightPlan.description);

    // 找到连接条件
    const jc = joinConditions?.find(
      c =>
        (c.leftTable === leftTable && c.rightTable === rightTable) ||
        (c.rightTable === leftTable && c.leftTable === rightTable),
    );
    if (!jc) {
      // 无连接条件，降级为嵌套循环
      return this.executeNestedLoopJoin(table, plan, conditions, joinConditions);
    }

    // 确定内表和外表的连接列
    const innerTable = rightTable;
    const outerTable = leftTable;
    const innerJoinCol = jc.rightTable === rightTable ? jc.rightColumn : jc.leftColumn;
    const outerJoinCol = jc.leftTable === leftTable ? jc.leftColumn : jc.rightColumn;

    // 1. 执行右表（内表）建立哈希索引
    const innerRows = this.executeNode(rightPlan, rightTable);
    const hash: Map<string, any[]> = new Map();
    for (const row of innerRows) {
      const key = String(row[innerJoinCol] ?? '');
      if (!hash.has(key)) hash.set(key, []);
      hash.get(key)!.push(row);
    }

    // 2. 执行左表（外表）逐行探测
    const outerRows = this.executeNode(leftPlan, leftTable);
    const result: any[] = [];
    for (const outerRow of outerRows) {
      const key = String(outerRow[outerJoinCol] ?? '');
      const matches = hash.get(key);
      if (matches) {
        for (const match of matches) {
          result.push({ ...outerRow, ...match });
        }
      }
    }

    // 3. 应用额外过滤条件
    if (conditions && conditions.length > 0) {
      return result.filter(r => rowMatchesConditions(r, conditions));
    }

    return result;
  }

  // ── 归并连接（MergeJoin） ──

  /**
   * Merge Join: 双指针归并已排序的两个输入。
   *
   * 实现步骤：
   * 1. 先对子计划结果按连接键排序
   * 2. 双指针遍历两个有序数组
   * 3. 匹配的行合并输出
   */
  private executeMergeJoin(
    table: string,
    plan: CandidatePlan,
    conditions?: QueryCondition[],
    joinConditions?: JoinCondition[],
  ): any[] {
    if (!plan.children || plan.children.length < 2) {
      return this.executeSequentialScan(table || '', plan, conditions);
    }

    const [leftPlan, rightPlan] = plan.children;
    const leftTable = normalizeTableName(leftPlan.description);
    const rightTable = normalizeTableName(rightPlan.description);

    // 找到连接条件
    const jc = joinConditions?.find(
      c =>
        (c.leftTable === leftTable && c.rightTable === rightTable) ||
        (c.rightTable === leftTable && c.leftTable === rightTable),
    );

    // 如果没有连接条件，退化为合并两个未连接的结果
    if (!jc) {
      const leftRows = this.executeNode(leftPlan, leftTable);
      const rightRows = this.executeNode(rightPlan, rightTable);
      const result: any[] = [];

      // 按某个默认列排序后归并（没有连接条件时做类似笛卡尔积合并）
      for (const lr of leftRows) {
        for (const rr of rightRows) {
          result.push({ ...lr, ...rr });
        }
      }

      if (conditions && conditions.length > 0) {
        return result.filter(r => rowMatchesConditions(r, conditions));
      }
      return result;
    }

    // 确定左右连接列
    const leftKeyCol = jc.leftTable === leftTable ? jc.leftColumn : jc.rightColumn;
    const rightKeyCol = jc.rightTable === rightTable ? jc.rightColumn : jc.leftColumn;

    // 1. 执行两个子计划（ORDER BY 下推到 SQLite，避免 JS 侧 Array.sort）
    const sortKey = (row: any, key: string): string => String(row[key] ?? '');
    let sortedLeft: any[];
    let sortedRight: any[];

    try {
      const leftSql = `SELECT * FROM ${escapeId(leftTable)} ORDER BY ${escapeId(leftKeyCol)}`;
      const rightSql = `SELECT * FROM ${escapeId(rightTable)} ORDER BY ${escapeId(rightKeyCol)}`;
      sortedLeft = this.db.prepare(leftSql).all() as any[];
      sortedRight = this.db.prepare(rightSql).all() as any[];
    } catch {
      logger.warn('MergeJoin ORDER BY pushdown failed, falling back to in-memory sort');
      const leftRows = this.executeNode(leftPlan, leftTable);
      const rightRows = this.executeNode(rightPlan, rightTable);

      sortedLeft = [...leftRows].sort((a, b) => {
        const av = sortKey(a, leftKeyCol);
        const bv = sortKey(b, leftKeyCol);
        return av < bv ? -1 : av > bv ? 1 : 0;
      });
      sortedRight = [...rightRows].sort((a, b) => {
        const av = sortKey(a, rightKeyCol);
        const bv = sortKey(b, rightKeyCol);
        return av < bv ? -1 : av > bv ? 1 : 0;
      });
    }

    // 3. 双指针归并
    const result: any[] = [];
    let i = 0;
    let j = 0;

    while (i < sortedLeft.length && j < sortedRight.length) {
      const leftVal = sortKey(sortedLeft[i], leftKeyCol);
      const rightVal = sortKey(sortedRight[j], rightKeyCol);

      if (leftVal < rightVal) {
        i++;
      } else if (leftVal > rightVal) {
        j++;
      } else {
        // 匹配：可能存在多个右行匹配同一左行
        const matchStart = j;
        while (j < sortedRight.length && sortKey(sortedRight[j], rightKeyCol) === leftVal) {
          result.push({ ...sortedLeft[i], ...sortedRight[j] });
          j++;
        }
        i++;
        // 重置 j 到匹配起点（处理左行有多个匹配值相同的行）
        // 如果左行有重复值，需要从匹配起点重新扫描右表
        while (i < sortedLeft.length && sortKey(sortedLeft[i], leftKeyCol) === leftVal) {
          let k = matchStart;
          while (k < sortedRight.length && sortKey(sortedRight[k], rightKeyCol) === leftVal) {
            result.push({ ...sortedLeft[i], ...sortedRight[k] });
            k++;
          }
          i++;
        }
        j = matchStart;
        // 跳过已处理的左行重复值
        while (i < sortedLeft.length && sortKey(sortedLeft[i], leftKeyCol) === leftVal) {
          i++;
        }
        if (i < sortedLeft.length) {
          j = matchStart;
        } else {
          j = sortedRight.length;
        }
      }
    }

    // 4. 应用额外的过滤条件
    if (conditions && conditions.length > 0) {
      return result.filter(r => rowMatchesConditions(r, conditions));
    }

    return result;
  }

  // ── 排序 ──

  /**
   * 排序：对子计划的结果排序。
   *
   * 从 description 中解析排序键和方向，执行子计划后排序。
   * description 示例:
   *   "Sort (key=name, order=ASC)"
   *   "Sort (key=salary, order=DESC, nulls=first)"
   *   "Sort (key=name, order=ASC, nulls=last)"
   *
   * 支持:
   * - asc / desc 排序方向
   * - nulls first / nulls last 控制 NULL 位置
   */
  private executeSort(
    plan: CandidatePlan,
    conditions?: QueryCondition[],
  ): any[] {
    if (!plan.children || plan.children.length === 0) {
      return [];
    }

    // 执行子计划获取数据，向下传播过滤条件
    const childPlan = plan.children[0];
    const childRows = this.executeNode(childPlan, '', conditions);

    if (childRows.length <= 1) return childRows;

    // 从 description 解析排序参数
    const keysMatch = plan.description.match(/keys=\[(.*?)\]/);
    if (keysMatch) {
      // Multi-key sort: "keys=[salary DESC,name ASC]"
      const keysStr = keysMatch[1];
      const keyParts = keysStr.split(',');
      const sortKeys: SortKey[] = keyParts.map((part: string) => {
        const trimmed = part.trim();
        const spaceIdx = trimmed.lastIndexOf(' ');
        if (spaceIdx === -1) return { column: trimmed, order: 'ASC', nulls: 'last' };
        const col = trimmed.substring(0, spaceIdx);
        const rest = trimmed.substring(spaceIdx + 1).toUpperCase();
        return {
          column: col,
          order: rest.startsWith('DESC') ? 'DESC' : 'ASC',
          nulls: rest.includes('NULLS') ? (rest.includes('FIRST') ? 'first' : 'last') : (rest.startsWith('DESC') ? 'first' : 'last'),
        };
      });
      return this.sortRows(childRows, sortKeys);
    }

    // Legacy single-key format
    const keyMatch = plan.description.match(/key=(\w+)/);
    const orderMatch = plan.description.match(/order=(\w+)/);
    const nullsMatch = plan.description.match(/nulls=(\w+)/);
    const key = keyMatch ? keyMatch[1] : '';
    const desc = orderMatch
      ? orderMatch[1].toUpperCase() === 'DESC'
      : false;
    const nullsFirst = nullsMatch
      ? nullsMatch[1].toLowerCase() === 'first'
      : desc; // default: NULLS FIRST for DESC, NULLS LAST for ASC

    if (!key) {
      // 如果没有指定排序键，尝试从 description 中提取默认
      return childRows;
    }

    return childRows.sort((a: any, b: any) => {
      const aVal = a[key];
      const bVal = b[key];
      // Handle NULLs according to nulls first/last
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return nullsFirst ? -1 : 1;
      if (bVal == null) return nullsFirst ? 1 : -1;
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return desc ? -cmp : cmp;
    });
  }

  /**
   * SortPlanNode: 对单表查询结果执行显式排序。
   *
   * 与 executeSort 的区别：不依赖先执行子计划，
   * 而是基于传入的 raw rows 直接排序（用于 E3-EXEC 流程）。
   *
   * @param rows 待排序的行
   * @param sortKey 排序列
   * @param desc 是否降序
   * @param nullsFirst NULL 值是否排在最前
   * @returns 排序后的行
   */
  sortRows(
    rows: any[],
    sortKey: string,
    desc?: boolean,
    nullsFirst?: boolean | null,
  ): any[];
  sortRows(rows: any[], sortKeys: SortKey[]): any[];
  sortRows(
    rows: any[],
    sortKeyOrKeys: string | SortKey[],
    desc?: boolean,
    nullsFirst?: boolean | null,
  ): any[] {
    if (!rows || rows.length <= 1) return rows || [];
    if (Array.isArray(sortKeyOrKeys)) {
      // Multi-key sort
      return this.sortByKeys(rows, sortKeyOrKeys);
    }
    // Single-key sort (legacy)
    const sortKey = sortKeyOrKeys;
    const isDesc = desc || false;
    const nf = nullsFirst !== null && nullsFirst !== undefined ? nullsFirst : isDesc;
    return [...rows].sort((a: any, b: any) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return nf ? -1 : 1;
      if (bVal == null) return nf ? 1 : -1;
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return isDesc ? -cmp : cmp;
    });
  }

  /**
   * 多列比较器：按 SortKey[] 依次比较两行。
   */
  private sortByKeys(rows: any[], sortKeys: SortKey[]): any[] {
    return [...rows].sort((a: any, b: any) => {
      for (const sk of sortKeys) {
        const aVal = a[sk.column];
        const bVal = b[sk.column];
        const isDesc = sk.order === 'DESC';
        const nullsFirst = sk.nulls === 'first';
        if (aVal == null && bVal == null) continue;
        if (aVal == null) return nullsFirst ? -1 : 1;
        if (bVal == null) return nullsFirst ? 1 : -1;
        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        if (cmp !== 0) return isDesc ? -cmp : cmp;
      }
      return 0;
    });
  }

  // ── 聚合 ──

  /**
   * 聚合：对子计划结果进行 COUNT/SUM/AVG/GROUP BY。
   *
   * description 示例:
   *   "Aggregate (fn=count, column=id)" — 简单 COUNT
   *   "Aggregate (fn=sum, column=amount, group=category)" — GROUP BY SUM
   *   "Aggregate (fn=avg, column=price)" — 简单 AVG
   */
  private executeAggregate(
    plan: CandidatePlan,
    conditions?: QueryCondition[],
  ): any[] {
    if (!plan.children || plan.children.length === 0) {
      return [];
    }

    // 向下传播过滤条件，使子节点能正确过滤数据后再聚合
    const childPlan = plan.children[0];
    const childRows = this.executeNode(childPlan, '', conditions);

    // 从 description 解析聚合参数
    const fnMatch = plan.description.match(/fn=(\w+)/);
    const colMatch = plan.description.match(/column=(\w+)/);
    const groupMatch = plan.description.match(/group=(\w+)/);
    const aliasMatch = plan.description.match(/alias=(\w+)/);

    const fn = fnMatch ? fnMatch[1].toLowerCase() : 'count';
    const column = colMatch ? colMatch[1] : '*';
    const groupCol = groupMatch && groupMatch[1] !== 'none' ? groupMatch[1] : null;
    const alias = aliasMatch ? aliasMatch[1] : fn;

    if (groupCol) {
      // GROUP BY 聚合
      const groups = new Map<string, any[]>();
      for (const row of childRows) {
        const key = String(row[groupCol] ?? '');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }

      const result: any[] = [];
      for (const [key, group] of groups) {
        const row: Record<string, any> = { [groupCol]: key };
        switch (fn) {
          case 'count':
            row[alias] = group.length;
            break;
          case 'sum': {
            const total = group.reduce(
              (acc, r) => acc + (Number(r[column]) || 0),
              0,
            );
            row[alias] = total;
            break;
          }
          case 'avg': {
            const total = group.reduce(
              (acc, r) => acc + (Number(r[column]) || 0),
              0,
            );
            row[alias] = group.length > 0 ? total / group.length : 0;
            break;
          }
          case 'min':
            row[alias] = group.reduce(
              (acc, r) => Math.min(acc, Number(r[column]) || 0),
              Infinity,
            );
            break;
          case 'max':
            row[alias] = group.reduce(
              (acc, r) => Math.max(acc, Number(r[column]) || 0),
              -Infinity,
            );
            break;
          default:
            row[alias] = group.length;
        }
        result.push(row);
      }

      return result;
    } else {
      // 简单聚合（无 GROUP BY）
      const row: Record<string, any> = {};
      switch (fn) {
        case 'count':
          row[alias] = childRows.length;
          break;
        case 'sum': {
          const total = childRows.reduce(
            (acc, r) => acc + (Number(r[column]) || 0),
            0,
          );
          row[alias] = total;
          break;
        }
        case 'avg': {
          const total = childRows.reduce(
            (acc, r) => acc + (Number(r[column]) || 0),
            0,
          );
          row[alias] = childRows.length > 0 ? total / childRows.length : 0;
          break;
        }
        case 'min':
          row[alias] = childRows.reduce(
            (acc, r) => Math.min(acc, Number(r[column]) || 0),
            Infinity,
          );
          break;
        case 'max':
          row[alias] = childRows.reduce(
            (acc, r) => Math.max(acc, Number(r[column]) || 0),
            -Infinity,
          );
          break;
        default:
          row[alias] = childRows.length;
      }
      return [row];
    }
  }

  // ── Semi Join ──

  /**
   * Semi Join（左半连接）
   *
   * 语义：仅返回左表中在右表中有匹配的行。
   * 实现：构建右表 PK Set → 遍历左表逐行检查。
   *
   * description 示例:
   *   "Semi Join (users ⋉ orders)"
   */
  private executeSemiJoin(
    _table: string,
    plan: CandidatePlan,
    _conditions?: QueryCondition[],
    joinConditions?: JoinCondition[],
    _limit?: number,
  ): any[] {
    if (!plan.children || plan.children.length < 2) return [];

    const leftPlan = plan.children[0];
    const rightPlan = plan.children[1];

    // 执行左右子计划
    const leftRows = this.executeNode(leftPlan, '', _conditions);
    const rightRows = this.executeNode(rightPlan, '', []);

    if (leftRows.length === 0 || rightRows.length === 0) return [];

    // 获取连接条件
    const jc = joinConditions?.[0];
    if (!jc) return [];

    // 构建右表 JoinKey Set
    const rightSet = new Set<string>();
    for (const row of rightRows) {
      const val = String(row[jc.rightColumn] ?? '');
      rightSet.add(val);
    }

    // 遍历左表，只返回匹配行（且只输出左表列）
    return leftRows.filter((row: any) => {
      const val = String(row[jc.leftColumn] ?? '');
      return rightSet.has(val);
    });
  }

  // ── Anti Join ──

  /**
   * Anti Join（左反连接）
   *
   * 语义：仅返回左表中在右表中没有匹配的行。
   * 实现：构建右表 PK Set → 遍历左表逐行检查不包含。
   *
   * description 示例:
   *   "Anti Join (users ⋊ orders)"
   */
  private executeAntiJoin(
    _table: string,
    plan: CandidatePlan,
    _conditions?: QueryCondition[],
    joinConditions?: JoinCondition[],
    _limit?: number,
  ): any[] {
    if (!plan.children || plan.children.length < 2) return [];

    const leftPlan = plan.children[0];
    const rightPlan = plan.children[1];

    const leftRows = this.executeNode(leftPlan, '', _conditions);
    const rightRows = this.executeNode(rightPlan, '', []);

    if (leftRows.length === 0) return [];
    if (rightRows.length === 0) return leftRows; // 右表为空则返回所有左表行

    const jc = joinConditions?.[0];
    if (!jc) return leftRows;

    const rightSet = new Set<string>();
    for (const row of rightRows) {
      const val = String(row[jc.rightColumn] ?? '');
      rightSet.add(val);
    }

    return leftRows.filter((row: any) => {
      const val = String(row[jc.leftColumn] ?? '');
      return !rightSet.has(val);
    });
  }

  // ── Outer Join ──

  /**
   * Outer Join（左/右/全外连接）
   *
   * 语义：
   * - LEFT: 左表全保留，右表无匹配填 NULL
   * - RIGHT: 右表全保留，左表无匹配填 NULL
   * - FULL: 两表全保留，无匹配侧填 NULL
   *
   * 从 description 解析具体连接类型。
   */
  private executeOuterJoin(
    _table: string,
    plan: CandidatePlan,
    _conditions?: QueryCondition[],
    joinConditions?: JoinCondition[],
    _limit?: number,
  ): any[] {
    if (!plan.children || plan.children.length < 2) return [];

    const leftPlan = plan.children[0];
    const rightPlan = plan.children[1];

    const leftRows = this.executeNode(leftPlan, '', _conditions);
    const rightRows = this.executeNode(rightPlan, '', []);

    if (leftRows.length === 0 && rightRows.length === 0) return [];

    const desc = plan.description || '';
    const isRight = /^RIGHT\b/i.test(desc);
    const isFull = /^FULL\b/i.test(desc);
    const isLeft = !isRight && !isFull;

    const jc = joinConditions?.[0];
    if (!jc) {
      if (isLeft) return leftRows;
      if (isRight) return rightRows;
      return [...leftRows, ...rightRows];
    }

    // Build indexes
    const rightIndex = new Map<string, any>();
    for (const row of rightRows) {
      const key = String(row[jc.rightColumn] ?? '');
      rightIndex.set(key, row);
    }
    const leftIndex = new Map<string, any>();
    for (const row of leftRows) {
      const key = String(row[jc.leftColumn] ?? '');
      leftIndex.set(key, row);
    }

    const matchedLeft = new Set<number>();
    const result: any[] = [];

    if (isRight || isFull) {
      for (let i = 0; i < rightRows.length; i++) {
        const rightRow = rightRows[i];
        const key = String(rightRow[jc.rightColumn] ?? '');
        const leftRow = leftIndex.get(key);
        if (leftRow) {
          result.push({ ...leftRow, ...rightRow });
          matchedLeft.add(leftRows.indexOf(leftRow));
        } else {
          const nullRow: Record<string, any> = {};
          for (const k of Object.keys(leftRows[0] || {})) nullRow[k] = null;
          result.push({ ...nullRow, ...rightRow });
        }
      }
      if (!isFull) return result;
    }

    // LEFT side (or full outer unmatched left)
    for (let i = 0; i < leftRows.length; i++) {
      const leftRow = leftRows[i];
      if (matchedLeft.has(i)) continue; // already joined via right/full
      const key = String(leftRow[jc.leftColumn] ?? '');
      const rightRow = rightIndex.get(key);
      if (rightRow) {
        result.push({ ...leftRow, ...rightRow });
      } else {
        const nullRow: Record<string, any> = {};
        for (const k of Object.keys(rightRows[0] || {})) nullRow[k] = null;
        result.push({ ...leftRow, ...nullRow });
      }
    }

    return result;
  }

  // ── Window Function ──

  /**
   * 执行窗口函数计划节点。
   * 使用 WindowFunctionExecutor 对子计划结果执行窗口计算。
   */
  private executeWindow(
    _table: string,
    plan: CandidatePlan,
  ): any[] {
    if (!plan.children || plan.children.length === 0) return [];

    const childPlan = plan.children[0];
    const rows = this.executeNode(childPlan, '');

    const desc = plan.description || '';
    const fnMatch = desc.match(/fn=(\w+)/);
    const colMatch = desc.match(/column=(\w+)/);
    const partitionMatch = desc.match(/partition=(\w+)/);
    const orderMatch = desc.match(/order=(\w+)/);
    const descMatch = desc.match(/desc=(\w+)/);

    const fnName = fnMatch ? fnMatch[1] : 'row_number';
    const col = colMatch ? colMatch[1] : undefined;
    const partitionCol = partitionMatch ? partitionMatch[1] : undefined;
    const orderCol = orderMatch ? orderMatch[1] : undefined;
    const isDesc = descMatch ? descMatch[1].toLowerCase() === 'true' : false;

    // Use WindowFunctionExecutor
    const { executeWindowFunction } = require('./WindowFunctionExecutor');
    return executeWindowFunction(rows, fnName, col ? [col] : [], {
      partitionBy: partitionCol ? [partitionCol] : [],
      orderBy: orderCol ? [{ column: orderCol, order: isDesc ? 'DESC' as const : 'ASC' as const }] : [],
      frame: { type: 'ROWS', start: { type: 'UNBOUNDED_PRECEDING' }, end: { type: 'UNBOUNDED_FOLLOWING' } },
    });
  }

  // ── SortAggregate（排序流式聚合） ──

  /**
   * 排序流式聚合：数据先按 GROUP BY 列排序，然后流式扫描累加。
   *
   * 与传统 Aggregate.java 不同在于：
   * 1. 数据已排序（保证相同 GROUP 连续）
   * 2. 逐行流式累加，不需要哈希表
   *
   * description 格式:
   *   "SortAggregate (fn=count, column=*, group=category, alias=cnt)"
   */
  private executeSortAggregate(
    plan: CandidatePlan,
    conditions?: QueryCondition[],
  ): any[] {
    if (!plan.children || plan.children.length === 0) return [];

    const childPlan = plan.children[0];

    // 解析参数（必须在排序之前）
    const fnMatch = plan.description.match(/fn=(\w+)/);
    const colMatch = plan.description.match(/column=([a-zA-Z*_][a-zA-Z0-9_]*)/);
    const groupMatch = plan.description.match(/group=(\w+)/);
    const aliasMatch = plan.description.match(/alias=(\w+)/);

    const fn = fnMatch ? fnMatch[1].toLowerCase() : 'count';
    const column = colMatch && colMatch[1] !== '*' ? colMatch[1] : null;
    const groupCol = groupMatch ? groupMatch[1] : null;
    const alias = aliasMatch ? aliasMatch[1] : fn;

    let childRows = this.executeNode(childPlan, '', conditions);

    // 按 group column 排序（流式聚合的前提）
    if (groupCol) {
      childRows = [...childRows].sort((a: any, b: any) => {
        const aVal = String(a[groupCol] ?? '');
        const bVal = String(b[groupCol] ?? '');
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      });
    }

    if (!groupCol) {
      // 无 GROUP BY，对全表做聚合
      const row: Record<string, any> = {};
      switch (fn) {
        case 'count': row[alias] = childRows.length; break;
        case 'sum': row[alias] = childRows.reduce((a: number, r: any) => a + (Number(column ? r[column] : 0) || 0), 0); break;
        case 'avg': {
          const total = childRows.reduce((a: number, r: any) => a + (Number(column ? r[column] : 0) || 0), 0);
          row[alias] = childRows.length > 0 ? total / childRows.length : 0;
          break;
        }
        default: row[alias] = childRows.length;
      }
      return [row];
    }

    // GROUP BY 流式累加（数据已排序）
    const result: any[] = [];
    let currentGroup: string | null = null;
    let count = 0;
    let sum = 0;

    for (const r of childRows) {
      const groupVal = String(r[groupCol] ?? '');
      if (currentGroup !== null && groupVal !== currentGroup) {
        // 输出前一个组
        const row: Record<string, any> = { [groupCol]: currentGroup };
        switch (fn) {
          case 'count': row[alias] = count; break;
          case 'sum': row[alias] = sum; break;
          case 'avg': row[alias] = count > 0 ? sum / count : 0; break;
          default: row[alias] = count;
        }
        result.push(row);
        count = 0;
        sum = 0;
      }
      currentGroup = groupVal;
      count++;
      if (column) {
        sum += Number(r[column]) || 0;
      }
    }

    // 最后一个组
    if (currentGroup !== null) {
      const row: Record<string, any> = { [groupCol]: currentGroup };
      switch (fn) {
        case 'count': row[alias] = count; break;
        case 'sum': row[alias] = sum; break;
        case 'avg': row[alias] = count > 0 ? sum / count : 0; break;
        default: row[alias] = count;
      }
      result.push(row);
    }

    return result;
  }

  // ── Top-N Heap Sort（插入排序缓存 Top K） ──

  /**
   * Top-N：从子计划结果中取前 N 行（按指定排序列）。
   *
   * 使用插入排序缓存（O(N·K)），N = 数据量，K = limit。
   * 相比完整排序（O(N·logN)），在 K 较小时显著更快。
   *
   * description 格式:
   *   "TopNHeap (key=score, order=DESC, limit=3)"
   */
  private executeTopN(
    _table: string,
    plan: CandidatePlan,
    _conditions?: QueryCondition[],
  ): any[] {
    if (!plan.children || plan.children.length === 0) return [];

    const childPlan = plan.children[0];
    const rows = this.executeNode(childPlan, '');

    const keyMatch = plan.description.match(/key=(\w+)/);
    const orderMatch = plan.description.match(/order=(\w+)/);
    const limitMatch = plan.description.match(/limit=(\d+)/);

    const key = keyMatch ? keyMatch[1] : '';
    const isDesc = orderMatch ? orderMatch[1].toUpperCase() === 'DESC' : false;
    const k = limitMatch ? parseInt(limitMatch[1], 10) : 10;

    if (!key || k >= rows.length) {
      // K 大于数据量，直接排序后返回
      return this.sortByKeys(rows, [{ column: key, order: isDesc ? 'DESC' : 'ASC', nulls: isDesc ? 'first' : 'last' }]);
    }

    // 二分插入排序缓存 O(N·K)
    const result: any[] = [];
    for (const row of rows) {
      const val = Number(row[key]);
      // 二分查找插入位置
      let lo = 0, hi = result.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const midVal = Number(result[mid][key]);
        const cmp = val < midVal ? -1 : val > midVal ? 1 : 0;
        if (isDesc ? cmp > 0 : cmp < 0) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      if (lo < k) {
        result.splice(lo, 0, row);
        if (result.length > k) result.length = k;
      }
    }
    return result;
  }

  // ── Disk Sort（磁盘排序） ──

  /**
   * 磁盘排序：当数据量大到内存无法容纳时，使用 SQLite 临时表辅助排序。
   *
   * 策略：
   * 1. 执行子计划获取数据
   * 2. 写入选中的排序列到 SQLite 临时表
   * 3. 用 SQLite 索引排序并读回
   *
   * description 格式:
   *   "DiskSort (key=score, order=DESC)"
   */
  private executeDiskSort(
    _table: string,
    plan: CandidatePlan,
    _conditions?: QueryCondition[],
  ): any[] {
    if (!plan.children || plan.children.length === 0) return [];

    const childPlan = plan.children[0];
    const rows = this.executeNode(childPlan, '');

    const keyMatch = plan.description.match(/key=(\w+)/);
    const orderMatch = plan.description.match(/order=(\w+)/);

    const sortKey = keyMatch ? keyMatch[1] : '';
    const isDesc = orderMatch ? orderMatch[1].toUpperCase() === 'DESC' : false;

    if (!sortKey || rows.length <= 1000) {
      // 小数据直接内存排序
      const nullsFirst = isDesc;
      return [...rows].sort((a: any, b: any) => {
        const aVal = a[sortKey];
        const bVal = b[sortKey];
        if (aVal == null && bVal == null) return 0;
        if (aVal == null) return nullsFirst ? -1 : 1;
        if (bVal == null) return nullsFirst ? 1 : -1;
        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return isDesc ? -cmp : cmp;
      });
    }

    // 大数据：使用 SQLite 临时表 sort
    const tmpTable = `_disksort_${Date.now()}`;
    this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS "${tmpTable}" (rowid INTEGER PRIMARY KEY, sort_val ${typeof rows[0]?.[sortKey] === 'number' ? 'REAL' : 'TEXT'})`);
    const insertStmt = this.db.prepare(`INSERT INTO "${tmpTable}" (rowid, sort_val) VALUES (?, ?)`);
    const insertMany = this.db.transaction((batch: Array<{ rowid: number; val: any }>) => {
      for (const item of batch) insertStmt.run(item.rowid, item.val);
    });
    const batch: Array<{ rowid: number; val: any }> = [];
    for (let i = 0; i < rows.length; i++) {
      batch.push({ rowid: i, val: rows[i][sortKey] ?? null });
      if (batch.length >= 500) { insertMany(batch); batch.length = 0; }
    }
    if (batch.length > 0) insertMany(batch);

    const sortedIds = this.db.prepare(
      `SELECT rowid FROM "${tmpTable}" ORDER BY sort_val ${isDesc ? 'DESC' : 'ASC'} NULLS LAST`,
    ).all() as Array<{ rowid: number }>;

    this.db.exec(`DROP TABLE IF EXISTS "${tmpTable}"`);
    return sortedIds.map(r => rows[r.rowid]);
  }

  /**
   * Async parallel query execution.
   * For file-backed databases, delegates to ParallelQueryExecutor for parallel-scan plans.
   * Falls back to synchronous executeQuery for in-memory databases.
   */
  async executeQueryAsync(
    plan: CandidatePlan,
    table?: string,
    conditions?: QueryCondition[],
    joinConditions?: JoinCondition[],
    limit?: number,
  ): Promise<QueryResult> {
    // For parallel-scan plans with file-backed DB, use ParallelQueryExecutor
    if (plan.type === 'parallel-scan' && table && !this.db.memory) {
      return this.execParallelScan(plan, table, conditions, limit);
    }
    // For all other cases, use the existing synchronous path
    return this.executeQuery(plan, table, conditions, joinConditions, limit);
  }

  /**
   * Execute a parallel-scan plan using ParallelQueryExecutor (async).
   * Only works with file-backed databases.
   */
  private async execParallelScan(
    plan: CandidatePlan,
    table: string,
    conditions?: QueryCondition[],
    limit?: number,
  ): Promise<QueryResult> {
    const start = Date.now();
    try {
      const { parallelQuery } = await import('./ParallelQueryExecutor');
      const tableName = table || normalizeTableName(plan.description);
      let baseSql = `SELECT * FROM ${escapeId(tableName)}`;
      const values: any[] = [];

      // Build WHERE clause inline (same logic as executeSequentialScan)
      if (conditions && conditions.length > 0) {
        const clauses: string[] = [];
        for (const c of conditions) {
          clauses.push(`${escapeId(c.column)} ${c.operator} ?`);
          values.push(c.value);
        }
        baseSql += ` WHERE ${clauses.join(' AND ')}`;
      }

      if (limit !== undefined) {
        baseSql += ` LIMIT ${limit}`;
      }

      const rows = await parallelQuery(this.db.name, baseSql, values, tableName);
      return {
        rows,
        rowCount: rows.length,
        queryTimeMs: Date.now() - start,
        engine: 'parallel',
      };
    } catch (err: any) {
      this.logger.warn({ error: err.message }, 'Parallel scan failed, falling back to sequential');
      return this.executeQuery(plan, table, conditions, undefined, limit);
    }
  }
}
