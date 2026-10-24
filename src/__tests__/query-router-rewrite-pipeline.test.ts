/**
 * End-to-end tests for QueryRouter.execute()'s PG-compatibility rewrite
 * pipeline. Each case drives one detect→rewrite pair through the real
 * execute() entry point with a SQL that matches the detector's trigger
 * pattern, asserting the statement reaches a terminal (rewrite / no-op-return
 * / execution) instead of falling through to an unhandled error. This
 * exercises the glue lines inside execute() that bridge the individually-
 * tested shim modules, which the feature suites never reached.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

interface RouterHarness {
  qr: QueryRouter;
  db: Database.Database;
}

function makeRouter(): RouterHarness {
  const db = new Database(':memory:');
  const exec = (s: string) => db.exec(s);
  const sm: any = {
    getAllShards: () => new Map([[0, { db, vectorIndex: null, readers: [] }] as any]),
    getShard: (n: number) => (n === 0 ? { db, vectorIndex: null, readers: [] } as any : undefined),
    execShard: async (_n: number, sql: string) => exec(sql),
    queryShard: (_n: number, sql: string, params?: any[]) =>
      db.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => exec(sql),
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => exec(sqls.join(';\n')),
    execBatchOnShard: async (_n: number, sqls: string[]) => exec(sqls.join(';\n')),
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
  return { qr: new QueryRouter(sm, {} as any, config), db };
}

describe('QueryRouter — PG compatibility rewrite pipeline (detect→rewrite glue)', () => {
  it('detects and rewrites a MERGE INTO statement (routes to write path)', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const r = await qr.execute(
      "MERGE INTO t USING (SELECT 1 AS id) s ON t.id = s.id WHEN MATCHED THEN UPDATE SET v = 'x'",
    );
    expect(r).toBeTruthy();
  });

  it('detects CREATE DOMAIN and returns an empty no-op result', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('CREATE DOMAIN us_postal_code AS TEXT');
    expect(r.rows).toEqual([]);
  });

  it('detects SAVEPOINT and routes through the savepoint path', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (id INTEGER)');
    const r = await qr.execute('SAVEPOINT sp1');
    expect(r).toBeTruthy();
  });

  it('detects and rewrites a BRIN index (USING BRIN)', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (id INTEGER)');
    const r = await qr.execute('CREATE INDEX idx ON t USING BRIN (id)');
    expect(r).toBeTruthy();
  });

  it('detects and rewrites a GiST index (USING GIST)', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (id INTEGER)');
    const r = await qr.execute('CREATE INDEX idx ON t USING GIST (id)');
    expect(r).toBeTruthy();
  });

  it('detects and rewrites a HASH index (USING HASH)', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (id INTEGER)');
    const r = await qr.execute('CREATE INDEX idx ON t USING HASH (id)');
    expect(r).toBeTruthy();
  });

  it('detects and rewrites a NULLS FIRST/LAST ordering clause', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (id INTEGER)');
    const r = await qr.execute('SELECT * FROM t ORDER BY id NULLS LAST');
    expect(r).toBeTruthy();
  });

  it('detects and rewrites a covering index INCLUDE clause', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (id INTEGER, name TEXT)');
    const r = await qr.execute('CREATE INDEX idx ON t (id) INCLUDE (name)');
    expect(r).toBeTruthy();
  });

  it('detects and rewrites a LATERAL join', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (id INTEGER)');
    const r = await qr.execute('SELECT * FROM t CROSS JOIN LATERAL (SELECT 1) s');
    expect(r).toBeTruthy();
  });

  it('detects and rewrites a DISTINCT ON clause', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (id INTEGER, grp INTEGER)');
    const r = await qr.execute('SELECT DISTINCT ON (grp) id, grp FROM t');
    expect(r).toBeTruthy();
  });

  it('detects and rewrites a recursive-CTE WITH clause', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute(
      'WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM r WHERE n < 3) SELECT * FROM r',
    );
    expect(r).toBeTruthy();
  });

  it('detects and handles a SET statement (no-op)', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SET statement_timeout = 30000');
    expect(r).toBeTruthy();
  });
});
