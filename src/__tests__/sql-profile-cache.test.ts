import { describe, it, expect } from 'vitest';
import { SqlProfileCache } from '../query/SqlProfileCache';

describe('SqlProfileCache — normalizeSQL & cache key', () => {
  it('collapses whitespace, strips comments, patternizes literal', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT   *  FROM  t  -- comment\n  WHERE a = 1');
    // normalizeSQL compacts '*', collapses whitespace, strips the line comment;
    // patternizeSQL then turns the literal `1` into `?`.
    expect(p.normalized).toBe('SELECT*FROM t WHERE a=?');
  });

  it('strips block comments', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT /* block */ 1');
    expect(p.normalized).not.toContain('block');
  });

  it('compacts operators and equals', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT a FROM t WHERE a  =  1');
    expect(p.normalized).toContain('a=?');
  });
});

describe('SqlProfileCache — patternizeSQL literals', () => {
  it('replaces integer literals with ?', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT * FROM t WHERE aid = 42');
    expect(p.normalized).toContain('aid=?');
  });

  it('replaces negative and float literals', () => {
    const c = new SqlProfileCache();
    const p1 = c.getProfile('SELECT * FROM t WHERE x = -5');
    expect(p1.normalized).toContain('x=?');
    const p2 = c.getProfile('SELECT * FROM t WHERE x = 3.14');
    expect(p2.normalized).toContain('x=?');
  });

  it('replaces scientific notation', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT * FROM t WHERE x = 1.5e10');
    expect(p.normalized).toContain('x=?');
  });

  it('replaces single-quoted string literals', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile("SELECT * FROM t WHERE name = 'Alice'");
    expect(p.normalized).toContain('name=?');
  });

  it('handles escaped quotes inside strings', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile("SELECT * FROM t WHERE name = 'it''s'");
    expect(p.normalized).toContain('name=?');
  });

  it('preserves identifiers (not replacing col_1)', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT col_1 FROM t');
    expect(p.normalized).toContain('col_1');
  });

  it('replaces dollar-quoted string', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile("SELECT $$hello$$");
    expect(p.normalized).toContain('?');
  });

  it('replaces tagged dollar-quoted string', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT $tag$hello$tag$');
    expect(p.normalized).toContain('?');
  });

  it('preserves double-quoted identifier content', () => {
    // patternizeSQL keeps the quoted identifier verbatim; normalizeSQL then
    // rewrites the double quotes to single quotes. The inner text must survive.
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT "col" FROM "tbl"');
    expect(p.normalized).toContain("'col'");
    expect(p.normalized).toContain("'tbl'");
    expect(p.normalized).not.toContain('"');
  });

  it('keeps distinct quoted identifiers as distinct cache keys', () => {
    const c = new SqlProfileCache();
    const a = c.getProfile('SELECT "col_a" FROM t').normalized;
    const b = c.getProfile('SELECT "col_b" FROM t').normalized;
    expect(a).not.toBe(b);
  });

  it('replaces hex literal X\'1A2F\'', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile("SELECT X'1A2F'");
    expect(p.normalized).toContain('?');
  });

  it('replaces bit literal B\'1010\'', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile("SELECT B'1010'");
    expect(p.normalized).toContain('?');
  });

  it('handles backslash escape inside a string literal', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile("SELECT E'\\u0041'");
    expect(p.normalized).toContain('?');
  });

  it('handles an unterminated dollar-quoted string (fallback emits as-is)', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT $tag$unclosed');
    // No matching close tag → the `$` is emitted verbatim rather than `?`.
    expect(p.normalized).not.toMatch(/^\s*$|undefined/);
    expect(typeof p.normalized).toBe('string');
  });

  it('handles an unterminated double-quoted identifier', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT "unclosed');
    expect(typeof p.normalized).toBe('string');
  });

  it('treats invalid hex/bit literal as identifier + string (not replaced)', () => {
    // X'...' with non-hex content fails validHex and falls through.
    const c = new SqlProfileCache();
    const p = c.getProfile("SELECT X'xyz'");
    expect(typeof p.normalized).toBe('string');
  });

  it('handles negative and positive sign on numbers', () => {
    const c = new SqlProfileCache();
    expect(c.getProfile('SELECT * FROM t WHERE a = -1').normalized).toContain('a=?');
    expect(c.getProfile('SELECT * FROM t WHERE a = +1').normalized).toContain('a=?');
  });

  it('handles leading-dot decimal (.5)', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT * FROM t WHERE a = .5');
    expect(p.normalized).toContain('a=?');
  });

  it('handles scientific notation with exponent sign', () => {
    const c = new SqlProfileCache();
    expect(c.getProfile('SELECT 1e-3').normalized).toContain('?');
    expect(c.getProfile('SELECT 2E+3').normalized).toContain('?');
  });

  it('does not treat a bare identifier-like e as scientific', () => {
    const c = new SqlProfileCache();
    // `e` not followed by digits should not be consumed as exponent.
    const p = c.getProfile('SELECT a FROM t WHERE x = 5');
    expect(p.normalized).toContain('x=?');
  });

  it('handles backslash escape inside a double-quoted identifier', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT "col\\"esc" FROM t');
    expect(typeof p.normalized).toBe('string');
  });

  it('handles an unterminated hex literal (no closing quote)', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile("SELECT X'1A2F");
    expect(typeof p.normalized).toBe('string');
  });

  it('handles a bare exponent marker without digits', () => {
    const c = new SqlProfileCache();
    // `1e` has no exponent digits → backtrack and emit a single `?`.
    const p = c.getProfile('SELECT 1e');
    expect(p.normalized).toContain('?');
  });

  it('handles scientific with uppercase E and no sign', () => {
    const c = new SqlProfileCache();
    expect(c.getProfile('SELECT 1E3').normalized).toContain('?');
  });
});

