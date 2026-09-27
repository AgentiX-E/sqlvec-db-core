import { describe, it, expect } from 'vitest';
import {
  detectCompositeType,
  detectRowFieldAccess,
  detectRowConstructor,
  rewriteCompositeType,
  findMatchingCloseParen,
  createNoOpResult,
  getRegisteredTypes,
} from '../query/CompositeTypeShim';

describe('CompositeTypeShim', () => {
  describe('detectCompositeType', () => {
    it('detects composite type DDL', () => {
      expect(detectCompositeType('CREATE TYPE p AS (a INT, b TEXT)')).toBe(true);
      expect(detectCompositeType('CREATE TYPE addr AS (street TEXT)')).toBe(true);
    });
    it('excludes ENUM variants', () => {
      expect(detectCompositeType("CREATE TYPE mood AS ENUM ('a','b')")).toBe(false);
    });
    it('returns false for non-composite / empty / non-string', () => {
      expect(detectCompositeType('SELECT 1')).toBe(false);
      expect(detectCompositeType('')).toBe(false);
      expect(detectCompositeType(null as any)).toBe(false);
      expect(detectCompositeType(42 as any)).toBe(false);
    });
    it('does not match a composite DDL inside a string literal', () => {
      expect(detectCompositeType("SELECT 'CREATE TYPE p AS (a INT)'")).toBe(false);
    });
  });

  describe('detectRowFieldAccess', () => {
    it('detects (expr).field', () => {
      expect(detectRowFieldAccess('SELECT (t).id FROM x')).toBe(true);
      expect(detectRowFieldAccess('SELECT (func(x)).min')).toBe(true);
    });
    it('returns false for no field access', () => {
      expect(detectRowFieldAccess('SELECT id FROM t')).toBe(false);
      expect(detectRowFieldAccess('')).toBe(false);
      expect(detectRowFieldAccess(null as any)).toBe(false);
    });
    it('does not match inside a string literal', () => {
      expect(detectRowFieldAccess("SELECT '(t).id'")).toBe(false);
    });
    it('does not match inside a comment', () => {
      expect(detectRowFieldAccess('-- (t).id\nSELECT 1')).toBe(false);
    });
    it('is stateless across repeated calls', () => {
      expect(detectRowFieldAccess('SELECT (t).id')).toBe(true);
      expect(detectRowFieldAccess('SELECT 1')).toBe(false);
      expect(detectRowFieldAccess('SELECT (t).id')).toBe(true);
    });
  });

  describe('detectRowConstructor', () => {
    it('detects ROW(...)', () => {
      expect(detectRowConstructor('SELECT ROW(1, 2)')).toBe(true);
      expect(detectRowConstructor('SELECT ROW()')).toBe(true);
    });
    it('returns false for no ROW constructor', () => {
      expect(detectRowConstructor('SELECT 1')).toBe(false);
      expect(detectRowConstructor('')).toBe(false);
      expect(detectRowConstructor(null as any)).toBe(false);
    });
    it('does not match inside a string literal', () => {
      expect(detectRowConstructor("SELECT 'ROW(1,2)'")).toBe(false);
    });
  });

  describe('rewriteCompositeType', () => {
    it('rewrites CREATE TYPE AS (...) to SELECT 1', () => {
      expect(rewriteCompositeType('CREATE TYPE p AS (a INT, b TEXT)')).toEqual({
        sql: 'SELECT 1', rewritten: true,
      });
    });
    it('handles type arguments like DECIMAL(10,2)', () => {
      const r = rewriteCompositeType('CREATE TYPE p AS (amount DECIMAL(10,2), tags VARCHAR(255))');
      expect(r.sql).toBe('SELECT 1');
      expect(r.rewritten).toBe(true);
    });
    it('rewrites (expr).field to json_extract', () => {
      expect(rewriteCompositeType('SELECT (t).id, (f(x)).name')).toEqual({
        sql: "SELECT json_extract(t, '$.id'), json_extract(f(x), '$.name')",
        rewritten: true,
      });
    });
    it('rewrites ROW(...) to json_object', () => {
      expect(rewriteCompositeType('SELECT ROW(1, 2, 3)')).toEqual({
        sql: "SELECT json_object('f1', 1, 'f2', 2, 'f3', 3)",
        rewritten: true,
      });
    });
    it('handles nested parens inside ROW args', () => {
      expect(rewriteCompositeType('SELECT ROW(1, (2+3))')).toEqual({
        sql: "SELECT json_object('f1', 1, 'f2', (2+3))",
        rewritten: true,
      });
    });
    it('handles commas inside string literals in ROW args', () => {
      expect(rewriteCompositeType("SELECT ROW('a,b', 2)")).toEqual({
        sql: "SELECT json_object('f1', 'a,b', 'f2', 2)",
        rewritten: true,
      });
    });
    it('does not rewrite field access inside a string literal', () => {
      expect(rewriteCompositeType("SELECT '(t).id'")).toEqual({
        sql: "SELECT '(t).id'", rewritten: false,
      });
    });
    it('does not rewrite ROW inside a string literal', () => {
      expect(rewriteCompositeType("SELECT 'ROW(1,2)'")).toEqual({
        sql: "SELECT 'ROW(1,2)'", rewritten: false,
      });
    });
    it('passes through non-composite SQL', () => {
      expect(rewriteCompositeType('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    });
    it('handles empty / non-string', () => {
      expect(rewriteCompositeType('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteCompositeType(null as any)).toEqual({ sql: null, rewritten: false });
    });

    it('handles an unterminated composite type paren (closeParen -1)', () => {
      // No matching close paren → no rewrite, passes through.
      expect(rewriteCompositeType('CREATE TYPE p AS (a INT').rewritten).toBe(false);
    });

    it('registers nothing for an empty attribute list', () => {
      const before = getRegisteredTypes().length;
      rewriteCompositeType('CREATE TYPE empty_t AS ()');
      expect(getRegisteredTypes().length).toBe(before);
    });

    it('handles (expr) without a field (no .identifier)', () => {
      // A parenthesized expression not followed by `.field` is untouched.
      expect(rewriteCompositeType('SELECT (a + b)')).toEqual({
        sql: 'SELECT (a + b)', rewritten: false,
      });
    });

    it('handles (expr). followed by a non-identifier', () => {
      // `.123` is not a valid field identifier, so no rewrite.
      expect(rewriteCompositeType('SELECT (t).123')).toEqual({
        sql: 'SELECT (t).123', rewritten: false,
      });
    });

    it('handles ROW not followed by a paren', () => {
      expect(rewriteCompositeType('SELECT ROW_NUMBER() OVER ()')).toEqual({
        sql: 'SELECT ROW_NUMBER() OVER ()', rewritten: false,
      });
    });

    it('handles an unterminated ROW constructor', () => {
      expect(rewriteCompositeType('SELECT ROW(1, 2')).toEqual({
        sql: 'SELECT ROW(1, 2', rewritten: false,
      });
    });

    it('handles ROW with empty args', () => {
      expect(rewriteCompositeType('SELECT ROW()')).toEqual({
        sql: 'SELECT json_object()', rewritten: true,
      });
    });
  });

  describe('findMatchingCloseParen', () => {
    it('finds the matching close paren with nesting', () => {
      expect(findMatchingCloseParen('(a(b)c)', 0)).toBe(6);
      expect(findMatchingCloseParen('(())', 0)).toBe(3);
    });
    it('returns -1 for invalid input', () => {
      expect(findMatchingCloseParen('abc', 0)).toBe(-1);
      expect(findMatchingCloseParen('(abc', 0)).toBe(-1);
      expect(findMatchingCloseParen('abc', -1)).toBe(-1);
      expect(findMatchingCloseParen('abc', 99)).toBe(-1);
    });
    it('does not count parens inside string literals', () => {
      // index 3's '(' is inside the string '(b'; the first real ')' at index 6 closes.
      expect(findMatchingCloseParen("(a'(b')c)", 0)).toBe(6);
    });
  });

  describe('createNoOpResult', () => {
    it('returns SELECT 1 for a standalone type', () => {
      expect(createNoOpResult('CREATE TYPE p AS (a INT)', 18, 24)).toBe('SELECT 1');
    });
    it('preserves trailing content after the paren', () => {
      const r = createNoOpResult('CREATE TYPE p AS (a INT); SELECT 5', 18, 24);
      expect(r).toContain('SELECT 1');
      expect(r).toContain('SELECT 5');
    });
    it('joins before and after with SELECT 1 in the middle', () => {
      // trailing-only content: before stripped to empty, after keeps 'SELECT 5'
      const r = createNoOpResult('CREATE TYPE p AS (a INT); SELECT 5', 18, 24);
      expect(r).toBe('SELECT 1; SELECT 5');
    });
  });

  describe('getRegisteredTypes', () => {
    it('returns registered type names after a rewrite', () => {
      rewriteCompositeType('CREATE TYPE addr AS (street TEXT, city TEXT)');
      expect(getRegisteredTypes()).toContain('addr');
    });
  });
});
