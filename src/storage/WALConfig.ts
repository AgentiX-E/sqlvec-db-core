/**
 * WALConfig — WAL 写入策略配置
 *
 * Pipeline v3 Phase 3: WAL 异步写入优化
 *
 * 三种模式:
 * - STANDALONE_SAFE: synchronous=NORMAL + journal_size_limit + 定时 checkpoint (安全)
 * - CLUSTER_ACCEL: synchronous=OFF + 定时 checkpoint (Raft 保证持久化)
 * - SINGLE_EXTREME: synchronous=OFF + 高频 checkpoint (纯读密集场景)
 *
 * @see docs/ARCHITECTURE-OPTIMIZATION-PLAN.md §3
 */

export type WalSyncLevel = 'NORMAL' | 'OFF';

export interface WALConfig {
  /** SQLite synchronous 级别 */
  syncLevel: WalSyncLevel;

  /** journal_size_limit 字节 (默认 64MB = 67_108_864) */
  journalSizeLimit: number;

  /** wal_checkpoint 间隔毫秒 (0 = 不启用定时 checkpoint) */
  checkpointIntervalMs: number;

  /** cache_size 页数 (默认 -64000 = 64MB) */
  cacheSize: number;
}

export const WAL_CONFIGS = {
  /** 安全模式: 异步 fsync + 限制 WAL 文件大小 + 定时检查点 (每 30s) */
  STANDALONE_SAFE: {
    syncLevel: 'NORMAL' as WalSyncLevel,
    journalSizeLimit: 64 * 1024 * 1024, // 64 MB
    checkpointIntervalMs: 30_000, // 30 seconds
    cacheSize: -64000,
  },

  /** 集群加速: Raft 保证持久化, SQLite 关闭同步 */
  CLUSTER_ACCEL: {
    syncLevel: 'OFF' as WalSyncLevel,
    journalSizeLimit: 32 * 1024 * 1024, // 32 MB (更快 checkpoint)
    checkpointIntervalMs: 5_000, // 5 seconds
    cacheSize: -64000,
  },

  /** 极致模式: 低延迟优先, 纯 OLTP 写入密集场景 */
  SINGLE_EXTREME: {
    syncLevel: 'OFF' as WalSyncLevel,
    journalSizeLimit: 16 * 1024 * 1024, // 16 MB
    checkpointIntervalMs: 1_000, // 1 second
    cacheSize: -128000, // 128 MB
  },
} as const satisfies Record<string, WALConfig>;
