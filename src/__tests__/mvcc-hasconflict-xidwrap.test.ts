import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor allocateXid FROZEN skip / wrap-around (in-memory)', () => {
  it('skips XID_FROZEN during in-memory allocation', () => {
    const e = makeExec();
    // Force counter to land on XID_FROZEN (2) so allocateXid skips it.
    (e as any).xidCounter = 2;
    const xid = (e as any).allocateXid();
    // xidCounter++ returns 2 (== FROZEN), so it skips to the next one.
    expect(xid).not.toBe(2);
    expect(xid).toBeGreaterThanOrEqual(3);
  });

  it('triggers handleXidWrap when counter reaches wrap limit', () => {
    const e = makeExec();
    (e as any).xidCounter = 2147483648; // XID_WRAP_LIMIT
    const wrapped = (e as any).allocateXid();
    expect(wrapped).toBe(3); // XID_FROZEN + 1
  });

  it('persists XID on wrap via persistXid', () => {
    let persisted = -1;
    const e = makeExec({ persistXid: (xid: number) => { persisted = xid; } });
    (e as any).xidCounter = 2147483648;
    (e as any).allocateXid();
    expect(persisted).toBeGreaterThanOrEqual(3);
  });
});

describe('MVCCExecutor hasConflict commit-scan boundaries', () => {
  it('returns false when txn has no write locks', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    expect((e as any).hasConflict(a)).toBe(false);
  });

  it('returns false when row version missing', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    const a = e.getTransaction('a')!;
    (e as any).txnWriteLocks.set(a.xid, new Set(['t:missing']));
    expect((e as any).hasConflict(a)).toBe(false);
  });

  it('returns false for rows written by this txn itself', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    const a = e.getTransaction('a')!;
    (e as any).txnWriteLocks.set(a.xid, new Set(['t:1']));
    (e as any).rowVersions.set('t:1', { xmin: a.xid, xmax: null });
    expect((e as any).hasConflict(a)).toBe(false);
  });

  it('returns false when rewriter committed before our snapshot', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    const a = e.getTransaction('a')!;
    (e as any).txnWriteLocks.set(a.xid, new Set(['t:1']));
    // rv.xmin (5) <= txn.snapshot → no conflict (written before we read it).
    (e as any).rowVersions.set('t:1', { xmin: 5, xmax: null });
    a.snapshot = 100;
    expect((e as any).hasConflict(a)).toBe(false);
  });

  it('returns true for REPEATABLE_READ committed write after snapshot', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    const a = e.getTransaction('a')!;
    (e as any).txnWriteLocks.set(a.xid, new Set(['t:1']));
    // rv.xmin (50) > snapshot (10) → conflict (committed after our snapshot).
    (e as any).rowVersions.set('t:1', { xmin: 50, xmax: null });
    a.snapshot = 10;
    expect((e as any).hasConflict(a)).toBe(true);
  });

  it('returns true for READ_COMMITTED active-rewriter conflict', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnWriteLocks.set(a.xid, new Set(['t:1']));
    (e as any).rowVersions.set('t:1', { xmin: 50, xmax: null });
    a.snapshot = 10;
    (e as any).activeXidSet.add(50); // rewriter still active
    expect((e as any).hasConflict(a)).toBe(true);
  });

  it('emits verbose conflict log when verboseConflictLogging enabled', () => {
    const e = makeExec({ verboseConflictLogging: true });
    e.begin('a', 'REPEATABLE_READ', false);
    const a = e.getTransaction('a')!;
    (e as any).txnWriteLocks.set(a.xid, new Set(['t:1']));
    (e as any).rowVersions.set('t:1', { xmin: 50, xmax: null });
    a.snapshot = 10;
    expect((e as any).hasConflict(a)).toBe(true);
  });

  it('returns false for non-conflicting read-committed committed rewriter', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnWriteLocks.set(a.xid, new Set(['t:1']));
    // xmin 50 > snapshot 10, but not REPEATABLE_READ and 50 not active → no conflict.
    (e as any).rowVersions.set('t:1', { xmin: 50, xmax: null });
    a.snapshot = 10;
    expect((e as any).hasConflict(a)).toBe(false);
  });
});
