import { describe, it, expect } from 'vitest';
import { detectTextSearchFunc, rewriteTextSearchFunc } from '../query/TextSearchShim';

// TextSearchShim rewrites PG full-text-search functions to SQLite-compatible
// forms. Its matchers were previously bare; tests lock the literal/comment
// protection and every rewrite variant.
describe('TextSearchShim', () => {
  describe('detectTextSearchFunc', () => {
    it('detects each supported function', () => {
      expect(detectTextSearchFunc("SELECT setweight(v, 'A') FROM t")).toBe(true);
      expect(detectTextSearchFunc("SELECT ts_filter(v, '{a,b}') FROM t")).toBe(true);
      expect(detectTextSearchFunc('SELECT tsvector_to_array(v) FROM t')).toBe(true);
      expect(detectTextSearchFunc('SELECT array_to_tsvector(arr) FROM t')).toBe(true);
    });

    it('returns false for empty/non-string input', () => {
      expect(detectTextSearchFunc('')).toBe(false);
      expect(detectTextSearchFunc('   ')).toBe(false);
      expect(detectTextSearchFunc(undefined as unknown as string)).toBe(false);
    });

    it('returns false for unrelated SQL', () => {
      expect(detectTextSearchFunc('SELECT 1')).toBe(false);
    });

    it('does not report a function token inside a string literal or comment', () => {
      expect(detectTextSearchFunc("SELECT 'setweight(v, A)'")).toBe(false);
      expect(detectTextSearchFunc('SELECT 1 -- setweight(v, A)')).toBe(false);
    });
  });

  describe('rewriteTextSearchFunc', () => {
    it('rewrites setweight to its vector argument', () => {
      expect(rewriteTextSearchFunc("SELECT setweight(v, 'A') FROM t"))
        .toEqual({ sql: 'SELECT v FROM t', rewritten: true });
    });

    it('rewrites ts_filter to its vector argument', () => {
      expect(rewriteTextSearchFunc("SELECT ts_filter(v, '{a,b}') FROM t"))
        .toEqual({ sql: 'SELECT v FROM t', rewritten: true });
    });

    it('rewrites tsvector_to_array to COALESCE', () => {
      expect(rewriteTextSearchFunc('SELECT tsvector_to_array(v) FROM t'))
        .toEqual({ sql: "SELECT COALESCE(v, '[]') FROM t", rewritten: true });
    });

    it('rewrites array_to_tsvector to COALESCE', () => {
      expect(rewriteTextSearchFunc('SELECT array_to_tsvector(arr) FROM t'))
        .toEqual({ sql: "SELECT COALESCE(arr, '') FROM t", rewritten: true });
    });

    it('rewrites multiple functions in one statement', () => {
      expect(rewriteTextSearchFunc("SELECT setweight(a, 'A'), ts_filter(b, '{a}') FROM t"))
        .toEqual({ sql: 'SELECT a, b FROM t', rewritten: true });
    });

    it('passes through SQL with no text search function', () => {
      expect(rewriteTextSearchFunc('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    });

    it('passes through a malformed call that detect matches but rewrite cannot', () => {
      // detect matches the `setweight(` prefix, but the full-call regex needs
      // a comma + closing paren, so rewrite leaves it unchanged (rewritten=false).
      expect(rewriteTextSearchFunc('SELECT setweight(v FROM t'))
        .toEqual({ sql: 'SELECT setweight(v FROM t', rewritten: false });
    });

    it('returns blank passthrough for empty/non-string input', () => {
      expect(rewriteTextSearchFunc('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteTextSearchFunc(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    });

    // BUG #95/#96 regression: a function token inside a string literal or
    // comment must survive intact.
    it('passes through a function token inside a string literal', () => {
      expect(rewriteTextSearchFunc("SELECT 'setweight(v, A)'"))
        .toEqual({ sql: "SELECT 'setweight(v, A)'", rewritten: false });
    });

    it('passes through a function token inside a comment', () => {
      expect(rewriteTextSearchFunc('SELECT 1 -- setweight(v, A)'))
        .toEqual({ sql: 'SELECT 1 -- setweight(v, A)', rewritten: false });
    });
  });
});
