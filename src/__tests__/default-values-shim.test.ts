import { describe, it, expect } from 'vitest';
import { stripDefaultValues } from '../query/DefaultValuesShim';

// DefaultValuesShim strips DEFAULT-valued columns from INSERT ... VALUES so
// SQLite can fall back to column defaults, while preserving non-DEFAULT values
// (including nested function calls and string literals).
describe('DefaultValuesShim', () => {
  describe('stripDefaultValues', () => {
    it('strips a single DEFAULT column and keeps the rest', () => {
      expect(stripDefaultValues("INSERT INTO t (id, name, created_at) VALUES (default, 'hello', default)"))
        .toBe("INSERT INTO t (name) VALUES ('hello')");
    });

    it('handles uppercase DEFAULT (case-insensitive)', () => {
      expect(stripDefaultValues("INSERT INTO t (a, b) VALUES (DEFAULT, 'x')"))
        .toBe("INSERT INTO t (b) VALUES ('x')");
    });

    it('returns unchanged when there is no DEFAULT', () => {
      expect(stripDefaultValues("INSERT INTO t (id, name) VALUES (1, 'x')"))
        .toBe("INSERT INTO t (id, name) VALUES (1, 'x')");
    });

    it('returns unchanged for non-INSERT SQL', () => {
      expect(stripDefaultValues('SELECT 1')).toBe('SELECT 1');
    });

    it('preserves a RETURNING suffix', () => {
      expect(stripDefaultValues("INSERT INTO t (a, b) VALUES (DEFAULT, 'x') RETURNING id"))
        .toBe("INSERT INTO t (b) VALUES ('x') RETURNING id");
    });

    // BUG #69 regression: nested function calls must not be truncated at the
    // first `)`. Previously the regex `[^)]+` stopped at `func(1,2)`'s inner
    // `)`, producing `VALUES (func(1,2) )`.
    it('preserves nested function calls in kept values', () => {
      expect(stripDefaultValues('INSERT INTO t (a, b) VALUES (DEFAULT, func(1,2))'))
        .toBe('INSERT INTO t (b) VALUES (func(1,2))');
    });

    it('preserves multiple nested function values', () => {
      expect(stripDefaultValues('INSERT INTO t (a, b, c) VALUES (DEFAULT, func(1,2), sub(3))'))
        .toBe('INSERT INTO t (b, c) VALUES (func(1,2), sub(3))');
    });

    it('preserves an escaped single quote with a comma inside a kept value', () => {
      expect(stripDefaultValues("INSERT INTO t (a, b) VALUES (DEFAULT, 'a''b,c')"))
        .toBe("INSERT INTO t (b) VALUES ('a''b,c')");
    });

    it('preserves a string literal containing parentheses', () => {
      expect(stripDefaultValues("INSERT INTO t (a, b) VALUES (DEFAULT, 'x)y')"))
        .toBe("INSERT INTO t (b) VALUES ('x)y')");
    });

    it('returns unchanged when all values are DEFAULT', () => {
      expect(stripDefaultValues('INSERT INTO t (a, b) VALUES (DEFAULT, DEFAULT)'))
        .toBe('INSERT INTO t (a, b) VALUES (DEFAULT, DEFAULT)');
    });

    // ── Error / degenerate inputs (early-return paths) ──

    it('returns unchanged when the column list is unterminated', () => {
      expect(stripDefaultValues('INSERT INTO t (a, b VALUES (DEFAULT, 1)'))
        .toBe('INSERT INTO t (a, b VALUES (DEFAULT, 1)');
    });

    it('returns unchanged when there is no VALUES clause', () => {
      expect(stripDefaultValues('INSERT INTO t (a) SELECT 1'))
        .toBe('INSERT INTO t (a) SELECT 1');
    });

    it('returns unchanged when the column and value counts differ', () => {
      expect(stripDefaultValues('INSERT INTO t (a, b) VALUES (DEFAULT)'))
        .toBe('INSERT INTO t (a, b) VALUES (DEFAULT)');
    });

    it('ignores a `)` inside a trailing line comment', () => {
      expect(stripDefaultValues('INSERT INTO t (a, b) VALUES (DEFAULT, 1) -- ) comment'))
        .toBe('INSERT INTO t (b) VALUES (1) -- ) comment');
    });

    it('returns unchanged when the VALUES list is unterminated', () => {
      expect(stripDefaultValues('INSERT INTO t (a) VALUES (DEFAULT, 1'))
        .toBe('INSERT INTO t (a) VALUES (DEFAULT, 1');
    });

    it('ignores a line comment inside the column list', () => {
      expect(stripDefaultValues('INSERT INTO t (a -- c\n, b) VALUES (DEFAULT, 1)'))
        .toBe('INSERT INTO t (b) VALUES (1)');
    });
  });
});
