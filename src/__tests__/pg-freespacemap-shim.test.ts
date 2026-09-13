import { describe, it, expect } from 'vitest';
import {
  pgFreespacemap,
  detectPgFreeSpaceMap,
  rewritePgFreeSpaceMap,
} from '../query/PgFreeSpaceMapShim';

// PgFreeSpaceMapShim rewrites queries targeting the PostgreSQL pg_freespacemap
// function to a synthetic VALUES clause, and generates estimated free-space rows.
describe('PgFreeSpaceMapShim', () => {
  describe('pgFreespacemap', () => {
    it('returns a single row by default (pageCount defaults to at least 1)', () => {
      expect(pgFreespacemap()).toEqual([{ relfilenode: 0, blkno: 0, avail: 1228 }]);
    });

    it('returns one row per page with a 30% free-space estimate', () => {
      const rows = pgFreespacemap(99, 3, 100);
      expect(rows).toEqual([
        { relfilenode: 99, blkno: 0, avail: 30 },
        { relfilenode: 99, blkno: 1, avail: 30 },
        { relfilenode: 99, blkno: 2, avail: 30 },
      ]);
    });

    it('forces at least one row even when pageCount is 0', () => {
      expect(pgFreespacemap(1, 0)).toHaveLength(1);
    });
  });

  describe('rewritePgFreeSpaceMap', () => {
    it('rewrites a pg_freespacemap reference to a synthetic SELECT', () => {
      expect(rewritePgFreeSpaceMap('SELECT * FROM pg_freespacemap(t)').rewritten).toBe(true);
      expect(rewritePgFreeSpaceMap('SELECT * FROM pg_freespacemap(t)').sql).toContain(
        '(SELECT 0 AS relfilenode, 0 AS blkno, 1228 AS avail)',
      );
    });

    it('returns unchanged for non-matching SQL', () => {
      expect(rewritePgFreeSpaceMap('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    });

    it('returns unchanged for empty/non-string input', () => {
      expect(rewritePgFreeSpaceMap('')).toEqual({ sql: '', rewritten: false });
      expect(rewritePgFreeSpaceMap(undefined as unknown as string))
        .toEqual({ sql: '', rewritten: false });
    });

    // BUG #70 regression: a mention inside a multi-line comment must not be
    // rewritten (the old `cleaned` only stripped `--` line comments).
    it('preserves pg_freespacemap inside a multi-line comment', () => {
      expect(rewritePgFreeSpaceMap('/* pg_freespacemap */ SELECT 1'))
        .toEqual({ sql: '/* pg_freespacemap */ SELECT 1', rewritten: false });
    });

    it('preserves pg_freespacemap inside a string literal', () => {
      expect(rewritePgFreeSpaceMap("SELECT 'pg_freespacemap' AS t"))
        .toEqual({ sql: "SELECT 'pg_freespacemap' AS t", rewritten: false });
    });

    it('preserves pg_freespacemap inside a line comment', () => {
      expect(rewritePgFreeSpaceMap('-- pg_freespacemap\nSELECT 1'))
        .toEqual({ sql: '-- pg_freespacemap\nSELECT 1', rewritten: false });
    });
  });

  describe('detectPgFreeSpaceMap', () => {
    it('detects a real pg_freespacemap reference', () => {
      expect(detectPgFreeSpaceMap('SELECT * FROM pg_freespacemap(t)')).toBe(true);
    });

    it('returns false for empty/non-string input', () => {
      expect(detectPgFreeSpaceMap('')).toBe(false);
      expect(detectPgFreeSpaceMap(undefined as unknown as string)).toBe(false);
    });

    // BUG #71 regression: the old detector had no literal protection, so a
    // string/comment mention was misreported as a real reference.
    it('does not report a reference inside a string literal', () => {
      expect(detectPgFreeSpaceMap("SELECT 'pg_freespacemap'")).toBe(false);
    });

    it('does not report a reference inside a multi-line comment', () => {
      expect(detectPgFreeSpaceMap('/* pg_freespacemap */ SELECT 1')).toBe(false);
    });
  });
});
