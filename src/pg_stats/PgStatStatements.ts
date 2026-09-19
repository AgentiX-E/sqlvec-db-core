/**
 * PgStatStatements — pg_stat_statements-equivalent query statistics tracker.
 *
 * Mirrors PostgreSQL's `pg_stat_statements` extension: aggregates per-query
 * call counts, total/min/max/mean runtime, rows returned, and shared block
 * hits/reads.  Each distinct query text is identified by a stable hash
 * (`queryid`), matching PostgreSQL's use of an FNV-derived hash so that the
 * same query always maps to the same id.
 *
 * @module pg_stats/PgStatStatements
 */

/** A single aggregated statement's statistics. */
export interface StatementStat {
  /** Stable id derived from the query text (FNV-1a). */
  queryid: number;
  /** Normalized query text. */
  query: string;
  /** Number of times the query was executed. */
  calls: number;
  /** Total execution time in milliseconds. */
  total_time: number;
  /** Minimum execution time in milliseconds. */
  min_time: number;
  /** Maximum execution time in milliseconds. */
  max_time: number;
  /** Mean execution time in milliseconds. */
  mean_time: number;
  /** Total rows returned. */
  rows: number;
  /** Shared block hits (cache hits). */
  shared_blks_hit: number;
  /** Shared block reads (cache misses). */
  shared_blks_read: number;
}

/**
 * 64-bit FNV-1a hash of a query string, returned as an unsigned 32-bit value.
 *
 * PostgreSQL uses a hash of the query text for `queryid`; this implementation
 * mirrors that intent with a stable, collision-resistant function that is
 * deterministic across processes.
 *
 * @param input - Query text.
 * @returns Unsigned 32-bit hash.
 */
function queryHash(input: string): number {
  // FNV-1a 32-bit offset basis and prime.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Aggregates per-query statistics keyed by `queryid`.
 *
 * `recordQuery` accumulates runtime and row data for a query; `getAll` returns
 * a defensive snapshot ordered by first-seen.
 */
export class PgStatStatements {
  private static instance: PgStatStatements | null = null;

  private readonly stats = new Map<number, StatementStat>();

  /** Return the process-wide singleton, creating it on first use. */
  static getInstance(): PgStatStatements {
    if (!PgStatStatements.instance) {
      PgStatStatements.instance = new PgStatStatements();
    }
    return PgStatStatements.instance;
  }

  /** Create a new isolated tracker for tests/boundaries. */
  static create(): PgStatStatements {
    return new PgStatStatements();
  }

  /**
   * Record a single execution of a query.
   *
   * The query text is hashed to a `queryid`; the first execution creates a new
   * entry, subsequent executions aggregate into the existing one.
   *
   * @param sql        - Query text.
   * @param durationMs - Execution time in milliseconds.
   * @param rowCount   - Number of rows returned.
   */
  recordQuery(sql: string, durationMs: number, rowCount: number): void {
    const queryid = queryHash(sql);
    const duration = durationMs < 0 ? 0 : durationMs;
    const rows = rowCount < 0 ? 0 : rowCount;

    const existing = this.stats.get(queryid);
    if (!existing) {
      this.stats.set(queryid, {
        queryid,
        query: sql,
        calls: 1,
        total_time: duration,
        min_time: duration,
        max_time: duration,
        mean_time: duration,
        rows,
        shared_blks_hit: 0,
        shared_blks_read: 0,
      });
      return;
    }

    existing.calls += 1;
    existing.total_time += duration;
    if (duration < existing.min_time) {
      existing.min_time = duration;
    }
    if (duration > existing.max_time) {
      existing.max_time = duration;
    }
    existing.mean_time = existing.total_time / existing.calls;
    existing.rows += rows;
  }

  /**
   * Return a defensive snapshot of all statement statistics.
   *
   * Entries are returned in first-seen insertion order.
   */
  getAll(): StatementStat[] {
    return [...this.stats.values()].map((s) => ({ ...s }));
  }

  /**
   * Return the statistics for a single query id, or `undefined`.
   *
   * @param queryid - Query id.
   */
  get(queryid: number): StatementStat | undefined {
    const entry = this.stats.get(queryid);
    return entry ? { ...entry } : undefined;
  }

  /** Number of distinct queries tracked. */
  get size(): number {
    return this.stats.size;
  }

  /** Reset all statistics (primarily for tests). */
  reset(): void {
    this.stats.clear();
  }
}
