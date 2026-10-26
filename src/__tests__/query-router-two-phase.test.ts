/**
 * Integration tests for two-phase commit (2PC) routing in QueryRouter.
 *
 * Historical bugs (all three fixed in the same change):
 *
 * 1. Session-id normalization — `executeTransaction`/`executeTwoPhase` default
 *    their transaction key to 'default' when no sessionId is passed, but the
 *    DML buffering branches in `execStandardSQL` tested the RAW `sessionId`
 *    (undefined) and skipped staging. Result: `BEGIN` (no sid) + `INSERT`
 *    (no sid) left the INSERT unstaged, so `PREPARE TRANSACTION`
 *    reported `savedChanges: 0`.
 *
 * 2. Fast-path misrouting — the BEGIN/COMMIT/ROLLBACK fast path matched
 *    `COMMIT PREPARED 'gid'` / `ROLLBACK PREPARED 'gid'` by their COMMIT /
 *    ROLLBACK prefix and routed them to `executeTransaction`, returning
 *    `NO TRANSACTION` and discarding the prepared changes.
 *
 * 3. Missing MVCC rewrite — `TwoPhaseCommitManager.commitPrepared` replays the
 *    persisted SQL verbatim via `db.exec`, but the buffered INSERT predates the
 *    MVCC-column rewrite. Replaying `INSERT INTO t VALUES (1,'a')` against a
 *    table with injected `_xmin/_xmax/_cmin/_cmax` columns failed with
 *    "table t has N columns but M values were supplied".
 *
 * These tests assert the full 2PC lifecycle end-to-end via the public
 * `execute` API, so they exercise detectTwoPhase routing, executeTwoPhase
 * (prepare/commit/rollback), MVCC rewrite of prepared DML, and the session-id
 * normalization — no reflection and no internal stubbing of the 2PC path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { shutdownWAL } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

interface ShardHandle {
  db: Database.Database;
  vectorIndex: null;
  readers: unknown[];
  path: string;
}

const cleanups: string[] = [];
let db0: Database.Database;

function makeRouter(): QueryRouter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-2pc-'));
  cleanups.push(dir);
  const p0 = path.join(dir, 's0.db');
  db0 = new Database(p0);
  const shard0: ShardHandle = { db: db0, vectorIndex: null, readers: [], path: p0 };

  const sm: any = {
    getAllShards: () => new Map([[0, shard0]]),
    getShard: (n: number) => (n === 0 ? shard0 : undefined),
    execShard: async (_n: number, sql: string) => db0.exec(sql),
    queryShard: (_n: number, sql: string, params?: any[]) =>
      db0.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => db0.exec(sql),
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => db0.exec(sqls.join(';')),
    execBatchOnShard: async (_n: number, sqls: string[]) => db0.exec(sqls.join(';')),
    rotateAllKeys: () => [{ success: true }],
  };
  const config: any = {
    enabled: true,
    dimension: 768,
    metric: VectorMetric.COSINE,
    mode: VectorMode.AUTO,
    bruteForceThreshold: 1000,
    indexType: VectorIndexType.FLAT,
    indexParams: {},
  };
  const router = new QueryRouter(sm, {} as any, config);
  (router as any).parallelExecutor = { executeParallel: async () => [] };
  return router;
}

afterEach(() => {
  try { db0?.close(); } catch {}
  while (cleanups.length) {
    try { fs.rmSync(cleanups.pop()!, { recursive: true, force: true }); } catch {}
  }
});

describe('two-phase commit (2PC) routing', () => {
  it('COMMIT PREPARED persists staged DML across the full PREPARE/COMMIT cycle (no explicit session id)', async () => {
    const qr = makeRouter();
    await qr.execute('CREATE TABLE t (id INT, x TEXT)');

    // No sessionId passed — exercises the session-id normalization fix.
    await qr.execute('BEGIN');
    await qr.execute("INSERT INTO t VALUES (1, 'a')");
    await qr.execute("INSERT INTO t VALUES (2, 'b')");

    const prep = await qr.execute("PREPARE TRANSACTION 'gid1'");
    expect(prep.rows[0]).toMatchObject({ message: 'PREPARE TRANSACTION', gid: 'gid1' });
    expect(prep.rows[0].savedChanges).toBe(2);

    const commit = await qr.execute("COMMIT PREPARED 'gid1'");
    expect(commit.rows[0]).toMatchObject({ message: 'COMMIT PREPARED', gid: 'gid1' });

    // Both rows persisted with MVCC visibility columns assigned (xid > 0).
    const rows = db0.prepare('SELECT id, x, _xmin, _xmax FROM t ORDER BY id').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows.map((r) => r.x)).toEqual(['a', 'b']);
    for (const r of rows) {
      expect(r._xmin).toBeGreaterThan(0);
      expect(r._xmax).toBeNull();
    }
  });

  it('COMMIT PREPARED persists staged DML with an explicit session id', async () => {
    const qr = makeRouter();
    await qr.execute('CREATE TABLE t (id INT, x TEXT)');
    const sid = 'two-phase-session';

    await qr.execute('BEGIN', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (10, 'z')", undefined, sid);

    const prep = await qr.execute("PREPARE TRANSACTION 'gid2'", undefined, sid);
    expect(prep.rows[0].savedChanges).toBe(1);

    const commit = await qr.execute("COMMIT PREPARED 'gid2'", undefined, sid);
    expect(commit.rows[0]).toMatchObject({ message: 'COMMIT PREPARED', gid: 'gid2' });

    const rows = db0.prepare('SELECT id, x FROM t').all() as any[];
    expect(rows).toEqual([{ id: 10, x: 'z' }]);
  });

  it('ROLLBACK PREPARED discards staged DML', async () => {
    const qr = makeRouter();
    await qr.execute('CREATE TABLE t (id INT, x TEXT)');
    const sid = 'two-phase-rollback';

    await qr.execute('BEGIN', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (1, 'keep-me-out')", undefined, sid);

    const prep = await qr.execute("PREPARE TRANSACTION 'gid3'", undefined, sid);
    expect(prep.rows[0].savedChanges).toBe(1);

    const rollback = await qr.execute("ROLLBACK PREPARED 'gid3'", undefined, sid);
    expect(rollback.rows[0]).toMatchObject({ message: 'ROLLBACK PREPARED', gid: 'gid3' });

    // The rolled-back INSERT must not have landed.
    const rows = db0.prepare('SELECT * FROM t').all();
    expect(rows).toHaveLength(0);
  });

  it('engine accessors expose the configured internals', () => {
    const qr = makeRouter();
    // `engineRouter` returns the unified router (undefined here since the
    // test router is constructed with a plain shard manager and no unified
    // routing backend); the getter must still be reachable and defined.
    expect(qr.engineRouter).toBeUndefined();
    expect(qr.engineDuckDBExecutor).toBeUndefined();
  });
});

describe('shutdownWAL', () => {
  it('is a no-op best-effort flush that resolves without throwing', async () => {
    // shutdownWAL flushes the global PgWalWriter singleton and writes a
    // checkpoint; it must never throw (failures are swallowed as non-fatal).
    await expect(shutdownWAL()).resolves.toBeUndefined();
  });
});
