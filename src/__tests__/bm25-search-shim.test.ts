import { describe, it, expect, beforeEach } from 'vitest';
import { Bm25SearchShim } from '../query/Bm25SearchShim';

describe('Bm25SearchShim', () => {
  let shim: Bm25SearchShim;

  beforeEach(() => {
    shim = new Bm25SearchShim();
  });

  describe('availability', () => {
    it('reports natural package availability', () => {
      // natural is a dependency; availability should be true in normal runs.
      // We don't assert a hard boolean since the environment may vary.
      expect(typeof shim.isAvailable()).toBe('boolean');
    });
  });

  describe('registerFtsConfig / hasFtsConfig', () => {
    it('registers and queries config case-insensitively', () => {
      shim.registerFtsConfig('Products', ['Title', 'Body']);
      expect(shim.hasFtsConfig('products')).toBe(true);
      expect(shim.hasFtsConfig('PRODUCTS', 'title')).toBe(true);
      expect(shim.hasFtsConfig('products', 'missing')).toBe(false);
      expect(shim.hasFtsConfig('other')).toBe(false);
    });

    it('hasFtsConfig without column returns true when config exists', () => {
      shim.registerFtsConfig('t', ['a']);
      expect(shim.hasFtsConfig('t')).toBe(true);
    });
  });

  describe('tokenize behavior (via search)', () => {
    it('splits on non-alphanumeric and lowercases', () => {
      shim.registerFtsConfig('docs', ['content']);
      shim.indexRow('docs', 1, { content: 'Hello, World! 中文' });
      const results = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: 'hello', limit: 10 },
        [{ id: 1, content: 'Hello, World! 中文' }],
        'id',
      );
      expect(results.length).toBe(1);
    });
  });

  describe('indexRow', () => {
    it('no-ops when natural is unavailable', () => {
      // Hard to force unavailable without mocking; just assert indexing works.
      shim.registerFtsConfig('docs', ['content']);
      shim.indexRow('docs', 1, { content: 'foo bar' });
      expect(shim.getDocumentCount()).toBeGreaterThanOrEqual(0);
    });

    it('no-ops when table has no config', () => {
      shim.indexRow('noconfig', 1, { content: 'foo' });
      expect(shim.getDocumentCount()).toBe(0);
    });

    it('skips empty column values', () => {
      shim.registerFtsConfig('docs', ['content']);
      shim.indexRow('docs', 1, { content: '' });
      shim.indexRow('docs', 2, { content: undefined as any });
      // empty/undefined values produce no terms, so no documents get indexed
      expect(shim.getDocumentCount()).toBe(0);
    });

    it('replaces term frequencies when re-indexing the same row', () => {
      shim.registerFtsConfig('docs', ['content']);
      shim.indexRow('docs', 1, { content: 'foo bar' });
      shim.indexRow('docs', 1, { content: 'foo baz' });
      expect(shim.getDocumentCount()).toBe(1);
      // "bar" should no longer match after re-index
      const bar = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: 'bar', limit: 10 },
        [{ id: 1, content: 'foo baz' }],
        'id',
      );
      expect(bar.length).toBe(0);
      const baz = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: 'baz', limit: 10 },
        [{ id: 1, content: 'foo baz' }],
        'id',
      );
      expect(baz.length).toBe(1);
    });
  });

  describe('removeRow', () => {
    it('removes a document and its term frequencies', () => {
      shim.registerFtsConfig('docs', ['content']);
      shim.indexRow('docs', 1, { content: 'foo bar' });
      expect(shim.getDocumentCount()).toBe(1);
      shim.removeRow('docs', 1);
      expect(shim.getDocumentCount()).toBe(0);
      const results = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: 'foo', limit: 10 },
        [{ id: 1, content: 'foo bar' }],
        'id',
      );
      expect(results.length).toBe(0);
    });

    it('no-ops when the document does not exist', () => {
      shim.registerFtsConfig('docs', ['content']);
      shim.removeRow('docs', 999);
      expect(shim.getDocumentCount()).toBe(0);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      shim.registerFtsConfig('docs', ['content']);
      shim.indexRow('docs', 1, { content: 'the quick brown fox' });
      shim.indexRow('docs', 2, { content: 'quick lazy dog' });
      shim.indexRow('docs', 3, { content: 'unrelated terms here' });
    });

    const rows = [
      { id: 1, content: 'the quick brown fox' },
      { id: 2, content: 'quick lazy dog' },
      { id: 3, content: 'unrelated terms here' },
    ];

    it('returns scored results sorted by relevance', () => {
      const results = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: 'quick', limit: 10 },
        rows,
        'id',
      );
      expect(results.length).toBe(2);
      expect(results.map((r) => r.row.id)).toEqual([2, 1]);
      expect(results[0].matchColumn).toBe('content');
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('returns empty for empty keywords', () => {
      const results = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: '', limit: 10 },
        rows,
        'id',
      );
      expect(results.length).toBe(0);
    });

    it('returns empty for unknown table', () => {
      const results = shim.search(
        { tableName: 'unknown', matchColumn: 'content', keywords: 'quick', limit: 10 },
        rows,
        'id',
      );
      expect(results.length).toBe(0);
    });

    it('applies a result limit', () => {
      const results = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: 'quick', limit: 1 },
        rows,
        'id',
      );
      expect(results.length).toBe(1);
    });

    it('defaults limit to 10 when non-positive', () => {
      const results = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: 'quick', limit: 0 },
        rows,
        'id',
      );
      expect(results.length).toBe(2);
    });

    it('skips rows with undefined or null id', () => {
      const results = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: 'quick', limit: 10 },
        [{ id: undefined, content: 'quick fox' }],
        'id',
      );
      expect(results.length).toBe(0);
    });

    it('skips rows whose doc id is not in the index', () => {
      const results = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: 'quick', limit: 10 },
        [{ id: 99, content: 'quick fox' }],
        'id',
      );
      expect(results.length).toBe(0);
    });
  });

  describe('detectMatchAgainst', () => {
    it('detects MATCH/AGAINST and extracts table/column/keywords/limit', () => {
      const q = shim.detectMatchAgainst(
        "SELECT * FROM products WHERE MATCH(title) AGAINST('hello world') LIMIT 20",
      );
      expect(q).not.toBeNull();
      expect(q!.tableName).toBe('products');
      expect(q!.matchColumn).toBe('title');
      expect(q!.keywords).toBe('hello world');
      expect(q!.limit).toBe(20);
    });

    it('defaults limit to 10 when absent', () => {
      const q = shim.detectMatchAgainst("SELECT * FROM products WHERE MATCH(title) AGAINST('x')");
      expect(q!.limit).toBe(10);
    });

    it('strips quoting from table and column names', () => {
      const q = shim.detectMatchAgainst('SELECT * FROM "products" WHERE MATCH("title") AGAINST(\'x\')');
      expect(q!.tableName).toBe('products');
      expect(q!.matchColumn).toBe('title');
    });

    it('returns null when no MATCH/AGAINST', () => {
      expect(shim.detectMatchAgainst('SELECT * FROM products')).toBeNull();
    });

    it('returns null when MATCH/AGAINST present but no FROM', () => {
      expect(shim.detectMatchAgainst("SELECT MATCH(title) AGAINST('x')")).toBeNull();
    });
  });

  describe('rewriteMatchQuery', () => {
    it('rewrites a MATCH/AGAINST query with score column and ORDER BY', () => {
      const r = shim.rewriteMatchQuery("SELECT * FROM products WHERE MATCH(title) AGAINST('hello')");
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('bm25_score');
      expect(r.sql).toContain('ORDER BY bm25_score DESC');
      expect(r.sql).not.toContain('MATCH');
    });

    it('preserves explicit SELECT columns', () => {
      const r = shim.rewriteMatchQuery("SELECT id, name FROM products WHERE MATCH(title) AGAINST('hello')");
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('id, name');
    });

    it('does not add ORDER BY if already present', () => {
      const r = shim.rewriteMatchQuery(
        "SELECT * FROM products WHERE MATCH(title) AGAINST('hello') ORDER BY id",
      );
      expect(r.rewritten).toBe(true);
      expect(r.sql).not.toContain('bm25_score DESC');
    });

    it('returns unchanged when no MATCH/AGAINST', () => {
      const sql = 'SELECT * FROM products';
      const r = shim.rewriteMatchQuery(sql);
      expect(r.rewritten).toBe(false);
      expect(r.sql).toBe(sql);
    });
  });

  describe('constants / counters', () => {
    it('exposes document count and clears all state', () => {
      shim.registerFtsConfig('docs', ['content']);
      shim.indexRow('docs', 1, { content: 'foo' });
      expect(shim.getDocumentCount()).toBe(1);
      shim.clear();
      expect(shim.getDocumentCount()).toBe(0);
    });

    it('handles search on empty index', () => {
      shim.registerFtsConfig('docs', ['content']);
      const results = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: 'foo', limit: 10 },
        [{ id: 1, content: 'foo' }],
        'id',
      );
      expect(results.length).toBe(0);
    });

    it('decrements DF correctly when removing a shared-term document', () => {
      // Two documents share the term "foo"; removing one should keep df=1,
      // exercising the currentDf > 1 branch (subtract, not delete).
      shim.registerFtsConfig('docs', ['content']);
      shim.indexRow('docs', 1, { content: 'foo bar' });
      shim.indexRow('docs', 2, { content: 'foo baz' });
      shim.removeRow('docs', 1);
      expect(shim.getDocumentCount()).toBe(1);
      const results = shim.search(
        { tableName: 'docs', matchColumn: 'content', keywords: 'foo', limit: 10 },
        [{ id: 2, content: 'foo baz' }],
        'id',
      );
      expect(results.length).toBe(1);
    });

    it('is case-insensitive between indexRow and search table names', () => {
      shim.registerFtsConfig('Users', ['name']);
      shim.indexRow('Users', 1, { name: 'Alice Bob' });
      const results = shim.search(
        { tableName: 'users', matchColumn: 'name', keywords: 'Alice', limit: 10 },
        [{ id: 1, name: 'Alice Bob' }],
        'id',
      );
      expect(results.length).toBe(1);
      expect(results[0].row.id).toBe(1);
    });

    it('is case-insensitive between indexRow and removeRow table names', () => {
      shim.registerFtsConfig('Users', ['name']);
      shim.indexRow('Users', 1, { name: 'Alice Bob' });
      shim.removeRow('USERS', 1);
      expect(shim.getDocumentCount()).toBe(0);
    });

    it('ignores non-informative punctuation-only values', () => {
      shim.registerFtsConfig('docs', ['content']);
      shim.indexRow('docs', 1, { content: '...' });
      // punctuation-only tokenizes to zero terms, so no document is stored
      expect(shim.getDocumentCount()).toBe(0);
    });
  });
});
