/**
 * query-cache-shim.test.ts — Coverage tests for QueryCacheShim
 * (PostgreSQL query-cache compatibility shim for SQLite).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PGliteEvalResult } from '../query/PGliteEngine';
import { PgCatalog } from '../system/PgCatalog';
import {
  extractPgPrewarmOid,
  resolveOidToTable,
  extractPgPrewarmFirstArg,
  detectQueryCache,
  rewriteQueryCache,
  QueryCacheShim,
} from '../query/QueryCacheShim';

function result(rows: any[] = []): PGliteEvalResult {
  return { columns: [], rows };
}

// ──────────────────────────────────────────────
//  extractPgPrewarmOid
// ──────────────────────────────────────────────

describe('extractPgPrewarmOid', () => {
  it('extracts numeric oid', () => {
    expect(extractPgPrewarmOid('SELECT pg_prewarm(16384)')).toBe(16384);
  });

  it('extracts quoted numeric oid', () => {
    expect(extractPgPrewarmOid("SELECT pg_prewarm('16384')")).toBe(16384);
  });

  it('extracts oid with second arg', () => {
    expect(extractPgPrewarmOid("SELECT pg_prewarm(16384, 'buffer')")).toBe(16384);
  });

  it('extracts oid with trailing semicolon', () => {
    expect(extractPgPrewarmOid('SELECT pg_prewarm(16384);')).toBe(16384);
  });

  it('returns null for table name (non-numeric)', () => {
    expect(extractPgPrewarmOid("SELECT pg_prewarm('my_table')")).toBeNull();
  });

  it('returns null for table name with second arg', () => {
    expect(extractPgPrewarmOid("SELECT pg_prewarm('my_table', 'buffer')")).toBeNull();
  });

  it('returns null for non-prewarm SQL', () => {
    expect(extractPgPrewarmOid('SELECT 1')).toBeNull();
    expect(extractPgPrewarmOid('')).toBeNull();
  });
});

// ──────────────────────────────────────────────
//  resolveOidToTable
// ──────────────────────────────────────────────

describe('resolveOidToTable', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves oid to table name (relkind r)', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([
      { oid: 16384, relname: 'users', relkind: 'r' },
      { oid: 16385, relname: 'users_idx', relkind: 'i' },
    ]);
    expect(resolveOidToTable(16384)).toBe('users');
  });

  it('returns null for non-relkind-r (index)', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([
      { oid: 16385, relname: 'users_idx', relkind: 'i' },
    ]);
    expect(resolveOidToTable(16385)).toBeNull();
  });

  it('returns null for oid not found', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([
      { oid: 16384, relname: 'users', relkind: 'r' },
    ]);
    expect(resolveOidToTable(99999)).toBeNull();
  });

  it('returns null when getClassRows throws', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockImplementation(() => {
      throw new Error('catalog unavailable');
    });
    expect(resolveOidToTable(16384)).toBeNull();
  });
});

// ──────────────────────────────────────────────
//  extractPgPrewarmFirstArg
// ──────────────────────────────────────────────

describe('extractPgPrewarmFirstArg', () => {
  it('extracts quoted table name', () => {
    expect(extractPgPrewarmFirstArg("SELECT pg_prewarm('my_table')")).toBe('my_table');
  });

  it('extracts quoted table name with second arg', () => {
    expect(extractPgPrewarmFirstArg("SELECT pg_prewarm('my_table', 'buffer')")).toBe(
      'my_table',
    );
  });

  it('extracts numeric arg (unquoted)', () => {
    expect(extractPgPrewarmFirstArg('SELECT pg_prewarm(16384)')).toBe('16384');
  });

  it('returns null for non-prewarm SQL', () => {
    expect(extractPgPrewarmFirstArg('SELECT 1')).toBeNull();
    expect(extractPgPrewarmFirstArg('')).toBeNull();
  });
});

// ──────────────────────────────────────────────
//  detectQueryCache
// ──────────────────────────────────────────────

describe('detectQueryCache', () => {
  it('returns false for non-string / empty', () => {
    expect(detectQueryCache(undefined as any)).toBe(false);
    expect(detectQueryCache('')).toBe(false);
    expect(detectQueryCache('   ')).toBe(false);
  });

  it('returns false for non-cache SQL', () => {
    expect(detectQueryCache('SELECT * FROM users')).toBe(false);
    expect(detectQueryCache('CREATE TABLE t (id int)')).toBe(false);
    expect(detectQueryCache('INSERT INTO t VALUES (1)')).toBe(false);
  });

  it.each([
    'SET enable_plan_cache = on',
    'SET enable_plan_cache = off',
    'SET enable_plan_cache TO on',
    'SET SESSION enable_plan_cache = on',
    'SET LOCAL enable_plan_cache = off',
  ])('returns true for SET plan cache: %s', (sql) => {
    expect(detectQueryCache(sql)).toBe(true);
  });

  it('returns true for SHOW plan_cache_mode', () => {
    expect(detectQueryCache('SHOW plan_cache_mode')).toBe(true);
    expect(detectQueryCache('SHOW plan_cache_mode;')).toBe(true);
  });

  it.each([
    "SELECT pg_prewarm('t')",
    "SELECT pg_prewarm('my_table', 'buffer')",
    'SELECT pg_catalog.pg_prewarm(16384)',
    "select pg_prewarm('t')",
  ])('returns true for pg_prewarm: %s', (sql) => {
    expect(detectQueryCache(sql)).toBe(true);
  });

  it('returns false for SET without enable_plan_cache (fast path)', () => {
    expect(detectQueryCache('SET search_path = public')).toBe(false);
  });

  it('returns false for SELECT without pg_prewarm (fast path)', () => {
    expect(detectQueryCache('SELECT now()')).toBe(false);
  });

  it('returns false when pg_prewarm is not the top-level function', () => {
    // hasPrewarm fast-path matches the substring, but PG_PREWARM_PATTERN
    // requires pg_prewarm to be the first function after SELECT.
    expect(detectQueryCache('SELECT x.pg_prewarm(1)')).toBe(false);
    expect(detectQueryCache('SELECT pg_prewarm(1) FROM t')).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  rewriteQueryCache
// ──────────────────────────────────────────────

describe('rewriteQueryCache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns pass-through for non-string / empty', () => {
    expect(rewriteQueryCache(undefined as any)).toEqual({
      sql: '',
      rewritten: false,
    });
    expect(rewriteQueryCache('')).toEqual({ sql: '', rewritten: false });
  });

  it.each([
    ['SET enable_plan_cache = on', 'SELECT 1'],
    ['SET enable_plan_cache = off', 'SELECT 1'],
    ['SET enable_plan_cache TO on', 'SELECT 1'],
    ['SET SESSION enable_plan_cache = on', 'SELECT 1'],
    ['SET LOCAL enable_plan_cache = off', 'SELECT 1'],
  ])('rewrites SET plan cache: %s', (sql, expected) => {
    expect(rewriteQueryCache(sql)).toEqual({ sql: expected, rewritten: true });
  });

  it('rewrites SHOW plan_cache_mode', () => {
    expect(rewriteQueryCache('SHOW plan_cache_mode')).toEqual({
      sql: "SELECT 'auto' as plan_cache_mode",
      rewritten: true,
    });
  });

  it('rewrites pg_prewarm with oid → SELECT COUNT(*)', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([
      { oid: 16384, relname: 'users', relkind: 'r' },
    ]);
    expect(rewriteQueryCache('SELECT pg_prewarm(16384)')).toEqual({
      sql: 'SELECT COUNT(*) FROM "users"',
      rewritten: true,
    });
  });

  it('rewrites pg_prewarm with quoted oid → SELECT COUNT(*)', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([
      { oid: 16384, relname: 'orders', relkind: 'r' },
    ]);
    expect(rewriteQueryCache("SELECT pg_prewarm('16384')")).toEqual({
      sql: 'SELECT COUNT(*) FROM "orders"',
      rewritten: true,
    });
  });

  it('rewrites pg_prewarm with reserved-word table name (quoted)', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([
      { oid: 100, relname: 'order', relkind: 'r' },
    ]);
    expect(rewriteQueryCache('SELECT pg_prewarm(100)')).toEqual({
      sql: 'SELECT COUNT(*) FROM "order"',
      rewritten: true,
    });
  });

  it('pg_prewarm oid not found → fallback SELECT 1', () => {
    vi.spyOn(PgCatalog, 'getClassRows').mockReturnValue([]);
    expect(rewriteQueryCache('SELECT pg_prewarm(99999)')).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });

  it('pg_prewarm table name (non-oid) → SELECT COUNT(*)', () => {
    expect(rewriteQueryCache("SELECT pg_prewarm('users')")).toEqual({
      sql: 'SELECT COUNT(*) FROM "users"',
      rewritten: true,
    });
  });

  it('pg_prewarm table name with second arg → SELECT COUNT(*)', () => {
    expect(rewriteQueryCache("SELECT pg_prewarm('users', 'buffer')")).toEqual({
      sql: 'SELECT COUNT(*) FROM "users"',
      rewritten: true,
    });
  });

  it('pg_prewarm with non-identifier table name → SELECT 1', () => {
    // A table name with special chars fails the identifier regex.
    expect(rewriteQueryCache("SELECT pg_prewarm('my table')")).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });

  it('passes through non-cache SQL', () => {
    expect(rewriteQueryCache('SELECT * FROM users')).toEqual({
      sql: 'SELECT * FROM users',
      rewritten: false,
    });
  });
});

// ──────────────────────────────────────────────
//  QueryCacheShim class
// ──────────────────────────────────────────────

describe('QueryCacheShim', () => {
  let cache: QueryCacheShim;
  beforeEach(() => {
    cache = new QueryCacheShim();
  });

  it('defaults to enabled with maxSize 100', () => {
    expect(cache.enabled).toBe(true);
    expect(cache.getMaxSize()).toBe(100);
    expect(cache.size()).toBe(0);
  });

  it('constructor accepts custom maxSize', () => {
    const c = new QueryCacheShim(3);
    expect(c.getMaxSize()).toBe(3);
  });

  it('enabled setter disables and clears cache', () => {
    cache.set('k', result([[1]]));
    expect(cache.size()).toBe(1);
    cache.enabled = false;
    expect(cache.enabled).toBe(false);
    expect(cache.size()).toBe(0);
    cache.enabled = true;
    expect(cache.enabled).toBe(true);
  });

  it('get returns null when disabled', () => {
    cache.enabled = false;
    cache.set('k', result());
    expect(cache.get('k')).toBeNull();
  });

  it('set is a no-op when disabled', () => {
    cache.enabled = false;
    cache.set('k', result([[1]]));
    expect(cache.size()).toBe(0);
  });

  it('get returns null for missing key', () => {
    expect(cache.get('missing')).toBeNull();
  });

  it('set + get round-trips result', () => {
    const r = result([[1, 'a']]);
    cache.set('k', r);
    expect(cache.get('k')).toEqual(r);
  });

  it('get with TTL: expired entry returns null and deletes', () => {
    const r = result([[1]]);
    cache.set('k', r);
    // Negative TTL → any elapsed time (>=0) is > ttlMs, so always expired.
    expect(cache.get('k', -1)).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('get with future TTL returns cached entry', () => {
    const r = result([[1]]);
    cache.set('k', r);
    expect(cache.get('k', 60_000)).toEqual(r);
  });

  it('set with existing key re-inserts to tail (no duplicate)', () => {
    cache.set('k', result([[1]]));
    cache.set('k', result([[2]]));
    expect(cache.size()).toBe(1);
    expect(cache.get('k')).toEqual(result([[2]]));
  });

  it('LRU eviction at capacity', () => {
    const c = new QueryCacheShim(2);
    c.set('a', result([[1]]));
    c.set('b', result([[2]]));
    c.set('c', result([[3]])); // evicts 'a' (LRU)
    expect(c.size()).toBe(2);
    expect(c.get('a')).toBeNull();
    expect(c.get('b')).not.toBeNull();
    expect(c.get('c')).not.toBeNull();
  });

  it('get re-orders entries (recently used survive eviction)', () => {
    const c = new QueryCacheShim(2);
    c.set('a', result([[1]]));
    c.set('b', result([[2]]));
    c.get('a'); // 'a' now most recently used
    c.set('c', result([[3]])); // evicts 'b' (now LRU)
    expect(c.get('a')).not.toBeNull();
    expect(c.get('b')).toBeNull();
  });

  it('invalidate removes entries involving a table (case-insensitive)', () => {
    cache.set('k1', result([[1]]), ['Users']);
    cache.set('k2', result([[2]]), ['Orders']);
    cache.set('k3', result([[3]]), ['Other']);
    cache.invalidate('users');
    expect(cache.get('k1')).toBeNull();
    expect(cache.get('k2')).not.toBeNull();
    expect(cache.get('k3')).not.toBeNull();
  });

  it('invalidate with no matching table does nothing', () => {
    cache.set('k1', result([[1]]), ['Users']);
    cache.invalidate('nothing');
    expect(cache.get('k1')).not.toBeNull();
  });

  it('clear empties the cache', () => {
    cache.set('a', result([[1]]));
    cache.set('b', result([[2]]));
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('setMaxSize clamps below 1', () => {
    cache.setMaxSize(0);
    expect(cache.getMaxSize()).toBe(1);
  });

  it('setMaxSize evicts LRU entries when shrinking', () => {
    cache.set('a', result([[1]]));
    cache.set('b', result([[2]]));
    cache.set('c', result([[3]]));
    cache.setMaxSize(2);
    expect(cache.size()).toBe(2);
    expect(cache.get('a')).toBeNull(); // LRU evicted first
  });

  it('setMaxSize grows without eviction', () => {
    cache.set('a', result([[1]]));
    cache.setMaxSize(200);
    expect(cache.getMaxSize()).toBe(200);
    expect(cache.size()).toBe(1);
  });
});
