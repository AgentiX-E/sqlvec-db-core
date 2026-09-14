import { describe, it, expect } from 'vitest';
import { detectGINParam, rewriteGINParam } from '../query/GINParamShim';

// GINParamShim handles SET/SHOW gin_pending_list_limit GUC statements. Its
// SET/SHOW patterns are line-anchored (^\s*SET / ^\s*SHOW), so a token inside a
// string literal or comment is never matched. Tests lock the full contract,
// including the numeric-value restriction (`(\d+)`).
describe('GINParamShim', () => {
  describe('detectGINParam', () => {
    it('detects SET variants', () => {
      expect(detectGINParam('SET gin_pending_list_limit = 4096')).toBe(true);
      expect(detectGINParam('SET gin_pending_list_limit = 0')).toBe(true);
      expect(detectGINParam('SET gin_pending_list_limit TO 4096')).toBe(true);
      expect(detectGINParam('SET SESSION gin_pending_list_limit = 4096')).toBe(true);
      expect(detectGINParam('SET LOCAL gin_pending_list_limit = 4096')).toBe(true);
      expect(detectGINParam('set gin_pending_list_limit = 4096')).toBe(true);
    });

    it('detects SHOW', () => {
      expect(detectGINParam('SHOW gin_pending_list_limit')).toBe(true);
      expect(detectGINParam('SHOW gin_pending_list_limit;')).toBe(true);
    });

    it('returns false for a non-numeric SET value', () => {
      expect(detectGINParam('SET gin_pending_list_limit = abc')).toBe(false);
    });

    it('returns false for empty/non-string input', () => {
      expect(detectGINParam('')).toBe(false);
      expect(detectGINParam('   ')).toBe(false);
      expect(detectGINParam(undefined as unknown as string)).toBe(false);
    });

    it('returns false for unrelated SQL', () => {
      expect(detectGINParam('SELECT * FROM users')).toBe(false);
    });

    it('does not report a token inside a string literal or comment', () => {
      expect(detectGINParam("SELECT 'gin_pending_list_limit'")).toBe(false);
      expect(detectGINParam('-- SET gin_pending_list_limit = 4096')).toBe(false);
    });
  });

  describe('rewriteGINParam', () => {
    it('rewrites SET = value to SELECT 1', () => {
      expect(rewriteGINParam('SET gin_pending_list_limit = 4096'))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
      expect(rewriteGINParam('SET gin_pending_list_limit = 0'))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
    });

    it('rewrites SET TO / SESSION / LOCAL variants', () => {
      expect(rewriteGINParam('SET gin_pending_list_limit TO 4096').sql).toBe('SELECT 1');
      expect(rewriteGINParam('SET SESSION gin_pending_list_limit = 4096').sql).toBe('SELECT 1');
      expect(rewriteGINParam('SET LOCAL gin_pending_list_limit = 4096').sql).toBe('SELECT 1');
      expect(rewriteGINParam('SET TEMPORARY gin_pending_list_limit = 4096').sql).toBe('SELECT 1');
    });

    it('rewrites SHOW to a SELECT 0 literal', () => {
      expect(rewriteGINParam('SHOW gin_pending_list_limit'))
        .toEqual({ sql: "SELECT '0' as gin_pending_list_limit", rewritten: true });
    });

    it('passes through a non-numeric SET value (not a handled pattern)', () => {
      expect(rewriteGINParam('SET gin_pending_list_limit = abc'))
        .toEqual({ sql: 'SET gin_pending_list_limit = abc', rewritten: false });
    });

    it('passes through SQL with no token at all (fast-path)', () => {
      expect(rewriteGINParam('SELECT 1'))
        .toEqual({ sql: 'SELECT 1', rewritten: false });
      expect(rewriteGINParam('SELECT * FROM users'))
        .toEqual({ sql: 'SELECT * FROM users', rewritten: false });
    });

    it('passes through an unrelated token used as a normal identifier', () => {
      expect(rewriteGINParam('SELECT gin_pending_list_limit FROM cfg'))
        .toEqual({ sql: 'SELECT gin_pending_list_limit FROM cfg', rewritten: false });
    });

    it('passes through a token inside a string literal or comment', () => {
      expect(rewriteGINParam("SELECT 'gin_pending_list_limit'"))
        .toEqual({ sql: "SELECT 'gin_pending_list_limit'", rewritten: false });
      expect(rewriteGINParam('-- SET gin_pending_list_limit = 4096'))
        .toEqual({ sql: '-- SET gin_pending_list_limit = 4096', rewritten: false });
    });

    it('returns blank passthrough for empty/non-string input', () => {
      expect(rewriteGINParam('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteGINParam(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    });
  });
});
