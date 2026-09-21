/**
 * HnswVectorIndex — a lighter cosine-first HNSW wrapper over hnswlib-node.
 *
 * Exercises the full lifecycle against the real hnswlib extension (no mocks):
 * construction validation, init/re-init, add/addBatch/remove with external-ID
 * mapping, search (all three metrics), stats accessors, efSearch runtime
 * tuning, and save/load persistence round-trip.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HnswVectorIndex } from '../vector/HnswVectorIndex';

const DIM = 3;
const tempDirs: string[] = [];

function makeTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hvi-'));
  tempDirs.push(d);
  return d;
}

function makeIndex(metric: 'cosine' | 'l2' | 'ip' = 'cosine'): HnswVectorIndex {
  return new HnswVectorIndex({ dimension: DIM, metric, maxElements: 100, m: 16, efConstruction: 200, efSearch: 50 });
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('HnswVectorIndex', () => {
  describe('construction', () => {
    it('defaults metric to cosine and applies configured params', () => {
      const idx = new HnswVectorIndex({ dimension: 4 });
      expect((idx as any).metric).toBe('cosine');
      expect(idx.getDimension()).toBe(4);
      expect(idx.getMaxElements()).toBe(1_000_000);
      expect(idx.getEfSearch()).toBe(200);
      expect(idx.isInitialized()).toBe(false);
    });

    it('throws when dimension < 1', () => {
      expect(() => new HnswVectorIndex({ dimension: 0 })).toThrow(/dimension must be >= 1/);
      expect(() => new HnswVectorIndex({ dimension: -3 })).toThrow(/dimension must be >= 1/);
    });

    it('honors custom metric, maxElements, m, efConstruction, efSearch', () => {
      const idx = new HnswVectorIndex({ dimension: 8, metric: 'l2', maxElements: 42, m: 8, efConstruction: 99, efSearch: 33 });
      expect((idx as any).metric).toBe('l2');
      expect(idx.getMaxElements()).toBe(42);
      expect(idx.getEfSearch()).toBe(33);
    });
  });

  describe('init / re-init', () => {
    it('initializes the underlying index and resets state', () => {
      const idx = makeIndex();
      idx.init();
      expect(idx.isInitialized()).toBe(true);
      expect(idx.getCount()).toBe(0);
    });

    it('re-init clears points and id mappings', () => {
      const idx = makeIndex('l2');
      idx.init();
      idx.add(1, [1, 2, 3]);
      idx.add(2, [4, 5, 6]);
      expect(idx.getCount()).toBe(2);
      idx.init(); // re-init resets
      expect(idx.getCount()).toBe(0);
      expect(idx.isInitialized()).toBe(true);
    });

    it('init accepts an explicit maxElements override', () => {
      const idx = makeIndex();
      idx.init(2000);
      expect(idx.isInitialized()).toBe(true);
    });
  });

  describe('point operations', () => {
    it('throws when add/search are called before init', () => {
      const idx = makeIndex();
      expect(() => idx.add(1, [1, 2, 3])).toThrow(/not initialized/);
      expect(() => idx.search([1, 2, 3], 1)).toThrow(/not initialized/);
      expect(() => idx.remove(1)).toThrow(/not initialized/);
      expect(() => idx.save('/tmp/x')).toThrow(/not initialized/);
    });

    it('throws when adding a vector of the wrong dimension', () => {
      const idx = makeIndex();
      idx.init();
      expect(() => idx.add(1, [1, 2])).toThrow(/expected dimension 3, got 2/);
    });

    it('replaces an existing ID rather than duplicating it', () => {
      const idx = makeIndex('l2');
      idx.init();
      idx.add(7, [1, 1, 1]);
      idx.add(7, [2, 2, 2]);
      expect(idx.getCount()).toBe(1);
      const res = idx.search([2, 2, 2], 1);
      expect(res[0].id).toBe(7);
      expect(res[0].distance).toBeCloseTo(0, 5);
    });

    it('addBatch inserts multiple points and validates length mismatch', () => {
      const idx = makeIndex('l2');
      idx.init();
      idx.addBatch([1, 2, 3], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
      expect(idx.getCount()).toBe(3);
      const res = idx.search([1, 0, 0], 1);
      expect(res[0].id).toBe(1);

      expect(() => idx.addBatch([1, 2], [[1, 0, 0]])).toThrow(/!== vectors.length/);
    });

    it('addBatch throws on a wrong-dimension vector at a specific index', () => {
      const idx = makeIndex();
      idx.init();
      expect(() => idx.addBatch([1, 2], [[1, 0, 0], [0, 1]])).toThrow(/at index 1/);
    });

    it('addBatch replaces a duplicate external id within the same batch', () => {
      const idx = makeIndex('l2');
      idx.init();
      // Duplicate id 5 appears twice: the second entry must replace the first
      // (markDelete the stale internal point, then re-add) rather than leak
      // two internal points for one external id.
      idx.addBatch([5, 5], [[1, 0, 0], [0, 1, 0]]);
      expect(idx.getCount()).toBe(1);
      const res = idx.search([0, 1, 0], 1);
      expect(res[0].id).toBe(5);
      expect(res[0].distance).toBeCloseTo(0, 5);
    });

    it('remove deletes a point and is a no-op for unknown ids', () => {
      const idx = makeIndex('l2');
      idx.init();
      idx.add(11, [0, 0, 0]);
      idx.add(22, [9, 9, 9]);
      expect(idx.getCount()).toBe(2);
      idx.remove(11);
      expect(idx.getCount()).toBe(1);
      idx.remove(9999);
      expect(idx.getCount()).toBe(1);
    });

    it('removed points are no longer returned by search', () => {
      const idx = makeIndex('l2');
      idx.init();
      idx.add(1, [1, 0, 0]);
      idx.add(2, [0, 1, 0]);
      idx.remove(1);
      const res = idx.search([1, 0, 0], 2);
      expect(res.map((r) => r.id)).not.toContain(1);
    });
  });

  describe('search', () => {
    it('throws when k < 1', () => {
      const idx = makeIndex();
      idx.init();
      expect(() => idx.search([1, 2, 3], 0)).toThrow(/k must be >= 1/);
    });

    it('throws when query dimension mismatches index dimension', () => {
      const idx = makeIndex();
      idx.init();
      expect(() => idx.search([1, 2], 1)).toThrow(/query dimension 2 !== index dimension 3/);
    });

    it('returns exact L2 results sorted ascending', () => {
      const idx = makeIndex('l2');
      idx.init();
      idx.add(1, [1, 0, 0]);
      idx.add(2, [3, 0, 0]);
      idx.add(3, [0, 4, 0]);
      const res = idx.search([1, 0, 0], 3);
      expect(res.length).toBe(3);
      expect(res[0].id).toBe(1);
      expect(res[0].distance).toBeCloseTo(0, 5);
      expect(res[1].id).toBe(2);
      expect(res[1].distance).toBeCloseTo(4, 5);
      expect(res[2].id).toBe(3);
      expect(res[2].distance).toBeCloseTo(17, 5);
    });

    it('returns cosine distance (1 - similarity)', () => {
      const idx = makeIndex('cosine');
      idx.init();
      idx.add(1, [1, 0, 0]);
      idx.add(2, [1, 1, 0]);
      const res = idx.search([1, 0, 0], 2);
      expect(res[0].id).toBe(1);
      expect(res[0].distance).toBeCloseTo(0, 5);
      expect(res[1].id).toBe(2);
      expect(res[1].distance).toBeCloseTo(1 - Math.cos(Math.PI / 4), 5);
    });

    it('returns inner-product results for ip metric', () => {
      const idx = makeIndex('ip');
      idx.init();
      idx.add(1, [1, 0, 0]);
      idx.add(2, [2, 0, 0]);
      const res = idx.search([1, 0, 0], 2);
      expect(res.length).toBe(2);
    });
  });

  describe('stats', () => {
    it('reports count, maxElements, dimension, efSearch', () => {
      const idx = makeIndex();
      idx.init();
      idx.add(1, [1, 0, 0]);
      idx.add(2, [0, 1, 0]);
      expect(idx.getCount()).toBe(2);
      expect(idx.getMaxElements()).toBe(100);
      expect(idx.getDimension()).toBe(DIM);
      expect(idx.getEfSearch()).toBe(50);
    });

    it('setEfSearch updates config and live index', () => {
      const idx = makeIndex('l2');
      idx.init();
      idx.setEfSearch(99);
      expect(idx.getEfSearch()).toBe(99);
      idx.add(1, [1, 0, 0]);
      expect(idx.search([1, 0, 0], 1)[0].id).toBe(1);
    });

    it('setEfSearch before init does not touch a null index', () => {
      const idx = makeIndex();
      idx.setEfSearch(77);
      expect(idx.getEfSearch()).toBe(77);
    });
  });

  describe('persistence', () => {
    it('save + load round-trips ids and vectors', async () => {
      const dir = makeTmp();
      const file = path.join(dir, 'idx');

      const idx = makeIndex('l2');
      idx.init();
      idx.add(10, [1, 0, 0]);
      idx.add(20, [0, 1, 0]);
      idx.add(30, [0, 0, 1]);
      idx.save(file);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.existsSync(file + '.meta.json')).toBe(true);

      const reloaded = new HnswVectorIndex({ dimension: DIM, metric: 'l2', maxElements: 100 });
      await reloaded.load(file);
      expect(reloaded.getCount()).toBe(3);
      const res = reloaded.search([1, 0, 0], 1);
      expect(res[0].id).toBe(10);
      expect(res[0].distance).toBeCloseTo(0, 5);
    });

    it('save creates nested directories if missing', () => {
      const dir = makeTmp();
      const nested = path.join(dir, 'a', 'b', 'idx');
      const idx = makeIndex();
      idx.init();
      idx.add(1, [1, 0, 0]);
      idx.save(nested);
      expect(fs.existsSync(nested)).toBe(true);
    });

    it('load throws when index file is missing', async () => {
      const dir = makeTmp();
      const idx = new HnswVectorIndex({ dimension: DIM });
      await expect(idx.load(path.join(dir, 'ghost'))).rejects.toThrow(/index file not found/);
    });

    it('load throws when metadata file is missing', async () => {
      const dir = makeTmp();
      const file = path.join(dir, 'idx');
      const idx = makeIndex();
      idx.init();
      idx.add(1, [1, 0, 0]);
      idx.save(file);
      fs.unlinkSync(file + '.meta.json');
      const reloaded = new HnswVectorIndex({ dimension: DIM });
      await expect(reloaded.load(file)).rejects.toThrow(/metadata file not found/);
    });

    it('load throws when saved dimension mismatches constructor dimension', async () => {
      const dir = makeTmp();
      const file = path.join(dir, 'idx');
      const idx = makeIndex();
      idx.init();
      idx.add(1, [1, 0, 0]);
      idx.save(file);

      const wrongDim = new HnswVectorIndex({ dimension: 5 });
      await expect(wrongDim.load(file)).rejects.toThrow(/saved dimension 3 !== constructor dimension 5/);
    });

    it('loaded index accepts new points via preserved nextId', async () => {
      const dir = makeTmp();
      const file = path.join(dir, 'idx');
      const idx = makeIndex('l2');
      idx.init();
      idx.add(1, [1, 0, 0]);
      idx.save(file);

      const reloaded = new HnswVectorIndex({ dimension: DIM, metric: 'l2' });
      await reloaded.load(file);
      reloaded.add(2, [0, 1, 0]);
      expect(reloaded.getCount()).toBe(2);
      const res = reloaded.search([0, 1, 0], 1);
      expect(res[0].id).toBe(2);
    });
  });
});
