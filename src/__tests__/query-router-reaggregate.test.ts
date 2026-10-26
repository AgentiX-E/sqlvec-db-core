/**
 * Re-aggregation SQL builder tests for QueryRouter.
 *
 * `_buildReaggregateSql` is the pure transform that turns a per-shard partial
 * aggregate query into the final cross-shard re-aggregation SQL. When a
 * `GROUP BY` query spans multiple shards, each shard first computes its local
 * aggregate (COUNT/SUM/MIN/MAX/AVG) into a `_ms_scatter` temp table, and this
 * builder then composes the merge query that combines those partial results.
 *
 * The mapping is well-defined and deterministic, so it is asserted directly:
 *   COUNT/SUM → SUM(alias)   (sum of partial sums = total)
 *   MIN       → MIN(alias)
 *   MAX       → MAX(alias)
 *   AVG       → weighted AVG via SUM(alias * cnt) / SUM(cnt), or plain
 *               AVG(alias) when no count column is present
 *
 * `_splitTopLevelCommas` (the SELECT-expression splitter that skips commas
 * inside function parentheses) is also covered as it is a dependency of the
 * builder and was previously unreached.
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
let qr: any;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-reagg-'));
  const p0 = path.join(dir, 's0.db');
  db0 = new Database(p0);
  const shard0 = { db: db0, vectorIndex: null, readers: [], path: p0 };
  const sm: any = {
    getAllShards: () => new Map([[0, shard0]]),
    getShard: (n: number) => shard0,
    execShard: async (_n: number, sql: string) => db0.exec(sql),
    queryShard: (_n: number, sql: string, params?: any[]) => db0.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => { db0.exec(sql); },
    queryAll: async () => [],
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

describe('_buildReaggregateSql (pure transform)', () => {
  it('re-aggregates COUNT and SUM across partial results', () => {
    const sql = 'SELECT category, COUNT(*) AS cnt, SUM(price) AS total FROM t GROUP BY category';
    const out = qr._buildReaggregateSql(sql, ['category', 'cnt', 'total'], 't');
    expect(out).toContain('SUM("cnt")');
    expect(out).toContain('SUM("total")');
    expect(out).toContain('FROM _ms_scatter');
    expect(out).toContain('GROUP BY _ms_scatter.category');
  });

  it('re-aggregates MIN and MAX into global extremes', () => {
    const sql = 'SELECT MIN(price) AS lo, MAX(price) AS hi FROM t';
    const out = qr._buildReaggregateSql(sql, ['lo', 'hi'], 't');
    expect(out).toContain('MIN("lo")');
    expect(out).toContain('MAX("hi")');
  });

  it('re-aggregates AVG as a weighted average when a count column exists', () => {
    const sql = 'SELECT category, AVG(price) AS avgp, COUNT(*) AS cnt FROM t GROUP BY category';
    const out = qr._buildReaggregateSql(sql, ['category', 'avgp', 'cnt'], 't');
    // weighted average uses the cnt column
    expect(out).toContain('SUM("avgp" * "cnt") / SUM("cnt")');
  });

  it('falls back to plain AVG when no count column is present', () => {
    const sql = 'SELECT AVG(price) AS avgp FROM t';
    const out = qr._buildReaggregateSql(sql, ['avgp'], 't');
    expect(out).toContain('AVG("avgp")');
    expect(out).not.toContain('* "cnt"');
  });

  it('carries GROUP BY / ORDER BY / LIMIT / HAVING clauses through', () => {
    const sql = 'SELECT category, COUNT(*) FROM t GROUP BY category HAVING COUNT(*) > 1 ORDER BY category LIMIT 5';
    const out = qr._buildReaggregateSql(sql, ['category', 'cnt'], 't');
    expect(out).toContain('GROUP BY _ms_scatter.category');
    expect(out).toContain('HAVING');
    expect(out).toContain('ORDER BY');
    expect(out).toContain('LIMIT 5');
  });

  it('falls back to table-name replacement when there is no SELECT clause', () => {
    // No `SELECT ... FROM` match → the SQL is returned with the table name
    // replaced (only occurrences of the table name are rewritten).
    const out = qr._buildReaggregateSql('UPDATE t SET x = 1', ['a'], 't');
    expect(out).toContain('_ms_scatter');
    expect(out).toContain('UPDATE _ms_scatter SET x = 1');
  });
});

describe('_splitTopLevelCommas (subquery/nesting)', () => {
  it('splits only on top-level commas, skipping function parentheses', () => {
    const out = qr._splitTopLevelCommas('a, CONCAT(b, c), SUM(x, y)');
    expect(out).toEqual(['a', ' CONCAT(b, c)', ' SUM(x, y)']);
    const nested = qr._splitTopLevelCommas("FUNC(1, 2), 3");
    expect(nested).toEqual(['FUNC(1, 2)', ' 3']);
  });
});
