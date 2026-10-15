import { describe, it, expect } from 'vitest';
import {
  detectNullsClause,
  rewriteNullsClause,
} from '../index/NullsIndexShim';

describe('NullsIndexShim', () => {
  describe('detectNullsClause', () => {
    it('detects NULLS FIRST', () => {
      expect(detectNullsClause('CREATE INDEX idx ON t (col NULLS FIRST)')).toBe(true);
    });
    it('detects NULLS LAST', () => {
      expect(detectNullsClause('CREATE INDEX idx ON t (col NULLS LAST)')).toBe(true);
    });
    it('detects lowercase nulls first', () => {
      expect(detectNullsClause('create index idx on t (col nulls last)')).toBe(true);
    });
    it('returns false when no NULLS clause is present', () => {
      expect(detectNullsClause('CREATE INDEX idx ON t (col ASC)')).toBe(false);
      expect(detectNullsClause('CREATE INDEX idx ON t (col)')).toBe(false);
    });
  });

  describe('rewriteNullsClause', () => {
    it('strips DESC NULLS FIRST, preserving direction', () => {
      const r = rewriteNullsClause('CREATE INDEX idx ON t (col DESC NULLS FIRST)');
      expect(r.sql).toBe('CREATE INDEX idx ON t (col DESC)');
      expect(r.rewritten).toBe(true);
    });

    it('strips ASC NULLS LAST, preserving direction', () => {
      const r = rewriteNullsClause('CREATE INDEX idx ON t (col ASC NULLS LAST)');
      expect(r.sql).toBe('CREATE INDEX idx ON t (col ASC)');
      expect(r.rewritten).toBe(true);
    });

    it('strips bare NULLS FIRST without leaving a dangling space', () => {
      const r = rewriteNullsClause('CREATE INDEX idx ON t (col NULLS FIRST)');
      expect(r.sql).toBe('CREATE INDEX idx ON t (col)');
      expect(r.rewritten).toBe(true);
    });

    it('strips bare NULLS LAST', () => {
      const r = rewriteNullsClause('CREATE INDEX idx ON t (col NULLS LAST)');
      expect(r.sql).toBe('CREATE INDEX idx ON t (col)');
      expect(r.rewritten).toBe(true);
    });

    it('handles multiple NULLS clauses in one statement', () => {
      const r = rewriteNullsClause(
        'CREATE INDEX idx ON t (a DESC NULLS FIRST, b ASC NULLS LAST)',
      );
      expect(r.sql).toBe('CREATE INDEX idx ON t (a DESC, b ASC)');
      expect(r.rewritten).toBe(true);
    });

    it('handles mixed bare and directed NULLS clauses', () => {
      const r = rewriteNullsClause(
        'CREATE INDEX idx ON t (a DESC NULLS LAST, b NULLS FIRST)',
      );
      expect(r.sql).toBe('CREATE INDEX idx ON t (a DESC, b)');
      expect(r.rewritten).toBe(true);
    });

    it('passes through unchanged when no NULLS clause is present', () => {
      const r = rewriteNullsClause('CREATE INDEX idx ON t (col ASC)');
      expect(r.sql).toBe('CREATE INDEX idx ON t (col ASC)');
      expect(r.rewritten).toBe(false);
    });

    it('trims surrounding whitespace', () => {
      const r = rewriteNullsClause('  CREATE INDEX idx ON t (col NULLS FIRST)  ');
      expect(r.sql).toBe('CREATE INDEX idx ON t (col)');
    });
  });
});
