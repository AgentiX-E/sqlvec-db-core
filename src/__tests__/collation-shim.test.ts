import { describe, it, expect } from 'vitest';
import { stripCollate, hasCollate } from '../query/CollationShim';

// CollationShim strips COLLATE clauses (unsupported by SQLite) while preserving
// any COLLATE text that appears inside string literals, identifiers, or comments.
describe('CollationShim', () => {
  describe('stripCollate', () => {
    it('strips COLLATE from ORDER BY', () => {
      expect(stripCollate('SELECT * FROM t ORDER BY name COLLATE "C"'))
        .toBe('SELECT * FROM t ORDER BY name');
    });

    it('strips COLLATE from a column definition', () => {
      expect(stripCollate('CREATE TABLE t (name TEXT COLLATE "C")'))
        .toBe('CREATE TABLE t (name TEXT)');
    });

    it('strips COLLATE from a comparison expression', () => {
      expect(stripCollate("name COLLATE \"C\" > 'foo'"))
        .toBe("name > 'foo'");
    });

    it('strips COLLATE with a bare identifier (not quoted)', () => {
      expect(stripCollate('SELECT x COLLATE my_collation FROM t'))
        .toBe('SELECT x FROM t');
    });

    it('strips COLLATE when no collation name is quoted (multi-word)', () => {
      // `COLLATE "C"` inside a larger expression is still removed.
      expect(stripCollate('GROUP BY name COLLATE "en_US"'))
        .toBe('GROUP BY name');
    });

    // BUG #64 regression: COLLATE inside literals/comments must be preserved.
    it('preserves COLLATE text inside a string literal', () => {
      expect(stripCollate("SELECT 'x COLLATE C' AS t"))
        .toBe("SELECT 'x COLLATE C' AS t");
    });

    it('preserves COLLATE text inside a single-line comment', () => {
      expect(stripCollate('-- COLLATE "C"\nSELECT 1'))
        .toBe('-- COLLATE "C"\nSELECT 1');
    });

    it('preserves COLLATE text inside a quoted identifier', () => {
      expect(stripCollate('SELECT "col COLLATE C" FROM t'))
        .toBe('SELECT "col COLLATE C" FROM t');
    });

    it('preserves COLLATE text inside a multi-line comment', () => {
      expect(stripCollate('SELECT 1 /* COLLATE C */'))
        .toBe('SELECT 1 /* COLLATE C */');
    });
  });

  describe('hasCollate', () => {
    it('detects a COLLATE clause', () => {
      expect(hasCollate('ORDER BY name COLLATE "C"')).toBe(true);
    });

    it('returns false when no COLLATE clause is present', () => {
      expect(hasCollate('SELECT 1')).toBe(false);
    });

    // BUG #65 regression: repeated calls must be deterministic (no lastIndex leak).
    it('returns the same result across repeated calls', () => {
      const sql = 'a COLLATE b';
      expect(hasCollate(sql)).toBe(true);
      expect(hasCollate(sql)).toBe(true);
      expect(hasCollate('SELECT 1')).toBe(false);
      expect(hasCollate(sql)).toBe(true);
    });

    // BUG: hasCollate must shield literals/comments (agree with stripCollate).
    it('does not report COLLATE inside a string literal', () => {
      expect(hasCollate("SELECT 'x COLLATE \"C\" y' AS lit")).toBe(false);
    });

    it('does not report COLLATE inside a single-line comment', () => {
      expect(hasCollate('-- x COLLATE "C"\nSELECT 1')).toBe(false);
    });

    it('does not report COLLATE inside a quoted identifier', () => {
      expect(hasCollate('SELECT "col COLLATE C" FROM t')).toBe(false);
    });

    it('reports COLLATE that precedes the DESC/ASC keyword', () => {
      expect(hasCollate('ORDER BY name COLLATE "C" DESC')).toBe(true);
    });
  });
});
