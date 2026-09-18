/**
 * Unit tests for RouteMetrics.
 *
 * Verifies routing-event recording, per-engine aggregate counters, defensive
 * snapshot behavior, and the singleton/isolated-instance factory split.  The
 * previous stub defined `record()` but UnifiedRouter called
 * `metrics.emitRouteEvent(...)` — a missing method that would throw at runtime
 * (BUG #162).
 */
import { describe, it, expect } from 'vitest';
import { RouteMetrics } from '../monitoring/RouteMetrics';

describe('RouteMetrics — factory & singleton', () => {
  it('getInstance returns the same singleton', () => {
    expect(RouteMetrics.getInstance()).toBe(RouteMetrics.getInstance());
  });

  it('create returns an isolated instance', () => {
    expect(RouteMetrics.create()).not.toBe(RouteMetrics.getInstance());
  });
});

describe('RouteMetrics — event recording', () => {
  it('emitRouteEvent records an event and counters', () => {
    const m = RouteMetrics.create();
    m.emitRouteEvent('sqlite', 12.5, false);
    expect(m.totalEvents).toBe(1);
    const counters = m.engineCounters.get('sqlite');
    expect(counters).toEqual({ count: 1, fallbacks: 0, totalLatencyMs: 12.5 });
  });

  it('record is an alias for emitRouteEvent', () => {
    const m = RouteMetrics.create();
    m.record('duckdb', 5, true);
    expect(m.totalEvents).toBe(1);
    expect(m.engineCounters.get('duckdb')).toEqual({
      count: 1,
      fallbacks: 1,
      totalLatencyMs: 5,
    });
  });

  it('aggregates counters across multiple events per engine', () => {
    const m = RouteMetrics.create();
    m.emitRouteEvent('sqlite', 10, false);
    m.emitRouteEvent('sqlite', 20, true);
    m.emitRouteEvent('sqlite', 30, false);
    const c = m.engineCounters.get('sqlite');
    expect(c).toEqual({ count: 3, fallbacks: 1, totalLatencyMs: 60 });
  });

  it('normalizes empty engine name to "unknown"', () => {
    const m = RouteMetrics.create();
    m.emitRouteEvent('', 1, false);
    expect(m.engineCounters.has('unknown')).toBe(true);
  });

  it('tracks fallback totals across engines', () => {
    const m = RouteMetrics.create();
    m.emitRouteEvent('sqlite', 1, true);
    m.emitRouteEvent('duckdb', 1, true);
    m.emitRouteEvent('duckdb', 1, false);
    expect(m.totalFallbacks).toBe(2);
  });

  it('tracks distinct engines', () => {
    const m = RouteMetrics.create();
    m.emitRouteEvent('sqlite', 1, false);
    m.emitRouteEvent('duckdb', 1, false);
    expect(m.distinctEngines).toBe(2);
  });
});

describe('RouteMetrics — defensive copies & reset', () => {
  it('recentEvents returns a detached snapshot', () => {
    const m = RouteMetrics.create();
    m.emitRouteEvent('sqlite', 1, false);
    const snapshot = m.recentEvents;
    snapshot.length = 0;
    expect(m.recentEvents).toHaveLength(1);
  });

  it('engineCounters returns a detached map', () => {
    const m = RouteMetrics.create();
    m.emitRouteEvent('sqlite', 1, false);
    const snapshot = m.engineCounters;
    snapshot.clear();
    expect(m.engineCounters.has('sqlite')).toBe(true);
  });

  it('reset clears events and counters', () => {
    const m = RouteMetrics.create();
    m.emitRouteEvent('sqlite', 1, false);
    m.reset();
    expect(m.totalEvents).toBe(0);
    expect(m.distinctEngines).toBe(0);
  });
});
