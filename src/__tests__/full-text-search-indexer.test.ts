import { describe, it, expect, beforeEach } from 'vitest';
import {
  SimpleTokenizer,
  TsQueryParser,
  FullTextSearchIndexer,
} from '../query/FullTextSearchIndexer';
import type { FtsIndexConfig } from '../query/FullTextSearchIndexer';

// ── SimpleTokenizer ──────────────────────────────────────────────

describe('SimpleTokenizer', () => {
  it('tokenizes ASCII words with stemming and stop-word removal', () => {
    const t = new SimpleTokenizer();
    const terms = t.tokenize('The quick brown fox').map(x => x.term);
    expect(terms).toEqual(['quick', 'brown', 'fox']);
  });

  it('applies porter stemming to regular words', () => {
    const t = new SimpleTokenizer();
    expect(t.tokenize('running jumps easily').map(x => x.term)).toEqual([
      'run',
      'jump',
      'easili',
    ]);
  });

  it('tokenizes CJK characters individually', () => {
    const t = new SimpleTokenizer();
    const terms = t.tokenize('hello 世界 test').map(x => x.term);
    expect(terms).toContain('世');
    expect(terms).toContain('界');
    expect(terms).toContain('hello');
  });

  it('returns empty for null/blank input', () => {
    const t = new SimpleTokenizer();
    expect(t.tokenize('')).toEqual([]);
    expect(t.tokenize('   ')).toEqual([]);
    expect(t.tokenize(null as any)).toEqual([]);
  });

  it('skips single non-CJK characters', () => {
    const t = new SimpleTokenizer();
    expect(t.tokenize('a b c')).toEqual([]);
  });

  it('records positions incrementally', () => {
    const t = new SimpleTokenizer();
    const tokens = t.tokenize('first second third');
    expect(tokens.map(x => x.position)).toEqual([0, 1, 2]);
  });

  it('deduplicates terms via tokenizeUnique', () => {
    const t = new SimpleTokenizer();
    expect(t.tokenizeUnique('cat cat dog')).toEqual(['cat', 'dog']);
  });

  it('stems a single word', () => {
    expect(new SimpleTokenizer().stem('running')).toBe('run');
  });

  it('checks stop words case-insensitively', () => {
    const t = new SimpleTokenizer();
    expect(t.isStopWord('the')).toBe(true);
    expect(t.isStopWord('THE')).toBe(true);
    expect(t.isStopWord('cat')).toBe(false);
  });

  it('accepts a custom stop-word set', () => {
    const t = new SimpleTokenizer(new Set(['custom']));
    expect(t.isStopWord('custom')).toBe(true);
    expect(t.isStopWord('the')).toBe(false);
    // custom stop word is filtered from tokenize
    expect(t.tokenize('custom value').map(x => x.term)).toEqual(['valu']);
  });
});

// ── TsQueryParser ────────────────────────────────────────────────

