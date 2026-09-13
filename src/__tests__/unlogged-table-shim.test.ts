import { describe, it, expect } from 'vitest';
import { detectUnloggedTable, rewriteUnloggedTable } from '../query/UnloggedTableShim';

// UnloggedTableShim strips PostgreSQL UNLOGGED from CREATE TABLE while
// preserving TEMP/TEMPORARY and never touching literals/comments.
describe('UnloggedTableShim', () => {
  describe('detectUnloggedTable', () => {
    it('detects CREATE UNLOGGED TABLE', () => {
      expect(detectUnloggedTable('CREATE UNLOGGED TABLE t (id int)')).toBe(true);
    });

    it('detects TEMP/TEMPORARY variants', () => {
      expect(detectUnloggedTable('CREATE TEMP UNLOGGED TABLE t (id int)')).toBe(true);
      expect(detectUnloggedTable('CREATE TEMPORARY UNLOGGED TABLE t (id int)')).toBe(true);
    });

    // BUG #77 regression: whitespace other than a literal space must be handled.
    it('detects CREATE separated by tab/newline', () => {
      expect(detectUnloggedTable('CREATE\tUNLOGGED TABLE t (id int)')).toBe(true);
      expect(detectUnloggedTable('CREATE\nUNLOGGED TABLE t (id int)')).toBe(true);
    });

    it('does not detect a plain CREATE TABLE', () => {
      expect(detectUnloggedTable('CREATE TABLE t (id int)')).toBe(false);
    });

    it('does not detect a keyword sharing the CREATE prefix without whitespace', () => {
      expect(detectUnloggedTable('CREATEX UNLOGGED TABLE t (id int)')).toBe(false);
    });

    it('does not detect a bare CREATE with no following content', () => {
      expect(detectUnloggedTable('CREATE')).toBe(false);
    });

    // BUG #78 regression: mention inside a literal/comment is not UNLOGGED DDL.
    it('does not report a string default containing the words', () => {
      expect(detectUnloggedTable("CREATE TABLE t (c TEXT DEFAULT 'create unlogged table')")).toBe(false);
    });

    it('does not report a trailing comment mention', () => {
      expect(detectUnloggedTable('CREATE TABLE t (id int) /* create unlogged table */')).toBe(false);
    });

    it('returns false for empty/blank/non-string input', () => {
      expect(detectUnloggedTable('')).toBe(false);
      expect(detectUnloggedTable('   ')).toBe(false);
      expect(detectUnloggedTable(undefined as unknown as string)).toBe(false);
    });
  });

  describe('rewriteUnloggedTable', () => {
    it('strips UNLOGGED from CREATE UNLOGGED TABLE', () => {
      expect(rewriteUnloggedTable('CREATE UNLOGGED TABLE t (id int)'))
        .toEqual({ sql: 'CREATE TABLE t (id int)', rewritten: true });
    });

    it('preserves the TEMP modifier', () => {
      expect(rewriteUnloggedTable('CREATE TEMP UNLOGGED TABLE t (id int)'))
        .toEqual({ sql: 'CREATE TEMP TABLE t (id int)', rewritten: true });
    });

    it('preserves the TEMPORARY modifier', () => {
      expect(rewriteUnloggedTable('CREATE TEMPORARY UNLOGGED TABLE t (id int)'))
        .toEqual({ sql: 'CREATE TEMPORARY TABLE t (id int)', rewritten: true });
    });

    it('passes through a plain CREATE TABLE', () => {
      expect(rewriteUnloggedTable('CREATE TABLE t (id int)'))
        .toEqual({ sql: 'CREATE TABLE t (id int)', rewritten: false });
    });

    it('passes through a SELECT', () => {
      expect(rewriteUnloggedTable('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    });

    // BUG #78 regression: a string default must not lose the word UNLOGGED.
    it('preserves UNLOGGED inside a string default', () => {
      const sql = "CREATE TABLE t (c TEXT DEFAULT 'create unlogged table')";
      expect(rewriteUnloggedTable(sql)).toEqual({ sql, rewritten: false });
    });

    it('preserves UNLOGGED inside a trailing comment', () => {
      const sql = 'CREATE TABLE t (id int) /* create unlogged table */';
      expect(rewriteUnloggedTable(sql)).toEqual({ sql, rewritten: false });
    });

    it('passes through empty/non-string input', () => {
      expect(rewriteUnloggedTable('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteUnloggedTable(undefined as unknown as string))
        .toEqual({ sql: '', rewritten: false });
    });
  });
});
