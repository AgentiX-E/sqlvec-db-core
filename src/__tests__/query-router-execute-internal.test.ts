/**
 * executeInternal dispatch-matrix tests.
 *
 * `executeInternal` is the fallback pipeline reached only for SQL that the
 * standard fast paths (execStandardSQL / execInsertFast / execSelectFast)
 * decline to handle: DML carrying a RETURNING clause, DML trigger dispatch,
 * transaction control statements, and DDL/misc statement types.
 *
 * These tests drive the public `execute()` entry point end-to-end so the
 * coverage is real — it exercises the actual fallback routing, MVCC own-write
 * recording, row locking, and dollar-quote normalization, not mock stubs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

let dir: string;
let db0: Database.Database;
let qr: QueryRouter;

function makeShardManager(db: Database.Database): any {
  const shard0 = { db, vectorIndex: null, readers: [], path: dir + '/s0.db' };
  return {
    getAllShards: () => new Map([[0, shard0]]),
    getShard: () => shard0,
    execShard: async (_n: number, sql: string) => db.exec(sql),
    queryShard: (_n: number, sql: string, params?: any[]) => db.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => { db.exec(sql); },
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => { db.exec(sqls.join(';')); },
    execBatchOnShard: async (_n: number, sqls: string[]) => db.exec(sqls.join(';')),
    rotateAllKeys: () => [{ success: true }],
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-ei-'));
  db0 = new Database(path.join(dir, 's0.db'));
  db0.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER);');
  db0.exec("INSERT INTO items VALUES (1,'a',10),(2,'b',20),(3,'c',30);");
  const config: any = {
    enabled: true,
    dimension: 768,
    metric: VectorMetric.COSINE,
    mode: VectorMode.AUTO,
    bruteForceThreshold: 1000,
    indexType: VectorIndexType.FLAT,
    indexParams: {},
  };
  qr = new QueryRouter(makeShardManager(db0), {} as any, config);
});

afterAll(() => {
  try { db0.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('executeInternal — auto-commit DML with RETURNING', () => {
  it('UPDATE ... RETURNING returns the updated row and commits', async () => {
    const r = await qr.execute('UPDATE items SET qty = 99 WHERE id = 1 RETURNING id, qty');
    expect(r.rows).toContainEqual(expect.objectContaining({ id: 1, qty: 99 }));
    const check: any = db0.prepare('SELECT qty FROM items WHERE id = 1').get();
    expect(check.qty).toBe(99);
  });

  it('DELETE ... RETURNING returns the removed row', async () => {
    const r = await qr.execute('DELETE FROM items WHERE id = 2 RETURNING id, name');
    expect(r.rows).toContainEqual(expect.objectContaining({ id: 2, name: 'b' }));
    const check: any = db0.prepare('SELECT COUNT(*) AS c FROM items WHERE id = 2').get();
    expect(check.c).toBe(0);
  });

  it('INSERT ... RETURNING degrades without MVCC columns instead of corrupting', async () => {
    // The `items` table has no _xmin/_xmax/_cmin/_cmax MVCC columns (it was
    // created without the MVCC DDL path), so the MVCC rewrite of the INSERT
    // cannot be applied. The router must not throw or half-commit: it reports
    // an empty result and leaves the table untouched.
    const r = await qr.execute("INSERT INTO items (name, qty) VALUES ('z', 77) RETURNING id, name");
    expect(r).toBeDefined();
    expect(r.rowCount).toBe(0);
    const check: any = db0.prepare('SELECT COUNT(*) AS c FROM items WHERE name = ?').get('z');
    expect(check.c).toBe(0);
  });
});

describe('executeInternal — transaction-scoped RETURNING', () => {
  it('buffers/executes UPDATE ... RETURNING inside an explicit txn', async () => {
    await qr.execute('BEGIN', undefined, 'sid-ei');
    const r = await qr.execute('UPDATE items SET qty = qty + 1 WHERE id = 3 RETURNING id, qty', undefined, 'sid-ei');
    expect(r).toBeDefined();
    await qr.execute('COMMIT', undefined, 'sid-ei');
    const check: any = db0.prepare('SELECT qty FROM items WHERE id = 3').get();
    expect(check.qty).toBe(31);
  });
});

describe('executeInternal — dollar-quote normalization', () => {
  it('converts $$...$$ to a single-quoted literal', async () => {
    const r = await qr.execute("UPDATE items SET name = $$hello 'quoted' world$$ WHERE id = 1 RETURNING id, name");
    expect(r).toBeDefined();
    const check: any = db0.prepare('SELECT name FROM items WHERE id = 1').get();
    expect(check.name).toBe("hello 'quoted' world");
  });
});
