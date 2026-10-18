/**
 * vacuum-shim.test.ts — Coverage tests for VacuumShim (PostgreSQL VACUUM
 * option stripping for SQLite compatibility).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectPgVacuum, rewriteVacuum, setVacuumMutationHook } from '../query/VacuumShim';

describe('detectPgVacuum', () => {
  it('returns false for non-string input', () => {
    expect(detectPgVacuum(undefined as unknown as string)).toBe(false);
    expect(detectPgVacuum(null as unknown as string)).toBe(false);
    expect(detectPgVacuum(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectPgVacuum('')).toBe(false);
    expect(detectPgVacuum('   ')).toBe(false);
  });

  it('returns false for non-VACUUM SQL', () => {
    expect(detectPgVacuum('SELECT * FROM t')).toBe(false);
    expect(detectPgVacuum('ANALYZE t')).toBe(false);
  });

  it('returns false for SQLite-compatible VACUUM variants', () => {
    expect(detectPgVacuum('VACUUM')).toBe(false);
    expect(detectPgVacuum('VACUUM;')).toBe(false);
    expect(detectPgVacuum('VACUUM main')).toBe(false);
    expect(detectPgVacuum('VACUUM INTO backup.db')).toBe(false);
  });

  it('detects parenthesized options', () => {
    expect(detectPgVacuum('VACUUM (FULL, VERBOSE, ANALYZE)')).toBe(true);
    expect(detectPgVacuum('VACUUM (FULL, FREEZE)')).toBe(true);
  });

  it('detects PG space-separated keywords', () => {
    expect(detectPgVacuum('VACUUM FULL')).toBe(true);
    expect(detectPgVacuum('VACUUM VERBOSE')).toBe(true);
    expect(detectPgVacuum('VACUUM ANALYZE')).toBe(true);
    expect(detectPgVacuum('VACUUM FREEZE')).toBe(true);
    expect(detectPgVacuum('VACUUM FULL VERBOSE ANALYZE my_table')).toBe(true);
  });
});

describe('setVacuumMutationHook', () => {
  it('registers and clears the mutation hook', () => {
    const hook = vi.fn();
    setVacuumMutationHook(hook);
    setVacuumMutationHook(null);
    // Setting to null must not throw.
    expect(true).toBe(true);
  });
});

describe('rewriteVacuum', () => {
  beforeEach(() => {
    setVacuumMutationHook(null);
  });

  it('returns passthrough for non-string input', () => {
    expect(rewriteVacuum(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteVacuum(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteVacuum('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through non-VACUUM SQL', () => {
    expect(rewriteVacuum('SELECT * FROM t')).toEqual({ sql: 'SELECT * FROM t', rewritten: false });
  });

  it('passes through VACUUM INTO unchanged', () => {
    expect(rewriteVacuum('VACUUM INTO backup.db')).toEqual({
      sql: 'VACUUM INTO backup.db',
      rewritten: false,
    });
  });

  it('passes through bare VACUUM and schema-name VACUUM', () => {
    expect(rewriteVacuum('VACUUM')).toEqual({ sql: 'VACUUM', rewritten: false });
    expect(rewriteVacuum('VACUUM main')).toEqual({ sql: 'VACUUM main', rewritten: false });
  });

  it('strips PG-specific keywords to bare VACUUM', () => {
    expect(rewriteVacuum('VACUUM FULL')).toEqual({ sql: 'VACUUM', rewritten: true });
    expect(rewriteVacuum('VACUUM VERBOSE')).toEqual({ sql: 'VACUUM', rewritten: true });
    expect(rewriteVacuum('VACUUM ANALYZE')).toEqual({ sql: 'VACUUM', rewritten: true });
    expect(rewriteVacuum('VACUUM FULL VERBOSE ANALYZE my_table')).toEqual({ sql: 'VACUUM', rewritten: true });
  });

  it('strips parenthesized options to bare VACUUM', () => {
    expect(rewriteVacuum('VACUUM (FULL, VERBOSE, ANALYZE)')).toEqual({ sql: 'VACUUM', rewritten: true });
    expect(rewriteVacuum('VACUUM (FULL, FREEZE) my_table')).toEqual({ sql: 'VACUUM', rewritten: true });
  });

  it('invokes the mutation hook with the table name on PG-specific VACUUM', () => {
    const hook = vi.fn();
    setVacuumMutationHook(hook);
    rewriteVacuum('VACUUM FULL VERBOSE ANALYZE my_table');
    expect(hook).toHaveBeenCalledWith('my_table');
  });

  it('invokes the mutation hook on VACUUM INTO', () => {
    const hook = vi.fn();
    setVacuumMutationHook(hook);
    rewriteVacuum('VACUUM INTO backup.db');
    expect(hook).toHaveBeenCalled();
  });
});
