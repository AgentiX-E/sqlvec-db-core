/**
 * Unit tests for MetricsManager and its built-in counter/histogram primitives.
 *
 * Exercises counter increments, histogram bucketing and snapshots, reset
 * semantics, and the optional prom-client-compatible injection points.
 */
import { describe, it, expect } from 'vitest';
import {
  MetricsManager,
  SimpleCounter,
  SimpleHistogram,
} from '../core/MetricsManager';

describe('SimpleCounter', () => {
  it('defaults to zero and increments by one', () => {
    const c = new SimpleCounter();
    expect(c.get()).toBe(0);
    c.inc();
    expect(c.get()).toBe(1);
  });

  it('increments by a custom amount', () => {
    const c = new SimpleCounter();
    c.inc(5);
    c.inc(3);
    expect(c.get()).toBe(8);
  });

  it('resets to zero', () => {
    const c = new SimpleCounter();
    c.inc(10);
    c.reset();
    expect(c.get()).toBe(0);
  });
});

describe('SimpleHistogram', () => {
  it('records observations into the correct buckets', () => {
    const h = new SimpleHistogram([10, 100, 1000]);
    h.observe(5); // -> bucket 0
    h.observe(50); // -> bucket 1
    h.observe(500); // -> bucket 2
    h.observe(2000); // -> beyond the last bound
    const snap = h.snapshot();
    expect(snap.count).toBe(4);
    expect(snap.sum).toBe(5 + 50 + 500 + 2000);
    // Cumulative: bucket 0 -> 1, bucket 1 -> 2, bucket 2 -> 3 (the 2000 is
    // above every bound and is never counted in any bucket).
    expect(snap.bucketCounts).toEqual([1, 2, 3]);
  });

  it('starts empty', () => {
    const h = new SimpleHistogram([10, 100]);
    expect(h.snapshot()).toMatchObject({ count: 0, sum: 0 });
    expect(h.snapshot().bucketCounts).toEqual([0, 0]);
  });

  it('resets all state', () => {
    const h = new SimpleHistogram([10, 100]);
    h.observe(5);
    h.observe(50);
    h.reset();
    expect(h.snapshot()).toMatchObject({ count: 0, sum: 0 });
    expect(h.snapshot().bucketCounts).toEqual([0, 0]);
  });

  it('uses default latency buckets when none are provided', () => {
    const h = new SimpleHistogram();
    h.observe(3);
    const snap = h.snapshot();
    expect(snap.bucketBounds.length).toBeGreaterThan(0);
    expect(snap.count).toBe(1);
  });

  it('sorts cumulative counts monotonically', () => {
    const h = new SimpleHistogram([5, 50, 500]);
    h.observe(1);
    h.observe(600);
    const cumulative = h.snapshot().bucketCounts;
    for (let i = 1; i < cumulative.length; i++) {
      expect(cumulative[i]).toBeGreaterThanOrEqual(cumulative[i - 1]);
    }
  });
});

describe('MetricsManager', () => {
  it('records a query and updates queryTotal + queryDuration', () => {
    const m = new MetricsManager();
    m.recordQuery(42);
    expect(m.queryTotal.get()).toBe(1);
    expect(m.queryDuration.snapshot().count).toBe(1);
    expect(m.queryDuration.snapshot().sum).toBe(42);
  });

  it('keeps queryTotal monotonic across multiple queries', () => {
    const m = new MetricsManager();
    m.recordQuery(10);
    m.recordQuery(20);
    m.recordQuery(30);
    expect(m.queryTotal.get()).toBe(3);
    expect(m.queryDuration.snapshot().count).toBe(3);
  });

  it('exposes queryDuration.observe and queryTotal.inc directly (QueryRouter contract)', () => {
    const m = new MetricsManager();
    m.queryDuration.observe(5);
    m.queryTotal.inc(1);
    m.queryDuration.observe(15);
    m.queryTotal.inc(1);
    expect(m.queryTotal.get()).toBe(2);
    expect(m.queryDuration.snapshot().count).toBe(2);
    expect(m.queryDuration.snapshot().sum).toBe(20);
  });

  it('accepts optional prom-client-compatible injection points', () => {
    const m = new MetricsManager();
    expect(m.sqlvecQueriesTotal).toBeUndefined();
    expect(m.sqlvecActiveConnections).toBeUndefined();

    const injectedCounter = { inc: () => undefined };
    const injectedGauge = { set: () => undefined };
    m.sqlvecQueriesTotal = injectedCounter;
    m.sqlvecActiveConnections = injectedGauge;
    expect(m.sqlvecQueriesTotal).toBe(injectedCounter);
    expect(m.sqlvecActiveConnections).toBe(injectedGauge);
  });
});
