import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// duckdb-analytics-manager.test.ts — Coverage for DuckDBAnalyticsManager.
//
// The real `duckdb` native package cannot run in CI (no compiled binary), so we
// mock the module with a minimal in-memory fake that records SQL and lets each
// test drive the success/failure paths. This exercises the real manager logic
// (availability state machine, shard attach/detach, OLAP writes, recovery
// metrics, singleton factory) without touching the native library.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface FakeStmt {
  // The real duckdb stmt.run(...flatValues, cb) invokes cb(err) async; the last
  // arg is always the completion callback.
  run: (this: unknown, ...args: unknown[]) => void;
  finalize(): void;
}

interface FakeConnection {
  all: (sql: string, cb: (err: Error | null, rows?: Row[]) => void) => void;
  exec: (sql: string, cb: (err: Error | null) => void) => void;
  prepare: (sql: string) => FakeStmt;
  close(): void;
}

interface FakeDatabase {
  connect(): FakeConnection;
  close(): void;
}

// The fake module is a self-contained singleton installed via vi.mock. Because
// vi.mock factories are hoisted above imports, the shared state must be created
// with vi.hoisted() so it is initialized before the factory runs (a top-level
// `const` would sit in the temporal dead zone when the factory executes).
const fakeState = vi.hoisted(() => ({
  allCalls: [] as string[],
  execCalls: [] as string[],
  preparedCalls: [] as string[],
  allImpl: null as null | ((sql: string, cb: (err: Error | null, rows?: Row[]) => void) => void),
  execImpl: null as null | ((sql: string, cb: (err: Error | null) => void) => void),
  prepareImpl: null as null | ((sql: string) => FakeStmt),
  DatabaseConstructorError: null as Error | null,
}));

function resetFakeState(): void {
  fakeState.allCalls = [];
  fakeState.execCalls = [];
  fakeState.preparedCalls = [];
  fakeState.allImpl = null;
  fakeState.execImpl = null;
  fakeState.prepareImpl = null;
  fakeState.DatabaseConstructorError = null;
}

vi.mock('duckdb', () => {
  const conn: FakeConnection = {
    all: (sql, cb) => {
      fakeState.allCalls.push(sql);
      if (fakeState.allImpl) fakeState.allImpl(sql, cb);
      else cb(null, []);
    },
    exec: (sql, cb) => {
      fakeState.execCalls.push(sql);
      if (fakeState.execImpl) fakeState.execImpl(sql, cb);
      else cb(null);
    },
    prepare: (sql) => {
      fakeState.preparedCalls.push(sql);
      if (fakeState.prepareImpl) return fakeState.prepareImpl(sql);
      return { run: () => {}, finalize: () => {} };
    },
    close: () => {},
  };
  const db: FakeDatabase = {
    connect: () => conn,
    close: () => {},
  };
  return {
    default: {
      Database: function (this: unknown) {
        if (fakeState.DatabaseConstructorError) throw fakeState.DatabaseConstructorError;
        return db;
      },
    },
    __esModule: true,
  };
});

import { DuckDBAnalyticsManager, getDuckDBAnalyticsManager, resetDuckDBAnalyticsManager } from '../analytics/DuckDBAnalyticsManager';

beforeEach(() => {
  resetFakeState();
  resetDuckDBAnalyticsManager();
});

describe('DuckDBAnalyticsManager — lifecycle & availability', () => {
  it('constructs with a db path', () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    expect(mgr.availability).toBe('unavailable');
    expect(mgr.isAvailable).toBe(false);
    expect(mgr.hasScanner).toBe(false);
    expect(mgr.attachedShardIds).toEqual([]);
  });

  it('degrades to "unavailable" when the native binary cannot open', async () => {
    fakeState.DatabaseConstructorError = new Error('cannot load duckdb');
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    expect(mgr.availability).toBe('unavailable');
    expect(mgr.isAvailable).toBe(false);
  });

  it('initializes to "no-scanner" when the database opens', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    expect(mgr.availability).toBe('no-scanner');
    expect(mgr.isAvailable).toBe(true);   // not 'unavailable'
    expect(mgr.hasScanner).toBe(false);   // not 'available' yet
  });

  it('closes the connection and resets availability', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.close();
    expect(mgr.availability).toBe('unavailable');
  });

  it('close() is safe when never initialized', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await expect(mgr.close()).resolves.toBeUndefined();
  });
});

