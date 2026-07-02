/**
 * EngineStep — OLTP/OLAP 引擎路由层
 *
 * Pipeline v3 Step 1.5: 在 RewriteStep 之后、RouteStep 之前，决定查询应该
 * 由哪个引擎执行。这是 OLTP+OLAP 有机统一的架构核心：
 *
 *   1. UnifiedRouter.decide() → 获知目标引擎
 *   2. DUCKDB_OLAP → DuckDBExecutor.execute() → 直接返回 DuckDB 结果
 *   3. SQLITE_OLTP → 返回空决策（等待 RouteStep → ExecStep 填充）
 *   4. DuckDB 故障 → 自动降级到 SQLite（完整 Pipeline 路径，不跳过任何步骤）
 *
 * 设计原则 P-I (Pipeline 原生):
 *   引擎路由是 Pipeline 的第一级决策，不是 QueryRouter.execute() 的隐藏逻辑。
 *
 * @see docs/architecture/oltp-olap-unification.md §3
 * @see /src/query/UnifiedRouter.ts
 * @see /src/query/DuckDBExecutor.ts
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import type { DuckDBExecutor } from '../query/DuckDBExecutor';
import type { UnifiedRouter } from '../query/UnifiedRouter';
import type { QueryTarget } from '../analytics/AnalyticQueryClassifier';
import { QueryTarget as QT } from '../analytics/AnalyticQueryClassifier';
import type { PipelineContext, ExecutionResult } from './types';
import { parseStatement } from '../query/SqlParser';

const logger = PinoLogger.forComponent('EngineStep');

// ─── 三级别最近写入跟踪（读-写一致性） ──────────────────

/**
 * P1: 三级别最近写入保护。
 *
 * 覆盖场景:
 *   - Level 1 (session): 同一 PG wire 连接的 read-your-writes [500ms]
 *   - Level 2 (shard): 不同连接但写入同一 shard [500ms]
 *   - Level 3 (node): 任何 shard 的任何写入（跨节点 Raft 复制后本地 CDC 未同步）[200ms]
 *
 * 窗口选择依据:
 *   - session/shard: DataBridge 100ms tick × 5，覆盖 GC + I/O 排队
 *   - node: DataBridge 100ms tick × 2，仅覆盖 Raft apply + CDC 延迟
 *     （更宽的时间窗口意味着更多查询被强制走 SQLite，造成不必要性能下降）
 */
const RECENT_WRITE_WINDOW_MS = 200;  // node 级别 (×2 DataBridge tick)
const SHARD_WRITE_WINDOW_MS = 500;   // session/shard 级别 (×5 DataBridge tick)

// Level 1: session 级别
const _recentWriteSessions = new Map<string, number>();

// Level 2: shard 级别
const _recentWriteShards = new Map<number, number>();

// Level 3: 节点级别
let _nodeLastWriteTime = 0;

/**
 * 重置所有最近写入状态（用于测试隔离）。
 */
export function resetWriteState(): void {
  _recentWriteSessions.clear();
  _recentWriteShards.clear();
  _nodeLastWriteTime = 0;
}

/**
 * 记录最近写入到三级别跟踪器。
 *
 * @param shardId — 目标 shard ID（-1 表示未指定）
 */
export function markRecentWrite(sessionId: string, shardId: number = -1): void {
  const now = Date.now();
  _recentWriteSessions.set(sessionId, now);
  if (shardId >= 0) {
    _recentWriteShards.set(shardId, now);
  }
  _nodeLastWriteTime = now;
}

/**
 * 检查是否有最近写入。
 *
 * 三级别检查，任一匹配返回 true:
 *   1. 同 session 有写入 [SHARD_WRITE_WINDOW]
 *   2. 同 shard 有写入（任何 session）[SHARD_WRITE_WINDOW]
 *   3. 节点有任何写入 [RECENT_WRITE_WINDOW]
 *
 * @param sessionId — 当前 session 标识
 * @param shardId — 目标 shard ID（-1 表示仅检查 session 和 node 级别）
 */
export function hasRecentWrite(sessionId: string, shardId: number = -1): boolean {
  const now = Date.now();

  // Level 1: session 级别 — SHARD_WRITE_WINDOW
  const sessionTs = _recentWriteSessions.get(sessionId);
  if (sessionTs !== undefined) {
    if ((now - sessionTs) <= SHARD_WRITE_WINDOW_MS) return true;
    _recentWriteSessions.delete(sessionId);
  }

  // Level 2: shard 级别 — SHARD_WRITE_WINDOW
  if (shardId >= 0) {
    const shardTs = _recentWriteShards.get(shardId);
    if (shardTs !== undefined) {
      if ((now - shardTs) <= SHARD_WRITE_WINDOW_MS) return true;
      _recentWriteShards.delete(shardId);
    }
  }

  // Level 3: 节点级别 — RECENT_WRITE_WINDOW (更窄)
  if (_nodeLastWriteTime > 0 && (now - _nodeLastWriteTime) <= RECENT_WRITE_WINDOW_MS) {
    return true;
  }

  return false;
}

