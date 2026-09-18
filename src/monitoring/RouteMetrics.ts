/**
 * RouteMetrics — routing-decision observability for the unified query router.
 *
 * The unified router emits a routing event after every decision so that
 * operators can observe which engine a query was routed to, how long the
 * dispatch took, and whether the primary target fell back to SQLite.
 *
 * @module monitoring/RouteMetrics
 */

/** A single recorded routing decision. */
export interface RouteEvent {
  /** Target engine (e.g. `sqlite`, `duckdb`). */
  engine: string;
  /** Dispatch latency in milliseconds. */
  latencyMs: number;
  /** Whether the primary target failed and fell back. */
  wasFallback: boolean;
  /** Epoch-millis when the event was recorded. */
  timestamp: number;
}

/** Per-engine aggregate counters. */
export interface RouteEngineCounters {
  /** Total events routed to this engine. */
  count: number;
  /** Number of fallback events. */
  fallbacks: number;
  /** Total dispatch latency across all events. */
  totalLatencyMs: number;
}

/**
 * In-memory routing-metrics recorder with a process-wide singleton.
 *
 * Keeps a bounded history of recent events plus per-engine aggregate counters.
 */
export class RouteMetrics {
  private static instance: RouteMetrics | null = null;

  private readonly events: RouteEvent[] = [];
  private readonly counters = new Map<string, RouteEngineCounters>();

  /** Return the process-wide singleton, creating it on first use. */
  static getInstance(): RouteMetrics {
    if (!RouteMetrics.instance) {
      RouteMetrics.instance = new RouteMetrics();
    }
    return RouteMetrics.instance;
  }

  /** Create a new isolated recorder for tests/boundaries. */
  static create(): RouteMetrics {
    return new RouteMetrics();
  }

  /**
   * Record a routing decision.
   *
   * @param engine      - Target engine.
   * @param latencyMs   - Dispatch latency in milliseconds.
   * @param wasFallback - Whether the primary target failed and fell back.
   */
  emitRouteEvent(engine: string, latencyMs: number, wasFallback: boolean): void {
    const normalizedEngine = engine || 'unknown';
    this.events.push({
      engine: normalizedEngine,
      latencyMs,
      wasFallback,
      timestamp: Date.now(),
    });

    const current = this.counters.get(normalizedEngine) ?? {
      count: 0,
      fallbacks: 0,
      totalLatencyMs: 0,
    };
    current.count += 1;
    if (wasFallback) {
      current.fallbacks += 1;
    }
    current.totalLatencyMs += latencyMs;
    this.counters.set(normalizedEngine, current);
  }

  /**
   * Legacy alias for {@link emitRouteEvent} retained for source compatibility.
   * Historical callers invoked `record()` with no-op semantics.
   *
   * @param engine      - Target engine.
   * @param latencyMs   - Dispatch latency in milliseconds.
   * @param wasFallback - Whether the primary target failed and fell back.
   */
  record(engine: string, latencyMs: number, wasFallback: boolean): void {
    this.emitRouteEvent(engine, latencyMs, wasFallback);
  }

  /** Defensive snapshot of recent events (most recent last). */
  get recentEvents(): RouteEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  /** Defensive snapshot of per-engine aggregate counters. */
  get engineCounters(): ReadonlyMap<string, RouteEngineCounters> {
    return new Map(
      [...this.counters.entries()].map(([k, v]) => [k, { ...v }]),
    );
  }

  /** Total number of recorded events. */
  get totalEvents(): number {
    return this.events.length;
  }

  /** Total number of fallback events. */
  get totalFallbacks(): number {
    let sum = 0;
    for (const { fallbacks } of this.counters.values()) {
      sum += fallbacks;
    }
    return sum;
  }

  /** Total number of distinct engines observed. */
  get distinctEngines(): number {
    return this.counters.size;
  }

  /** Reset internal state (primarily for tests). */
  reset(): void {
    this.events.length = 0;
    this.counters.clear();
  }
}
