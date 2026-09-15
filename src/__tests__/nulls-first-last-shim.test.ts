import { describe, it, expect } from 'vitest';
import {
  detectNullsFirstLast,
  rewriteNullsFirstLast,
} from '../query/NullsFirstLastShim';

// NullsFirstLastShim rewrites ORDER BY ... NULLS FIRST/LAST into
// SQLite-compatible CASE expressions. Tests lock the literal/comment
// protection and the clause-boundary separator behavior.
describe('NullsFirstLastShim', () => {
  describe('detectNullsFirstLast', () => {
    it('detects ORDER BY with NULLS LAST', () => {
      expect(detectNullsFirstLast('SELECT * FROM t ORDER BY name NULLS LAST')).toBe(true);
    });

    it('detects NULLS FIRST with ASC', () => {
      expect(detectNullsFirstLast('SELECT * FROM t ORDER BY name ASC NULLS FIRST')).toBe(true);
    });

    it('returns false without NULLS clause', () => {
      expect(detectNullsFirstLast('SELECT * FROM t ORDER BY name ASC')).toBe(false);
    });

    it('returns false without ORDER BY', () => {
      expect(detectNullsFirstLast('SELECT * FROM t')).toBe(false);
    });

    it('returns false for empty or non-string input', () => {
      expect(detectNullsFirstLast('')).toBe(false);
      expect(detectNullsFirstLast(undefined as unknown as string)).toBe(false);
    });

    // BUG #98 regression: ORDER BY / NULLS inside a string or comment is not a
    // real clause and must not be reported.
    it('does not report ORDER BY ... NULLS inside a string or comment', () => {
      expect(detectNullsFirstLast("SELECT 'ORDER BY x NULLS LAST'")).toBe(false);
      expect(detectNullsFirstLast('SELECT 1 -- ORDER BY x NULLS LAST')).toBe(false);
    });
  });

  describe('rewriteNullsFirstLast', () => {
    it('rewrites ASC NULLS LAST into a CASE expression', () => {
      expect(rewriteNullsFirstLast('SELECT * FROM t ORDER BY name NULLS LAST'))
        .toEqual({
          sql: 'SELECT * FROM t ORDER BY (CASE WHEN name IS NULL THEN 1 ELSE 0 END), name ASC',
          rewritten: true,
          count: 1,
        });
    });

    it('strips NULLS FIRST for ASC (SQLite default)', () => {
      expect(rewriteNullsFirstLast('SELECT * FROM t ORDER BY name ASC NULLS FIRST'))
        .toEqual({
          sql: 'SELECT * FROM t ORDER BY name ASC',
          rewritten: true,
          count: 1,
        });
    });

    it('strips NULLS LAST for DESC (SQLite default)', () => {
      expect(rewriteNullsFirstLast('SELECT * FROM t ORDER BY name DESC NULLS LAST'))
        .toEqual({
          sql: 'SELECT * FROM t ORDER BY name DESC',
          rewritten: true,
          count: 1,
        });
    });

    it('rewrites DESC NULLS FIRST into a CASE expression', () => {
      expect(rewriteNullsFirstLast('SELECT * FROM t ORDER BY name DESC NULLS FIRST').sql)
        .toBe('SELECT * FROM t ORDER BY (CASE WHEN name IS NULL THEN 0 ELSE 1 END), name DESC');
    });

    it('preserves a function call with commas in the sort key', () => {
      expect(rewriteNullsFirstLast('SELECT * FROM t ORDER BY SUM(x, y) NULLS LAST').sql)
        .toBe('SELECT * FROM t ORDER BY (CASE WHEN SUM(x, y) IS NULL THEN 1 ELSE 0 END), SUM(x, y) ASC');
    });

    it('keeps a plain DESC sort item unchanged (no NULLS clause)', () => {
      expect(rewriteNullsFirstLast('SELECT * FROM t ORDER BY name DESC'))
        .toEqual({ sql: 'SELECT * FROM t ORDER BY name DESC', rewritten: false, count: 0 });
    });

    it('rewrites only the NULLS sort item and leaves the plain one intact', () => {
      const result = rewriteNullsFirstLast('SELECT * FROM t ORDER BY a NULLS LAST, b ASC');
      expect(result.sql).toBe(
        'SELECT * FROM t ORDER BY (CASE WHEN a IS NULL THEN 1 ELSE 0 END), a ASC, b ASC',
      );
      expect(result.count).toBe(1);
    });

    it('treats a NULLS clause in a later UNION branch as out of scope', () => {
      const result = rewriteNullsFirstLast(
        'SELECT * FROM a ORDER BY x ASC UNION SELECT * FROM b ORDER BY y NULLS LAST',
      );
      expect(result.rewritten).toBe(false);
      expect(result.count).toBe(0);
    });

    it('rewrites multiple mixed NULLS clauses independently', () => {
      const result = rewriteNullsFirstLast(
        'SELECT * FROM t ORDER BY a DESC NULLS FIRST, b ASC NULLS LAST',
      );
      expect(result.sql).toBe(
        'SELECT * FROM t ORDER BY (CASE WHEN a IS NULL THEN 0 ELSE 1 END), a DESC, (CASE WHEN b IS NULL THEN 1 ELSE 0 END), b ASC',
      );
      expect(result.count).toBe(2);
    });

    it('returns rewritten:false when there is no NULLS clause', () => {
      expect(rewriteNullsFirstLast('SELECT * FROM t ORDER BY name ASC'))
        .toEqual({ sql: 'SELECT * FROM t ORDER BY name ASC', rewritten: false, count: 0 });
    });

    it('handles empty and non-string input', () => {
      expect(rewriteNullsFirstLast('')).toEqual({ sql: '', rewritten: false, count: 0 });
      expect(rewriteNullsFirstLast(undefined as unknown as string))
        .toEqual({ sql: '', rewritten: false, count: 0 });
    });

    // BUG #100 regression: a trailing LIMIT/OFFSET must be separated from the
    // rewritten sort key by a space, not glued into `name ASCLIMIT 5`.
    it('preserves the separator before a trailing LIMIT/OFFSET', () => {
      expect(rewriteNullsFirstLast('SELECT * FROM t ORDER BY name NULLS LAST LIMIT 5').sql)
        .toBe('SELECT * FROM t ORDER BY (CASE WHEN name IS NULL THEN 1 ELSE 0 END), name ASC LIMIT 5');
      expect(rewriteNullsFirstLast('SELECT * FROM t ORDER BY name NULLS LAST OFFSET 5').sql)
        .toBe('SELECT * FROM t ORDER BY (CASE WHEN name IS NULL THEN 1 ELSE 0 END), name ASC OFFSET 5');
    });

    // BUG #99 regression: a NULLS token inside a string or comment must survive
    // intact and must not be treated as a real ORDER BY clause.
    it('leaves a string or comment containing ORDER BY ... NULLS intact', () => {
      expect(rewriteNullsFirstLast("SELECT 'ORDER BY x NULLS LAST'").sql)
        .toBe("SELECT 'ORDER BY x NULLS LAST'");
      expect(rewriteNullsFirstLast('SELECT 1 -- ORDER BY x NULLS LAST').sql)
        .toBe('SELECT 1 -- ORDER BY x NULLS LAST');
    });

    // A NULLS token inside a string literal used as a sort key must be preserved
    // while the real (outer) NULLS clause is still rewritten.
    it('preserves a string literal sort key containing NULLS', () => {
      expect(rewriteNullsFirstLast("SELECT * FROM t ORDER BY lower('NULLS LAST') NULLS FIRST").sql)
        .toBe("SELECT * FROM t ORDER BY lower('NULLS LAST') ASC");
    });
  });
});
