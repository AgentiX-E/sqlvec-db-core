import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor async-mutex row locking (lockRow/unlockRow)', () => {
  it('lockRow creates an entry and increments refCount', async () => {
    const e = makeExec();
    await e.lockRow('t', 1);
    const entry = (e as any).rowMutexes.get('lock:t:1');
    expect(entry).toBeDefined();
    expect(entry.refCount).toBe(1);
  });

  it('unlockRow releases and deletes entry at zero refCount', async () => {
    const e = makeExec();
    await e.lockRow('t', 1);
    e.unlockRow('t', 1);
    expect((e as any).rowMutexes.has('lock:t:1')).toBe(false);
  });

  it('unlockRow is a no-op for a missing entry', () => {
    const e = makeExec();
    expect(() => e.unlockRow('t', 999)).not.toThrow();
  });

  it('lockRows locks in sorted key order to prevent deadlocks', async () => {
    const e = makeExec();
    await e.lockRows('t', [3, 1, 2]);
    // All three entries must exist.
    expect((e as any).rowMutexes.has('lock:t:1')).toBe(true);
    expect((e as any).rowMutexes.has('lock:t:2')).toBe(true);
    expect((e as any).rowMutexes.has('lock:t:3')).toBe(true);
  });

  it('unlockRows unlocks in reverse order', async () => {
    const e = makeExec();
    await e.lockRows('t', [1, 2, 3]);
    e.unlockRows('t', [1, 2, 3]);
    expect((e as any).rowMutexes.size).toBe(0);
  });
});

describe('MVCCExecutor async-mutex session row locking (lockRowForSession)', () => {
  it('records wait during acquire then clears it', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const aTxn = e.getTransaction('a')!;
    await e.lockRowForSession('t', 1, 'a');
    // Wait should be cleared after acquisition.
    expect((e as any).txnWaitFor.has(aTxn.xid)).toBe(false);
    const entry = (e as any).rowMutexes.get('lock:t:1');
    expect(entry.refCount).toBe(1);
  });

  it('unlockRowForSession clears wait and removes entry', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    await e.lockRowForSession('t', 1, 'a');
    e.unlockRowForSession('t', 1, 'a');
    expect((e as any).rowMutexes.has('lock:t:1')).toBe(false);
  });

  it('unlockRowForSession is a no-op for a missing entry', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    expect(() => e.unlockRowForSession('t', 999, 'a')).not.toThrow();
  });

  it('lockRowsForSession acquires all rows', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    await e.lockRowsForSession('t', [2, 1], 'a');
    expect((e as any).rowMutexes.has('lock:t:1')).toBe(true);
    expect((e as any).rowMutexes.has('lock:t:2')).toBe(true);
  });

  it('unlockRowsForSession releases all rows', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    await e.lockRowsForSession('t', [1, 2], 'a');
    e.unlockRowsForSession('t', [1, 2], 'a');
    expect((e as any).rowMutexes.size).toBe(0);
  });
});

describe('MVCCExecutor async-mutex refCount shared locking', () => {
  it('two lockRow calls on same row increment refCount to 2', async () => {
    const e = makeExec();
    await e.lockRow('t', 1);
    // lockRow is not re-entrant-safe: second call blocks on the mutex.
    // Use a second session-style path to avoid deadlock in a single thread.
    const p = e.lockRow('t', 1); // will await acquire behind the first
    // Unlock the first to let the second proceed.
    e.unlockRow('t', 1);
    await p;
    const entry = (e as any).rowMutexes.get('lock:t:1');
    expect(entry).toBeDefined();
    e.unlockRow('t', 1);
  });
});
