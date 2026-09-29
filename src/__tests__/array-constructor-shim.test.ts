import { describe, it, expect } from 'vitest';
import {
  detectArrayConstructor,
  rewriteArrayExpr,
  stripArrayType,
} from '../query/ArrayConstructorShim';

describe('detectArrayConstructor', () => {
  it('returns false for empty / non-string / blank', () => {
    expect(detectArrayConstructor('')).toBe(false);
    expect(detectArrayConstructor('   ')).toBe(false);
    expect(detectArrayConstructor(null as unknown as string)).toBe(false);
    expect(detectArrayConstructor(undefined as unknown as string)).toBe(false);
  });

  it('detects DDL array type annotations', () => {
    expect(detectArrayConstructor('CREATE TABLE t (ids int[])')).toBe(true);
    expect(detectArrayConstructor('col text[][]')).toBe(true);
    expect(detectArrayConstructor('varchar(255)[]')).toBe(true);
    expect(detectArrayConstructor('decimal(10,2)[]')).toBe(true);
  });

  it('detects ARRAY literal and subquery constructors', () => {
    expect(detectArrayConstructor('SELECT ARRAY[1,2,3]')).toBe(true);
    expect(detectArrayConstructor('ARRAY(SELECT x FROM t)')).toBe(true);
  });

  it('does not detect non-array SQL', () => {
    expect(detectArrayConstructor('SELECT 1')).toBe(false);
    expect(detectArrayConstructor('SELECT * FROM t')).toBe(false);
    expect(detectArrayConstructor('int')).toBe(false);
  });

  it('does not detect array syntax inside a string literal', () => {
    expect(detectArrayConstructor("SELECT 'ARRAY[1,2]' FROM t")).toBe(false);
    expect(detectArrayConstructor("SELECT 'int[]' AS t")).toBe(false);
  });

  it('does not detect array syntax inside a comment', () => {
    expect(detectArrayConstructor('-- ARRAY[1,2]\nSELECT 1')).toBe(false);
    expect(detectArrayConstructor('/* int[] */ SELECT 1')).toBe(false);
  });
});

