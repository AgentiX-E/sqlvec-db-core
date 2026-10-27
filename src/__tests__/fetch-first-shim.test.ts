import { describe, it, expect } from 'vitest';
import { detectFetchFirst, rewriteFetchFirst } from '../query/FetchFirstShim';

// FetchFirstShim normalizes SQL-standard row-limiting syntax (OFFSET n ROWS,
// FETCH FIRST/NEXT n ROWS ONLY) into SQLite's LIMIT/OFFSET. Tests lock the
// rewrite, the OFFSET-before-FETCH swap, and the shared-regexp lastIndex reset.
describe('FetchFirstShim', () => {
  describe('detectFetchFirst', () => {
    it('detects OFFSET n ROWS', () => {
      expect(detectFetchFirst('SELECT * FROM t OFFSET 1 ROWS')).toBe(true);
    });

    it('detects FETCH FIRST n ROWS ONLY', () => {
      expect(detectFetchFirst('SELECT * FROM t FETCH FIRST 2 ROWS ONLY')).toBe(true);
    });

    it('detects FETCH NEXT n ROWS ONLY', () => {
      expect(detectFetchFirst('SELECT * FROM t FETCH NEXT 2 ROWS ONLY')).toBe(true);
    });

    it('returns false for plain SQL', () => {
      expect(detectFetchFirst('SELECT * FROM t LIMIT 2 OFFSET 1')).toBe(false);
    });

    it('returns false for non-string or empty input', () => {
      expect(detectFetchFirst(undefined as unknown as string)).toBe(false);
      expect(detectFetchFirst('')).toBe(false);
    });

    // lastIndex reset regression: repeated .test() on the shared global regex.
    it('is deterministic across repeated calls', () => {
      expect(detectFetchFirst('SELECT * FROM t FETCH FIRST 1 ROW ONLY')).toBe(true);
      expect(detectFetchFirst('SELECT * FROM t FETCH FIRST 1 ROW ONLY')).toBe(true);
      expect(detectFetchFirst('SELECT * FROM t OFFSET 1 ROW')).toBe(true);
    });
  });

  describe('rewriteFetchFirst', () => {
    it('rewrites FETCH FIRST n ROWS ONLY to LIMIT n', () => {
      expect(rewriteFetchFirst('SELECT * FROM t FETCH FIRST 2 ROWS ONLY'))
        .toEqual({ sql: 'SELECT * FROM t LIMIT 2', rewritten: true });
    });

    it('rewrites FETCH NEXT n ROWS ONLY to LIMIT n', () => {
      expect(rewriteFetchFirst('SELECT * FROM t FETCH NEXT 3 ROWS ONLY'))
        .toEqual({ sql: 'SELECT * FROM t LIMIT 3', rewritten: true });
    });

    it('rewrites bare OFFSET n ROWS to OFFSET n', () => {
      expect(rewriteFetchFirst('SELECT * FROM t OFFSET 1 ROWS'))
        .toEqual({ sql: 'SELECT * FROM t OFFSET 1', rewritten: true });
    });

    it('combines OFFSET n ROWS + FETCH NEXT m ROWS ONLY into LIMIT m OFFSET n', () => {
      expect(rewriteFetchFirst('SELECT * FROM t OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY'))
        .toEqual({ sql: 'SELECT * FROM t LIMIT 2 OFFSET 1', rewritten: true });
    });

    it('preserves ORDER BY through the OFFSET/FETCH rewrite', () => {
      expect(rewriteFetchFirst('SELECT * FROM t ORDER BY n OFFSET 1 ROW FETCH NEXT 2 ROWS ONLY'))
        .toEqual({ sql: 'SELECT * FROM t ORDER BY n LIMIT 2 OFFSET 1', rewritten: true });
    });

    it('handles FETCH FIRST n ROW ONLY (singular ROW)', () => {
      expect(rewriteFetchFirst('SELECT * FROM t FETCH FIRST 1 ROW ONLY'))
        .toEqual({ sql: 'SELECT * FROM t LIMIT 1', rewritten: true });
    });

    it('leaves non-matching SQL unchanged', () => {
      expect(rewriteFetchFirst('SELECT * FROM t LIMIT 2 OFFSET 1'))
        .toEqual({ sql: 'SELECT * FROM t LIMIT 2 OFFSET 1', rewritten: false });
    });

    it('leaves a literal containing FETCH/ROWS intact', () => {
      expect(rewriteFetchFirst("SELECT 'FETCH FIRST 1 ROWS ONLY'"))
        .toEqual({ sql: "SELECT 'FETCH FIRST 1 ROWS ONLY'", rewritten: false });
    });
  });
});
