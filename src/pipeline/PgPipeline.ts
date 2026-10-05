/**
 * PgPipeline — 统一 SQL 执行管道入口
 *
 * Pipeline v3 核心编排器。将 5 条平行 SQL 执行路径合为一条统一管道。
 *
 * 管道流程:
 * ```
 * PipelineContext + SQL
 *   → RewriteStep   (step 1: shim pipeline)
 *   → EngineStep    (step 2: OLTP/OLAP engine routing) [v4 new]
 *   → RouteStep     (step 3: shard routing, SQLite only)
 *   → ExecStep      (step 4: execution, SQLite only)
 *   → ResultStep    (step 5: merge + format)
 *   → PipelineOutput
 * ```
 *
 * 当 EngineStep 决定使用 DuckDB 时，跳过 RouteStep 和 ExecStep，
 * 直接将 DuckDB 结果送入 ResultStep。
 *
 * @see docs/architecture/oltp-olap-unification.md §3
 *
 * @see docs/ARCHITECTURE-OPTIMIZATION-PLAN.md §2
 * @see /src/protocol/PgWireServer.ts — 目标集成点
 */

import { PinoLogger } from '../logger/PinoLogger';
import { RewriteStep } from './RewriteStep';
import { EngineStep } from './EngineStep';
import { RouteStep, type ShardRouterFn, createShardRouter } from './RouteStep';
import { ExecStep } from './ExecStep';
import { ResultStep } from './ResultStep';
import { ShimCache } from './ShimCache';
import type { QueryRouter, QueryResult } from '../query/QueryRouter';
import type { ShardManager } from '../storage/ShardManager';
import type {
  PipelineContext,
  PipelineOutput,
  PipelineConfig,
  StatementCategory,
  RewriteOutput,
  RouteDecision,
  ExecutionResult,
} from './types';
import type { TxCoord } from '../query/TxCoord';
import type { UnifiedRouter } from '../query/UnifiedRouter';
import type { DuckDBExecutor } from '../query/DuckDBExecutor';

// 重新导出类型供外部消费
export type { PipelineContext, PipelineOutput };

const logger = PinoLogger.forComponent('PgPipeline');

/**
 * PgPipeline — 统一 SQL 执行管道
 *
 * 设计原则:
 * 1. 一条管道，所有语句 — 无 bypass 路径
 * 2. 每层一个职责 — 输入输出类型化
 * 3. 可组合 — 每层可独立测试
 * 4. 可观测 — 每层有明确的开始/完成日志
 */
export class PgPipeline {
  private readonly rewriteStep: RewriteStep;
  private readonly engineStep?: EngineStep;
  private readonly routeStep: RouteStep;
  private readonly execStep: ExecStep;
  private readonly resultStep: ResultStep;

  /** 事务协调器 (可选 — 注入后 Pipeline 管理事务生命周期) */
  private readonly txCoord?: TxCoord;

  /** Callback invoked on successful CREATE TABLE DDL */
  private readonly onTableCreated?: (tableName: string) => Promise<void>;

  /** 执行统计 */
  private totalQueries = 0;
  private totalTimeMs = 0;
  /** Shim Cache (Phase 4) */
  private cache: ShimCache;

