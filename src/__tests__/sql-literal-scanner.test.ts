import { describe, it, expect } from 'vitest';
import { skipSqlLiteral, isInsideLiteral } from '../query/SqlLiteralScanner';

describe('SqlLiteralScanner', () => {
  describe('skipSqlLiteral', () => {
    it('skips a single-quoted string', () => {
      expect(skipSqlLiteral("'abc'", 0)).toBe(5);
    });

    it('skips a single-quoted string with a doubled-quote escape', () => {
      expect(skipSqlLiteral("'a''b'", 0)).toBe(6);
    });

    it('skips a single-quoted string with a backslash escape', () => {
      expect(skipSqlLiteral("'it\\'s'", 0)).toBe(7);
    });

    it('returns length for an unterminated single-quoted string', () => {
      expect(skipSqlLiteral("'abc", 0)).toBe(4);
    });

    it('skips a double-quoted identifier', () => {
      expect(skipSqlLiteral('"col"', 0)).toBe(5);
    });

    it('skips a double-quoted identifier with a doubled-quote escape', () => {
      expect(skipSqlLiteral('"a""b"', 0)).toBe(6);
    });

    it('returns length for an unterminated double-quoted identifier', () => {
      expect(skipSqlLiteral('"abc', 0)).toBe(4);
    });

    it('skips a line comment through end of line', () => {
      expect(skipSqlLiteral('-- hello\n', 0)).toBe(8);
    });

    it('skips a line comment at end of string (no newline)', () => {
      expect(skipSqlLiteral('-- hello', 0)).toBe(8);
    });

    it('skips a block comment', () => {
      expect(skipSqlLiteral('/* hi */', 0)).toBe(8);
    });

    it('returns length for an unterminated block comment', () => {
      expect(skipSqlLiteral('/* unterminated', 0)).toBe(15);
    });

    it('skips an anonymous dollar-quoted string', () => {
      expect(skipSqlLiteral('$$abc$$', 0)).toBe(7);
    });

    it('skips a tagged dollar-quoted string', () => {
      expect(skipSqlLiteral('$tag$abc$tag$', 0)).toBe(13);
    });

    it('returns length for an unterminated dollar-quoted string', () => {
      expect(skipSqlLiteral('$$abc', 0)).toBe(5);
    });

    it('returns -1 for a bare dollar sign that is not a dollar-quote', () => {
      expect(skipSqlLiteral('$1', 0)).toBe(-1);
    });

    it('returns -1 for an ordinary character', () => {
      expect(skipSqlLiteral('abc', 0)).toBe(-1);
    });
  });

  describe('isInsideLiteral', () => {
    it('detects a position inside a string literal', () => {
      expect(isInsideLiteral("SELECT 'x' FROM t", 8)).toBe(true);
    });

    it('detects a position before any literal as outside', () => {
      expect(isInsideLiteral('SELECT a', 3)).toBe(false);
    });

    it('detects a position after a completed literal as outside', () => {
      expect(isInsideLiteral("'abc' tail", 8)).toBe(false);
    });

    it('detects a position inside a dollar-quoted string', () => {
      expect(isInsideLiteral("SELECT $$ x $$ FROM t", 10)).toBe(true);
    });

    it('detects a position on the closing quote boundary as inside', () => {
      expect(isInsideLiteral("'ab'", 3)).toBe(true);
    });
  });
});
