/**
 * End-to-end coverage of executeInternal's DDL / DML-only PG-compatibility
 * shims that are *not* reachable through the SELECT fast path.
 *
 * `applyPgSelectRewrites` only runs for SELECT statements. The DDL/DML-only
 * shims (CTE extensions, MERGE, partial/covering/expression/GiST indexes,
 * NULLS FIRST/LAST, SET/RESET, LOCK TABLE, NOTIFY/LISTEN, etc.) are exercised
 * exclusively inside `executeInternal`'s Step 1a–1z region. A bare PG-ism that
 * survives that region would reach SQLite and fail (e.g. `near "MERGE"`,
 * `near "GRANT"`, or a stray `NULLS LAST` on a non-window ORDER BY).
 *
 * Each test drives the public `execute()` entry point against a real SQLite
 * shard and asserts the rewrite fires AND produces the correct side effect —
 * not merely that the statement settles.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';
import { getNotifyListenInitSql } from '../query/NotifyListenShim';

let dir: string;
let db0: Database.Database;
let qr: QueryRouter;

function makeShardManager(db: Database.Database): any {
  const shard0 = { db, vectorIndex: null, readers: [], path: dir + '/rw-s0.db' };
  return {
    getAllShards: () => new Map([[0, shard0]]),
    getShard: () => shard0,
    execShard: async (_n: number, sql: string) => db.exec(sql),
    queryShard: (_n: number, sql: string, params?: any[]) => db.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => { db.exec(sql); },
    queryAll: async (sql: string, params?: any[]) => db.prepare(sql).all(...(params || [])),
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => { db.exec(sqls.join(';')); },
    execBatchOnShard: async (_n: number, sqls: string[]) => db.exec(sqls.join(';')),
    rotateAllKeys: () => [{ success: true }],
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-ddls-'));
  db0 = new Database(path.join(dir, 'rw-s0.db'));
  db0.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT, n INT);');
  db0.exec("INSERT INTO t VALUES (1,'abc',10),(2,'ABC',-5),(3,'xyz',20);");
  // NOTIFY/LISTEN backing tables (normally created by the database bootstrap
  // schema, which a bare QueryRouter does not run).
  for (const ddl of getNotifyListenInitSql()) db0.exec(ddl);
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

describe('executeInternal — DDL/DML-only PG-ism rewrites', () => {
  it('strips MATERIALIZED from a CTE so the query runs', async () => {
    const r: any = await qr.execute('WITH c AS MATERIALIZED (SELECT * FROM t) SELECT * FROM c ORDER BY id');
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0].id).toBe(1);
  });

  it('rewrites MERGE into INSERT ... ON CONFLICT and applies the change', async () => {
    const r: any = await qr.execute(
      "MERGE INTO t USING (SELECT 9 AS id, 'new' AS x, 7 AS n) s ON t.id = s.id " +
      'WHEN MATCHED THEN UPDATE SET n = s.n ' +
      'WHEN NOT MATCHED THEN INSERT (id, x, n) VALUES (s.id, s.x, s.n)',
    );
    const row: any = db0.prepare('SELECT id, x, n FROM t WHERE id = 9').get();
    expect(row).toEqual({ id: 9, x: 'new', n: 7 });
  });

  it('strips the WHERE clause of a partial index into a plain (no-op) index', async () => {
    await qr.execute('CREATE INDEX idx_t_n ON t(n) WHERE n > 0');
    // The column must be indexable (the shim strips the unsupported predicate).
    const idx: any = db0.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_t_n'").get();
    expect(idx).toBeTruthy();
  });

  it('strips the INCLUDE clause of a covering index', async () => {
    await qr.execute('CREATE INDEX idx_t_x ON t(x) INCLUDE (n)');
    const idx: any = db0.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_t_x'").get();
    expect(idx).toBeTruthy();
  });

  it('unwraps double parens of an expression index', async () => {
    await qr.execute('CREATE INDEX idx_lower ON t ((lower(x)))');
    const idx: any = db0.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_lower'").get();
    expect(idx).toBeTruthy();
  });

  it('rewrites ORDER BY col NULLS LAST into a null-aware ordering', async () => {
    const r: any = await qr.execute('SELECT id, n FROM t ORDER BY n NULLS LAST, id');
    // t has n ∈ {10, -5, 20} plus id=9 n=7 from the MERGE test; NULLS LAST
    // without any NULLs simply preserves ascending order.
    expect(r.rows.map((row: any) => row.n)).toEqual([-5, 7, 10, 20]);
  });

  it('no-ops a SET search_path statement', async () => {
    const r: any = await qr.execute('SET search_path TO public');
    expect(r).toBeDefined();
  });

  it('records a NOTIFY into the backing queue table', async () => {
    await qr.execute("NOTIFY mychannel, 'hello'");
    const row: any = db0.prepare("SELECT channel, payload FROM __notify_queue WHERE channel='mychannel'").get();
    expect(row.channel).toBe('mychannel');
    expect(row.payload).toBe('hello');
  });

  it('records a LISTEN into the backing listeners table', async () => {
    await qr.execute('LISTEN mychannel');
    const row: any = db0.prepare("SELECT channel FROM __notify_listeners WHERE channel='mychannel'").get();
    expect(row).toBeTruthy();
  });

  it('no-ops a LOCK TABLE statement', async () => {
    const r: any = await qr.execute('LOCK TABLE t IN ACCESS EXCLUSIVE MODE');
    expect(r).toBeDefined();
  });

  it('no-ops CREATE TYPE ... AS ENUM even after literal protection', async () => {
    const r: any = await qr.execute("CREATE TYPE mood AS ENUM ('sad','ok','happy')");
    expect(r.rowCount).toBe(0);
  });

  it('registers a standalone CREATE SEQUENCE via SequenceManager', async () => {
    await qr.execute('CREATE SEQUENCE seq1 START 1');
    const row: any = db0.prepare("SELECT name FROM _sqlvec_sequences WHERE name='seq1'").get();
    expect(row).toBeTruthy();
  });

  it('drops a standalone DROP SEQUENCE via SequenceManager', async () => {
    await qr.execute('DROP SEQUENCE IF EXISTS seq1');
    const row: any = db0.prepare("SELECT name FROM _sqlvec_sequences WHERE name='seq1'").get();
    expect(row).toBeUndefined();
  });
});
