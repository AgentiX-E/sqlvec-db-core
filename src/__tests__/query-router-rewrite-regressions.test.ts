/**
 * Regression tests for PG→SQLite rewrite defects surfaced by end-to-end
 * execution through QueryRouter.execute(). Each defect produced a SQLite
 * syntax error (`unrecognized token`, `near "X"`) because a shim rewrote the
 * statement into an invalid form, or because the SELECT fast path forwarded
 * PG-only syntax verbatim. These tests assert the rewritten SQL actually
 * executes, not merely that execute() settles.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';
import { rewriteLateral } from '../query/LateralJoinRewriter';

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
    queryShard: (_n: number, sql: string, params?: any[]) => db.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => exec(sql),
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => exec(sqls.join(';')),
    execBatchOnShard: async (_n: number, sqls: string[]) => exec(sqls.join(';')),
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

describe('PG→SQLite rewrite regressions (execute() end-to-end)', () => {
  it('rewrites `col @> ARRAY[...]` before the ARRAY constructor (no stray @ token)', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, col TEXT)');
    // `@>` must become intarray_contains BEFORE ARRAY[1] becomes json_array(1);
    // otherwise the `@>` token leaks to SQLite. The bare shard has no intarray
    // UDF, so the failure here must be `no such function`, never `unrecognized
    // token: @`.
    const p = qr.execute('SELECT col @> ARRAY[1] FROM t').then(
      (r) => ({ ok: true, rows: r.rows }),
      (e: any) => ({ ok: false, msg: e.message }),
    );
    const res = await p;
    if (res.ok) {
      expect(Array.isArray(res.rows)).toBe(true);
    } else {
      expect(res.msg).not.toMatch(/unrecognized token/i);
    }
  });

  it('executes GROUPING SETS through the SELECT fast path', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (a INTEGER, b INTEGER)');
    await expect(qr.execute('SELECT a, b FROM t GROUP BY GROUPING SETS ((a), (b))')).resolves.toBeTruthy();
  });

  it('executes JSON_TABLE COLUMNS through the SELECT fast path', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute(
      "SELECT * FROM json_table('[1]', '$[*]' COLUMNS (a int PATH '$')) AS jt",
    );
    expect(r.rows).toEqual([{ a: 1 }]);
  });

  it('executes a pg_hint_plan hint comment without injection-guard rejection', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (id INTEGER)');
    await expect(qr.execute('SELECT /*+ SeqScan(t) */ * FROM t')).resolves.toBeTruthy();
  });

  it('still blocks genuine `/*` comment truncation injection', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE accounts (id INTEGER)');
    await expect(qr.execute('SELECT * FROM accounts WHERE id = 1 /* OR 1=1 --')).rejects.toThrow();
  });
});

describe('LateralJoinRewriter — bare FROM LATERAL (unit)', () => {
  it('drops LATERAL and preserves FROM (no missing-FROM syntax)', () => {
    expect(rewriteLateral('SELECT * FROM LATERAL (SELECT 1) AS t', { forceRewrite: true })).toEqual({
      sql: 'SELECT * FROM (SELECT 1) AS t',
      rewritten: true,
    });
  });

  it('keeps comma-separated LATERAL as CROSS JOIN', () => {
    expect(rewriteLateral('SELECT * FROM a, LATERAL (SELECT 1) AS t', { forceRewrite: true })).toEqual({
      sql: 'SELECT * FROM a CROSS JOIN (SELECT 1) AS t',
      rewritten: true,
    });
  });
});
