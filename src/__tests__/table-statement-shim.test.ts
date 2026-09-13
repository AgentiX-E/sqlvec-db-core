import { describe, it, expect } from 'vitest';
import { detectTableStatement, rewriteTableStatement } from '../query/TableStatementShim';

// TableStatementShim rewrites PostgreSQL `TABLE tab` shorthand to
// `SELECT * FROM tab`.
describe('TableStatementShim', () => {
  describe('detectTableStatement', () => {
    it('detects a simple TABLE statement', () => {
      expect(detectTableStatement('TABLE users')).toBe(true);
    });

    it('detects TABLE with a trailing clause', () => {
      expect(detectTableStatement('TABLE users ORDER BY id')).toBe(true);
    });

    // BUG #76 regression: `TABLE` separated by tab/newline must be detected
    // (the old `startsWith('TABLE ')` only matched a literal space).
    it('detects TABLE separated by a tab', () => {
      expect(detectTableStatement('TABLE\tusers')).toBe(true);
    });

    it('detects TABLE separated by a newline', () => {
      expect(detectTableStatement('TABLE\nusers')).toBe(true);
    });

    it('does not detect a non-TABLE keyword with a shared prefix', () => {
      expect(detectTableStatement('TABLEx users')).toBe(false);
    });

    it('does not detect TABLE with no following identifier', () => {
      expect(detectTableStatement('TABLE')).toBe(false);
    });

    it('does not detect a SELECT statement', () => {
      expect(detectTableStatement('SELECT * FROM users')).toBe(false);
    });

    it('returns false for empty/blank/non-string input', () => {
      expect(detectTableStatement('')).toBe(false);
      expect(detectTableStatement('   ')).toBe(false);
      expect(detectTableStatement(undefined as unknown as string)).toBe(false);
    });
  });

  describe('rewriteTableStatement', () => {
    it('rewrites a plain TABLE to SELECT * FROM', () => {
      expect(rewriteTableStatement('TABLE users'))
        .toEqual({ sql: 'SELECT * FROM users', rewritten: true });
    });

    it('preserves ORDER BY/LIMIT suffixes', () => {
      expect(rewriteTableStatement('TABLE users ORDER BY id DESC LIMIT 5'))
        .toEqual({ sql: 'SELECT * FROM users ORDER BY id DESC LIMIT 5', rewritten: true });
    });

    it('preserves a schema qualifier', () => {
      expect(rewriteTableStatement('TABLE public.users'))
        .toEqual({ sql: 'SELECT * FROM public.users', rewritten: true });
    });

    it('passes through a SELECT statement', () => {
      expect(rewriteTableStatement('SELECT 1'))
        .toEqual({ sql: 'SELECT 1', rewritten: false });
    });

    it('passes through TABLE with no table name', () => {
      expect(rewriteTableStatement('TABLE'))
        .toEqual({ sql: 'TABLE', rewritten: false });
    });

    it('rewrites TABLE separated by a tab', () => {
      expect(rewriteTableStatement('TABLE\tusers'))
        .toEqual({ sql: 'SELECT * FROM users', rewritten: true });
    });
  });
});
