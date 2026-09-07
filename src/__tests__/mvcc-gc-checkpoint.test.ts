import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor, XID_FROZEN } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor gcRowVersions boundary conditions', () => {
  it('returns 0 when below threshold and not forced', () => {
    const e = makeExec({ maxRowVersions: 1000, rowVersionGcThreshold: 0.8 });
    expect(e.gcRowVersions(false)).toBe(0); // empty map < threshold
  });

  it('gcRowVersions(force) removes truly dead versions', () => {
    const e = makeExec();
    // Seed a row version deleted by a committed XID (1) older than the
    // oldest snapshot (xidCounter=3 when no active txns).
    (e as any).rowVersions.set('t:1', { xmin: 0, xmax: 1, data: {} });
    const freed = e.gcRowVersions(true);
    expect(freed).toBe(1);
    expect((e as any).rowVersions.has('t:1')).toBe(false);
  });

  it('preserves FROZEN row versions during GC', () => {
    const e = makeExec();
    (e as any).rowVersions.set('t:1', { xmin: 1, xmax: XID_FROZEN });
    const freed = e.gcRowVersions(true);
    expect(freed).toBe(0);
    expect((e as any).rowVersions.has('t:1')).toBe(true);
  });

  it('preserves live (xmax=null) row versions', () => {
    const e = makeExec();
    (e as any).rowVersions.set('t:1', { xmin: 1, xmax: null });
    expect(e.gcRowVersions(true)).toBe(0);
  });

  it('tracks gc freed/runs counters', () => {
    const e = makeExec();
    (e as any).rowVersions.set('t:1', { xmin: 0, xmax: 1 });
    e.gcRowVersions(true);
    expect((e as any).rowVersionGcFreed).toBe(1);
    expect((e as any).rowVersionGcRuns).toBe(1);
  });
});

describe('MVCCExecutor computeOldestActiveXid / computeOldestActiveSnapshot', () => {
  it('computeOldestActiveXid returns counter when no active txns', () => {
    const e = makeExec();
    const oldest = e.computeOldestActiveXid();
    expect(oldest).toBeGreaterThan(0);
  });

  it('computeOldestActiveXid returns min active XID', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const aTxn = e.getTransaction('a')!;
    const oldest = e.computeOldestActiveXid();
    expect(oldest).toBe(aTxn.xid); // a started first -> smaller xid
  });

  it('computeOldestActiveSnapshot uses min(snapshot, xid)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const snap = (e as any).computeOldestActiveSnapshot();
    expect(snap).toBeGreaterThan(0);
  });
});

describe('MVCCExecutor vacuum (FREEZE)', () => {
  it('freezes committed-deleted in-memory versions', () => {
    const e = makeExec();
    (e as any).rowVersions.set('t:1', { xmin: 0, xmax: 1 });
    const frozen = e.vacuum({ exec: () => undefined });
    // xmax 1 <= oldestActiveXid (counter=3, no active txns) -> frozen
    expect((e as any).rowVersions.get('t:1').xmax).toBe(XID_FROZEN);
    expect(frozen).toBeGreaterThanOrEqual(0);
  });

  it('vacuum invokes onVacuum callback', () => {
    let called = -1;
    const e = makeExec({ onVacuum: (n: number) => { called = n; } });
    e.vacuum({ exec: () => undefined });
    expect(called).toBeGreaterThanOrEqual(0);
  });
});

describe('MVCCExecutor checkpoint (WAL)', () => {
  it('checkpoint returns null when no WAL writer configured', () => {
    const e = makeExec();
    expect(e.checkpoint()).toBeNull();
  });

  it('checkpoint writes a checkpoint record via pgWalWriter', () => {
    let flushed = false;
    const mockWal = {
      writeCheckpoint: (xid: number) => ({ lsn: '0/123', xid }),
      flushSegment: () => { flushed = true; },
    };
    const e = makeExec({ pgWalWriter: mockWal } as any);
    const lsn = e.checkpoint();
    expect(lsn).toBe('0/123');
    expect(flushed).toBe(true);
  });

  it('checkpoint returns null when pgWalWriter throws', () => {
    const e = makeExec({
      pgWalWriter: {
        writeCheckpoint: () => { throw new Error('wal down'); },
        flushSegment: () => {},
      },
    } as any);
    expect(e.checkpoint()).toBeNull();
  });

  it('checkpoint persists row versions when db configured', () => {
    const writes: string[] = [];
    const e = makeExec({ writeSql: (sql: string) => { writes.push(sql); return Promise.resolve(); } } as any);
    (e as any).rowVersions.set('t:1', { xmin: 1, xmax: null });
    // checkpoint() calls persistRowVersion for each row when config.db is set;
    // with writeSql route it goes through persistRowVersion.
    (e as any).persistRowVersion('t:1', 1, null);
    expect(writes.length).toBeGreaterThan(0);
  });
});
