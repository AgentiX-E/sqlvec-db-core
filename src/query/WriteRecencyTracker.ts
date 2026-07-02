/**
 * WriteRecencyTracker — Tracks per-table write recency for OLTP routing decisions.
 *
 * When a table has been written to within a configurable window (default 2000ms),
 * subsequent queries against that table are forced to the SQLite OLTP engine
 * instead of the DuckDB OLAP mirror. This prevents reads from returning stale
 * data when CDC sync to DuckDB hasn't caught up yet.
 *
 * Uses a simple LRU-eviction approach to prevent unbounded memory growth:
 * maps are pruned when they exceed MAX_TABLES entries (oldest entries removed
 * first by scanning). Entries older than the prune window are also evicted.
 *
 * @see docs/design/mvcc-delete-design.md §5.3
 */

export interface WriteRecencyTrackerConfig {
  /** Time window (ms) during which a write forces SQLite OLTP routing. Default 2000. */
  windowMs: number;
  /** Maximum tracked tables before LRU eviction. Default 5000. */
  maxTables: number;
  /** How often (entries) to prune stale entries. Default 100. */
  pruneInterval: number;
}

export const DEFAULT_WRITE_RECENCY_CONFIG: WriteRecencyTrackerConfig = {
  windowMs: 2000,
  maxTables: 5000,
  pruneInterval: 100,
};

export class WriteRecencyTracker {
  private readonly config: WriteRecencyTrackerConfig;
  /** Map<tableName, lastWriteTimestamp> in milliseconds. */
  private lastWriteAt = new Map<string, number>();
  /** Counter to trigger periodic LRU pruning. */
  private opsSincePrune = 0;

  constructor(config?: Partial<WriteRecencyTrackerConfig>) {
    this.config = { ...DEFAULT_WRITE_RECENCY_CONFIG, ...config };
  }

  /**
   * Record a write operation on the given table.
   * Thread-safe in single-process SqlVec (no concurrent writes).
   */
  recordWrite(tableName: string): void {
    this.lastWriteAt.set(tableName.toLowerCase(), Date.now());
    this.opsSincePrune++;
    if (this.opsSincePrune >= this.config.pruneInterval) {
      this._prune();
      this.opsSincePrune = 0;
    }
  }

  /**
   * Returns `true` if the table had a write within the recency window.
   * Used by UnifiedRouter to force SQLite OLTP routing.
   */
  hasRecentWrite(tableName: string): boolean {
    const ts = this.lastWriteAt.get(tableName.toLowerCase());
    if (ts === undefined) return false;
    return (Date.now() - ts) < this.config.windowMs;
  }

  /**
   * Remove all entries older than the config window to prevent unbounded growth.
   * Also enforce maxTables limit via oldest-entry eviction.
   */
  private _prune(): void {
    const cutoff = Date.now() - this.config.windowMs;
    // Remove expired entries (older than recency window)
    for (const [table, ts] of this.lastWriteAt) {
      if (ts < cutoff) {
        this.lastWriteAt.delete(table);
      }
    }
    // If still over limit, remove oldest entries until under limit
    if (this.lastWriteAt.size > this.config.maxTables) {
      const sorted = [...this.lastWriteAt.entries()]
        .sort((a, b) => a[1] - b[1]); // oldest first
      const toRemove = this.lastWriteAt.size - this.config.maxTables;
      for (let i = 0; i < toRemove && i < sorted.length; i++) {
        this.lastWriteAt.delete(sorted[i][0]);
      }
    }
  }

  /** For testing/inspection: get current tracked tables. */
  getTrackedTables(): string[] {
    return [...this.lastWriteAt.keys()];
  }

  /** For testing/inspection: get last write timestamp for a table. */
  getLastWriteTime(tableName: string): number | undefined {
    return this.lastWriteAt.get(tableName.toLowerCase());
  }

  /** Clear all tracked data (for test isolation). */
  reset(): void {
    this.lastWriteAt.clear();
    this.opsSincePrune = 0;
  }
}
