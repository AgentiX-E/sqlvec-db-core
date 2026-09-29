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
    expect(detectFilter(undefined as unknown as string)).toBe(false);
  });

  it('detects a FILTER (WHERE) clause', () => {
    expect(detectFilter('SELECT SUM(x) FILTER (WHERE x > 0) FROM t')).toBe(true);
  });

  it('does not detect FILTER inside a string literal', () => {
    expect(detectFilter("SELECT 'FILTER (WHERE x)' FROM t")).toBe(false);
  });

  it('does not detect FILTER inside a comment', () => {
    expect(detectFilter('-- FILTER (WHERE x)\nSELECT 1')).toBe(false);
    expect(detectFilter('/* FILTER (WHERE x) */ SELECT 1')).toBe(false);
  });

  it('strips double-quoted identifiers when scanning', () => {
    expect(detectFilter('SELECT "FILTER (WHERE x)" FROM t')).toBe(false);
    expect(detectFilter('SELECT "col", SUM(x) FILTER (WHERE x > 0) FROM t')).toBe(true);
  });
});

describe('rewriteFilter', () => {
  it('returns unchanged for empty / non-string / blank', () => {
    expect(rewriteFilter('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteFilter(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteFilter('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites SUM(x) FILTER (WHERE x > 0)', () => {
    expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0) FROM t').sql).toBe(
      'SELECT SUM(CASE WHEN (x > 0) THEN x END) FROM t',
    );
  });

  it('rewrites count(*) FILTER (WHERE ...) with THEN 1', () => {
    expect(rewriteFilter('SELECT count(*) FILTER (WHERE x > 0) FROM t').sql).toBe(
      'SELECT count(CASE WHEN (x > 0) THEN 1 END) FROM t',
    );
  });

  it('rewrites AVG(x) FILTER (WHERE x IS NOT NULL)', () => {
    expect(rewriteFilter('SELECT AVG(x) FILTER (WHERE x IS NOT NULL) FROM t').sql).toBe(
      'SELECT AVG(CASE WHEN (x IS NOT NULL) THEN x END) FROM t',
    );
  });

  it('preserves an OVER clause after FILTER', () => {
    expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0) OVER (PARTITION BY y) FROM t').sql).toBe(
      'SELECT SUM(CASE WHEN (x > 0) THEN x END) OVER (PARTITION BY y) FROM t',
    );
  });

  it('rewrites STRING_AGG with a delimiter, wrapping only the value expression', () => {
    expect(rewriteFilter("SELECT STRING_AGG(x, ',') FILTER (WHERE x IS NOT NULL) FROM t").sql).toBe(
      "SELECT STRING_AGG(CASE WHEN (x IS NOT NULL) THEN x END, ',') FROM t",
    );
  });

  it('rewrites STRING_AGG with no explicit delimiter', () => {
    expect(rewriteFilter('SELECT STRING_AGG(x) FILTER (WHERE x > 0) FROM t').sql).toBe(
      'SELECT STRING_AGG(CASE WHEN (x > 0) THEN x END) FROM t',
    );
  });

  it('rewrites MIN / MAX / json_agg / ARRAY_AGG aggregations', () => {
    expect(rewriteFilter('SELECT MIN(x) FILTER (WHERE x > 0) FROM t').sql).toBe(
      'SELECT MIN(CASE WHEN (x > 0) THEN x END) FROM t',
    );
    expect(rewriteFilter('SELECT MAX(x) FILTER (WHERE x > 0) FROM t').sql).toBe(
      'SELECT MAX(CASE WHEN (x > 0) THEN x END) FROM t',
    );
    expect(rewriteFilter('SELECT json_agg(x) FILTER (WHERE x > 0) FROM t').sql).toBe(
      'SELECT json_agg(CASE WHEN (x > 0) THEN x END) FROM t',
    );
    expect(rewriteFilter('SELECT jsonb_agg(x) FILTER (WHERE x > 0) FROM t').sql).toBe(
      'SELECT jsonb_agg(CASE WHEN (x > 0) THEN x END) FROM t',
    );
    expect(rewriteFilter('SELECT ARRAY_AGG(x) FILTER (WHERE x > 0) FROM t').sql).toBe(
      'SELECT ARRAY_AGG(CASE WHEN (x > 0) THEN x END) FROM t',
    );
  });

  it('honors parentheses inside string literals within the WHERE condition', () => {
    // Regression #350: `)` inside 'a)b' must not close the FILTER paren early.
    expect(rewriteFilter("SELECT SUM(x) FILTER (WHERE x IN ('a)b', 'c')) FROM t").sql).toBe(
      "SELECT SUM(CASE WHEN (x IN ('a)b', 'c')) THEN x END) FROM t",
    );
  });

  it('handles nested parentheses in the WHERE condition', () => {
    expect(rewriteFilter('SELECT SUM(f(x)) FILTER (WHERE a AND (b OR c)) FROM t').sql).toBe(
      'SELECT SUM(CASE WHEN (a AND (b OR c)) THEN f(x) END) FROM t',
    );
  });

  it('handles a string literal inside the aggregate expression', () => {
    expect(rewriteFilter("SELECT SUM(x IN ('a)b')) FILTER (WHERE y > 0) FROM t").sql).toBe(
      "SELECT SUM(CASE WHEN (y > 0) THEN x IN ('a)b') END) FROM t",
    );
  });

  it('rewrites multiple FILTER clauses independently', () => {
    const r = rewriteFilter(
      'SELECT SUM(x) FILTER (WHERE x > 0), AVG(y) FILTER (WHERE y > 1) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('SUM(CASE WHEN (x > 0) THEN x END)');
    expect(r.sql).toContain('AVG(CASE WHEN (y > 1) THEN y END)');
  });

  it('leaves a FILTER inside a string literal untouched even when a real FILTER exists', () => {
    const r = rewriteFilter("SELECT SUM(x) FILTER (WHERE x > 0), 'FILTER (WHERE y)' AS s FROM t");
    expect(r.sql).toBe("SELECT SUM(CASE WHEN (x > 0) THEN x END), 'FILTER (WHERE y)' AS s FROM t");
  });

  // ── malformed FILTER forms are left untouched (no crash, no rewrite) ──

  it('leaves a FILTER with no opening paren untouched', () => {
    expect(rewriteFilter('SELECT FILTER WHERE x > 0').rewritten).toBe(false);
  });

  it('leaves a FILTER with an unterminated paren untouched', () => {
    expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0').rewritten).toBe(false);
  });

  it('leaves a FILTER with no WHERE keyword untouched', () => {
    expect(rewriteFilter('SELECT SUM(x) FILTER (x > 0)').rewritten).toBe(false);
  });

  it('leaves a FILTER with an empty WHERE condition untouched', () => {
    expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE) FROM t').rewritten).toBe(false);
  });

  it('leaves a FILTER not preceded by an aggregate function untouched', () => {
    expect(rewriteFilter('SELECT x FILTER (WHERE x > 0) FROM t').rewritten).toBe(false);
  });

  it('leaves a FILTER with an unbalanced aggregate paren untouched', () => {
    expect(rewriteFilter('SELECT SUM(x FILTER (WHERE x > 0) FROM t').rewritten).toBe(false);
  });

  it('handles an OVER clause with no parentheses', () => {
    expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0) OVER PARTITION BY y FROM t').sql).toBe(
      'SELECT SUM(CASE WHEN (x > 0) THEN x END) OVER PARTITION BY y FROM t',
    );
  });

  it('handles an OVER clause with an unterminated paren', () => {
    expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0) OVER (PARTITION BY y FROM t').sql).toBe(
      'SELECT SUM(CASE WHEN (x > 0) THEN x END) OVER (PARTITION BY y FROM t',
    );
  });

  it('leaves a FILTER at the very start of the SQL untouched', () => {
    expect(rewriteFilter('FILTER (WHERE x > 0)').rewritten).toBe(false);
  });

  it('leaves a FILTER on a non-aggregate function untouched', () => {
    expect(rewriteFilter('SELECT foo(x) FILTER (WHERE x > 0) FROM t').rewritten).toBe(false);
  });

  it('leaves a FILTER with an unbalanced aggregate paren untouched', () => {
    // SUM(x  — the aggregate's open paren is never closed before FILTER.
    expect(rewriteFilter('SELECT SUM(x FILTER (WHERE x > 0) FROM t').rewritten).toBe(false);
  });

  it('handles an escaped quote inside the aggregate expression', () => {
    // Regression for `_findMatchingOpenParen` honoring '' escapes inside the
    // aggregate's own argument list (reverse paren scan).
    expect(rewriteFilter("SELECT SUM(x IN ('it''s')) FILTER (WHERE y > 0) FROM t").sql).toBe(
      "SELECT SUM(CASE WHEN (y > 0) THEN x IN ('it''s') END) FROM t",
    );
    expect(rewriteFilter("SELECT STRING_AGG(x, ',') FILTER (WHERE y > 0) FROM t").rewritten).toBe(true);
    expect(rewriteFilter("SELECT SUM(x) FILTER (WHERE x = 'it''s') FROM t").sql).toBe(
      "SELECT SUM(CASE WHEN (x = 'it''s') THEN x END) FROM t",
    );
  });

  it('leaves a FILTER preceded by an orphan closing paren untouched', () => {
    expect(rewriteFilter('SELECT ) FILTER (WHERE x > 0) FROM t').rewritten).toBe(false);
  });
});

