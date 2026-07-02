/**
 * Pipeline v3 — 统一 SQL 执行管道类型定义
 *
 * @see docs/ARCHITECTURE-OPTIMIZATION-PLAN.md
 * @see /src/query/QueryRouter.ts — 现有 QueryResult 类型将逐步迁移至此
 */

import type { QueryResult } from '../query/QueryRouter';
import type { ShardManager } from '../storage/ShardManager';

// ─── 核心类型 ───────────────────────────────────────────

/**
 * 会话上下文 — 由 Wire 层创建，沿管道传递
 */
export interface PipelineContext {
  sessionId: string;
  currentUser: string;
  /** 事务协调器实例 */
  txCoord?: TransactionCoordinator;
  /** 自定义元数据 (各 step 可读写) */
  metadata?: Record<string, unknown>;
}

/**
 * 事务协调器接口
 */
export interface TransactionCoordinator {
  begin(sessionId: string): Promise<void>;
  commit(sessionId: string): Promise<void>;
  rollback(sessionId: string): Promise<void>;
  savepoint(name: string, sessionId: string): Promise<void>;
  rollbackToSavepoint(name: string, sessionId: string): Promise<void>;
  releaseSavepoint(name: string, sessionId: string): Promise<void>;
  getStatus(sessionId: string): 'idle' | 'in_transaction' | 'failed';
}

// ─── 重写层 ─────────────────────────────────────────────

/**
 * 语句分类 — 由重写层在重写过程中推导
 */
export type StatementCategory =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'DDL'
  | 'TCL'        // 事务控制 (BEGIN/COMMIT/ROLLBACK)
  | 'COPY'
  | 'SET'
  | 'SHOW'
  | 'OTHER';

/**
 * 重写元数据 — 由 RewriteStep 产出，下游 step 消费
 */
export interface RewriteMeta {
  /** 重写后的 SQL */
  rewrittenSql: string;
  /** 语句类型 */
  category: StatementCategory;
  /** 涉及的表名列表 */
  tables: string[];
  /** DML 是否带 RETURNING */
  hasReturning: boolean;
  /** 是否为 COPY 操作 */
  isCopy: boolean;
  /** 是否为 Prepared Statement 参数执行 */
  hasParams: boolean;
  /** 原始参数 (如果有) */
  params?: any[];
  /** 备注/警告信息 */
  notices?: string[];
}

/**
 * 重写层输出
 */
export interface RewriteOutput {
  sql: string;
  meta: RewriteMeta;
}

// ─── 路由层 ─────────────────────────────────────────────

/**
 * 路由决策 — 由 RouteStep 产出
 */
export interface RouteDecision {
  /** 目标 shard ID (-1 = 所有分片 scatter) */
  shardId: number;
  /** 是否 scatter (所有分片并行) */
  scatter: boolean;
  /** 最终执行的 SQL */
  sql: string;
  /** 执行参数 */
  params?: any[];
}

// ─── 执行层 ─────────────────────────────────────────────

/**
 * 执行结果 — 由 ExecStep 产出
 * 扩展 QueryResult 以包含分片信息和字段定义
 */
export interface ExecutionResult extends QueryResult {
  /** 执行所在 shard */
  shardId: number;
  /** 字段定义 */
  fields?: { name: string; dataTypeID: number }[];
}

// ─── 管道接口 ───────────────────────────────────────────

/**
 * 管道策略 — 选择执行方式
 */
export type PipelineStrategy = 'local' | 'raft' | 'auto';

/**
 * 管道配置
 */
export interface PipelineConfig {
  strategy?: PipelineStrategy;
  /** 分片管理器 (用于 RouteStep 路由) — 可选，不传则默认路由到 shard 0 */
  shardManager?: ShardManager;
  /** 重写层函数 (from QueryRouter) */
  rewriteFn?: (sql: string, params?: any[]) => Promise<RewriteOutput>;
  /** 执行函数 (from QueryRouter.execute) — 扩展为接受 shardId 提示 */
  executeFn?: (sql: string, params?: any[], sessionId?: string, shardId?: number) => Promise<QueryResult>;

  /** 
   * Callback invoked after a CREATE TABLE DDL statement executes successfully.
   * Called with the extracted table name so the caller can register it with 
   * OLAPSchemaManager for CDC/DataBridge synchronization.
   * Fire-and-forget: does not block the pipeline response.
   */
  onTableCreated?: (tableName: string) => Promise<void>;
}

/**
 * 管道输出 — 最终合并结果
 */
export interface PipelineOutput {
  rows: any[];
  rowCount: number;
  fields?: any[];
  commandTag: string;
  queryTimeMs: number;
  /** 执行引擎 — 由 EngineStep 标记 */
  engine: 'sqlite' | 'duckdb';
  /** 各分片的子结果 (scatter 时) */
  shardResults?: ExecutionResult[];
  /** 事务状态变更 */
  transactionStatus?: 'idle' | 'in_transaction' | 'failed';
  /** 是否发生过引擎降级 (DuckDB → SQLite) */
  triggeredFallback?: boolean;
}
