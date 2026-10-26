/**
 * MVCC own-write visibility tests for QueryRouter.
 *
 * `mergeOwnWritesIntoResult` is the mechanism that lets a transaction see its
 * own uncommitted INSERT/UPDATE/DELETE rows in a subsequent SELECT. It has two
 * layers:
 *
 *   1. A fast own-write merge (driven by `MVCCExecutor.txnOwnRowData`) that
 *      splices INSERTed rows, replaces UPDATEd rows, and removes DELETEd rows.
 *   2. A fallback that replays BEGIN…COMMIT buffered INSERTs from
 *      `TxCoord.pendingChanges` when the MVCC executor has no own-write rows.
 *
 * The standard-SQL transaction path (`execStandardSQL`) buffers DML into
 * `TxCoord.pendingChanges` without calling `addOwnWriteRow`, so in practice the
 * fallback is what makes the public API work. Both layers are exercised here:
 * the fallback through the real `execute()` pipeline, and the own-write merge
 * directly (since it is not reachable through the standard public path).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

const cleanups: string[] = [];

function makeRouter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-mvcc-'));
  cleanups.push(dir);
  const p = path.join(dir, 's0.db');
  const db = new Database(p);
  const shards = [{ db, vectorIndex: null, readers: [], path: p }];
  const sm: any = {
    getAllShards: () => new Map([[0, shards[0]]]),
    getShard: (n: number) => shards[n],
    execShard: async (n: number, sql: string) => shards[n].db.exec(sql),
    queryShard: (n: number, sql: string, params?: any[]) => shards[n].db.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => { shards[0].db.exec(sql); },
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => { shards[0].db.exec(sqls.join(';')); },
    execBatchOnShard: async (n: number, sqls: string[]) => shards[0].db.exec(sqls.join(';')),
    rotateAllKeys: () => [{ success: true }],
  };
  const config: any = {
    enabled: true, dimension: 768, metric: VectorMetric.COSINE, mode: VectorMode.AUTO,
    bruteForceThreshold: 1000, indexType: VectorIndexType.FLAT, indexParams: {},
  };
  const qr: any = new QueryRouter(sm, {} as any, config);
  return { qr, db };
}

afterEach(() => {
  while (cleanups.length) {
    try { fs.rmSync(cleanups.pop()!, { recursive: true, force: true }); } catch {}
  }
});

describe('mergeOwnWritesIntoResult — public fallback path', () => {
  it('SELECT inside a txn sees a buffered INSERT (pendingChanges fallback)', async () => {
    const { qr } = makeRouter();
    const sid = 'app-session-1';
    await qr.execute('CREATE TABLE t (id INT PRIMARY KEY, name TEXT)', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (1, 'old')", undefined, sid);
    await qr.execute('BEGIN', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (2, 'new')", undefined, sid);
    const r = await qr.execute('SELECT * FROM t ORDER BY id', undefined, sid);
    const ids = r.rows.map((x: any) => x.id).sort((a: any, b: any) => a - b);
    expect(ids).toEqual([1, 2]);
    expect(r.rows.find((x: any) => x.id === 2).name).toBe('new');
  });

  it('SELECT outside a txn does not see staged writes after ROLLBACK', async () => {
    const { qr } = makeRouter();
    const sid = 'app-session-2';
    await qr.execute('CREATE TABLE t (id INT PRIMARY KEY, name TEXT)', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (1, 'old')", undefined, sid);
    await qr.execute('BEGIN', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (2, 'new')", undefined, sid);
    await qr.execute('ROLLBACK', undefined, sid);
    const r = await qr.execute('SELECT * FROM t', undefined, sid);
    expect(r.rows.map((x: any) => x.id)).toEqual([1]);
  });
});

describe('mergeOwnWritesIntoResult — own-write merge (direct)', () => {
  let qr: any;
  beforeEach(async () => {
    ({ qr } = makeRouter());
    await qr.execute('CREATE TABLE t (id INT PRIMARY KEY, name TEXT)');
  });

  it('splices INSERT own-writes into the result', () => {
    qr.mvccExecutor.begin('s', 'READ_COMMITTED', false);
    qr.mvccExecutor.addOwnWriteRow('s', 't', 2, 'INSERT', { id: 2, name: 'new' });
    const result = { rows: [{ id: 1, name: 'old' }], rowCount: 1 };
    qr.mergeOwnWritesIntoResult('s', 'SELECT * FROM t', result);
    expect(result.rows.map((x: any) => x.id).sort((a: any, b: any) => a - b)).toEqual([1, 2]);
  });

  it('replaces an UPDATE own-write by rowId match', () => {
    qr.mvccExecutor.begin('s', 'READ_COMMITTED', false);
    qr.mvccExecutor.addOwnWriteRow('s', 't', 1, 'UPDATE', { id: 1, name: 'updated' });
    const result = { rows: [{ id: 1, name: 'old' }], rowCount: 1 };
    qr.mergeOwnWritesIntoResult('s', 'SELECT * FROM t', result);
    expect(result.rows).toEqual([{ id: 1, name: 'updated' }]);
  });

  it('removes a DELETE own-write by rowId match', () => {
    qr.mvccExecutor.begin('s', 'READ_COMMITTED', false);
    qr.mvccExecutor.addOwnWriteRow('s', 't', 1, 'DELETE');
    const result = { rows: [{ id: 1, name: 'old' }, { id: 2, name: 'keep' }], rowCount: 2 };
    qr.mergeOwnWritesIntoResult('s', 'SELECT * FROM t', result);
    expect(result.rows.map((x: any) => x.id)).toEqual([2]);
  });

  it('is a no-op when there is no active transaction', () => {
    const result = { rows: [{ id: 1, name: 'old' }], rowCount: 1 };
    qr.mergeOwnWritesIntoResult('no-such-session', 'SELECT * FROM t', result);
    expect(result.rows).toEqual([{ id: 1, name: 'old' }]);
  });
});
