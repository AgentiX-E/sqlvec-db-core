import { describe, it, expect } from 'vitest';
import { detectRLS, rewriteRLS } from '../query/RowLevelSecurityShim';

// RowLevelSecurityShim elides PostgreSQL RLS DDL to a safe `SELECT 1` no-op.
// Its RLS patterns are all anchored to the string start (`^\s*`), so a token
// inside a string literal or comment is never misreported. Tests lock the full
// contract across every variant plus the passthrough and edge branches.
describe('RowLevelSecurityShim', () => {
  describe('detectRLS', () => {
    it('detects ALTER TABLE ... ROW LEVEL SECURITY variants', () => {
      expect(detectRLS('ALTER TABLE t ENABLE ROW LEVEL SECURITY')).toBe(true);
      expect(detectRLS('ALTER TABLE t DISABLE ROW LEVEL SECURITY')).toBe(true);
      expect(detectRLS('ALTER TABLE t FORCE ROW LEVEL SECURITY')).toBe(true);
      expect(detectRLS('ALTER TABLE t NO FORCE ROW LEVEL SECURITY')).toBe(true);
    });

    it('detects CREATE/ALTER/DROP POLICY', () => {
      expect(detectRLS('CREATE POLICY p ON t FOR SELECT TO role USING (e)')).toBe(true);
      expect(detectRLS('ALTER POLICY p ON t USING (expr)')).toBe(true);
      expect(detectRLS('DROP POLICY p ON t')).toBe(true);
      expect(detectRLS('DROP POLICY IF EXISTS p ON t CASCADE')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(detectRLS('alter table t enable row level security')).toBe(true);
      expect(detectRLS('create policy p on t')).toBe(true);
    });

    it('returns false for empty/non-string input', () => {
      expect(detectRLS('')).toBe(false);
      expect(detectRLS('   ')).toBe(false);
      expect(detectRLS(undefined as unknown as string)).toBe(false);
    });

    it('returns false for non-RLS SQL', () => {
      expect(detectRLS('SELECT * FROM users')).toBe(false);
      expect(detectRLS('ALTER TABLE users ADD COLUMN x int')).toBe(false);
    });

    it('does not report an RLS token inside a string literal or comment', () => {
      expect(detectRLS("SELECT 'CREATE POLICY p ON t'")).toBe(false);
      expect(detectRLS('-- CREATE POLICY p ON t\nSELECT 1')).toBe(false);
      expect(detectRLS('/* CREATE POLICY p ON t */ SELECT 1')).toBe(false);
    });
  });

  describe('rewriteRLS', () => {
    it.each([
      ['ALTER TABLE t ENABLE ROW LEVEL SECURITY'],
      ['ALTER TABLE t DISABLE ROW LEVEL SECURITY'],
      ['ALTER TABLE t FORCE ROW LEVEL SECURITY'],
      ['ALTER TABLE t NO FORCE ROW LEVEL SECURITY'],
      ['CREATE POLICY p ON t FOR SELECT TO role USING (e)'],
      ['ALTER POLICY p ON t USING (expr)'],
      ['ALTER POLICY p ON t RENAME TO p2'],
      ['DROP POLICY p ON t'],
      ['DROP POLICY IF EXISTS p ON t CASCADE'],
    ])('rewrites %s to SELECT 1', (sql) => {
      expect(rewriteRLS(sql)).toEqual({ sql: 'SELECT 1', rewritten: true });
    });

    it('passes through non-RLS SQL unchanged', () => {
      expect(rewriteRLS('SELECT * FROM users'))
        .toEqual({ sql: 'SELECT * FROM users', rewritten: false });
      expect(rewriteRLS('INSERT INTO t VALUES (1)'))
        .toEqual({ sql: 'INSERT INTO t VALUES (1)', rewritten: false });
    });

    it('passes through an RLS token inside a string literal or comment', () => {
      expect(rewriteRLS("SELECT 'CREATE POLICY p ON t'"))
        .toEqual({ sql: "SELECT 'CREATE POLICY p ON t'", rewritten: false });
    });

    it('returns blank passthrough for empty/non-string input', () => {
      expect(rewriteRLS('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteRLS('   ')).toEqual({ sql: '   ', rewritten: false });
      expect(rewriteRLS(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    });

    // The broad ANY_RLS matcher matches a prefix while ALTER_TABLE_RLS requires
    // the statement to end right after `SECURITY`; an extra trailing token hits
    // the `unknown RLS statement` variant branch yet still rewrites to SELECT 1.
    it('rewrites a trailing-token ALTER TABLE variant via the unknown branch', () => {
      expect(rewriteRLS('ALTER TABLE t ENABLE ROW LEVEL SECURITY CASCADE'))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
    });
  });
});
