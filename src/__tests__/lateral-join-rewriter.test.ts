import { describe, it, expect } from 'vitest';
import { detectLateral, rewriteLateral } from '../query/LateralJoinRewriter';

// LateralJoinRewriter rewrites LATERAL JOINs for SQLite compatibility while
// never touching LATERAL mentions inside string literals or comments.
describe('LateralJoinRewriter', () => {
  describe('detectLateral', () => {
    it('detects a real LATERAL keyword', () => {
      expect(detectLateral('SELECT * FROM LATERAL (SELECT 1)')).toBe(true);
    });

    // BUG #83 regression: a mention inside a literal/comment is not a keyword.
    it('does not report LATERAL inside a string literal', () => {
      expect(detectLateral("SELECT 'LATERAL'")).toBe(false);
    });

    it('does not report LATERAL inside a comment', () => {
      expect(detectLateral('-- LATERAL\nSELECT 1')).toBe(false);
    });

    it('returns false when no LATERAL is present', () => {
      expect(detectLateral('SELECT 1')).toBe(false);
    });
  });

  describe('rewriteLateral', () => {
    it('passes through when forceRewrite is not set (native LATERAL support)', () => {
      expect(rewriteLateral('SELECT * FROM LATERAL (SELECT 1)'))
        .toEqual({ sql: 'SELECT * FROM LATERAL (SELECT 1)', rewritten: false });
    });

    it('returns unchanged for SQL without LATERAL', () => {
      expect(rewriteLateral('SELECT 1', { forceRewrite: true }))
        .toEqual({ sql: 'SELECT 1', rewritten: false });
    });

    // A bare `FROM LATERAL (...)` has no left input to cross-join against, so
    // LATERAL must be dropped while FROM is preserved. The prior behavior
    // (rewriting to `SELECT * CROSS JOIN (...)`) omitted the FROM keyword and
    // produced SQLite "near CROSS" syntax errors.
    it('rewrites a bare FROM LATERAL to FROM (drops LATERAL)', () => {
      expect(rewriteLateral('SELECT * FROM LATERAL (SELECT 1) AS t', { forceRewrite: true }))
        .toEqual({ sql: 'SELECT * FROM (SELECT 1) AS t', rewritten: true });
    });

    it('rewrites a comma-separated LATERAL to CROSS JOIN', () => {
      expect(rewriteLateral('SELECT * FROM a, LATERAL (SELECT 1) AS t', { forceRewrite: true }))
        .toEqual({ sql: 'SELECT * FROM a CROSS JOIN (SELECT 1) AS t', rewritten: true });
    });

    it('rewrites JOIN LATERAL to INNER JOIN', () => {
      expect(rewriteLateral('CROSS JOIN LATERAL (SELECT 1)', { forceRewrite: true }))
        .toEqual({ sql: 'INNER JOIN (SELECT 1)', rewritten: true });
    });

    // BUG #81 regression: a string literal must not lose its content.
    it('preserves LATERAL inside a string literal (forceRewrite)', () => {
      expect(rewriteLateral("SELECT 'LATERAL'", { forceRewrite: true }))
        .toEqual({ sql: "SELECT 'LATERAL'", rewritten: false });
    });

    // BUG #82 regression: a comment must not be corrupted.
    it('preserves LATERAL inside a comment (forceRewrite)', () => {
      expect(rewriteLateral('-- LATERAL\nSELECT 1', { forceRewrite: true }))
        .toEqual({ sql: '-- LATERAL\nSELECT 1', rewritten: false });
    });

    it('strips a residual standalone LATERAL via the fallback', () => {
      expect(rewriteLateral('SELECT LATERAL foo', { forceRewrite: true }).sql)
        .toBe('SELECT  foo');
    });
  });
});

describe('rewriteLateral — comma-separated LATERAL (glue regression)', () => {
  it('keeps a space before CROSS JOIN when LATERAL follows a comma', () => {
    expect(rewriteLateral('SELECT * FROM t, LATERAL (SELECT 1) x', { forceRewrite: true }))
      .toEqual({ sql: 'SELECT * FROM t CROSS JOIN (SELECT 1) x', rewritten: true });
  });
});
