import { describe, it, expect } from 'vitest';
import { detectIncrSort, rewriteIncrSort } from '../query/IncrementalSortShim';

// IncrementalSortShim rewrites SET/SHOW enable_incremental_sort GUC statements.
// Although it lacks an explicit LiteralProtectionLayer, its SET/SHOW patterns are
// line-anchored (^\s*SET / ^\s*SHOW), so a token inside a string/comment is never
// matched. Tests lock the full contract, including that guarantee.
describe('IncrementalSortShim', () => {
  describe('detectIncrSort', () => {
    it('detects SET variants', () => {
      expect(detectIncrSort('SET enable_incremental_sort = on')).toBe(true);
      expect(detectIncrSort('SET enable_incremental_sort = off')).toBe(true);
      expect(detectIncrSort('SET enable_incremental_sort TO on')).toBe(true);
      expect(detectIncrSort('SET SESSION enable_incremental_sort = on')).toBe(true);
      expect(detectIncrSort('SET LOCAL enable_incremental_sort = off')).toBe(true);
      expect(detectIncrSort('set enable_incremental_sort = on')).toBe(true); // case-insensitive
    });

    it('detects SHOW', () => {
      expect(detectIncrSort('SHOW enable_incremental_sort')).toBe(true);
      expect(detectIncrSort('SHOW enable_incremental_sort;')).toBe(true);
    });

    it('returns false for empty/non-string input', () => {
      expect(detectIncrSort('')).toBe(false);
      expect(detectIncrSort('   ')).toBe(false);
      expect(detectIncrSort(undefined as unknown as string)).toBe(false);
      expect(detectIncrSort(123 as unknown as string)).toBe(false);
    });

    it('returns false for unrelated SQL', () => {
      expect(detectIncrSort('SELECT * FROM users')).toBe(false);
    });

    it('returns false for a token inside a string literal or comment', () => {
      expect(detectIncrSort("SELECT 'enable_incremental_sort'")).toBe(false);
      expect(detectIncrSort('-- SET enable_incremental_sort = on')).toBe(false);
      expect(detectIncrSort('/* SET enable_incremental_sort = on */')).toBe(false);
    });
  });

  describe('rewriteIncrSort', () => {
    it('rewrites SET = on/off to SELECT 1', () => {
      expect(rewriteIncrSort('SET enable_incremental_sort = on'))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
      expect(rewriteIncrSort('SET enable_incremental_sort = off'))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
    });

    it('rewrites SET TO value to SELECT 1', () => {
      expect(rewriteIncrSort('SET enable_incremental_sort TO on'))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
    });

    it('rewrites SESSION/LOCAL/TEMP variants to SELECT 1', () => {
      expect(rewriteIncrSort('SET SESSION enable_incremental_sort = on').sql).toBe('SELECT 1');
      expect(rewriteIncrSort('SET LOCAL enable_incremental_sort = off').sql).toBe('SELECT 1');
      expect(rewriteIncrSort('SET TEMPORARY enable_incremental_sort = on').sql).toBe('SELECT 1');
    });

    it('rewrites SHOW to a SELECT off literal', () => {
      expect(rewriteIncrSort('SHOW enable_incremental_sort'))
        .toEqual({ sql: "SELECT 'off' as enable_incremental_sort", rewritten: true });
    });

    it('passes through non-incremental-sort SQL', () => {
      expect(rewriteIncrSort('SELECT * FROM users'))
        .toEqual({ sql: 'SELECT * FROM users', rewritten: false });
    });

    it('passes through a token used as a normal identifier (not SET/SHOW)', () => {
      expect(rewriteIncrSort('SELECT enable_incremental_sort FROM cfg'))
        .toEqual({ sql: 'SELECT enable_incremental_sort FROM cfg', rewritten: false });
    });

    it('passes through a token inside a string literal or comment', () => {
      expect(rewriteIncrSort("SELECT 'enable_incremental_sort'"))
        .toEqual({ sql: "SELECT 'enable_incremental_sort'", rewritten: false });
      expect(rewriteIncrSort('-- SET enable_incremental_sort = on'))
        .toEqual({ sql: '-- SET enable_incremental_sort = on', rewritten: false });
    });

    it('returns blank passthrough for empty/non-string input', () => {
      expect(rewriteIncrSort('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteIncrSort('   ')).toEqual({ sql: '   ', rewritten: false });
      expect(rewriteIncrSort(null as unknown as string))
        .toEqual({ sql: '', rewritten: false });
    });
  });
});
