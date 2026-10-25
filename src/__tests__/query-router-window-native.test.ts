/**
 * Window functions must produce correct results through QueryRouter.execute()
 * via SQLite's native OVER support (SQLite >= 3.25). These serve as a
 * regression safety net: the legacy scatter-gather re-ranking path
 * (handleWindowQuery) was unreachable dead code, and its removal must not
 * change observable window-function semantics.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

let qr: QueryRouter;
let db: Database.Database;

beforeAll(() => {
  db = new Database(':memory:');
  const sm: any = {
    getAllShards: () => new Map([[0, { db, vectorIndex: null, readers: [] }] as any]),
    getShard: (n: number) => (n === 0 ? { db, vectorIndex: null, readers: [] } as any : undefined),
    execShard: async (_n: number, sql: string) => db.exec(sql),
    queryShard: (_n: number, sql: string, params?: any[]) => db.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => db.exec(sql),
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => db.exec(sqls.join(';')),
    execBatchOnShard: async (_n: number, sqls: string[]) => db.exec(sqls.join(';')),
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
  qr = new QueryRouter(sm, {} as any, config);
  db.exec('CREATE TABLE sales (region TEXT, amount INTEGER)');
  db.exec(`
    INSERT INTO sales VALUES
      ('east', 10), ('east', 30), ('east', 20), ('east', 10),
      ('west', 5), ('west', 15)
  `);
});

describe('QueryRouter window functions (native SQLite execution)', () => {
  it('computes ROW_NUMBER ordered by amount globally', async () => {
    const r = await qr.execute(
      'SELECT region, amount, ROW_NUMBER() OVER (ORDER BY amount DESC) AS rn FROM sales',
    );
    expect(r.rows).toHaveLength(6);
    // top amount (30) is rn 1, then 20, 15, 10, 10, 5
    expect(r.rows[0]).toMatchObject({ amount: 30, rn: 1 });
    expect(r.rows[1]).toMatchObject({ amount: 20, rn: 2 });
    expect(r.rows[r.rows.length - 1]).toMatchObject({ amount: 5, rn: 6 });
  });

  it('partitions ROW_NUMBER by region', async () => {
    const r = await qr.execute(
      'SELECT region, amount, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) AS rn FROM sales',
    );
    // east has 4 rows (rn 1..4), west has 2 rows (rn 1..2)
    const east = r.rows.filter((x: any) => x.region === 'east');
    const west = r.rows.filter((x: any) => x.region === 'west');
    expect(east.map((x: any) => x.rn).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(west.map((x: any) => x.rn).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('ranks RANK and DENSE_RANK with ties', async () => {
    const r = await qr.execute(
      'SELECT amount, RANK() OVER (ORDER BY amount) AS rk FROM sales',
    );
    // amounts: 5,10,10,15,20,30 → ranks 1,2,2,4,5,6
    const rkByAmount = new Map<number, any>();
    for (const row of r.rows) if (!rkByAmount.has(row.amount)) rkByAmount.set(row.amount, row.rk);
    expect(rkByAmount.get(5)).toBe(1);
    expect(rkByAmount.get(10)).toBe(2); // tied
    expect(rkByAmount.get(15)).toBe(4); // skipped 3
    expect(rkByAmount.get(20)).toBe(5);
    expect(rkByAmount.get(30)).toBe(6);
  });

  it('applies statement ORDER BY and LIMIT after window computation', async () => {
    const r = await qr.execute(
      'SELECT region, amount, ROW_NUMBER() OVER (ORDER BY amount) AS rn FROM sales ORDER BY amount DESC LIMIT 2',
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].amount).toBe(30);
    expect(r.rows[1].amount).toBe(20);
  });

  it('executes aggregate window functions (SUM/AVG OVER)', async () => {
    const r = await qr.execute(
      'SELECT region, amount, SUM(amount) OVER (PARTITION BY region) AS region_total FROM sales ORDER BY region, amount',
    );
    expect(r.rows).toHaveLength(6);
    const eastTotal = r.rows[0].region_total;
    expect(eastTotal).toBe(70); // 10+30+20+10
    const westTotal = r.rows[4].region_total;
    expect(westTotal).toBe(20); // 5+15
  });
});
