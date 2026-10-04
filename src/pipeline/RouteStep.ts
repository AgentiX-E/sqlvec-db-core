/**
 * RouteStep — 路由层
 *
 * Pipeline v3 Step 2: 根据重写后的 SQL + 元数据决定目标 shard。
 *
 * 路由策略:
 * - WHERE + shard key = literal → 单分片路由（无 scatter 开销）
 * - INSERT + column-matched shard key → 单分片路由
 * - 聚合/JOIN/ORDER BY + LIMIT/无 shard key → scatter（-1, scatter: true）
 * - DDL/DCL → shard 0（无 scatter）
 *
 * @see docs/ARCHITECTURE-OPTIMIZATION-PLAN.md §2
 */

import { PinoLogger } from '../logger/PinoLogger';
import { ShardManager } from '../storage/ShardManager';
import type {
  PipelineContext,
  RewriteOutput,
  RouteDecision,
  StatementCategory,
} from './types';

const logger = PinoLogger.forComponent('RouteStep');

/** 路由函数类型 — 由调用方注入 */
export type ShardRouterFn = (
  sql: string,
  tables: string[],
  category: StatementCategory,
) => Promise<RouteDecision>;

/**
 * RouteStep 配置
 */
export interface RouteStepConfig {
  /** 分片路由函数 */
  route: ShardRouterFn;
}

/**
 * RouteStep — 纯函数式 SQL → shard 映射
 *
 * 输入: 重写后的 SQL + RewriteMeta
 * 输出: 目标 shard + SQL (不变) + scatter 标志
 *
 * 设计原则:
 * - 不接触数据库或网络
 * - 仅基于元数据做路由决策
 * - scatter 决策由调用方控制
 */
export class RouteStep {
  private readonly route: ShardRouterFn;

  constructor(config: RouteStepConfig) {
    this.route = config.route;
  }

  /**
   * 路由决定
   */
  async process(output: RewriteOutput, _ctx?: PipelineContext): Promise<RouteDecision> {
    return this.route(output.sql, output.meta.tables, output.meta.category);
  }
}

/**
 * 工厂函数: 创建带真实路由逻辑的 ShardRouterFn
 *
 * @param shardManager — ShardManager 实例
 * @returns ShardRouterFn
 */
export function createShardRouter(shardManager: ShardManager): ShardRouterFn {
  return async (sql: string, _tables: string[], category: StatementCategory) => {
    const shardCount = shardManager.getShardCount();
    if (shardCount <= 1) {
      return { shardId: 0, scatter: false, sql };
    }

    switch (category) {
      case 'SELECT':
      case 'INSERT':
      case 'UPDATE':
      case 'DELETE': {
        // 尝试单分片路由: WHERE col = val
        const shardId = inferShardFromSql(sql, category, shardManager);
        if (shardId >= 0) {
          return { shardId, scatter: false, sql };
        }
        // 无法确定目标分片 → scatter
        return { shardId: -1, scatter: true, sql };
      }

      // DDL/TCL/COPY/OTHER → 主分片
      default:
        return { shardId: 0, scatter: false, sql };
    }
  };
}

// ──────────────────────────────────────────────
//  Routing Logic
// ──────────────────────────────────────────────

/**
 * 从 SQL 推断目标 shard ID。
 * 规则:
 * 1. WHERE + shard key 列名 × = literal → hash(literal) → shardId
 * 2. INSERT + 列名匹配 shard key → hash(value) → shardId
 * 3. 否则 → -1 (scatter)
 */
function inferShardFromSql(
  sql: string,
  category: StatementCategory,
  shardManager: ShardManager,
): number {
  const shardCount = shardManager.getShardCount();

  if (category === 'SELECT' || category === 'UPDATE' || category === 'DELETE') {
    // WHERE col = literal
    const idMatch = sql.match(/WHERE\s+(?:`?(\w+)`?\s*=\s*'?(?:(\d+)|('.+?'))'?)/i);
    if (idMatch) {
      const col = idMatch[1];
      const val = idMatch[2] ?? idMatch[3]?.replace(/^'|'$/g, '');
      if (val && /^(id|.*_id|aid|bid|tid)$/i.test(col)) {
        return shardManager.getShardIdForKey(val, shardCount);
      }
    }
  }

  if (category === 'INSERT') {
    // INSERT INTO t(cols) VALUES(vals) — match shard key column
    const colValMatch = sql.match(/INSERT\s+INTO\s+\S+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (colValMatch) {
      const cols = colValMatch[1].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      const vals = colValMatch[2].split(',').map(v => v.trim());
      for (let i = 0; i < cols.length && i < vals.length; i++) {
        if (/^(id|.*_id|aid|bid|tid)$/i.test(cols[i])) {
          // Strip surrounding quotes: '0' → 0, "42" → 42
          const cleanKey = vals[i].replace(/^['"]|['"]$/g, '');
          return shardManager.getShardIdForKey(cleanKey, shardCount);
        }
      }
    }
    // Fallback: extract first value from VALUES tuple
    const valMatch = sql.match(/VALUES\s*\(([^)]+)\)/i);
    if (valMatch) {
      const firstVal = valMatch[1].split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      return shardManager.getShardIdForKey(firstVal, shardCount);
    }
  }

  return -1;
}
