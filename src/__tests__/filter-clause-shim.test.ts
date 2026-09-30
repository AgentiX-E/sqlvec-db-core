import { describe, it, expect } from 'vitest';
import {
  detectFilter,
  rewriteFilter,
  _findMatchingParen,
  _findMatchingOpenParen,
  _topLevelSplit,
} from '../query/FilterClauseShim';

describe('detectFilter', () => {
  it('returns false for empty / non-string / blank', () => {
    expect(detectFilter('')).toBe(false);
    expect(detectFilter('   ')).toBe(false);
    expect(detectFilter(null as unknown as string)).toBe(false);
  });

  it('detects a FILTER (WHERE) clause', () => {
    expect(detectFilter('SELECT SUM(x) FILTER (WHERE x > 0) FROM t')).toBe(true);
  });

  it('does not detect FILTER inside a string literal', () => {
    expect(detectFilter("SELECT 'SUM(x) FILTER (WHERE x > 0)' FROM t")).toBe(false);
  });

  it('does not detect FILTER inside comments', () => {
    expect(detectFilter('-- SUM(x) FILTER (WHERE x > 0)\nSELECT 1')).toBe(false);
    expect(detectFilter('/* SUM(x) FILTER (WHERE x > 0) */ SELECT 1')).toBe(false);
  });

  it('does not detect FILTER inside a dollar-quoted string', () => {
    expect(detectFilter('SELECT $$ SUM(x) FILTER (WHERE x > 0) $$ FROM t')).toBe(false);
    expect(detectFilter('SELECT $tag$ SUM(x) FILTER (WHERE x > 0) $tag$ FROM t')).toBe(false);
  });

  it('does not detect FILTER inside an E-string', () => {
    expect(detectFilter("SELECT E'SUM(x) FILTER (WHERE x > 0)' FROM t")).toBe(false);
  });
});

describe('rewriteFilter — normal rewrites', () => {
  it('returns unchanged for empty / non-string', () => {
    expect(rewriteFilter('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteFilter(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('rewrites SUM(x) FILTER (WHERE ...)', () => {
    expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0) FROM t')).toEqual({
      sql: 'SELECT SUM(CASE WHEN (x > 0) THEN x END) FROM t',
      rewritten: true,
    });
  });

  it('rewrites count(*) FILTER as count(CASE WHEN ... THEN 1 END)', () => {
    expect(rewriteFilter('SELECT COUNT(*) FILTER (WHERE x > 0) FROM t')).toEqual({
      sql: 'SELECT count(CASE WHEN (x > 0) THEN 1 END) FROM t',
      rewritten: true,
    });
  });

  it('rewrites AVG FILTER', () => {
    expect(rewriteFilter('SELECT AVG(x) FILTER (WHERE x IS NOT NULL) FROM t')).toEqual({
      sql: 'SELECT AVG(CASE WHEN (x IS NOT NULL) THEN x END) FROM t',
      rewritten: true,
    });
  });

  it('rewrites MIN/MAX FILTER', () => {
    expect(rewriteFilter('SELECT MIN(x) FILTER (WHERE x > 0) FROM t').sql).toContain('MIN(CASE WHEN (x > 0) THEN x END)');
    expect(rewriteFilter('SELECT MAX(x) FILTER (WHERE x > 0) FROM t').sql).toContain('MAX(CASE WHEN (x > 0) THEN x END)');
  });

  it('rewrites STRING_AGG with delimiter', () => {
    expect(rewriteFilter("SELECT STRING_AGG(x, ',') FILTER (WHERE x IS NOT NULL) FROM t")).toEqual({
      sql: "SELECT STRING_AGG(CASE WHEN (x IS NOT NULL) THEN x END, ',') FROM t",
      rewritten: true,
    });
  });

  it('rewrites STRING_AGG without delimiter', () => {
    expect(rewriteFilter('SELECT STRING_AGG(x) FILTER (WHERE x > 0) FROM t')).toEqual({
      sql: 'SELECT STRING_AGG(CASE WHEN (x > 0) THEN x END) FROM t',
      rewritten: true,
    });
  });

  it('rewrites ARRAY_AGG with ORDER BY inside', () => {
    expect(rewriteFilter('SELECT ARRAY_AGG(x ORDER BY y) FILTER (WHERE x > 0) FROM t')).toEqual({
      sql: 'SELECT ARRAY_AGG(CASE WHEN (x > 0) THEN x ORDER BY y END) FROM t',
      rewritten: true,
    });
  });

  it('rewrites with OVER clause preserved', () => {
    expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0) OVER (PARTITION BY y) FROM t')).toEqual({
      sql: 'SELECT SUM(CASE WHEN (x > 0) THEN x END) OVER (PARTITION BY y) FROM t',
      rewritten: true,
    });
  });

  it('rewrites multiple FILTER clauses independently', () => {
    expect(
      rewriteFilter('SELECT SUM(x) FILTER (WHERE a > 0), COUNT(y) FILTER (WHERE b < 0) FROM t'),
    ).toEqual({
      sql: 'SELECT SUM(CASE WHEN (a > 0) THEN x END), COUNT(CASE WHEN (b < 0) THEN y END) FROM t',
      rewritten: true,
    });
  });

  it('handles nested parens in the condition', () => {
    expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE (a+b) > 0) FROM t').sql).toContain(
      'CASE WHEN ((a+b) > 0) THEN x END',
    );
  });

  it('handles a subquery in the condition', () => {
    expect(
      rewriteFilter('SELECT COUNT(*) FILTER (WHERE x IN (SELECT id FROM u)) FROM t').rewritten,
    ).toBe(true);
  });
});

