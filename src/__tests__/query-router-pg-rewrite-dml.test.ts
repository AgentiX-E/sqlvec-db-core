/**
 * End-to-end coverage of executeInternal's PG-compatibility rewrite Step
 * region as applied to non-SELECT statements (UPDATE / DELETE).
 *
 * The rewrite shims (`detectTypeCast`, `detectStringFunc`, …) are exercised
 * twice in QueryRouter — once for SELECT via `applyPgSelectRewrites`, and once
 * for every other statement type inside `executeInternal`'s Step 1a–1z
 * region. The latter path is only reachable when a non-SELECT statement (an
 * UPDATE or DELETE carrying a PG-ism such as `::cast`, `left(...)`, or
 * `ILIKE`) falls through the standard fast paths into `executeInternal`.
 *
 * These tests drive the public `execute()` entry point end-to-end against a
 * real SQLite shard so the assertions verify both that the rewrite fires
 * (`rewritten` branch → true) and that the rewritten SQL produces the correct
 * row effect — not merely that the statement "settles".
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
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => { db.exec(sqls.join(';')); },
    execBatchOnShard: async (_n: number, sqls: string[]) => db.exec(sqls.join(';')),
    rotateAllKeys: () => [{ success: true }],
  };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-pgrw-'));
  db0 = new Database(path.join(dir, 'rw-s0.db'));
  db0.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT, n INT);');
  db0.exec("INSERT INTO t VALUES (1,'abcdef',10),(2,'hijklm',-5),(3,'xyz',20);");
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

describe('executeInternal — PG-ism rewrite on UPDATE / DELETE', () => {
  it('rewrites left(...) in an UPDATE SET to substr and persists the result', async () => {
    await qr.execute('UPDATE t SET x = left(x, 2) WHERE id = 1');
    const row: any = db0.prepare('SELECT x FROM t WHERE id = 1').get();
    expect(row.x).toBe('ab');
  });

  it('rewrites right(...) in an UPDATE SET to substr', async () => {
    await qr.execute('UPDATE t SET x = right(x, 3) WHERE id = 2');
    const row: any = db0.prepare('SELECT x FROM t WHERE id = 2').get();
    expect(row.x).toBe('klm');
  });

  it('rewrites ::cast in an UPDATE SET to CAST and persists the value', async () => {
    await qr.execute("UPDATE t SET n = n::int WHERE id = 2");
    const row: any = db0.prepare('SELECT n FROM t WHERE id = 2').get();
    expect(row.n).toBe(-5);
  });

  it('rewrites ::text in a DELETE WHERE predicate so the row is removed', async () => {
    await qr.execute("DELETE FROM t WHERE n::text = '10'");
    const cnt: any = db0.prepare('SELECT COUNT(*) AS c FROM t').get();
    expect(cnt.c).toBe(2);
    const gone: any = db0.prepare('SELECT COUNT(*) AS c FROM t WHERE id = 1').get();
    expect(gone.c).toBe(0);
  });

  it('rewrites ILIKE into a case-insensitive LIKE on a DELETE predicate', async () => {
    await qr.execute("DELETE FROM t WHERE x ILIKE 'XYZ'");
    const cnt: any = db0.prepare('SELECT COUNT(*) AS c FROM t WHERE id = 3').get();
    expect(cnt.c).toBe(0);
  });
});

describe('executeInternal / execSelectFast — PG pattern-operator rewrite on SELECT', () => {
  // Independent table so the DELETE-based tests above cannot mutate its rows.
  beforeAll(() => {
    db0.exec('CREATE TABLE pat (id INTEGER PRIMARY KEY, s TEXT);');
    db0.exec("INSERT INTO pat VALUES (1,'Alpha'),(2,'bravo'),(3,'CHARLIE');");
  });

  it('rewrites ILIKE into a case-insensitive LIKE', async () => {
    const r = await qr.execute("SELECT id FROM pat WHERE s ILIKE 'alpha'");
    expect(r.rows).toContainEqual(expect.objectContaining({ id: 1 }));
  });

  it('rewrites NOT ILIKE', async () => {
    const r = await qr.execute("SELECT id FROM pat WHERE s NOT ILIKE 'alpha'");
    const ids = r.rows.map((row: any) => row.id).sort();
    expect(ids).toEqual([2, 3]);
  });

  it('rewrites the ~~ operator into LIKE', async () => {
    const r = await qr.execute("SELECT id FROM pat WHERE s ~~ 'bravo'");
    expect(r.rows).toContainEqual(expect.objectContaining({ id: 2 }));
  });

  it('rewrites the ~~* operator into a case-insensitive LIKE', async () => {
    const r = await qr.execute("SELECT id FROM pat WHERE s ~~* 'charlie'");
    expect(r.rows).toContainEqual(expect.objectContaining({ id: 3 }));
  });
});
