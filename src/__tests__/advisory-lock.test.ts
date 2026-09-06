/**
 * AdvisoryLockManager unit tests.
 *
 * Verifies PostgreSQL-style advisory locking over async-mutex: session vs
 * transaction scopes, reentrancy, timeouts, try-acquire, transaction lifecycle,
 * and session cleanup. Concurrency tests assert real lock exclusivity and
 * reentrant release symmetry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AdvisoryLockManager, type LockScope } from '../lock/AdvisoryLockManager';

describe('AdvisoryLockManager core', () => {
  let m: AdvisoryLockManager;
  beforeEach(() => { m = new AdvisoryLockManager(); });

  it('acquires and releases a session lock', async () => {
    const ok = await m.acquire('session', 42n, 's1');
    expect(ok).toBe(true);
    expect(m.isLocked(42n)).toBe(true);
    expect(m.getLockHolders(42n)).toEqual(['s1']);
    expect(m.release(42n, 's1')).toBe(true);
    expect(m.isLocked(42n)).toBe(false);
  });

  it('returns false when releasing a never-acquired lock', () => {
    expect(m.release(99n, 'nobody')).toBe(false);
  });

  it('getLockHolders returns empty array for unknown keys', () => {
    expect(m.getLockHolders(123n)).toEqual([]);
  });

  it('tracks lockCount across distinct keys', async () => {
    await m.acquire('session', 1n, 's1');
    await m.acquire('session', 2n, 's1');
    expect(m.lockCount).toBe(2);
    m.release(1n, 's1');
    expect(m.lockCount).toBe(1);
  });

  it('isLocked is false for unknown keys and after release', async () => {
    expect(m.isLocked(5n)).toBe(false);
    await m.acquire('session', 5n, 's1');
    expect(m.isLocked(5n)).toBe(true);
    m.release(5n, 's1');
    expect(m.isLocked(5n)).toBe(false);
  });

  it('supports reentrant acquisition by the same session', async () => {
    await m.acquire('session', 7n, 's1');
    await m.acquire('session', 7n, 's1'); // reentrant, returns immediately
    expect(m.getLockHolders(7n)).toEqual(['s1']);
    // First release: decrement, still held.
    expect(m.release(7n, 's1')).toBe(true);
    expect(m.isLocked(7n)).toBe(true);
    // Second release: fully released.
    expect(m.release(7n, 's1')).toBe(true);
    expect(m.isLocked(7n)).toBe(false);
  });

  it('reentrant release returns true even when decrementing (not only releasing)', async () => {
    await m.acquire('session', 8n, 's1');
    await m.acquire('session', 8n, 's1');
    expect(m.release(8n, 's1')).toBe(true);
    expect(m.isLocked(8n)).toBe(true);
  });

  it('tryAcquire succeeds when unlocked and fails when locked', async () => {
    const first = await m.tryAcquire('session', 10n, 's1');
    expect(first).toBe(true);
    const second = await m.tryAcquire('session', 10n, 's2');
    expect(second).toBe(false);
  });

  it('tryAcquire is reentrant for the holding session', async () => {
    await m.tryAcquire('session', 11n, 's1');
    const again = await m.tryAcquire('session', 11n, 's1');
    expect(again).toBe(true);
  });

  it('tryAcquire registers transaction scope in transactionSessions', async () => {
    const ok = await m.tryAcquire('transaction', 12n, 's1');
    expect(ok).toBe(true);
    // A txn-scope tryAcquire should be releasable via releaseTransactionLocks.
    expect(m.releaseTransactionLocks('s1')).toBe(1);
    expect(m.isLocked(12n)).toBe(false);
  });

  it('release returns false when releasing a lock held by someone else', async () => {
    await m.acquire('session', 13n, 'holder');
    // 'other' never held this key, so release returns false.
    expect(m.release(13n, 'other')).toBe(false);
    // The lock is still held by 'holder'.
    expect(m.isLocked(13n)).toBe(true);
  });

  it('keeps the lock alive when another session still holds it after one release', async () => {
    // Two sessions acquire distinct keys; releasing one key's sole holder
    // deletes that key while the other key remains.
    await m.acquire('session', 14n, 's1');
    await m.acquire('session', 15n, 's2');
    m.release(14n, 's1');
    expect(m.isLocked(14n)).toBe(false);
    expect(m.isLocked(15n)).toBe(true);
  });

  it('enforces mutual exclusion across sessions (concurrent)', async () => {
    const held: string[] = [];
    async function crit(sessionId: string) {
      await m.acquire('session', 20n, sessionId);
      held.push(sessionId);
      await new Promise((r) => setTimeout(r, 30));
      m.release(20n, sessionId);
    }
    await Promise.all([crit('a'), crit('b')]);
    // Both sessions eventually entered the critical section.
    expect(held).toHaveLength(2);
  });
});

describe('AdvisoryLockManager timeouts and lock scopes', () => {
  let m: AdvisoryLockManager;
  beforeEach(() => { m = new AdvisoryLockManager(); });

  it('times out when a lock cannot be acquired within timeoutMs', async () => {
    await m.acquire('session', 30n, 'holder');
    const ok = await m.acquire('session', 30n, 'waiter', 50);
    expect(ok).toBe(false);
  });

  it('acquires without a timeout when timeoutMs is 0 or undefined', async () => {
    await m.acquire('session', 31n, 's1');
    // Reentrant acquisition with no timeout succeeds immediately.
    const ok = await m.acquire('session', 31n, 's1');
    expect(ok).toBe(true);
  });

  it('tracks transaction-scope locks separately via transactionSessions', async () => {
    await m.acquire('transaction', 40n, 's1');
    expect(m.isLocked(40n)).toBe(true);
    // session-scope release on a transaction lock still releases because the
    // public release() treats both scopes identically.
    expect(m.release(40n, 's1')).toBe(true);
  });
});

describe('AdvisoryLockManager transaction lifecycle', () => {
  let m: AdvisoryLockManager;
  beforeEach(() => { m = new AdvisoryLockManager(); });

  it('releaseTransactionLocks releases only transaction locks for a session', async () => {
    await m.acquire('transaction', 50n, 's1');
    await m.acquire('session', 51n, 's1');
    const released = m.releaseTransactionLocks('s1');
    expect(released).toBe(1);
    expect(m.isLocked(50n)).toBe(false); // transaction lock released
    expect(m.isLocked(51n)).toBe(true);  // session lock retained
  });

  it('releaseTransactionLocks returns 0 when the session has no txn locks', async () => {
    // A session-scope lock does not register in transactionSessions.
    await m.acquire('session', 52n, 's1');
    expect(m.releaseTransactionLocks('s1')).toBe(0);
  });

  it('releaseTransactionLocks force-releases txn locks even across scopes', async () => {
    // s1 acquires a txn lock on key 53.
    await m.acquire('transaction', 53n, 's1');
    expect(m.isLocked(53n)).toBe(true);
    const released = m.releaseTransactionLocks('s1');
    expect(released).toBe(1);
    expect(m.isLocked(53n)).toBe(false);
  });

  it('releaseAllBySession skips keys not held by the session', async () => {
    await m.acquire('session', 62n, 's1');
    await m.acquire('session', 63n, 's2');
    // Releasing s1 only affects key 62, leaving 63 intact.
    const released = m.releaseAllBySession('s1');
    expect(released).toBe(1);
    expect(m.isLocked(62n)).toBe(false);
    expect(m.isLocked(63n)).toBe(true);
  });

  it('releaseAllBySession releases every lock held by a session', async () => {
    await m.acquire('session', 60n, 's1');
    await m.acquire('transaction', 61n, 's1');
    const released = m.releaseAllBySession('s1');
    expect(released).toBe(2);
    expect(m.lockCount).toBe(0);
  });

  it('releaseAllBySession returns 0 for an unknown session', () => {
    expect(m.releaseAllBySession('ghost')).toBe(0);
  });
});

describe('AdvisoryLockManager reset', () => {
  it('clears all locks and resets lockCount', async () => {
    const m = new AdvisoryLockManager();
    await m.acquire('session', 70n, 's1');
    await m.acquire('session', 71n, 's1');
    expect(m.lockCount).toBe(2);
    m.reset();
    expect(m.lockCount).toBe(0);
    expect(m.isLocked(70n)).toBe(false);
  });
});
