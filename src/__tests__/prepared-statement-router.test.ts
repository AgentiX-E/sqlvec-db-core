import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

/**
 * End-to-end tests for PostgreSQL PREPARE / EXECUTE / DEALLOCATE wired through
 * QueryRouter. Prepared statements are intercepted before classification and
 * driven by PreparedStatementManager; EXECUTE re-enters the normal pipeline
 * with $N placeholders substituted.
 */

type ShardManager = any;

function makeRouter() {
  const db = new Database(':memory:');
  const exec = (s: string) => db.exec(s);
  const sm: ShardManager = {
    getAllShards: () =>
      new Map([[0, { db, vectorIndex: null, readers: [] }]]),
    getShard: (n: number) =>
      n === 0 ? { db, vectorIndex: null, readers: [] } : undefined,
    execShard: async (_n: number, sql: string) => exec(sql),
    queryShard: (_n: number, sql: string, p?: any[]) => db.prepare(sql).all(...(p || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => exec(sql),
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => exec(sqls.join(';\n')),
    execBatchOnShard: async (_n: number, sqls: string[]) => exec(sqls.join(';\n')),
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

describe('QueryRouter PREPARE / EXECUTE / DEALLOCATE', () => {
  let qr: QueryRouter;
  let db: Database.Database;

  beforeEach(() => {
    ({ qr, db } = makeRouter());
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT, n INTEGER)');
    db.prepare('INSERT INTO t (x, n) VALUES (?, ?)').run('hello', 10);
    db.prepare('INSERT INTO t (x, n) VALUES (?, ?)').run('world', 20);
  });

  it('PREPARE stores the statement and returns an empty result', async () => {
    const r = await qr.execute('PREPARE p1 (text) AS SELECT * FROM t WHERE x = $1');
    expect(r.rowCount).toBe(0);
    expect((qr as any).preparedStatements.has('p1')).toBe(true);
  });

  it('EXECUTE returns the matching row for a string parameter', async () => {
    await qr.execute('PREPARE p1 (text) AS SELECT * FROM t WHERE x = $1');
    const r = await qr.execute("EXECUTE p1 ('hello')");
    expect(r.rows).toEqual([{ id: 1, x: 'hello', n: 10 }]);
    expect(r.rowCount).toBe(1);
  });

  it('EXECUTE substitutes numeric and NULL parameters', async () => {
    await qr.execute('PREPARE p2 (integer) AS SELECT * FROM t WHERE n = $1');
    const rNum = await qr.execute('EXECUTE p2 (20)');
    expect(rNum.rows).toEqual([{ id: 2, x: 'world', n: 20 }]);

    await qr.execute('PREPARE p3 (integer) AS SELECT * FROM t WHERE n = $1');
    const rNull = await qr.execute('EXECUTE p3 (NULL)');
    expect(rNull.rows).toEqual([]);
    expect(rNull.rowCount).toBe(0);
  });

  it('EXECUTE supports multiple parameters', async () => {
    await qr.execute('PREPARE p4 (text, integer) AS SELECT * FROM t WHERE x = $1 AND n = $2');
    const r = await qr.execute("EXECUTE p4 ('world', 20)");
    expect(r.rows).toEqual([{ id: 2, x: 'world', n: 20 }]);
  });

  it('EXECUTE unescapes doubled single quotes in string literals', async () => {
    db.prepare('INSERT INTO t (x, n) VALUES (?, ?)').run("o'reilly", 30);
    await qr.execute('PREPARE p5 (text) AS SELECT * FROM t WHERE x = $1');
    const r = await qr.execute("EXECUTE p5 ('o''reilly')");
    expect(r.rows).toEqual([{ id: 3, x: "o'reilly", n: 30 }]);
  });

  it('DEALLOCATE removes a prepared statement', async () => {
    await qr.execute('PREPARE p6 (text) AS SELECT * FROM t WHERE x = $1');
    await qr.execute('DEALLOCATE p6');
    expect((qr as any).preparedStatements.has('p6')).toBe(false);
  });

  it('EXECUTE on a deallocated statement throws', async () => {
    await qr.execute('PREPARE p7 (text) AS SELECT * FROM t WHERE x = $1');
    await qr.execute('DEALLOCATE p7');
    await expect(qr.execute("EXECUTE p7 ('hello')")).rejects.toThrow(/not found/i);
  });

  it('PREPARE with a duplicate name throws', async () => {
    await qr.execute('PREPARE p8 (text) AS SELECT * FROM t WHERE x = $1');
    await expect(
      qr.execute('PREPARE p8 (text) AS SELECT * FROM t WHERE n = $1'),
    ).rejects.toThrow(/already exists/i);
  });

  it('EXECUTE with mismatched parameter count throws', async () => {
    await qr.execute('PREPARE p9 (text, integer) AS SELECT * FROM t WHERE x = $1 AND n = $2');
    await expect(qr.execute("EXECUTE p9 ('hello')")).rejects.toThrow(/parameters/i);
  });
});
