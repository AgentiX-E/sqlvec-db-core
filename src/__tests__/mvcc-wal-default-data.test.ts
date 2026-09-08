import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor addOwnWriteRow WAL default-data branches', () => {
  it('logs INSERT with data ?? { rowId } default when data undefined', () => {
    const inserted: any[] = [];
    const e = makeExec({ walLogger: { logInsert: (r: any) => inserted.push(r) } as any });
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    e.addOwnWriteRow('a', 't', 5, 'INSERT', undefined); // no data
    expect(inserted.length).toBe(1);
    expect(inserted[0].data).toEqual({ rowId: 5 });
    expect(inserted[0].xmin).toBe(a.xid);
  });

  it('logs DELETE with oldData ?? { rowId } default', () => {
    const deleted: any[] = [];
    const e = makeExec({ walLogger: { logDelete: (r: any) => deleted.push(r) } as any });
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    e.addOwnWriteRow('a', 't', 7, 'DELETE', undefined);
    expect(deleted.length).toBe(1);
    expect(deleted[0].oldData).toEqual({ rowId: 7 });
    expect(deleted[0].xmax).toBe(a.xid);
  });

  it('logs UPDATE with newData fallback from data.newData ?? { rowId }', () => {
    const updated: any[] = [];
    const e = makeExec({ walLogger: { logUpdate: (r: any) => updated.push(r) } as any });
    e.begin('a', 'READ_COMMITTED', false);
    // data.oldData present but data.newData undefined → newData defaults.
    e.addOwnWriteRow('a', 't', 9, 'UPDATE', { oldData: { x: 1 } });
    expect(updated.length).toBe(1);
    expect(updated[0].oldData).toEqual({ x: 1 });
    expect(updated[0].newData).toEqual({ rowId: 9 });
  });

  it('logs UPDATE with both oldData and newData present', () => {
    const updated: any[] = [];
    const e = makeExec({ walLogger: { logUpdate: (r: any) => updated.push(r) } as any });
    e.begin('a', 'READ_COMMITTED', false);
    e.addOwnWriteRow('a', 't', 9, 'UPDATE', { oldData: { x: 1 }, newData: { x: 2 } });
    expect(updated[0].oldData).toEqual({ x: 1 });
    expect(updated[0].newData).toEqual({ x: 2 });
  });

  it('addOwnWriteRow skips read-only txn', () => {
    const inserted: any[] = [];
    const e = makeExec({ walLogger: { logInsert: (r: any) => inserted.push(r) } as any });
    e.begin('a', 'READ_COMMITTED', true); // read-only
    e.addOwnWriteRow('a', 't', 1, 'INSERT', { id: 1 });
    expect(inserted.length).toBe(0);
  });
});

describe('MVCCExecutor clearOwnWrites / getSelectVisibility', () => {
  it('clearOwnWrites is a no-op for unknown session', () => {
    const e = makeExec();
    expect(() => e.clearOwnWrites('ghost')).not.toThrow();
  });

  it('clearOwnWrites clears own row data', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnOwnRowData.set(a.xid, new Map([['k', {}]]));
    e.clearOwnWrites('a');
    expect((e as any).txnOwnRowData.has(a.xid)).toBe(false);
  });

  it('getSelectVisibility returns null for unknown session', () => {
    const e = makeExec();
    expect(e.getSelectVisibility('ghost')).toBeNull();
  });

  it('getSelectVisibility falls back to READ_COMMITTED without txnIsolation', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    // Delete txnIsolation to force the `|| 'READ_COMMITTED'` fallback.
    (e as any).txnIsolation.delete(a.xid);
    const vis = e.getSelectVisibility('a');
    expect(vis!.isolation).toBe('READ_COMMITTED');
  });
});
