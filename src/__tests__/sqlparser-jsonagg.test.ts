import { describe, it, expect } from 'vitest';
import { detectJsonAgg, rewriteJsonAgg } from '../query/JsonAggShim';

// JsonAggShim rewrites PostgreSQL SQL/JSON aggregate constructors
// (JSON_OBJECTAGG / JSON_ARRAYAGG) to SQLite-native json_group_object /
// json_group_array, while preserving literal text.
describe('JsonAggShim', () => {
  describe('rewriteJsonAgg', () => {
    it('rewrites JSON_OBJECTAGG(KEY k VALUE v) to json_group_object(k, v)', () => {
      expect(rewriteJsonAgg('SELECT JSON_OBJECTAGG(KEY k VALUE v) FROM t'))
        .toEqual({ sql: 'SELECT json_group_object(k, v) FROM t', rewritten: true });
    });

    it('rewrites JSON_ARRAYAGG(v) to json_group_array(v)', () => {
      expect(rewriteJsonAgg('SELECT JSON_ARRAYAGG(v) FROM t'))
        .toEqual({ sql: 'SELECT json_group_array(v) FROM t', rewritten: true });
    });

    it('preserves ORDER BY inside JSON_ARRAYAGG', () => {
      expect(rewriteJsonAgg('SELECT JSON_ARRAYAGG(v ORDER BY col) FROM t'))
        .toEqual({ sql: 'SELECT json_group_array(v ORDER BY col) FROM t', rewritten: true });
    });

    it('rewrites multiple occurrences in one query', () => {
      expect(rewriteJsonAgg('SELECT JSON_ARRAYAGG(a), JSON_ARRAYAGG(b)'))
        .toEqual({ sql: 'SELECT json_group_array(a), json_group_array(b)', rewritten: true });
    });

    it('passes through non-matching SQL unchanged', () => {
      expect(rewriteJsonAgg('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    });

    it('returns unchanged for empty/blank SQL', () => {
      expect(rewriteJsonAgg('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteJsonAgg('   ')).toEqual({ sql: '   ', rewritten: false });
    });

    // BUG #68 regression: literals/comments must be preserved, not rewritten.
    it('preserves JSON_AGG text inside a string literal', () => {
      expect(rewriteJsonAgg("SELECT 'json_arrayagg(x)' AS t"))
        .toEqual({ sql: "SELECT 'json_arrayagg(x)' AS t", rewritten: false });
    });

    it('preserves JSON_AGG text inside a single-line comment', () => {
      expect(rewriteJsonAgg('-- json_objectagg(KEY a VALUE b)\nSELECT 1'))
        .toEqual({ sql: '-- json_objectagg(KEY a VALUE b)\nSELECT 1', rewritten: false });
    });

    it('preserves JSON_AGG text inside a multi-line comment', () => {
      expect(rewriteJsonAgg('SELECT 1 /* json_arrayagg(x) */'))
        .toEqual({ sql: 'SELECT 1 /* json_arrayagg(x) */', rewritten: false });
    });

    // `JSON_ARRAYAGG()` with an empty argument list is detected (the keyword
    // matches) but cannot be rewritten because the value expression requires at
    // least one character. This locks the detect/rewrite fallback path.
    it('returns unchanged for an empty JSON_ARRAYAGG() argument list', () => {
      expect(rewriteJsonAgg('SELECT JSON_ARRAYAGG()'))
        .toEqual({ sql: 'SELECT JSON_ARRAYAGG()', rewritten: false });
    });
  });

  describe('detectJsonAgg', () => {
    it('detects JSON_OBJECTAGG', () => {
      expect(detectJsonAgg('JSON_OBJECTAGG(KEY k VALUE v)')).toBe(true);
    });

    it('detects JSON_ARRAYAGG', () => {
      expect(detectJsonAgg('JSON_ARRAYAGG(x)')).toBe(true);
    });

    it('returns false for empty/blank/non-string input', () => {
      expect(detectJsonAgg('')).toBe(false);
      expect(detectJsonAgg('   ')).toBe(false);
      expect(detectJsonAgg(undefined as unknown as string)).toBe(false);
      expect(detectJsonAgg(42 as unknown as string)).toBe(false);
    });

    it('does not report a JSON aggregate inside a literal', () => {
      expect(detectJsonAgg("SELECT 'json_arrayagg(x)'")).toBe(false);
      expect(detectJsonAgg('-- json_arrayagg(x)\nSELECT 1')).toBe(false);
    });
  });
});
