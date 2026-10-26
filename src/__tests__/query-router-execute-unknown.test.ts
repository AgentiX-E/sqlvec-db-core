/**
 * executeUnknown statement-dispatch tests.
 *
 * `executeUnknown` is the final fallback for statements with no recognized
 * type. It must distinguish row-returning queries (SHOW, VALUES, PRAGMA reads)
 * from side-effecting statements that return no rows (VACUUM, SAVEPOINT,
 * RELEASE SAVEPOINT, PRAGMA assignment). The former must go through
 * `stmt.all()`; the latter through `db.exec()`. Previously both went through
 * `queryAll` (`.all()`), so a bare `VACUUM` or `SAVEPOINT` failed with SQLite's
 * "This statement does not return data. Use run() instead" — a real bug that
 * this suite guards against.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { isRowReturningStatement } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

let dir: string;
let db0: Database.Database;
let qr: QueryRouter;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-uk-'));
  const p0 = path.join(dir, 's0.db');
  db0 = new Database(p0);
  db0.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);');
  const shard0 = { db: db0, vectorIndex: null, readers: [], path: p0 };
  const sm: any = {
    getAllShards: () => new Map([[0, shard0]]),
    getShard: () => shard0,
    execShard: async (_n: number, sql: string) => db0.exec(sql),
    queryShard: (_n: number, sql: string, params?: any[]) => db0.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => { db0.exec(sql); },
    queryAll: async (sql: string, params?: any[]) => db0.prepare(sql).all(...(params || [])),
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => { db0.exec(sqls.join(';')); },
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
  qr = new QueryRouter(sm, {} as any, config);
});

afterAll(() => {
  try { db0.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('isRowReturningStatement (predicate)', () => {
  it('classifies row-returning statements correctly', () => {
    expect(isRowReturningStatement('SELECT 1')).toBe(true);
    expect(isRowReturningStatement('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isRowReturningStatement('VALUES (1)')).toBe(true);
    expect(isRowReturningStatement('SHOW ALL')).toBe(true);
    expect(isRowReturningStatement('EXPLAIN SELECT 1')).toBe(true);
    expect(isRowReturningStatement('TABLE items')).toBe(true);
    expect(isRowReturningStatement('PRAGMA table_info(items)')).toBe(true);
  });

  it('classifies known side-effecting statements as non-row-returning', () => {
    expect(isRowReturningStatement('VACUUM')).toBe(false);
    expect(isRowReturningStatement('VACUUM FULL')).toBe(false);
    expect(isRowReturningStatement('SAVEPOINT sp1')).toBe(false);
    expect(isRowReturningStatement('RELEASE SAVEPOINT sp1')).toBe(false);
    expect(isRowReturningStatement('ROLLBACK TO SAVEPOINT sp1')).toBe(false);
    expect(isRowReturningStatement('ANALYZE items')).toBe(false);
  });
});

describe('executeUnknown — side-effecting statements execute without error', () => {
  it('VACUUM runs against the shard without throwing', async () => {
    await expect(qr.execute('VACUUM')).resolves.toBeDefined();
  });

  it('SAVEPOINT / RELEASE SAVEPOINT round-trip without throwing', async () => {
    await expect(qr.execute('SAVEPOINT sp1')).resolves.toBeDefined();
    await expect(qr.execute('RELEASE SAVEPOINT sp1')).resolves.toBeDefined();
  });
});

describe('executeUnknown — row-returning statements still return rows', () => {
  it('SHOW-like query still returns rows via queryAll', async () => {
    const r: any = await qr.execute('PRAGMA table_info(items)');
    expect(r.rows).toBeDefined();
    expect(Array.isArray(r.rows)).toBe(true);
  });
});
