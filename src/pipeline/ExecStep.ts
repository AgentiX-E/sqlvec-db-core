/**
 * ExecStep — 执行层
 *
 * Pipeline v3 Step 3: 执行 SQL 并返回结果。
 *
 * 当前实现: 委托给 QueryRouter.execute()。
 * v2 增强: 传递 shardId 提示给 executeFn，当 RouteStep 确定了目标分片时
 * 避免 QueryRouter 内部重复做 scatter-gather 推导。
 *
 * @see docs/ARCHITECTURE-OPTIMIZATION-PLAN.md §2
 */

import type { QueryResult } from '../query/QueryRouter';
import { PinoLogger } from '../logger/PinoLogger';
import type { PipelineContext, RouteDecision, ExecutionResult } from './types';

const logger = PinoLogger.forComponent('ExecStep');

/** 执行函数类型 — 由调用方注入 */
export type ExecFn = (
  sql: string,
  params?: any[],
  sessionId?: string,
  shardId?: number,
) => Promise<QueryResult>;

/**
 * ExecStep 配置
 */
export interface ExecStepConfig {
  /** SQL 执行函数 (注入自 QueryRouter) */
  execute: ExecFn;
}

/**
 * ExecStep — SQL 执行层
 *
 * 输入: RouteDecision (目标 shard + SQL)
 * 输出: ExecutionResult (行数据 + 分片信息)
 *
 * v2 变化: 当 RouteDecision.shardId >= 0 且不 scatter 时，
 * 将 shardId 传给 executeFn，减少 QueryRouter 内部的路由开销。
 */
export class ExecStep {
  private readonly execute: ExecFn;

  constructor(config: ExecStepConfig) {
    this.execute = config.execute;
  }

  /**
   * 执行 SQL
   */
  async process(
    decision: RouteDecision,
    ctx?: PipelineContext,
  ): Promise<ExecutionResult> {
    const { sql, params, shardId, scatter } = decision;

    // 如果 RouteStep 确定了目标分片（单分片、不 scatter），传递 shardId 提示
    const shardHint = shardId >= 0 && !scatter ? shardId : undefined;
    const result = await this.execute(sql, params, ctx?.sessionId, shardHint);

    return {
      ...result,
      shardId: shardHint ?? shardId,
    };
  }
}
