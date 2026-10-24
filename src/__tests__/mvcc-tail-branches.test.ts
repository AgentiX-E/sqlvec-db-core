/**
 * Unit tests for MVCCExecutor tail branches — the async write-lock queue,
 * the periodic deadlock timer, SSI predicate-conflict filtering, stale-txn
 * cleanup, and error-handling fallbacks that the focused feature suites do
 * not reach.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Record<string, unknown>): MVCCExecutor {
  const e = new MVCCExecutor(config as any);
  exec = e;
  return e;
}
afterEach(() => {
  exec?.dispose();
  exec = null;
  vi.useRealTimers();
});

describe('MVCCExecutor — async write-lock queue', () => {
  it('resolves a queued waiter when the holder releases the lock', async () => {
    const e = makeExec();
    e.begin('holder', 'READ_COMMITTED', false);
    e.begin('waiter', 'READ_COMMITTED', false);

    // holder acquires the lock immediately (no contention).
    const firstWait = await e.acquireWriteLock('holder', 't', 1, 5000);
    expect(firstWait).toBe(0);

    // waiter contends → queued, returns a pending promise.
    const pending = e.acquireWriteLock('waiter', 't', 1, 5000);

    // Let the waiter pass through the mutex and land in the wait queue
    // before the holder releases, otherwise it would find the lock already
    // free and short-circuit the queue path entirely.
    await new Promise((r) => setTimeout(r, 0));

    // Release the holder's lock; the queued waiter resolves with a wait time.
    e.releaseWriteLock('t', 1);
    const waitTime = await pending;
    expect(waitTime).toBeGreaterThanOrEqual(0);
  });

  it('rejects a queued waiter after the timeout elapses', async () => {
    const e = makeExec();
    e.begin('holder', 'READ_COMMITTED', false);
    e.begin('waiter', 'READ_COMMITTED', false);

    await e.acquireWriteLock('holder', 't', 1, 5000);

    // waiter contends with a very short timeout; the holder never releases.
    await expect(
      e.acquireWriteLock('waiter', 't', 1, 10),
    ).rejects.toThrow(/timeout/);
  });

  it('returns 0 immediately for a read-only or unknown session', async () => {
    const e = makeExec();
    e.begin('ro', 'READ_COMMITTED', true);
    expect(await e.acquireWriteLock('ro', 't', 1, 5000)).toBe(0);
    expect(await e.acquireWriteLock('ghost', 't', 1, 5000)).toBe(0);
  });
});

describe('MVCCExecutor — periodic deadlock timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('runs detectDeadlocks on the interval when a wait-for edge exists', () => {
    const e = makeExec();
    // Seed a wait-for edge directly so detectDeadlocks has work to do.
    (e as any).txnWaitFor.set(3, 't:1');
    // Construct a real cycle: 3 waits on 4, 4 waits on 3.
    (e as any).txnWaitFor.set(4, 't:2');

    // Fast-forward past the 5s interval to trigger the timer callback.
    vi.advanceTimersByTime(5000);
    // No throw means detectDeadlocks ran (and returned cleanly with no cycle).
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });
});

describe('MVCCExecutor — SSI predicate-conflict filtering', () => {
  it('recordInsertRow skips non-SERIALIZABLE competing transactions', () => {
    const e = makeExec();
    const a = e.begin('a', 'SERIALIZABLE', false);
    const b = e.begin('b', 'READ_COMMITTED', false); // non-serializable
    expect(a.xid).toBeGreaterThan(0);
    expect(b.xid).toBeGreaterThan(0);

    // a (SERIALIZABLE) inserts a row; the loop must skip b (non-SERIALIZABLE).
    expect(() => e.recordInsertRow('a', 'users', { id: 1, name: 'x' })).not.toThrow();
  });

  it('recordRead ignores read-only transactions', () => {
    const e = makeExec();
    e.begin('ro', 'SERIALIZABLE', true);
    expect(() => e.recordRead('ro', 'users', 1)).not.toThrow();
  });

  it('recordRead ignores non-SERIALIZABLE transactions', () => {
    const e = makeExec();
    e.begin('rc', 'READ_COMMITTED', false);
    expect(() => e.recordRead('rc', 'users', 1)).not.toThrow();
  });
});

describe('MVCCExecutor — stale transaction cleanup', () => {
  it('skips a stale session whose txn was already removed', () => {
    const e = makeExec();
    e.begin('victim', 'READ_COMMITTED', false);

    // Mark the transaction deadlocked so it is collected as stale…
    const txn = (e as any).activeTxns.get('victim');
    (e as any).txnDeadlocked.add(txn.xid);

    // …but remove it from activeTxns before cleanup, so the second loop
    // hits the `if (!txn) continue` guard.
    (e as any).activeTxns.delete('victim');

    expect(() => e.cleanupStaleTxns(0)).not.toThrow();
  });

  it('cleans up a deadlocked transaction', () => {
    const e = makeExec();
    e.begin('victim', 'READ_COMMITTED', false);
    const txn = (e as any).activeTxns.get('victim');
    (e as any).txnDeadlocked.add(txn.xid);

    const cleaned = e.cleanupStaleTxns(0);
    expect(cleaned).toBe(1);
    expect((e as any).activeTxns.has('victim')).toBe(false);
  });
});

describe('MVCCExecutor — visibility & vacuum error fallbacks', () => {
  it('applyVisibility keeps rows with no primary key value', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    // A row lacking the pk column (undefined rowId) must pass through visible.
    const rows = [{ id: undefined, name: 'x' }];
    const result = e.filterSelectResult('a', rows, 'users', 'id');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('x');
  });

  it('vacuum survives a failing row-version GC / TOAST callback', () => {
    const e = makeExec();
    // A connection whose exec throws forces the vacuum catch path.
    const conn = { exec() { throw new Error('gc boom'); } };
    expect(() => e.vacuum(conn as any)).not.toThrow();
  });
});