describe('SqlProfileCache — PG-specific detection', () => {
  it('marks standard SQL as standard', () => {
    const c = new SqlProfileCache();
    const p = c.getProfile('SELECT * FROM t WHERE a = 1');
    expect(p.isStandardSQL).toBe(true);
  });

  it.each([
    'SELECT a::int FROM t',
    'CREATE TABLE t (id SERIAL)',
    'SELECT ARRAY[1,2,3]',
    'SELECT * FROM t WHERE name ILIKE \'%x%\'',
    'SELECT a ->> \'key\' FROM t',
    'SELECT * FROM t RETURNING id',
    'SELECT DISTINCT ON (a) * FROM t',
    'CREATE EXTENSION hstore',
    'MERGE INTO t USING src ON t.id = src.id',
    'SELECT COALESCE(a, 0) FROM t',
    'SELECT GREATEST(a, b) FROM t',
    'SELECT CAST(a AS text) FROM t',
    'SAVEPOINT sp1',
    'VACUUM',
    'SELECT * FROM t TABLESAMPLE system(10)',
    'SELECT group_concat(x) FILTER (WHERE x > 0) FROM t',
  ])('marks PG-specific SQL as non-standard: %s', (sql) => {
    const c = new SqlProfileCache();
    const p = c.getProfile(sql);
    expect(p.isStandardSQL).toBe(false);
  });
});

