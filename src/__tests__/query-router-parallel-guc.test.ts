/**
 * Integration regression tests for parallel-query GUC routing in QueryRouter.
 *
 * Historical bug: `SET parallel_workers = N` (and the other parallel GUCs)
 * were swallowed by broad SET matchers before they reached the parallel
 * query handling in Step 1x. Concretely:
 *   1. Step 1e — detectSetReset matched every `SET ...` as a no-op.
 *   2. Step 1r — ConnectionPoolShim's `SET_CMD = /^\s*SET\s+/i` rewrote every
 *      `SET ...` into `SELECT 1`.
 * Either one returned early, so ParallelSessionContext.parallelWorkers was
 * never populated and the entire parallel execution path
 * (calculateShouldUseParallel → buildParallelTasks → sortRowsByOrderBy →
 * getTableRowCount) was unreachable.
 *
 * These tests assert that parallel GUCs now flow through to Step 1x (updating
 * the session context) while non-parallel SET (e.g. client_encoding) still
 * follow their original no-op/PoolSql path, and that the parallel decision
 * helpers behave correctly on a two-shard file-backed database.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

interface ShardHandle {
  db: Database.Database;
  vectorIndex: null;
  readers: unknown[];
  path: string;
}

const cleanups: string[] = [];
let db0: Database.Database;
let db1: Database.Database;
let shard0: ShardHandle;
let shard1: ShardHandle;

/** Build a fresh two-shard, file-backed QueryRouter for each test. */
function makeRouter(): QueryRouter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-par-'));
  cleanups.push(dir);
  const p0 = path.join(dir, 's0.db');
  const p1 = path.join(dir, 's1.db');
  db0 = new Database(p0);
  db1 = new Database(p1);
  for (const db of [db0, db1]) {
    db.exec('CREATE TABLE t (id INT, x TEXT)');
    db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')");
  }
  shard0 = { db: db0, vectorIndex: null, readers: [], path: p0 };
  shard1 = { db: db1, vectorIndex: null, readers: [], path: p1 };

  const sm: any = {
    getAllShards: () => new Map([[0, shard0], [1, shard1]]),
    getShard: (n: number) => (n === 0 ? shard0 : n === 1 ? shard1 : undefined),
    execShard: async (_n: number, sql: string) => (_n === 0 ? db0 : db1).exec(sql),
    queryShard: (_n: number, sql: string, params?: any[]) =>
      (_n === 0 ? db0 : db1).prepare(sql).all(...(params || [])),
    getShardCount: () => 2,
    getShardIdForKey: () => 0,
    getShardIds: () => [0, 1],
    execAll: async (sql: string) => { db0.exec(sql); db1.exec(sql); },
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => { db0.exec(sqls.join(';')); db1.exec(sqls.join(';')); },
    execBatchOnShard: async (_n: number, sqls: string[]) => (_n === 0 ? db0 : db1).exec(sqls.join(';')),
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
  const router = new QueryRouter(sm, {} as any, config);

  // Pre-seed a fake ParallelExecutor so the parallel decision path does not
  // spin up a real Piscina thread pool (which requires a compiled
  // parallel-worker.js not present under tsx/vitest). The helpers under test
  // (calculateShouldUseParallel, buildParallelTasks) are exercised directly;
  // executeParallel is stubbed to return empty results.
  (router as any).parallelExecutor = {
    executeParallel: async () => [],
  };

  return router;
}

afterEach(() => {
  try { db0?.close(); } catch {}
  try { db1?.close(); } catch {}
  while (cleanups.length) {
    try { fs.rmSync(cleanups.pop()!, { recursive: true, force: true }); } catch {}
  }
});

describe('parallel-query GUC routing (regression)', () => {
  it('SET parallel_workers updates the session context', async () => {
    const qr = makeRouter();
    await qr.execute('SET parallel_workers = 2');
    const ctx = (qr as any).defaultParallelCtx;
    expect(ctx.parallelWorkers).toBe(2);
    expect(ctx.effectiveWorkers).toBe(2);
  });

  it('SET max_parallel_workers_per_gather updates the session context', async () => {
    const qr = makeRouter();
    await qr.execute('SET max_parallel_workers_per_gather = 4');
    const ctx = (qr as any).defaultParallelCtx;
    expect(ctx.maxParallelWorkersPerGather).toBe(4);
  });

  it('SET max_parallel_workers updates the session context', async () => {
    const qr = makeRouter();
    await qr.execute('SET max_parallel_workers = 3');
    const ctx = (qr as any).defaultParallelCtx;
    expect(ctx.maxParallelWorkers).toBe(3);
  });

  it('non-parallel SET (client_encoding) still returns an empty no-op result', async () => {
    const qr = makeRouter();
    const r = await qr.execute('SET client_encoding = UTF8');
    expect(r.rows).toEqual([]);
    expect(r.rowCount).toBe(0);
  });

  it('parallel decision helpers are reachable on a two-shard database', async () => {
    const qr = makeRouter();
    await qr.execute('SET parallel_workers = 2');
    const ctx = (qr as any).defaultParallelCtx;

    const shouldParallel = (qr as any).calculateShouldUseParallel(['t'], ctx, 2, true);
    expect(shouldParallel).toBe(true);

    const tasks = (qr as any).buildParallelTasks('SELECT * FROM t', undefined);
    expect(tasks).not.toBeNull();
    expect(tasks.length).toBe(2);

    const rowCount = (qr as any).getTableRowCount('t');
    expect(rowCount).toBe(6); // 3 rows per shard × 2 shards
  });

  it('sortRowsByOrderBy sorts merged rows in-place', () => {
    const qr = makeRouter();

    const rows = [
      { id: 3, x: 'c' },
      { id: 1, x: 'a' },
      { id: 2, x: 'b' },
    ];
    (qr as any).sortRowsByOrderBy(rows, 'id ASC');
    expect(rows.map((r: any) => r.id)).toEqual([1, 2, 3]);

    const rowsDesc = [
      { id: 1, x: 'a' },
      { id: 3, x: 'c' },
      { id: 2, x: 'b' },
    ];
    (qr as any).sortRowsByOrderBy(rowsDesc, 'id DESC');
    expect(rowsDesc.map((r: any) => r.id)).toEqual([3, 2, 1]);
  });
});
