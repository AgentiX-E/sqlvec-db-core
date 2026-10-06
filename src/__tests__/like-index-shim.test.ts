import { describe, it, expect } from 'vitest';
import {
  buildFTSQuery,
  createLikeIndex,
  rewriteLikeQuery,
  detectLikeIndex,
} from '../index/LikeIndexShim';

describe('buildFTSQuery', () => {
  it('strips leading/trailing % for substring match', () => {
    expect(buildFTSQuery('%foo%')).toBe('"foo"');
    expect(buildFTSQuery('foo%')).toBe('"foo"');
    expect(buildFTSQuery('%foo')).toBe('"foo"');
  });

  it('splits internal % into AND-joined terms', () => {
    expect(buildFTSQuery('%foo%bar%')).toBe('"foo" AND "bar"');
    expect(buildFTSQuery('%a%b%c%')).toBe('"a" AND "b" AND "c"');
  });

  it('collapses consecutive % into a single separator', () => {
    expect(buildFTSQuery('%foo%%bar%')).toBe('"foo" AND "bar"');
  });

  it('translates _ to the single-character wildcard', () => {
    expect(buildFTSQuery('%foo_bar%')).toBe('"foo?bar"');
    expect(buildFTSQuery('_o_')).toBe('"?o?"');
  });

  it('returns empty string for a pattern with no content', () => {
    expect(buildFTSQuery('%%')).toBe('');
    expect(buildFTSQuery('%')).toBe('');
  });

  it('escapes internal double quotes for FTS5 phrase syntax', () => {
    expect(buildFTSQuery('%a"b%')).toBe('"a""b"');
  });

  it('handles a bare term without wildcards', () => {
    expect(buildFTSQuery('foo')).toBe('"foo"');
  });

  it('handles a multi-term pattern for multi-character AND quoting', () => {
    expect(buildFTSQuery('%foo bar%')).toBe('"foo" AND "bar"');
  });
});

describe('createLikeIndex', () => {
  it('builds an FTS5 DDL block for a simple table/column', () => {
    const r = createLikeIndex('users', 'name');
    expect(r.ftsTableName).toBe('__like_users_name');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS __like_users_name');
    expect(r.sql).toContain("tokenize='trigram'");
    expect(r.sql).toContain("content='users'");
  });

  it('strips quote/backtick characters from identifiers', () => {
    const r = createLikeIndex('my-table', 'my"col');
    expect(r.ftsTableName).toBe('__like_my-table_mycol');
    expect(r.sql).toContain('__like_my-table_mycol');
  });

  it('emits sync triggers for insert/delete/update', () => {
    const r = createLikeIndex('t', 'c');
    expect(r.sql).toContain('AFTER INSERT');
    expect(r.sql).toContain('AFTER DELETE');
    expect(r.sql).toContain('AFTER UPDATE OF c');
  });

  it('emits a populate statement', () => {
    const r = createLikeIndex('t', 'c');
    expect(r.sql).toContain('INSERT OR IGNORE INTO __like_t_c');
  });
});