describe('rewriteArrayExpr', () => {
  it('returns unchanged for empty / non-string / blank', () => {
    expect(rewriteArrayExpr('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteArrayExpr(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteArrayExpr('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites DDL array type annotations to TEXT', () => {
    expect(rewriteArrayExpr('CREATE TABLE t (ids int[])').sql).toBe('CREATE TABLE t (ids TEXT)');
    expect(rewriteArrayExpr('col text[][]').sql).toBe('col TEXT');
    expect(rewriteArrayExpr('ALTER TABLE t ALTER COLUMN c TYPE bigint[]').sql).toBe(
      'ALTER TABLE t ALTER COLUMN c TYPE TEXT',
    );
  });

  it('rewrites ARRAY[...] literals to json_array', () => {
    expect(rewriteArrayExpr('SELECT ARRAY[1, 2, 3]').sql).toBe('SELECT json_array(1, 2, 3)');
    expect(rewriteArrayExpr("SELECT ARRAY['a', 'b']").sql).toBe("SELECT json_array('a', 'b')");
  });

  it('rewrites ARRAY(SELECT ...) subqueries', () => {
    expect(rewriteArrayExpr('ARRAY(SELECT x FROM t)').sql).toBe(
      "(SELECT COALESCE(json_group_array(x), '[]') FROM t)",
    );
  });

  it('preserves DISTINCT / ALL in ARRAY subqueries', () => {
    expect(rewriteArrayExpr('ARRAY(SELECT DISTINCT x FROM t)').sql).toBe(
      "(SELECT COALESCE(json_group_array(DISTINCT x), '[]') FROM t)",
    );
    expect(rewriteArrayExpr('ARRAY(SELECT ALL x FROM t)').sql).toBe(
      "(SELECT COALESCE(json_group_array(ALL x), '[]') FROM t)",
    );
  });

  it('rewrites multiple ARRAY literals independently', () => {
    expect(rewriteArrayExpr('SELECT ARRAY[1,2], ARRAY[3,4]').sql).toBe(
      'SELECT json_array(1,2), json_array(3,4)',
    );
  });

  it('preserves array syntax inside a string literal', () => {
    expect(rewriteArrayExpr("SELECT 'ARRAY[1,2]' FROM t").rewritten).toBe(false);
    expect(rewriteArrayExpr("SELECT 'int[]' AS t").rewritten).toBe(false);
  });

  it('preserves array syntax inside comments', () => {
    expect(rewriteArrayExpr('-- ARRAY[1,2]\nSELECT 1').rewritten).toBe(false);
    expect(rewriteArrayExpr('/* int[] */ SELECT 1').rewritten).toBe(false);
  });

  it('keeps a closing bracket inside a string literal intact', () => {
    // Regression #360: ']' inside 'a]b' must not close the ARRAY bracket early.
    expect(rewriteArrayExpr("SELECT ARRAY['a]b', 'c']").sql).toBe(
      "SELECT json_array('a]b', 'c')",
    );
  });

  it('keeps a comma inside a string literal element intact', () => {
    expect(rewriteArrayExpr("SELECT ARRAY['a,b', 'c']").sql).toBe(
      "SELECT json_array('a,b', 'c')",
    );
  });

  it('does not corrupt nested ARRAY literals', () => {
    // Regression #361: nested ARRAY must be preserved cleanly, not mangled.
    expect(rewriteArrayExpr('SELECT ARRAY[ARRAY[1,2], ARRAY[3,4]]').sql).toBe(
      'SELECT json_array(ARRAY[1,2], ARRAY[3,4])',
    );
    expect(rewriteArrayExpr('SELECT ARRAY[1, ARRAY[2,3], 4]').sql).toBe(
      'SELECT json_array(1, ARRAY[2,3], 4)',
    );
  });

  it('handles a nested subquery in an ARRAY(SELECT ...)', () => {
    expect(rewriteArrayExpr('ARRAY(SELECT x FROM t WHERE a = (SELECT max(a) FROM t))').sql).toBe(
      "(SELECT COALESCE(json_group_array(x), '[]') FROM t WHERE a = (SELECT max(a) FROM t))",
    );
  });

  it('handles an escaped quote inside an ARRAY subquery', () => {
    expect(rewriteArrayExpr("ARRAY(SELECT x FROM t WHERE name = 'O''Brien')").sql).toBe(
      "(SELECT COALESCE(json_group_array(x), '[]') FROM t WHERE name = 'O''Brien')",
    );
  });

  it('skips an ARRAY literal with an unmatched bracket', () => {
    expect(rewriteArrayExpr('SELECT ARRAY[1, 2, 3 FROM t').rewritten).toBe(false);
  });

  it('skips an ARRAY subquery with an unmatched paren', () => {
    expect(rewriteArrayExpr('ARRAY(SELECT x FROM t').rewritten).toBe(false);
  });

  it('rewrites a SELECT-only ARRAY subquery with no clause boundary', () => {
    // e.g. ARRAY(SELECT 1) — no FROM/WHERE clause to anchor the boundary.
    expect(rewriteArrayExpr('ARRAY(SELECT 1)').sql).toBe(
      "(SELECT COALESCE(json_group_array(1), '[]'))",
    );
  });

  it('rewrites multiple ARRAY(SELECT ...) subqueries', () => {
    const r = rewriteArrayExpr(
      'SELECT ARRAY(SELECT a FROM t), ARRAY(SELECT b FROM u)',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe(
      "SELECT (SELECT COALESCE(json_group_array(a), '[]') FROM t), (SELECT COALESCE(json_group_array(b), '[]') FROM u)",
    );
  });
});

describe('stripArrayType', () => {
  it('returns unchanged for empty / non-string / blank', () => {
    expect(stripArrayType('')).toBe('');
    expect(stripArrayType(undefined as unknown as string)).toBe('');
    expect(stripArrayType('SELECT 1')).toBe('SELECT 1');
  });

  it('strips DDL array type annotations', () => {
    expect(stripArrayType('CREATE TABLE t (ids int[], name text)')).toBe(
      'CREATE TABLE t (ids TEXT, name text)',
    );
    expect(stripArrayType('col text[][]')).toBe('col TEXT');
    expect(stripArrayType('varchar(255)[]')).toBe('TEXT');
  });

  it('does not strip a type annotation inside a string literal', () => {
    expect(stripArrayType("SELECT 'int[]' AS t")).toBe("SELECT 'int[]' AS t");
  });
});
