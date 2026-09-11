import { describe, it, expect } from 'vitest';
import {
  detectNullsFirstLast,
  rewriteNullsFirstLast,
} from '../query/NullsFirstLastShim';

// PostgreSQL supports ORDER BY ... NULLS FIRST/LAST, which SQLite does not.
// NullsFirstLastShim rewrites the non-default combinations into an explicit
// CASE expression that controls NULL placement independently per sort key.
//
// SQLite default: ASC sorts NULLs first, DESC sorts NULLs last. So only the two
// non-default cases (ASC NULLS LAST, DESC NULLS FIRST) require a CASE rewrite;
// the two default cases are collapsed by stripping the NULLS clause.
describe('NullsFirstLastShim', () => {
  describe('detectNullsFirstLast', () => {
    it('rejects non-string / empty input', () => {
      expect(detectNullsFirstLast('')).toBe(false);
      expect(detectNullsFirstLast(null as any)).toBe(false);
      expect(detectNullsFirstLast(undefined as any)).toBe(false);
    });

    it('rejects SQL without ORDER BY', () => {
      expect(detectNullsFirstLast('SELECT * FROM t')).toBe(false);
    });

    it('rejects ORDER BY without NULLS FIRST/LAST', () => {
      expect(detectNullsFirstLast('SELECT * FROM t ORDER BY a')).toBe(false);
    });

    it('detects NULLS LAST', () => {
      expect(detectNullsFirstLast('SELECT * FROM t ORDER BY a NULLS LAST')).toBe(true);
    });

    it('detects NULLS FIRST (case-insensitive)', () => {
      expect(detectNullsFirstLast('SELECT * FROM t ORDER BY a nulls first')).toBe(true);
    });
  });

  describe('rewriteNullsFirstLast', () => {
    it('returns original SQL when there is nothing to rewrite', () => {
      const r = rewriteNullsFirstLast('SELECT * FROM t ORDER BY a');
      expect(r).toEqual({ sql: 'SELECT * FROM t ORDER BY a', rewritten: false, count: 0 });
    });

    it('handles null/non-string input gracefully', () => {
      expect(rewriteNullsFirstLast(null as any)).toEqual({
        sql: '', rewritten: false, count: 0,
      });
      expect(rewriteNullsFirstLast('' as any)).toEqual({
        sql: '', rewritten: false, count: 0,
      });
    });

    it('rewrites ASC NULLS LAST (non-default) with a NULL-last CASE', () => {
      const r = rewriteNullsFirstLast('SELECT * FROM t ORDER BY name NULLS LAST');
      expect(r.rewritten).toBe(true);
      expect(r.count).toBe(1);
      expect(r.sql).toBe(
        'SELECT * FROM t ORDER BY (CASE WHEN name IS NULL THEN 1 ELSE 0 END), name ASC',
      );
    });

    it('rewrites DESC NULLS FIRST (non-default) with a NULL-first CASE', () => {
      const r = rewriteNullsFirstLast('SELECT * FROM t ORDER BY name DESC NULLS FIRST');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe(
        'SELECT * FROM t ORDER BY (CASE WHEN name IS NULL THEN 0 ELSE 1 END), name DESC',
      );
    });

    it('collapses ASC NULLS FIRST to plain ASC (SQLite default)', () => {
      const r = rewriteNullsFirstLast('SELECT * FROM t ORDER BY name NULLS FIRST');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe('SELECT * FROM t ORDER BY name ASC');
    });

    it('collapses DESC NULLS LAST to plain DESC (SQLite default)', () => {
      const r = rewriteNullsFirstLast('SELECT * FROM t ORDER BY name DESC NULLS LAST');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe('SELECT * FROM t ORDER BY name DESC');
    });

    it('rewrites each sort key independently in a multi-column ORDER BY', () => {
      const r = rewriteNullsFirstLast(
        'SELECT * FROM t ORDER BY a DESC NULLS FIRST, b ASC NULLS LAST',
      );
      expect(r.count).toBe(2);
      expect(r.sql).toBe(
        'SELECT * FROM t ORDER BY (CASE WHEN a IS NULL THEN 0 ELSE 1 END), a DESC, '
        + '(CASE WHEN b IS NULL THEN 1 ELSE 0 END), b ASC',
      );
    });

    it('handles a parenthesized sort key expression', () => {
      const r = rewriteNullsFirstLast('SELECT * FROM t ORDER BY (a+b) NULLS LAST');
      expect(r.sql).toBe(
        'SELECT * FROM t ORDER BY (CASE WHEN (a+b) IS NULL THEN 1 ELSE 0 END), (a+b) ASC',
      );
    });

    it('handles an aggregate sort key', () => {
      const r = rewriteNullsFirstLast('SELECT * FROM t ORDER BY SUM(x) DESC NULLS FIRST');
      expect(r.sql).toBe(
        'SELECT * FROM t ORDER BY (CASE WHEN SUM(x) IS NULL THEN 0 ELSE 1 END), SUM(x) DESC',
      );
    });

    it('does not split on a comma inside a string literal', () => {
      const r = rewriteNullsFirstLast("SELECT * FROM t ORDER BY SUBSTR(name, 'a,b') NULLS LAST");
      expect(r.count).toBe(1);
      expect(r.sql).toBe(
        "SELECT * FROM t ORDER BY (CASE WHEN SUBSTR(name, 'a,b') IS NULL THEN 1 ELSE 0 END), SUBSTR(name, 'a,b') ASC",
      );
    });

    it('does not split on a comma inside a quoted identifier', () => {
      const r = rewriteNullsFirstLast('SELECT * FROM t ORDER BY "col, name" NULLS LAST');
      expect(r.count).toBe(1);
      expect(r.sql).toBe(
        'SELECT * FROM t ORDER BY (CASE WHEN "col, name" IS NULL THEN 1 ELSE 0 END), "col, name" ASC',
      );
    });

    it('preserves an escaped single quote inside a string literal', () => {
      const r = rewriteNullsFirstLast(
        "SELECT * FROM t ORDER BY CASE WHEN name = 'it''s' THEN 1 ELSE 0 END NULLS LAST",
      );
      expect(r.count).toBe(1);
      expect(r.sql).toContain("name = 'it''s'");
    });

    it('leaves a NULLS-less leading sort key intact while rewriting a later key', () => {
      const r = rewriteNullsFirstLast('SELECT * FROM t ORDER BY a, b NULLS LAST');
      expect(r.count).toBe(1);
      expect(r.sql).toBe(
        'SELECT * FROM t ORDER BY a ASC, (CASE WHEN b IS NULL THEN 1 ELSE 0 END), b ASC',
      );
    });

    it('preserves an escaped quote inside a quoted identifier', () => {
      const r = rewriteNullsFirstLast('SELECT * FROM t ORDER BY "col\\"x" NULLS LAST');
      expect(r.count).toBe(1);
      expect(r.sql).toBe(
        'SELECT * FROM t ORDER BY (CASE WHEN "col\\"x" IS NULL THEN 1 ELSE 0 END), "col\\"x" ASC',
      );
    });

    it('falls back gracefully on a malformed trailing comma (no rewrite, no throw)', () => {
      const r = rewriteNullsFirstLast('SELECT * FROM t ORDER BY a NULLS LAST,');
      expect(r.rewritten).toBe(false);
      expect(r.count).toBe(0);
    });
  });
});
