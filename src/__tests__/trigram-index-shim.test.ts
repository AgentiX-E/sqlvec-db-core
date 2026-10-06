import { describe, it, expect } from 'vitest';
import {
  detectTrigramIndex,
  rewriteTrigramIndex,
  rewriteLikeQuery,
  rewriteRegexQuery,
} from '../index/TrigramIndexShim';

describe('detectTrigramIndex', () => {
  it('detects a named CREATE INDEX ... USING FTS5 LIKE', () => {
    expect(detectTrigramIndex('CREATE INDEX idx ON t USING FTS5 LIKE col')).toBe(true);
  });

  it('detects CREATE UNIQUE INDEX IF NOT EXISTS', () => {
    expect(detectTrigramIndex('CREATE UNIQUE INDEX IF NOT EXISTS idx ON t USING FTS5 LIKE col')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectTrigramIndex('create index idx on t using fts5 like col')).toBe(true);
  });

  it('rejects a non-FTS5 index', () => {
    expect(detectTrigramIndex('CREATE INDEX idx ON t USING btree (col)')).toBe(false);
  });

  it('rejects a non-index statement', () => {
    expect(detectTrigramIndex('SELECT * FROM t')).toBe(false);
  });
});

describe('rewriteTrigramIndex', () => {
  it('returns a null result for a non-matching statement', () => {
    expect(rewriteTrigramIndex('SELECT 1')).toEqual({
      sql: null, rewritten: false, ftsTableName: '', indexedColumn: '',
    });
  });

  it('builds an FTS5 trigram virtual table and triggers', () => {
    const r = rewriteTrigramIndex('CREATE INDEX idx ON users USING FTS5 LIKE name');
    expect(r.rewritten).toBe(true);
    expect(r.ftsTableName).toBe('__trigram_idx');
    expect(r.indexedColumn).toBe('name');
    expect(r.sql).toContain('CREATE VIRTUAL TABLE __trigram_idx');
    expect(r.sql).toContain("tokenize='trigram'");
    expect(r.sql).toContain("content='users'");
  });

  it('emits insert/delete/update sync triggers and a populate statement', () => {
    const r = rewriteTrigramIndex('CREATE INDEX idx ON users USING FTS5 LIKE name');
    expect(r.sql).toContain('AFTER INSERT');
    expect(r.sql).toContain('AFTER DELETE');
    expect(r.sql).toContain('AFTER UPDATE OF name');
    expect(r.sql).toContain('INSERT INTO __trigram_idx(rowid, name)');
  });

  it('strips quote/backtick characters from identifiers', () => {
    const r = rewriteTrigramIndex('CREATE INDEX "i" ON "t" USING FTS5 LIKE "c"');
    expect(r.ftsTableName).toBe('__trigram_i');
    expect(r.indexedColumn).toBe('c');
  });
});

describe('rewriteLikeQuery', () => {
  it('returns unchanged when there is no LIKE clause', () => {
    const r = rewriteLikeQuery('SELECT * FROM t', '__x', 'name');
    expect(r).toEqual({ sql: 'SELECT * FROM t', rewritten: false });
  });

  it('returns unchanged when the pattern is not wrapped in %', () => {
    const r = rewriteLikeQuery("SELECT * FROM t WHERE name LIKE 'foo%'", '__x', 'name');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe("SELECT * FROM t WHERE name LIKE 'foo%'");
  });

  it('rewrites a %...% LIKE into FTS5 MATCH joined on rowid', () => {
    const r = rewriteLikeQuery("SELECT * FROM t WHERE name LIKE '%foo%'", '__x', 'name');
    expect(r.rewritten).toBe(true);
    expect(r.pattern).toBe('%foo%');
    expect(r.sql).toContain("name LIKE '%foo%' AND");
    expect(r.sql).toContain('__x MATCH');
    expect(r.sql).toContain('t.rowid IN (SELECT rowid FROM __x');
  });

  it('preserves the qualified table reference', () => {
    const r = rewriteLikeQuery("SELECT * FROM users u WHERE u.name LIKE '%foo%'", '__x', 'name');
    expect(r.sql).toContain('u.rowid IN (SELECT rowid FROM __x');
    expect(r.sql).toContain("u.name LIKE '%foo%'");
  });

  it('preserves an apostrophe (SQL-escaped quote) in the pattern', () => {
    const r = rewriteLikeQuery("SELECT * FROM t WHERE name LIKE '%o''brien%'", '__x', 'name');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("name LIKE '%o''brien%' AND");
  });
});

describe('rewriteRegexQuery', () => {
  it('returns unchanged when there is no regex operator', () => {
    const r = rewriteRegexQuery('SELECT * FROM t', '__x');
    expect(r).toEqual({ sql: 'SELECT * FROM t', rewritten: false });
  });

  it('rewrites a regex with a literal part >= 3 chars', () => {
    const r = rewriteRegexQuery("SELECT * FROM t WHERE name ~ '^foo.*bar$'", '__x');
    expect(r.rewritten).toBe(true);
    expect(r.pattern).toBe('^foo.*bar$');
    expect(r.sql).toContain("name ~ '^foo.*bar$'");
    expect(r.sql).toContain('__x MATCH');
  });

  it('preserves the `$` anchor verbatim (no String.replace substitution)', () => {
    const r = rewriteRegexQuery("SELECT * FROM t WHERE name ~ '^foo.*bar$'", '__x');
    expect(r.sql).toContain("name ~ '^foo.*bar$' AND");
  });

  it('supports the case-insensitive ~* operator', () => {
    const r = rewriteRegexQuery("SELECT * FROM t WHERE name ~* 'joh?n'", '__x');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("name ~ 'joh?n'");
  });

  it('uses the longest literal part for the trigram query', () => {
    const r = rewriteRegexQuery("SELECT * FROM t WHERE name ~ '^john.*smith$'", '__x');
    expect(r.sql).toContain("MATCH 'smith'");
  });

  it('preserves a qualified table reference', () => {
    const r = rewriteRegexQuery("SELECT * FROM users u WHERE u.name ~ '^foo.*bar$'", '__x');
    expect(r.sql).toContain('u.rowid IN (SELECT rowid FROM __x');
    expect(r.sql).toContain("u.name ~ '^foo.*bar$'");
  });

  it('returns unchanged when no literal part is at least 3 chars', () => {
    const r = rewriteRegexQuery("SELECT * FROM t WHERE name ~ '^..$'", '__x');
    expect(r.rewritten).toBe(false);
  });

  it('preserves an apostrophe in the regex pattern', () => {
    const r = rewriteRegexQuery("SELECT * FROM t WHERE name ~ 'o''brien'", '__x');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("name ~ 'o''''brien'");
  });
});
