import { describe, it, expect } from 'vitest';
import {
  detectCitextType,
  rewriteCitextType,
  rewriteCitextComparisons,
  rewriteCitextSql,
} from '../query/CitextShim';

// citext is a case-insensitive text type. The shim rewrites CITEXT -> TEXT in
// DDL and wraps `col = expr`-style comparisons on citext columns with LOWER().
describe('CitextShim', () => {
  describe('rewriteCitextType', () => {
    it('rewrites CITEXT to TEXT (case-insensitive)', () => {
      expect(rewriteCitextType('CREATE TABLE t (name CITEXT)')).toBe(
        'CREATE TABLE t (name TEXT)',
      );
      expect(rewriteCitextType('CREATE TABLE t (name citext)')).toBe(
        'CREATE TABLE t (name TEXT)',
      );
    });

    it('does NOT rewrite a CITEXT token inside a string literal', () => {
      expect(rewriteCitextType("SELECT 'CITEXT' AS t")).toBe("SELECT 'CITEXT' AS t");
    });

    it('does NOT rewrite a CITEXT token inside a comment', () => {
      expect(rewriteCitextType('-- CITEXT comment\nSELECT 1')).toBe(
        '-- CITEXT comment\nSELECT 1',
      );
    });
  });

  describe('rewriteCitextComparisons', () => {
    it('returns passthrough for empty/non-string input', () => {
      expect(rewriteCitextComparisons('', [])).toEqual({ sql: '', rewritten: false });
      expect(rewriteCitextComparisons(null as any, ['name'])).toEqual({
        sql: '', rewritten: false,
      });
    });

    it('returns passthrough when no citext columns are given', () => {
      expect(rewriteCitextComparisons("SELECT * FROM t WHERE name = 'x'", [])).toEqual({
        sql: "SELECT * FROM t WHERE name = 'x'", rewritten: false,
      });
    });

    it('wraps =, <>, !=, and LIKE comparisons in LOWER()', () => {
      expect(rewriteCitextComparisons("SELECT * FROM t WHERE name = 'Hello'", ['name']).sql)
        .toBe("SELECT * FROM t WHERE LOWER(name) = LOWER('Hello')");
      expect(rewriteCitextComparisons("SELECT * FROM t WHERE name <> 'Hello'", ['name']).sql)
        .toBe("SELECT * FROM t WHERE LOWER(name) <> LOWER('Hello')");
      expect(rewriteCitextComparisons("SELECT * FROM t WHERE name != 'Hello'", ['name']).sql)
        .toBe("SELECT * FROM t WHERE LOWER(name) != LOWER('Hello')");
      expect(rewriteCitextComparisons("SELECT * FROM t WHERE name LIKE 'Hel%'", ['name']).sql)
        .toBe("SELECT * FROM t WHERE LOWER(name) LIKE LOWER('Hel%')");
    });

    it('only rewrites the citext column, not other columns', () => {
      const r = rewriteCitextComparisons(
        "SELECT * FROM t WHERE name = 'Hello' AND age = 5",
        ['name'],
      );
      expect(r.sql).toBe("SELECT * FROM t WHERE LOWER(name) = LOWER('Hello') AND age = 5");
    });

    it('does not double-wrap an already LOWER()-ed column', () => {
      const r = rewriteCitextComparisons("SELECT * FROM t WHERE LOWER(name) = 'hello'", ['name']);
      expect(r.rewritten).toBe(false);
    });

    it('returns unchanged when the column is absent', () => {
      const r = rewriteCitextComparisons('SELECT * FROM t', ['name']);
      expect(r.rewritten).toBe(false);
    });
  });

  describe('rewriteCitextSql', () => {
    it('takes the DDL path when a CITEXT type is present', () => {
      expect(rewriteCitextSql('CREATE TABLE t (name CITEXT)', [])).toEqual({
        sql: 'CREATE TABLE t (name TEXT)', rewritten: true,
      });
    });

    it('falls through to comparison rewriting otherwise', () => {
      expect(rewriteCitextSql("SELECT * FROM t WHERE name = 'Hello'", ['name'])).toEqual({
        sql: "SELECT * FROM t WHERE LOWER(name) = LOWER('Hello')", rewritten: true,
      });
    });
  });

  describe('detectCitextType', () => {
    it('detects a CITEXT type (case-insensitive)', () => {
      expect(detectCitextType('CREATE TABLE t (name CITEXT)')).toBe(true);
      expect(detectCitextType('CREATE TABLE t (name citext)')).toBe(true);
    });

    it('ignores CITEXT inside string literals and comments', () => {
      expect(detectCitextType("SELECT 'CITEXT'")).toBe(false);
      expect(detectCitextType('-- CITEXT\nSELECT 1')).toBe(false);
    });

    it('returns false for unrelated SQL', () => {
      expect(detectCitextType('SELECT 1')).toBe(false);
    });

    it('returns false for non-string input', () => {
      expect(detectCitextType(null as any)).toBe(false);
      expect(detectCitextType(undefined as any)).toBe(false);
    });
  });
});
