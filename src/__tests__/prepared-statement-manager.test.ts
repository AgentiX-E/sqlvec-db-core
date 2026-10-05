import { describe, it, expect, beforeEach } from 'vitest';
import { PreparedStatementManager } from '../query/PreparedStatementManager';

/**
 * PreparedStatementManager — PREPARE/EXECUTE/DEALLOCATE lifecycle and LRU cache.
 *
 * Tests target real behavior including positional-parameter substitution
 * (single- and multi-digit placeholders), type escaping, duplicate rejection,
 * LRU eviction, and the case-insensitive name contract.
 */

let m: PreparedStatementManager;

beforeEach(() => {
  m = new PreparedStatementManager(10);
});

describe('prepare / get / has / list', () => {
  it('prepares and retrieves a statement (case-insensitive name)', () => {
    m.prepare('MyStmt', 'SELECT * FROM t WHERE a = $1', ['int']);
    expect(m.has('mystmt')).toBe(true);
    expect(m.has('MYSTMT')).toBe(true);
    expect(m.get('mystmt')?.sql).toBe('SELECT * FROM t WHERE a = $1');
    expect(m.get('mystmt')?.paramTypes).toEqual(['int']);
  });

  it('throws when preparing a duplicate name', () => {
    m.prepare('s1', 'SELECT 1', []);
    expect(() => m.prepare('S1', 'SELECT 2', [])).toThrow(/already exists/);
  });

  it('lists all prepared statement names', () => {
    m.prepare('b', 'SELECT 1', []);
    m.prepare('a', 'SELECT 2', []);
    expect(m.list().sort()).toEqual(['a', 'b']);
  });

  it('has() returns false for an unknown name', () => {
    expect(m.has('nope')).toBe(false);
  });

  it('get() returns undefined for an unknown name', () => {
    expect(m.get('nope')).toBeUndefined();
  });
});

