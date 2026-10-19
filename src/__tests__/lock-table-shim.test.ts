/**
 * lock-table-shim.test.ts — Coverage tests for LockTableShim
 * (PostgreSQL LOCK TABLE compatibility shim).
 */

import { describe, it, expect } from 'vitest';
import {
  detectLockTable,
  extractLockMode,
  extractLockNowait,
  extractLockTableNames,
  rewriteLockTable,
} from '../query/LockTableShim';

describe('detectLockTable', () => {
  it('returns false for non-string input', () => {
    expect(detectLockTable(undefined as unknown as string)).toBe(false);
    expect(detectLockTable(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectLockTable('')).toBe(false);
    expect(detectLockTable('   ')).toBe(false);
  });

  it('returns false for non-LOCK SQL', () => {
    expect(detectLockTable('SELECT * FROM users')).toBe(false);
    expect(detectLockTable('UNLOCK TABLE t')).toBe(false);
    expect(detectLockTable('INSERT INTO t VALUES (1)')).toBe(false);
  });

  it('detects LOCK TABLE statements', () => {
    expect(detectLockTable('LOCK TABLE users')).toBe(true);
    expect(detectLockTable('LOCK TABLE users IN ACCESS EXCLUSIVE MODE')).toBe(true);
    expect(detectLockTable('LOCK TABLE users, posts IN SHARE MODE NOWAIT')).toBe(true);
    expect(detectLockTable('LOCK users')).toBe(true);
  });

  it('returns false when LOCK is not followed by an identifier', () => {
    // "LOCK" followed by non-identifier (e.g. starts with a digit)
    expect(detectLockTable('LOCK 123')).toBe(false);
  });
});

describe('extractLockMode', () => {
  it('returns default for non-string input', () => {
    expect(extractLockMode(undefined as unknown as string)).toBe('ACCESS EXCLUSIVE');
  });

  it('returns default for empty string', () => {
    expect(extractLockMode('')).toBe('ACCESS EXCLUSIVE');
  });

  it('returns default when no IN ... MODE clause', () => {
    expect(extractLockMode('LOCK TABLE users')).toBe('ACCESS EXCLUSIVE');
  });

  it('extracts SHARE mode', () => {
    expect(extractLockMode('LOCK TABLE users IN SHARE MODE')).toBe('SHARE');
  });

  it('extracts ACCESS EXCLUSIVE mode', () => {
    expect(extractLockMode('LOCK TABLE users IN ACCESS EXCLUSIVE MODE')).toBe('ACCESS EXCLUSIVE');
  });

  it('extracts SHARE UPDATE EXCLUSIVE mode', () => {
    expect(extractLockMode('LOCK TABLE t IN SHARE UPDATE EXCLUSIVE MODE')).toBe('SHARE UPDATE EXCLUSIVE');
  });

  it('falls back to default for unknown mode', () => {
    expect(extractLockMode('LOCK TABLE users IN BOGUS MODE')).toBe('ACCESS EXCLUSIVE');
  });

  it('is case-insensitive', () => {
    expect(extractLockMode('lock table users in share mode')).toBe('SHARE');
  });
});

describe('extractLockNowait', () => {
  it('returns false for non-string input', () => {
    expect(extractLockNowait(undefined as unknown as string)).toBe(false);
  });

  it('returns true when NOWAIT present', () => {
    expect(extractLockNowait('LOCK TABLE users NOWAIT')).toBe(true);
    expect(extractLockNowait('LOCK TABLE users IN SHARE MODE NOWAIT')).toBe(true);
  });

  it('returns false when NOWAIT absent', () => {
    expect(extractLockNowait('LOCK TABLE users')).toBe(false);
  });
});

describe('extractLockTableNames', () => {
  it('returns empty for non-string input', () => {
    expect(extractLockTableNames(undefined as unknown as string)).toEqual([]);
  });

  it('returns empty for empty string', () => {
    expect(extractLockTableNames('')).toEqual([]);
  });

  it('returns empty for non-LOCK SQL', () => {
    expect(extractLockTableNames('SELECT 1')).toEqual([]);
  });

  it('extracts single table name', () => {
    expect(extractLockTableNames('LOCK TABLE users')).toEqual(['users']);
  });

  it('extracts multiple table names', () => {
    expect(extractLockTableNames('LOCK TABLE users, posts IN SHARE MODE')).toEqual(['users', 'posts']);
  });

  it('extracts name with IN ACCESS EXCLUSIVE MODE', () => {
    expect(extractLockTableNames('LOCK TABLE t IN ACCESS EXCLUSIVE MODE')).toEqual(['t']);
  });

  it('extracts name without TABLE keyword', () => {
    expect(extractLockTableNames('LOCK t')).toEqual(['t']);
  });

  it('extracts names with NOWAIT only', () => {
    expect(extractLockTableNames('LOCK TABLE a, b NOWAIT')).toEqual(['a', 'b']);
  });

  it('filters out invalid identifiers', () => {
    // "foo bar" contains a space -> invalid identifier -> empty after filter
    expect(extractLockTableNames('LOCK TABLE foo bar')).toEqual([]);
  });

  it('filters out empty/invalid names from comma list', () => {
    expect(extractLockTableNames('LOCK TABLE users,, posts')).toEqual(['users', 'posts']);
  });
});

describe('rewriteLockTable', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteLockTable(undefined as unknown as string)).toEqual({ sql: '', rewritten: false, useTableLock: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteLockTable('')).toEqual({ sql: '', rewritten: false, useTableLock: false });
  });

  it('passes through non-LOCK SQL', () => {
    expect(rewriteLockTable('SELECT * FROM users')).toEqual({
      sql: 'SELECT * FROM users',
      rewritten: false,
      useTableLock: false,
    });
  });

  it('returns table lock info for simple LOCK TABLE', () => {
    const r = rewriteLockTable('LOCK TABLE users');
    expect(r.rewritten).toBe(true);
    expect(r.useTableLock).toBe(true);
    expect(r.sql).toBeNull();
    expect(r.lockInfo).toEqual({
      tableNames: ['users'],
      lockMode: 'ACCESS EXCLUSIVE',
      nowait: false,
    });
  });

  it('returns full lock info (mode + nowait + multiple names)', () => {
    const r = rewriteLockTable('LOCK TABLE users, posts IN SHARE MODE NOWAIT');
    expect(r.rewritten).toBe(true);
    expect(r.useTableLock).toBe(true);
    expect(r.sql).toBeNull();
    expect(r.lockInfo).toEqual({
      tableNames: ['users', 'posts'],
      lockMode: 'SHARE',
      nowait: true,
    });
  });

  it('falls back to SELECT 1 when table names cannot be parsed', () => {
    const r = rewriteLockTable('LOCK TABLE foo bar');
    expect(r).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
      useTableLock: false,
    });
  });

  it('detects LOCK without TABLE keyword', () => {
    const r = rewriteLockTable('LOCK users');
    expect(r.rewritten).toBe(true);
    expect(r.useTableLock).toBe(true);
    expect(r.lockInfo?.tableNames).toEqual(['users']);
  });
});
