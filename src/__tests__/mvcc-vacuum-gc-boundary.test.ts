import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor vacuum deep db mock (colInfo/_xmax/changes)', () => {
  it('freezes rows when table has _xmax column and update returns changes', () => {
    const e = makeExec();
    // Mock prepare returning chainable all()/run() based on SQL.
    const runCalls: any[] = [];
    const connection = {
      exec: () => {},
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes('sqlite_master')) return [{ name: 'users' }, { name: 'orders' }];
          if (sql.includes('PRAGMA table_info')) return [{ name: 'id' }, { name: '_xmax' }];
          return [];
        },
        run: (...args: any[]) => {
          runCalls.push(args);
          return { changes: 3 };
        },
      }),
    };
    // Pre-populate an in-memory row version that is dead and freezable.
    (e as any).rowVersions.set('users:1', { xmin: 10, xmax: 5 });

    const frozen = e.vacuum(connection as any);
    // In-memory version frozen (xmax 5 <= oldest, > 0) → contributes.
    expect(frozen).toBeGreaterThanOrEqual(3);
    expect(runCalls.length).toBeGreaterThan(0);
  });

  it('skips tables without _xmax column', () => {
    const e = makeExec();
    const connection = {
      exec: () => {},
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes('sqlite_master')) return [{ name: 'logs' }];
          if (sql.includes('PRAGMA table_info')) return [{ name: 'id' }]; // no _xmax
          return [];
        },
        run: () => ({ changes: 0 }),
      }),
    };
    const frozen = e.vacuum(connection as any);
    expect(frozen).toBe(0);
  });

  it('tolerates prepare returning undefined tables', () => {
    const e = makeExec();
    const connection = {
      exec: () => {},
      prepare: () => ({ all: () => undefined, run: () => ({ changes: 0 }) }),
    };
    expect(() => e.vacuum(connection as any)).not.toThrow();
  });
});

describe('MVCCExecutor gcRowVersions boundaries', () => {
  it('returns 0 when not forced and below threshold', () => {
    const e = makeExec({ maxRowVersions: 1000, rowVersionGcThreshold: 0.8 });
    (e as any).rowVersions.set('t:1', { xmin: 10, xmax: 5 });
    expect(e.gcRowVersions(false)).toBe(0);
  });

  it('frees dead rows when forced (xmax < oldestSnapshot)', () => {
    const e = makeExec();
    // Create an active txn with a high snapshot so old xmax is truly dead.
    e.begin('a', 'REPEATABLE_READ', false);
    const a = e.getTransaction('a')!;
    a.snapshot = a.xid;
    // rowversion dead: xmax=1 is a long-committed XID (older than every active snapshot).
    (e as any).rowVersions.set('t:1', { xmin: 1, xmax: 1 });
    const freed = e.gcRowVersions(true);
    expect(freed).toBe(1);
    expect((e as any).rowVersions.has('t:1')).toBe(false);
  });

  it('preserves FROZEN_XID rows', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    const a = e.getTransaction('a')!;
    a.snapshot = a.xid;
    (e as any).rowVersions.set('t:1', { xmin: 1, xmax: MVCCExecutor.XID_FROZEN });
    expect(e.gcRowVersions(true)).toBe(0);
    expect((e as any).rowVersions.has('t:1')).toBe(true);
  });
});

describe('MVCCExecutor XID wrap helpers', () => {
  it('handleXidWrap returns XID_FROZEN + 1', () => {
    const e = makeExec();
    expect((e as any).handleXidWrap()).toBe(MVCCExecutor.XID_FROZEN + 1);
  });
});
