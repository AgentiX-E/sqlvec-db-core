/**
 * ParseCache unit tests.
 *
 * Verifies SQL literal normalization, template-keyed cache retrieval, LRU
 * eviction at capacity, and store lifecycle (per-name clear + clear-all).
 * These tests target the exact normalization regex behavior so that a subtle
 * change in placeholder substitution is caught immediately.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeSql,
  cacheGet,
  cacheSet,
  cacheClear,
  cacheClearAll,
} from '../utils/ParseCache';

describe('normalizeSql', () => {
  it('replaces integer literals with `?`', () => {
    expect(normalizeSql('SELECT 1')).toBe('SELECT ?');
    expect(normalizeSql('WHERE id = 42')).toBe('WHERE id = ?');
  });

  it('replaces negative and decimal literals with `?`', () => {
    expect(normalizeSql('SELECT -3.14')).toBe('SELECT ?');
    expect(normalizeSql('x = -0.5')).toBe('x = ?');
  });

  it('replaces scientific notation literals', () => {
    expect(normalizeSql('x = 1e10')).toBe('x = ?');
    expect(normalizeSql('x = 1.5E-3')).toBe('x = ?');
  });

  it('replaces single-quoted string literals (including escaped quotes)', () => {
    expect(normalizeSql("name = 'alice'")).toBe("name = '?'");
    expect(normalizeSql("name = 'it''s'")).toBe("name = '?'");
  });

  it('replaces dollar-quoted string literals', () => {
    expect(normalizeSql('body = $$hello$$')).toBe('body = ?');
    expect(normalizeSql('body = $tag$hi there$tag$')).toBe('body = ?');
    expect(normalizeSql('body = $func$x$func$')).toBe('body = ?');
  });

  it('replaces boolean literals case-insensitively', () => {
    expect(normalizeSql('WHERE flag = true')).toBe('WHERE flag = ?');
    expect(normalizeSql('WHERE flag = FALSE')).toBe('WHERE flag = ?');
  });

  it('replaces NULL literals case-insensitively', () => {
    expect(normalizeSql('WHERE x IS NULL')).toBe('WHERE x IS ?');
    expect(normalizeSql('WHERE x IS null')).toBe('WHERE x IS ?');
  });

  it('collapses whitespace-separated placeholders into one', () => {
    // The final `.replace(/\?\s*\?/g, '?')` merges placeholders separated only
    // by whitespace, e.g. `?  ?` → `?`. Comma-separated placeholders `?, ?`
    // remain distinct (they are separate expressions, not a redundant pair).
    expect(normalizeSql('SELECT 1  2')).toBe('SELECT ?');
    expect(normalizeSql('VALUES (1, 2)')).toBe('VALUES (?, ?)');
  });

  it('does not alter identifiers that contain digits mid-token', () => {
    expect(normalizeSql('SELECT col2 FROM t1')).toBe('SELECT col2 FROM t1');
  });

  it('does not replace a digit inside a parenthesized keyword context', () => {
    // Leading digits preceded by `(` are normalized; ensure the boundary works.
    expect(normalizeSql('(1)')).toBe('(?)');
  });
});

describe('ParseCache store', () => {
  beforeEach(() => {
    cacheClearAll();
  });

  it('returns undefined on a cache miss', () => {
    expect(cacheGet('tpl', 'SELECT 1')).toBeUndefined();
  });

  it('stores and retrieves a value by normalized template', () => {
    cacheSet('tpl', 'SELECT id FROM t WHERE id = 1', { plan: 'seq' });
    // A different literal yields the same template and hits the cache.
    expect(cacheGet('tpl', 'SELECT id FROM t WHERE id = 2')).toEqual({ plan: 'seq' });
  });

  it('uses distinct stores for distinct cache names', () => {
    cacheSet('a', 'SELECT 1', 'A');
    cacheSet('b', 'SELECT 1', 'B');
    expect(cacheGet('a', 'SELECT 1')).toBe('A');
    expect(cacheGet('b', 'SELECT 1')).toBe('B');
  });

  it('evicts the oldest entry when the cache reaches capacity', () => {
    // Each entry must map to a *distinct* normalized template. Literal values
    // (numbers/strings) are normalized away, so we vary the identifier to
    // guarantee 600 distinct keys and force LRU eviction past capacity 512.
    for (let i = 0; i < 600; i++) {
      cacheSet('big', `SELECT col_${i} FROM t`, i);
    }
    // The very first key should have been evicted.
    expect(cacheGet('big', 'SELECT col_0 FROM t')).toBeUndefined();
    // A recent key should still be present.
    expect(cacheGet('big', 'SELECT col_599 FROM t')).toBe(599);
  });

  it('cacheClear removes only the named store', () => {
    cacheSet('keep', 'SELECT 1', 'KEEP');
    cacheSet('drop', 'SELECT 1', 'DROP');
    cacheClear('drop');
    expect(cacheGet('drop', 'SELECT 1')).toBeUndefined();
    expect(cacheGet('keep', 'SELECT 1')).toBe('KEEP');
  });

  it('cacheClearAll removes every store', () => {
    cacheSet('a', 'SELECT 1', 1);
    cacheSet('b', 'SELECT 1', 2);
    cacheClearAll();
    expect(cacheGet('a', 'SELECT 1')).toBeUndefined();
    expect(cacheGet('b', 'SELECT 1')).toBeUndefined();
  });
});
