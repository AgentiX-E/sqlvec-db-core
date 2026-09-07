import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

// A minimal better-sqlite3-style mock with in-memory XID state.
function makeMockDb() {
  const prepared: string[] = [];
  const executed: string[] = [];
  let lastXid = 2;
  return {
    prepared,
    executed,
    pragma(_name: string, _opts?: any): string | number { return 'NORMAL'; },
    exec(sql: string) { executed.push(sql); },
    prepare(sql: string) {
      prepared.push(sql);
      const self = this as any;
      return {
        run(..._args: any[]) { self.executed.push(sql + ' [run]'); },
        all() {
          if (sql.includes('__row_versions')) {
            return [{ key: 't:1', xmin: 1, xmax: null }] as any[];
          }
          return [];
        },
        get() {
          if (sql.includes('RETURNING last_xid')) {
            lastXid += 1;
            return { last_xid: lastXid } as any;
          }
          if (sql.includes('SELECT last_xid')) {
            return { last_xid: lastXid } as any;
          }
          return undefined;
        },
      };
    },
  };
}

describe('MVCCExecutor XID table initialization', () => {
  it('initializeXidTable creates table and sets initialized flag', () => {
    const db = makeMockDb();
    const e = makeExec({ db } as any);
    (e as any).initializeXidTable();
    expect((e as any).xidTableInitialized).toBe(true);
    expect(db.executed.some((s) => s.includes('__mvcc_xid_seq'))).toBe(true);
  });

  it('initializeXidTable is a no-op without db', () => {
    const e = makeExec();
    (e as any).initializeXidTable();
    expect((e as any).xidTableInitialized).toBe(false);
  });

  it('initializeRowVersionsTable reloads existing versions', () => {
    const db = makeMockDb();
    const e = makeExec({ db } as any);
    (e as any).initializeRowVersionsTable();
    expect((e as any).rowVersions.has('t:1')).toBe(true);
  });

  it('reloadRowVersions clears and repopulates cache', () => {
    const db = makeMockDb();
    const e = makeExec({ db } as any);
    (e as any).reloadRowVersions();
    expect((e as any).rowVersions.get('t:1')).toEqual({ xmin: 1, xmax: null });
  });
});

describe('MVCCExecutor XID allocation via SQLite (allocateXid)', () => {
  it('allocates XIDs via SQLite RETURNING path', () => {
    const db = makeMockDb();
    const e = makeExec({ db } as any);
    (e as any).xidTableInitialized = true;
    const xid1 = (e as any).allocateXid();
    const xid2 = (e as any).allocateXid();
    expect(xid2).toBeGreaterThan(xid1);
  });

  it('falls back to in-memory when db.prepare throws', () => {
    const db = makeMockDb();
    db.prepare = () => { throw new Error('db down'); };
    const e = makeExec({ db } as any);
    (e as any).xidTableInitialized = true;
    const xid = (e as any).allocateXid();
    expect(typeof xid).toBe('number');
  });

  it('restoreXidFromDb is a no-op without initialized table', () => {
    const e = makeExec();
    (e as any).restoreXidFromDb();
    expect((e as any).xidCounter).toBeGreaterThan(0);
  });
});

describe('MVCCExecutor XID wrap handling with persistXid', () => {
  it('handleXidWrap resets to XID_FROZEN+1 and persists', () => {
    const persisted: number[] = [];
    const e = makeExec({ persistXid: (xid: number) => { persisted.push(xid); } });
    (e as any).xidCounter = 2147483648; // at wrap limit
    const wrapped = (e as any).handleXidWrap();
    expect(wrapped).toBe(3); // XID_FROZEN + 1
    expect(persisted.length).toBe(1);
  });

  it('persistXidIfEnabled is a no-op without config.persistXid', () => {
    const e = makeExec();
    (e as any).persistXidIfEnabled(); // no throw
  });
});

describe('MVCCExecutor row version deletion & clearing', () => {
  it('deleteRowVersion persists a DELETE via writeSql', async () => {
    const writes: string[] = [];
    const e = makeExec({ writeSql: (sql: string) => { writes.push(sql); return Promise.resolve(); } });
    (e as any).deleteRowVersion("t:1' OR '1'='1");
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("t:1'' OR ''1''=''1"); // SQL-escaped
  });

  it('deleteRowVersion via db.prepare does not throw', () => {
    const db = makeMockDb();
    const e = makeExec({ db } as any);
    (e as any).deleteRowVersion('t:1');
    expect(db.prepared.some((s) => s.includes('DELETE FROM __row_versions'))).toBe(true);
  });

  it('clearRowVersions executes DELETE without where', () => {
    const db = makeMockDb();
    const e = makeExec({ db } as any);
    (e as any).clearRowVersions();
    expect(db.executed.some((s) => s.includes('DELETE FROM __row_versions'))).toBe(true);
  });

  it('persistRowVersion escapes single quotes in the key', () => {
    const writes: string[] = [];
    const e = makeExec({ writeSql: (sql: string) => { writes.push(sql); return Promise.resolve(); } });
    (e as any).persistRowVersion("t:1' OR '1'='1", 5, null);
    expect(writes[0]).toContain("t:1'' OR ''1''=''1");
  });
});