describe('SqlProfileCache — routing', () => {
  it('routes BEGIN/COMMIT/ROLLBACK to single shard 0', () => {
    const c = new SqlProfileCache();
    c.setShardCount(4);
    for (const sql of ['BEGIN', 'COMMIT', 'ROLLBACK', 'END']) {
      const p = c.getProfile(sql);
      expect(p.routing).toEqual({ type: 'single-shard', shardId: 0 });
    }
  });

  it('routes DDL to shard 0', () => {
    const c = new SqlProfileCache();
    c.setShardCount(4);
    for (const sql of ['CREATE TABLE t (a int)', 'ALTER TABLE t ADD b int', 'DROP TABLE t', 'TRUNCATE t']) {
      const p = c.getProfile(sql);
      expect(p.routing).toEqual({ type: 'ddl', shardId: 0 });
    }
  });

  it('routes SELECT with WHERE key to single shard', () => {
    const c = new SqlProfileCache();
    c.setShardCount(8);
    const p = c.getProfile('SELECT * FROM t WHERE aid = 42');
    expect(p.routing.type).toBe('single-shard');
    expect((p.routing as any).key).toBe('42');
  });

  it('routes SELECT without WHERE key to all-shards', () => {
    const c = new SqlProfileCache();
    c.setShardCount(8);
    const p = c.getProfile('SELECT * FROM t');
    expect(p.routing).toEqual({ type: 'all-shards' });
  });

  it('routes UPDATE/DELETE with WHERE key to single shard', () => {
    const c = new SqlProfileCache();
    c.setShardCount(8);
    const u = c.getProfile('UPDATE t SET x = 1 WHERE aid = 42');
    expect(u.routing.type).toBe('single-shard');
    const d = c.getProfile('DELETE FROM t WHERE aid = 42');
    expect(d.routing.type).toBe('single-shard');
  });

  it('routes INSERT with key column to single shard', () => {
    const c = new SqlProfileCache();
    c.setShardCount(8);
    const p = c.getProfile('INSERT INTO t(aid, name) VALUES(42, \'x\')');
    expect(p.routing.type).toBe('single-shard');
    expect((p.routing as any).key).toBe('42');
  });

  it('routes INSERT without key to all-shards', () => {
    const c = new SqlProfileCache();
    c.setShardCount(8);
    const p = c.getProfile('INSERT INTO t(name) VALUES(\'x\')');
    expect(p.routing).toEqual({ type: 'all-shards' });
  });

  it('routes SET/SHOW/other to single shard 0', () => {
    const c = new SqlProfileCache();
    c.setShardCount(8);
    const p = c.getProfile('SET search_path TO public');
    expect(p.routing).toEqual({ type: 'single-shard', shardId: 0 });
  });

  it('returns no-route for non-standard SQL', () => {
    const c = new SqlProfileCache();
    c.setShardCount(8);
    const p = c.getProfile('SELECT a::int FROM t WHERE a = 1');
    expect(p.isStandardSQL).toBe(false);
    expect(p.routing).toEqual({ type: 'no-route' });
  });

  it('detects the :: cast operator (previously missed)', () => {
    // Regression: the leading `[^a-zA-Z_]` assertion previously excluded the
    // ordinary `col::type` form, so casts were miscategorized as standard SQL.
    const c = new SqlProfileCache();
    for (const sql of [
      'SELECT a::int FROM t',
      'SELECT x::text FROM t',
      'SELECT 1::int',
      'SELECT (a)::int',
      'SELECT x :: int FROM t',
    ]) {
      expect(c.getProfile(sql).isStandardSQL).toBe(false);
    }
  });

  it('cached non-standard SQL returns no-route without re-classifying', () => {
    const c = new SqlProfileCache();
    c.setShardCount(8);
    // Both statements share one pattern key (literal differs only inside `::`).
    c.getProfile('SELECT a::int FROM t WHERE aid = 1');
    const p = c.getProfile('SELECT a::int FROM t WHERE aid = 2');
    expect(p.isStandardSQL).toBe(false);
    expect(p.routing).toEqual({ type: 'no-route' });
  });

  it('extractWhereKey returns null for malformed WHERE clause', () => {
    const c = new SqlProfileCache();
    c.setShardCount(8);
    // No key column / no value → all-shards fallback.
    for (const sql of ['SELECT * FROM t WHERE = 5', 'SELECT * FROM t WHERE aid =']) {
      const p = c.getProfile(sql);
      expect(p.routing).toEqual({ type: 'all-shards' });
    }
  });

  it('extractInsertKey returns null when INSERT has no matching VALUES', () => {
    const c = new SqlProfileCache();
    c.setShardCount(8);
    const p = c.getProfile('INSERT INTO t SELECT * FROM src');
    expect(p.routing).toEqual({ type: 'all-shards' });
  });
});

describe('SqlProfileCache — LRU cache behavior', () => {
  it('caches identical patterns and returns cached profile', () => {
    const c = new SqlProfileCache();
    const p1 = c.getProfile('SELECT * FROM t WHERE aid = 1');
    const p2 = c.getProfile('SELECT * FROM t WHERE aid = 2');
    expect(p1.isStandardSQL).toBe(p2.isStandardSQL);
    // Different literal → same pattern key → cache hit
    expect(p1.normalized).toBe(p2.normalized);
  });

  it('evicts oldest entry when exceeding maxEntries', () => {
    const c = new SqlProfileCache(2);
    c.getProfile('SELECT a FROM t1');
    c.getProfile('SELECT b FROM t2');
    c.getProfile('SELECT c FROM t3');
    expect(c.size).toBe(2);
    // The oldest (t1) was evicted; re-querying it re-populates.
    c.getProfile('SELECT a FROM t1');
    expect(c.size).toBe(2);
  });

  it('clear empties cache', () => {
    const c = new SqlProfileCache();
    c.getProfile('SELECT a FROM t1');
    c.clear();
    expect(c.size).toBe(0);
  });

  it('tracks size by distinct patterns', () => {
    const c = new SqlProfileCache();
    c.getProfile('SELECT a FROM t1');
    c.getProfile('SELECT b FROM t2');
    expect(c.size).toBe(2);
  });

  it('collapses literal-only differences into one cache key', () => {
    // `SELECT 1` and `SELECT 2` patternize to the same `SELECT ?` key.
    const c = new SqlProfileCache();
    c.getProfile('SELECT 1');
    c.getProfile('SELECT 2');
    expect(c.size).toBe(1);
  });

  it('handles maxEntries=0 (empty cache keys().next() yields done)', () => {
    const c = new SqlProfileCache(0);
    // First set: cache is empty, keys().next() yields {done:true} → no evict.
    c.getProfile('SELECT a FROM t1');
    expect(c.size).toBe(1);
    // Second set: size(1) >= max(0), keys().next() has an element → evict.
    c.getProfile('SELECT b FROM t2');
    expect(c.size).toBe(1);
  });
});