  constructor(
    config: PipelineConfig,
    txCoord?: TxCoord,
    unifiedRouter?: UnifiedRouter,
    duckDBExecutor?: DuckDBExecutor,
  ) {
    if (!config.rewriteFn || !config.executeFn) {
      throw new Error('PgPipeline requires rewriteFn and executeFn');
    }

    this.txCoord = txCoord;
    this.onTableCreated = config.onTableCreated;
    this.cache = new ShimCache();

    this.rewriteStep = new RewriteStep({
      rewrite: async (sql: string, params?: any[]) => {
        const output = await config.rewriteFn!(sql, params);
        return output;
      },
      cache: this.cache,
    });

    // EngineStep — OLTP/OLAP 引擎路由 (v4)
    if (unifiedRouter && duckDBExecutor) {
      this.engineStep = new EngineStep({ unifiedRouter, duckDBExecutor });
    }

    // 默认回退路由函数（无 shardManager 或单分片时使用）
    const defaultRouter: ShardRouterFn = async (sql: string, _tables: string[], _category: StatementCategory) => {
      return { shardId: -1, scatter: true, sql };
    };

    this.routeStep = new RouteStep({
      route: config.shardManager && config.shardManager.getShardCount() > 1
        ? createShardRouter(config.shardManager)
        : defaultRouter,
    });

    this.execStep = new ExecStep({
      execute: async (sql: string, params?: any[], sessionId?: string, shardId?: number) => {
        return config.executeFn!(sql, params, sessionId, shardId);
      },
    });

    this.resultStep = new ResultStep();
  }

