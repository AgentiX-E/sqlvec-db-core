import { describe, it, expect } from 'vitest';
import {
  rewriteCitextType,
  rewriteCitextComparisons,
  rewriteCitextSql,
  detectCitextType,
} from '../query/CitextShim';

describe('CitextShim', () => {
  describe('rewriteCitextType', () => {
    it('rewrites CITEXT keyword to TEXT', () => {
      expect(rewriteCitextType('CREATE TABLE t (name CITEXT)')).toBe('CREATE TABLE t (name TEXT)');
      expect(rewriteCitextType('ALTER TABLE t ALTER COLUMN c TYPE citext')).toBe(
        'ALTER TABLE t ALTER COLUMN c TYPE TEXT',
      );
    });
    it('does not rewrite CITEXT inside a string literal', () => {
      expect(rewriteCitextType("SELECT 'CITEXT'")).toBe("SELECT 'CITEXT'");
    });
    it('does not rewrite CITEXT inside a quoted identifier', () => {
      expect(rewriteCitextType('SELECT "CITEXT"')).toBe('SELECT "CITEXT"');
    });
    it('does not rewrite CITEXT inside a comment', () => {
      expect(rewriteCitextType('-- CITEXT\nSELECT 1')).toBe('-- CITEXT\nSELECT 1');
      expect(rewriteCitextType('/* CITEXT */ SELECT 1')).toBe('/* CITEXT */ SELECT 1');
    });
  });

  describe('detectCitextType', () => {
    it('detects CITEXT type reference', () => {
      expect(detectCitextType('CREATE TABLE t (name CITEXT)')).toBe(true);
    });
    it('returns false for unrelated SQL', () => {
      expect(detectCitextType('SELECT 1')).toBe(false);
      expect(detectCitextType('')).toBe(false);
      expect(detectCitextType(null as any)).toBe(false);
    });
    it('does not detect CITEXT inside a string literal', () => {
      expect(detectCitextType("SELECT 'CITEXT'")).toBe(false);
    });
    it('does not detect CITEXT inside a quoted identifier', () => {
      expect(detectCitextType('SELECT "CITEXT"')).toBe(false);
    });
    it('does not detect CITEXT inside a block comment', () => {
      expect(detectCitextType('/* CITEXT */ SELECT 1')).toBe(false);
      expect(detectCitextType('-- CITEXT\nSELECT 1')).toBe(false);
    });
  });

  describe('rewriteCitextComparisons', () => {
    it('rewrites = comparison', () => {
      expect(rewriteCitextComparisons("SELECT * FROM t WHERE name = 'Hello'", ['name'])).toEqual({
        sql: "SELECT * FROM t WHERE LOWER(name) = LOWER('Hello')", rewritten: true,
      });
    });
    it('rewrites <> and != comparisons', () => {
      expect(rewriteCitextComparisons("WHERE name <> 'x'", ['name'])).toEqual({
        sql: "WHERE LOWER(name) <> LOWER('x')", rewritten: true,
      });
      expect(rewriteCitextComparisons("WHERE name != 'x'", ['name'])).toEqual({
        sql: "WHERE LOWER(name) != LOWER('x')", rewritten: true,
      });
    });
    it('rewrites LIKE comparison', () => {
      expect(rewriteCitextComparisons("WHERE name LIKE '%a%'", ['name'])).toEqual({
        sql: "WHERE LOWER(name) LIKE LOWER('%a%')", rewritten: true,
      });
    });
    it('handles comparison followed by AND', () => {
      expect(rewriteCitextComparisons("WHERE name = 'x' AND age > 5", ['name'])).toEqual({
        sql: "WHERE LOWER(name) = LOWER('x') AND age > 5", rewritten: true,
      });
    });
    it('does NOT rewrite a comparison inside a string literal', () => {
      expect(rewriteCitextComparisons("SELECT 'name = Hello'", ['name'])).toEqual({
        sql: "SELECT 'name = Hello'", rewritten: false,
      });
    });
    it('does not rewrite when column list is empty', () => {
      expect(rewriteCitextComparisons("WHERE name = 'x'", [])).toEqual({
        sql: "WHERE name = 'x'", rewritten: false,
      });
    });
    it('handles empty / non-string input', () => {
      expect(rewriteCitextComparisons('', ['name'])).toEqual({ sql: '', rewritten: false });
      expect(rewriteCitextComparisons(null as any, ['name'])).toEqual({ sql: '', rewritten: false });
    });
    it('rewrites only the matching column among several', () => {
      expect(rewriteCitextComparisons("WHERE a = 'x' AND b = 'y'", ['a'])).toEqual({
        sql: "WHERE LOWER(a) = LOWER('x') AND b = 'y'", rewritten: true,
      });
    });
  });

  describe('rewriteCitextSql', () => {
    it('rewrites DDL type alias', () => {
      expect(rewriteCitextSql('CREATE TABLE t (name CITEXT)', [])).toEqual({
        sql: 'CREATE TABLE t (name TEXT)', rewritten: true,
      });
    });
    it('rewrites comparisons when no DDL type present', () => {
      expect(rewriteCitextSql("name = 'x'", ['name'])).toEqual({
        sql: "LOWER(name) = LOWER('x')", rewritten: true,
      });
    });
    it('passes through non-citext SQL', () => {
      expect(rewriteCitextSql('SELECT 1', [])).toEqual({ sql: 'SELECT 1', rewritten: false });
    });
  });

  describe('escapeRegex integration', () => {
    it('escapes regex-special column names', () => {
      expect(rewriteCitextComparisons("WHERE a.b = 'x'", ['a.b'])).toEqual({
        sql: "WHERE LOWER(a.b) = LOWER('x')", rewritten: true,
      });
    });
  });
});
