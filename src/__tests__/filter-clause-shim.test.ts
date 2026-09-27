import { describe, it, expect } from 'vitest';
import {
  detectFilter,
  rewriteFilter,
  _findMatchingParen,
  _findMatchingOpenParen,
  _topLevelSplit,
} from '../query/FilterClauseShim';

describe('FilterClauseShim', () => {
  describe('detectFilter', () => {
    it('detects a FILTER clause on an aggregate', () => {
      expect(detectFilter('SELECT SUM(x) FILTER (WHERE x > 0) FROM t')).toBe(true);
    });
    it('detects FILTER regardless of case', () => {
      expect(detectFilter('select sum(x) filter (where x > 0) from t')).toBe(true);
    });
    it('returns false when no FILTER present', () => {
      expect(detectFilter('SELECT SUM(x) FROM t')).toBe(false);
      expect(detectFilter('SELECT 1')).toBe(false);
    });
    it('returns false for empty / non-string input', () => {
      expect(detectFilter('')).toBe(false);
      expect(detectFilter('   ')).toBe(false);
      expect(detectFilter(null as any)).toBe(false);
      expect(detectFilter(42 as any)).toBe(false);
    });
    it('does not detect FILTER inside a string literal', () => {
      expect(detectFilter("SELECT 'FILTER (WHERE x > 0)'")).toBe(false);
    });
    it('does not detect FILTER inside escaped string literal', () => {
      expect(detectFilter("SELECT 'it''s FILTER (WHERE x)'")).toBe(false);
    });
    it('does not detect FILTER inside a comment', () => {
      expect(detectFilter('-- FILTER (WHERE x > 0)\nSELECT 1')).toBe(false);
      expect(detectFilter('/* FILTER (WHERE x > 0) */ SELECT 1')).toBe(false);
    });
    it('handles double-quoted identifiers and dollar-escaped strings', () => {
      expect(detectFilter('SELECT "FILTER" FROM t')).toBe(false);
      expect(detectFilter("SELECT 'it''s' FROM t")).toBe(false);
      expect(detectFilter('SELECT SUM("x") FILTER (WHERE "x" > 0) FROM "t"')).toBe(true);
    });
  });

  describe('rewriteFilter — basic aggregates', () => {
    it('rewrites SUM(x) FILTER', () => {
      expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0) FROM t')).toEqual({
        sql: 'SELECT SUM(CASE WHEN (x > 0) THEN x END) FROM t', rewritten: true,
      });
    });
    it('rewrites count(*) FILTER to count(CASE ... THEN 1)', () => {
      expect(rewriteFilter('SELECT count(*) FILTER (WHERE x > 0) FROM t')).toEqual({
        sql: 'SELECT count(CASE WHEN (x > 0) THEN 1 END) FROM t', rewritten: true,
      });
    });
    it('rewrites AVG / MIN / MAX FILTER', () => {
      expect(rewriteFilter('SELECT avg(x) FILTER (WHERE x IS NOT NULL) FROM t')).toEqual({
        sql: 'SELECT avg(CASE WHEN (x IS NOT NULL) THEN x END) FROM t', rewritten: true,
      });
      expect(rewriteFilter('SELECT min(x) FILTER (WHERE x > 0) FROM t')).toEqual({
        sql: 'SELECT min(CASE WHEN (x > 0) THEN x END) FROM t', rewritten: true,
      });
      expect(rewriteFilter('SELECT max(x) FILTER (WHERE x > 0) FROM t')).toEqual({
        sql: 'SELECT max(CASE WHEN (x > 0) THEN x END) FROM t', rewritten: true,
      });
    });
    it('rewrites json_agg / jsonb_agg FILTER', () => {
      expect(rewriteFilter('SELECT json_agg(x) FILTER (WHERE x > 0) FROM t')).toEqual({
        sql: 'SELECT json_agg(CASE WHEN (x > 0) THEN x END) FROM t', rewritten: true,
      });
      expect(rewriteFilter('SELECT jsonb_agg(x) FILTER (WHERE x > 0) FROM t')).toEqual({
        sql: 'SELECT jsonb_agg(CASE WHEN (x > 0) THEN x END) FROM t', rewritten: true,
      });
    });
  });

  describe('rewriteFilter — STRING_AGG and ordering', () => {
    it('rewrites STRING_AGG with an explicit delimiter', () => {
      expect(rewriteFilter("SELECT string_agg(x, ',') FILTER (WHERE x IS NOT NULL) FROM t")).toEqual({
        sql: "SELECT string_agg(CASE WHEN (x IS NOT NULL) THEN x END, ',') FROM t", rewritten: true,
      });
    });
    it('rewrites STRING_AGG with no explicit delimiter', () => {
      expect(rewriteFilter('SELECT string_agg(x) FILTER (WHERE x > 0) FROM t')).toEqual({
        sql: 'SELECT string_agg(CASE WHEN (x > 0) THEN x END) FROM t', rewritten: true,
      });
    });
    it('rewrites array_agg(x ORDER BY y) FILTER', () => {
      expect(rewriteFilter('SELECT array_agg(x ORDER BY y) FILTER (WHERE x > 0) FROM t')).toEqual({
        sql: 'SELECT array_agg(CASE WHEN (x > 0) THEN x ORDER BY y END) FROM t', rewritten: true,
      });
    });
    it('handles an escaped quote inside a STRING_AGG delimiter', () => {
      expect(rewriteFilter("SELECT string_agg(x, ',''') FILTER (WHERE x > 0) FROM t")).toEqual({
        sql: "SELECT string_agg(CASE WHEN (x > 0) THEN x END, ',''') FROM t", rewritten: true,
      });
    });
  });

  describe('rewriteFilter — OVER clause', () => {
    it('rewrites FILTER with an OVER clause (no stray closing paren)', () => {
      const r = rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0) OVER (PARTITION BY y) FROM t');
      expect(r.rewritten).toBe(true);
      // Balance check: number of ( equals number of )
      expect((r.sql.match(/\(/g) || []).length).toBe((r.sql.match(/\)/g) || []).length);
      expect(r.sql).toBe(
        'SELECT SUM(CASE WHEN (x > 0) THEN x END) OVER (PARTITION BY y) FROM t',
      );
    });
    it('rewrites FILTER with OVER and no whitespace', () => {
      const r = rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0)OVER(PARTITION BY y)');
      expect(r.sql).toBe('SELECT SUM(CASE WHEN (x > 0) THEN x END) OVER(PARTITION BY y)');
    });
    it('rewrites FILTER with OVER and multiple spaces', () => {
      const r = rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0)   OVER (PARTITION BY y)');
      expect(r.sql).toBe('SELECT SUM(CASE WHEN (x > 0) THEN x END) OVER (PARTITION BY y)');
    });
  });

  describe('rewriteFilter — robustness', () => {
    it('rewrites nested function arguments', () => {
      expect(rewriteFilter('SELECT SUM(f(x, g(y))) FILTER (WHERE x > 0) FROM t')).toEqual({
        sql: 'SELECT SUM(CASE WHEN (x > 0) THEN f(x, g(y)) END) FROM t', rewritten: true,
      });
    });
    it('rewrites multiple FILTER clauses independently', () => {
      expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE x>0), AVG(y) FILTER (WHERE y>1) FROM t')).toEqual({
        sql: 'SELECT SUM(CASE WHEN (x>0) THEN x END), AVG(CASE WHEN (y>1) THEN y END) FROM t',
        rewritten: true,
      });
    });
    it('passes through SQL without FILTER', () => {
      expect(rewriteFilter('SELECT SUM(x) FROM t')).toEqual({
        sql: 'SELECT SUM(x) FROM t', rewritten: false,
      });
    });
    it('does NOT rewrite FILTER inside a string literal', () => {
      expect(rewriteFilter("SELECT 'FILTER (WHERE x > 0)'")).toEqual({
        sql: "SELECT 'FILTER (WHERE x > 0)'", rewritten: false,
      });
    });
    it('does NOT rewrite FILTER inside a comment', () => {
      expect(rewriteFilter('-- FILTER (WHERE x > 0)\nSELECT 1')).toEqual({
        sql: '-- FILTER (WHERE x > 0)\nSELECT 1', rewritten: false,
      });
    });
    it('handles a string FILTER alongside a real FILTER', () => {
      expect(rewriteFilter("SELECT SUM(x) FILTER (WHERE x > 0), 'FILTER (WHERE x)' FROM t")).toEqual({
        sql: "SELECT SUM(CASE WHEN (x > 0) THEN x END), 'FILTER (WHERE x)' FROM t",
        rewritten: true,
      });
    });
    it('rewrites nested FILTER clauses (innermost first, overlapping outer kept intact)', () => {
      // Two FILTER clauses whose rewrite spans overlap (the inner aggregate is
      // nested inside the outer). The dedup guard keeps the overlapping
      // replacement from corrupting indices, rewriting the inner FILTER while
      // leaving the outer one — a documented limitation of the scanner.
      const r = rewriteFilter('SELECT SUM(COUNT(x) FILTER (WHERE y > 0)) FILTER (WHERE x > 0) FROM t');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('COUNT(CASE WHEN (y > 0) THEN x END)');
    });
    it('handles empty / non-string input', () => {
      expect(rewriteFilter('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteFilter(null as any)).toEqual({ sql: '', rewritten: false });
    });
  });

  describe('rewriteFilter — defensive paths (no valid rewrite)', () => {
    it('does not rewrite FILTER with no opening paren', () => {
      expect(rewriteFilter('SELECT SUM(x) FILTER x > 0')).toEqual({
        sql: 'SELECT SUM(x) FILTER x > 0', rewritten: false,
      });
    });
    it('does not rewrite FILTER with unbalanced parens', () => {
      expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0')).toEqual({
        sql: 'SELECT SUM(x) FILTER (WHERE x > 0', rewritten: false,
      });
    });
    it('does not rewrite FILTER whose parens contain no WHERE', () => {
      expect(rewriteFilter('SELECT SUM(x) FILTER (x > 0)')).toEqual({
        sql: 'SELECT SUM(x) FILTER (x > 0)', rewritten: false,
      });
    });
    it('does not rewrite FILTER at the very start of input', () => {
      expect(rewriteFilter('FILTER (WHERE x > 0)')).toEqual({
        sql: 'FILTER (WHERE x > 0)', rewritten: false,
      });
    });
    it('does not rewrite FILTER not preceded by a closing paren', () => {
      expect(rewriteFilter('SELECT SUM(x FILTER (WHERE x > 0)')).toEqual({
        sql: 'SELECT SUM(x FILTER (WHERE x > 0)', rewritten: false,
      });
    });
    it('does not rewrite FILTER preceded by a non-aggregate function', () => {
      expect(rewriteFilter('SELECT foo(x) FILTER (WHERE x > 0)')).toEqual({
        sql: 'SELECT foo(x) FILTER (WHERE x > 0)', rewritten: false,
      });
    });
    it('does not rewrite FILTER with unbalanced agg parens', () => {
      expect(rewriteFilter('SELECT SUM(x FILTER (WHERE x > 0)')).toEqual({
        sql: 'SELECT SUM(x FILTER (WHERE x > 0)', rewritten: false,
      });
    });
    it('does not rewrite FILTER preceded by an unmatched closing paren', () => {
      expect(rewriteFilter('SELECT ) FILTER (WHERE x > 0)')).toEqual({
        sql: 'SELECT ) FILTER (WHERE x > 0)', rewritten: false,
      });
    });
    it('handles FILTER followed by OVER with unbalanced parens', () => {
      expect(rewriteFilter('SELECT SUM(x) FILTER (WHERE x > 0) OVER (PARTITION BY y')).toEqual({
        sql: 'SELECT SUM(CASE WHEN (x > 0) THEN x END) OVER (PARTITION BY y', rewritten: true,
      });
    });
  });

  describe('internal helpers', () => {
    it('_findMatchingParen finds a matching close and guards invalid input', () => {
      expect(_findMatchingParen('(a(b)c)', 0)).toBe(6);
      expect(_findMatchingParen('abc', -1)).toBe(-1);
      expect(_findMatchingParen('abc', 10)).toBe(-1);
      expect(_findMatchingParen('abc', 0)).toBe(-1); // not '('
      expect(_findMatchingParen('(unclosed', 0)).toBe(-1);
    });
    it('_findMatchingOpenParen finds a matching open and guards invalid input', () => {
      expect(_findMatchingOpenParen('(a(b)c)', 6)).toBe(0);
      expect(_findMatchingOpenParen('abc', -1)).toBe(-1);
      expect(_findMatchingOpenParen('abc', 10)).toBe(-1);
      expect(_findMatchingOpenParen('abc', 0)).toBe(-1); // not ')'
      expect(_findMatchingOpenParen('unclosed)', 8)).toBe(-1);
    });
    it('_topLevelSplit splits at top level respecting parens and strings', () => {
      expect(_topLevelSplit('a, b', ',')).toEqual(['a', 'b']);
      expect(_topLevelSplit('f(a, b), c', ',')).toEqual(['f(a, b)', 'c']);
      expect(_topLevelSplit("x, ',', y", ',')).toEqual(['x', "','", 'y']);
      expect(_topLevelSplit("x, 'it''s', y", ',')).toEqual(['x', "'it''s'", 'y']);
      expect(_topLevelSplit('single', ',')).toEqual(['single']);
      expect(_topLevelSplit('', ',')).toEqual([]);
    });
  });
});
