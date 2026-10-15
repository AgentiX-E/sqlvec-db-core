import { describe, it, expect } from 'vitest';
import { detectHash, rewriteHash } from '../index/HashIndexShim';

describe('HashIndexShim', () => {
  describe('detectHash', () => {
    it('detects USING HASH', () => {
      expect(detectHash('CREATE INDEX ix ON t USING HASH (col)')).toBe(true);
    });
    it('detects lowercase using hash (case-insensitive)', () => {
      expect(detectHash('CREATE INDEX ix ON t using hash (col)')).toBe(true);
    });
    it('returns false without USING HASH', () => {
      expect(detectHash('CREATE INDEX ix ON t (col)')).toBe(false);
    });
    it('does not match a table named "hash" without USING', () => {
      expect(detectHash('CREATE INDEX ix ON hash (col)')).toBe(false);
    });
  });

  describe('rewriteHash', () => {
    it('strips USING HASH to a plain B-tree index', () => {
      const r = rewriteHash('CREATE INDEX ix ON t USING HASH (col)');
      expect(r.sql).toBe('CREATE INDEX ix ON t (col)');
      expect(r.rewritten).toBe(true);
    });

    it('strips USING HASH on a UNIQUE index with multiple columns', () => {
      const r = rewriteHash('CREATE UNIQUE INDEX uq ON t USING HASH (a, b)');
      expect(r.sql).toBe('CREATE UNIQUE INDEX uq ON t (a, b)');
      expect(r.rewritten).toBe(true);
    });

    it('strips lowercase using hash', () => {
      const r = rewriteHash('CREATE INDEX ix ON t USING hash (col)');
      expect(r.sql).toBe('CREATE INDEX ix ON t (col)');
      expect(r.rewritten).toBe(true);
    });

    it('passes through unchanged without USING HASH', () => {
      const r = rewriteHash('CREATE INDEX ix ON t (col)');
      expect(r.sql).toBe('CREATE INDEX ix ON t (col)');
      expect(r.rewritten).toBe(false);
    });

    it('trims surrounding whitespace', () => {
      const r = rewriteHash('  CREATE INDEX ix ON t USING HASH (col)  ');
      expect(r.sql).toBe('CREATE INDEX ix ON t (col)');
      expect(r.rewritten).toBe(true);
    });
  });
});
