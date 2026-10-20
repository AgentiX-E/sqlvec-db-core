/**
 * query-cache-shim.test.ts — Coverage tests for QueryCacheShim
 * (PG plan-cache / pg_prewarm shim + LRU query result cache).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractPgPrewarmOid,
  resolveOidToTable,
  extractPgPrewarmFirstArg,
  detectQueryCache,
  rewriteQueryCache,
  QueryCacheShim,
} from '../query/QueryCacheShim';
import { PgCatalog } from '../system/PgCatalog';
import type { PGliteEvalResult } from '../query/PGliteEngine';

function result(rows: number[][] = []): PGliteEvalResult {
  return { columns: ['a'], rows };
}

describe('extractPgPrewarmOid', () => {
  it('extracts numeric oid', () => {
    expect(extractPgPrewarmOid('SELECT pg_prewarm(16384)')).toBe(16384);
    expect(extractPgPrewarmOid('SELECT pg_prewarm(16384);')).toBe(16384);
  });

  it('extracts quoted numeric oid', () => {
    expect(extractPgPrewarmOid("SELECT pg_prewarm('16384')")).toBe(16384);
  });

  it('returns null for table name (non-numeric)', () => {
    expect(extractPgPrewarmOid("SELECT pg_prewarm('my_table')")).toBeNull();
    expect(extractPgPrewarmOid("SELECT pg_prewarm('my_table', 'buffer')")).toBeNull();
  });

  it('returns null for non-prewarm SQL', () => {
    expect(extractPgPrewarmOid('SELECT 1')).toBeNull();
  });
});

describe('resolveOidToTable', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves oid to a regular-table relname', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([
      { oid: 5, relname: 't1', relkind: 'r' },
      { oid: 6, relname: 'v1', relkind: 'v' },
    ]);
    expect(resolveOidToTable(5)).toBe('t1');
  });

  it('returns null when oid is a non-table relkind', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([
      { oid: 6, relname: 'v1', relkind: 'v' },
    ]);
    expect(resolveOidToTable(6)).toBeNull();
  });

  it('returns null when oid not found', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([
      { oid: 1, relname: 't1', relkind: 'r' },
    ]);
    expect(resolveOidToTable(999)).toBeNull();
  });

  it('returns null when getClassRows throws', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(resolveOidToTable(1)).toBeNull();
  });
});

describe('extractPgPrewarmFirstArg', () => {
  it('extracts quoted table name', () => {
    expect(extractPgPrewarmFirstArg("SELECT pg_prewarm('my_table')")).toBe('my_table');
    expect(extractPgPrewarmFirstArg("SELECT pg_prewarm('my_table', 'buffer')")).toBe('my_table');
  });

  it('extracts unquoted numeric arg', () => {
    expect(extractPgPrewarmFirstArg('SELECT pg_prewarm(16384)')).toBe('16384');
  });

  it('returns null for unknown form', () => {
    expect(extractPgPrewarmFirstArg('SELECT 1')).toBeNull();
    expect(extractPgPrewarmFirstArg("SELECT pg_prewarm('weird name!')")).toBe('weird name!');
  });
});

describe('detectQueryCache', () => {
  it('returns false for non-string / empty', () => {
    expect(detectQueryCache(undefined as unknown as string)).toBe(false);
    expect(detectQueryCache('')).toBe(false);
    expect(detectQueryCache('   ')).toBe(false);
  });

  it('detects SET enable_plan_cache (all variants)', () => {
    expect(detectQueryCache('SET enable_plan_cache = on')).toBe(true);
    expect(detectQueryCache('SET enable_plan_cache = off')).toBe(true);
    expect(detectQueryCache('SET enable_plan_cache TO on')).toBe(true);
    expect(detectQueryCache('SET SESSION enable_plan_cache = on')).toBe(true);
    expect(detectQueryCache('SET LOCAL enable_plan_cache = off')).toBe(true);
  });

  it('detects SHOW plan_cache_mode', () => {
    expect(detectQueryCache('SHOW plan_cache_mode')).toBe(true);
    expect(detectQueryCache('SHOW plan_cache_mode;')).toBe(true);
  });

  it('detects SELECT pg_prewarm', () => {
    expect(detectQueryCache("SELECT pg_prewarm('t')")).toBe(true);
    expect(detectQueryCache("SELECT pg_catalog.pg_prewarm('t')")).toBe(true);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectQueryCache('SELECT 1')).toBe(false);
    expect(detectQueryCache('CREATE TABLE t (id int)')).toBe(false);
  });

  it('fast-path rejects keyword-only matches without full pattern', () => {
    // Has SET prefix and enable_plan_cache, but not a complete valid statement
    expect(detectQueryCache('SET enable_plan_cache = maybe')).toBe(false);
  });
});

describe('rewriteQueryCache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes through non-string / empty with rewritten false', () => {
    expect(rewriteQueryCache(undefined as unknown as string)).toEqual({
      sql: '',
      rewritten: false,
    });
    expect(rewriteQueryCache('')).toEqual({ sql: '', rewritten: false });
  });

  it('rewrites SET enable_plan_cache → SELECT 1', () => {
    expect(rewriteQueryCache('SET enable_plan_cache = on')).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });

  it('rewrites SHOW plan_cache_mode → SELECT auto literal', () => {
    expect(rewriteQueryCache('SHOW plan_cache_mode')).toEqual({
      sql: "SELECT 'auto' as plan_cache_mode",
      rewritten: true,
    });
  });

  it('rewrites pg_prewarm with resolvable numeric oid → COUNT', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([
      { oid: 16384, relname: 'orders', relkind: 'r' },
    ]);
    expect(rewriteQueryCache('SELECT pg_prewarm(16384)')).toEqual({
      sql: 'SELECT COUNT(*) FROM "orders"',
      rewritten: true,
    });
  });

  it('rewrites pg_prewarm with unresolvable oid → SELECT 1', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([]);
    expect(rewriteQueryCache('SELECT pg_prewarm(99999)')).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });

  it('rewrites pg_prewarm with valid table name → COUNT', () => {
    expect(rewriteQueryCache("SELECT pg_prewarm('orders')")).toEqual({
      sql: 'SELECT COUNT(*) FROM "orders"',
      rewritten: true,
    });
  });

  it('rewrites pg_prewarm with invalid table name → SELECT 1', () => {
    expect(rewriteQueryCache("SELECT pg_prewarm('bad name!')")).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });

  it('passes through unrelated SQL unchanged (no trailing handling)', () => {
    expect(rewriteQueryCache('SELECT * FROM users')).toEqual({
      sql: 'SELECT * FROM users',
      rewritten: false,
    });
  });
});

describe('QueryCacheShim — LRU cache', () => {
  it('constructs with default and custom max size', () => {
    expect(new QueryCacheShim().getMaxSize()).toBe(100);
    expect(new QueryCacheShim(5).getMaxSize()).toBe(5);
  });

  it('enabled defaults true and can be disabled (clearing cache)', () => {
    const c = new QueryCacheShim();
    expect(c.enabled).toBe(true);
    c.set('k', result());
    expect(c.size()).toBe(1);
    c.enabled = false;
    expect(c.enabled).toBe(false);
    expect(c.size()).toBe(0);
  });

  it('re-enabling does not clear cache (enabled setter truthy side)', () => {
    const c = new QueryCacheShim();
    c.enabled = false;
    c.enabled = true;
    expect(c.enabled).toBe(true);
    c.set('k', result());
    expect(c.size()).toBe(1);
  });

  it('set with maxSize 0 hits lruKey-undefined guard', () => {
    // Constructor does not clamp maxSize, so 0 is legal: size(0) >= maxSize(0),
    // and the LRU head is undefined on an empty map, exercising the false side.
    const c = new QueryCacheShim(0);
    c.set('a', result());
    expect(c.size()).toBe(1);
  });

  it('get returns null when disabled', () => {
    const c = new QueryCacheShim();
    c.set('k', result());
    c.enabled = false;
    expect(c.get('k')).toBeNull();
  });

  it('get returns null when not cached', () => {
    const c = new QueryCacheShim();
    expect(c.get('missing')).toBeNull();
  });

  it('get returns cached result and refreshes LRU order', () => {
    const c = new QueryCacheShim();
    const r = result([[1]]);
    c.set('k', r);
    expect(c.get('k')).toEqual(r);
  });

  it('get expires entry when TTL elapsed', () => {
    const c = new QueryCacheShim();
    c.set('k', result());
    // Simulate stale entry by passing a negative TTL
    expect(c.get('k', -1)).toBeNull();
    expect(c.size()).toBe(0); // expired entry removed
  });

  it('set no-op when disabled', () => {
    const c = new QueryCacheShim();
    c.enabled = false;
    c.set('k', result());
    expect(c.size()).toBe(0);
  });

  it('set evicts LRU entry when at capacity', () => {
    const c = new QueryCacheShim(2);
    c.set('a', result());
    c.set('b', result());
    c.set('c', result()); // evicts 'a'
    expect(c.size()).toBe(2);
    expect(c.get('a')).toBeNull();
    expect(c.get('b')).not.toBeNull();
    expect(c.get('c')).not.toBeNull();
  });

  it('set overwrites existing key by moving to tail', () => {
    const c = new QueryCacheShim(2);
    c.set('a', result([[1]]));
    c.set('b', result([[2]]));
    // Overwrite 'a' — re-insert at tail
    c.set('a', result([[3]]));
    expect(c.get('a')).toEqual(result([[3]]));
  });

  it('invalidate removes entries touching a table (case-insensitive)', () => {
    const c = new QueryCacheShim();
    c.set('k1', result(), ['Orders']);
    c.set('k2', result(), ['Users']);
    c.set('k3', result(), ['Orders', 'Users']);
    c.invalidate('orders');
    expect(c.size()).toBe(1); // only k2 (Users) remains
    expect(c.get('k2')).not.toBeNull();
  });

  it('invalidate no-op when no matching table', () => {
    const c = new QueryCacheShim();
    c.set('k1', result(), ['Users']);
    c.invalidate('orders');
    expect(c.size()).toBe(1);
  });

  it('clear empties cache', () => {
    const c = new QueryCacheShim();
    c.set('a', result());
    c.set('b', result());
    c.clear();
    expect(c.size()).toBe(0);
  });

  it('size returns entry count', () => {
    const c = new QueryCacheShim();
    expect(c.size()).toBe(0);
    c.set('a', result());
    c.set('b', result());
    expect(c.size()).toBe(2);
  });

  it('setMaxSize clamps values below 1 to 1', () => {
    const c = new QueryCacheShim();
    c.setMaxSize(0);
    expect(c.getMaxSize()).toBe(1);
    c.setMaxSize(-5);
    expect(c.getMaxSize()).toBe(1);
  });

  it('setMaxSize evicts LRU entries when shrinking', () => {
    const c = new QueryCacheShim();
    c.set('a', result());
    c.set('b', result());
    c.set('c', result());
    c.setMaxSize(1); // evict down to 1 (LRU first)
    expect(c.size()).toBe(1);
    expect(c.get('c')).not.toBeNull();
  });
});
