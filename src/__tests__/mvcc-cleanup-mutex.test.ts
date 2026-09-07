import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor cleanupStaleTxns boundaries', () => {
  it('returns 0 when no stale txns', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    expect(e.cleanupStaleTxns(60000)).toBe(0);
  });

  it('cleans up deadlocked transactions regardless of age', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnDeadlocked.add(a.xid);
    // maxAgeMs huge → fresh txn, but deadlocked marker forces stale.
    const count = e.cleanupStaleTxns(3_600_000);
    expect(count).toBe(1);
  });

  it('cleans up stale txns with retries or wait-for', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    a.started = Date.now() - 999_999; // very old (> maxAge)
    (e as any).conflictStats.set('a', { totalRetries: 3, conflictCount: 0 });
    const count = e.cleanupStaleTxns(1000);
    expect(count).toBe(1);
  });

  it('skips old txns without retries or wait-for', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    a.started = Date.now() - 999_999; // old, but no retries & not waiting
    const count = e.cleanupStaleTxns(1000);
    expect(count).toBe(0);
  });
});

describe('MVCCExecutor row mutex refCount lifecycle', () => {
  it('lockRow/unlockRow creates and deletes entry at refCount 0', async () => {
    const e = makeExec();
    await e.lockRow('t', 1);
    expect((e as any).rowMutexes.has('lock:t:1')).toBe(true);
    e.unlockRow('t', 1);
    expect((e as any).rowMutexes.has('lock:t:1')).toBe(false);
  });

  it('unlockRow is a no-op when entry missing', () => {
    const e = makeExec();
    expect(() => e.unlockRow('t', 999)).not.toThrow();
  });

  it('unlockRowForSession clears wait and deletes entry', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    await e.lockRowForSession('t', 1, 'a');
    expect((e as any).rowMutexes.has('lock:t:1')).toBe(true);
    e.unlockRowForSession('t', 1, 'a');
    expect((e as any).rowMutexes.has('lock:t:1')).toBe(false);
  });

  it('unlockRowForSession is a no-op without entry', () => {
    const e = makeExec();
    expect(() => e.unlockRowForSession('t', 999, 'ghost')).not.toThrow();
  });

  it('lockRows/unlockRows handles multiple rows sorted', async () => {
    const e = makeExec();
    await e.lockRows('t', [3, 1, 2]);
    expect((e as any).rowMutexes.size).toBe(3);
    e.unlockRows('t', [3, 1, 2]);
    expect((e as any).rowMutexes.size).toBe(0);
  });
});

describe('MVCCExecutor deadlock timer lifecycle', () => {
  it('startDeadlockDetection is a no-op when timer already started', () => {
    const e = makeExec();
    const fakeTimer = { unref: () => {} };
    (e as any).deadlockTimer = fakeTimer;
    (e as any).startDeadlockDetection(); // should return early (timer exists)
    expect((e as any).deadlockTimer).toBe(fakeTimer); // unchanged
  });

  it('stopDeadlockDetection clears the timer', () => {
    const e = makeExec();
    (e as any).deadlockTimer = { unref: () => {} };
    (e as any).stopDeadlockDetection();
    expect((e as any).deadlockTimer).toBeNull();
  });
});