describe('rewriteLikeQuery', () => {
  it('returns unchanged when ftsMap is empty', () => {
    const r = rewriteLikeQuery("SELECT * FROM t WHERE name LIKE '%x%'", {});
    expect(r.rewritten).toBe(false);
    expect(r.rewrites).toEqual([]);
    expect(r.sql).toBe("SELECT * FROM t WHERE name LIKE '%x%'");
  });

  it('returns unchanged when ftsMap is null/undefined', () => {
    const r = rewriteLikeQuery('SELECT 1', null as never);
    expect(r.rewritten).toBe(false);
    expect(r.rewrites).toEqual([]);
  });

  it('rewrites an unqualified LIKE using FTS5 MATCH', () => {
    const r = rewriteLikeQuery(
      "SELECT * FROM users WHERE name LIKE '%john%'",
      { name: '__like_users_name' },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('__like_users_name MATCH');
    expect(r.sql).toContain('name LIKE');
    expect(r.rewrites).toHaveLength(1);
    expect(r.rewrites[0]).toMatchObject({
      column: 'name',
      pattern: '%john%',
      operator: 'LIKE',
      ftsTable: '__like_users_name',
    });
  });

  it('rewrites a qualified LIKE using the qualified ftsMap entry', () => {
    const r = rewriteLikeQuery(
      "SELECT * FROM users u WHERE u.name LIKE 'foo%'",
      { 'u.name': '__x', name: '__y' },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('u.rowid IN (SELECT rowid FROM __x');
    expect(r.rewrites[0].column).toBe('u.name');
    expect(r.rewrites[0].ftsTable).toBe('__x');
  });

  it('falls back to the bare column when only unqualified is mapped', () => {
    const r = rewriteLikeQuery(
      "SELECT * FROM users u WHERE u.name LIKE 'x%'",
      { name: '__y' },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('FROM __y');
  });

  it('rewrites ILIKE and SIMILAR TO conditions', () => {
    const ftsMap = { name: '__n' };
    const ilike = rewriteLikeQuery("SELECT * FROM t WHERE name ILIKE '%a%'", ftsMap);
    expect(ilike.rewritten).toBe(true);
    expect(ilike.rewrites[0].operator).toBe('ILIKE');

    const similar = rewriteLikeQuery("SELECT * FROM t WHERE name SIMILAR TO '%a%'", ftsMap);
    expect(similar.rewritten).toBe(true);
    expect(similar.rewrites[0].operator).toBe('SIMILAR TO');
  });

  it('rewrites all three operator types in a single query', () => {
    const r = rewriteLikeQuery(
      "SELECT * FROM t WHERE a LIKE '%x%' AND b ILIKE '%y%' AND c SIMILAR TO '%z%'",
      { a: '__a', b: '__b', c: '__c' },
    );
    expect(r.rewrites).toHaveLength(3);
    expect(r.rewrites.map((w) => w.operator)).toEqual(['LIKE', 'ILIKE', 'SIMILAR TO']);
  });

  it('skips conditions whose column is not in ftsMap', () => {
    const r = rewriteLikeQuery(
      "SELECT * FROM t WHERE a LIKE '%x%' AND b LIKE '%y%'",
      { a: '__a' },
    );
    expect(r.rewrites).toHaveLength(1);
    expect(r.sql).toContain("b LIKE '%y%'");
    expect(r.sql).not.toContain('__b');
  });

  it('skips conditions whose pattern yields an empty FTS query', () => {
    const r = rewriteLikeQuery(
      "SELECT * FROM t WHERE name LIKE '%%'",
      { name: '__n' },
    );
    expect(r.rewritten).toBe(false);
    expect(r.rewrites).toEqual([]);
  });

  it('preserves an apostrophe (SQL-escaped quote) in the pattern', () => {
    const r = rewriteLikeQuery(
      "SELECT * FROM t WHERE name LIKE '%o''brien%'",
      { name: '__n' },
    );
    expect(r.rewritten).toBe(true);
    // The original condition must remain intact (no fragment leaked after it).
    expect(r.sql).toContain("name LIKE '%o''brien%' AND rowid IN");
    // The FTS5 MATCH literal is produced from the quote-escaped phrase.
    expect(r.sql).toContain("MATCH '\"o''''brien\"'");
  });
});

describe('detectLikeIndex', () => {
  it('detects a gin_trgm_ops index', () => {
    expect(detectLikeIndex('CREATE INDEX ON t USING gin (col gin_trgm_ops)')).toBe(true);
  });

  it('detects an fts5 LIKE index', () => {
    expect(detectLikeIndex('CREATE INDEX ON t USING fts5 LIKE col')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectLikeIndex('create index using GIN (c gin_trgm_ops)')).toBe(true);
  });

  it('rejects an index without a trigram/like marker', () => {
    expect(detectLikeIndex('CREATE INDEX ON t USING btree (col)')).toBe(false);
  });

  it('rejects a non-index statement', () => {
    expect(detectLikeIndex('SELECT * FROM t')).toBe(false);
  });
});