describe('_findMatchingParen', () => {
  it('returns -1 for invalid open positions', () => {
    expect(_findMatchingParen('abc', -1)).toBe(-1);
    expect(_findMatchingParen('abc', 99)).toBe(-1);
    expect(_findMatchingParen('abc', 1)).toBe(-1); // not a '('
  });

  it('finds a balanced closing paren', () => {
    expect(_findMatchingParen('(a)', 0)).toBe(2);
    expect(_findMatchingParen('((a)b)', 0)).toBe(5);
    expect(_findMatchingParen('((a)b)', 1)).toBe(3);
  });

  it('returns -1 for an unbalanced open', () => {
    expect(_findMatchingParen('(a', 0)).toBe(-1);
  });

  it('ignores parens inside string literals', () => {
    expect(_findMatchingParen("('a)b')", 0)).toBe(6);
  });
});

describe('_findMatchingOpenParen', () => {
  it('returns -1 for invalid close positions', () => {
    expect(_findMatchingOpenParen('abc', -1)).toBe(-1);
    expect(_findMatchingOpenParen('abc', 99)).toBe(-1);
    expect(_findMatchingOpenParen('abc', 1)).toBe(-1); // not a ')'
  });

  it('finds a balanced opening paren', () => {
    expect(_findMatchingOpenParen('(a)', 2)).toBe(0);
    expect(_findMatchingOpenParen('(a(b))', 5)).toBe(0);
    expect(_findMatchingOpenParen('(a(b))', 4)).toBe(2);
  });

  it('returns -1 for an unbalanced close', () => {
    expect(_findMatchingOpenParen('a)', 1)).toBe(-1);
  });

  it('ignores parens inside string literals', () => {
    expect(_findMatchingOpenParen("('a)b')", 6)).toBe(0);
  });
});

describe('_topLevelSplit', () => {
  it('splits at top-level commas only', () => {
    expect(_topLevelSplit('a, b, c', ',')).toEqual(['a', 'b', 'c']);
    expect(_topLevelSplit('f(a, b), c', ',')).toEqual(['f(a, b)', 'c']);
  });

  it('does not split commas inside string literals', () => {
    expect(_topLevelSplit("a, 'b,c', d", ',')).toEqual(['a', "'b,c'", 'd']);
  });

  it('does not split commas inside double-quoted identifiers', () => {
    expect(_topLevelSplit('a, "b,c", d', ',')).toEqual(['a', '"b,c"', 'd']);
  });

  it('does not split commas inside a trailing empty segment', () => {
    expect(_topLevelSplit('a, b,', ',')).toEqual(['a', 'b']);
  });
});
