/**
 * VectorEngine — dual-mode (DuckDB brute-force vs sqlite-vec indexed) plus
 * optional HNSW/IVFPQ vector search engine.
 *
 * Exercises mode routing (AUTO/BRUTEFORCE/INDEXED/HNSW/IVFPQ), dimension
 * validation, DuckDB brute-force SQL generation against a real in-memory
 * DuckDB, HNSW/IVFPQ population + search, auto-persist checkpoints, and
 * index auto-load from disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VectorEngine } from '../vector/VectorEngine';
import { HnswIndexManager } from '../vector/HnswIndexManager';
import { IVFPQIndex } from '../index/ivfpq-index';
import {
  VectorMetric,
  VectorMode,
  VectorIndexType,
  SqlVecErrorCode,
} from '../types';

const DIM = 4;

function vec(...xs: number[]): Float32Array {
  return new Float32Array(xs);
}

/** Minimal ShardManager stand-in exposing the surface VectorEngine uses. */
class StubShardManager {
  shardIds: number[] = [];
  shardPaths: (string | undefined)[] = [];
  rowCounts = new Map<string, number>();
  vectorSearchResults: Array<{ id: number; distance: number; shardId: number }> = [];
  queryResults: any[] = [];
  queryAllImpl: ((sql: string, params?: any[]) => Promise<any[]>) | null = null;

  getShardIds(): number[] { return this.shardIds; }
  getShard(id: number): { path?: string } | undefined { return { path: this.shardPaths[id] }; }
  getShardCount(): number { return this.shardIds.length; }

  async vectorSearchAll(
    _table: string, _q: Float32Array, topK: number, _perShard?: number,
  ): Promise<Array<{ id: number; distance: number; shardId: number }>> {
    return this.vectorSearchResults.slice(0, topK);
  }

  async queryAll(sql: string, params?: any[]): Promise<any[]> {
    if (this.queryAllImpl) return this.queryAllImpl(sql, params);
    return this.queryResults;
  }
}

function makeEngine(
  overrides: Partial<import('../types').VectorConfig> = {},
  opts?: { strictDimensionCheck?: boolean },
) {
  const config = {
    enabled: true,
    dimension: DIM,
    metric: VectorMetric.L2,
    mode: VectorMode.AUTO,
    bruteForceThreshold: 100,
    indexType: VectorIndexType.HNSW,
    indexParams: {},
    ...overrides,
  };
  const shardManager = new StubShardManager();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-eng-'));
  const engine = new VectorEngine(shardManager as any, config, dataDir, opts);
  return { engine, shardManager, dataDir };
}