describe('DuckDBAnalyticsManager — query execution', () => {
  it('execute() returns typed columns and rows via conn.all', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.allImpl = (_sql, cb) => cb(null, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    const res = await mgr.execute('SELECT * FROM t');
    expect(res.rowCount).toBe(2);
    expect(res.rows).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    expect(res.columns.map(c => c.name)).toEqual(['id', 'name']);
    expect(res.columns.map(c => c.type)).toEqual(['number', 'string']);
  });

  it('execute() returns empty columns for an empty result set', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.allImpl = (_sql, cb) => cb(null, []);
    const res = await mgr.execute('SELECT * FROM t');
    expect(res.rowCount).toBe(0);
    expect(res.columns).toEqual([]);
  });

  it('execute() rejects on query error', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.allImpl = (_sql, cb) => cb(new Error('syntax error'));
    await expect(mgr.execute('BROKEN')).rejects.toThrow(/DuckDB query failed/);
  });

  it('queryRaw() returns raw rows', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.allImpl = (_sql, cb) => cb(null, [{ a: 1 }]);
    await expect(mgr.queryRaw('SELECT 1')).resolves.toEqual([{ a: 1 }]);
  });

  it('queryRaw() rejects on error', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.allImpl = (_sql, cb) => cb(new Error('boom'));
    await expect(mgr.queryRaw('SELECT 1')).rejects.toThrow(/DuckDB query failed/);
  });

  it('execRaw() resolves on success and rejects on error', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await expect(mgr.execRaw('CREATE TABLE x(a INT)')).resolves.toBeUndefined();
    fakeState.execImpl = (_sql, cb) => cb(new Error('ddl boom'));
    await expect(mgr.execRaw('CREATE TABLE x(a INT)')).rejects.toThrow(/execRaw failed/);
  });

  it('execSQL() resolves/rejects via conn.exec', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await expect(mgr.execSQL('PRAGMA x')).resolves.toBeUndefined();
    fakeState.execImpl = (_sql, cb) => cb(new Error('exec boom'));
    await expect(mgr.execSQL('PRAGMA x')).rejects.toThrow('exec boom');
  });

  it('throws when queried before init()', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await expect(mgr.queryRaw('SELECT 1')).rejects.toThrow(/not initialized/);
    await expect(mgr.execRaw('X')).rejects.toThrow(/not initialized/);
  });

  it('throws the "binary unavailable" error when availability is unavailable but conn exists', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    // Simulate a degraded state: connection present but marked unavailable.
    (mgr as any)._availability = 'unavailable';
    await expect(mgr.queryRaw('SELECT 1')).rejects.toThrow(/native binary not available/);
  });

  it('executes with SET schema after a primary schema is attached', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    (mgr as any)._availability = 'available';
    await mgr.attachShard(0, '/tmp/shard.db'); // sets primarySchema = shard_0
    fakeState.allImpl = (_sql, cb) => cb(null, [{ x: 1 }]);
    await mgr.execute('SELECT * FROM t');
    expect(fakeState.execCalls).toContain('SET schema = shard_0');
  });
});

