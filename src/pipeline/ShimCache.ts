/**
 * ShimCache — SQL 重写结果 LRU 缓存
 *
 * Pipeline v3 Phase 4: 缓存 postProcessSql 的结果，避免对热查询重复执行
 * 17 步 shim pipeline。OLTP 场景预期缓存命中率 ≥ 90%。
 *
 * @see docs/ARCHITECTURE-OPTIMIZATION-PLAN.md §4
 */

import { PinoLogger } from '../logger/PinoLogger';
import type { RewriteOutput } from './types';

const logger = PinoLogger.forComponent('ShimCache');

/** LRU 缓存节点 */
interface CacheNode {
  key: string;
  value: RewriteOutput;
  prev: CacheNode | null;
  next: CacheNode | null;
}

/**
 * LRU Cache 实现 — 双向链表 + Map
 *
 * 设计要点:
 * - O(1) get/set
 * - 最近未被访问的条目在达到 maxEntries 时被淘汰
 * - normalizeKey() 去除多余空白，提高命中率
 * - invalidate() 清空全部 (DDL 变更时调用)
 */
export class ShimCache {
  private readonly maxEntries: number;
  private readonly map: Map<string, CacheNode>;
  private head: CacheNode | null = null;
  private tail: CacheNode | null = null;
  private _hits = 0;
  private _misses = 0;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  /** 规范化 SQL key — 去除多余空白，使相同语义的 SQL 命中同一缓存 */
  static normalizeKey(sql: string): string {
    return sql.trim().replace(/\s+/g, ' ');
  }

  /** 获取缓存命中数 */
  get hits(): number {
    return this._hits;
  }

  /** 获取缓存未命中数 */
  get misses(): number {
    return this._misses;
  }

  /** 缓存命中率 */
  get hitRate(): number {
    const total = this._hits + this._misses;
    return total === 0 ? 0 : this._hits / total;
  }

  /**
   * 从缓存获取重写结果
   * @returns 命中时返回 RewriteOutput，未命中返回 undefined
   */
  get(sql: string): RewriteOutput | undefined {
    const key = ShimCache.normalizeKey(sql);
    const node = this.map.get(key);

    if (!node) {
      this._misses++;
      return undefined;
    }

    // LRU promotion: move to head
    this.promote(node);
    this._hits++;
    return node.value;
  }

  /**
   * 缓存重写结果
   */
  set(sql: string, output: RewriteOutput): void {
    const key = ShimCache.normalizeKey(sql);

    // 如果已存在，更新值并 promote
    const existing = this.map.get(key);
    if (existing) {
      existing.value = output;
      this.promote(existing);
      return;
    }

    // 创建新节点
    const node: CacheNode = {
      key,
      value: output,
      prev: null,
      next: null,
    };

    // 添加到头部
    if (this.head) {
      node.next = this.head;
      this.head.prev = node;
    }
    this.head = node;
    if (!this.tail) {
      this.tail = node;
    }

    this.map.set(key, node);

    // 淘汰尾部（最近最少使用）
    if (this.map.size > this.maxEntries && this.tail) {
      this.evict(this.tail);
    }
  }

  /**
   * 清空全部缓存 — 在 DDL 变更时调用
   */
  invalidate(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
    logger.debug('ShimCache invalidated');
  }

  /** 当前缓存条目数 */
  get size(): number {
    return this.map.size;
  }

  // ── Private: LRU 维护 ──

  /** 将节点提升到头部 */
  private promote(node: CacheNode): void {
    if (node === this.head) return;

    // 从当前位置移除
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.tail) this.tail = node.prev;

    // 插入头部
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
  }

  /** 淘汰指定节点 */
  private evict(node: CacheNode): void {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (node === this.head) this.head = node.next;
    if (node === this.tail) this.tail = node.prev;
    this.map.delete(node.key);
  }
}
