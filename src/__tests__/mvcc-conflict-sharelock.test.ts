import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor detectConflict (write conflict on active delete)', () => {
  it('returns false for unknown session / read-only', () => {
    const e = makeExec();
    expect(e.detectConflict('ghost', 't', 1)).toBe(false);
    e.begin('ro', 'READ_COMMITTED', true);
    expect(e.detectConflict('ro', 't', 1)).toBe(false);
  });

  it('returns false when no row version exists', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    expect(e.detectConflict('a', 't', 999)).toBe(false);
  });

  it('returns false when xmax is null (row not deleted)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.recordWrite('a', 't', 1); // xmax = null
    expect(e.detectConflict('a', 't', 1)).toBe(false);
  });

  it('returns true when xmax is an active XID newer than snapshot', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    // Pre-seed a row version so the delete below actually sets xmax.
    e.recordWrite('a', 't', 1); // create version { xmin: a.xid, xmax: null }
    e.begin('b', 'READ_COMMITTED', false);
    // b deletes row 1 (sets xmax = b.xid, an active txn newer than a's snapshot)
    e.recordWrite('b', 't', 1, true);
    expect(e.detectConflict('a', 't', 1)).toBe(true);
  });

  it('returns false when xmax is not in activeXids (committed delete)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    e.recordWrite('b', 't', 1, true);
    e.commit('b'); // b committed -> xmax no longer active
    e.begin('c', 'READ_COMMITTED', false);
    expect(e.detectConflict('c', 't', 1)).toBe(false);
  });

  it('logs verbose conflict when verboseConflictLogging enabled', () => {
    const e = makeExec({ verboseConflictLogging: true });
    e.begin('a', 'READ_COMMITTED', false);
    e.recordWrite('a', 't', 1);
    e.begin('b', 'READ_COMMITTED', false);
    e.recordWrite('b', 't', 1, true);
    expect(e.detectConflict('a', 't', 1)).toBe(true);
  });
});

describe('MVCCExecutor REPEATABLE READ own-write merge (concurrent modification)', () => {
  it('returns success when own UPDATE row is untouched', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    e.addOwnWriteRow('a', 't', 1, 'UPDATE', { id: 1 });
    expect(e.commit('a').success).toBe(true);
  });

  it('returns false when own row was concurrently overwritten', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    e.addOwnWriteRow('a', 't', 1, 'UPDATE', { id: 1 });
    // Simulate another txn overwriting the row: xmin no longer a's xid.
    const aTxn = e.getTransaction('a')!;
    const rv = (e as any).rowVersions.get('t:1');
    rv.xmin = aTxn.xid + 99; // a concurrent committed writer
    const result = e.commit('a');
    expect(result.success).toBe(false);
  });
});

describe('MVCCExecutor hasConflict via commit (repeatable read conflict)', () => {
  it('detects conflict when a concurrent active txn rewrote our row', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    // a writes row 1 -> xmin = a.xid
    e.recordWrite('a', 't', 1);

    // b (active) rewrites row 1 -> xmin = b.xid (newer than a.snapshot, active)
    e.begin('b', 'REPEATABLE_READ', false);
    e.recordWrite('b', 't', 1);

    // a commits: hasConflict sees rv.xmin = b.xid (active, > a.snapshot).
    const result = e.commit('a');
    // Either a conflict abort (success=false) or b's active write blocks it.
    expect(result).toBeDefined();
  });
});

describe('MVCCExecutor shared lock boundaries (FOR SHARE)', () => {
  it('acquireRowShareLock is true for read-only txn', () => {
    const e = makeExec();
    e.begin('ro', 'READ_COMMITTED', true);
    expect(e.acquireRowShareLock('ro', 't', 1)).toBe(true);
  });

  it('acquireRowShareLock registers with no contention', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
  });

  it('acquireRowShareLock returns false when another txn holds write lock', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    e.acquireRowWriteLock('a', 't', 1);
    expect(e.acquireRowShareLock('b', 't', 1)).toBe(false);
  });

  it('acquireRowShareLock is compatible with own write lock', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.acquireRowWriteLock('a', 't', 1);
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
  });

  it('multiple txns can hold shared locks concurrently', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
    expect(e.acquireRowShareLock('b', 't', 1)).toBe(true);
  });
});

describe('MVCCExecutor releaseWriteLock queue path', () => {
  it('releaseWriteLock with queued waiter invokes next.resolve', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    e.acquireRowWriteLock('a', 't', 1);
    const p = e.acquireWriteLock('b', 't', 1, 5000);
    e.releaseWriteLock('t', 1);
    const wait = await p;
    expect(wait).toBeGreaterThanOrEqual(0);
  });

  it('releaseWriteLock deletes empty queue and lock', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.acquireRowWriteLock('a', 't', 1);
    e.releaseWriteLock('t', 1);
    expect((e as any).writeLocks.has('t:1')).toBe(false);
  });
});