describe('execute', () => {
  it('substitutes a single placeholder', () => {
    m.prepare('s', 'SELECT * FROM t WHERE a = $1', ['int']);
    expect(m.execute('s', ['x']).sql).toBe("SELECT * FROM t WHERE a = 'x'");
  });

  it('substitutes repeated placeholders', () => {
    m.prepare('s', 'SELECT * FROM t WHERE a = $1 OR b = $1', ['int']);
    expect(m.execute('s', ['z']).sql).toBe("SELECT * FROM t WHERE a = 'z' OR b = 'z'");
  });

  it('substitutes a multi-digit placeholder ($10) correctly', () => {
    m.prepare('s', 'SELECT * FROM t WHERE a = $1 AND b = $10', [
      'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int',
    ]);
    const sql = m.execute('s', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']).sql;
    expect(sql).toBe("SELECT * FROM t WHERE a = 'a' AND b = 'j'");
  });

  it('does not corrupt $1 when $10 is present', () => {
    m.prepare('s', 'SELECT $1 * $10', [
      'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int',
    ]);
    const sql = m.execute('s', [2, 3, 4, 5, 6, 7, 8, 9, 10, 100]).sql;
    expect(sql).toBe('SELECT 2 * 100');
  });

  it('throws when the parameter count mismatches the highest placeholder index', () => {
    m.prepare('s', 'SELECT * FROM t WHERE a = $1 AND b = $10', [
      'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int',
    ]);
    expect(() => m.execute('s', ['only', 'two'])).toThrow(/expects 10 parameters/);
  });

  it('throws when executing an unknown statement', () => {
    expect(() => m.execute('nope', [])).toThrow(/not found/);
  });

  it('returns the original params alongside the substituted SQL', () => {
    m.prepare('s', 'SELECT $1', ['int']);
    const params = [42];
    const r = m.execute('s', params);
    expect(r.params).toBe(params);
  });

  it('marks the statement as recently used (affects LRU order)', () => {
    m.prepare('a', 'SELECT 1', []);
    m.prepare('b', 'SELECT 2', []);
    m.execute('a', []); // a is now most recently used
    const evicted = m.evict(1);
    expect(evicted).toEqual(['b']); // b is least recently used
  });
});

describe('escapeParam value types', () => {
  const cases: Array<[any, string]> = [
    [null, 'NULL'],
    [undefined, 'NULL'],
    [true, 'TRUE'],
    [false, 'FALSE'],
    [42, '42'],
    [42.5, '42.5'],
    [123n, '123'],
    ['plain', "'plain'"],
    ["O'Brien", "'O''Brien'"],
    [new Date('2026-01-01T00:00:00.000Z'), "'2026-01-01T00:00:00.000Z'"],
    [[1, 2, 3], "'[1,2,3]'"],
    [{ a: 1 }, "'{\"a\":1}'"],
  ];

  for (const [value, expected] of cases) {
    const label = typeof value === 'bigint' ? `${value}n` : JSON.stringify(value);
    it(`escapes ${label} to ${expected}`, () => {
      m.prepare('s', 'SELECT $1', ['x']);
      expect(m.execute('s', [value]).sql).toBe(`SELECT ${expected}`);
    });
  }
});

describe('deallocate', () => {
  it('deallocates a specific statement', () => {
    m.prepare('s', 'SELECT 1', []);
    expect(m.deallocate('s')).toBe(true);
    expect(m.has('s')).toBe(false);
  });

  it('returns false when deallocating an unknown statement', () => {
    expect(m.deallocate('nope')).toBe(false);
  });

  it('deallocates all statements (case-insensitive ALL)', () => {
    m.prepare('a', 'SELECT 1', []);
    m.prepare('b', 'SELECT 2', []);
    expect(m.deallocate('ALL')).toBe(true);
    expect(m.getCacheSize()).toBe(0);
  });

  it('returns false when DEALLOCATE ALL on an empty cache', () => {
    expect(m.deallocate('ALL')).toBe(false);
  });
});

describe('clear / clearCache / getStats', () => {
  it('clears all statements', () => {
    m.prepare('a', 'SELECT 1', []);
    m.clear();
    expect(m.getCacheSize()).toBe(0);
  });

  it('clearCache returns false when empty, true when non-empty', () => {
    expect(m.clearCache()).toBe(false);
    m.prepare('a', 'SELECT 1', []);
    expect(m.clearCache()).toBe(true);
  });

  it('getStats returns count and names', () => {
    m.prepare('a', 'SELECT 1', []);
    m.prepare('b', 'SELECT 2', []);
    const stats = m.getStats();
    expect(stats.count).toBe(2);
    expect(stats.names.sort()).toEqual(['a', 'b']);
  });
});

describe('LRU cache', () => {
  it('evicts the least recently used statement when at capacity', () => {
    const small = new PreparedStatementManager(2);
    small.prepare('a', 'SELECT 1', []);
    small.prepare('b', 'SELECT 2', []);
    small.prepare('c', 'SELECT 3', []); // evicts a
    expect(small.has('a')).toBe(false);
    expect(small.has('b')).toBe(true);
    expect(small.has('c')).toBe(true);
  });

  it('evict returns an empty array for count <= 0', () => {
    m.prepare('a', 'SELECT 1', []);
    expect(m.evict(0)).toEqual([]);
    expect(m.evict(-1)).toEqual([]);
  });

  it('evict returns an empty array when the cache is empty (positive count)', () => {
    expect(m.evict(5)).toEqual([]);
  });

  it('warns via the capacity path when the cache exceeds 80% full', () => {
    const small = new PreparedStatementManager(10);
    // The 10th prepare brings the pre-insert size to 9/10 = 90% (> 80%).
    for (let i = 0; i < 10; i++) {
      small.prepare(`s${i}`, 'SELECT 1', []);
    }
    expect(small.getCacheSize()).toBe(10);
  });

  it('evict removes exactly N oldest entries', () => {
    m.prepare('a', 'SELECT 1', []);
    m.prepare('b', 'SELECT 2', []);
    m.prepare('c', 'SELECT 3', []);
    expect(m.evict(2).sort()).toEqual(['a', 'b']);
    expect(m.getCacheSize()).toBe(1);
  });

  it('getCacheSize / getCacheMax report state', () => {
    m.prepare('a', 'SELECT 1', []);
    expect(m.getCacheSize()).toBe(1);
    expect(m.getCacheMax()).toBe(10);
  });

  it('setCacheMax shrinks the cache by evicting oldest entries', () => {
    m.prepare('a', 'SELECT 1', []);
    m.prepare('b', 'SELECT 2', []);
    m.prepare('c', 'SELECT 3', []);
    m.setCacheMax(1);
    expect(m.getCacheSize()).toBe(1);
    expect(m.has('c')).toBe(true); // most recent survives
  });

  it('setCacheMax rejects a max below 1', () => {
    expect(() => m.setCacheMax(0)).toThrow(/at least 1/);
  });

  it('setCacheMax grows the cache without eviction', () => {
    m.prepare('a', 'SELECT 1', []);
    m.setCacheMax(1000);
    expect(m.getCacheMax()).toBe(1000);
    expect(m.getCacheSize()).toBe(1);
  });
});
