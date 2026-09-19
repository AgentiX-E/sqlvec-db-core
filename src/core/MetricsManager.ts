/**
 * MetricsManager — the central query metrics collector for the database core.
 *
 * Exposes a small, dependency-free Prometheus-style metrics surface used by
 * `QueryRouter` to record per-query latency (a histogram) and total query
 * volume (a counter).  Two optional fields (`sqlvecQueriesTotal` and
 * `sqlvecActiveConnections`) remain for callers that inject a real
 * prom-client-compatible metric object; when those are absent, the built-in
 * counters below are authoritative.
 *
 * @module core/MetricsManager
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('MetricsManager');

/** Prometheus counter interface (a structural subset of prom-client's Counter). */
export interface Counter {
  inc(value?: number): void;
}

/** Prometheus gauge interface (a structural subset of prom-client's Gauge). */
export interface Gauge {
  set(value: number): void;
}

/** A monotonic counter backed by an in-process number. */
export class SimpleCounter implements Counter {
  private value = 0;

  inc(value = 1): void {
    this.value += value;
  }

  /** Current total. */
  get(): number {
    return this.value;
  }

  /** Reset to zero. */
  reset(): void {
    this.value = 0;
  }
}

/** A fixed-bound-bucket histogram for query latency (milliseconds). */
const LATENCY_BUCKETS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 30_000,
] as const;

export interface HistogramSnapshot {
  /** Cumulative count of observations. */
  count: number;
  /** Sum of all observed values. */
  sum: number;
  /** Number of observations at or below each configured bucket bound. */
  bucketCounts: number[];
  /** The bucket upper bounds, in ascending order. */
  bucketBounds: readonly number[];
}

/** A simple cumulative histogram for latency values. */
export class SimpleHistogram {
  private count = 0;
  private sum = 0;
  private readonly buckets: number[];

  constructor(private readonly bounds: readonly number[] = LATENCY_BUCKETS) {
    this.buckets = new Array(bounds.length).fill(0);
  }

  /**
   * Record a single observation.
   *
   * @param value - The observed value (e.g. latency in milliseconds).
   */
  observe(value: number): void {
    this.count += 1;
    this.sum += value;
    const idx = this.bounds.findIndex((b) => value <= b);
    if (idx >= 0) this.buckets[idx] += 1;
  }

  /** Snapshot of the histogram's cumulative state. */
  snapshot(): HistogramSnapshot {
    const cumulative: number[] = [];
    let running = 0;
    for (const c of this.buckets) {
      running += c;
      cumulative.push(running);
    }
    return {
      count: this.count,
      sum: this.sum,
      bucketCounts: cumulative,
      bucketBounds: this.bounds,
    };
  }

  /** Reset the histogram to empty. */
  reset(): void {
    this.count = 0;
    this.sum = 0;
    this.buckets.fill(0);
  }
}

/**
 * The query metrics collector.
 */
export class MetricsManager {
  /** Total queries executed (monotonic counter). */
  readonly queryTotal: Counter;
  /** Histogram of query latency (milliseconds). */
  readonly queryDuration: SimpleHistogram;

  /**
   * Optional externally-injected prom-client counters.  Kept for API
   * compatibility with deployments that wire a real metrics registry; when
   * absent, {@link queryTotal} and {@link queryDuration} remain authoritative.
   */
  sqlvecQueriesTotal?: Counter;
  sqlvecActiveConnections?: Gauge;

  constructor() {
    this.queryTotal = new SimpleCounter();
    this.queryDuration = new SimpleHistogram();
  }

  /**
   * Record a query latency observation and increment the query counter.
   *
   * @param elapsedMs - Query duration in milliseconds.
   */
  recordQuery(elapsedMs: number): void {
    this.queryDuration.observe(elapsedMs);
    this.queryTotal.inc(1);
    logger.trace({ elapsedMs }, 'Recorded query metric');
  }
}