describe('rewriteFilter — literal/comment protection', () => {
  it('does not rewrite FILTER inside a string literal', () => {
    expect(rewriteFilter("SELECT 'SUM(x) FILTER (WHERE x > 0)' FROM t").rewritten).toBe(false);
  });

  it('does not rewrite FILTER inside a comment', () => {
    expect(rewriteFilter('-- SUM(x) FILTER (WHERE x > 0)\nSELECT 1').rewritten).toBe(false);
    expect(rewriteFilter('/* SUM(x) FILTER (WHERE x > 0) */ SELECT 1').rewritten).toBe(false);
  });

  it('does not rewrite FILTER inside a dollar-quoted string (regression)', () => {
    const r = rewriteFilter('SELECT $$ SUM(x) FILTER (WHERE x > 0) $$ FROM t');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT $$ SUM(x) FILTER (WHERE x > 0) $$ FROM t');
  });

  it('does not rewrite FILTER inside a tagged dollar-quoted string (regression)', () => {
    const r = rewriteFilter('SELECT $tag$ SUM(x) FILTER (WHERE x > 0) $tag$ FROM t');
    expect(r.rewritten).toBe(false);
  });

  it('handles a string literal with a closing paren inside the condition', () => {
    expect(rewriteFilter("SELECT SUM(x) FILTER (WHERE name = 'a)b') FROM t").sql).toContain(
      "THEN x END",
    );
  });
});