/**
 * 获取当前保护窗口大小 (ms)。
 * 返回 { sessionShard: ms, node: ms } 用于 GUC 或 metrics 暴露。
 */
export function getRecentWriteWindowMs(): { sessionShard: number; node: number } {
  return { sessionShard: SHARD_WRITE_WINDOW_MS, node: RECENT_WRITE_WINDOW_MS };
}

/**
 * 清理过期的写入跟踪条目（由外部定时器调用，可选）。
 */
export function sweepRecentWriteEntries(): void {
  const now = Date.now();
  const purgeBefore = now - Math.max(SHARD_WRITE_WINDOW_MS, RECENT_WRITE_WINDOW_MS) - 1000;

  for (const [sessionId, ts] of _recentWriteSessions) {
    if (ts < purgeBefore) _recentWriteSessions.delete(sessionId);
  }
  for (const [shardId, ts] of _recentWriteShards) {
    if (ts < purgeBefore) _recentWriteShards.delete(shardId);
  }
}

// ─── 类型定义 ───────────────────────────────────────────

/** 支持的引擎类型 */
export type EngineType = 'sqlite' | 'duckdb' | 'duckdb_fallback';

/**
 * EngineStep 决策输出
 *
 * 当 engine === 'duckdb' 时，duckdbResult 包含已执行的 DuckDB 结果。
 * Pipeline.execute() 应跳过 RouteStep 和 ExecStep。
 *
 * 当 engine === 'sqlite' 时，Pipeline 继续走 RouteStep → ExecStep。
 *
 * 当 engine === 'duckdb_fallback' 时，DuckDB 执行失败，Pipeline
 * 降级走 SQLite 路径，但 triggeredFallback 标记为 true。
 */
export interface EngineDecision {
  /** 选择的引擎 */
  engine: EngineType;
  /** UnifiedRouter 给出的路由目标 */
  target: QueryTarget;
  /** 路由理由（用于日志/调试） */
  reason: string;
  /** DuckDB 执行结果（仅在 engine === 'duckdb' 时存在） */
  duckdbResult?: ExecutionResult;
  /** 是否发生过 DuckDB → SQLite 降级 */
  triggeredFallback: boolean;
}

// ─── 配置 ───────────────────────────────────────────────

/** EngineStep 配置 — 由 PgPipeline 构造函数注入 */
export interface EngineStepConfig {
  /** UnifiedRouter 实例（来自 SqlVecDatabase） */
  unifiedRouter: UnifiedRouter;
  /** DuckDBExecutor 实例（来自 SqlVecDatabase） */
  duckDBExecutor: DuckDBExecutor;
}

// ─── EngineStep ─────────────────────────────────────────

/**
 * EngineStep — 引擎路由决策层
 *
 * 职责:
 *   1. 调用 UnifiedRouter.decide() 决定目标引擎
 *   2. 如果目标是 DuckDB，直接通过 DuckDBExecutor 执行
 *   3. 如果 DuckDB 执行失败，优雅降级到 SQLite
 *   4. 如果目标是 SQLite，标记并返回（由后续步骤执行）
 *
 * 不接触数据库（除了通过 DuckDBExecutor 执行时）。
 * 不修改 SQL。
 * 不修改 PipelineContext。
 */
export class EngineStep {
  private readonly unifiedRouter: UnifiedRouter;
  private readonly duckDBExecutor: DuckDBExecutor;

  constructor(config: EngineStepConfig) {
    this.unifiedRouter = config.unifiedRouter;
    this.duckDBExecutor = config.duckDBExecutor;
  }

