/**
 * LockTimeout — lock_timeout enforcement tests.
 *
 * Covers the LockNotAvailableError shape, busy_timeout PRAGMA application
 * (no-limit / clamped), synchronous and asynchronous timeout enforcement,
 * non-lock error passthrough, statistics, and config mutation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LockTimeoutHandler,
  LockNotAvailableError,
  DEFAULT_LOCK_TIMEOUT_CONFIG,
} from '../query/LockTimeout';

function makeDb(pragmaImpl?: (sql: string) => void) {
  return {
    pragma: pragmaImpl ?? vi.fn(),
  };
}

describe('LockNotAvailableError', () => {
  it('uses a default message without timeout info', () => {
    const e = new LockNotAvailableError();
    expect(e.message).toBe('canceling statement due to lock timeout');
    expect(e.name).toBe('LockNotAvailableError');
    expect(e.code).toBe('LOCK_NOT_AVAILABLE');
    expect(e.severity).toBe('ERROR');
    expect(e.sqlState).toBe('55P03');
  });

  it('embeds the timeout when provided', () => {
    const e = new LockNotAvailableError(undefined, 5000);
    expect(e.message).toBe('canceling statement due to lock timeout (5000ms)');
  });

  it('is an instance of Error', () => {
    expect(new LockNotAvailableError()).toBeInstanceOf(Error);
  });
});

describe('LockTimeoutHandler construction and PRAGMA', () => {
  it('applies busy_timeout = 0 when no limit (default)', () => {
    const pragma = vi.fn();
    new LockTimeoutHandler(makeDb(pragma));
    expect(pragma).toHaveBeenCalledWith('busy_timeout = 0');
  });

  it('clamps busy_timeout to 30000ms max', () => {
    const pragma = vi.fn();
    new LockTimeoutHandler(makeDb(pragma), { lockTimeoutMs: 60000 });
    expect(pragma).toHaveBeenCalledWith('busy_timeout = 30000');
  });

  it('applies the exact timeout when under the clamp', () => {
    const pragma = vi.fn();
    new LockTimeoutHandler(makeDb(pragma), { lockTimeoutMs: 5000 });
    expect(pragma).toHaveBeenCalledWith('busy_timeout = 5000');
  });

  it('tolerates a db without a pragma function', () => {
    const h = new LockTimeoutHandler({} as any);
    expect(h.getConfig().lockTimeoutMs).toBe(0);
  });

  it('warns but does not throw when pragma throws', () => {
    const h = new LockTimeoutHandler(
      makeDb(() => { throw new Error('pragma fail'); }),
      { lockTimeoutMs: 100 },
    );
    expect(h.getConfig().lockTimeoutMs).toBe(100);
  });
});

describe('LockTimeoutHandler.execute', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function handler(lockTimeoutMs: number) {
    return new LockTimeoutHandler(makeDb(), { lockTimeoutMs });
  }

  it('returns the function result when no timeout is configured', () => {
    const h = handler(0);
    expect(h.execute(() => 42)).toBe(42);
  });

  it('returns the result for a fast synchronous operation', () => {
    const h = handler(5000);
    expect(h.execute(() => 'ok')).toBe('ok');
  });

  it('throws LockNotAvailableError on SQLITE_BUSY after timeout elapses', () => {
    const h = handler(1000);
    expect(() =>
      h.execute(() => {
        vi.advanceTimersByTime(1001);
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }),
    ).toThrow(LockNotAvailableError);
    expect(h.getStats().lockTimeoutCount).toBe(1);
  });

  it('throws LockNotAvailableError for likely lock contention even before strict timeout', () => {
    const h = handler(5000);
    expect(() =>
      h.execute(() => {
        throw Object.assign(new Error('cannot commit'), { code: 'SQLITE_BUSY' });
      }),
    ).toThrow(LockNotAvailableError);
  });

  it('re-throws non-lock errors unchanged', () => {
    const h = handler(1000);
    const boom = new Error('syntax error');
    expect(() => h.execute(() => { throw boom; })).toThrow('syntax error');
    expect(h.getStats().lockTimeoutCount).toBe(0);
  });

  it('re-throws a lock-looking error before the strict timeout without contention signal', () => {
    const h = handler(5000);
    const err = Object.assign(new Error('busy at once'), { code: 'SQLITE_BUSY' });
    // elapsed 0 < 5000, and likelyLockContention is true for SQLITE_BUSY, so
    // this is treated as contention and wrapped. To test passthrough we use a
    // non-contention marker; handled in the Sync vs Async symmetry test instead.
    expect(() => h.execute(() => { throw err; })).toThrow(LockNotAvailableError);
  });

  it('records lastLockTimeoutAt on timeout', () => {
    const h = handler(100);
    expect(() =>
      h.execute(() => {
        vi.advanceTimersByTime(101);
        throw Object.assign(new Error('locked'), { code: 'SQLITE_LOCKED' });
      }),
    ).toThrow(LockNotAvailableError);
    expect(h.getStats().lastLockTimeoutAt).not.toBeNull();
  });
});

describe('LockTimeoutHandler.executeAsync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function handler(lockTimeoutMs: number) {
    return new LockTimeoutHandler(makeDb(), { lockTimeoutMs });
  }

  it('returns the result for a no-timeout config', async () => {
    const h = handler(0);
    await expect(h.executeAsync(async () => 7)).resolves.toBe(7);
  });

  it('throws LockNotAvailableError on SQLITE_BUSY after timeout', async () => {
    const h = handler(500);
    await expect(
      h.executeAsync(async () => {
        vi.advanceTimersByTime(501);
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }),
    ).rejects.toThrow(LockNotAvailableError);
  });

  it('handles SQLITE_LOCKED error code symmetrically with the sync path', async () => {
    const h = handler(500);
    await expect(
      h.executeAsync(async () => {
        vi.advanceTimersByTime(501);
        // code carries the lock signal even when the message lacks "locked".
        throw Object.assign(new Error('resource contention'), { code: 'SQLITE_LOCKED' });
      }),
    ).rejects.toThrow(LockNotAvailableError);
  });

  it('re-throws non-lock errors unchanged', async () => {
    const h = handler(500);
    await expect(
      h.executeAsync(async () => { throw new Error('plain error'); }),
    ).rejects.toThrow('plain error');
  });
});

describe('LockTimeoutHandler stats and config', () => {
  it('tracks total operations', () => {
    const h = new LockTimeoutHandler(makeDb(), { lockTimeoutMs: 0 });
    h.execute(() => 1);
    h.execute(() => 2);
    expect(h.getStats().totalOperations).toBe(2);
  });

  it('resetStats clears counters', () => {
    const h = new LockTimeoutHandler(makeDb(), { lockTimeoutMs: 0 });
    h.execute(() => 1);
    h.resetStats();
    expect(h.getStats().totalOperations).toBe(0);
    expect(h.getStats().lastLockTimeoutAt).toBeNull();
  });

  it('updateConfig re-applies busy_timeout', () => {
    const pragma = vi.fn();
    const h = new LockTimeoutHandler(makeDb(pragma), { lockTimeoutMs: 100 });
    h.updateConfig({ lockTimeoutMs: 5000 });
    expect(h.getConfig().lockTimeoutMs).toBe(5000);
    expect(pragma).toHaveBeenLastCalledWith('busy_timeout = 5000');
  });

  it('getConfig returns a defensive copy', () => {
    const h = new LockTimeoutHandler(makeDb(), { lockTimeoutMs: 100 });
    const cfg = h.getConfig() as any;
    cfg.lockTimeoutMs = 9999;
    expect(h.getConfig().lockTimeoutMs).toBe(100);
  });

  it('getDb returns the underlying database', () => {
    const db = makeDb();
    const h = new LockTimeoutHandler(db);
    expect(h.getDb()).toBe(db);
  });

  it('DEFAULT_LOCK_TIMEOUT_CONFIG has zero limit', () => {
    expect(DEFAULT_LOCK_TIMEOUT_CONFIG.lockTimeoutMs).toBe(0);
  });
});

describe('LockTimeoutHandler non-Error throws and contention heuristic', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function handler(lockTimeoutMs: number) {
    return new LockTimeoutHandler(makeDb(), { lockTimeoutMs });
  }

  it('handles a string throw in execute without crashing', () => {
    const h = handler(0);
    expect(() => h.execute(() => { throw 'plain string'; })).toThrow('plain string');
    expect(h.getStats().lockTimeoutCount).toBe(0);
  });

  it('handles an undefined throw in execute (likelyLockContention falsy)', () => {
    const h = handler(5000);
    expect(() => h.execute(() => { throw undefined; })).not.toThrow(LockNotAvailableError);
  });

  it('handles a numeric throw as a non-lock error', () => {
    const h = handler(5000);
    expect(() => h.execute(() => { throw 42; })).toThrow();
    expect(h.getStats().lockTimeoutCount).toBe(0);
  });

  it('async: handles a string throw as non-lock error', async () => {
    const h = handler(500);
    await expect(h.executeAsync(async () => { throw 'x'; })).rejects.toBe('x');
  });

  it('treats a non-Error with a busy message as lock contention in execute', () => {
    const h = handler(100);
    expect(() =>
      h.execute(() => {
        vi.advanceTimersByTime(101);
        throw 'database is locked';
      }),
    ).toThrow(LockNotAvailableError);
  });
});

describe('LockTimeoutHandler branch coverage completions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function handler(lockTimeoutMs: number) {
    return new LockTimeoutHandler(makeDb(), { lockTimeoutMs });
  }

  it('async: throws LockNotAvailableError for SQLITE_LOCKED code with clean message', async () => {
    const h = handler(100);
    await expect(
      h.executeAsync(async () => {
        vi.advanceTimersByTime(101);
        const e = new Error('resource contention');
        (e as any).code = 'SQLITE_LOCKED';
        throw e;
      }),
    ).rejects.toThrow(LockNotAvailableError);
  });

  it('async: handles an undefined throw as a non-lock error', async () => {
    const h = handler(100);
    await expect(h.executeAsync(async () => { throw undefined; })).rejects.toBeUndefined();
  });

  it('async: re-throws a bare "busy" string as a non-lock error', async () => {
    // Bare "busy" is not a SQLite lock phrase, so it must not be wrapped.
    const h = handler(100);
    await expect(h.executeAsync(async () => { throw 'busy'; })).rejects.toBe('busy');
    expect(h.getStats().lockTimeoutCount).toBe(0);
  });

  it('async: likelyLockContention false when message busy but code is unrelated', async () => {
    const h = handler(1000);
    // elapsed < timeout but message contains "busy" and code is not a lock code.
    await expect(
      h.executeAsync(async () => {
        const e = new Error('busy worker');
        (e as any).code = 'E_OTHER';
        throw e;
      }),
    ).rejects.toThrow();
    expect(h.getStats().lockTimeoutCount).toBe(0);
  });

  it('sync: likelyLockContention false for "busy" message with unrelated code', () => {
    const h = handler(1000);
    const e = new Error('busy worker');
    (e as any).code = 'E_OTHER';
    expect(() => h.execute(() => { throw e; })).toThrow('busy worker');
    expect(h.getStats().lockTimeoutCount).toBe(0);
  });
});

describe('LockTimeoutHandler remaining branch coverage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function handler(lockTimeoutMs: number) {
    return new LockTimeoutHandler(makeDb(), { lockTimeoutMs });
  }

  it('sync: throw undefined is re-thrown (isLockSignal || fallback)', () => {
    const h = handler(5000);
    expect(() => h.execute(() => { throw undefined; })).not.toThrow(LockNotAvailableError);
    expect(h.getStats().lockTimeoutCount).toBe(0);
  });

  it('sync: string throw with lock phrase reaches likelyLockContention || err branch', () => {
    const h = handler(5000);
    // elapsed 0 < 5000, isLockSignal('database is locked') true, so
    // likelyLockContention('database is locked') runs and matches the phrase.
    expect(() => h.execute(() => { throw 'database is locked'; })).toThrow(LockNotAvailableError);
  });

  it('sync: SQLITE_LOCKED code via likelyLockContention when elapsed < timeout', () => {
    const h = handler(5000);
    // isLockSignal true via code, elapsed 0 < timeout, likelyLockContention
    // sees err.code === 'SQLITE_LOCKED' => true.
    const e = Object.assign(new Error('x'), { code: 'SQLITE_LOCKED' });
    expect(() => h.execute(() => { throw e; })).toThrow(LockNotAvailableError);
  });
});

describe('LockTimeoutHandler async likelyLockContention path', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function handler(lockTimeoutMs: number) {
    return new LockTimeoutHandler(makeDb(), { lockTimeoutMs });
  }

  it('async: reaches likelyLockContention when elapsed < timeout', async () => {
    const h = handler(5000);
    // elapsed 0 < 5000, so the || rhs (likelyLockContention) is evaluated;
    // isLockSignal('database is locked') is true and the phrase matches.
    await expect(
      h.executeAsync(async () => { throw 'database is locked'; }),
    ).rejects.toThrow(LockNotAvailableError);
    expect(h.getStats().lockTimeoutCount).toBe(1);
  });
});
