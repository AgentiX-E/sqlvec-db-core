import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor lockTable holder-skip and multiple-holder branches', () => {
  it('skips own xid when re-acquiring table lock (holderXid === xid)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    expect(e.lockTable('a', 't', 'ACCESS EXCLUSIVE')).toBe(true);
    // Re-acquire same lock on same table — existingLocks has own xid → skip.
    expect(e.lockTable('a', 't', 'ACCESS EXCLUSIVE')).toBe(true);
    const lockMap = (e as any).tableLocks.get('T');
    expect(lockMap.get(a.xid)).toBe('ACCESS EXCLUSIVE');
  });

  it('returns false when incompatible holder + nowait', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    const b = e.getTransaction('b')!;
    // a holds ACCESS EXCLUSIVE, b requests incompatible mode with nowait.
    (e as any).tableLocks.set('T', new Map([[a.xid, 'ACCESS EXCLUSIVE']]));
    expect(e.lockTable('b', 't', 'ACCESS EXCLUSIVE', true)).toBe(false);
  });

  it('acquires compatible table lock when holder uses compatible mode', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).tableLocks.set('T', new Map([[a.xid, 'ACCESS SHARE']]));
    // ACCESS SHARE is compatible with ACCESS SHARE.
    expect(e.lockTable('b', 't', 'ACCESS SHARE')).toBe(true);
  });
});

describe('MVCCExecutor releaseTxnTableLocks multiple-holder branches', () => {
  it('keeps tableLocks entry when another holder remains (size > 0)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    const b = e.getTransaction('b')!;
    (e as any).tableLocks.set('T', new Map([[a.xid, 'ACCESS SHARE'], [b.xid, 'ACCESS SHARE']]));
    (e as any).releaseTxnTableLocks(a.xid);
    expect((e as any).tableLocks.has('T')).toBe(true);
    expect((e as any).tableLocks.get('T').has(a.xid)).toBe(false);
    expect((e as any).tableLocks.get('T').has(b.xid)).toBe(true);
  });

  it('is a no-op when lockMap has no entry for xid (has false)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    (e as any).tableLocks.set('T', new Map([[999, 'ACCESS SHARE']]));
    (e as any).releaseTxnTableLocks(1);
    // xid=1 not in lockMap → has(xid) false → no deletion.
    expect((e as any).tableLocks.get('T').has(999)).toBe(true);
  });
});

describe('MVCCExecutor releaseRowShareLock no-entry branches', () => {
  it('returns early with no shareLocks/txnShareLocks entries', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    // No locks held → holders/txnKeys both undefined → no-op.
    expect(() => e.releaseRowShareLock('a', 't', 1)).not.toThrow();
    expect(() => (e as any).releaseTxnShareLocks(e.getTransaction('a')!.xid)).not.toThrow();
  });
});
