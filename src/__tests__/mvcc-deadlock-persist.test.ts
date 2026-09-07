import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

// A minimal in-memory SQLite-like mock for XID/row-version persistence tests.
function makeDbMock() {
  const tables = new Map<string, any[]>([
    ['__row_versions', []],
    ['__mvcc_xid_seq', [{ last_xid: 2 }]],
  ]);
  return {
    pragma: (_sql: string, _opts?: any) => 'NORMAL',
    exec: (sql: string) => {
      if (sql.startsWith('DELETE FROM __row_versions')) tables.set('__row_versions', []);
    },
    prepare: (sql: string) => {
      const run = () => ({ changes: 1 });
      const all = () => {
        if (sql.includes('__row_versions')) return tables.get('__row_versions')!;
        return [];
      };
      const get = () => {
        if (sql.includes('last_xid FROM __mvcc_xid_seq')) return { last_xid: 3 };
        if (sql.startsWith('INSERT OR REPLACE INTO __row_versions')) {
          // not a get
        }
        return undefined;
      };
      return { run, all, get };
    },
  };
}

describe('MVCCExecutor deadlock detection (wait-for graph)', () => {
  it('isDeadlocked returns false for unknown session', () => {
    const e = makeExec();
    expect(e.isDeadlocked('ghost')).toBe(false);
  });

  it('detects a deadlock via acquireRowWriteLock and marks victim', () => {
    const e = makeExec();
    const a = e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);

    // a locks row 1, b locks row 2
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);
    expect(e.acquireRowWriteLock('b', 't', 2)).toBe(true);

    // a tries row 2 (held by b) → contended, registers wait
    expect(e.acquireRowWriteLock('a', 't', 2)).toBe(false);
    // b tries row 1 (held by a) → contended; now a→b→a cycle forms
    const result = e.acquireRowWriteLock('b', 't', 1);

    if (result === 'deadlocked') {
      // b (the younger XID) should be marked as a victim
      expect(e.isDeadlocked('b')).toBe(true);
    } else {
      // Depending on victim selection, some session is deadlocked
      const deadlockedSome = e.isDeadlocked('a') || e.isDeadlocked('b');
      expect(deadlockedSome).toBe(true);
    }
  });
});

describe('MVCCExecutor own-write buffering & visibility merge', () => {
  it('addOwnWriteRow buffers an INSERT and getOwnWrites returns it', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    e.addOwnWriteRow('s', 'users', 1, 'INSERT', { id: 1, name: 'a' });
    const writes = e.getOwnWrites('s');
    expect(writes.length).toBe(1);
    expect(writes[0].type).toBe('INSERT');
    expect(writes[0].table).toBe('users');
  });

  it('addOwnWriteRow is a no-op for read-only txn', () => {
    const e = makeExec();
    e.begin('ro', 'SERIALIZABLE', true);
    e.addOwnWriteRow('ro', 't', 1, 'INSERT', { id: 1 });
    expect(e.getOwnWrites('ro')).toEqual([]);
  });

  it('clearOwnWrites empties the buffer', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    e.addOwnWriteRow('s', 'users', 1, 'UPDATE', { id: 1 });
    e.clearOwnWrites('s');
    expect(e.getOwnWrites('s')).toEqual([]);
  });

  it('getOwnWrites returns [] for unknown session', () => {
    const e = makeExec();
    expect(e.getOwnWrites('ghost')).toEqual([]);
  });

  it('getSelectVisibility returns null for unknown session', () => {
    const e = makeExec();
    expect(e.getSelectVisibility('ghost')).toBeNull();
  });

  it('getSelectVisibility exposes snapshot + ownWrites for active txn', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    e.addOwnWriteRow('s', 'users', 1, 'INSERT', { id: 1 });
    const sv = e.getSelectVisibility('s');
    expect(sv).not.toBeNull();
    expect(sv!.ownWrites.length).toBe(1);
    expect(sv!.isolation).toBe('SERIALIZABLE');
  });

  it('filterSelectResult returns rows unchanged for unknown session', () => {
    const e = makeExec();
    const rows = [{ id: 1 }, { id: 2 }];
    expect(e.filterSelectResult('ghost', rows, 't')).toEqual(rows);
  });

  it('filterSelectResult hides a row created by an active transaction', () => {
    const e = makeExec();
    // Writer creates a row version (xmin = writer's active XID).
    e.begin('writer', 'READ_COMMITTED', false);
    e.recordWrite('writer', 't', 2);

    // A separate reader with its own snapshot must NOT see the uncommitted row.
    e.begin('reader', 'READ_COMMITTED', false);
    const rows = [{ id: 2 }];
    const filtered = e.filterSelectResult('reader', rows, 't');
    // xmin is an active (uncommitted) XID → not visible to reader
    expect(filtered.length).toBe(0);
  });

  it('filterSelectResult keeps a row with no version info (pre-existing)', () => {
    const e = makeExec();
    e.begin('reader', 'READ_COMMITTED', false);
    const rows = [{ id: 99 }, null, 'scalar'];
    const filtered = e.filterSelectResult('reader', rows as any[], 't');
    expect(filtered.length).toBe(3); // non-object + no-version rows pass through
  });
});

describe('MVCCExecutor XID persistence (mock db)', () => {
  it('restores XID from db and starts new XIDs above restored value', () => {
    const db = makeDbMock();
    const e = makeExec({ db: db as any });
    const a = e.begin('a', 'READ_COMMITTED', false);
    expect(a.xid).toBeGreaterThanOrEqual(3);
  });

  it('recordWrite persists row version without throwing when db present', () => {
    const db = makeDbMock();
    const e = makeExec({ db: db as any });
    e.begin('w', 'READ_COMMITTED', false);
    expect(() => e.recordWrite('w', 't', 1)).not.toThrow();
    expect(() => e.recordWrite('w', 't', 2, true)).not.toThrow();
  });
});

describe('MVCCExecutor WAL logging via addOwnWriteRow', () => {
  it('logs INSERT/DELETE/UPDATE records via walLogger', () => {
    const logged: string[] = [];
    const walLogger = {
      logInsert: (r: any) => logged.push('insert:' + r.table),
      logDelete: (r: any) => logged.push('delete:' + r.table),
      logUpdate: (r: any) => logged.push('update:' + r.table),
      getWriter: () => ({ flushSegment: () => {} }),
      logCommit: () => {},
    };
    const e = makeExec({ walLogger: walLogger as any });
    e.begin('s', 'SERIALIZABLE', false);
    e.addOwnWriteRow('s', 't', 1, 'INSERT', { id: 1 });
    e.addOwnWriteRow('s', 't', 2, 'UPDATE', { newData: { id: 2 } });
    e.addOwnWriteRow('s', 't', 3, 'DELETE', { id: 3 });
    expect(logged).toContain('insert:t');
    expect(logged).toContain('update:t');
    expect(logged).toContain('delete:t');
  });
});