describe('DuckDBAnalyticsManager — shard management', () => {
  async function initAvailableMgr(): Promise<DuckDBAnalyticsManager> {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    // Simulate scanner available by flipping via a successful attach path:
    // attachShard early-returns unless availability === 'available', so we
    // drive attach through execSQL success by marking available directly.
    (mgr as any)._availability = 'available';
    return mgr;
  }

  it('attachShard is a no-op when not available', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init(); // availability = no-scanner
    await mgr.attachShard(0, '/tmp/shard.db');
    expect(fakeState.execCalls).toEqual([]);
  });

  it('attachShard attaches and sets primary schema', async () => {
    const mgr = await initAvailableMgr();
    await mgr.attachShard(0, '/tmp/shard.db');
    expect(fakeState.execCalls).toContain("ATTACH '/tmp/shard.db' AS shard_0 (TYPE SQLITE)");
    expect(fakeState.execCalls).toContain('SET schema = shard_0');
    expect(mgr.attachedShardIds).toEqual([0]);
  });

  it('attachShard skips already-attached shards', async () => {
    const mgr = await initAvailableMgr();
    await mgr.attachShard(0, '/tmp/shard.db');
    const before = fakeState.execCalls.length;
    await mgr.attachShard(0, '/tmp/shard.db');
    expect(fakeState.execCalls.length).toBe(before); // no new ATTACH
  });

  it('attachShard warns on attach failure', async () => {
    const mgr = await initAvailableMgr();
    fakeState.execImpl = (sql, cb) => {
      if (sql.startsWith('ATTACH')) cb(new Error('scanner missing'));
      else cb(null);
    };
    await mgr.attachShard(0, '/tmp/shard.db');
    expect(mgr.attachedShardIds).toEqual([]);
  });

  it('attachShard escapes single quotes in path', async () => {
    const mgr = await initAvailableMgr();
    await mgr.attachShard(0, "/tmp/shard'o.db");
    expect(fakeState.execCalls.some(s => s.includes("'/tmp/shard''o.db'"))).toBe(true);
  });

  it('detachShard detaches and removes from map', async () => {
    const mgr = await initAvailableMgr();
    await mgr.attachShard(0, '/tmp/shard.db');
    await mgr.detachShard(0);
    expect(fakeState.execCalls).toContain('DETACH shard_0');
    expect(mgr.attachedShardIds).toEqual([]);
  });

  it('detachShard warns on failure', async () => {
    const mgr = await initAvailableMgr();
    await mgr.attachShard(0, '/tmp/shard.db');
    fakeState.execImpl = (sql, cb) => {
      if (sql.startsWith('DETACH')) cb(new Error('detach boom'));
      else cb(null);
    };
    await mgr.detachShard(0);
    // detach failure still logs; map retains only if delete didn't happen —
    // implementation keeps entry on failure, so id remains.
    expect(mgr.attachedShardIds).toEqual([0]);
  });

  it('detachShard is a no-op for unknown shard', async () => {
    const mgr = await initAvailableMgr();
    await mgr.detachShard(99);
    expect(fakeState.execCalls.some(s => s.startsWith('DETACH'))).toBe(false);
  });

  it('reattachAll reattaches all previously attached shards', async () => {
    const mgr = await initAvailableMgr();
    await mgr.attachShard(0, '/tmp/a.db');
    await mgr.attachShard(1, '/tmp/b.db');
    await mgr.reattachAll();
    const attaches = fakeState.execCalls.filter(s => s.startsWith('ATTACH'));
    expect(attaches.length).toBe(4); // 2 initial + 2 reattach
  });
});

describe('DuckDBAnalyticsManager — metadata', () => {
  it('listTables() returns [] when unavailable', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await expect(mgr.listTables()).resolves.toEqual([]);
  });

  it('listTables() maps schema.table names', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.allImpl = (_sql, cb) => cb(null, [
      { name: 'main.users' }, { name: 'shard_0.orders' },
    ]);
    await expect(mgr.listTables()).resolves.toEqual(['main.users', 'shard_0.orders']);
  });

  it('listTables() swallows query errors', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.allImpl = (_sql, cb) => cb(new Error('no meta'));
    await expect(mgr.listTables()).resolves.toEqual([]);
  });

  it('getVersion() returns "unavailable" when unavailable', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await expect(mgr.getVersion()).resolves.toBe('unavailable');
  });

  it('getVersion() returns the version string', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.allImpl = (_sql, cb) => cb(null, [{ v: '1.4.4' }]);
    await expect(mgr.getVersion()).resolves.toBe('1.4.4');
  });

  it('getVersion() returns "unknown" on empty or error', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.allImpl = (_sql, cb) => cb(null, []);
    await expect(mgr.getVersion()).resolves.toBe('unknown');

    fakeState.allImpl = (_sql, cb) => cb(new Error('no version'));
    await expect(mgr.getVersion()).resolves.toBe('unknown');
  });

  it('setMemoryLimit() issues SET memory_limit', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.setMemoryLimit(4096);
    expect(fakeState.execCalls).toContain("SET memory_limit = '4096mb'");
  });

  it('setMemoryLimit() defaults to 2048mb', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.setMemoryLimit();
    expect(fakeState.execCalls).toContain("SET memory_limit = '2048mb'");
  });
});

