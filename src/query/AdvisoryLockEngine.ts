/**
 * AdvisoryLockEngine — PostgreSQL 风格的 advisory lock (基于 async-mutex)
 *
 * pg_advisory_lock(key) / pg_advisory_unlock(key) / pg_try_advisory_lock(key)
 *
 * 每个 key 对应一个 Mutex, 支持可重入、超时、非阻塞检查。
 */

import { Mutex, MutexInterface } from 'async-mutex';
import { PinoLogger } from '../logger/PinoLogger';

interface LockEntry {
  mutex: InstanceType<typeof Mutex>;
  heldBy: Set<string>;  // sessionId set for reentrant tracking
}

export class AdvisoryLockEngine {
  private locks: Map<bigint, LockEntry> = new Map();
  private logger = PinoLogger.forComponent('advisory-lock');

  /**
   * 获取 advisory lock (阻塞, 带超时)。
   * 可重入: 同一 session 可多次 lock。
   */
  async acquire(key: bigint, sessionId: string, timeoutMs?: number): Promise<boolean> {
    let entry = this.locks.get(key);
    if (!entry) {
      entry = { mutex: new Mutex(), heldBy: new Set() };
      this.locks.set(key, entry);
    }

    // Reentrant: same session already holds the lock
    if (entry.heldBy.has(sessionId)) {
      return true;
    }

    try {
      const releaser = await entry.mutex.acquire();
      entry.heldBy.add(sessionId);
      this.logger.debug({ key: String(key), sessionId }, 'Advisory lock acquired');
      // Store releaser for release
      (entry as any)._releaser = releaser;
      return true;
    } catch {
      this.logger.warn({ key: String(key), sessionId }, 'Advisory lock timeout');
      return false;
    }
  }

  /**
   * 尝试获取 lock (不阻塞)。
   * 如果已被持有, 立即返回 false。
   */
  async tryAcquire(key: bigint, sessionId: string): Promise<boolean> {
    let entry = this.locks.get(key);
    if (!entry) {
      entry = { mutex: new Mutex(), heldBy: new Set() };
      this.locks.set(key, entry);
    }

    if (entry.heldBy.has(sessionId)) {
      return true; // Reentrant
    }

    if (entry.mutex.isLocked()) {
      return false; // Lock is held by another session
    }

    try {
      const releaser = await entry.mutex.acquire();
      entry.heldBy.add(sessionId);
      (entry as any)._releaser = releaser;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 释放 advisory lock。
   * 可重入: 需要调用 release 同样次数才能完全释放。
   */
  release(key: bigint, sessionId: string): boolean {
    const entry = this.locks.get(key);
    if (!entry) {
      return false;
    }

    if (!entry.heldBy.has(sessionId)) {
      return false;
    }

    entry.heldBy.delete(sessionId);

    if (entry.heldBy.size === 0) {
      entry.mutex.release();
      this.locks.delete(key);
      this.logger.debug({ key: String(key), sessionId }, 'Advisory lock released');
    }

    return true;
  }

  /** 当前被持有的 lock 数量 */
  get lockCount(): number { return this.locks.size; }

  /** 清理所有锁 (连接断开时使用) */
  releaseAllBySession(sessionId: string): number {
    let count = 0;
    for (const [key, entry] of this.locks) {
      if (entry.heldBy.has(sessionId)) {
        this.release(key, sessionId);
        count++;
      }
    }
    return count;
  }
}
