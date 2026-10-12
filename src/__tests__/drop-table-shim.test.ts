import { describe, it, expect } from 'vitest';
import { detectMultiTableDrop, rewriteMultiTableDrop } from '../query/DropTableShim';

// DropTableShim expands PostgreSQL's comma-separated DROP TABLE into a series of
// individual SQLite DROP TABLE statements (SQLite only drops one table per stmt).
describe('DropTableShim', () => {
  describe('detectMultiTableDrop', () => {
    it('detects a multi-table DROP TABLE', () => {
      expect(detectMultiTableDrop('DROP TABLE t1, t2')).toBe(true);
    });

    it('detects DROP TABLE IF EXISTS with multiple tables', () => {
      expect(detectMultiTableDrop('DROP TABLE IF EXISTS t1, t2, t3')).toBe(true);
    });

    it('detects quoted table names', () => {
      expect(detectMultiTableDrop('DROP TABLE "pgbench_accounts", "pgbench_branches"')).toBe(true);
    });

    it('detects schema-qualified table names', () => {
      expect(detectMultiTableDrop('DROP TABLE schema1.t1, schema2.t2')).toBe(true);
    });

    it('detects a CASCADE modifier as still a multi-table drop', () => {
      expect(detectMultiTableDrop('DROP TABLE t1, t2 CASCADE')).toBe(true);
    });

    it('returns false for a single-table DROP TABLE', () => {
      expect(detectMultiTableDrop('DROP TABLE t1')).toBe(false);
      expect(detectMultiTableDrop('DROP TABLE IF EXISTS t1')).toBe(false);
    });

    it('returns false for DROP VIEW', () => {
      expect(detectMultiTableDrop('DROP VIEW v1, v2')).toBe(false);
    });

    it('returns false for non-string or empty input', () => {
      expect(detectMultiTableDrop(undefined as unknown as string)).toBe(false);
      expect(detectMultiTableDrop('')).toBe(false);
      expect(detectMultiTableDrop('   ')).toBe(false);
    });
  });

  describe('rewriteMultiTableDrop', () => {
    it('expands two comma-separated tables', () => {
      expect(rewriteMultiTableDrop('DROP TABLE t1, t2'))
        .toEqual({ sql: 'DROP TABLE t1; DROP TABLE t2', rewritten: true });
    });

    it('preserves IF EXISTS across all expanded statements', () => {
      expect(rewriteMultiTableDrop('DROP TABLE IF EXISTS t1, t2, t3'))
        .toEqual({
          sql: 'DROP TABLE IF EXISTS t1; DROP TABLE IF EXISTS t2; DROP TABLE IF EXISTS t3',
          rewritten: true,
        });
    });

    it('preserves quoted table names', () => {
      expect(rewriteMultiTableDrop('DROP TABLE "pgbench_accounts", "pgbench_branches"'))
        .toEqual({
          sql: 'DROP TABLE "pgbench_accounts"; DROP TABLE "pgbench_branches"',
          rewritten: true,
        });
    });

    it('preserves schema-qualified table names', () => {
      expect(rewriteMultiTableDrop('DROP TABLE schema1.t1, schema2.t2'))
        .toEqual({
          sql: 'DROP TABLE schema1.t1; DROP TABLE schema2.t2',
          rewritten: true,
        });
    });

    it('strips a trailing semicolon', () => {
      expect(rewriteMultiTableDrop('DROP TABLE t1, t2, t3;'))
        .toEqual({ sql: 'DROP TABLE t1; DROP TABLE t2; DROP TABLE t3', rewritten: true });
    });

    it('returns null for a single-table DROP TABLE', () => {
      expect(rewriteMultiTableDrop('DROP TABLE t1')).toEqual({ sql: null, rewritten: false });
    });

    it('returns null for non-string or empty input', () => {
      expect(rewriteMultiTableDrop(undefined as unknown as string)).toEqual({ sql: null, rewritten: false });
      expect(rewriteMultiTableDrop('')).toEqual({ sql: null, rewritten: false });
    });

    it('handles whitespace and newlines between tokens', () => {
      expect(rewriteMultiTableDrop('DROP TABLE\n t1, t2 , t3'))
        .toEqual({ sql: 'DROP TABLE t1; DROP TABLE t2; DROP TABLE t3', rewritten: true });
    });

    // BUG regression: PostgreSQL's CASCADE/RESTRICT modifier (unsupported by
    // SQLite) must not leak into the rewritten table list as a fake table name.
    it('strips a trailing CASCADE modifier', () => {
      expect(rewriteMultiTableDrop('DROP TABLE t1, t2 CASCADE'))
        .toEqual({ sql: 'DROP TABLE t1; DROP TABLE t2', rewritten: true });
    });

    it('strips a trailing RESTRICT modifier', () => {
      expect(rewriteMultiTableDrop('DROP TABLE t1, t2 RESTRICT'))
        .toEqual({ sql: 'DROP TABLE t1; DROP TABLE t2', rewritten: true });
    });

    it('strips CASCADE together with IF EXISTS and a trailing semicolon', () => {
      expect(rewriteMultiTableDrop('DROP TABLE IF EXISTS t1, t2 CASCADE;'))
        .toEqual({ sql: 'DROP TABLE IF EXISTS t1; DROP TABLE IF EXISTS t2', rewritten: true });
    });
  });
});