  /**
   * 引擎路由决策入口
   *
   * @param sql — 经过 RewriteStep 处理的 SQL
   * @param ctx — Pipeline 上下文
   * @returns EngineDecision — 引擎决策 + 可能的 DuckDB 结果
   */
  async process(sql: string, ctx: PipelineContext): Promise<EngineDecision> {
    // Step 1: 检查 DuckDB 是否可用
    // 不可用 → 直接走 SQLite（不尝试 DuckDB）
    if (!this.unifiedRouter.isAvailable) {
      logger.debug('DuckDB unavailable, routing to SQLite');
      return {
        engine: 'sqlite',
        target: 'SQLITE_OLTP' as QueryTarget,
        reason: 'DuckDB unavailable',
        triggeredFallback: false,
      };
    }

    // Step 2: 检查事务上下文
    // 事务中的查询必须走 SQLite（保持 OLTP 一致性）
    const inTransaction = ctx.txCoord?.getStatus(ctx.sessionId) === 'in_transaction';

    // Step 3: 解析 SQL 获取 ParsedStatement
    // SqlParser.parseStatement() 是安全的 — try-catch 全覆盖，从不抛出异常
    const parsed = parseStatement(sql);

    // Step 3a: 非 SELECT 语句 → 记录最近写入（读-写一致性）
    // 后续 SELECT 需要通过 hasRecentWrite 检查来决定是否强制走 SQLite，
    // 避免从 DuckDB 读到陈旧数据。
    // P1: 三级别写入跟踪 — EngineStep 在 RouteStep 前运行，
    // 无法获取 shardId，使用 -1 触发 session + node 级别保护。
    if (parsed && parsed.type !== 'SELECT') {
      markRecentWrite(ctx.sessionId, -1);
    }

    // Step 4: 调用 UnifiedRouter.decide() 做出路由决策
    // 传入 parsed 让 AnalyticQueryClassifier 可以按规则判断 DuckDB/SQLite。
    // 对于非 SELECT 语句（INSERT/UPDATE/DELETE/DDL）:
    //   classifier 规则 1 (non-SELECT type) → SQLITE_OLTP
    // 对于聚合/JOIN/窗口函数/子查询: classifier 规则 3-7 → DUCKDB_OLAP
    const decision = this.unifiedRouter.decide(
      sql,
      parsed,
      { inTransaction },
    );

    logger.debug({
      sql: sql.substring(0, 80),
      target: decision.target,
      reason: decision.reason,
    }, 'EngineStep: UnifiedRouter decision');

    // Step 4a: 最近写入检查 — 读-写一致性
    // P1: 三级别保护 — session + shard + node
    // 如果 session/shard/node 有最近写入（DataBridge 可能有同步延迟），即使
    // classifier 判定为 DUCKDB_OLAP，也强制走 SQLite 避免读到陈旧数据。
    // shardId 在 EngineStep 阶段未知（RouteStep 尚未运行），传递 -1
    // 触发至少 session + node 两级保护
    if (decision.target === QT.DUCKDB_OLAP && hasRecentWrite(ctx.sessionId)) {
      logger.debug({
        sessionId: ctx.sessionId,
        target: decision.target,
      }, 'EngineStep: recent write detected (P1 3-level), overriding DuckDB -> SQLite');
      return {
        engine: 'sqlite',
        target: QT.SQLITE_OLTP,
        reason: `recent write (P1 3-level) — read-your-writes consistency: ${decision.reason}`,
        triggeredFallback: false,
      };
    }

    // Step 5: 如果目标是 SQLite → 返回空决策（后续步骤填充）
    if (decision.target === QT.SQLITE_OLTP) {
      return {
        engine: 'sqlite',
        target: decision.target,
        reason: decision.reason,
        triggeredFallback: false,
      };
    }

    // Step 6: 目标是 DuckDB → 直接通过 DuckDBExecutor 执行
    // 注意: 我们在 EngineStep 中直接执行，而不是交给 ExecStep。
    // 这是设计文档 §3.4 的核心设计：DuckDB 路径在 EngineStep 中完成。
    const start = performance.now();

    try {
      const duckResult = await this.duckDBExecutor.execute(
        sql,
        start,
        parsed,    // pass parsed for classifier-based routing
        { inTransaction },
      );

      if (duckResult.routed) {
        logger.debug({
          rows: duckResult.rows?.length,
          rowCount: duckResult.rowCount,
          queryTimeMs: duckResult.queryTimeMs,
        }, 'EngineStep: DuckDB execution succeeded');

        return {
          engine: 'duckdb',
          target: decision.target,
          reason: decision.reason,
          triggeredFallback: false,
          duckdbResult: {
            rows: duckResult.rows || [],
            rowCount: duckResult.rowCount || 0,
            fields: duckResult.rows && duckResult.rows.length > 0 ? Object.keys(duckResult.rows[0]).map(k => ({ name: k, dataTypeID: 0 })) : [],
            queryTimeMs: duckResult.queryTimeMs || (performance.now() - start),
            shardId: -1,  // DuckDB 不按 shard 路由
            engine: 'duckdb' as any,  // satisfy QueryResult.engine (type-compatible)
          },
        };
      }

      // DuckDB decided but didn't route — this is unexpected
      logger.warn({
        sql: sql.substring(0, 120),
        reason: duckResult.reason,
      }, 'EngineStep: DuckDB decision but no route, falling back to SQLite');
    } catch (err: any) {
      logger.warn({
        err: err.message,
        sql: sql.substring(0, 120),
      }, 'EngineStep: DuckDB execution error, falling back to SQLite');
    }

    // Step 7: DuckDB 执行失败 → 优雅降级到 SQLite
    return {
      engine: 'sqlite',
      target: decision.target,
      reason: 'DuckDB execution failed, fallback to SQLite',
      triggeredFallback: true,
    };
  }
}
