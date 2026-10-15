/**
 * PgCatalogShim — Runtime bridge between QueryRouter and PgCatalog.
 *
 * Provides:
 * - Runtime counters for seq_scan, idx_scan, idx_tup_read, etc.
 * - Wrapper calls to PgCatalog's dynamic pg_catalog view generators
 * - Integration hooks for QueryRouter to increment counters on real queries
 *
 * Usage (in QueryRouter):
 *   import { pgCatalogShim } from '../index/PgCatalogShim';
 *
 *   // On table scan:
 *   pgCatalogShim.incrementSeqScan('my_table');
 *
 *   // On index scan:
 *   pgCatalogShim.incrementIdxScan('my_index');
 */

import { PgCatalog } from '../system/PgCatalog';

// ── Types ────────────────────────────────────────────────────────

export interface TableStats {
  seq_scan: number;
  seq_tup_read: number;
  idx_scan: number;
  idx_tup_fetch: number;
}

export interface IndexStats {
  idx_scan: number;
  idx_tup_read: number;
  idx_tup_fetch: number;
}

export interface PgCatalogShimOptions {
  /** Whether to enable verbose logging of counter increments */
  verbose: boolean;
}

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_OPTIONS: PgCatalogShimOptions = {
  verbose: false,
};

// ── PgCatalogShim ────────────────────────────────────────────────

class PgCatalogShimImpl {
  private tableCounters: Map<string, TableStats> = new Map();
  private indexCounters: Map<string, IndexStats> = new Map();
  private options: PgCatalogShimOptions;

  constructor(options?: Partial<PgCatalogShimOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // ── Table scan counters ────────────────────────────────────

  /** Increment seq_scan counter for a table. Returns the new count. */
  incrementSeqScan(tableName: string): number {
    const lower = tableName.toLowerCase();
    let stats = this.tableCounters.get(lower);
    if (!stats) {
      stats = { seq_scan: 0, seq_tup_read: 0, idx_scan: 0, idx_tup_fetch: 0 };
      this.tableCounters.set(lower, stats);
    }
    stats.seq_scan++;
    return stats.seq_scan;
  }

  /** Increment seq_tup_read counter for a table. */
  incrementSeqTupRead(tableName: string, count: number = 1): void {
    const lower = tableName.toLowerCase();
    let stats = this.tableCounters.get(lower);
    if (!stats) {
      stats = { seq_scan: 0, seq_tup_read: 0, idx_scan: 0, idx_tup_fetch: 0 };
      this.tableCounters.set(lower, stats);
    }
    stats.seq_tup_read += count;
  }

  /** Increment idx_scan counter for an index. */
  incrementIdxScan(indexName: string): number {
    const lower = indexName.toLowerCase();
    let stats = this.indexCounters.get(lower);
    if (!stats) {
      stats = { idx_scan: 0, idx_tup_read: 0, idx_tup_fetch: 0 };
      this.indexCounters.set(lower, stats);
    }
    stats.idx_scan++;
    return stats.idx_scan;
  }

  /** Increment idx_tup_read counter for an index. */
  incrementIdxTupRead(indexName: string, count: number = 1): void {
    const lower = indexName.toLowerCase();
    let stats = this.indexCounters.get(lower);
    if (!stats) {
      stats = { idx_scan: 0, idx_tup_read: 0, idx_tup_fetch: 0 };
      this.indexCounters.set(lower, stats);
    }
    stats.idx_tup_read += count;
  }

  /** Increment idx_tup_fetch counter for an index. */
  incrementIdxTupFetch(indexName: string, count: number = 1): void {
    const lower = indexName.toLowerCase();
    let stats = this.indexCounters.get(lower);
    if (!stats) {
      stats = { idx_scan: 0, idx_tup_read: 0, idx_tup_fetch: 0 };
      this.indexCounters.set(lower, stats);
    }
    stats.idx_tup_fetch += count;
  }

  // ── Getters ────────────────────────────────────────────────

  /** Get current table scan counter values. */
  getTableStats(tableName: string): TableStats {
    const lower = tableName.toLowerCase();
    return this.tableCounters.get(lower) || { seq_scan: 0, seq_tup_read: 0, idx_scan: 0, idx_tup_fetch: 0 };
  }

  /** Get current index scan counter values. */
  getIndexStats(indexName: string): IndexStats {
    const lower = indexName.toLowerCase();
    return this.indexCounters.get(lower) || { idx_scan: 0, idx_tup_read: 0, idx_tup_fetch: 0 };
  }

  /** Get all tracked table counters. */
  getAllTableStats(): Map<string, TableStats> {
    return new Map(this.tableCounters);
  }

  /** Get all tracked index counters. */
  getAllIndexStats(): Map<string, IndexStats> {
    return new Map(this.indexCounters);
  }

  // ── Reset ─────────────────────────────────────────────────

  /** Reset all counters (useful in tests). */
  reset(): void {
    this.tableCounters.clear();
    this.indexCounters.clear();
  }
}

// ── Singleton export ─────────────────────────────────────────────

export const pgCatalogShim = new PgCatalogShimImpl();

// ── Helper: sync shim counters into PgCatalog.userTableStats ─────

/**
 * Sync runtime shim counters into PgCatalog.userTableStats/userIndexStats
 * so that pg_stat_user_tables and pg_stat_user_indexes reflect real-time
 * scan/read counts.
 *
 * Call this periodically (e.g., after each query) or on-demand.
 */
export function syncShimToPgCatalog(): void {
  for (const [tableName, stats] of pgCatalogShim.getAllTableStats()) {
    const existing = PgCatalog.userTableStats.get(tableName);
    if (existing) {
      existing.seq_scan += stats.seq_scan;
      existing.seq_tup_read += stats.seq_tup_read;
    } else {
      PgCatalog.userTableStats.set(tableName, {
        seq_scan: stats.seq_scan,
        seq_tup_read: stats.seq_tup_read,
        idx_scan: stats.idx_scan,
        idx_tup_fetch: stats.idx_tup_fetch,
        n_tup_ins: 0,
        n_tup_upd: 0,
        n_tup_del: 0,
        n_live_tup: 0,
        n_dead_tup: 0,
        n_mod_since_analyze: 0,
        last_analyze: null,
        last_autoanalyze: null,
      });
    }
  }

  for (const [indexName, stats] of pgCatalogShim.getAllIndexStats()) {
    const existing = PgCatalog.userIndexStats.get(indexName);
    if (existing) {
      existing.idx_scan += stats.idx_scan;
      existing.idx_tup_read += stats.idx_tup_read;
      existing.idx_tup_fetch += stats.idx_tup_fetch;
    } else {
      PgCatalog.userIndexStats.set(indexName, {
        idx_scan: stats.idx_scan,
        idx_tup_read: stats.idx_tup_read,
        idx_tup_fetch: stats.idx_tup_fetch,
      });
    }
  }

  // Reset the shim counters after syncing so a subsequent sync does not
  // re-add the same accumulated counts (idempotent incremental sync).
  pgCatalogShim.reset();
}