describe('DuckDBAnalyticsManager — OLAP columnar writes', () => {
  it('appendToOLAPTable is a no-op for empty rows', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.appendToOLAPTable('t', []);
    expect(fakeState.preparedCalls).toEqual([]);
  });

  it('appendToOLAPTable prepares and runs a batched insert', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    const runArgs: unknown[] = [];
    fakeState.prepareImpl = (sql) => ({
      run: (...args: unknown[]) => {
        const cb = args[args.length - 1] as ((err?: Error | null) => void);
        runArgs.push(...args.slice(0, -1));
        cb(null);
      },
      finalize: () => {},
    });
    await mgr.appendToOLAPTable('t', [{ id: 1, name: 'a' }, { id: 2, name: null }]);
    expect(fakeState.preparedCalls[0]).toContain('INSERT INTO "t" ("id", "name") VALUES (?, ?), (?, ?)');
    expect(runArgs).toEqual([1, 'a', 2, null]); // null ?? null → null
  });

  it('appendToOLAPTable rejects on run error', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.prepareImpl = () => ({
      run: (...args: unknown[]) => {
        const cb = args[args.length - 1] as ((err?: Error | null) => void);
        cb(new Error('run boom'));
      },
      finalize: () => {},
    });
    await expect(mgr.appendToOLAPTable('t', [{ id: 1 }])).rejects.toThrow(/append failed/);
  });

  it('updateOLAPTable is a no-op for empty rowIds, else issues UPDATE', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.updateOLAPTable('t', ['a = 1'], []);
    expect(fakeState.execCalls).toEqual([]);
    await mgr.updateOLAPTable('t', ['a = 1', 'b = 2'], [1, 2, 3]);
    expect(fakeState.execCalls[0]).toBe('UPDATE "t" SET a = 1, b = 2 WHERE rowid IN (1, 2, 3)');
  });

  it('updateOLAPTableByPK builds WHERE from PK columns', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.updateOLAPTableByPK('t', ['v = 9'], ['id'], [[1], [2]]);
    expect(fakeState.execCalls[0]).toBe('UPDATE "t" SET v = 9 WHERE ("id" = 1) OR ("id" = 2)');
  });

  it('updateOLAPTableByPK is a no-op for empty values', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.updateOLAPTableByPK('t', ['v'], ['id'], []);
    expect(fakeState.execCalls).toEqual([]);
  });

  it('deleteFromOLAPTable deletes by rowid', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.deleteFromOLAPTable('t', [5, 6]);
    expect(fakeState.execCalls[0]).toBe('DELETE FROM "t" WHERE rowid IN (5, 6)');
  });

  it('deleteFromOLAPTable is a no-op for empty rowIds', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.deleteFromOLAPTable('t', []);
    expect(fakeState.execCalls).toEqual([]);
  });

  it('deleteFromOLAPTableByPK builds WHERE from PK columns', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.deleteFromOLAPTableByPK('t', ['id'], [[1], [3]]);
    expect(fakeState.execCalls[0]).toBe('DELETE FROM "t" WHERE ("id" = 1) OR ("id" = 3)');
  });

  it('deleteFromOLAPTableByPK is a no-op for empty values', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.deleteFromOLAPTableByPK('t', ['id'], []);
    expect(fakeState.execCalls).toEqual([]);
  });

  it('createTemporaryTable creates table then bulk-inserts', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.prepareImpl = () => ({
      run: (...args: unknown[]) => {
        const cb = args[args.length - 1] as ((err?: Error | null) => void);
        cb(null);
      },
      finalize: () => {},
    });
    await mgr.createTemporaryTable('tmp', [{ name: 'id', type: 'INT' }], [{ id: 1 }]);
    expect(fakeState.execCalls).toContain('CREATE TEMPORARY TABLE IF NOT EXISTS "tmp" ("id" INT)');
    expect(fakeState.preparedCalls[0]).toContain('INSERT INTO "tmp"');
  });

  it('escapes quotes in identifiers', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    await mgr.deleteFromOLAPTable('we"ird', [1]);
    expect(fakeState.execCalls[0]).toBe('DELETE FROM "we""ird" WHERE rowid IN (1)');
  });
});

