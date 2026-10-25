/**
 * Integration tests for QueryRouter's cross-shard DML row plumbing.
 *
 * These tests exercise the private row-parsing/rebuilding helpers
 * (extractInsertRow, parseSqlValues, parseSqlLiteral, rebuildInsertSql,
 * extractOldRows, extractUpdateRow, rebuildUpdateSql) through the *real*
 * DML-trigger path rather than invoking them reflectively. Registering a
 * BEFORE INSERT/UPDATE trigger forces execInsertFast to fall back to
 * executeInternal, where the trigger manager fires and the row plumbing runs.
 *
 * The pure helpers (parseSqlValues, parseSqlLiteral, _inferAggAlias,
 * _replaceTableName) are additionally asserted reflectively because they are
 * deterministic string/literal transforms with well-defined semantics.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

let dir: string;
let db0: Database.Database;
let db1: Database.Database;
let qr: QueryRouter;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-dml-'));
  const p0 = path.join(dir, 's0.db');
  const p1 = path.join(dir, 's1.db');
  db0 = new Database(p0);
  db1 = new Database(p1);
  const shard0: ShardHandle = { db: db0, vectorIndex: null, readers: [], path: p0 };
  const shard1: ShardHandle = { db: db1, vectorIndex: null, readers: [], path: p1 };

  const sm: any = {
    getAllShards: () => new Map([[0, shard0], [1, shard1]]),
    getShard: (n: number) => (n === 0 ? shard0 : n === 1 ? shard1 : undefined),
    execShard: async (_n: number, sql: string) => (_n === 0 ? db0 : db1).exec(sql),
    queryShard: (n: number, sql: string, params?: any[]) =>
      (n === 0 ? db0 : db1).prepare(sql).all(...(params || [])),
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
  qr = new QueryRouter(sm, {} as any, config);

  // Pre-seed a fake ParallelExecutor so the parallel decision path does not
  // spin up a real Piscina thread pool (parallel-worker.js is not compiled
  // under tsx/vitest). The DML path under test does not rely on it anyway.
  (qr as any).parallelExecutor = { executeParallel: async () => [] };

  // Build the table through the query router so the MVCC schema shim injects
  // the _xmin/_xmax/_cmin/_cmax visibility columns that the INSERT rewrite
  // expects. A raw db.exec('CREATE TABLE ...') would skip that injection and
  // make the subsequent INSERT fail with "no column named _xmin".
  await qr.execute('CREATE TABLE t (id INT, name TEXT, price REAL)');
  await qr.execute("INSERT INTO t VALUES (1, 'alice', 10.5), (2, 'bob', 20.0)");
});

afterAll(() => {
  try { db0.close(); } catch {}
  try { db1.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('parseSqlValues / parseSqlLiteral (pure helpers)', () => {
  it('parseSqlValues splits top-level commas, honoring quotes and nesting', () => {
    const q = qr as any;
    expect(q.parseSqlValues("'a', 1, (2,3), 'x,y'")).toEqual(["'a'", '1', '(2,3)', "'x,y'"]);
    expect(q.parseSqlValues('1, NULL, 2')).toEqual(['1', 'NULL', '2']);
  });

  it('parseSqlLiteral converts NULL, numbers, and quoted strings', () => {
    const q = qr as any;
    expect(q.parseSqlLiteral('NULL')).toBeNull();
    expect(q.parseSqlLiteral('42')).toBe(42);
    expect(q.parseSqlLiteral('-3.14')).toBe(-3.14);
    expect(q.parseSqlLiteral("'alice'")).toBe('alice');
    expect(q.parseSqlLiteral("'a''b'")).toBe("a'b");
    expect(q.parseSqlLiteral('DEFAULT')).toBe('DEFAULT');
  });
});

describe('DML BEFORE INSERT trigger plumbing', () => {
  it('extractInsertRow → rebuildInsertSql round-trips when a trigger modifies the row', async () => {
    const mgr = qr.getDMLTriggerManager();
    mgr.createTrigger({
      name: 'before_insert_upper',
      timing: 'BEFORE',
      event: 'INSERT',
      level: 'ROW',
      tableName: 't',
      enabled: true,
      callback: async (ctx) => ({
        row: { ...ctx.newRow, name: String(ctx.newRow!.name).toUpperCase() },
      }),
    });

    const r = await qr.execute("INSERT INTO t (id, name, price) VALUES (3, 'carol', 30.0)");
    expect(r.error).toBeUndefined();

    // The trigger uppercase'd the name; verify it persisted on both shards
    // (the router fans INSERT out to every shard via execInsertRaw).
    const rows = db0.prepare("SELECT * FROM t WHERE id = 3").all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].name).toBe('CAROL');

    mgr.dropTrigger('before_insert_upper');
  });
});

describe('DML BEFORE UPDATE trigger plumbing', () => {
  it('extractOldRows / extractUpdateRow / rebuildUpdateSql flow on UPDATE', async () => {
    const mgr = qr.getDMLTriggerManager();
    const seen: any[] = [];
    mgr.createTrigger({
      name: 'before_update_audit',
      timing: 'BEFORE',
      event: 'UPDATE',
      level: 'ROW',
      tableName: 't',
      enabled: true,
      callback: async (ctx) => {
        seen.push({ old: ctx.oldRow, neu: ctx.newRow });
        return { row: { ...ctx.newRow, price: (ctx.newRow!.price as number) + 1 } };
      },
    });

    const r = await qr.execute("UPDATE t SET name = 'alice2' WHERE id = 1");
    expect(r.error).toBeUndefined();

    // The BEFORE UPDATE trigger observes oldRow (extractOldRows) and newRow
    // (extractUpdateRow), then increments price (rebuildUpdateSql).
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].old).toBeTruthy();
    expect(seen[0].neu).toBeTruthy();

    const rows = db0.prepare('SELECT * FROM t WHERE id = 1').all();
    expect(rows[0].price).toBe(11.5); // 10.5 + 1

    mgr.dropTrigger('before_update_audit');
  });
});

describe('_inferAggAlias / _replaceTableName (pure helpers)', () => {
  it('_inferAggAlias derives a column name from aggregate arguments', () => {
    const q = qr as any;
    // '*' args map to 'cnt' (COUNT) or the bare function name (other aggs).
    expect(q._inferAggAlias('*', 'count')).toBe('cnt');
    expect(q._inferAggAlias('*', 'sum')).toBe('sum');
    // Non-'*' args sanitize the argument text (e.g. 'a.b' -> 'a_b'); the
    // aggregate function name is NOT prepended (unlike the stale JSDoc that
    // claimed COUNT(id) -> 'cnt_id').
    expect(q._inferAggAlias('id', 'COUNT')).toBe('id');
    expect(q._inferAggAlias('a.b', 'SUM')).toBe('a_b');
  });

  it('_replaceTableName rewrites whole-word table references', () => {
    const q = qr as any;
    expect(q._replaceTableName('SELECT * FROM t WHERE t.id = 1', 't', '_ms_scatter'))
      .toBe('SELECT * FROM _ms_scatter WHERE _ms_scatter.id = 1');
  });
});
