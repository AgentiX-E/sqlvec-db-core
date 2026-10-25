/**
 * End-to-end coverage for PostgreSQL generated columns exercised through
 * QueryRouter.execute(). Verifies that:
 *   - CREATE TABLE ... GENERATED ALWAYS AS (expr) STORED registers the
 *     definition in the _sqlvec_generated_columns system table (DDL path).
 *   - INSERT computes the generated value and returns it on read-back.
 *   - DROP TABLE removes the generation definition from the system table
 *     (metadata must not leak after the table is gone).
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
});

function registeredDefs(table: string): any[] {
  try {
    return db.prepare(
      `SELECT table_name, column_name, expression FROM _sqlvec_generated_columns WHERE table_name = ?`,
    ).all(table) as any[];
  } catch {
    return [];
  }
}

describe('generated columns (GENERATED ALWAYS AS)', () => {
  it('registers the generated column definition during CREATE TABLE', async () => {
    await qr.execute('CREATE TABLE gc (a INT, b INT, c INT GENERATED ALWAYS AS (a + b) STORED)');
    expect(registeredDefs('gc')).toEqual([
      { table_name: 'gc', column_name: 'c', expression: 'a + b' },
    ]);
  });

  it('computes the generated value on INSERT and returns it on read-back', async () => {
    await qr.execute('CREATE TABLE gc2 (a INT, b INT, c INT GENERATED ALWAYS AS (a + b) STORED)');
    await qr.execute('INSERT INTO gc2 (a, b) VALUES (3, 4)');
    const r = await qr.execute('SELECT a, b, c FROM gc2');
    expect(r.rows).toEqual([{ a: 3, b: 4, c: 7 }]);
  });

  it('removes the generation definition when the table is dropped', async () => {
    await qr.execute('CREATE TABLE gc3 (a INT, b INT, c INT GENERATED ALWAYS AS (a * b) STORED)');
    expect(registeredDefs('gc3')).toHaveLength(1);

    await qr.execute('DROP TABLE gc3');

    // The metadata must not leak after the table is dropped.
    expect(registeredDefs('gc3')).toHaveLength(0);
  });
});