describe('DuckDBAnalyticsManager — executeOnOLAP & name rewriting', () => {
  it('rewrites mapped table names and executes', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.allImpl = (_sql, cb) => cb(null, [{ x: 1 }]);
    const mapping = new Map([['lineitem', 'olap_shard_0_lineitem']]);
    const res = await mgr.executeOnOLAP('SELECT * FROM lineitem WHERE l=1', mapping);
    expect(res.rows).toEqual([{ x: 1 }]);
    expect(fakeState.allCalls.some(s => s.includes('olap_shard_0_lineitem'))).toBe(true);
  });

  it('rewrites without partial-word replacement', async () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    await mgr.init();
    fakeState.allImpl = (_sql, cb) => cb(null, []);
    const mapping = new Map([['line', 'OLAP_line']]);
    await mgr.executeOnOLAP('SELECT * FROM lineitem', mapping);
    // 'lineitem' must NOT become 'OLAP_lineitem' (word-boundary protects it)
    expect(fakeState.allCalls[0]).toBe('SELECT * FROM lineitem');
  });
});

describe('DuckDBAnalyticsManager — recovery metrics', () => {
  it('tracks recovery progress and completion', () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    mgr.markRecoveryStart(100);
    let m = mgr.getRecoveryMetrics();
    expect(m.isRecovering).toBe(true);
    expect(m.tablesTotal).toBe(100);
    expect(m.tablesRestored).toBe(0);
    expect(m.recoveryProgress).toBe(0);

    mgr.updateRecoveryProgress(50);
    m = mgr.getRecoveryMetrics();
    expect(m.tablesRestored).toBe(50);
    expect(m.isRecovering).toBe(true);

    mgr.updateRecoveryProgress(100);
    m = mgr.getRecoveryMetrics();
    expect(m.isRecovering).toBe(false);
    expect(m.recoveryProgress).toBe(1);
  });

  it('clamps tablesTotal to at least 1 to avoid div-by-zero', () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    mgr.markRecoveryStart(0);
    expect(mgr.getRecoveryMetrics().tablesTotal).toBe(1);
  });

  it('compute recoveryProgress === 1.0 when not started', () => {
    const mgr = new DuckDBAnalyticsManager('/tmp/x.db');
    const m = mgr.getRecoveryMetrics();
    expect(m.isRecovering).toBe(false);
    expect(m.recoveryProgress).toBe(1.0);
    expect(m.recoveryStartedAt).toBeNull();
  });
});

describe('DuckDBAnalyticsManager — singleton factory', () => {
  it('throws when not initialized', () => {
    expect(() => getDuckDBAnalyticsManager()).toThrow(/not initialized/);
  });

  it('creates a singleton on first call with dataDir and reuses it', () => {
    const a = getDuckDBAnalyticsManager('/tmp/datadir');
    const b = getDuckDBAnalyticsManager();
    expect(a).toBe(b);
  });

  it('reset clears the singleton', async () => {
    getDuckDBAnalyticsManager('/tmp/datadir');
    resetDuckDBAnalyticsManager();
    expect(() => getDuckDBAnalyticsManager()).toThrow(/not initialized/);
    // Re-initialize to leave global clean for other tests
    resetDuckDBAnalyticsManager();
  });

  it('reset swallows a close() rejection', async () => {
    const inst = getDuckDBAnalyticsManager('/tmp/datadir2');
    vi.spyOn(inst, 'close').mockRejectedValue(new Error('close boom'));
    // should not throw despite close() rejecting (the .catch(() => {}) path)
    expect(() => resetDuckDBAnalyticsManager()).not.toThrow();
    expect(() => getDuckDBAnalyticsManager()).toThrow(/not initialized/);
    resetDuckDBAnalyticsManager();
  });
});
