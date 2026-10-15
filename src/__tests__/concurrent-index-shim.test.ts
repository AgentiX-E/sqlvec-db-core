import { describe, it, expect } from 'vitest';
import { detectConcurrently, rewriteConcurrently } from '../index/ConcurrentIndexShim';

describe('ConcurrentIndexShim', () => {
  describe('detectConcurrently', () => {
    it('detects CONCURRENTLY', () => {
      expect(detectConcurrently('CREATE INDEX CONCURRENTLY ix ON t (col)')).toBe(true);
    });
    it('detects lowercase concurrently (case-insensitive)', () => {
      expect(detectConcurrently('CREATE INDEX concurrently ix ON t (col)')).toBe(true);
    });
    it('returns false without CONCURRENTLY', () => {
      expect(detectConcurrently('CREATE INDEX ix ON t (col)')).toBe(false);
    });
    it('does not match a column named "concurrently_idx"', () => {
      expect(detectConcurrently('CREATE INDEX concurrently_idx ON t (col)')).toBe(false);
    });
  });

  describe('rewriteConcurrently', () => {
    it('strips CONCURRENTLY from a plain index', () => {
      const r = rewriteConcurrently('CREATE INDEX CONCURRENTLY ix ON t (col)');
      expect(r.sql).toBe('CREATE INDEX ix ON t (col)');
      expect(r.rewritten).toBe(true);
    });

    it('strips CONCURRENTLY from a UNIQUE index', () => {
      const r = rewriteConcurrently('CREATE UNIQUE INDEX CONCURRENTLY ix ON t (a, b)');
      expect(r.sql).toBe('CREATE UNIQUE INDEX ix ON t (a, b)');
      expect(r.rewritten).toBe(true);
    });

    it('strips CONCURRENTLY before IF NOT EXISTS', () => {
      const r = rewriteConcurrently('CREATE INDEX CONCURRENTLY IF NOT EXISTS ix ON t (col)');
      expect(r.sql).toBe('CREATE INDEX IF NOT EXISTS ix ON t (col)');
      expect(r.rewritten).toBe(true);
    });

    it('passes through unchanged without CONCURRENTLY', () => {
      const r = rewriteConcurrently('CREATE INDEX ix ON t (col)');
      expect(r.sql).toBe('CREATE INDEX ix ON t (col)');
      expect(r.rewritten).toBe(false);
    });

    it('trims surrounding whitespace', () => {
      const r = rewriteConcurrently('  CREATE INDEX CONCURRENTLY ix ON t (col)  ');
      expect(r.sql).toBe('CREATE INDEX ix ON t (col)');
      expect(r.rewritten).toBe(true);
    });
  });
});
