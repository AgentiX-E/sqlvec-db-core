import { describe, it, expect } from 'vitest';
import {
  parseCreateFunction,
  detectCreateFunction,
  detectDropFunction,
  extractDropFunctionName,
} from '../query/CreateFunctionHandler';

// CreateFunctionHandler parses CREATE FUNCTION and detects DROP FUNCTION.
describe('CreateFunctionHandler', () => {
  describe('parseCreateFunction', () => {
    it('parses a dollar-quoted function with params and return type', () => {
      const fn = parseCreateFunction('CREATE FUNCTION add(a int, b int) RETURNS int AS $$ RETURN a+b; $$ LANGUAGE plpgsql;');
      expect(fn).toEqual({
        name: 'add',
        params: 'a int, b int',
        paramCount: 2,
        returnType: 'int',
        body: 'RETURN a+b;',
        isReplace: false,
      });
    });

    it('parses CREATE OR REPLACE', () => {
      const fn = parseCreateFunction('CREATE OR REPLACE FUNCTION f() RETURNS text AS $body$ hi $body$');
      expect(fn?.isReplace).toBe(true);
      expect(fn?.name).toBe('f');
      expect(fn?.body).toBe('hi');
    });

    it('parses a named dollar-quote tag', () => {
      const fn = parseCreateFunction('CREATE FUNCTION f() RETURNS text AS $myfunc$ hello $myfunc$');
      expect(fn?.body).toBe('hello');
    });

    it('accepts a dollar token inside the body that is not a tag', () => {
      const fn = parseCreateFunction('CREATE FUNCTION f() RETURNS text AS $$ a $ b $$');
      expect(fn?.body).toBe('a $ b');
    });

    it('defaults return type to text when omitted', () => {
      const fn = parseCreateFunction('CREATE FUNCTION h() $$ x $$');
      expect(fn?.returnType).toBe('text');
      expect(fn?.body).toBe('x');
      expect(fn?.paramCount).toBe(0);
    });

    it('parses a bare (non-dollar-quoted) body', () => {
      const fn = parseCreateFunction('CREATE FUNCTION g() SELECT 1');
      expect(fn?.name).toBe('g');
      expect(fn?.body).toBe('SELECT 1');
      expect(fn?.returnType).toBe('text');
    });

    it('parses a bare body with a simple return type', () => {
      const fn = parseCreateFunction('CREATE FUNCTION f() RETURNS int SELECT 1');
      expect(fn?.returnType).toBe('int');
      expect(fn?.body).toBe('SELECT 1');
    });

    it('parses a bare form with no body (empty body fallback)', () => {
      const fn = parseCreateFunction('CREATE FUNCTION f()');
      expect(fn?.name).toBe('f');
      expect(fn?.body).toBe('');
      expect(fn?.returnType).toBe('text');
      expect(fn?.paramCount).toBe(0);
    });

    // BUG #79 regression: composite return types must be captured, not fail.
    it('parses a numeric(precision,scale) return type', () => {
      const fn = parseCreateFunction('CREATE FUNCTION f() RETURNS numeric(10,2) AS $$ 1 $$');
      expect(fn?.returnType).toBe('numeric(10,2)');
    });

    it('parses varchar(len) and character varying return types', () => {
      expect(parseCreateFunction('CREATE FUNCTION f() RETURNS varchar(50) AS $$ 1 $$')?.returnType)
        .toBe('varchar(50)');
      expect(parseCreateFunction('CREATE FUNCTION f() RETURNS character varying AS $$ 1 $$')?.returnType)
        .toBe('character varying');
    });

    it('parses TABLE(...) and SETOF return types', () => {
      expect(parseCreateFunction('CREATE FUNCTION f() RETURNS TABLE(id int) AS $$ 1 $$')?.returnType)
        .toBe('TABLE(id int)');
      expect(parseCreateFunction('CREATE FUNCTION f() RETURNS SETOF int AS $$ 1 $$')?.returnType)
        .toBe('SETOF int');
    });

    it('parses an array return type', () => {
      expect(parseCreateFunction('CREATE FUNCTION f() RETURNS int[] AS $$ 1 $$')?.returnType)
        .toBe('int[]');
    });

    it('returns null for non-CREATE-FUNCTION or malformed input', () => {
      expect(parseCreateFunction('SELECT 1')).toBeNull();
      expect(parseCreateFunction('')).toBeNull();
      expect(parseCreateFunction('   ')).toBeNull();
    });

    it('returns null when a dollar-quoted body exists but the prefix is malformed', () => {
      // `NOTHERE` cannot be matched by the prefix grammar → null.
      expect(parseCreateFunction('CREATE FUNCTION f(a) NOTHERE AS $$ x $$')).toBeNull();
    });

    it('returns null when the bare form is missing a function name', () => {
      expect(parseCreateFunction('CREATE FUNCTION')).toBeNull();
    });

    it('falls back to the bare form when a dollar quote lacks a closing tag', () => {
      // An unclosed `$$` makes findDollarQuote return null, so the statement is
      // parsed as a bare-body function that keeps the AS/$$ text as its body.
      const fn = parseCreateFunction('CREATE FUNCTION f() RETURNS int AS $$ unterminated');
      expect(fn?.name).toBe('f');
      expect(fn?.returnType).toBe('int');
      expect(fn?.body).toBe('AS $$ unterminated');
    });
  });

  describe('detectCreateFunction', () => {
    it('detects a CREATE FUNCTION', () => {
      expect(detectCreateFunction('CREATE FUNCTION f()')).toBe(true);
    });

    it('detects CREATE OR REPLACE FUNCTION', () => {
      expect(detectCreateFunction('CREATE OR REPLACE FUNCTION f()')).toBe(true);
    });

    it('does not detect a non-function statement', () => {
      expect(detectCreateFunction('SELECT 1')).toBe(false);
    });
  });

  describe('detectDropFunction', () => {
    it('detects DROP FUNCTION', () => {
      expect(detectDropFunction('DROP FUNCTION f')).toBe(true);
    });

    it('detects DROP FUNCTION IF EXISTS', () => {
      expect(detectDropFunction('DROP FUNCTION IF EXISTS f')).toBe(true);
    });

    // BUG #80 regression: reject the invalid IF NOT EXISTS form instead of
    // misreading IF as the function name.
    it('does not detect DROP FUNCTION IF NOT EXISTS (invalid form)', () => {
      expect(detectDropFunction('DROP FUNCTION IF NOT EXISTS f')).toBe(false);
    });

    it('does not detect a bare DROP FUNCTION without a name', () => {
      expect(detectDropFunction('DROP FUNCTION')).toBe(false);
    });
  });

  describe('extractDropFunctionName', () => {
    it('extracts a plain function name', () => {
      expect(extractDropFunctionName('DROP FUNCTION f')).toBe('f');
    });

    it('extracts a name after IF EXISTS', () => {
      expect(extractDropFunctionName('DROP FUNCTION IF EXISTS myfn')).toBe('myfn');
    });

    it('returns null for the invalid IF NOT EXISTS form', () => {
      expect(extractDropFunctionName('DROP FUNCTION IF NOT EXISTS f')).toBeNull();
    });

    it('returns null for a non-DROP statement', () => {
      expect(extractDropFunctionName('SELECT 1')).toBeNull();
    });
  });
});
