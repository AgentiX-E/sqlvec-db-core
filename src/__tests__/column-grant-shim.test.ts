import { describe, it, expect, vi } from 'vitest';
import {
  detectColumnGrant,
  rewriteColumnGrant,
} from '../query/ColumnGrantShim';
import { ColumnGrantChecker } from '../security/ColumnGrantChecker';

describe('ColumnGrantShim', () => {
  describe('detectColumnGrant', () => {
    it('detects a real column-level GRANT', () => {
      expect(detectColumnGrant('GRANT SELECT(col1, col2) ON t TO user')).toBe(true);
      expect(detectColumnGrant('  GRANT UPDATE(a) ON s.t TO bob  ')).toBe(true);
    });

    it('returns false for a table-level GRANT (no column list)', () => {
      expect(detectColumnGrant('GRANT SELECT ON t TO user')).toBe(false);
    });

    it('returns false for empty/non-string input', () => {
      expect(detectColumnGrant('')).toBe(false);
      expect(detectColumnGrant(undefined as unknown as string)).toBe(false);
      expect(detectColumnGrant(null as unknown as string)).toBe(false);
    });

    // BUG #88 regression: a column-level GRANT inside a multiline comment must
    // not be reported (the old bare regex matched via the `m`/`^` anchor).
    it('does not report a GRANT inside a multiline comment', () => {
      expect(detectColumnGrant('/*\nGRANT SELECT(a,b) ON t TO u\n*/')).toBe(false);
    });
  });

  describe('rewriteColumnGrant', () => {
    it('strips the column list from a column-level GRANT', () => {
      expect(rewriteColumnGrant('GRANT SELECT(col1, col2) ON t TO user')).toEqual({
        sql: 'GRANT SELECT ON t TO user',
        rewritten: true,
      });
    });

    it('handles a schema-qualified table and multi-word privilege', () => {
      expect(rewriteColumnGrant('GRANT UPDATE(a, b) ON public.t TO bob')).toEqual({
        sql: 'GRANT UPDATE ON public.t TO bob',
        rewritten: true,
      });
    });

    it('passes through a table-level GRANT unchanged', () => {
      expect(rewriteColumnGrant('GRANT SELECT ON t TO user')).toEqual({
        sql: 'GRANT SELECT ON t TO user',
        rewritten: false,
      });
    });

    it('passes through non-GRANT SQL unchanged', () => {
      expect(rewriteColumnGrant('SELECT * FROM t')).toEqual({
        sql: 'SELECT * FROM t',
        rewritten: false,
      });
    });

    // BUG #88 regression: the old rewrote a GRANT pattern inside a multiline
    // comment, dropping the `/* ... */` wrapper and truncating the text.
    it('leaves a GRANT inside a multiline comment intact', () => {
      expect(rewriteColumnGrant('/*\nGRANT SELECT(a,b) ON t TO u\n*/')).toEqual({
        sql: '/*\nGRANT SELECT(a,b) ON t TO u\n*/',
        rewritten: false,
      });
    });

    it('records column-level grants via the checker when ready', () => {
      const checker = new ColumnGrantChecker();
      const grantSpy = vi.spyOn(checker, 'grantColumnPrivilege');
      rewriteColumnGrant('GRANT SELECT(col1, col2) ON my_table TO alice', checker);
      expect(grantSpy).toHaveBeenCalledWith(
        'alice',
        'my_table',
        'SELECT',
        ['col1', 'col2'],
      );
    });

    it('does not record when the column list is empty', () => {
      const checker = new ColumnGrantChecker();
      const grantSpy = vi.spyOn(checker, 'grantColumnPrivilege');
      rewriteColumnGrant('GRANT SELECT() ON t TO user', checker);
      expect(grantSpy).not.toHaveBeenCalled();
    });

    // BUG #87 regression: `isReady` is a boolean field, not a method; passing a
    // real checker previously threw `checker.isReady is not a function`.
    it('treats checker.isReady as a boolean field', () => {
      const checker = new ColumnGrantChecker();
      checker.isReady = false;
      const grantSpy = vi.spyOn(checker, 'grantColumnPrivilege');
      expect(() => rewriteColumnGrant('GRANT SELECT(a) ON t TO user', checker)).not.toThrow();
      expect(grantSpy).not.toHaveBeenCalled();
    });
  });
});
