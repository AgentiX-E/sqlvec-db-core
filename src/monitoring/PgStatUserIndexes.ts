/**
 * PgStatUserIndexes — per-index usage statistics.
 *
 * Mirrors PostgreSQL's `pg_stat_user_indexes` view: tracks index scan counts,
 * tuple reads, and block hits per (schema-agnostic) index name.  The plan
 * executor records these counters after using an index so operators can see
 * which indexes actually get used.
 *
 * @module monitoring/PgStatUserIndexes
 */

/** A single index's accumulated usage statistics. */
export interface IndexStatEntry {
  /** Index name. */
  indexName: string;
  /** Number of index scans. */
  idx_scan: number;
  /** Number of index tuples read. */
  idx_tup_read: number;
  /** Number of index block hits. */
  idx_blks_hit: number;
}

/**
 * In-memory index-usage statistics collector.
 *
 * Statistics are keyed by index name; the optional table name is retained for
 * callers that want the association but is not part of the key.
 */
export class PgStatUserIndexes {
  private readonly stats = new Map<string, IndexStatEntry>();

  /**
   * Record a single index scan.
   *
   * @param indexName - Index name.
   * @param _tableName - Owning table (informational; not part of the key).
   */
  recordIndexScan(indexName: string, _tableName?: string): void {
    const entry = this.entryFor(indexName);
    entry.idx_scan += 1;
  }

  /**
   * Record the number of tuples read from an index.
   *
   * @param indexName - Index name.
   * @param tuples    - Number of tuples read.
   */
  recordIndexTuplesRead(indexName: string, tuples: number): void {
    if (tuples <= 0) {
      return;
    }
    const entry = this.entryFor(indexName);
    entry.idx_tup_read += tuples;
  }

  /**
   * Record an index block access.
   *
   * @param indexName - Index name.
   * @param isHit     - `true` for a cache hit, `false` for a miss.
   */
  recordIndexBlock(indexName: string, isHit: boolean): void {
    if (isHit) {
      const entry = this.entryFor(indexName);
      entry.idx_blks_hit += 1;
    }
  }

  /**
   * Return the accumulated statistics for an index, or `undefined`.
   *
   * @param indexName - Index name.
   */
  getIndexStats(indexName: string): IndexStatEntry | undefined {
    const entry = this.stats.get(indexName);
    return entry ? { ...entry } : undefined;
  }

  /** Defensive snapshot of all index statistics. */
  getAll(): IndexStatEntry[] {
    return [...this.stats.values()].map((e) => ({ ...e }));
  }

  /** Number of tracked indexes. */
  get size(): number {
    return this.stats.size;
  }

  /** Reset all accumulated statistics (primarily for tests). */
  reset(): void {
    this.stats.clear();
  }

  /** Create (or return) the entry for an index name. */
  private entryFor(indexName: string): IndexStatEntry {
    let entry = this.stats.get(indexName);
    if (!entry) {
      entry = { indexName, idx_scan: 0, idx_tup_read: 0, idx_blks_hit: 0 };
      this.stats.set(indexName, entry);
    }
    return entry;
  }
}

/** Process-wide default index-stats collector. */
const defaultCollector = new PgStatUserIndexes();

/**
 * Return the default index-stats collector.
 *
 * The previous stub always returned `null`, so index usage tracking was
 * silently disabled (BUG #161).  The collector is a process-wide singleton.
 */
export function getIndexStatsCollector(): PgStatUserIndexes {
  return defaultCollector;
}

/**
 * Alias for {@link getIndexStatsCollector} matching the historical import name
 * in `PlanExecutor` (`import { getDefaultCollector as getIndexStatsCollector }`).
 */
export function getDefaultCollector(): PgStatUserIndexes {
  return defaultCollector;
}
