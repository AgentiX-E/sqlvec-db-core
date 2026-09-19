/**
 * RaftMetrics — a process-wide singleton that records per-database query
 * throughput (queries/second) and exposes it to monitoring/dashboard code.
 *
 * `QueryRouter` runs a periodic flush timer that computes each shard's QPS and
 * calls {@link setQueryThroughput}; this module is the sink for those samples
 * and the source of truth for any consumer that needs to observe application
 * load (e.g. `pg_stat_activity`-style introspection, health checks, or load
 * balancers).
 *
 * The name reflects its origin in Raft-replicated deployments where a leader
 * aggregates throughput from followers; here it serves as a lightweight,
 * dependency-free metrics collector that keeps the latest sample per database
 * plus basic aggregate counters.
 *
 * @module monitoring/RaftMetrics
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('RaftMetrics');

/** A single database's latest throughput observation. */
export interface QueryThroughputSample {
  /** Database name. */
  database: string;
  /** Queries per second, as computed by the flush timer. */
  qps: number;
  /** Epoch milliseconds when the sample was set. */
  updatedAt: number;
}

/**
 * Process-wide per-database query throughput collector.
 */
export class RaftMetrics {
  private static instance: RaftMetrics | null = null;

  /** Per-database latest QPS sample, keyed by database name. */
  private readonly throughput = new Map<string, QueryThroughputSample>();

  /** Total number of samples ever recorded (across all databases). */
  private totalSamples = 0;

  private constructor() {
    // Private to enforce the singleton contract.
  }

  /** Get (or lazily create) the process-wide singleton. */
  static getInstance(): RaftMetrics {
    if (RaftMetrics.instance === null) {
      RaftMetrics.instance = new RaftMetrics();
    }
    return RaftMetrics.instance;
  }

  /**
   * Record the latest query throughput for a database.
   *
   * @param database - Database name.
   * @param qps - Queries per second (may be `0` to indicate an idle interval).
   */
  setQueryThroughput(database: string, qps: number): void {
    this.throughput.set(database, {
      database,
      qps,
      updatedAt: Date.now(),
    });
    this.totalSamples += 1;
    logger.trace({ database, qps }, 'Recorded query throughput sample');
  }

  /** Get the latest throughput sample for a single database. */
  getQueryThroughput(database: string): QueryThroughputSample | undefined {
    return this.throughput.get(database);
  }

  /** Get a snapshot of all databases' latest throughput samples. */
  getAllQueryThroughput(): QueryThroughputSample[] {
    return [...this.throughput.values()];
  }

  /** Names of all databases that have reported at least one sample. */
  getDatabaseNames(): string[] {
    return [...this.throughput.keys()];
  }

  /** Total number of samples recorded since process start. */
  get totalSampleCount(): number {
    return this.totalSamples;
  }

  /** Number of databases currently tracked. */
  get trackedDatabaseCount(): number {
    return this.throughput.size;
  }

  /**
   * Remove a database's tracked sample (e.g. after a shard is dropped).
   *
   * @returns `true` if a sample existed and was removed.
   */
  forget(database: string): boolean {
    return this.throughput.delete(database);
  }

  /**
   * Reset all samples and counters.  Used primarily by tests and by a full
   * cluster reset; it does not change the singleton identity.
   */
  reset(): void {
    this.throughput.clear();
    this.totalSamples = 0;
  }
}
