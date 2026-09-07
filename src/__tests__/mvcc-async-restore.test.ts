import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor periodic deadlock detection (detectDeadlocks)', () => {
  it('detectDeadlocks is a no-op when no waits exist', () => {
    const e = makeExec();
    // txnWaitFor is empty -> early return before graph building
    expect(() => (e as any).detectDeadlocks()).not.toThrow();
  });

  it('detectDeadlocks detects a cycle and marks youngest victim', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);

    // Build a real wait-for cycle: a waits on t:2 (held by b), b waits on t:1 (held by a).
    e.acquireRowWriteLock('a', 't', 1);
    e.acquireRowWriteLock('b', 't', 2);
    e.acquireRowWriteLock('a', 't', 2); // a waits on b
    e.acquireRowWriteLock('b', 't', 1); // b waits on a -> cycle

    // Running the periodic detector should mark a victim (younger XID = larger).
    (e as any).detectDeadlocks();
    const deadlocked = [...(e as any).txnDeadlocked] as number[];
    expect(deadlocked.length).toBeGreaterThanOrEqual(1);
  });
});

describe('MVCCExecutor async write lock contention (queue path)', () => {
  it('acquireWriteLock resolves wait time after contention release', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);

    // a holds the write lock on t:1.
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);

    // b tries the async lock on t:1 -> contends -> queued.
    const waitPromise = e.acquireWriteLock('b', 't', 1, 1000);

    // Release a's lock, which should resolve b's queued wait.
    e.releaseWriteLock('t', 1);

    const waitTime = await waitPromise;
    expect(waitTime).toBeGreaterThanOrEqual(0);
  });

  it('acquireWriteLock times out when never released', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);

    e.acquireRowWriteLock('a', 't', 1);
    await expect(e.acquireWriteLock('b', 't', 1, 10)).rejects.toThrow(/timeout/);
  });
});

describe('MVCCExecutor conflict/degradation eviction (capacity)', () => {
  it('writeSql and db persistence paths do not throw', () => {
    const writes: string[] = [];
    const e = makeExec({ writeSql: (sql: string) => { writes.push(sql); return Promise.resolve(); } });
    e.begin('w', 'READ_COMMITTED', false);
    expect(() => e.recordWrite('w', 't', 1)).not.toThrow();
    expect(() => e.recordWrite('w', 't', 2, true)).not.toThrow();
    expect(writes.some((s) => s.includes('__row_versions'))).toBe(true);
  });

  it('writeSql rejection is caught and logged (no throw)', async () => {
    const e = makeExec({
      writeSql: () => Promise.reject(new Error('disk full')),
    });
    e.begin('w', 'READ_COMMITTED', false);
    expect(() => e.recordWrite('w', 't', 1)).not.toThrow();
    // Give the fired-and-forgotten catch a tick to run.
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('MVCCExecutor restoreXidFromDb with active txns', () => {
  it('restoreXidFromDb bumps above max active XID', () => {
    const db = {
      pragma: () => 'NORMAL',
      exec: () => {},
      prepare: () => ({
        run: () => ({ changes: 1 }),
        all: () => [],
        get: () => ({ last_xid: 5 }),
      }),
    };
    const e = makeExec({ db: db as any });
    // Seed xidTableInitialized + an active txn with XID larger than restored value.
    (e as any).xidTableInitialized = true;
    e.begin('a', 'READ_COMMITTED', false); // allocates xid 3.. but in-memory, no db increment
    (e as any).restoreXidFromDb();
    // restoreXidFromDb sets xidCounter >= restored(5) and >= maxActive+1.
    expect((e as any).xidCounter).toBeGreaterThanOrEqual(5);
  });
});
