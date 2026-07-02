/**
 * PeriodicCheckpointer — 定时 WAL 检查点
 *
 * Pipeline v3 Phase 3: 后台线程定期执行 PRAGMA wal_checkpoint(TRUNCATE)
 * 防止 WAL 文件无限增长，同时避免 checkpoint 阻塞写入。
 *
 * 行为:
 * - 每 intervalMs 毫秒执行一次 wal_checkpoint(TRUNCATE)
 * - checkpoint 失败 (如写入进行中) 静默忽略
 * - stop() 触发优雅退出
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import type BetterSqlite3 from 'better-sqlite3';

const logger = PinoLogger.forComponent('PeriodicCheckpointer');

export class PeriodicCheckpointer {
  private readonly db: BetterSqlite3.Database;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(db: BetterSqlite3.Database, intervalMs: number, shardId?: string) {
    this.db = db;
    this.intervalMs = intervalMs;
  }

  /** 启动定时检查点 */
  start(): void {
    if (this.timer !== null) return; // already started
    this.timer = setInterval(() => this.runCheckpoint(), this.intervalMs);
    // Don't prevent process exit
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as any).unref();
    }
    logger.debug({ intervalMs: this.intervalMs }, 'PeriodicCheckpointer started');
  }

  /** 停止定时检查点 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      logger.debug('PeriodicCheckpointer stopped');
    }
  }

  /** 执行一次检查点 */
  private runCheckpoint(): void {
    try {
      // wal_checkpoint(PASSIVE=0): 不等待 readers 完成
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err: any) {
      // 写入进行中时 checkpoint 可能失败 — 静默忽略
      logger.debug({ err: err.message }, 'wal_checkpoint skipped (concurrent write)');
    }
  }
}