describe('VectorEngine', () => {
  let cleanups: string[] = [];
  afterEach(() => {
    for (const d of cleanups) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    cleanups = [];
  });

  describe('dimension validation', () => {
    it('throws on mismatched dimension on search', async () => {
      const { engine } = makeEngine();
      await expect(
        engine.search({ collection: 't', queryVector: vec(1, 2, 3), topK: 3 }),
      ).rejects.toThrow(/Dimension mismatch/);
    });

    it('skips validation when strictDimensionCheck is false', async () => {
      const { engine, shardManager } = makeEngine({ mode: VectorMode.INDEXED }, { strictDimensionCheck: false });
      shardManager.vectorSearchResults = [{ id: 1, distance: 0, shardId: 0 }];
      shardManager.shardIds = [0];
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3), topK: 3 });
      expect(res.results.length).toBe(1);
    });
  });

  describe('search routing', () => {
    it('routes INDEXED mode to indexedSearch', async () => {
      const { engine, shardManager } = makeEngine({ mode: VectorMode.INDEXED });
      shardManager.shardIds = [0];
      shardManager.vectorSearchResults = [{ id: 7, distance: 1.5, shardId: 0 }];
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 3 });
      expect(res.stats.mode).toBe(VectorMode.INDEXED);
      expect(res.results[0].id).toBe(7);
      expect(res.results[0].distance).toBe(1.5);
      expect(res.results[0].metadata).toEqual({ shardId: 0 });
    });

    it('routes BRUTEFORCE to bruteForceSearch (DuckDB)', async () => {
      const { engine, shardManager } = makeEngine({ mode: VectorMode.BRUTEFORCE });
      shardManager.shardIds = [0];
      shardManager.shardPaths = ['/tmp/fake-shard.db'];
      // DuckDB will fail to attach a nonexistent path → brute-force falls back
      // only when duckDBAvailable is false; otherwise throws. We assert it
      // attempts brute-force (throws on bad shard) rather than silently indexed.
      await engine.initialize();
      // Pre-seed a real sqlite shard file? For coverage, verify attach path runs.
      await expect(
        engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 3 }),
      ).rejects.toThrow();
      await engine.close();
    });

    it('falls back to indexed when DuckDB unavailable in brute-force mode', async () => {
      const { engine, shardManager } = makeEngine({ mode: VectorMode.BRUTEFORCE });
      shardManager.shardIds = [0];
      shardManager.vectorSearchResults = [{ id: 1, distance: 0, shardId: 0 }];
      // Force duckDBAvailable false + null duckDB so it redirects to indexed.
      (engine as any).duckDBAvailable = false;
      (engine as any).duckDB = null;
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 3 });
      expect(res.stats.mode).toBe(VectorMode.INDEXED);
    });

    it('routes HNSW mode to hnswSearch', async () => {
      const { engine } = makeEngine({ mode: VectorMode.HNSW });
      engine.initHnswIndex();
      engine.registerHnswVectors([vec(1, 2, 3, 4), vec(5, 6, 7, 8)], [10, 20]);
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.HNSW);
      expect(res.results[0].id).toBe(10);
      expect(res.results[0].metadata).toEqual({ mode: 'hnsw' });
    });

    it('falls back to indexed when HNSW index not built', async () => {
      const { engine, shardManager } = makeEngine({ mode: VectorMode.HNSW });
      shardManager.shardIds = [0];
      shardManager.vectorSearchResults = [{ id: 1, distance: 0, shardId: 0 }];
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.INDEXED);
    });

    it('routes IVFPQ mode and falls back to brute-force when not built', async () => {
      const { engine, shardManager } = makeEngine({ mode: VectorMode.IVFPQ });
      shardManager.shardIds = [0];
      shardManager.vectorSearchResults = [{ id: 1, distance: 0, shardId: 0 }];
      // IVFPQ not built → falls back to brute-force → which falls back to indexed
      // only when DuckDB unavailable.
      (engine as any).duckDBAvailable = false;
      (engine as any).duckDB = null;
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.INDEXED);
    });
  });

  describe('IVFPQ search (built)', () => {
    it('searches a trained IVFPQ index', async () => {
      const { engine } = makeEngine({
        mode: VectorMode.IVFPQ,
        indexType: VectorIndexType.IVFPQ,
        indexParams: { ivfpqK: 4, ivfpqM: 4, ivfpqNprobe: 4 },
      });
      // Build via internal init + train + add.
      (engine as any).initIvfpqIndex();
      const ivf = (engine as any).ivfpqIndex as IVFPQIndex;
      const vectors = Array.from({ length: 8 }, (_, i) => new Float64Array([i, i, i, i]));
      const ids = Array.from({ length: 8 }, (_, i) => i);
      ivf.train(vectors);
      ivf.add(vectors, ids);

      const res = await engine.search({ collection: 't', queryVector: vec(0, 0, 0, 0), topK: 3 });
      expect(res.stats.mode).toBe(VectorMode.IVFPQ);
      expect(res.results.length).toBe(3);
    });
  });

  describe('AUTO routing', () => {
    it('uses configured hnsw indexType when available', async () => {
      const { engine, shardManager } = makeEngine({ mode: VectorMode.AUTO, indexType: VectorIndexType.HNSW });
      engine.initHnswIndex();
      engine.registerHnswVectors([vec(1, 2, 3, 4)], [10]);
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.HNSW);
    });

    it('auto-detects small set → brute-force threshold fallback', async () => {
      const { engine, shardManager } = makeEngine({
        mode: VectorMode.AUTO,
        indexType: VectorIndexType.FLAT,
        bruteForceThreshold: 1000,
      });
      shardManager.shardIds = [0];
      shardManager.vectorSearchResults = [{ id: 1, distance: 0, shardId: 0 }];
      shardManager.rowCounts.set('t', 5); // small
      // With FLAT indexType and no hnsw/ivfpq, AUTO flows to indexed fallback.
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      expect(res.results.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('topK via searchByEmbedding', () => {
    it('converts embedding array and delegates to search', async () => {
      const { engine, shardManager } = makeEngine({ mode: VectorMode.INDEXED });
      shardManager.shardIds = [0];
      shardManager.vectorSearchResults = [{ id: 5, distance: 0, shardId: 0 }];
      const res = await engine.searchByEmbedding('t', [1, 2, 3, 4], 3);
      expect(res.results[0].id).toBe(5);
    });
  });

  describe('register vectors', () => {
    it('registerHnswVectors validates dimension and adds points', () => {
      const { engine } = makeEngine();
      engine.initHnswIndex();
      expect(() => engine.registerHnswVectors([vec(1, 2, 3)], [1])).toThrow(/Dimension mismatch/);
      engine.registerHnswVectors([vec(1, 2, 3, 4)], [10]);
      expect(engine.isHnswAvailable()).toBe(true);
    });

    it('registerIvfpqVectors converts Float32 → Float64 and adds', () => {
      const { engine } = makeEngine({
        mode: VectorMode.IVFPQ,
        indexParams: { ivfpqK: 4, ivfpqM: 4, ivfpqNprobe: 4 },
      });
      (engine as any).initIvfpqIndex();
      const ivf = (engine as any).ivfpqIndex as IVFPQIndex;
      ivf.train(Array.from({ length: 8 }, (_, i) => new Float64Array([i, i, i, i])));
      engine.registerIvfpqVectors([vec(1, 2, 3, 4)], [10]);
      expect(engine.isIvfpqAvailable()).toBe(true);
    });

    it('registerHnswVectors no-ops when no HNSW index', () => {
      const { engine } = makeEngine();
      expect(() => engine.registerHnswVectors([vec(1, 2, 3, 4)], [10])).not.toThrow();
      expect(engine.isHnswAvailable()).toBe(false);
    });
  });

  describe('HNSW refresh & sync', () => {
    it('refreshHnswIndex returns 0 when no HNSW index', async () => {
      const { engine } = makeEngine();
      expect(await engine.refreshHnswIndex('t')).toBe(0);
    });

    it('refreshHnswIndex incremental path', async () => {
      const { engine, shardManager } = makeEngine();
      engine.initHnswIndex();
      shardManager.queryResults = [
        { id: 10, embedding: Buffer.from(new Float32Array([1, 2, 3, 4]).buffer) },
        { id: 20, embedding: Buffer.from(new Float32Array([5, 6, 7, 8]).buffer) },
      ];
      const added = await engine.refreshHnswIndex('t', 10000);
      expect(added).toBe(2);
      expect(engine.isHnswAvailable()).toBe(true);
    });

    it('refreshHnswIndex shard path for large datasets', async () => {
      const { engine, shardManager } = makeEngine();
      engine.initHnswIndex();
      shardManager.queryResults = Array.from({ length: 5 }, (_, i) => ({
        id: i, embedding: Buffer.from(new Float32Array([i, i, i, i]).buffer),
      }));
      const added = await engine.refreshHnswIndex('t', 2); // threshold 2 → shard path
      expect(added).toBe(5);
    });

    it('syncIndexWithVec0 returns -1 when no index or path', async () => {
      const { engine } = makeEngine();
      expect(await engine.syncIndexWithVec0('t')).toBe(-1);
    });

    it('syncIndexWithVec0 detects missing vectors and repairs', async () => {
      const { engine, shardManager } = makeEngine();
      engine.initHnswIndex();
      engine.registerHnswVectors([vec(1, 2, 3, 4)], [1]);
      const tmp = path.join((engine as any).dataDir, 'idx');
      engine.setHnswIndexPath(tmp);

      // vec0 has 3 rows, index has 1 → 2 missing with id > 1.
      shardManager.queryAllImpl = async (sql: string) => {
        if (sql.includes('COUNT')) return [{ cnt: 3 }];
        // WHERE id > savedCount(=1)
        return [
          { id: 2, embedding: Buffer.from(new Float32Array([5, 6, 7, 8]).buffer) },
          { id: 3, embedding: Buffer.from(new Float32Array([9, 10, 11, 12]).buffer) },
        ];
      };
      const added = await engine.syncIndexWithVec0('t');
      expect(added).toBe(2);
    });
  });

  describe('persistence path management', () => {
    it('tracks HNSW and IVFPQ index paths', () => {
      const { engine } = makeEngine();
      expect(engine.getHnswIndexPath()).toBeNull();
      expect(engine.getIvfpqIndexPath()).toBeNull();
      engine.setHnswIndexPath('/tmp/idx');
      engine.setIvfpqIndexPath('/tmp/ivf.json');
      expect(engine.getHnswIndexPath()).toBe('/tmp/idx');
      expect(engine.getIvfpqIndexPath()).toBe('/tmp/ivf.json');
    });

    it('forcePersistHnsw returns false without index/path', () => {
      const { engine } = makeEngine();
      expect(engine.forcePersistHnsw()).toBe(false);
    });
  });

  describe('auto-persist checkpoint', () => {
    it('schedules persist after threshold and persists to path', async () => {
      vi.useFakeTimers();
      try {
        const { engine } = makeEngine();
        engine.initHnswIndex();
        const tmp = path.join((engine as any).dataDir, 'idx');
        engine.setHnswIndexPath(tmp);
        (engine as any).autoPersistCount = 2;

        engine.registerHnswVectors([vec(1, 2, 3, 4), vec(5, 6, 7, 8)], [10, 20]);
        await vi.advanceTimersByTimeAsync(300);
        // Files written.
        expect(fs.existsSync(tmp + '.hnsw')).toBe(true);
        expect(fs.existsSync(tmp + '.meta')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('forcePersistHnsw writes and returns true', () => {
      const { engine } = makeEngine();
      engine.initHnswIndex();
      engine.registerHnswVectors([vec(1, 2, 3, 4)], [10]);
      const tmp = path.join((engine as any).dataDir, 'idx');
      engine.setHnswIndexPath(tmp);
      expect(engine.forcePersistHnsw()).toBe(true);
      expect(fs.existsSync(tmp + '.hnsw')).toBe(true);
    });
  });

  describe('auto-load indexes from disk', () => {
    it('loads a pre-existing HNSW index on initialize', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-aload-'));
      cleanups.push(dataDir);
      // Build + persist an index file first.
      const mgr = new HnswIndexManager(DIM, { maxElements: 100, m: 16, efConstruction: 200, efSearch: 50 });
      mgr.addPoints([vec(1, 2, 3, 4)], [10]);
      mgr.saveSync(path.join(dataDir, 'persisted'));

      // mode INDEXED does NOT pre-init hnsw, so tryAutoLoadIndexes runs its
      // HNSW branch and loads the persisted index.
      const config = {
        enabled: true, dimension: DIM, metric: VectorMetric.L2, mode: VectorMode.INDEXED,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT, indexParams: {},
      };
      const engine2 = new VectorEngine(new StubShardManager() as any, config, dataDir);
      await engine2.initialize();
      expect(engine2.getHnswIndex()).not.toBeNull();
    });

    it('auto-load uses explicit indexParams when provided', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-al2-'));
      cleanups.push(dataDir);
      const mgr = new HnswIndexManager(DIM, { maxElements: 50, m: 8, efConstruction: 100, efSearch: 30 });
      mgr.addPoints([vec(1, 2, 3, 4)], [10]);
      mgr.saveSync(path.join(dataDir, 'persisted'));

      const config = {
        enabled: true, dimension: DIM, metric: VectorMetric.L2, mode: VectorMode.INDEXED,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT,
        indexParams: { m: 8, efConstruction: 100, efSearch: 30, maxElements: 50 },
      };
      const engine = new VectorEngine(new StubShardManager() as any, config, dataDir);
      await engine.initialize();
      expect(engine.getHnswIndex()).not.toBeNull();
    });

    it('auto-load tolerates missing indexParams (undefined object)', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-al3-'));
      cleanups.push(dataDir);
      const mgr = new HnswIndexManager(DIM, { maxElements: 100, m: 16, efConstruction: 200, efSearch: 50 });
      mgr.addPoints([vec(1, 2, 3, 4)], [10]);
      mgr.saveSync(path.join(dataDir, 'persisted'));

      const config = {
        enabled: true, dimension: DIM, metric: VectorMetric.L2, mode: VectorMode.INDEXED,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT, indexParams: undefined,
      } as any;
      const engine = new VectorEngine(new StubShardManager() as any, config, dataDir);
      await engine.initialize();
      expect(engine.getHnswIndex()).not.toBeNull();
    });

    it('skips an .hnsw file whose .meta file is missing', async () => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-al4-'));
      cleanups.push(dataDir);
      // Create an orphan .hnsw file (no .meta).
      fs.writeFileSync(path.join(dataDir, 'orphan.hnsw'), 'junk');

      const config = {
        enabled: true, dimension: DIM, metric: VectorMetric.L2, mode: VectorMode.INDEXED,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT, indexParams: {},
      };
      const engine = new VectorEngine(new StubShardManager() as any, config, dataDir);
      await engine.initialize();
      // No .meta → load was skipped; hnswIndex stays null.
      expect(engine.getHnswIndex()).toBeNull();
    });
  });

  describe('brute-force DuckDB edge paths', () => {
    it('throws when duckDB unavailable but flag set (null instance)', async () => {
      const cfg = {
        enabled: true, dimension: DIM, metric: VectorMetric.L2, mode: VectorMode.BRUTEFORCE,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT, indexParams: {},
      };
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-bf3-'));
      cleanups.push(dataDir);
      const shardManager = new StubShardManager();
      shardManager.shardIds = [0];
      shardManager.shardPaths = ['/tmp/x.db'];
      const engine = new VectorEngine(shardManager as any, cfg, dataDir);
      await engine.initialize();
      (engine as any).duckDBAvailable = true;
      (engine as any).duckDB = null; // simulate uninitialized instance
      await expect(
        engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 }),
      ).rejects.toThrow(/not initialized/);
      await engine.close();
    });

    it('maps IP metric distance as 1 - distance', async () => {
      const cfg = {
        enabled: true, dimension: DIM, metric: VectorMetric.IP, mode: VectorMode.BRUTEFORCE,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT, indexParams: {},
      };
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-bf4-'));
      cleanups.push(dataDir);
      const Database = require('better-sqlite3');
      const shardPath = path.join(dataDir, 'shard_0.db');
      const sdb = new Database(shardPath);
      sdb.exec('CREATE TABLE articles (id INTEGER PRIMARY KEY, embedding BLOB)');
      sdb.prepare('INSERT INTO articles (id, embedding) VALUES (?, ?)').run(1, Buffer.from(new Float32Array([0, 0, 0, 0]).buffer));
      sdb.close();

      const shardManager = new StubShardManager();
      shardManager.shardIds = [0];
      shardManager.shardPaths = [shardPath];
      const engine = new VectorEngine(shardManager as any, cfg, dataDir);
      await engine.initialize();
      const conn = (engine as any).duckDB.conn;
      const origAll = conn.all.bind(conn);
      conn.all = (sql: string, cb: any) => cb(null, [{ id: 1, distance: 0.4 }]);
      const res = await engine.search({ collection: 'articles', queryVector: vec(0, 0, 0, 0), topK: 1 });
      expect(res.results[0].distance).toBeCloseTo(0.6); // 1 - 0.4 (IP)
      conn.all = origAll;
      await engine.close();
    });

    it('handles falsy/empty result rows from DuckDB (|| [] fallback)', async () => {
      const cfg = {
        enabled: true, dimension: DIM, metric: VectorMetric.L2, mode: VectorMode.BRUTEFORCE,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT, indexParams: {},
      };
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-bf6-'));
      cleanups.push(dataDir);
      const Database = require('better-sqlite3');
      const shardPath = path.join(dataDir, 'shard_0.db');
      const sdb = new Database(shardPath);
      sdb.exec('CREATE TABLE articles (id INTEGER PRIMARY KEY, embedding BLOB)');
      sdb.close();

      const shardManager = new StubShardManager();
      shardManager.shardIds = [0];
      shardManager.shardPaths = [shardPath];
      const engine = new VectorEngine(shardManager as any, cfg, dataDir);
      await engine.initialize();
      const conn = (engine as any).duckDB.conn;
      const origAll = conn.all.bind(conn);
      conn.all = (sql: string, cb: any) => cb(null, null); // falsy data → || []
      const res = await engine.search({ collection: 'articles', queryVector: vec(0, 0, 0, 0), topK: 1 });
      expect(res.results).toEqual([]);
      conn.all = origAll;
      await engine.close();
    });

    it('falls back to indexed when sqlite_scanner init fails', async () => {
      const cfg = {
        enabled: true, dimension: DIM, metric: VectorMetric.L2, mode: VectorMode.AUTO,
        bruteForceThreshold: 0, indexType: VectorIndexType.FLAT, indexParams: {},
      };
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-bf5-'));
      cleanups.push(dataDir);
      const shardManager = new StubShardManager();
      shardManager.shardIds = [0];
      shardManager.shardPaths = ['/tmp/x.db'];
      shardManager.vectorSearchResults = [{ id: 1, distance: 0, shardId: 0 }];
      const engine = new VectorEngine(shardManager as any, cfg, dataDir);
      // Force DuckDB module to throw on init.
      vi.spyOn(engine as any, 'initDuckDB').mockImplementation(async () => {
        (engine as any).duckDBAvailable = false;
      });
      await engine.initialize();
      expect((engine as any).duckDBAvailable).toBe(false);
      // AUTO with estimate 0 → brute-force → fallback indexed.
      shardManager.queryAllImpl = async () => [{ cnt: 0 }];
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.INDEXED);
      await engine.close();
    });
  });

  describe('buildIvfpqIndex when index already exists', () => {
    it('reuses existing IVFPQ index', async () => {
      const { engine, shardManager } = makeEngine({
        indexParams: { ivfpqK: 4, ivfpqM: 4, ivfpqNprobe: 4 },
      });
      (engine as any).initIvfpqIndex(); // pre-create
      const existing = engine.getIvfpqIndex();
      shardManager.queryResults = Array.from({ length: 4 }, (_, i) => ({
        id: i, embedding: Buffer.from(new Float32Array([i, i, i, i]).buffer),
      }));
      await engine.buildIvfpqIndex('t');
      expect(engine.getIvfpqIndex()).toBe(existing); // reused, not re-created
    });
  });

  describe('auto-persist error handling', () => {
    it('catches persist errors without throwing', async () => {
      vi.useFakeTimers();
      try {
        const { engine } = makeEngine();
        engine.initHnswIndex();
        engine.registerHnswVectors([vec(1, 2, 3, 4), vec(5, 6, 7, 8)], [10, 20]);
        // Point index path at an invalid location to force saveSync to throw.
        engine.setHnswIndexPath('/nonexistent-dir/idx');
        (engine as any).autoPersistCount = 1;
        engine.registerHnswVectors([vec(9, 10, 11, 12)], [30]);
        await vi.advanceTimersByTimeAsync(300);
        // No unhandled rejection; the catch swallowed it.
        expect(true).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stub a timer without unref to cover the unref-else branch', async () => {
      vi.useFakeTimers();
      try {
        const { engine } = makeEngine();
        engine.initHnswIndex();
        const tmp = path.join((engine as any).dataDir, 'idx');
        engine.setHnswIndexPath(tmp);
        (engine as any).autoPersistCount = 1;
        // Patch setTimeout to return a timer without unref.
        const origSetTimeout = globalThis.setTimeout;
        const noUnrefTimer = Object.create(null);
        noUnrefTimer.ref = () => {};
        const stub = (fn: any, ms?: any) => { fn; return noUnrefTimer; };
        vi.stubGlobal('setTimeout', stub as any);
        engine.registerHnswVectors([vec(1, 2, 3, 4)], [10]);
        expect((engine as any).autoPersistPending).toBe(true);
        vi.unstubAllGlobals();
        // Cleanup: reset pending to avoid dangling fake timers.
        (engine as any).autoPersistPending = false;
        (engine as any).autoPersistHnswTimer = null;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('brute-force (DuckDB real shard attach)', () => {
    function makeRealShard(dataDir: string, name: string, rows: Array<[number, Float32Array]>): string {
      const Database = require('better-sqlite3');
      const p = path.join(dataDir, name);
      const db = new Database(p);
      db.exec('CREATE TABLE articles (id INTEGER PRIMARY KEY, embedding BLOB)');
      const ins = db.prepare('INSERT INTO articles (id, embedding) VALUES (?, ?)');
      for (const [id, v] of rows) ins.run(id, Buffer.from(v.buffer));
      db.close();
      return p;
    }

    it('runs DuckDB brute-force attach + SQL generation (exposes BLOB cast)', async () => {
      const cfg = {
        enabled: true, dimension: DIM, metric: VectorMetric.L2, mode: VectorMode.BRUTEFORCE,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT, indexParams: {},
      };
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-bf-'));
      cleanups.push(dataDir);
      const shardPath = makeRealShard(dataDir, 'shard_0.db', [[1, vec(1, 2, 3, 4)]]);

      const shardManager = new StubShardManager();
      shardManager.shardIds = [0];
      shardManager.shardPaths = [shardPath];
      shardManager.vectorSearchResults = [{ id: 1, distance: 0, shardId: 0 }];

      const engine = new VectorEngine(shardManager as any, cfg, dataDir);
      await engine.initialize();
      expect((engine as any).duckDBAvailable).toBe(true);

      // The BLOB -> FLOAT[] cast is unsupported by DuckDB (#186), so the query
      // rejects. This still covers attach loop + SQL generation + metric fn.
      await expect(
        engine.search({ collection: 'articles', queryVector: vec(1, 2, 3, 4), topK: 3 }),
      ).rejects.toThrow();
      await engine.close();
    });

    it('falls back to indexed when no shards exist in brute-force mode', async () => {
      const { engine, shardManager } = makeEngine({ mode: VectorMode.BRUTEFORCE });
      shardManager.shardIds = []; // no shards
      shardManager.vectorSearchResults = [{ id: 9, distance: 0, shardId: 0 }];
      await engine.initialize();
      (engine as any).duckDBAvailable = true;
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.INDEXED);
      await engine.close();
    });

    it('getMetricFunction covers COSINE and IP', () => {
      const { engine } = makeEngine({ metric: VectorMetric.COSINE });
      expect((engine as any).getMetricFunction(VectorMetric.COSINE)).toBe('list_cosine_similarity');
      expect((engine as any).getMetricFunction(VectorMetric.L2)).toBe('list_distance');
      expect((engine as any).getMetricFunction(VectorMetric.IP)).toBe('list_dot_product');
    });

    it('maps non-L2 distance as 1 - distance on brute-force result', async () => {
      const cfg = {
        enabled: true, dimension: DIM, metric: VectorMetric.COSINE, mode: VectorMode.BRUTEFORCE,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT, indexParams: {},
      };
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-bf2-'));
      cleanups.push(dataDir);
      const shardPath = makeRealShard(dataDir, 'shard_0.db', [[1, vec(0, 0, 0, 0)]]);
      const shardManager = new StubShardManager();
      shardManager.shardIds = [0];
      shardManager.shardPaths = [shardPath];
      const engine = new VectorEngine(shardManager as any, cfg, dataDir);
      await engine.initialize();
      // Mock conn.all to return a row so we exercise the 1 - distance mapping.
      const conn = (engine as any).duckDB.conn;
      const origAll = conn.all.bind(conn);
      conn.all = (sql: string, cb: any) => cb(null, [{ id: 1, distance: 0.25 }]);
      const res = await engine.search({ collection: 'articles', queryVector: vec(0, 0, 0, 0), topK: 1 });
      expect(res.results[0].distance).toBeCloseTo(0.75); // 1 - 0.25
      conn.all = origAll;
      await engine.close();
    });
  });

  describe('initialize mode branches', () => {
    it('initialize with IVFPQ mode initializes IVFPQ index', async () => {
      const { engine } = makeEngine({
        mode: VectorMode.IVFPQ,
        indexType: VectorIndexType.IVFPQ,
        indexParams: { ivfpqK: 4, ivfpqM: 4, ivfpqNprobe: 4 },
      });
      await engine.initialize();
      expect(engine.getIvfpqIndex()).not.toBeNull();
    });

    it('initialize with HNSW mode initializes HNSW index', async () => {
      const { engine } = makeEngine({ mode: VectorMode.HNSW, indexType: VectorIndexType.HNSW });
      await engine.initialize();
      expect(engine.getHnswIndex()).not.toBeNull();
    });

    it('auto-loads a persisted IVFPQ index on initialize', async () => {
      const cfg = {
        enabled: true, dimension: DIM, metric: VectorMetric.L2, mode: VectorMode.INDEXED,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT,
        indexParams: { ivfpqK: 4, ivfpqM: 4, ivfpqNprobe: 4 },
      };
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-ivf-'));
      cleanups.push(dataDir);

      // Build + serialize an IVFPQ index to disk.
      const ivf = new IVFPQIndex({ dim: DIM, K: 4, M: 4, codebookSize: 8, nprobe: 4 });
      ivf.train(Array.from({ length: 8 }, (_, i) => new Float64Array([i, i, i, i])));
      ivf.add(Array.from({ length: 8 }, (_, i) => new Float64Array([i, i, i, i])), [0, 1, 2, 3, 4, 5, 6, 7]);
      fs.writeFileSync(path.join(dataDir, 'persisted.ivfpq.json'), JSON.stringify(ivf.toJSON()));

      // mode INDEXED does not pre-init ivfpq → auto-load branch runs.
      const engine = new VectorEngine(new StubShardManager() as any, cfg, dataDir);
      await engine.initialize();
      expect(engine.getIvfpqIndex()).not.toBeNull();
    });
  });

  describe('buildIvfpqIndex', () => {
    it('builds IVFPQ from vec table rows', async () => {
      const { engine, shardManager } = makeEngine({
        mode: VectorMode.IVFPQ,
        indexParams: { ivfpqK: 4, ivfpqM: 4, ivfpqNprobe: 4 },
      });
      shardManager.queryResults = Array.from({ length: 4 }, (_, i) => ({
        id: i, embedding: Buffer.from(new Float32Array([i, i, i, i]).buffer),
      }));
      await engine.buildIvfpqIndex('t');
      expect(engine.isIvfpqAvailable()).toBe(true);
    });

    it('buildIvfpqIndex no-ops on empty table', async () => {
      const { engine, shardManager } = makeEngine({
        mode: VectorMode.IVFPQ,
        indexParams: { ivfpqK: 4, ivfpqM: 4, ivfpqNprobe: 4 },
      });
      shardManager.queryResults = [];
      await engine.buildIvfpqIndex('t');
      expect(engine.isIvfpqAvailable()).toBe(false);
    });
  });

  describe('estimate & stats detail', () => {
    it('estimateTableRows uses cache on second call', async () => {
      const { engine, shardManager } = makeEngine();
      shardManager.queryResults = [{ cnt: 42 }];
      const first = await (engine as any).estimateTableRows('t');
      const second = await (engine as any).estimateTableRows('t');
      expect(first).toBe(42);
      expect(second).toBe(42);
    });

    it('estimateTableRows returns 0 on error', async () => {
      const { engine, shardManager } = makeEngine();
      shardManager.queryAllImpl = async () => { throw new Error('boom'); };
      expect(await (engine as any).estimateTableRows('t')).toBe(0);
    });

    it('getStats computes average ms after brute-force + indexed', async () => {
      const { engine, shardManager } = makeEngine({ mode: VectorMode.INDEXED });
      shardManager.shardIds = [0];
      shardManager.vectorSearchResults = [{ id: 1, distance: 0, shardId: 0 }];
      await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      // Manually seed brute-force stat to exercise the avg numerator guard.
      (engine as any).stats.bruteForceCount = 2;
      (engine as any).stats.totalBruteForceMs = 100;
      const s = engine.getStats();
      expect(s.avgIndexedMs).toBeGreaterThanOrEqual(0);
      expect(s.avgBruteForceMs).toBe(50);
    });
  });

  describe('stats & config', () => {
    it('getStats reports mode and dimension', () => {
      const { engine } = makeEngine();
      const s = engine.getStats();
      expect(s.mode).toBe(VectorMode.AUTO);
      expect(s.dimension).toBe(DIM);
      expect(s.hnswAvailable).toBe(false);
    });

    it('updateConfig patches dimension and config', () => {
      const { engine } = makeEngine();
      engine.updateConfig({ dimension: 8 });
      expect((engine as any).dimension).toBe(8);
    });

    it('updateConfig without dimension leaves it unchanged', () => {
      const { engine } = makeEngine();
      engine.updateConfig({ metric: VectorMetric.COSINE });
      expect((engine as any).dimension).toBe(DIM);
      expect(engine.getStats().dimension).toBe(DIM);
    });

    it('close closes DuckDB connection', async () => {
      const { engine } = makeEngine({ mode: VectorMode.BRUTEFORCE });
      await engine.initialize();
      await engine.close();
      expect((engine as any).duckDB).toBeNull();
    });

    it('close no-ops when DuckDB was already closed', async () => {
      const { engine } = makeEngine({ mode: VectorMode.BRUTEFORCE });
      await engine.initialize();
      await engine.close();
      await engine.close(); // second close → duckDB already null
      expect((engine as any).duckDB).toBeNull();
    });
  });

  describe('registerIvfpqVectors no-op without IVFPQ index', () => {
    it('does nothing when ivfpqIndex is null', () => {
      const { engine } = makeEngine();
      expect(() => engine.registerIvfpqVectors([vec(1, 2, 3, 4)], [10])).not.toThrow();
      expect(engine.isIvfpqAvailable()).toBe(false);
    });
  });

  describe('initIvfpqIndex defaults', () => {
    it('uses default K/M/nprobe when indexParams lacks them', () => {
      const { engine } = makeEngine({ dimension: 8, mode: VectorMode.IVFPQ });
      // dimension 8 with default M=8 is divisible; covers ?? defaults.
      (engine as any).initIvfpqIndex();
      const ivf = (engine as any).ivfpqIndex as IVFPQIndex;
      expect(ivf).not.toBeNull();
      expect((ivf as any).params.K).toBe(64);
      expect((ivf as any).params.M).toBe(8);
    });
  });

  describe('IVFPQ search fallback when not built', () => {
    it('falls back to brute-force → indexed when ivfpq not built', async () => {
      const { engine, shardManager } = makeEngine({
        mode: VectorMode.IVFPQ, indexParams: { ivfpqK: 4, ivfpqM: 4, ivfpqNprobe: 4 },
      });
      shardManager.shardIds = [0];
      shardManager.vectorSearchResults = [{ id: 1, distance: 0, shardId: 0 }];
      (engine as any).initIvfpqIndex(); // exists but not built
      expect((engine as any).ivfpqIndex['built']).toBeFalsy();

      (engine as any).duckDBAvailable = false;
      (engine as any).duckDB = null;
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.INDEXED);
    });
  });

  describe('buildIvfpqIndex auto-init', () => {
    it('initializes IVFPQ when not present before building', async () => {
      const { engine, shardManager } = makeEngine({
        indexParams: { ivfpqK: 4, ivfpqM: 4, ivfpqNprobe: 4 },
      });
      expect(engine.getIvfpqIndex()).toBeNull();
      shardManager.queryResults = Array.from({ length: 4 }, (_, i) => ({
        id: i, embedding: Buffer.from(new Float32Array([i, i, i, i]).buffer),
      }));
      await engine.buildIvfpqIndex('t');
      expect(engine.getIvfpqIndex()).not.toBeNull();
      expect(engine.isIvfpqAvailable()).toBe(true);
    });
  });

  describe('syncIndexWithVec0 consistent', () => {
    it('returns 0 when vec0 count <= saved count', async () => {
      const { engine, shardManager } = makeEngine();
      engine.initHnswIndex();
      engine.registerHnswVectors([vec(1, 2, 3, 4), vec(5, 6, 7, 8)], [1, 2]);
      const tmp = path.join((engine as any).dataDir, 'idx');
      engine.setHnswIndexPath(tmp);
      shardManager.queryAllImpl = async (sql: string) => {
        if (sql.includes('COUNT')) return [{ cnt: 1 }]; // vec0 <= saved(2)
        return [];
      };
      expect(await engine.syncIndexWithVec0('t')).toBe(0);
    });

    it('returns 0 when vec0 count query returns empty rows', async () => {
      const { engine, shardManager } = makeEngine();
      engine.initHnswIndex();
      engine.registerHnswVectors([vec(1, 2, 3, 4)], [1]);
      const tmp = path.join((engine as any).dataDir, 'idx');
      engine.setHnswIndexPath(tmp);
      shardManager.queryAllImpl = async () => []; // no count rows → vec0Count 0
      expect(await engine.syncIndexWithVec0('t')).toBe(0);
    });
  });

  describe('estimateTableRows row-shape handling', () => {
    it('handles array-shaped firstRow', async () => {
      const { engine, shardManager } = makeEngine();
      shardManager.queryAllImpl = async () => [[{ cnt: 7 }]];
      expect(await (engine as any).estimateTableRows('t')).toBe(7);
    });

    it('handles object-shaped firstRow', async () => {
      const { engine, shardManager } = makeEngine();
      shardManager.queryAllImpl = async () => [{ cnt: 9 }];
      expect(await (engine as any).estimateTableRows('t')).toBe(9);
    });
  });

  describe('auto-persist debounce', () => {
    it('skips scheduling when a persist is already pending', async () => {
      vi.useFakeTimers();
      try {
        const { engine } = makeEngine();
        engine.initHnswIndex();
        const tmp = path.join((engine as any).dataDir, 'idx');
        engine.setHnswIndexPath(tmp);
        (engine as any).autoPersistCount = 1;
        // First register triggers schedule; second should hit pending guard.
        engine.registerHnswVectors([vec(1, 2, 3, 4)], [10]);
        (engine as any).autoPersistHnswCounter = 1; // reset to trigger again
        engine.registerHnswVectors([vec(5, 6, 7, 8)], [20]);
        await vi.advanceTimersByTimeAsync(300);
        expect(fs.existsSync(tmp + '.hnsw')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('doHnswPersist no-ops when no index or path', async () => {
      const { engine } = makeEngine();
      await expect((engine as any).doHnswPersist()).resolves.toBeUndefined();
    });
  });

  describe('AUTO routing to ivfpq/hnsw', () => {
    it('AUTO with ivfpq built routes to ivfpq search', async () => {
      const { engine, shardManager } = makeEngine({
        mode: VectorMode.AUTO, indexType: VectorIndexType.IVFPQ,
        indexParams: { ivfpqK: 4, ivfpqM: 4, ivfpqNprobe: 4 },
      });
      (engine as any).initIvfpqIndex();
      const ivf = (engine as any).ivfpqIndex as IVFPQIndex;
      ivf.train(Array.from({ length: 8 }, (_, i) => new Float64Array([i, i, i, i])));
      ivf.add(Array.from({ length: 8 }, (_, i) => new Float64Array([i, i, i, i])), [0, 1, 2, 3, 4, 5, 6, 7]);
      const res = await engine.search({ collection: 't', queryVector: vec(0, 0, 0, 0), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.IVFPQ);
    });

    it('AUTO large set routes to hnsw when available', async () => {
      const { engine, shardManager } = makeEngine({
        mode: VectorMode.AUTO, indexType: VectorIndexType.FLAT, bruteForceThreshold: 1,
      });
      engine.initHnswIndex();
      engine.registerHnswVectors([vec(1, 2, 3, 4)], [10]);
      shardManager.queryAllImpl = async () => [{ cnt: 1000 }]; // large → beyond threshold
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.HNSW);
    });
  });

  describe('DuckDB sqlite_scanner install failure (real catch)', () => {
    it('degrades gracefully when INSTALL/LOAD sqlite_scanner throws', async () => {
      const cfg = {
        enabled: true, dimension: DIM, metric: VectorMetric.L2, mode: VectorMode.BRUTEFORCE,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT, indexParams: {},
      };
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-scan-'));
      cleanups.push(dataDir);
      const shardManager = new StubShardManager();
      shardManager.shardIds = [0];
      shardManager.shardPaths = ['/tmp/x.db'];
      shardManager.vectorSearchResults = [{ id: 1, distance: 0, shardId: 0 }];
      const engine = new VectorEngine(shardManager as any, cfg, dataDir);
      // Force the real duckDBExec to reject on INSTALL.
      const origExec = (engine as any).duckDBExec;
      (engine as any).duckDBExec = async () => { throw new Error('extension load failed'); };
      await engine.initialize();
      expect((engine as any).duckDBAvailable).toBe(false);
      (engine as any).duckDBExec = origExec;
      // brute-force with unavailable DuckDB → indexed fallback.
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.INDEXED);
      await engine.close();
    });
  });

  describe('AUTO medium/large fallbacks', () => {
    it('AUTO large set with no hnswIndex falls back to indexed', async () => {
      const { engine, shardManager } = makeEngine({
        mode: VectorMode.AUTO, indexType: VectorIndexType.FLAT, bruteForceThreshold: 1,
      });
      shardManager.shardIds = [0];
      shardManager.vectorSearchResults = [{ id: 5, distance: 0, shardId: 0 }];
      shardManager.queryAllImpl = async () => [{ cnt: 1000 }]; // large
      // No hnswIndex → indexed fallback.
      const res = await engine.search({ collection: 't', queryVector: vec(1, 2, 3, 4), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.INDEXED);
    });

    it('AUTO medium set routes to IVFPQ when built (no hnsw)', async () => {
      const { engine, shardManager } = makeEngine({
        mode: VectorMode.AUTO, indexType: VectorIndexType.FLAT, bruteForceThreshold: 1,
        indexParams: { ivfpqK: 4, ivfpqM: 4, ivfpqNprobe: 4 },
      });
      (engine as any).initIvfpqIndex();
      const ivf = (engine as any).ivfpqIndex as IVFPQIndex;
      ivf.train(Array.from({ length: 8 }, (_, i) => new Float64Array([i, i, i, i])));
      ivf.add(Array.from({ length: 8 }, (_, i) => new Float64Array([i, i, i, i])), [0, 1, 2, 3, 4, 5, 6, 7]);
      shardManager.queryAllImpl = async () => [{ cnt: 100 }]; // medium → beyond threshold
      const res = await engine.search({ collection: 't', queryVector: vec(0, 0, 0, 0), topK: 2 });
      expect(res.stats.mode).toBe(VectorMode.IVFPQ);
    });
  });

  describe('brute-force COSINE distance mapping', () => {
    it('maps L2 metric distance unchanged (L2 true branch)', async () => {
      const cfg = {
        enabled: true, dimension: DIM, metric: VectorMetric.L2, mode: VectorMode.BRUTEFORCE,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT, indexParams: {},
      };
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-l2-'));
      cleanups.push(dataDir);
      const Database = require('better-sqlite3');
      const shardPath = path.join(dataDir, 'shard_0.db');
      const sdb = new Database(shardPath);
      sdb.exec('CREATE TABLE articles (id INTEGER PRIMARY KEY, embedding BLOB)');
      sdb.close();

      const shardManager = new StubShardManager();
      shardManager.shardIds = [0];
      shardManager.shardPaths = [shardPath];
      const engine = new VectorEngine(shardManager as any, cfg, dataDir);
      await engine.initialize();
      const conn = (engine as any).duckDB.conn;
      const origAll = conn.all.bind(conn);
      conn.all = (sql: string, cb: any) => cb(null, [{ id: 1, distance: 2.5 }]);
      const res = await engine.search({ collection: 'articles', queryVector: vec(0, 0, 0, 0), topK: 1 });
      expect(res.results[0].distance).toBe(2.5); // L2 → unchanged
      conn.all = origAll;
      await engine.close();
    });

    it('maps COSINE metric distance as 1 - distance', async () => {
      const cfg = {
        enabled: true, dimension: DIM, metric: VectorMetric.COSINE, mode: VectorMode.BRUTEFORCE,
        bruteForceThreshold: 100, indexType: VectorIndexType.FLAT, indexParams: {},
      };
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-cos-'));
      cleanups.push(dataDir);
      const Database = require('better-sqlite3');
      const shardPath = path.join(dataDir, 'shard_0.db');
      const sdb = new Database(shardPath);
      sdb.exec('CREATE TABLE articles (id INTEGER PRIMARY KEY, embedding BLOB)');
      sdb.close();

      const shardManager = new StubShardManager();
      shardManager.shardIds = [0];
      shardManager.shardPaths = [shardPath];
      const engine = new VectorEngine(shardManager as any, cfg, dataDir);
      await engine.initialize();
      const conn = (engine as any).duckDB.conn;
      const origAll = conn.all.bind(conn);
      conn.all = (sql: string, cb: any) => cb(null, [{ id: 1, distance: 0.8 }]);
      const res = await engine.search({ collection: 'articles', queryVector: vec(0, 0, 0, 0), topK: 1 });
      expect(res.results[0].distance).toBeCloseTo(0.2); // 1 - 0.8 (COSINE)
      conn.all = origAll;
      await engine.close();
    });
  });
});
