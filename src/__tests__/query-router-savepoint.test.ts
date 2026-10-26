/**
 * Savepoint transaction semantics tests.
 *
 * `SAVEPOINT`, `RELEASE SAVEPOINT` and `ROLLBACK TO SAVEPOINT` are transaction
 * control statements. TxCoord already implemented a savepoint stack
 * (savepointStack / savepointIndexMap) and executeInternal already had an
 * interception block for them, but `parseStatement` only classified
 * `ROLLBACK TO SAVEPOINT` as TRANSACTION — `SAVEPOINT` and `RELEASE` were left
 * UNKNOWN, contradicting the interception block's own comment ("parseStatement
 * classifies ROLLBACK TO SAVEPOINT and RELEASE as TRANSACTION-type").
 *
 * This suite verifies the now-complete integration: all three forms parse as
 * TRANSACTION and a savepoint correctly bounds the set of staged changes that
 * survive `ROLLBACK TO`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { parseStatement } from '../query/SqlParser';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

let dir: string;
let db0: Database.Database;
let qr: QueryRouter;

function makeRouter(): { qr: QueryRouter; db: Database.Database } {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-sp-'));
  const p = path.join(d, 's0.db');
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
  const qr = new QueryRouter(sm, {} as any, config);
  return { qr, db };
}

afterAll(() => {
  try { if (db0) db0.close(); } catch {}
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('parseStatement classification', () => {
  it('classifies all savepoint forms as TRANSACTION with the savepoint name', () => {
    const sp = parseStatement('SAVEPOINT sp1') as any;
    expect(sp.type).toBe('TRANSACTION');
    expect(sp.command).toBe('SAVEPOINT');
    expect(sp.savepointName).toBe('sp1');

    const rel = parseStatement('RELEASE SAVEPOINT sp1') as any;
    expect(rel.type).toBe('TRANSACTION');
    expect(rel.command).toBe('RELEASE');
    expect(rel.savepointName).toBe('sp1');

    const rb = parseStatement('ROLLBACK TO SAVEPOINT sp1') as any;
    expect(rb.type).toBe('TRANSACTION');
    expect(rb.command).toBe('ROLLBACK TO');
    expect(rb.savepointName).toBe('sp1');
  });

  it('does not mis-classify a plain ROLLBACK as ROLLBACK TO', () => {
    const rb = parseStatement('ROLLBACK') as any;
    expect(rb.command).toBe('ROLLBACK');
    expect(rb.savepointName).toBeUndefined();
  });

  it('reports NO TRANSACTION when a savepoint is used outside a transaction', async () => {
    const { qr } = makeRouter();
    const sid = 'sp-no-txn';
    const r: any = await qr.execute('SAVEPOINT sp_x', undefined, sid);
    expect(r.rows[0].message).toBe('NO TRANSACTION');
    expect(r.rows[0].savepoint).toBe('sp_x');
  });
});

describe('savepoint bounds staged changes (end-to-end)', () => {
  it('ROLLBACK TO SAVEPOINT discards writes staged after the savepoint only', async () => {
    const { qr } = makeRouter();
    const sid = 'sp-a';
    await qr.execute('CREATE TABLE t (id INT PRIMARY KEY, name TEXT)', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (1, 'base')", undefined, sid);
    await qr.execute('BEGIN', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (2, 'before-sp')", undefined, sid);
    await qr.execute('SAVEPOINT sp1', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (3, 'after-sp')", undefined, sid);
    await qr.execute('ROLLBACK TO SAVEPOINT sp1', undefined, sid);

    // The write before the savepoint is still visible; the one after is not.
    const r: any = await qr.execute('SELECT * FROM t ORDER BY id', undefined, sid);
    const ids = r.rows.map((x: any) => x.id).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([1, 2]);
    expect(r.rows.find((x: any) => x.id === 3)).toBeUndefined();
  });

  it('RELEASE SAVEPOINT keeps writes staged after the savepoint', async () => {
    const { qr } = makeRouter();
    const sid = 'sp-b';
    await qr.execute('CREATE TABLE t (id INT PRIMARY KEY, name TEXT)', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (1, 'base')", undefined, sid);
    await qr.execute('BEGIN', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (2, 'kept')", undefined, sid);
    await qr.execute('SAVEPOINT sp2', undefined, sid);
    await qr.execute("INSERT INTO t VALUES (3, 'also-kept')", undefined, sid);
    await qr.execute('RELEASE SAVEPOINT sp2', undefined, sid);

    const r: any = await qr.execute('SELECT * FROM t ORDER BY id', undefined, sid);
    const ids = r.rows.map((x: any) => x.id).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });
});
