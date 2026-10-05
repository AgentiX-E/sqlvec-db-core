import { describe, it, expect } from 'vitest';
import { AdvisoryLockEngine } from '../query/AdvisoryLockEngine';

/**
 * AdvisoryLockEngine — PostgreSQL-style reentrant advisory locks.
 *
 * These tests exercise the full reentrancy, timeout, and cleanup semantics
 * against the real async-mutex-backed implementation, including the
 * reentrancy-count and timeout behaviors that were previously broken.
 */

describe('acquire / release (basic)', () => {
  it('acquires a lock and tracks a single held key', async () => {
    const eng = new AdvisoryLockEngine();
    expect(await eng.acquire(42n, 's1')).toBe(true);
    expect(eng.lockCount).toBe(1);
  });

  it('release unlocks the mutex and removes the entry when the last hold is released', async () => {
    const eng = new AdvisoryLockEngine();
    await eng.acquire(42n, 's1');
    expect(eng.release(42n, 's1')).toBe(true);
    expect(eng.lockCount).toBe(0);
  });

  it('release returns false for an unknown key', () => {
    const eng = new AdvisoryLockEngine();
    expect(eng.release(42n, 's1')).toBe(false);
  });

  it('release returns false when the session does not hold the lock', async () => {
    const eng = new AdvisoryLockEngine();
    await eng.acquire(42n, 's1');
    expect(eng.release(42n, 's2')).toBe(false);
    expect(eng.lockCount).toBe(1); // still held by s1
  });

  it('distinguishes locks by key', async () => {
    const eng = new AdvisoryLockEngine();
    await eng.acquire(1n, 's1');
    await eng.acquire(2n, 's1');
    expect(eng.lockCount).toBe(2);
    eng.release(1n, 's1');
    expect(eng.lockCount).toBe(1);
  });
});

describe('reentrancy', () => {
  it('counts repeated acquisitions and releases one hold at a time', async () => {
    const eng = new AdvisoryLockEngine();
    expect(await eng.acquire(42n, 's1')).toBe(true);
    expect(await eng.acquire(42n, 's1')).toBe(true);
    expect(eng.lockCount).toBe(1);

    // First release drops the count from 2 -> 1; lock still held.
    expect(eng.release(42n, 's1')).toBe(true);
    expect(eng.lockCount).toBe(1);

    // Second (final) release actually unlocks.
    expect(eng.release(42n, 's1')).toBe(true);
    expect(eng.lockCount).toBe(0);
  });

  it('keeps the lock held by a reentrant session across a release', async () => {
    const eng = new AdvisoryLockEngine();
    await eng.acquire(42n, 's1');
    await eng.acquire(42n, 's1'); // reentrant
    eng.release(42n, 's1'); // still one hold remaining

    // Another session must NOT be able to grab it yet.
    expect(await eng.tryAcquire(42n, 's2')).toBe(false);
  });

  it('allows another session to tryAcquire after the final release', async () => {
    const eng = new AdvisoryLockEngine();
    await eng.acquire(42n, 's1');
    await eng.acquire(42n, 's1');
    eng.release(42n, 's1');
    eng.release(42n, 's1');
    expect(await eng.tryAcquire(42n, 's2')).toBe(true);
  });
});

describe('tryAcquire', () => {
  it('returns false when held by another session', async () => {
    const eng = new AdvisoryLockEngine();
    await eng.acquire(42n, 's1');
    expect(await eng.tryAcquire(42n, 's2')).toBe(false);
  });

  it('succeeds when the lock is free', async () => {
    const eng = new AdvisoryLockEngine();
    expect(await eng.tryAcquire(42n, 's1')).toBe(true);
  });

  it('is reentrant for the holding session', async () => {
    const eng = new AdvisoryLockEngine();
    expect(await eng.tryAcquire(42n, 's1')).toBe(true);
    expect(await eng.tryAcquire(42n, 's1')).toBe(true);
    expect(eng.lockCount).toBe(1);
  });
});

describe('timeout', () => {
  it('returns false after the timeout when the lock is held elsewhere', async () => {
    const eng = new AdvisoryLockEngine();
    await eng.acquire(42n, 's1');

    const start = Date.now();
    const result = await eng.acquire(42n, 's2', 50);
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('eventually acquires when the holder releases before the timeout', async () => {
    const eng = new AdvisoryLockEngine();
    await eng.acquire(42n, 's1');

    // Release after a short delay; the waiter with a generous timeout succeeds.
    const held = eng.acquire(42n, 's2', 500);
    setTimeout(() => eng.release(42n, 's1'), 20);

    expect(await held).toBe(true);
  });

  it('ignores a negative timeout and blocks normally', async () => {
    const eng = new AdvisoryLockEngine();
    expect(await eng.acquire(42n, 's1', -1)).toBe(true);
  });
});

describe('releaseAllBySession', () => {
  it('releases every lock held by a session', async () => {
    const eng = new AdvisoryLockEngine();
    await eng.acquire(1n, 's1');
    await eng.acquire(2n, 's1');
    await eng.acquire(3n, 's2');

    expect(eng.releaseAllBySession('s1')).toBe(2);
    expect(eng.lockCount).toBe(1); // only s2's lock remains
  });

  it('releases all reentrant holds for a session', async () => {
    const eng = new AdvisoryLockEngine();
    await eng.acquire(1n, 's1');
    await eng.acquire(1n, 's1'); // reentrant
    await eng.acquire(2n, 's1');

    expect(eng.releaseAllBySession('s1')).toBe(2);
    expect(eng.lockCount).toBe(0);
  });

  it('returns 0 when the session holds nothing', async () => {
    const eng = new AdvisoryLockEngine();
    await eng.acquire(1n, 's1');
    expect(eng.releaseAllBySession('s2')).toBe(0);
    expect(eng.lockCount).toBe(1);
  });
});

describe('lockCount', () => {
  it('starts at zero', () => {
    expect(new AdvisoryLockEngine().lockCount).toBe(0);
  });
});