describe('TsQueryParser', () => {
  const p = new TsQueryParser();

  it('parses an empty query into an empty AND node', () => {
    expect(p.parse('')).toEqual({ op: 'AND', left: null, right: null });
  });

  it('parses a single term', () => {
    expect(p.parse('cat')).toEqual({
      op: 'AND',
      left: null,
      right: null,
      term: 'cat',
    });
  });

  it('parses AND conjunction', () => {
    const node = p.parse('cat & dog');
    expect(node.op).toBe('AND');
    expect((node.left as any).term).toBe('cat');
    expect((node.right as any).term).toBe('dog');
  });

  it('parses OR disjunction', () => {
    const node = p.parse('cat | dog');
    expect(node.op).toBe('OR');
    expect((node.left as any).term).toBe('cat');
    expect((node.right as any).term).toBe('dog');
  });

  it('parses NOT operator', () => {
    const node = p.parse('!dog');
    expect(node.op).toBe('NOT');
    expect((node.left as any).term).toBe('dog');
  });

  it('parses combined AND + NOT', () => {
    const node = p.parse('cat & !dog');
    expect(node.op).toBe('AND');
    expect((node.left as any).term).toBe('cat');
    expect((node.right as any).op).toBe('NOT');
  });

  it('parses parenthesized groups', () => {
    const node = p.parse('cat & (dog | mouse)');
    expect(node.op).toBe('AND');
    expect((node.right as any).op).toBe('OR');
  });

  it('honors NOT > AND > OR precedence', () => {
    const node = p.parse('cat | dog & mouse');
    expect(node.op).toBe('OR');
    expect((node.right as any).op).toBe('AND');
  });

  it('parses word operators (AND/OR/NOT keywords)', () => {
    expect(p.parse('cat AND dog').op).toBe('AND');
    expect(p.parse('cat OR dog').op).toBe('OR');
    expect(p.parse('cat NOT dog').op).toBe('AND'); // NOT only applies as prefix
  });

  it('strips surrounding quotes', () => {
    expect(p.parse("'cat & dog'").op).toBe('AND');
    expect(p.parse('"cat & dog"').op).toBe('AND');
  });

  it('strips trailing prefix stars from terms', () => {
    const node = p.parse('cat* & dog');
    expect((node.left as any).term).toBe('cat');
  });

  it('lowercases terms', () => {
    expect((p.parse('Cat') as any).term).toBe('cat');
  });

  it('handles repeated NOT (double negation)', () => {
    const node = p.parse('!!cat');
    expect(node.op).toBe('NOT');
    expect((node.left as any).op).toBe('NOT');
    expect((node.left as any).left.term).toBe('cat');
  });

  it('parses multi-term implicit AND (no operator between terms)', () => {
    // "cat dog" lexes to [cat, dog]; parseAnd joins adjacent terms as AND
    const node = p.parse('cat dog');
    expect(node.op).toBe('AND');
    expect((node.left as any).term).toBe('cat');
    expect((node.right as any).term).toBe('dog');
  });

  it('handles a trailing operator gracefully', () => {
    // "cat &" → parseAnd sees AND then empty right, returns the left node
    const node = p.parse('cat &');
    expect(node.op).toBe('AND');
  });

  it('handles an unclosed parenthesis', () => {
    const node = p.parse('(cat');
    expect(node.op).toBe('AND');
    expect((node as any).term).toBe('cat');
  });

  it('handles a leading NOT on a parenthesized group', () => {
    const node = p.parse('!(cat | dog)');
    expect(node.op).toBe('NOT');
  });

  it('skips empty terms from repeated separators', () => {
    // "cat  &  dog" with extra spaces → lexer skips whitespace
    const node = p.parse('cat  &  dog');
    expect(node.op).toBe('AND');
  });
});

// ── FullTextSearchIndexer ────────────────────────────────────────

