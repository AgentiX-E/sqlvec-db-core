/**
 * End-to-end coverage for the vector search execution path in QueryRouter.
 *
 * Exercises executeVectorQuery together with its helpers (extractVectorParams,
 * buildSqlQuery, extractTableNamesHeuristic) through a real VectorEngine backed
 * by the INDEXED mode and a stubbed vectorSearchAll shard, verifying both the
 * VEC_SEARCH(...) and ORDER BY VECTOR_DISTANCE(...) SQL syntaxes produce a
 * vector_indexed/vector_bruteforce result carrying distance + metadata.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { VectorEngine } from '../vector/VectorEngine';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

let qr: QueryRouter;
let db: Database.Database;
let dataDir: string;

beforeAll(() => {
  db = new Database(':memory:');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-vec-'));
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
    vectorSearchAll: async () => [{ id: 7, distance: 0.1, shardId: 0 }],
  };
  const config: any = {
    enabled: true,
    dimension: 4,
    metric: VectorMetric.COSINE,
    mode: VectorMode.INDEXED,
    bruteForceThreshold: 1000,
    indexType: VectorIndexType.FLAT,
    indexParams: {},
  };
  const engine = new VectorEngine(sm as any, config, dataDir, { strictDimensionCheck: false });
  qr = new QueryRouter(sm, engine as any, config);
});

afterAll(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

describe('vector search execution (executeVectorQuery)', () => {
  it('routes VEC_SEARCH(...) through the vector engine and returns results', async () => {
    const embedding = new Float32Array([1, 2, 3, 4]);
    const r = await qr.execute("SELECT * FROM items WHERE vec_match VEC_SEARCH('items', ?, 5)", [embedding]);

    expect(r.rows).toEqual([{ id: 7, distance: 0.1, metadata: { shardId: 0 } }]);
    expect(r.rowCount).toBe(1);
    expect(r.engine).toBe('vector_indexed');
  });

  it('routes ORDER BY VECTOR_DISTANCE(...) through the vector engine', async () => {
    const embedding = new Float32Array([1, 2, 3, 4]);
    const r = await qr.execute('SELECT * FROM items ORDER BY VECTOR_DISTANCE(embedding, ?) LIMIT 3', [embedding]);

    expect(r.rows).toEqual([{ id: 7, distance: 0.1, metadata: { shardId: 0 } }]);
    expect(r.engine).toBe('vector_indexed');
  });
});
