import { describe, it, expect } from 'vitest';
import {
  detectGIN,
  rewriteGINIndex,
  rewriteArrayContains,
  rewriteArrayOverlaps,
  GINIndexRuntime,
} from '../index/GINIndexShim';

// GINIndexShim translates PostgreSQL `USING GIN` indexes to an FTS5 inverted
// index plus sync triggers, and rewrites array `@>` / `&&` predicates to an
// FTS5 MATCH subquery. GINIndexRuntime is an in-memory rbush inverted index
// for key/key-value lookups. Tests lock both halves.
describe('GINIndexShim', () => {
  describe('detectGIN', () => {
    it('detects USING GIN', () => {
      expect(detectGIN('CREATE INDEX i ON t USING GIN (c)')).toBe(true);
    });

    it('detects USING GIN case-insensitively', () => {
      expect(detectGIN('CREATE INDEX i ON t using gin (c)')).toBe(true);
    });

    it('does not detect a non-GIN index', () => {
      expect(detectGIN('CREATE INDEX i ON t USING btree (c)')).toBe(false);
    });

    it('does not detect GIN as a substring of another word', () => {
      expect(detectGIN('CREATE INDEX i ON t USING GINST (c)')).toBe(false);
    });
  });

  describe('rewriteGINIndex', () => {
    it('returns not_gin unchanged when no USING GIN', () => {
      const r = rewriteGINIndex('CREATE INDEX i ON t USING btree (c)');
      expect(r.rewritten).toBe(false);
      expect(r.strategy).toBe('not_gin');
      expect(r.sql).toBe('CREATE INDEX i ON t USING btree (c)');
    });

    it('rewrites a basic single-column GIN index to FTS5', () => {
      const r = rewriteGINIndex('CREATE INDEX idx ON t USING GIN (col)');
      expect(r.rewritten).toBe(true);
      expect(r.strategy).toBe('fts5_inverted');
      expect(r.ftsTableName).toBe('__gin_idx');
      expect(r.sql).toContain("CREATE VIRTUAL TABLE __gin_idx USING fts5(col");
      expect(r.sql).toContain("content='t'");
      expect(r.sql).toContain('INSERT INTO __gin_idx(rowid, col) VALUES (new.rowid, new.col)');
      expect(r.sql).toContain("VALUES ('delete', old.rowid, old.col)");
      expect(r.sql).toContain('SELECT rowid, col FROM t;');
    });

    // BUG: schema-qualified table must not be truncated to the schema name.
    it('preserves a schema-qualified table name', () => {
      const r = rewriteGINIndex('CREATE INDEX idx ON schema.t USING GIN (col)');
      expect(r.sql).toContain("content='schema.t'");
      expect(r.sql).toContain('ON schema.t');
      expect(r.sql).toContain('FROM schema.t;');
    });

    // BUG: every column in a multi-column index must get the new./old. prefix.
    it('qualifies every column in a multi-column index trigger', () => {
      const r = rewriteGINIndex('CREATE INDEX idx ON t USING GIN (col1, col2)');
      expect(r.sql).toContain('VALUES (new.rowid, new.col1, new.col2)');
      expect(r.sql).toContain("VALUES ('delete', old.rowid, old.col1, old.col2)");
      expect(r.sql).toContain('AFTER UPDATE OF col1, col2');
      expect(r.sql).toContain('INSERT INTO __gin_idx(rowid, col1, col2) SELECT rowid, col1, col2 FROM t;');
    });

    it('strips UNIQUE and IF NOT EXISTS modifiers', () => {
      const r1 = rewriteGINIndex('CREATE UNIQUE INDEX idx ON t USING GIN (col)');
      expect(r1.sql).toContain('__gin_idx');
      const r2 = rewriteGINIndex('CREATE INDEX IF NOT EXISTS idx ON t USING GIN (col)');
      expect(r2.sql).toContain('__gin_idx');
    });

    it('strips quoting from index and table names', () => {
      const r = rewriteGINIndex('CREATE INDEX "idx" ON "t" USING GIN ("col")');
      expect(r.ftsTableName).toBe('__gin_idx');
      expect(r.sql).toContain('content=\'t\'');
    });

    it('falls back to gin_unknown when table cannot be extracted', () => {
      const r = rewriteGINIndex('CREATE INDEX idx USING GIN (col)');
      expect(r.rewritten).toBe(true);
      expect(r.strategy).toBe('gin_unknown');
      expect(r.sql).not.toContain('USING GIN');
    });

    it('falls back to gin_unknown when column cannot be extracted', () => {
      const r = rewriteGINIndex('CREATE INDEX idx ON t USING GIN');
      expect(r.strategy).toBe('gin_unknown');
      expect(r.sql).not.toContain('USING GIN');
    });
  });

  describe('rewriteArrayContains', () => {
    it('rewrites an unqualified column to a bare rowid subquery', () => {
      const r = rewriteArrayContains("SELECT * FROM products WHERE arr_col @> ARRAY['foo','bar']", '__gin_idx');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe(
        "SELECT * FROM products WHERE rowid IN (SELECT rowid FROM __gin_idx WHERE __gin_idx MATCH '\"foo\" \"bar\"')",
      );
    });

    it('rewrites an alias-qualified column with the alias prefix', () => {
      const r = rewriteArrayContains("SELECT * FROM products p WHERE p.arr_col @> ARRAY['foo']", '__gin_idx');
      expect(r.sql).toContain('p.rowid IN');
    });

    it('escapes double quotes in literals', () => {
      const r = rewriteArrayContains(`SELECT * FROM t WHERE c @> ARRAY['a"b']`, '__gin_idx');
      expect(r.sql).toContain(`MATCH '"a""b"'`);
    });

    it('returns unchanged when no @> predicate exists', () => {
      const sql = 'SELECT * FROM t WHERE c = 1';
      const r = rewriteArrayContains(sql, '__gin_idx');
      expect(r.rewritten).toBe(false);
      expect(r.sql).toBe(sql);
    });
  });

  describe('rewriteArrayOverlaps', () => {
    it('rewrites with OR-joined tokens', () => {
      const r = rewriteArrayOverlaps("SELECT * FROM products WHERE arr_col && ARRAY['foo','bar']", '__gin_idx');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain(`MATCH '"foo" OR "bar"'`);
    });

    it('rewrites an alias-qualified column', () => {
      const r = rewriteArrayOverlaps("SELECT * FROM products p WHERE p.arr_col && ARRAY['foo']", '__gin_idx');
      expect(r.sql).toContain('p.rowid IN');
    });

    it('returns unchanged when no && predicate exists', () => {
      const sql = 'SELECT * FROM t WHERE c = 1';
      const r = rewriteArrayOverlaps(sql, '__gin_idx');
      expect(r.rewritten).toBe(false);
      expect(r.sql).toBe(sql);
    });
  });

  describe('GINIndexRuntime.parseJSONB', () => {
    it('flattens an object into key/value entries', () => {
      const m = GINIndexRuntime.parseJSONB('{"a":1,"b":"x"}');
      expect(m.get('a')).toBe('1');
      expect(m.get('b')).toBe('x');
    });

    it('flattens an array into index/key entries', () => {
      const m = GINIndexRuntime.parseJSONB('["a","b"]');
      expect(m.get('0')).toBe('a');
      expect(m.get('a')).toBe('a');
      expect(m.get('1')).toBe('b');
    });

    it('treats invalid JSON as a single plain-text key', () => {
      const m = GINIndexRuntime.parseJSONB('not json');
      expect(m.get('not json')).toBe('not json');
    });

    it('returns an empty map for a primitive that is not object/array', () => {
      const m = GINIndexRuntime.parseJSONB('42');
      expect(m.size).toBe(0);
    });
  });

  describe('GINIndexRuntime.parseArray', () => {
    it('parses ARRAY[...] syntax', () => {
      expect(GINIndexRuntime.parseArray("ARRAY['a','b','c']")).toEqual(['a', 'b', 'c']);
    });

    it('parses brace syntax', () => {
      expect(GINIndexRuntime.parseArray('{a,b,c}')).toEqual(['a', 'b', 'c']);
    });

    it('parses raw comma-separated values', () => {
      expect(GINIndexRuntime.parseArray('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('strips surrounding quotes', () => {
      expect(GINIndexRuntime.parseArray("ARRAY['a']")).toEqual(['a']);
    });
  });

  describe('GINIndexRuntime.parseTsvector', () => {
    it('strips positions and weights', () => {
      expect(GINIndexRuntime.parseTsvector('cat:3 dog:5')).toEqual(['cat', 'dog']);
    });

    it('splits plain lexemes', () => {
      expect(GINIndexRuntime.parseTsvector('a b c')).toEqual(['a', 'b', 'c']);
    });

    it('returns empty for blank input', () => {
      expect(GINIndexRuntime.parseTsvector('   ')).toEqual([]);
    });
  });

  describe('GINIndexRuntime (jsonb)', () => {
    it('inserts keys and supports ? key-exists search', () => {
      const g = new GINIndexRuntime('jsonb');
      g.insert(1, '{"a":1,"b":"x"}');
      expect(g.search('?', 'a')).toEqual([1]);
      expect(g.search('?', 'b')).toEqual([1]);
      expect(g.search('?', 'zzz')).toEqual([]);
      expect(g.getSize()).toBe(1);
      expect(g.getKeys()).toContain('a');
      expect(g.hasKey('a')).toBe(true);
    });

    it('supports @> contains search', () => {
      const g = new GINIndexRuntime('jsonb');
      g.insert(1, '{"a":1,"b":"x"}');
      g.insert(2, '{"a":1}');
      expect(g.search('@>', '{"a":1}').sort()).toEqual([1, 2]);
      expect(g.search('@>', '{"a":1,"b":"x"}')).toEqual([1]);
      expect(g.search('@>', '{"a":1,"b":"y"}')).toEqual([]);
    });

    it('matches all rows for an empty @> query', () => {
      const g = new GINIndexRuntime('jsonb');
      g.insert(1, '{"a":1}');
      g.insert(2, '{"b":2}');
      expect(g.search('@>', '{}').sort()).toEqual([1, 2]);
    });

    it('supports ?| and ?& key-set searches', () => {
      const g = new GINIndexRuntime('jsonb');
      g.insert(1, '{"a":1,"b":2}');
      g.insert(2, '{"a":1}');
      expect(g.search('?|', ['a', 'c']).sort()).toEqual([1, 2]);
      expect(g.search('?&', ['a', 'b'])).toEqual([1]);
      expect(g.search('?&', ['a', 'c'])).toEqual([]);
      expect(g.search('?&', 'a,b')).toEqual([1]);
      expect(g.search('?&', [])).toEqual([]);
    });

    it('removes a row and its keys', () => {
      const g = new GINIndexRuntime('jsonb');
      g.insert(1, '{"a":1}');
      g.remove(1, '{"a":1}');
      expect(g.search('?', 'a')).toEqual([]);
      expect(g.getSize()).toBe(0);
      expect(g.hasKey('a')).toBe(false);
    });

    it('keeps a shared key when one of several rows is removed', () => {
      const g = new GINIndexRuntime('jsonb');
      g.insert(1, '{"a":1}');
      g.insert(2, '{"a":1}');
      g.remove(1, '{"a":1}');
      // key 'a' and kv 'a:1' survive because row 2 still holds them
      expect(g.search('?', 'a')).toEqual([2]);
      expect(g.search('@>', '{"a":1}')).toEqual([2]);
      expect(g.getSize()).toBe(1);
    });

    it('ignores insert/remove for null values', () => {
      const g = new GINIndexRuntime('jsonb');
      g.insert(1, null);
      g.insert(2, undefined);
      expect(g.getSize()).toBe(0);
      g.remove(1, null);
      expect(g.getSize()).toBe(0);
    });

    it('returns empty for unknown operators and exact match', () => {
      const g = new GINIndexRuntime('jsonb');
      g.insert(1, '{"a":1}');
      expect(g.search('unknown', 'a')).toEqual([]);
      expect(g.search('=', 'a')).toEqual([]); // fallback is empty for non-simple
    });
  });

  describe('GINIndexRuntime (array)', () => {
    it('indexes array elements for key search', () => {
      const g = new GINIndexRuntime('array');
      g.insert(1, '{foo,bar}');
      expect(g.search('?', 'foo')).toEqual([1]);
      expect(g.search('?', 'bar')).toEqual([1]);
    });

    it('supports @> on array elements', () => {
      const g = new GINIndexRuntime('array');
      g.insert(1, '{foo,bar}');
      g.insert(2, '{foo}');
      expect(g.search('@>', '["foo"]').sort()).toEqual([1, 2]);
    });

    it('supports @> with a JS array, PG array, and brace-list query', () => {
      const g = new GINIndexRuntime('array');
      g.insert(1, '{foo,bar}');
      g.insert(2, '{foo}');
      expect(g.search('@>', ['foo']).sort()).toEqual([1, 2]);
      expect(g.search('@>', "ARRAY['foo']").sort()).toEqual([1, 2]);
      expect(g.search('@>', '{foo}').sort()).toEqual([1, 2]);
    });

    it('returns all rows for an empty @> array query', () => {
      const g = new GINIndexRuntime('array');
      g.insert(1, '{foo}');
      g.insert(2, '{bar}');
      expect(g.search('@>', '[]').sort()).toEqual([1, 2]);
    });

    it('intersects multiple @> elements', () => {
      const g = new GINIndexRuntime('array');
      g.insert(1, '{foo,bar}');
      g.insert(2, '{foo}');
      g.insert(3, '{foo,bar,baz}');
      expect(g.search('@>', ['foo', 'bar']).sort()).toEqual([1, 3]);
      expect(g.search('@>', ['foo', 'bar', 'baz'])).toEqual([3]);
    });

    it('handles a non-array non-string @> query value', () => {
      const g = new GINIndexRuntime('array');
      g.insert(1, '{42,x}');
      expect(g.search('@>', 42)).toEqual([1]);
    });

    it('returns empty when a queried @> element is absent', () => {
      const g = new GINIndexRuntime('array');
      g.insert(1, '{foo}');
      expect(g.search('@>', ['foo', 'nope'])).toEqual([]);
    });
  });

  describe('GINIndexRuntime (jsonb additional)', () => {
    it('supports @> with an object query', () => {
      const g = new GINIndexRuntime('jsonb');
      g.insert(1, '{"a":1,"b":"x"}');
      g.insert(2, '{"a":1}');
      expect(g.search('@>', { a: 1 }).sort()).toEqual([1, 2]);
    });

    it('supports ?| with a comma-separated string query', () => {
      const g = new GINIndexRuntime('jsonb');
      g.insert(1, '{"a":1}');
      g.insert(2, '{"b":2}');
      expect(g.search('?|', 'a,b').sort()).toEqual([1, 2]);
    });
  });

  describe('GINIndexRuntime (tsvector)', () => {
    it('indexes lexemes as keys', () => {
      const g = new GINIndexRuntime('tsvector');
      g.insert(1, 'cat:3 dog:5');
      expect(g.search('?', 'cat')).toEqual([1]);
      expect(g.search('?', 'dog')).toEqual([1]);
    });

    it('removes lexemes on remove', () => {
      const g = new GINIndexRuntime('tsvector');
      g.insert(1, 'cat:3');
      g.remove(1, 'cat:3');
      expect(g.search('?', 'cat')).toEqual([]);
    });
  });

  describe('GINIndexRuntime (simple)', () => {
    it('uses the fallback map for exact match', () => {
      const g = new GINIndexRuntime('simple');
      g.insert(1, 'foo');
      g.insert(2, 'bar');
      expect(g.search('=', 'foo')).toEqual([1]);
      expect(g.search('?', 'foo')).toEqual([1]);
      expect(g.getSize()).toBe(2);
    });

    it('removes from the fallback map', () => {
      const g = new GINIndexRuntime('simple');
      g.insert(1, 'foo');
      g.remove(1, 'foo');
      expect(g.search('=', 'foo')).toEqual([]);
      expect(g.getSize()).toBe(0);
    });

    it('deduplicates repeated fallback values and no-ops on unknown remove', () => {
      const g = new GINIndexRuntime('simple');
      g.insert(1, 'foo');
      g.insert(2, 'foo');
      expect(g.search('=', 'foo').sort()).toEqual([1, 2]);
      g.remove(3, 'nope'); // value not present → no change
      expect(g.getSize()).toBe(2);
    });

    it('keeps a shared fallback value when one row is removed', () => {
      const g = new GINIndexRuntime('simple');
      g.insert(1, 'foo');
      g.insert(2, 'foo');
      g.remove(1, 'foo');
      expect(g.search('=', 'foo')).toEqual([2]);
      expect(g.getSize()).toBe(1);
    });
  });

  describe('GINIndexRuntime.clear', () => {
    it('clears all state', () => {
      const g = new GINIndexRuntime('jsonb');
      g.insert(1, '{"a":1}');
      g.clear();
      expect(g.getSize()).toBe(0);
      expect(g.getKeys()).toEqual([]);
      expect(g.hasKey('a')).toBe(false);
      expect(g.search('?', 'a')).toEqual([]);
    });
  });
});
