import { describe, it, expect } from 'vitest';
import {
  detectRangeType,
  detectRangeOperator,
  detectRangeFunc,
  isRangeType,
  rewriteRangeType,
  simplifyRangeExpr,
  expandRangeOperators,
  rewriteRangeFunc,
} from '../query/RangeTypeShim';

describe('RangeTypeShim', () => {
  describe('isRangeType', () => {
    it('recognizes range type names case-insensitively', () => {
      expect(isRangeType('int4range')).toBe(true);
      expect(isRangeType('INT8RANGE')).toBe(true);
      expect(isRangeType('numrange')).toBe(true);
      expect(isRangeType('tsrange')).toBe(true);
      expect(isRangeType('tstzrange')).toBe(true);
      expect(isRangeType('daterange')).toBe(true);
    });

    it('trims surrounding whitespace', () => {
      expect(isRangeType('  int4range  ')).toBe(true);
    });

    it('returns false for non-range and non-string', () => {
      expect(isRangeType('int')).toBe(false);
      expect(isRangeType('')).toBe(false);
      expect(isRangeType(null as any)).toBe(false);
      expect(isRangeType(undefined as any)).toBe(false);
      expect(isRangeType(42 as any)).toBe(false);
    });
  });

  describe('detectRangeType', () => {
    it('detects range type names', () => {
      expect(detectRangeType('CREATE TABLE t (r int4range)')).toBe(true);
      expect(detectRangeType('SELECT int8range(1,10)')).toBe(true);
      expect(detectRangeType('numrange(1,2)')).toBe(true);
    });

    it('does NOT detect inside string literals', () => {
      expect(detectRangeType("SELECT 'int4range'")).toBe(false);
    });

    it('does NOT detect inside comments', () => {
      expect(detectRangeType('-- int4range\nSELECT 1')).toBe(false);
      expect(detectRangeType('/* daterange */ SELECT 1')).toBe(false);
    });

    it('does NOT detect inside quoted identifiers', () => {
      expect(detectRangeType('SELECT "int4range" FROM t')).toBe(false);
    });

    it('returns false for non-string', () => {
      expect(detectRangeType('')).toBe(false);
      expect(detectRangeType(null as any)).toBe(false);
      expect(detectRangeType(undefined as any)).toBe(false);
    });
  });

  describe('detectRangeOperator', () => {
    it('detects range operators', () => {
      expect(detectRangeOperator('r @> 5')).toBe(true);
      expect(detectRangeOperator('5 <@ r')).toBe(true);
      expect(detectRangeOperator('a && b')).toBe(true);
      expect(detectRangeOperator('a -|- b')).toBe(true);
    });

    it('does NOT detect inside string literals or comments', () => {
      expect(detectRangeOperator("SELECT '@>'")).toBe(false);
      expect(detectRangeOperator('-- @>\nSELECT 1')).toBe(false);
    });

    it('returns false for non-string', () => {
      expect(detectRangeOperator('')).toBe(false);
      expect(detectRangeOperator(null as any)).toBe(false);
    });
  });

  describe('detectRangeFunc', () => {
    it('detects range boundary functions', () => {
      expect(detectRangeFunc('SELECT lower_inc(r) FROM t')).toBe(true);
      expect(detectRangeFunc('upper_inc(r)')).toBe(true);
      expect(detectRangeFunc('lower_inf(r)')).toBe(true);
      expect(detectRangeFunc('upper_inf(r)')).toBe(true);
      expect(detectRangeFunc('range_merge(r1, r2)')).toBe(true);
      expect(detectRangeFunc('range_intersect(r1, r2)')).toBe(true);
      expect(detectRangeFunc('range_union(r1, r2)')).toBe(true);
    });

    it('does NOT detect inside string literals or comments', () => {
      expect(detectRangeFunc("SELECT 'lower_inc(r)'")).toBe(false);
      expect(detectRangeFunc('-- range_merge(r1,r2)\nSELECT 1')).toBe(false);
    });

    it('returns false for empty / non-string', () => {
      expect(detectRangeFunc('')).toBe(false);
      expect(detectRangeFunc('   ')).toBe(false);
      expect(detectRangeFunc(null as any)).toBe(false);
    });
  });

  describe('rewriteRangeType', () => {
    it('rewrites range types in DDL to TEXT', () => {
      expect(rewriteRangeType('CREATE TABLE t (r int4range)')).toEqual({
        sql: 'CREATE TABLE t (r TEXT)', rewritten: true,
      });
    });

    it('rewrites multiple range types (case-insensitive)', () => {
      expect(rewriteRangeType('CREATE TABLE t (a INT4RANGE, b daterange)')).toEqual({
        sql: 'CREATE TABLE t (a TEXT, b TEXT)', rewritten: true,
      });
    });

    it('does NOT rewrite outside DDL', () => {
      expect(rewriteRangeType('SELECT int4range(1,2)')).toEqual({
        sql: 'SELECT int4range(1,2)', rewritten: false,
      });
    });

    it('does NOT rewrite a range type inside a string literal in DDL', () => {
      expect(rewriteRangeType("CREATE TABLE t (x TEXT DEFAULT 'int4range')")).toEqual({
        sql: "CREATE TABLE t (x TEXT DEFAULT 'int4range')", rewritten: false,
      });
    });

    it('returns false for non-string / no range type', () => {
      expect(rewriteRangeType('CREATE TABLE t (id INT)')).toEqual({
        sql: 'CREATE TABLE t (id INT)', rewritten: false,
      });
      expect(rewriteRangeType(null as any)).toEqual({ sql: null, rewritten: false });
    });
  });

  describe('simplifyRangeExpr', () => {
    it('rewrites two-arg numeric range constructor', () => {
      expect(simplifyRangeExpr('SELECT int4range(1,10)')).toEqual({
        sql: "SELECT '[' || 1 || ',' || 10 || ')'", rewritten: true,
      });
    });

    it('rewrites three-arg numeric range with bounds mode', () => {
      expect(simplifyRangeExpr("SELECT int4range(1,10,'[]')")).toEqual({
        sql: "SELECT '[' || 1 || ',' || 10 || ']'", rewritten: true,
      });
    });

    it('falls back to default bounds for empty / short bounds mode', () => {
      expect(simplifyRangeExpr("SELECT int4range(1,10,'')")).toEqual({
        sql: "SELECT '[' || 1 || ',' || 10 || ')'", rewritten: true,
      });
      expect(simplifyRangeExpr("SELECT int4range(1,10,'[')")).toEqual({
        sql: "SELECT '[' || 1 || ',' || 10 || ')'", rewritten: true,
      });
    });

    it('rewrites date range constructor', () => {
      expect(simplifyRangeExpr("SELECT daterange('2020-01-01','2020-12-31')")).toEqual({
        sql: "SELECT '[' || '2020-01-01' || ',' || '2020-12-31' || ')'", rewritten: true,
      });
    });

    it('does NOT rewrite a range call inside a string literal', () => {
      expect(simplifyRangeExpr("SELECT 'int4range(1,2)'")).toEqual({
        sql: "SELECT 'int4range(1,2)'", rewritten: false,
      });
    });

    it('does NOT rewrite inside a comment', () => {
      expect(simplifyRangeExpr('-- int4range(1,2)\nSELECT 1')).toEqual({
        sql: '-- int4range(1,2)\nSELECT 1', rewritten: false,
      });
    });

    it('returns false for non-string / no function call', () => {
      expect(simplifyRangeExpr('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
      expect(simplifyRangeExpr(null as any)).toEqual({ sql: null, rewritten: false });
    });

    it('leaves a range call that does not match the simple forms unchanged', () => {
      // Four-argument (or otherwise non-simple) constructor is out of scope.
      expect(simplifyRangeExpr('SELECT int4range(1,2,3,4)')).toEqual({
        sql: 'SELECT int4range(1,2,3,4)', rewritten: false,
      });
    });
  });

  describe('expandRangeOperators', () => {
    it('expands int4range @> scalar', () => {
      expect(expandRangeOperators('int4range(1,10) @> 5')).toEqual({
        sql: '(1 <= 5 AND 5 < 10)', rewritten: true,
      });
    });

    it('expands scalar <@ int4range', () => {
      expect(expandRangeOperators('5 <@ int4range(1,10)')).toEqual({
        sql: '(1 <= 5 AND 5 < 10)', rewritten: true,
      });
    });

    it('expands range @> range', () => {
      expect(expandRangeOperators('int4range(1,10) @> int4range(2,5)')).toEqual({
        sql: '(1 <= 2 AND 5 <= 10)', rewritten: true,
      });
    });

    it('expands range && range', () => {
      expect(expandRangeOperators('int4range(1,10) && int4range(5,15)')).toEqual({
        sql: '(1 < 15 AND 5 < 10)', rewritten: true,
      });
    });

    it('expands tsrange @> scalar', () => {
      expect(expandRangeOperators("tsrange('2020-01-01','2020-12-31') @> x")).toEqual({
        sql: "('2020-01-01' <= x AND x < '2020-12-31')", rewritten: true,
      });
    });

    it('expands scalar <@ daterange', () => {
      expect(expandRangeOperators("x <@ daterange('2020-01-01','2020-12-31')")).toEqual({
        sql: "('2020-01-01' <= x AND x < '2020-12-31')", rewritten: true,
      });
    });

    it('expands int8range @> scalar', () => {
      expect(expandRangeOperators('int8range(1,100) @> 50')).toEqual({
        sql: '(1 <= 50 AND 50 < 100)', rewritten: true,
      });
    });

    it('does NOT expand a range operator inside a string literal', () => {
      expect(expandRangeOperators("SELECT 'a @> b'")).toEqual({
        sql: "SELECT 'a @> b'", rewritten: false,
      });
    });

    it('leaves column-only operators unchanged (no range constructor)', () => {
      // Column references are stored as TEXT and require json_extract; this
      // shim only expands inline range constructor calls.
      expect(expandRangeOperators('a @> b')).toEqual({
        sql: 'a @> b', rewritten: false,
      });
      expect(expandRangeOperators('x <@ y')).toEqual({
        sql: 'x <@ y', rewritten: false,
      });
    });

    it('does NOT corrupt a function-call value (regression)', () => {
      // `foo(1,2)` is a function call, not a scalar; it must not be partially
      // matched as `fo` leaving a dangling `o(1,2)` suffix.
      expect(expandRangeOperators('int4range(a,b) @> foo(1,2)')).toEqual({
        sql: 'int4range(a,b) @> foo(1,2)', rewritten: false,
      });
    });

    it('returns false for non-string / no operator', () => {
      expect(expandRangeOperators('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
      expect(expandRangeOperators(null as any)).toEqual({ sql: null, rewritten: false });
    });
  });

  describe('rewriteRangeFunc', () => {
    it('rewrites lower_inc', () => {
      expect(rewriteRangeFunc('SELECT lower_inc(my_range) FROM t')).toEqual({
        sql: "SELECT SUBSTR(my_range, 1, 1) = '[' FROM t", rewritten: true,
      });
    });

    it('rewrites upper_inc', () => {
      expect(rewriteRangeFunc('upper_inc(r)')).toEqual({
        sql: "SUBSTR(r, LENGTH(r), 1) = ']'", rewritten: true,
      });
    });

    it('rewrites lower_inf', () => {
      expect(rewriteRangeFunc('lower_inf(r)')).toEqual({
        sql: "INSTR(r, ',') = 2", rewritten: true,
      });
    });

    it('rewrites upper_inf', () => {
      expect(rewriteRangeFunc('upper_inf(r)')).toEqual({
        sql: "SUBSTR(r, INSTR(r, ',') + 1, LENGTH(r) - INSTR(r, ',') - 2) = ''",
        rewritten: true,
      });
    });

    it('rewrites range_merge', () => {
      const r = rewriteRangeFunc('range_merge(r1, r2)');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('CASE WHEN');
    });

    it('rewrites range_intersect', () => {
      const r = rewriteRangeFunc('range_intersect(r1, r2)');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('CASE WHEN');
    });

    it('rewrites range_union', () => {
      const r = rewriteRangeFunc('range_union(r1, r2)');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('CASE WHEN');
    });

    it('does NOT rewrite a range function inside a string literal', () => {
      expect(rewriteRangeFunc("SELECT 'lower_inc(x)'")).toEqual({
        sql: "SELECT 'lower_inc(x)'", rewritten: false,
      });
    });

    it('returns false for non-string / no function', () => {
      expect(rewriteRangeFunc('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
      expect(rewriteRangeFunc(null as any)).toEqual({ sql: '', rewritten: false });
      expect(rewriteRangeFunc('   ')).toEqual({ sql: '   ', rewritten: false });
    });

    it('leaves a boundary function with an empty argument unchanged', () => {
      // `[^)]+` requires at least one character inside the parens.
      expect(rewriteRangeFunc('lower_inc()')).toEqual({
        sql: 'lower_inc()', rewritten: false,
      });
    });
  });
});
