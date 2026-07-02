/**
 * HotQueryCache — LRU cache for UnifiedRouter.decide()
 *
 * Caches routing decisions for frequently-executed SQL queries to avoid
 * re-running the classifier, cost estimator, and config gate pipeline on
 * every invocation.
 *
 * ## When to use
 *
 * OLTP workloads with repeated queries (same SQL text, same routing outcome).
 * The cache is a pure performance optimization — correctness is guaranteed
 * because routing decisions depend only on the SQL text and static config,
 * not on dynamic data.
 *
 * ## Design
 *
 * - Max entries (configurable, default 4096)
 * - TTL per entry (configurable, default 60s)
 * - O(1) get/set via Map (insertion-order iteration for eviction)
 * - LRU semantics: get() refreshes entry to most-recently-used position
 * - Batched invalidation by table name prefix (future: CDC schema changes)
 */

import { RouteDecision } from './RouteDecision';

const logger = /* lazy */ undefined;

export interface HotQueryCacheConfig {
  /** Maximum number of cached decisions (default: 4096) */
  maxEntries?: number;
  /** TTL per entry in milliseconds (default: 60000 = 60s) */
  ttlMs?: number;
}

interface CacheEntry {
  decision: RouteDecision;
  insertedAt: number;
  lastAccessAt: number;
  accessCount: number;
}

const DEFAULT_MAX_ENTRIES = 4096;
const DEFAULT_TTL_MS = 60_000;

export class HotQueryCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  /**
   * Cache map. Insertion-order iteration means the oldest entries are at the
   * front. On eviction we delete the first N entries past the limit.
   * Uses LRU promotion: get() deletes+reinserts to move to end.
   */
  private readonly cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(config?: HotQueryCacheConfig) {
    this.maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
  }

  // ──────────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────────

  /**
   * Look up a cached routing decision for `sql`.
   * Returns the cached RouteDecision on hit, or undefined on miss/expiry.
   * On hit, promotes the entry to MRU (re-inserts at end of map).
   */
  get(sql: string): RouteDecision | undefined {
    const entry = this.cache.get(sql);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    // TTL expiry check
    if (Date.now() - entry.insertedAt > this.ttlMs) {
      this.cache.delete(sql);
      this.misses++;
      return undefined;
    }

    // LRU promotion: delete + re-insert to move to end of map
    this.cache.delete(sql);
    this.hits++;
    entry.lastAccessAt = Date.now();
    entry.accessCount++;
    this.cache.set(sql, entry);
    return entry.decision;
  }

  /**
   * Cache a routing decision for `sql`.
   * If the cache is at capacity, evicts the oldest entry (first in insertion order).
   */
  set(sql: string, decision: RouteDecision): void {
    // Evict if at capacity (and this is a new key)
    if (!this.cache.has(sql) && this.cache.size >= this.maxEntries) {
      // Map preserves insertion order — first key is oldest
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.evictions++;
      }
    }

    // Remove existing entry if present (so re-set moves to MRU)
    if (this.cache.has(sql)) {
      this.cache.delete(sql);
    }

    this.cache.set(sql, {
      decision,
      insertedAt: Date.now(),
      lastAccessAt: Date.now(),
      accessCount: 0,
    });
  }

  /**
   * Invalidate all cached entries. Useful after config changes or schema
   * alterations that could affect routing decisions.
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Invalidate entries whose SQL matches a given table name.
   * This is a best-effort prefix match on the SQL string to handle schema
   * change events (e.g., ALTER TABLE users → invalidate any cached decision
   * mentioning "users").
   */
  invalidateForTable(tableName: string): number {
    const lower = tableName.toLowerCase();
    let count = 0;
    for (const [sql] of this.cache) {
      if (sql.toLowerCase().includes(lower)) {
        this.cache.delete(sql);
        count++;
      }
    }
    return count;
  }

  // ──────────────────────────────────────────────
  //  Diagnostics
  // ──────────────────────────────────────────────

  get size(): number {
    return this.cache.size;
  }

  getStats(): { hits: number; misses: number; evictions: number; size: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.cache.size,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}
