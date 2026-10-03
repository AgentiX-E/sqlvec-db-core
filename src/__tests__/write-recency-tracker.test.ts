/**
 * WriteRecencyTracker — per-table write recency tests.
 *
 * Covers window boundedness (in/out, boundary), case-insensitive table keys,
 * periodic LRU pruning trigger, stale-entry eviction, and maxTables overflow
 * eviction ordering.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WriteRecencyTracker,
  DEFAULT_WRITE_RECENCY_CONFIG,
} from '../query/WriteRecencyTracker';

describe('WriteRecencyTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a recent write immediately after recording', () => {
    const t = new WriteRecencyTracker();
    t.recordWrite('orders');
    expect(t.hasRecentWrite('orders')).toBe(true);
  });

  it('reports no recent write for an unknown table', () => {
    const t = new WriteRecencyTracker();
    expect(t.hasRecentWrite('orders')).toBe(false);
  });

  it('reports false once the window elapses', () => {
    const t = new WriteRecencyTracker({ windowMs: 1000 });
    t.recordWrite('orders');
    expect(t.hasRecentWrite('orders')).toBe(true);

    vi.advanceTimersByTime(999);
    expect(t.hasRecentWrite('orders')).toBe(true);

    vi.advanceTimersByTime(1); // exactly 1000ms elapsed
    expect(t.hasRecentWrite('orders')).toBe(false);
  });

  it('treats table names case-insensitively', () => {
    const t = new WriteRecencyTracker();
    t.recordWrite('Orders');
    expect(t.hasRecentWrite('ORDERS')).toBe(true);
    expect(t.hasRecentWrite('orders')).toBe(true);
  });

  it('tracks distinct tables independently', () => {
    const t = new WriteRecencyTracker({ windowMs: 1000 });
    t.recordWrite('orders');
    vi.advanceTimersByTime(500);
    t.recordWrite('users');
    // users written later, still recent; orders also still within window.
    expect(t.hasRecentWrite('orders')).toBe(true);
    expect(t.hasRecentWrite('users')).toBe(true);
  });

  it('merges partial config over defaults', () => {
    const t = new WriteRecencyTracker({ windowMs: 500 });
    // maxTables and pruneInterval fall back to defaults.
    expect((t as any).config).toEqual({ ...DEFAULT_WRITE_RECENCY_CONFIG, windowMs: 500 });
  });
});

describe('WriteRecencyTracker pruning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prunes entries older than the window on the prune interval', () => {
    const t = new WriteRecencyTracker({ windowMs: 1000, pruneInterval: 3, maxTables: 100 });
    t.recordWrite('a');
    vi.advanceTimersByTime(2000); // 'a' is now 2000ms old (> window)
    t.recordWrite('b'); // ts_b = 2000ms
    vi.advanceTimersByTime(10);
    t.recordWrite('c'); // opsSincePrune reaches 3 → prune

    const tables = t.getTrackedTables().sort();
    // 'a' (2000ms old, past the 1000ms window) is evicted; 'b' and 'c' remain.
    expect(tables).toEqual(['b', 'c']);
  });

  it('evicts oldest entries when maxTables is exceeded (forced prune)', () => {
    const t = new WriteRecencyTracker({
      windowMs: 1000000,
      maxTables: 2,
      pruneInterval: 3,
    });
    t.recordWrite('a');
    vi.advanceTimersByTime(1);
    t.recordWrite('b');
    vi.advanceTimersByTime(1);
    t.recordWrite('c'); // opsSincePrune == 3 → prune; size 3 > maxTables 2 → evict oldest 'a'

    const tables = t.getTrackedTables().sort();
    expect(tables).toEqual(['b', 'c']);
    expect(tables).not.toContain('a');
  });

  it('does not prune before the interval is reached', () => {
    const t = new WriteRecencyTracker({ windowMs: 10, pruneInterval: 10, maxTables: 100 });
    t.recordWrite('a');
    vi.advanceTimersByTime(100); // 'a' is stale but prune not yet triggered
    t.recordWrite('b');
    // Still < 10 ops, so 'a' is not pruned yet (prune is lazy).
    expect(t.getTrackedTables().sort()).toEqual(['a', 'b']);
  });

  it('reset clears state', () => {
    const t = new WriteRecencyTracker();
    t.recordWrite('a');
    t.recordWrite('b');
    t.reset();
    expect(t.getTrackedTables()).toEqual([]);
    expect(t.hasRecentWrite('a')).toBe(false);
  });
});

describe('WriteRecencyTracker inspection helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('getLastWriteTime returns the recorded timestamp', () => {
    const t = new WriteRecencyTracker();
    t.recordWrite('orders');
    expect(t.getLastWriteTime('orders')).toBe(Date.now());
  });

  it('getLastWriteTime returns undefined for unknown table', () => {
    const t = new WriteRecencyTracker();
    expect(t.getLastWriteTime('nope')).toBeUndefined();
  });

  it('getLastWriteTime is case-insensitive', () => {
    const t = new WriteRecencyTracker();
    t.recordWrite('Orders');
    expect(t.getLastWriteTime('orders')).toBe(Date.now());
  });

  it('getTrackedTables returns table names in insertion order', () => {
    const t = new WriteRecencyTracker();
    t.recordWrite('a');
    t.recordWrite('b');
    t.recordWrite('c');
    expect(t.getTrackedTables()).toEqual(['a', 'b', 'c']);
  });
});
