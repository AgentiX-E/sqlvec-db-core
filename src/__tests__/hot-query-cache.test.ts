/**
 * HotQueryCache — LRU routing-decision cache tests.
 *
 * Covers hit/miss accounting, TTL expiry semantics, LRU promotion and
 * eviction, invalidation (all/table-prefix), and diagnostics.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HotQueryCache } from '../query/HotQueryCache';
import { QueryTarget } from '../analytics/AnalyticQueryClassifier';
import type { RouteDecision } from '../query/RouteDecision';

function decision(id = 0): RouteDecision {
  return {
    target: QueryTarget.SQLITE_OLTP,
    reason: `reason-${id}`,
    skipFallback: false,
  };
}

describe('HotQueryCache basics', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns undefined on a miss and counts it', () => {
    const c = new HotQueryCache();
    expect(c.get('SELECT 1')).toBeUndefined();
    expect(c.getStats().misses).toBe(1);
  });

  it('stores and retrieves a decision', () => {
    const c = new HotQueryCache();
    const d = decision();
    c.set('SELECT 1', d);
    expect(c.get('SELECT 1')).toBe(d);
    expect(c.getStats().hits).toBe(1);
  });

  it('tracks size', () => {
    const c = new HotQueryCache();
    c.set('a', decision());
    c.set('b', decision());
    expect(c.size).toBe(2);
  });

  it('computes hit rate from hits and misses', () => {
    const c = new HotQueryCache();
    c.get('miss');
    const d = decision();
    c.set('hit', d);
    c.get('hit');
    const s = c.getStats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(0.5);
  });

  it('returns a hit rate of zero with no traffic', () => {
    const c = new HotQueryCache();
    expect(c.getStats().hitRate).toBe(0);
  });
});

describe('HotQueryCache TTL expiry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('expires an entry after TTL elapses', () => {
    const c = new HotQueryCache({ ttlMs: 1000 });
    c.set('sql', decision());
    vi.advanceTimersByTime(1001);
    expect(c.get('sql')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('does not expire an entry before TTL elapses', () => {
    const c = new HotQueryCache({ ttlMs: 1000 });
    c.set('sql', decision());
    vi.advanceTimersByTime(999);
    expect(c.get('sql')).toBeDefined();
  });

  it('keeps a frequently-accessed entry alive across its TTL (idle semantics)', () => {
    const c = new HotQueryCache({ ttlMs: 1000 });
    const d = decision();
    c.set('sql', d);
    // Access it repeatedly, advancing just under the TTL each time.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(900);
      expect(c.get('sql')).toBe(d);
    }
    // Total elapsed time exceeds TTL, but each access resets the idle timer.
    expect(c.get('sql')).toBe(d);
  });
});

describe('HotQueryCache LRU eviction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('evicts the least-recently-used entry at capacity', () => {
    const c = new HotQueryCache({ maxEntries: 2 });
    c.set('a', decision(1));
    c.set('b', decision(2));
    // Access 'a' so 'b' becomes LRU.
    c.get('a');
    // Insert 'c' → evicts 'b'.
    c.set('c', decision(3));
    expect(c.get('a')).toBeDefined();
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBeDefined();
  });

  it('counts evictions', () => {
    const c = new HotQueryCache({ maxEntries: 1 });
    c.set('a', decision());
    c.set('b', decision());
    expect(c.getStats().evictions).toBe(1);
  });

  it('re-set updates the value and does not evict', () => {
    const c = new HotQueryCache({ maxEntries: 1 });
    c.set('a', decision(1));
    c.set('a', decision(2));
    expect(c.size).toBe(1);
    expect(c.get('a')).toMatchObject({ reason: 'reason-2' });
    expect(c.getStats().evictions).toBe(0);
  });

  it('increments accessCount on each get', () => {
    const c = new HotQueryCache();
    c.set('a', decision());
    c.get('a');
    c.get('a');
    // accessCount is not exposed; verify via stat side effects only.
    expect(c.getStats().hits).toBe(2);
  });
});

describe('HotQueryCache invalidation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('invalidateAll clears the cache', () => {
    const c = new HotQueryCache();
    c.set('a', decision());
    c.set('b', decision());
    c.invalidateAll();
    expect(c.size).toBe(0);
  });

  it('invalidateForTable removes entries mentioning the table', () => {
    const c = new HotQueryCache();
    c.set('SELECT * FROM users', decision(1));
    c.set('SELECT * FROM orders', decision(2));
    c.set('SELECT * FROM users_archive', decision(3));

    const removed = c.invalidateForTable('users');
    expect(removed).toBe(2); // 'users' and 'users_archive' both contain "users"
    expect(c.get('SELECT * FROM users')).toBeUndefined();
    expect(c.get('SELECT * FROM users_archive')).toBeUndefined();
    expect(c.get('SELECT * FROM orders')).toBeDefined();
  });

  it('invalidateForTable is case-insensitive', () => {
    const c = new HotQueryCache();
    c.set('SELECT * FROM Users', decision());
    expect(c.invalidateForTable('USERS')).toBe(1);
    expect(c.size).toBe(0);
  });
});

describe('HotQueryCache config defaults', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('applies default maxEntries and ttlMs when unset', () => {
    const c = new HotQueryCache();
    // Default TTL 60s: entry survives 59s.
    c.set('a', decision());
    vi.advanceTimersByTime(59_000);
    expect(c.get('a')).toBeDefined();
  });

  it('respects a custom ttlMs', () => {
    const c = new HotQueryCache({ ttlMs: 500 });
    c.set('a', decision());
    vi.advanceTimersByTime(501);
    expect(c.get('a')).toBeUndefined();
  });
});

describe('HotQueryCache zero-capacity edge case', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not crash when maxEntries is zero', () => {
    const c = new HotQueryCache({ maxEntries: 0 });
    // Empty map → cache.keys().next().value is undefined (the oldestKey guard).
    expect(() => c.set('a', decision())).not.toThrow();
  });
});
