import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

// A db mock whose prepare().get() returns an incrementing sequence of last_xid values.
function makeSeqDb(sequence: number[]) {
  let i = 0;
  return {
    prepare: () => ({
      get: () => {
        const v = sequence[Math.min(i, sequence.length - 1)];
        i++;
        return { last_xid: v };
      },
      all: () => [],
      run: () => ({ changes: 0 }),
    }),
    exec: () => {},
    pragma: () => {},
  };
}

function makeDb(lastXid: number) {
  return makeSeqDb([lastXid]);
}

describe('MVCCExecutor allocateXid SQLite FROZEN-skip branch', () => {
  it('skips XID_FROZEN (2) then returns the next non-FROZEN value', () => {
    // First get() returns 2 (FROZEN → skip/retry), second returns 3.
    const e = makeExec({ db: makeSeqDb([2, 3]) as any });
    (e as any).xidTableInitialized = true;
    const xid = (e as any).allocateXid();
    expect(xid).toBe(3);
    expect((e as any).xidCounter).toBe(3);
  });

  it('handles XID wrap when db returns last_xid >= XID_WRAP_LIMIT', () => {
    const e = makeExec({ db: makeDb(MVCCExecutor.XID_WRAP_LIMIT) as any });
    (e as any).xidTableInitialized = true;
    const xid = (e as any).allocateXid();
    expect(xid).toBe(MVCCExecutor.XID_FROZEN + 1);
  });
});

describe('MVCCExecutor restoreXidFromDb branches', () => {
  it('restores XID from db and bumps above max active XID', () => {
    // Start without a db so begin() allocates in-memory, then attach db for restore.
    const e = makeExec({});
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!; // in-memory xid=3
    // Attach a db whose persisted last_xid is large (e.g. 10) for restore.
    (e as any).config.db = makeDb(10);
    (e as any).xidTableInitialized = true;
    (e as any).restoreXidFromDb();
    // restoredXid = max(10, max(3)+1=4) = 10.
    expect((e as any).xidCounter).toBe(10);
  });

  it('restores XID bumped by db to above active XID when db value is small', () => {
    const e = makeExec({});
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!; // in-memory xid=3
    (e as any).config.db = makeDb(2); // small persisted value
    (e as any).xidTableInitialized = true;
    (e as any).restoreXidFromDb();
    // restoredXid = max(2, 3+1=4) = 4.
    expect((e as any).xidCounter).toBe(4);
  });

  it('is a no-op without xidTableInitialized', () => {
    const e = makeExec({ db: makeDb(5) as any });
    (e as any).xidTableInitialized = false;
    const before = (e as any).xidCounter;
    (e as any).restoreXidFromDb();
    expect((e as any).xidCounter).toBe(before);
  });
});
