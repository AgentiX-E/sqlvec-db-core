import { describe, it, expect } from 'vitest';
import { detectPgFuncSyntax, rewritePgFuncSyntax } from '../query/PgFuncSyntaxShim';

// PgFuncSyntaxShim rewrites PG keyword-style scalar calls (extract/substring/
// position) into comma-separated SQLite UDF form. Tests lock the keyword-separator
// handling, nested parens, quoted literals, and the no-op detection guard.
describe('PgFuncSyntaxShim', () => {
  describe('detectPgFuncSyntax', () => {
    it('detects extract(part FROM src)', () => {
      expect(detectPgFuncSyntax('SELECT extract(year FROM created_at) FROM t')).toBe(true);
    });
    it('detects position(needle IN haystack)', () => {
      expect(detectPgFuncSyntax("SELECT position('a' IN col) FROM t")).toBe(true);
    });
    it('detects substring(str FROM n FOR m)', () => {
      expect(detectPgFuncSyntax('SELECT substring(col FROM 2 FOR 3) FROM t')).toBe(true);
    });
    it('returns false for comma-style calls', () => {
      expect(detectPgFuncSyntax('SELECT extract(year, created_at) FROM t')).toBe(false);
    });
    it('returns false for non-string / empty', () => {
      expect(detectPgFuncSyntax(undefined as unknown as string)).toBe(false);
      expect(detectPgFuncSyntax('')).toBe(false);
    });
    it('does not flag a real FROM clause', () => {
      expect(detectPgFuncSyntax('SELECT * FROM t')).toBe(false);
    });
  });

  describe('rewritePgFuncSyntax', () => {
    it('rewrites extract(part FROM src) with quoted field', () => {
      expect(rewritePgFuncSyntax('SELECT extract(year FROM created_at) FROM t').sql)
        .toBe("SELECT extract('year', created_at) FROM t");
    });

    it('keeps an already-quoted extract field unchanged', () => {
      expect(rewritePgFuncSyntax("SELECT extract('year' FROM created_at) FROM t").sql)
        .toBe("SELECT extract('year', created_at) FROM t");
    });

    it('rewrites substring(str FROM start)', () => {
      expect(rewritePgFuncSyntax('SELECT substring(col FROM 2) FROM t').sql)
        .toBe('SELECT substring(col, 2) FROM t');
    });

    it('rewrites substring(str FROM start FOR len)', () => {
      expect(rewritePgFuncSyntax('SELECT substring(col FROM 2 FOR 3) FROM t').sql)
        .toBe('SELECT substring(col, 2, 3) FROM t');
    });

    it('rewrites position(needle IN haystack)', () => {
      expect(rewritePgFuncSyntax("SELECT position('a' IN col) FROM t").sql)
        .toBe("SELECT position('a', col) FROM t");
    });

    it('handles nested parentheses inside an argument', () => {
      expect(rewritePgFuncSyntax("SELECT position('a' IN lower(col)) FROM t").sql)
        .toBe("SELECT position('a', lower(col)) FROM t");
    });

    it('respects a quoted literal containing FROM/IN/FOR', () => {
      expect(rewritePgFuncSyntax("SELECT extract(part FROM 'a FROM b') FROM t").sql)
        .toBe("SELECT extract('part', 'a FROM b') FROM t");
    });

    it('rewrites multiple calls in one statement', () => {
      const sql = "SELECT extract(year FROM a), position('x' IN b) FROM t";
      expect(rewritePgFuncSyntax(sql).sql)
        .toBe("SELECT extract('year', a), position('x', b) FROM t");
    });

    it('leaves comma-style calls unchanged', () => {
      expect(rewritePgFuncSyntax('SELECT extract(year, created_at) FROM t'))
        .toEqual({ sql: 'SELECT extract(year, created_at) FROM t', rewritten: false });
    });

    it('leaves non-string input unchanged', () => {
      expect(rewritePgFuncSyntax(undefined as unknown as string))
        .toEqual({ sql: undefined, rewritten: false });
    });

    // Escaped-quote handling inside matchParen: a backslash-escaped quote must
    // not terminate the string scan early, so a `)` inside an escaped literal
    // is not mistaken for the closing paren.
    it('respects an escaped quote inside a string literal argument', () => {
      expect(rewritePgFuncSyntax("SELECT substring('a\\'b' FROM 2) FROM t").sql)
        .toBe("SELECT substring('a\\'b', 2) FROM t");
    });

    it('uses double-quoted identifiers as arguments without breaking the scan', () => {
      expect(rewritePgFuncSyntax('SELECT position("needle" IN "col") FROM t').sql)
        .toBe('SELECT position("needle", "col") FROM t');
    });

    // position without an IN separator is not a keyword-style call.
    it('leaves position(a, b) comma-style unchanged', () => {
      expect(rewritePgFuncSyntax('SELECT position(a, b) FROM t'))
        .toEqual({ sql: 'SELECT position(a, b) FROM t', rewritten: false });
    });

    // extract without a FROM separator is not rewritten.
    it('leaves extract(part) with no FROM unchanged', () => {
      expect(rewritePgFuncSyntax('SELECT extract(year) FROM t'))
        .toEqual({ sql: 'SELECT extract(year) FROM t', rewritten: false });
    });
  });
});
