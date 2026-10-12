import { describe, it, expect } from 'vitest';
import { detectCoveringIndex, rewriteCoveringIndex } from '../index/CoveringIndexRewriter';

// CoveringIndexRewriter strips PostgreSQL's INCLUDE (...) covering-index clause
// (and the CONCURRENTLY keyword) so CREATE INDEX compiles under SQLite.
describe('CoveringIndexRewriter', () => {
  describe('detectCoveringIndex', () => {
    it('detects a CREATE INDEX with an INCLUDE clause', () => {
      expect(detectCoveringIndex('CREATE INDEX ix ON t (a) INCLUDE (b)')).toBe(true);
    });

    it('detects a CREATE UNIQUE INDEX with INCLUDE', () => {
      expect(detectCoveringIndex('CREATE UNIQUE INDEX ix ON t (a) INCLUDE (b)')).toBe(true);
    });

    it('detects leading whitespace before CREATE', () => {
      expect(detectCoveringIndex('   CREATE INDEX ix ON t (a) INCLUDE (b)')).toBe(true);
    });

    it('returns false for CREATE INDEX without INCLUDE', () => {
      expect(detectCoveringIndex('CREATE INDEX ix ON t (a)')).toBe(false);
    });

    it('returns false for a non-CREATE-INDEX statement', () => {
      expect(detectCoveringIndex('CREATE TABLE t (a INT)')).toBe(false);
      expect(detectCoveringIndex('DROP INDEX ix')).toBe(false);
      expect(detectCoveringIndex('SELECT 1')).toBe(false);
    });

    it('returns false for INCLUDE without a leading CREATE INDEX', () => {
      expect(detectCoveringIndex('ALTER TABLE t INCLUDE (b)')).toBe(false);
    });
  });

  describe('rewriteCoveringIndex', () => {
    it('strips the INCLUDE clause', () => {
      expect(rewriteCoveringIndex('CREATE INDEX ix ON t (a) INCLUDE (b)'))
        .toEqual({ sql: 'CREATE INDEX ix ON t (a)', rewritten: true });
    });

    it('preserves UNIQUE and strips INCLUDE', () => {
      expect(rewriteCoveringIndex('CREATE UNIQUE INDEX ix ON t (a) INCLUDE (b, c)'))
        .toEqual({ sql: 'CREATE UNIQUE INDEX ix ON t (a)', rewritten: true });
    });

    it('removes the CONCURRENTLY keyword', () => {
      expect(rewriteCoveringIndex('CREATE INDEX CONCURRENTLY ix ON t (a) INCLUDE (b)'))
        .toEqual({ sql: 'CREATE INDEX ix ON t (a)', rewritten: true });
    });

    it('removes CONCURRENTLY even when INCLUDE precedes a WHERE clause', () => {
      expect(rewriteCoveringIndex('CREATE INDEX ix ON t (a) INCLUDE (b, c) WHERE x > 1'))
        .toEqual({ sql: 'CREATE INDEX ix ON t (a) WHERE x > 1', rewritten: true });
    });

    it('leaves a CREATE INDEX without INCLUDE untouched (rewritten=false)', () => {
      expect(rewriteCoveringIndex('CREATE INDEX ix ON t (a)'))
        .toEqual({ sql: 'CREATE INDEX ix ON t (a)', rewritten: false });
    });

    it('leaves a non-CREATE-INDEX statement untouched', () => {
      expect(rewriteCoveringIndex('SELECT 1'))
        .toEqual({ sql: 'SELECT 1', rewritten: false });
    });

    it('trims surrounding whitespace on a no-op', () => {
      expect(rewriteCoveringIndex('  SELECT 1  '))
        .toEqual({ sql: 'SELECT 1', rewritten: false });
    });

    // BUG regression: a function-expression covering column must not leave a
    // dangling ')' — the INCLUDE clause has its own brackets that the naive
    // `[^)]*` matcher failed to balance.
    it('strips INCLUDE (lower(c)) without leaving a dangling parenthesis', () => {
      expect(rewriteCoveringIndex('CREATE INDEX ix ON t (a) INCLUDE (lower(c))'))
        .toEqual({ sql: 'CREATE INDEX ix ON t (a)', rewritten: true });
    });

    it('strips INCLUDE with multiple function-expression columns', () => {
      expect(rewriteCoveringIndex('CREATE INDEX ix ON t (a) INCLUDE (lower(c), upper(d))'))
        .toEqual({ sql: 'CREATE INDEX ix ON t (a)', rewritten: true });
    });

    it('collapses whitespace left by multiple removals', () => {
      expect(rewriteCoveringIndex('CREATE  INDEX   CONCURRENTLY  ix  ON t (a)  INCLUDE (b)'))
        .toEqual({ sql: 'CREATE INDEX ix ON t (a)', rewritten: true });
    });

    it('handles INCLUDE appearing before the index columns (reordered clause)', () => {
      // Unusual but tolerated: INCLUDE still stripped wherever it appears.
      const r = rewriteCoveringIndex('CREATE INDEX ix ON t INCLUDE (b) (a)');
      expect(r.rewritten).toBe(true);
      expect(r.sql).not.toContain('INCLUDE');
    });

    it('strips an unbalanced INCLUDE clause through end-of-string', () => {
      // Malformed input: INCLUDE opens a '(' that is never closed. The scan
      // falls back to dropping the remainder of the string.
      const r = rewriteCoveringIndex('CREATE INDEX ix ON t (a) INCLUDE (b');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe('CREATE INDEX ix ON t (a)');
    });
  });
});
