/**
 * RewriteStep — 重写层
 *
 * Pipeline v3 Step 1: 将原始 SQL 通过 shim pipeline 重写为 SQLite 可执行的 SQL。
 *
 * 当前实现: 委托给 QueryRouter 的 postProcessSql 逻辑 (通过 injectFn)。
 * 未来: 独立实现 ShimPipeline，不依赖 QueryRouter。
 *
 * Phase 4 增强:
 * - 可选 ShimCache: 对热查询缓存重写结果，OLTP 场景预期命中率 ≥ 90%
 *
 * @see docs/ARCHITECTURE-OPTIMIZATION-PLAN.md §2
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { ShimCache } from './ShimCache';
import type { PipelineContext, RewriteOutput, RewriteMeta } from './types';

const logger = PinoLogger.forComponent('RewriteStep');

/** 重写函数类型 — 由调用方注入 */
export type RewriteFn = (sql: string, params?: any[]) => Promise<RewriteOutput>;

/**
 * RewriteStep 配置
 */
export interface RewriteStepConfig {
  /** SQL 重写函数 (注入自 QueryRouter) */
  rewrite: RewriteFn;
  /** 可选缓存 (Phase 4) */
  cache?: ShimCache;
}

/**
 * RewriteStep — 纯函数式 SQL → SQL 变换
 *
 * 输入: 原始 SQL + PipelineContext
 * 输出: 重写后的 SQL + RewriteMeta
 *
 * 设计原则:
 * - 纯函数: 同一输入保证同一输出 (除非元数据注入)
 * - 无副作用: 不接触数据库、网络、Raft
 * - 可缓存: 输出可被 ShimCache 缓存 (Phase 4)
 */
export class RewriteStep {
  private readonly rewrite: RewriteFn;
  private readonly cache: ShimCache | undefined;

  constructor(config: RewriteStepConfig) {
    this.rewrite = config.rewrite;
    this.cache = config.cache;
  }

  /**
   * 执行重写 — 优先使用缓存
   *
   * @param sql — 原始 SQL
   * @param _ctx — 管道上下文 (当前 unused，为未来扩展预留)
   * @returns 重写后的 SQL + 元数据
   */
  async process(sql: string, _ctx?: PipelineContext): Promise<RewriteOutput> {
    // Phase 4: Check cache first
    if (this.cache) {
      const cached = this.cache.get(sql);
      if (cached) {
        logger.debug({ sql: sql.substring(0, 40) }, 'RewriteStep: cache HIT');
        return cached;
      }
      logger.debug({ sql: sql.substring(0, 40) }, 'RewriteStep: cache MISS');
    }

    // Execute rewrite
    const output = await this.rewrite(sql);

    // Phase 4: Store in cache
    if (this.cache) {
      this.cache.set(sql, output);
    }

    return output;
  }

  /** 获取缓存统计 */
  getCacheStats(): { hits: number; misses: number; hitRate: number } | undefined {
    if (!this.cache) return undefined;
    return { hits: this.cache.hits, misses: this.cache.misses, hitRate: this.cache.hitRate };
  }

  /** 使缓存失效 (DDL 后调用) */
  invalidateCache(): void {
    this.cache?.invalidate();
  }
}