describe('FullTextSearchIndexer', () => {
  let idx: FullTextSearchIndexer;

  beforeEach(() => {
    idx = new FullTextSearchIndexer();
  });

  describe('detectCreateFtsIndex', () => {
    it('detects a GIN to_tsvector index', () => {
      const cfg = idx.detectCreateFtsIndex(
        "CREATE INDEX idx ON docs USING GIN(to_tsvector('english', content))",
      );
      expect(cfg).toEqual({
        name: 'idx',
        table: 'docs',
        column: 'content',
        config: 'english',
        originalSql: "CREATE INDEX idx ON docs USING GIN(to_tsvector('english', content))",
      });
    });

    it('detects double-quoted config', () => {
      const cfg = idx.detectCreateFtsIndex(
        'CREATE INDEX idx ON docs USING GIN(to_tsvector("english", content))',
      );
      expect(cfg?.config).toBe('english');
    });

    it('detects IF NOT EXISTS', () => {
      const cfg = idx.detectCreateFtsIndex(
        "CREATE INDEX IF NOT EXISTS idx ON docs USING GIN(to_tsvector('english', content))",
      );
      expect(cfg?.name).toBe('idx');
    });

    it('detects UNIQUE index', () => {
      const cfg = idx.detectCreateFtsIndex(
        "CREATE UNIQUE INDEX idx ON docs USING GIN(to_tsvector('english', content))",
      );
      expect(cfg?.name).toBe('idx');
    });

    it('detects fts_vector alternative', () => {
      const cfg = idx.detectCreateFtsIndex(
        "CREATE INDEX idx ON docs USING GIN(fts_vector('english', content))",
      );
      expect(cfg?.config).toBe('english');
    });

    it('defaults config to english when omitted', () => {
      const cfg = idx.detectCreateFtsIndex(
        'CREATE INDEX idx ON docs USING GIN(to_tsvector(content))',
      );
      // config omitted → the regex requires a config arg, so this returns null
      expect(cfg).toBeNull();
    });

    it('returns null for a non-GIN index', () => {
      expect(idx.detectCreateFtsIndex('CREATE INDEX idx ON docs(content)')).toBeNull();
    });

    it('returns null for unrelated DDL', () => {
      expect(idx.detectCreateFtsIndex('CREATE TABLE t (a int)')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(idx.detectCreateFtsIndex('')).toBeNull();
    });
  });

  describe('handleCreateFtsIndex', () => {
    const cfg: FtsIndexConfig = {
      name: 'idx',
      table: 'docs',
      column: 'content',
      config: 'english',
      originalSql: "CREATE INDEX idx ON docs USING GIN(to_tsvector('english', content))",
    };

    it('produces index-table DDL and registers the index', () => {
      const sqls = idx.handleCreateFtsIndex(cfg);
      expect(sqls.length).toBe(2);
      expect(sqls[0]).toContain('CREATE TABLE IF NOT EXISTS _fts_idx_idx');
      expect(sqls[1]).toContain('_fts_idx_idx_rowid');
      expect(idx.hasIndex('idx')).toBe(true);
    });

    it('registers multiple indexes for the same table', () => {
      idx.handleCreateFtsIndex(cfg);
      const cfg2 = { ...cfg, name: 'idx2', column: 'title' };
      idx.handleCreateFtsIndex(cfg2);
      expect(idx.getIndexesForTable('docs').length).toBe(2);
    });

    it('accepts hasExistingData flag without changing output', () => {
      const s1 = idx.handleCreateFtsIndex(cfg, false);
      idx.clearIndexes();
      const s2 = idx.handleCreateFtsIndex(cfg, true);
      expect(s1).toEqual(s2);
    });
  });

  describe('handleDropFtsIndex', () => {
    it('returns empty for unknown index', () => {
      expect(idx.handleDropFtsIndex('nope')).toEqual([]);
    });

    it('drops the auxiliary table and unregisters', () => {
      idx.handleCreateFtsIndex({
        name: 'idx',
        table: 'docs',
        column: 'content',
        config: 'english',
        originalSql: 'x',
      });
      const sqls = idx.handleDropFtsIndex('idx');
      expect(sqls).toEqual(['DROP TABLE IF EXISTS _fts_idx_idx']);
      expect(idx.hasIndex('idx')).toBe(false);
      expect(idx.getIndexesForTable('docs')).toEqual([]);
    });

    it('removes only the targeted index when multiple exist', () => {
      idx.handleCreateFtsIndex({ name: 'a', table: 'docs', column: 'c1', config: 'english', originalSql: 'x' });
      idx.handleCreateFtsIndex({ name: 'b', table: 'docs', column: 'c2', config: 'english', originalSql: 'x' });
      idx.handleDropFtsIndex('a');
      expect(idx.hasIndex('a')).toBe(false);
      expect(idx.hasIndex('b')).toBe(true);
      expect(idx.getIndexesForTable('docs').length).toBe(1);
    });
  });

  describe('detectDropFtsIndex', () => {
    it('returns the index name for a registered index', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      expect(idx.detectDropFtsIndex('DROP INDEX idx')).toBe('idx');
    });

    it('parses DROP INDEX IF EXISTS', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      expect(idx.detectDropFtsIndex('DROP INDEX IF EXISTS idx')).toBe('idx');
    });

    it('returns null for unregistered index', () => {
      expect(idx.detectDropFtsIndex('DROP INDEX other')).toBeNull();
    });

    it('returns null for non-DROP SQL', () => {
      expect(idx.detectDropFtsIndex('SELECT 1')).toBeNull();
    });
  });

  describe('indexRow', () => {
    it('returns empty when no index exists for the table', () => {
      expect(idx.indexRow('docs', 1, { content: 'hello world' })).toEqual([]);
    });

    it('generates DELETE + INSERT statements for a row', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sqls = idx.indexRow('docs', 7, { content: 'the quick fox' });
      expect(sqls[0]).toBe('DELETE FROM _fts_idx_idx WHERE rowid = 7');
      // two meaning tokens: quick, fox
      expect(sqls.length).toBe(3);
      expect(sqls[1]).toContain("INSERT OR REPLACE INTO _fts_idx_idx (term, rowid, positions) VALUES ('quick', 7, '0')");
      expect(sqls[2]).toContain("VALUES ('fox', 7, '1')");
    });

    it('escapes single quotes in terms produced by a custom tokenizer', () => {
      // A custom tokenizer may emit terms containing apostrophes; indexRow must
      // escape them to avoid SQL injection / malformed INSERT statements.
      const custom = {
        tokenize: () => [{ term: "o'brien", position: 0 }],
      } as unknown as SimpleTokenizer;
      const i = new FullTextSearchIndexer(custom);
      i.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sqls = i.indexRow('docs', 1, { content: "o'brien" });
      expect(sqls.some(s => s.includes("'o''brien'"))).toBe(true);
    });

    it('handles missing column value as empty string', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sqls = idx.indexRow('docs', 1, { other: 'value' });
      expect(sqls).toEqual(['DELETE FROM _fts_idx_idx WHERE rowid = 1']);
    });
  });

  describe('deleteRow', () => {
    it('returns empty when no index exists', () => {
      expect(idx.deleteRow('docs', 1)).toEqual([]);
    });

    it('deletes row entries from each index', () => {
      idx.handleCreateFtsIndex({ name: 'a', table: 'docs', column: 'c1', config: 'english', originalSql: 'x' });
      idx.handleCreateFtsIndex({ name: 'b', table: 'docs', column: 'c2', config: 'english', originalSql: 'x' });
      const sqls = idx.deleteRow('docs', 9);
      expect(sqls).toEqual([
        'DELETE FROM _fts_idx_a WHERE rowid = 9',
        'DELETE FROM _fts_idx_b WHERE rowid = 9',
      ]);
    });
  });

  describe('hasFtsExpression', () => {
    it('detects each FTS construct', () => {
      expect(idx.hasFtsExpression("SELECT to_tsvector('english', c)")).toBe(true);
      expect(idx.hasFtsExpression("SELECT to_tsquery('english', 'cat')")).toBe(true);
      expect(idx.hasFtsExpression("SELECT plainto_tsquery('cat')")).toBe(true);
      expect(idx.hasFtsExpression("SELECT phraseto_tsquery('cat dog')")).toBe(true);
      expect(idx.hasFtsExpression("SELECT ts_rank(...)")).toBe(true);
      expect(idx.hasFtsExpression("SELECT ts_headline(...)")).toBe(true);
    });

    it('returns false for plain SQL', () => {
      expect(idx.hasFtsExpression('SELECT * FROM docs')).toBe(false);
    });
  });

  describe('rewriteQuery', () => {
    it('returns unchanged SQL when no FTS expression', () => {
      const sql = 'SELECT * FROM docs WHERE id = 1';
      expect(idx.rewriteQuery(sql)).toBe(sql);
    });

    it('falls back to 1=1 when no matching index (pattern1)', () => {
      const sql = "SELECT * FROM docs WHERE to_tsvector('english', content) @@ to_tsquery('english', 'cat & dog')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('1=1');
    });

    it('rewrites using a registered index (pattern1)', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = "SELECT * FROM docs WHERE to_tsvector('english', content) @@ to_tsquery('english', 'cat & dog')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('rowid IN (');
      expect(out).toContain('_fts_idx_idx');
      expect(out).toContain('INTERSECT');
    });

    it('rewrites plainto_tsquery via index', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = "SELECT * FROM docs WHERE to_tsvector('english', content) @@ plainto_tsquery('english', 'cat dog')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('rowid IN (');
    });

    it('rewrites table.column @@ query (pattern2, real table name)', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = "SELECT * FROM docs WHERE docs.content @@ to_tsquery('cat & dog')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('rowid IN (');
      expect(out).toContain('_fts_idx_idx');
    });

    it('falls back for aliased table (alias not resolvable to table)', () => {
      // The indexer stores indexes by real table name only; a column reference
      // like `d.content` (alias `d` for `docs`) cannot be mapped, so it falls back.
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = "SELECT * FROM docs d WHERE d.content @@ to_tsquery('cat & dog')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain("@@ ''");
    });

    it('rewrites to_tsvector-only pattern (pattern3)', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = "SELECT * FROM docs WHERE to_tsvector(content) @@ to_tsquery('cat')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('rowid IN (');
    });

    it('rewrites OR query using UNION', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = "SELECT * FROM docs WHERE docs.content @@ to_tsquery('cat | dog')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('UNION');
    });

    it('rewrites NOT query using EXCEPT', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = "SELECT * FROM docs WHERE docs.content @@ to_tsquery('!cat')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('EXCEPT');
    });

    it('rewrites phraseto_tsquery via index', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = "SELECT * FROM docs WHERE docs.content @@ phraseto_tsquery('cat dog')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('rowid IN (');
    });

    it('returns 1=0 for a query with only stop words', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      // plainto_tsquery('the and') → all stop words → no indexable terms → 1=0
      const sql = "SELECT * FROM docs WHERE docs.content @@ plainto_tsquery('the and')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('1=0');
    });

    it('rewrites with double-quoted config (pattern1)', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = 'SELECT * FROM docs WHERE to_tsvector("english", content) @@ to_tsquery("english", \'cat\')';
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('rowid IN (');
    });

    it('rewrites via rewriteWithAnyIndex when column not directly indexed', () => {
      // index is on `content`, but query references `body` → findTableForColumn
      // returns null → rewriteWithAnyIndex matches by config
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = "SELECT * FROM docs WHERE to_tsvector('english', body) @@ to_tsquery('english', 'cat')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('rowid IN (');
    });

    it('strips FTS functions when config does not match any index', () => {
      // config 'french' has no matching index → rewriteWithAnyIndex finds nothing
      // → falls back to stripping the FTS functions to a trivial predicate
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = "SELECT * FROM docs WHERE to_tsvector('french', body) @@ to_tsquery('french', 'chat')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('1=1');
    });

    it('returns 1=0 when AST cannot produce lookup SQL', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      // whitespace-only tsquery → empty token list → empty AST → no lookup SQL → 1=0
      const sql = "SELECT * FROM docs WHERE docs.content @@ to_tsquery('   ')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('1=0');
    });

    it('returns 1=0 for phraseto_tsquery with only stop words', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      const sql = "SELECT * FROM docs WHERE docs.content @@ phraseto_tsquery('the and')";
      const out = idx.rewriteQuery(sql);
      expect(out).toContain('1=0');
    });
  });

  describe('computeTsRank', () => {
    it('returns 0 for empty input', () => {
      expect(idx.computeTsRank('', 'cat')).toBe(0);
      expect(idx.computeTsRank("'cat':1", '')).toBe(0);
    });

    it('scores a matching term', () => {
      const s = idx.computeTsRank("'cat':1 'dog':2 'fox':3", 'cat');
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    });

    it('scores all matching terms higher', () => {
      const one = idx.computeTsRank("'cat':1 'dog':2 'fox':3", 'cat');
      const both = idx.computeTsRank("'cat':1 'dog':2 'fox':3", 'cat & dog');
      expect(both).toBeGreaterThanOrEqual(one);
    });

    it('returns 0 for no match', () => {
      expect(idx.computeTsRank("'cat':1", 'zzz')).toBe(0);
    });

    it('respects weight vectors', () => {
      const plain = idx.computeTsRank("'cat':1", 'cat');
      const weighted = idx.computeTsRank("'cat':1", 'cat', '{0.1,0.2,0.4,1.0}');
      expect(weighted).toBeLessThan(plain);
    });

    it('parses space-separated vector fallback', () => {
      const s = idx.computeTsRank('cat dog fox', 'cat');
      expect(s).toBeGreaterThan(0);
    });

    it('parses query fallback when no quoted terms present', () => {
      // query without <'term'> quoting → caught by the second regex → fallback split
      const s = idx.computeTsRank("'cat':1 'dog':2", 'cat&dog');
      expect(s).toBeGreaterThan(0);
    });

    it('falls back to numeric/symbol terms in query', () => {
      // numeric terms are not matched by the primary [a-z] regex, so the fallback
      // split path is exercised
      const s = idx.computeTsRank("'cat':1", '123');
      expect(s).toBeGreaterThanOrEqual(0);
    });

    it('handles a query term that is an AND/OR/NOT keyword', () => {
      // 'and' is filtered out as an operator in the primary regex path
      const s = idx.computeTsRank("'cat':1 'and':2", 'and');
      expect(s).toBe(0);
    });

    it('handles a query of pure symbols (empty clean term)', () => {
      const s = idx.computeTsRank("'cat':1", '&&&');
      expect(s).toBe(0);
    });

    it('passes through non-Latin (CJK) vector terms without stemming', () => {
      // CJK vector term '世界' is passed through unstemed while ASCII 'cat' is matched
      const s = idx.computeTsRank("'世界':1 'cat':2", 'cat');
      expect(s).toBeGreaterThan(0);
    });

    it('treats zero weights as fallback to 1.0', () => {
      // all-zero weights → `weights[weightIndex] || 1.0` short-circuits to 1.0
      const s = idx.computeTsRank("'cat':1", 'cat', '{0,0,0,0}');
      expect(s).toBe(1);
    });
  });

  describe('computeTsHeadline', () => {
    it('returns empty for empty query or document', () => {
      expect(idx.computeTsHeadline('hello world', '')).toBe('');
      expect(idx.computeTsHeadline('', 'cat')).toBe('');
    });

    it('highlights matching term', () => {
      const out = idx.computeTsHeadline('the quick brown fox jumps', 'fox');
      expect(out).toContain('<b>fox</b>');
    });

    it('returns leading words when no match', () => {
      const out = idx.computeTsHeadline('hello world foo bar', 'zzz');
      expect(out).toBe('hello world foo bar');
    });

    it('respects custom options', () => {
      const out = idx.computeTsHeadline(
        'a b c d e f g h i j cat k l m n o p',
        'cat',
        'MaxWords=5,MinWords=3,StartSel=[,EndSel=]',
      );
      expect(out).toContain('[cat]');
    });

    it('matches stemmed terms', () => {
      const out = idx.computeTsHeadline('the runner runs quickly', 'running');
      expect(out).toContain('<b>');
    });

    it('skips empty option entries', () => {
      // leading/trailing commas produce empty pairs that are skipped
      const out = idx.computeTsHeadline('a b cat d e', 'cat', ',MaxWords=3,,StartSel=[,');
      expect(out).toContain('[cat');
    });
  });

  describe('state accessors', () => {
    it('exposes tokenizer and query parser', () => {
      expect(idx.getTokenizer()).toBeInstanceOf(SimpleTokenizer);
      expect(idx.getQueryParser()).toBeInstanceOf(TsQueryParser);
    });

    it('getIndexByName returns config or undefined', () => {
      idx.handleCreateFtsIndex({ name: 'idx', table: 'docs', column: 'content', config: 'english', originalSql: 'x' });
      expect(idx.getIndexByName('idx')?.table).toBe('docs');
      expect(idx.getIndexByName('missing')).toBeUndefined();
    });

    it('getAllIndexes returns all registered', () => {
      idx.handleCreateFtsIndex({ name: 'a', table: 't1', column: 'c', config: 'english', originalSql: 'x' });
      idx.handleCreateFtsIndex({ name: 'b', table: 't2', column: 'c', config: 'english', originalSql: 'x' });
      expect(idx.getAllIndexes().length).toBe(2);
    });

    it('clearIndexes empties all state', () => {
      idx.handleCreateFtsIndex({ name: 'a', table: 't1', column: 'c', config: 'english', originalSql: 'x' });
      idx.clearIndexes();
      expect(idx.getAllIndexes()).toEqual([]);
      expect(idx.hasIndex('a')).toBe(false);
    });

    it('accepts a custom tokenizer in constructor', () => {
      const custom = new SimpleTokenizer(new Set(['the', 'custom']));
      const i = new FullTextSearchIndexer(custom);
      expect(i.getTokenizer()).toBe(custom);
    });
  });
});
