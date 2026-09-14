import { describe, it, expect } from 'vitest';
import { hasBareOffset, fixBareOffset } from '../query/OffsetShim';

// OffsetShim fixes bare OFFSET (no preceding LIMIT) for SQLite by inserting
// LIMIT -1. Tests lock the literal/comment protection and the clause-scan
// behavior (numeric, $n param, ? placeholder, subquery scope).
describe('OffsetShim', () => {
  describe('hasBareOffset', () => {
    it('detects a bare numeric OFFSET', () => {
      expect(hasBareOffset('SELECT * FROM t OFFSET 5')).toBe(true);
    });

    it('detects OFFSET with a parameter or placeholder', () => {
      expect(hasBareOffset('SELECT * FROM t OFFSET $1')).toBe(true);
      expect(hasBareOffset('SELECT * FROM t OFFSET ?')).toBe(true);
    });

    it('returns false when a LIMIT precedes the OFFSET', () => {
      expect(hasBareOffset('SELECT * FROM t LIMIT 10 OFFSET 5')).toBe(false);
    });

    it('returns false for SQL without OFFSET', () => {
      expect(hasBareOffset('SELECT 1')).toBe(false);
    });

    it('returns false for non-string input', () => {
      expect(hasBareOffset(undefined as unknown as string)).toBe(false);
    });

    // BUG #97 regression: OFFSET inside a string literal or comment is not a
    // real clause and must not be reported.
    it('does not report OFFSET inside a string literal or comment', () => {
      expect(hasBareOffset("SELECT 'OFFSET 5'")).toBe(false);
      expect(hasBareOffset('SELECT 1 -- OFFSET 5')).toBe(false);
    });
  });

  describe('fixBareOffset', () => {
    it('inserts LIMIT -1 before a bare numeric OFFSET', () => {
      expect(fixBareOffset('SELECT * FROM t OFFSET 5'))
        .toBe('SELECT * FROM t LIMIT -1 OFFSET 5');
    });

    it('inserts LIMIT -1 before OFFSET with a parameter or placeholder', () => {
      expect(fixBareOffset('SELECT * FROM t OFFSET $1'))
        .toBe('SELECT * FROM t LIMIT -1 OFFSET $1');
      expect(fixBareOffset('SELECT * FROM t OFFSET ?'))
        .toBe('SELECT * FROM t LIMIT -1 OFFSET ?');
    });

    it('leaves SQL with an existing LIMIT unchanged', () => {
      expect(fixBareOffset('SELECT * FROM t LIMIT 10 OFFSET 5'))
        .toBe('SELECT * FROM t LIMIT 10 OFFSET 5');
    });

    it('leaves SQL without OFFSET unchanged', () => {
      expect(fixBareOffset('SELECT 1')).toBe('SELECT 1');
    });

    it('only fixes the top-level OFFSET (skips subquery OFFSET)', () => {
      expect(fixBareOffset('SELECT * FROM (SELECT * FROM t OFFSET 3) s OFFSET 9'))
        .toBe('SELECT * FROM (SELECT * FROM t OFFSET 3) s LIMIT -1 OFFSET 9');
    });

    it('leaves non-string input unchanged', () => {
      expect(fixBareOffset(undefined as unknown as string)).toBeUndefined();
    });

    // BUG #97 regression: a string/comment token must survive intact.
    it('leaves a string literal or comment containing OFFSET intact', () => {
      expect(fixBareOffset("SELECT 'OFFSET 5'")).toBe("SELECT 'OFFSET 5'");
      expect(fixBareOffset('SELECT 1 -- OFFSET 5')).toBe('SELECT 1 -- OFFSET 5');
    });
  });
});
