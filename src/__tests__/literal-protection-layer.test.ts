import { describe, it, expect } from 'vitest';
import {
  protectSQL,
  restoreSQL,
  hasPlaceholders,
  extractPlaceholderIndices,
} from '../query/LiteralProtectionLayer';

// LiteralProtectionLayer shields string literals, quoted identifiers, and
// comments behind placeholders so regex rewriters only ever see non-literal SQL.
describe('LiteralProtectionLayer', () => {
  describe('protectSQL / restoreSQL round-trip', () => {
    it('protects and restores a single-quoted string', () => {
      const sql = "SELECT 'hello' AS greeting";
      const p = protectSQL(sql);
      expect(p.protectedSql).toBe('SELECT __LIT_0__ AS greeting');
      expect(p.literals).toEqual(["'hello'"]);
      expect(restoreSQL(p)).toBe(sql);
    });

    it('protects and restores escaped single quotes', () => {
      const sql = "SELECT 'it''s a ''test''' AS t";
      const p = protectSQL(sql);
      expect(restoreSQL(p)).toBe(sql);
    });

    it('protects and restores a double-quoted identifier with escapes', () => {
      const sql = 'SELECT "col""name" AS x';
      const p = protectSQL(sql);
      expect(p.literals).toEqual(['"col""name"']);
      expect(restoreSQL(p)).toBe(sql);
    });

    it('protects and restores a single-line comment', () => {
      const sql = "-- it's a comment\nSELECT 1";
      const p = protectSQL(sql);
      expect(p.protectedSql).toBe('__LIT_0__\nSELECT 1');
      expect(restoreSQL(p)).toBe(sql);
    });

    it('protects and restores a multi-line comment', () => {
      const sql = 'SELECT 1 /* multi\nline comment */ + 2';
      const p = protectSQL(sql);
      expect(restoreSQL(p)).toBe(sql);
    });

    it('protects a string containing comment markers as a single literal', () => {
      const sql = "SELECT '-- not a comment' AS t";
      const p = protectSQL(sql);
      expect(p.literals).toEqual(["'-- not a comment'"]);
      expect(restoreSQL(p)).toBe(sql);
    });

    it('records comments with their position', () => {
      const p = protectSQL('-- lead\nSELECT 1');
      expect(p.comments).toEqual([{ text: '-- lead', position: 0 }]);
    });

    it('keeps multiple literals in order', () => {
      const sql = "SELECT 'a', 'b', 'c'";
      const p = protectSQL(sql);
      expect(p.literals).toEqual(["'a'", "'b'", "'c'"]);
      expect(restoreSQL(p)).toBe(sql);
    });
  });

  describe('scan type classification', () => {
    it('classifies string vs identifier vs comments', () => {
      const p = protectSQL("SELECT 's' AS \"id\", -- c\n 1 /* m */");
      // string, identifier, single-line comment, multi-line comment
      expect(p.literals.length).toBe(4);
    });
  });

  describe('restoreSQL with out-of-bounds placeholder', () => {
    it('keeps an out-of-bounds placeholder token unchanged', () => {
      const p = protectSQL("SELECT 'a'");
      // Force a placeholder index that does not exist in literals.
      const out = restoreSQL({ ...p, protectedSql: 'SELECT __LIT_9__' });
      expect(out).toBe('SELECT __LIT_9__');
    });
  });

  describe('hasPlaceholders', () => {
    it('detects a placeholder token', () => {
      expect(hasPlaceholders('SELECT __LIT_0__')).toBe(true);
    });

    it('returns false when no placeholder is present', () => {
      expect(hasPlaceholders('SELECT 1')).toBe(false);
    });
  });

  describe('extractPlaceholderIndices', () => {
    it('extracts placeholder indices in order', () => {
      expect(extractPlaceholderIndices('__LIT_0__ __LIT_5__ __LIT_2__')).toEqual([0, 5, 2]);
    });

    it('returns an empty array when no placeholder is present', () => {
      expect(extractPlaceholderIndices('SELECT 1')).toEqual([]);
    });
  });

  describe('placeholderPrefix metadata', () => {
    it('exposes the default prefix', () => {
      expect(protectSQL('SELECT 1').placeholderPrefix).toBe('__LIT_');
    });
  });
});