  /**
   * 执行一条 SQL 语句，通过完整管道
   *
   * @param sql — 原始 SQL
   * @param ctx — 管道上下文
   * @returns 管道输出
   */
  async execute(sql: string, ctx: PipelineContext): Promise<PipelineOutput> {
    const start = performance.now();
    this.totalQueries++;

    // ═══ Step 1: Rewrite ═══
    logger.debug({ sql: sql.substring(0, 60) }, 'Pipeline: RewriteStep start');
    const rewriteOutput: RewriteOutput = await this.rewriteStep.process(sql, ctx);
    const { category } = rewriteOutput.meta;
    logger.debug({ category, sql: rewriteOutput.sql.substring(0, 60) }, 'Pipeline: RewriteStep done');

    // ═══ Step 2: Engine Decision (NEW — OLTP/OLAP routing) ═══
    if (this.engineStep) {
      try {
        const engineDecision = await this.engineStep.process(rewriteOutput.sql, ctx);
        logger.debug({ engine: engineDecision.engine, reason: engineDecision.reason },
          'Pipeline: EngineStep done');

        if (engineDecision.engine === 'duckdb' && engineDecision.duckdbResult) {
          // DuckDB 路径: 跳过 RouteStep 和 ExecStep，直接 ResultStep
          const output = this.resultStep.process(
            [engineDecision.duckdbResult],
            category,
          );
          output.engine = 'duckdb';
          output.queryTimeMs = performance.now() - start;
          if (engineDecision.triggeredFallback) {
            output.triggeredFallback = true;
          }
          this.totalTimeMs += output.queryTimeMs;
          return output;
        }

        // SQLite 路径: 继续 RouteStep → ExecStep
        // 如果有触发降级，标记 triggeredFallback (在 ResultStep 后设置)
        if (engineDecision.triggeredFallback) {
          // 将降级信息暂存到 ctx 以便后续设置
          ctx.metadata = { ...ctx.metadata, engineFallback: true };
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Pipeline: EngineStep crashed, falling back to SQLite');
        // EngineStep 崩了不可怕 — 继续走 SQLite 路径
      }
    }

    // ═══ Step 3: Route ═══
    logger.debug('Pipeline: RouteStep start');
    const routeDecision: RouteDecision = await this.routeStep.process(rewriteOutput, ctx);
    logger.debug({ shardId: routeDecision.shardId, scatter: routeDecision.scatter }, 'Pipeline: RouteStep done');

    // ═══ Step 4: Execute ═══
    logger.debug('Pipeline: ExecStep start');
    const execResult: ExecutionResult = await this.execStep.process(routeDecision, ctx);
    logger.debug({ rows: execResult.rows?.length, rowCount: execResult.rowCount }, 'Pipeline: ExecStep done');

    // ═══ Step 5: Merge + Format ═══
    const output = this.resultStep.process([execResult], category);
    output.engine = 'sqlite';
    output.queryTimeMs = performance.now() - start;
    this.totalTimeMs += output.queryTimeMs;

    // 引擎降级标记
    if (ctx.metadata?.engineFallback) {
      output.triggeredFallback = true;
    }

    // ── After DDL: notify onTableCreated for CREATE TABLE ──
    if (category === 'DDL' && this.onTableCreated) {
      const trimmed = sql.trim();
      if (/^CREATE\s+TABLE\b/i.test(trimmed)) {
        const tableMatch = trimmed.match(
          /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`'])?(\w+)(?:["`'])?/i,
        );
        if (tableMatch) {
          const tableName = tableMatch[1];
          this.onTableCreated(tableName).catch((err: any) => {
            logger.warn({ tableName, err: err.message }, 'onTableCreated callback failed');
          });
        }
      }
    }

    return output;
  }

  /** 获取管道统计 */
  getStats(): { totalQueries: number; avgTimeMs: number; cacheHitRate: number } {
    return {
      totalQueries: this.totalQueries,
      avgTimeMs: this.totalQueries > 0 ? this.totalTimeMs / this.totalQueries : 0,
      cacheHitRate: this.cache.hitRate,
    };
  }

  /** 清空重写缓存 (DDL 后调用) */
  invalidateCache(): void {
    this.cache.invalidate();
  }

  /**
   * 执行批量 INSERT (COPY 专用) — 带参数化查询
   *
   * 将 batch INSERT 送入管道，与 execute() 走相同路径。
   * COPY batch INSERT 不经过 rewrite（已是 rewrite 后的 SQL）。
   *
   * @param sql — 已构造好的 batch INSERT SQL
   * @param params — 扁平化参数
   * @param ctx — 管道上下文
   */
  async executeBatchInsert(
    sql: string,
    params: any[],
    ctx: PipelineContext,
  ): Promise<PipelineOutput> {
    const start = performance.now();
    this.totalQueries++;

    // COPY batch INSERT 跳过 rewrite，直接路由 + 执行 + 合并
    // ✅ 未来: 给 RouteStep 添加 COPY 感知以支持 shard routing
    const routeDecision: RouteDecision = { shardId: 0, scatter: false, sql, params };
    const execResult: ExecutionResult = await this.execStep.process(routeDecision, ctx);
    const output = this.resultStep.process([execResult], 'INSERT');
    output.engine = 'sqlite';
    output.queryTimeMs = performance.now() - start;
    this.totalTimeMs += output.queryTimeMs;

    return output;
  }

  /**
   * 执行事务控制 SQL (BEGIN/COMMIT/ROLLBACK) — 通过管道。
   * 如果注入了 TxCoord，由 TxCoord 管理事务生命周期。
   */
  async executeTransaction(
    sql: string,
    ctx: PipelineContext,
  ): Promise<PipelineOutput> {
    const start = performance.now();
    this.totalQueries++;

    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    // Manage the transaction lifecycle through TxCoord.
    if (this.txCoord) {
      // Ordering is critical: `ROLLBACK TO SAVEPOINT` and `RELEASE SAVEPOINT`
      // must be matched before the plain `ROLLBACK` branch, otherwise a
      // savepoint rollback is misrouted to the full-transaction rollback.
      // Savepoint names are extracts from the ORIGINAL SQL (case-preserved)
      // because PostgreSQL treats savepoint identifiers as case-sensitive.
      if (upper === 'BEGIN' || upper.startsWith('BEGIN ')) {
        await this.txCoord.begin(ctx.sessionId);
      } else if (upper === 'COMMIT' || upper.startsWith('COMMIT')) {
        await this.txCoord.commit(ctx.sessionId);
      } else if (upper.startsWith('ROLLBACK TO SAVEPOINT ')) {
        const name = trimmed.slice(21).trim();
        await this.txCoord.rollbackToSavepoint(name, ctx.sessionId);
      } else if (upper === 'ROLLBACK' || upper.startsWith('ROLLBACK ')) {
        await this.txCoord.rollback(ctx.sessionId);
      } else if (upper.startsWith('SAVEPOINT ')) {
        const name = trimmed.slice(10).trim();
        await this.txCoord.savepoint(name, ctx.sessionId);
      } else if (upper.startsWith('RELEASE SAVEPOINT ')) {
        const name = trimmed.slice(18).trim();
        await this.txCoord.releaseSavepoint(name, ctx.sessionId);
      }
    }

    // 然后通过管道执行 SQL (当前委托给 QueryRouter.execute)
    const routeDecision: RouteDecision = { shardId: 0, scatter: false, sql };
    const execResult: ExecutionResult = await this.execStep.process(routeDecision, ctx);
    const output = this.resultStep.process([execResult], 'TCL');
    output.engine = 'sqlite';
    output.queryTimeMs = performance.now() - start;
    this.totalTimeMs += output.queryTimeMs;

    return output;
  }
}

/**
 * 为给定 QueryRouter 创建一个默认 Pipeline 实例
 *
 * 工厂函数 — 从现有 QueryRouter 提取 rewrite 和 execute 函数。
 * 与现有代码共存，不改变 QueryRouter 的行为。
 *
 * @param queryRouter — 真实 QueryRouter 实例
 * @param txCoord — 可选事务协调器
 * @param unifiedRouter — 可选 UnifiedRouter 实例 (用于 EngineStep OLTP/OLAP 路由)
 * @param shardManager — 可选 ShardManager 实例 (用于 RouteStep 真实分片路由)
 * @returns 配置好的 PgPipeline
 */
export function createPipelineFor(
  queryRouter: QueryRouter,
  txCoord?: TxCoord,
  unifiedRouter?: UnifiedRouter,
  duckDBExecutor?: DuckDBExecutor,
  shardManager?: ShardManager,
  onTableCreated?: (tableName: string) => Promise<void>,
): PgPipeline {
  const sm = shardManager ?? (queryRouter as any).shardManager ?? { getShardCount: () => 1, getShardIdForKey: () => 0, getShard: () => undefined } as any;

  return new PgPipeline({
    shardManager: sm,
    onTableCreated,
    rewriteFn: async (sql: string, _params?: any[]) => {
      // 当前实现: 简单的 SQL 分类，不重复 QueryRouter 的 17 步 shim pipeline
      // Phase 4 将添加独立的 ShimPipeline
      const upper = sql.trim().toUpperCase();
      const category: StatementCategory = upper.startsWith('SELECT') ? 'SELECT'
        : upper.startsWith('INSERT') ? 'INSERT'
        : upper.startsWith('UPDATE') ? 'UPDATE'
        : upper.startsWith('DELETE') ? 'DELETE'
        : upper.startsWith('CREATE') || upper.startsWith('DROP') || upper.startsWith('ALTER') ? 'DDL'
        : upper.startsWith('BEGIN') || upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK') ? 'TCL'
        : upper.startsWith('COPY') ? 'COPY'
        // SET / SHOW were previously missing and fell through to 'OTHER',
        // so any SET/SHOW statement was misclassified (wrong command tag).
        : upper.startsWith('SET') ? 'SET'
        : upper.startsWith('SHOW') ? 'SHOW'
        : 'OTHER';
      return {
        sql,
        meta: { rewrittenSql: sql, category, tables: [], hasReturning: false, isCopy: false, hasParams: false },
      };
    },
    executeFn: (sql: string, params?: any[], sessionId?: string, _shardId?: number) => {
      // The `shardId` hint computed by RouteStep is intentionally not passed
      // through here: `QueryRouter.execute(sql, params, sessionId)` performs
      // its own scatter-gather routing internally and its signature has no
      // shard-hint parameter. The hint exists in the function signature to
      // keep the ExecStep contract stable for a future QueryRouter refactor.
      return queryRouter.execute(sql, params, sessionId);
    },
  }, txCoord, unifiedRouter, duckDBExecutor);
}