describe('rewriteFilter — defensive branches', () => {
  it('returns rewritten false for unbalanced FILTER parens', () => {
    const r = rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0 FROM t');
    expect(r.rewritten).toBe(false);
  });

  it('skips a standalone FILTER with no aggregate', () => {
    expect(rewriteFilter('SELECT FILTER (WHERE x > 0) FROM t').rewritten).toBe(false);
  });

  it('skips a FILTER with empty WHERE condition', () => {
    expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE) FROM t').rewritten).toBe(false);
  });

  it('skips a FILTER at the very start of the string (no aggregate before it)', () => {
    expect(rewriteFilter('FILTER (WHERE x > 0)').rewritten).toBe(false);
  });

  it('skips a FILTER on a non-aggregate function', () => {
    expect(rewriteFilter('SELECT foo(x) FILTER (WHERE y > 0) FROM t').rewritten).toBe(false);
  });

  it('skips a FILTER whose aggregate parens are unbalanced', () => {
    expect(rewriteFilter('SELECT SUM(x FILTER (WHERE y > 0) FROM t').rewritten).toBe(false);
  });

  it('continues scanning past a literal that follows a rewritten FILTER', () => {
    const r = rewriteFilter("SELECT SUM(x) FILTER (WHERE y > 0), 'FILTER (WHERE z)' FROM t");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'FILTER (WHERE z)'");
  });

  it('preserves an unbalanced OVER clause rather than matching it', () => {
    const r = rewriteFilter('SELECT SUM(x) FILTER (WHERE y > 0) OVER (PARTITION FROM t');
    expect(r.rewritten).toBe(true);
  });

  it('rewrites ARRAY_AGG / json_agg / jsonb_agg single-arg FILTER', () => {
    expect(rewriteFilter('SELECT ARRAY_AGG(x) FILTER (WHERE y > 0) FROM t').sql).toContain('ARRAY_AGG(CASE WHEN (y > 0) THEN x END)');
    expect(rewriteFilter('SELECT json_agg(x) FILTER (WHERE y > 0) FROM t').sql).toContain('json_agg(CASE WHEN (y > 0) THEN x END)');
    expect(rewriteFilter('SELECT jsonb_agg(x) FILTER (WHERE y > 0) FROM t').sql).toContain('jsonb_agg(CASE WHEN (y > 0) THEN x END)');
  });

  it('skips a leading literal before the real FILTER clause', () => {
    const r = rewriteFilter("'FILTER (WHERE z)' || SUM(x) FILTER (WHERE y > 0)");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'FILTER (WHERE z)'");
    expect(r.sql).toContain('SUM(CASE WHEN (y > 0) THEN x END)');
  });

  it('skips a FILTER preceded only by an unmatched close paren', () => {
    expect(rewriteFilter('SELECT ) FILTER (WHERE x > 0) FROM t').rewritten).toBe(false);
  });

  it('handles a doubled-quote escape inside the aggregate expression', () => {
    // "a""b" is a quoted identifier containing an escaped double quote.
    const r = rewriteFilter('SELECT SUM("a""b") FILTER (WHERE x > 0) FROM t');
    expect(r.rewritten).toBe(true);
  });

  it('handles a doubled single-quote escape inside the aggregate expression', () => {
    const r = rewriteFilter("SELECT SUM('a''b') FILTER (WHERE x > 0) FROM t");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("THEN 'a''b' END");
  });
});

describe('_findMatchingParen', () => {
  it('returns -1 for out-of-range or non-open-paren positions', () => {
    expect(_findMatchingParen('(x)', -1)).toBe(-1);
    expect(_findMatchingParen('(x)', 99)).toBe(-1);
    expect(_findMatchingParen(')', 0)).toBe(-1);
  });

  it('finds a simple matching paren', () => {
    expect(_findMatchingParen('(a(b)c)', 0)).toBe(6);
  });

  it('skips parens inside string literals', () => {
    expect(_findMatchingParen("(')')", 0)).toBe(4);
  });

  it('returns -1 when unbalanced', () => {
    expect(_findMatchingParen('(abc', 0)).toBe(-1);
  });
});

describe('_findMatchingOpenParen', () => {
  it('returns -1 for out-of-range or non-close-paren positions', () => {
    expect(_findMatchingOpenParen('(x)', -1)).toBe(-1);
    expect(_findMatchingOpenParen('(x)', 99)).toBe(-1);
    expect(_findMatchingOpenParen('(', 0)).toBe(-1);
  });

  it('finds a simple matching open paren', () => {
    expect(_findMatchingOpenParen('(a(b)c)', 6)).toBe(0);
  });

  it('skips parens inside string literals', () => {
    expect(_findMatchingOpenParen("(')')", 4)).toBe(0);
  });

  it('returns -1 when unbalanced', () => {
    expect(_findMatchingOpenParen('abc)', 3)).toBe(-1);
  });
});

describe('_topLevelSplit', () => {
  it('splits on top-level commas', () => {
    expect(_topLevelSplit('a, b, c', ',')).toEqual(['a', 'b', 'c']);
  });

  it('does not split commas inside parens', () => {
    expect(_topLevelSplit('f(a,b), c', ',')).toEqual(['f(a,b)', 'c']);
  });

  it('does not split commas inside string literals', () => {
    expect(_topLevelSplit("'a,b', c", ',')).toEqual(["'a,b'", 'c']);
  });

  it('returns a single trimmed part for text without the delimiter', () => {
    expect(_topLevelSplit('justone', ',')).toEqual(['justone']);
  });

  it('returns empty for empty text and keeps interior empty segments', () => {
    expect(_topLevelSplit('', ',')).toEqual([]);
    expect(_topLevelSplit('  ', ',')).toEqual([]);
    // Interior empty segments are preserved (only the trailing segment is
    // trimmed away when blank).
    expect(_topLevelSplit(',,', ',')).toEqual(['', '']);
  });
});
