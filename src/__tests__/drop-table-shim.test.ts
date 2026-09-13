import { describe, it, expect } from 'vitest';
import { detectMultiTableDrop, rewriteMultiTableDrop } from '../query/DropTableShim';

// DropTableShim expands PostgreSQL comma-separated DROP TABLE into individual
// DROP TABLE statements because SQLite permits only one table per DROP.
//
// Note: CASCADE/RESTRICT suffixes are stripped by QueryRouter *before* this
// shim runs (Step 0b-i), so they are out of scope here. Quoted identifiers
// containing spaces are not matched by the `\w+` table-name token (a known
// limitation of the regex-based tokenizer).
describe('DropTableShim', () => {
  describe('detectMultiTableDrop', () => {
    it('detects a comma-separated multi-table DROP', () => {
      expect(detectMultiTableDrop('DROP TABLE t1, t2')).toBe(true);
    });

    it('detects IF EXISTS with multiple tables', () => {
      expect(detectMultiTableDrop('DROP TABLE IF EXISTS t1, t2, t3')).toBe(true);
    });

    it('returns false for a single-table DROP', () => {
      expect(detectMultiTableDrop('DROP TABLE t1')).toBe(false);
    });

    it('returns false for DROP VIEW', () => {
      expect(detectMultiTableDrop('DROP VIEW t1')).toBe(false);
    });

    it('returns false for empty/blank/non-string input', () => {
      expect(detectMultiTableDrop('')).toBe(false);
      expect(detectMultiTableDrop('   ')).toBe(false);
      expect(detectMultiTableDrop(undefined as unknown as string)).toBe(false);
    });
  });

  describe('rewriteMultiTableDrop', () => {
    it('splits multiple tables into individual statements', () => {
      expect(rewriteMultiTableDrop('DROP TABLE t1, t2, t3'))
        .toEqual({ sql: 'DROP TABLE t1; DROP TABLE t2; DROP TABLE t3', rewritten: true });
    });

    it('preserves IF EXISTS on every statement', () => {
      expect(rewriteMultiTableDrop('DROP TABLE IF EXISTS t1, t2'))
        .toEqual({ sql: 'DROP TABLE IF EXISTS t1; DROP TABLE IF EXISTS t2', rewritten: true });
    });

    it('returns null for a single-table DROP (already SQLite-compatible)', () => {
      expect(rewriteMultiTableDrop('DROP TABLE t1'))
        .toEqual({ sql: null, rewritten: false });
    });

    it('handles empty/blank/non-string input', () => {
      expect(rewriteMultiTableDrop('')).toEqual({ sql: null, rewritten: false });
      expect(rewriteMultiTableDrop('   ')).toEqual({ sql: null, rewritten: false });
      expect(rewriteMultiTableDrop(42 as unknown as string)).toEqual({ sql: null, rewritten: false });
    });

    it('preserves quoted identifiers', () => {
      expect(rewriteMultiTableDrop('DROP TABLE "a", "b"'))
        .toEqual({ sql: 'DROP TABLE "a"; DROP TABLE "b"', rewritten: true });
    });

    it('preserves schema-qualified table names', () => {
      expect(rewriteMultiTableDrop('DROP TABLE s1.a, s2.b'))
        .toEqual({ sql: 'DROP TABLE s1.a; DROP TABLE s2.b', rewritten: true });
    });

    it('handles a trailing semicolon', () => {
      expect(rewriteMultiTableDrop('DROP TABLE t1, t2;'))
        .toEqual({ sql: 'DROP TABLE t1; DROP TABLE t2', rewritten: true });
    });

    it('handles case-insensitive keywords', () => {
      expect(rewriteMultiTableDrop('drop table t1, t2'))
        .toEqual({ sql: 'DROP TABLE t1; DROP TABLE t2', rewritten: true });
    });

    it('filters empty table names from stray commas', () => {
      expect(rewriteMultiTableDrop('DROP TABLE t1, , t3'))
        .toEqual({ sql: 'DROP TABLE t1; DROP TABLE t3', rewritten: true });
    });
  });
});
