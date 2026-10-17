/**
 * advisory-lock-shim.test.ts — Coverage tests for AdvisoryLockShim.
 *
 * Exercises the process-level advisory lock map (acquire/release/timeout
 * lifecycle), argument extraction, lock-id construction, detection, and the
 * SQL rewrite entry points with real lock side effects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  acquireAdvisoryLock,
  releaseAdvisoryLock,
  releaseAllAdvisoryLocks,
  tryAcquireAdvisoryLock,
  getAdvisoryLockCount,
  isAdvisoryLockHeld,
  extractLockArgs,
  buildLockId,
  executeAdvisoryLock,
  detectAdvisoryLock,
  rewriteAdvisoryLock,
} from '../query/AdvisoryLockShim';

beforeEach(() => {
  releaseAllAdvisoryLocks();
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  releaseAllAdvisoryLocks();
});

describe('acquireAdvisoryLock', () => {
  it('acquires a free lock', () => {
    expect(acquireAdvisoryLock('42')).toBe(true);
    expect(getAdvisoryLockCount()).toBe(1);
  });

  it('returns false when lock already held', () => {
    expect(acquireAdvisoryLock('42')).toBe(true);
    expect(acquireAdvisoryLock('42')).toBe(false);
  });

  it('auto-releases and re-acquires when timed out', () => {
    expect(acquireAdvisoryLock('42')).toBe(true);
    // Advance time past the 30s timeout
    vi.mocked(Date.now).mockReturnValue(1_000_000 + 31_000);
    expect(acquireAdvisoryLock('42')).toBe(true);
  });
});

describe('releaseAdvisoryLock', () => {
  it('releases a held lock', () => {
    acquireAdvisoryLock('42');
    expect(releaseAdvisoryLock('42')).toBe(true);
    expect(getAdvisoryLockCount()).toBe(0);
  });

  it('returns false when lock not held', () => {
    expect(releaseAdvisoryLock('nope')).toBe(false);
  });
});

describe('releaseAllAdvisoryLocks', () => {
  it('releases all and returns count', () => {
    acquireAdvisoryLock('1');
    acquireAdvisoryLock('2');
    expect(releaseAllAdvisoryLocks()).toBe(2);
    expect(getAdvisoryLockCount()).toBe(0);
  });

  it('returns 0 when no locks', () => {
    expect(releaseAllAdvisoryLocks()).toBe(0);
  });
});

describe('tryAcquireAdvisoryLock', () => {
  it('delegates to acquireAdvisoryLock', () => {
    expect(tryAcquireAdvisoryLock('42')).toBe(true);
    expect(tryAcquireAdvisoryLock('42')).toBe(false);
  });
});

describe('getAdvisoryLockCount', () => {
  it('cleans up expired locks before counting', () => {
    acquireAdvisoryLock('a');
    acquireAdvisoryLock('b');
    expect(getAdvisoryLockCount()).toBe(2);
    vi.mocked(Date.now).mockReturnValue(1_000_000 + 31_000);
    expect(getAdvisoryLockCount()).toBe(0);
  });
});

describe('isAdvisoryLockHeld', () => {
  it('returns false for unheld lock', () => {
    expect(isAdvisoryLockHeld('zzz')).toBe(false);
  });

  it('returns true for held, unexpired lock', () => {
    acquireAdvisoryLock('42');
    expect(isAdvisoryLockHeld('42')).toBe(true);
  });

  it('returns false and cleans up for expired lock', () => {
    acquireAdvisoryLock('42');
    vi.mocked(Date.now).mockReturnValue(1_000_000 + 31_000);
    expect(isAdvisoryLockHeld('42')).toBe(false);
    expect(getAdvisoryLockCount()).toBe(0);
  });
});

describe('extractLockArgs', () => {
  it('returns null for non-advisory SQL', () => {
    expect(extractLockArgs('SELECT 1')).toBeNull();
    expect(extractLockArgs('')).toBeNull();
  });

  it('extracts single-arg lock', () => {
    expect(extractLockArgs('SELECT pg_advisory_lock(42)')).toEqual({
      fn: 'pg_advisory_lock',
      args: ['42'],
    });
  });

  it('extracts two-arg lock', () => {
    expect(extractLockArgs('SELECT pg_advisory_lock(42, 99)')).toEqual({
      fn: 'pg_advisory_lock',
      args: ['42', '99'],
    });
  });

  it('extracts no-arg unlock_all', () => {
    expect(extractLockArgs('SELECT pg_advisory_unlock_all()')).toEqual({
      fn: 'pg_advisory_unlock_all',
      args: [],
    });
  });

  it('lowercases the function name', () => {
    expect(extractLockArgs('SELECT PG_ADVISORY_LOCK(42)')?.fn).toBe('pg_advisory_lock');
  });

  it('trims whitespace in args', () => {
    expect(extractLockArgs('SELECT pg_advisory_lock( 42 , 99 )')).toEqual({
      fn: 'pg_advisory_lock',
      args: ['42', '99'],
    });
  });

  it('matches try variants', () => {
    expect(extractLockArgs('SELECT pg_try_advisory_lock(1)')?.fn).toBe('pg_try_advisory_lock');
    expect(extractLockArgs('SELECT pg_try_advisory_xact_lock(1)')?.fn).toBe('pg_try_advisory_xact_lock');
    expect(extractLockArgs('SELECT pg_advisory_xact_lock(1)')?.fn).toBe('pg_advisory_xact_lock');
  });

  it('returns null when call has no closing paren', () => {
    expect(extractLockArgs('SELECT pg_advisory_lock(')).toBeNull();
  });
});

describe('buildLockId', () => {
  it('returns empty for no args', () => {
    expect(buildLockId([])).toBe('');
  });
  it('returns single arg', () => {
    expect(buildLockId(['42'])).toBe('42');
  });
  it('joins two args with colon', () => {
    expect(buildLockId(['42', '99'])).toBe('42:99');
  });
  it('ignores args beyond first two', () => {
    expect(buildLockId(['1', '2', '3'])).toBe('1:2');
  });
});

describe('executeAdvisoryLock', () => {
  it('returns pass-through for non-advisory SQL', () => {
    const r = executeAdvisoryLock('SELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });

  it('acquires pg_advisory_lock', () => {
    const r = executeAdvisoryLock('SELECT pg_advisory_lock(42)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
    expect(r.acquired).toBe(true);
  });

  it('acquires pg_advisory_xact_lock', () => {
    const r = executeAdvisoryLock('SELECT pg_advisory_xact_lock(42)');
    expect(r.acquired).toBe(true);
  });

  it('tries pg_try_advisory_lock (free → acquired)', () => {
    const r = executeAdvisoryLock('SELECT pg_try_advisory_lock(42)');
    expect(r.acquired).toBe(true);
  });

  it('tries pg_try_advisory_xact_lock (held → not acquired)', () => {
    acquireAdvisoryLock('42');
    const r = executeAdvisoryLock('SELECT pg_try_advisory_xact_lock(42)');
    expect(r.acquired).toBe(false);
  });

  it('releases pg_advisory_unlock', () => {
    acquireAdvisoryLock('42');
    const r = executeAdvisoryLock('SELECT pg_advisory_unlock(42)');
    expect(r.released).toBe(true);
  });

  it('releases pg_advisory_unlock (not held → released false)', () => {
    const r = executeAdvisoryLock('SELECT pg_advisory_unlock(42)');
    expect(r.released).toBe(false);
  });

  it('releases all via pg_advisory_unlock_all', () => {
    acquireAdvisoryLock('1');
    acquireAdvisoryLock('2');
    const r = executeAdvisoryLock('SELECT pg_advisory_unlock_all()');
    expect(r.released).toBe(true);
    expect(getAdvisoryLockCount()).toBe(0);
  });

  it('unlock_all with no locks → released false', () => {
    const r = executeAdvisoryLock('SELECT pg_advisory_unlock_all()');
    expect(r.released).toBe(false);
  });

  it('two-arg lock uses combined lock id', () => {
    const r = executeAdvisoryLock('SELECT pg_advisory_lock(42, 99)');
    expect(r.acquired).toBe(true);
    expect(isAdvisoryLockHeld('42:99')).toBe(true);
  });
});

describe('detectAdvisoryLock', () => {
  it('returns false for non-string', () => {
    expect(detectAdvisoryLock(undefined as any)).toBe(false);
    expect(detectAdvisoryLock(null as any)).toBe(false);
  });

  it('returns false for empty/whitespace', () => {
    expect(detectAdvisoryLock('')).toBe(false);
    expect(detectAdvisoryLock('   ')).toBe(false);
  });

  it('detects lock call', () => {
    expect(detectAdvisoryLock('SELECT pg_advisory_lock(42)')).toBe(true);
    expect(detectAdvisoryLock('SELECT pg_advisory_unlock_all()')).toBe(true);
  });

  it('returns false for non-lock SQL', () => {
    expect(detectAdvisoryLock('SELECT 1')).toBe(false);
  });

  it('does not match partial identifier', () => {
    expect(detectAdvisoryLock('SELECT my_pg_advisory_lock(42)')).toBe(false);
  });
});

describe('rewriteAdvisoryLock', () => {
  it('returns empty sql unchanged for non-string/empty', () => {
    expect(rewriteAdvisoryLock('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteAdvisoryLock(undefined as any).rewritten).toBe(false);
  });

  it('passes through non-lock SQL', () => {
    expect(rewriteAdvisoryLock('SELECT * FROM t')).toEqual({
      sql: 'SELECT * FROM t',
      rewritten: false,
    });
  });

  it('passes through complex SQL embedding a lock call', () => {
    const sql = 'SELECT * FROM t WHERE pg_advisory_lock(42) IS NOT NULL';
    const r = rewriteAdvisoryLock(sql);
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe(sql);
  });

  it('rewrites simple SELECT advisory lock', () => {
    const r = rewriteAdvisoryLock('SELECT pg_advisory_lock(42);');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
    expect(r.acquired).toBe(true);
  });

  it('rewrites multi-line SELECT advisory lock', () => {
    const r = rewriteAdvisoryLock('  SELECT\n  pg_advisory_lock(42) ');
    expect(r.rewritten).toBe(true);
    expect(r.acquired).toBe(true);
  });
});
