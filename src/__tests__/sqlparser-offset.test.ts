import { describe, it, expect } from 'vitest';
import { hasBareOffset, fixBareOffset } from '../query/OffsetShim';

// PostgreSQL allows SELECT ... OFFSET n without LIMIT (treated as LIMIT ALL);
// SQLite requires LIMIT before OFFSET. OffsetShim detects a bare OFFSET and
// inserts `LIMIT -1` before it.
describe('OffsetShim', () => {
  describe('hasBareOffset', () => {
    it('rejects non-string input', () => {
      expect(hasBareOffset(null as any)).toBe(false);
      expect(hasBareOffset(42 as any)).toBe(false);
    });

    it('returns false when there is no OFFSET', () => {
      expect(hasBareOffset('SELECT * FROM t')).toBe(false);
    });

    it('returns true for a bare OFFSET with a numeric literal', () => {
      expect(hasBareOffset('SELECT * FROM t OFFSET 10')).toBe(true);
    });

    it('returns true for a bare OFFSET with a $n parameter', () => {
      expect(hasBareOffset('SELECT * FROM t OFFSET $1')).toBe(true);
    });

    it('returns true for a bare OFFSET with a ? placeholder', () => {
      expect(hasBareOffset('SELECT * FROM t OFFSET ?')).toBe(true);
    });

    it('returns false when LIMIT precedes OFFSET', () => {
      expect(hasBareOffset('SELECT * FROM t LIMIT 5 OFFSET 10')).toBe(false);
    });

    it('ignores a nested subquery OFFSET when checking the top level', () => {
      expect(
        hasBareOffset('SELECT * FROM t WHERE id IN (SELECT id FROM u OFFSET 3) OFFSET 10'),
      ).toBe(true);
    });
  });

  describe('fixBareOffset', () => {
    it('inserts LIMIT -1 before a numeric bare OFFSET', () => {
      expect(fixBareOffset('SELECT * FROM t OFFSET 10')).toBe(
        'SELECT * FROM t LIMIT -1 OFFSET 10',
      );
    });

    it('inserts LIMIT -1 before a $n bare OFFSET', () => {
      expect(fixBareOffset('SELECT * FROM t OFFSET $1')).toBe(
        'SELECT * FROM t LIMIT -1 OFFSET $1',
      );
    });

    it('inserts LIMIT -1 before a ? placeholder bare OFFSET', () => {
      expect(fixBareOffset('SELECT * FROM t OFFSET ?')).toBe(
        'SELECT * FROM t LIMIT -1 OFFSET ?',
      );
    });

    it('leaves a LIMIT ... OFFSET query unchanged', () => {
      expect(fixBareOffset('SELECT * FROM t LIMIT 5 OFFSET 10')).toBe(
        'SELECT * FROM t LIMIT 5 OFFSET 10',
      );
    });

    it('leaves a query without OFFSET unchanged', () => {
      expect(fixBareOffset('SELECT * FROM t')).toBe('SELECT * FROM t');
    });

    it('only fixes the top-level bare OFFSET, not a nested subquery', () => {
      expect(
        fixBareOffset('SELECT * FROM (SELECT * FROM u LIMIT 3 OFFSET 2) x OFFSET 10'),
      ).toBe('SELECT * FROM (SELECT * FROM u LIMIT 3 OFFSET 2) x LIMIT -1 OFFSET 10');
    });

    it('inserts LIMIT -1 before OFFSET following ORDER BY', () => {
      expect(fixBareOffset('SELECT * FROM t ORDER BY id DESC OFFSET 5')).toBe(
        'SELECT * FROM t ORDER BY id DESC LIMIT -1 OFFSET 5',
      );
    });
  });
});
