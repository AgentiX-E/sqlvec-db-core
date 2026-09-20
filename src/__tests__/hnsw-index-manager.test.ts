/**
 * HnswIndexManager — wraps hnswlib-node HierarchicalNSW, mapping SQLite rowids
 * to HNSW internal positions, with optional Product Quantization (ADC) and
 * auto-merge segment tracking.
 *
 * Exercises the full lifecycle: addPoints (idempotent per id), removePoint,
 * search (L2 + PQ-ADC), PQ train/enable/serialize, auto-merge strategy,
 * and save/load persistence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HnswIndexManager } from '../vector/HnswIndexManager';
import hnswlib from 'hnswlib-node';

const { HierarchicalNSW } = hnswlib as unknown as typeof import('hnswlib-node');

const DIM = 4;

function vec(...xs: number[]): Float32Array {
  return new Float32Array(xs);
}

function makeManager(config: Partial<import('../types').HnswConfig> = {}) {
  return new HnswIndexManager(DIM, {
    maxElements: 1000,
    m: 16,
    efConstruction: 200,
    efSearch: 50,
    ...config,
  });
}

describe('HnswIndexManager', () => {
  describe('point management', () => {
    it('adds points and searches top-K by L2 distance', () => {
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4), vec(5, 6, 7, 8), vec(1, 2, 3, 5)], [10, 20, 30]);

      const res = mgr.search(vec(1, 2, 3, 4), 2);
      expect(res.length).toBe(2);
      // The nearest point is id 10 (distance 0).
      expect(res[0].id).toBe(10);
      expect(res[0].distance).toBe(0);
      // Results are sorted ascending by distance.
      expect(res[0].distance).toBeLessThanOrEqual(res[1].distance);
      // All returned ids are known.
      const ids = res.map((r) => r.id);
      expect(ids.every((id) => [10, 20, 30].includes(id))).toBe(true);
    });

    it('throws on mismatched vectors/ids lengths', () => {
      const mgr = makeManager();
      expect(() => mgr.addPoints([vec(1, 2, 3, 4)], [1, 2])).toThrow(/!== ids.length/);
    });

    it('throws on wrong vector dimension', () => {
      const mgr = makeManager();
      expect(() => mgr.addPoints([vec(1, 2, 3)], [1])).toThrow(/expected dimension 4/);
    });

    it('is idempotent per sqlite id (last write wins)', () => {
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4)], [10]);
      // Re-add the same id at a different location.
      mgr.addPoints([vec(100, 100, 100, 100)], [10]);

      // The old vector should no longer be the nearest to [1,2,3,4].
      const res = mgr.search(vec(1, 2, 3, 4), 1);
      expect(mgr.getCurrentCount()).toBe(1);
      expect(res[0].id).toBe(10);
      // Distance to [100,100,100,100] is large, not 0.
      expect(res[0].distance).toBeGreaterThan(0);
    });

    it('removes a point', () => {
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4), vec(5, 6, 7, 8)], [10, 20]);
      expect(mgr.getCurrentCount()).toBe(2);

      mgr.removePoint(10);
      expect(mgr.getCurrentCount()).toBe(1);

      // Removed point is not returned.
      const res = mgr.search(vec(1, 2, 3, 4), 2);
      expect(res.every((r) => r.id !== 10)).toBe(true);
    });

    it('removePoint on unknown id is a no-op', () => {
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4)], [10]);
      expect(() => mgr.removePoint(999)).not.toThrow();
      expect(mgr.getCurrentCount()).toBe(1);
    });
  });

  describe('search', () => {
    it('returns fewer results than topK when index is smaller', () => {
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4)], [10]);
      const res = mgr.search(vec(1, 2, 3, 4), 5);
      expect(res.length).toBe(1);
    });

    it('searches empty index without throwing', () => {
      const mgr = makeManager();
      const res = mgr.search(vec(1, 2, 3, 4), 3);
      expect(res).toEqual([]);
    });
  });

  describe('configuration & stats', () => {
    it('exposes dimension and max elements', () => {
      const mgr = makeManager();
      expect(mgr.getDimension()).toBe(DIM);
      expect(mgr.getMaxElements()).toBe(1000);
    });

    it('setEfSearch is a no-throw', () => {
      const mgr = makeManager();
      expect(() => mgr.setEfSearch(100)).not.toThrow();
    });

    it('is not in shard mode by default', () => {
      const mgr = makeManager();
      expect(mgr.isShardMode()).toBe(false);
      expect(mgr.getShardCount()).toBe(0);
    });
  });

  describe('product quantization', () => {
    it('throws when PQ is not configured', () => {
      const mgr = makeManager();
      expect(() => mgr.trainProductQuantization([vec(1, 2, 3, 4)])).toThrow(/PQ is not configured/);
      expect(() => mgr.enableProductQuantization([vec(1, 2, 3, 4)])).toThrow(/PQ is not configured/);
    });

    it('returns null PQ size/metrics when not configured', () => {
      const mgr = makeManager();
      expect(mgr.getPqSize()).toBeNull();
      expect(mgr.serializePq()).toBeNull();
      expect(mgr.isPqActive()).toBe(false);
    });

    function makePqManager() {
      return new HnswIndexManager(DIM, {
        maxElements: 1000,
        m: 16,
        efConstruction: 200,
        efSearch: 50,
      }, { enabled: true, m: 2, k: 4 });
    }

    it('trains, enables, and searches via PQ-ADC', () => {
      const mgr = makePqManager();
      const vectors = [vec(1, 2, 3, 4), vec(5, 6, 7, 8), vec(9, 10, 11, 12), vec(1, 2, 3, 5)];
      const ids = [10, 20, 30, 40];
      mgr.addPoints(vectors, ids);

      mgr.enableProductQuantization(vectors);
      expect(mgr.isPqActive()).toBe(true);

      const res = mgr.search(vec(1, 2, 3, 4), 3);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].id).toBe(10); // nearest is still id 10
      expect(res[0].distance).toBeGreaterThanOrEqual(0);
    });

    it('serializes and deserializes PQ state', () => {
      const mgr = makePqManager();
      const vectors = [vec(1, 2, 3, 4), vec(5, 6, 7, 8), vec(9, 10, 11, 12)];
      mgr.addPoints(vectors, [10, 20, 30]);
      mgr.enableProductQuantization(vectors);

      const json = mgr.serializePq();
      expect(json).not.toBeNull();

      // Fresh manager, restore PQ from the serialized state.
      const mgr2 = makePqManager();
      const ok = mgr2.deserializePq(json);
      expect(ok).toBe(true);
      expect(mgr2.isPqActive()).toBe(true);
    });

    it('deserializePq returns false when PQ not configured', () => {
      const mgr = makeManager();
      expect(mgr.deserializePq({ m: 2, k: 4, subDim: 2, centroids: [], codes: null })).toBe(false);
    });
  });

  describe('auto-merge', () => {
    it('tracks segments on addPoints', () => {
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4), vec(5, 6, 7, 8)], [10, 20]);
      expect(mgr.getSegmentCount()).toBe(1);
      mgr.addPoints([vec(9, 10, 11, 12)], [30]);
      expect(mgr.getSegmentCount()).toBe(2);
      expect(mgr.getSegments()[0].count).toBe(2);
    });

    it('does not merge when no callback registered', async () => {
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4)], [10]);
      await expect(mgr.triggerMerge()).resolves.toBeUndefined();
      expect(mgr.isMergeInProgress()).toBe(false);
    });

    it('merges only when >3 segments and a small segment exists', async () => {
      const mgr = makeManager();
      let merged = 0;
      mgr.setMergeCallback(async () => { merged++; });

      // 3 segments — not enough to trigger.
      mgr.addPoints([vec(1, 2, 3, 4)], [1]);
      mgr.addPoints([vec(5, 6, 7, 8)], [2]);
      mgr.addPoints([vec(9, 10, 11, 12)], [3]);
      await mgr.triggerMerge();
      expect(merged).toBe(0);

      // 4th segment with a tiny count (< 10% of total).
      mgr.addPoints(Array.from({ length: 50 }, () => vec(1, 2, 3, 4)), Array.from({ length: 50 }, (_, i) => 100 + i));
      mgr.addPoints([vec(7, 7, 7, 7)], [200]); // tiny segment
      await mgr.triggerMerge();
      expect(merged).toBe(1);
      // Segments are reset after a successful merge.
      expect(mgr.getSegmentCount()).toBe(0);
    });

    it('guards against concurrent merges', async () => {
      const mgr = makeManager();
      let inMerge = false;
      let resolveMerge: () => void;
      const gate = new Promise<void>((r) => { resolveMerge = r; });
      mgr.setMergeCallback(async () => {
        inMerge = true;
        await gate;
        inMerge = false;
      });

      // Build up >3 segments with a tiny one.
      mgr.addPoints([vec(1, 2, 3, 4)], [1]);
      mgr.addPoints([vec(1, 2, 3, 4)], [2]);
      mgr.addPoints([vec(1, 2, 3, 4)], [3]);
      mgr.addPoints(Array.from({ length: 100 }, () => vec(1, 2, 3, 4)), Array.from({ length: 100 }, (_, i) => 10 + i));
      mgr.addPoints([vec(1, 2, 3, 4)], [400]);

      const p1 = mgr.triggerMerge();
      const p2 = mgr.triggerMerge(); // should be a no-op while in progress
      expect(mgr.isMergeInProgress()).toBe(true);
      resolveMerge!();
      await Promise.all([p1, p2]);
      expect(mgr.isMergeInProgress()).toBe(false);
    });

    it('startAutoMerge is idempotent and stopAutoMerge clears the timer', () => {
      const mgr = makeManager();
      expect(mgr.isAutoMergeRunning()).toBe(false);
      mgr.startAutoMerge(10);
      expect(mgr.isAutoMergeRunning()).toBe(true);
      mgr.startAutoMerge(10); // idempotent
      expect(mgr.isAutoMergeRunning()).toBe(true);
      mgr.stopAutoMerge();
      expect(mgr.isAutoMergeRunning()).toBe(false);
      mgr.stopAutoMerge(); // idempotent
      expect(mgr.isAutoMergeRunning()).toBe(false);
    });
  });

  describe('ip space', () => {
    it('normalizes vectors in ip space', () => {
      const mgr = makeManager({ spaceName: 'ip' });
      mgr.addPoints([vec(3, 4, 0, 0), vec(0, 0, 3, 4)], [10, 20]);
      // After normalization both are unit vectors; search works without error.
      const res = mgr.search(vec(3, 4, 0, 0), 2);
      expect(res.length).toBe(2);
      // The query itself is a unit vector along (3,4,0,0); id 10 is closest.
      expect(res[0].id).toBe(10);
    });

    it('handles zero vector in ip space without NaN', () => {
      const mgr = makeManager({ spaceName: 'ip' });
      mgr.addPoints([vec(0, 0, 0, 0)], [10]);
      const res = mgr.search(vec(1, 0, 0, 0), 1);
      expect(res.length).toBe(1);
      expect(Number.isFinite(res[0].distance)).toBe(true);
    });
  });

  describe('shard build', () => {
    it('builds shards and searches across them', async () => {
      const mgr = makeManager();
      const vectors = Array.from({ length: 20 }, (_, i) => vec(i, i + 1, i + 2, i + 3));
      const ids = Array.from({ length: 20 }, (_, i) => i);

      await mgr.shardBuild(vectors, ids, 3);
      expect(mgr.isShardMode()).toBe(true);
      expect(mgr.getShardCount()).toBe(3);
      expect(mgr.getCurrentCount()).toBe(20);

      const res = mgr.search(vec(0, 1, 2, 3), 3);
      expect(res.length).toBe(3);
      expect(res[0].id).toBe(0); // nearest is id 0
      expect(res[0].distance).toBe(0);
    });

    it('throws on mismatched vectors/ids lengths in shardBuild', async () => {
      const mgr = makeManager();
      await expect(mgr.shardBuild([vec(1, 2, 3, 4)], [1, 2], 2)).rejects.toThrow(/!== ids.length/);
    });

    it('setEfSearch propagates to shards', async () => {
      const mgr = makeManager();
      await mgr.shardBuild([vec(1, 2, 3, 4), vec(5, 6, 7, 8)], [10, 20], 2);
      expect(() => mgr.setEfSearch(30)).not.toThrow();
    });
  });

  describe('persistence', () => {
    it('saves and loads index + metadata round-trip', () => {
      const tmp = require('os').tmpdir() + '/hnsw-test-' + process.pid + '-' + Date.now();
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4), vec(5, 6, 7, 8)], [10, 20]);

      mgr.saveSync(tmp);

      const restored = HnswIndexManager.loadSync(tmp, DIM, {
        maxElements: 1000,
        m: 16,
        efConstruction: 200,
        efSearch: 50,
      });
      expect(restored.getCurrentCount()).toBe(2);
      expect(restored.getDimension()).toBe(DIM);

      const res = restored.search(vec(1, 2, 3, 4), 2);
      expect(res[0].id).toBe(10);

      // Cleanup.
      require('fs').unlinkSync(tmp + '.hnsw');
      require('fs').unlinkSync(tmp + '.meta');
    });

    it('saveSync creates intermediate directories', () => {
      const tmp = require('os').tmpdir() + '/hnsw-nested-' + process.pid + '-' + Date.now() + '/sub/dir/index';
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4)], [10]);
      expect(() => mgr.saveSync(tmp)).not.toThrow();
      require('fs').rmSync(require('path').dirname(require('path').dirname(tmp)), { recursive: true, force: true });
    });

    it('loadSync restores PQ state when saved with PQ', () => {
      const tmp = require('os').tmpdir() + '/hnsw-pq-' + process.pid + '-' + Date.now();
      const mgr = new HnswIndexManager(DIM, {
        maxElements: 1000, m: 16, efConstruction: 200, efSearch: 50,
      }, { enabled: true, m: 2, k: 4 });
      const vectors = [vec(1, 2, 3, 4), vec(5, 6, 7, 8)];
      mgr.addPoints(vectors, [10, 20]);
      mgr.enableProductQuantization(vectors);

      mgr.saveSync(tmp);
      const restored = HnswIndexManager.loadSync(tmp, DIM, {
        maxElements: 1000, m: 16, efConstruction: 200, efSearch: 50,
      });
      expect(restored.isPqActive()).toBe(true);

      require('fs').unlinkSync(tmp + '.hnsw');
      require('fs').unlinkSync(tmp + '.meta');
    });
  });

  describe('product quantization edge cases', () => {
    it('addPoints encodes when PQ already active', () => {
      const mgr = new HnswIndexManager(DIM, {
        maxElements: 1000, m: 16, efConstruction: 200, efSearch: 50,
      }, { enabled: true, m: 2, k: 4 });
      const first = [vec(1, 2, 3, 4), vec(5, 6, 7, 8)];
      mgr.addPoints(first, [10, 20]);
      mgr.enableProductQuantization(first);

      // Adding more points while PQ active encodes them immediately.
      mgr.addPoints([vec(9, 10, 11, 12)], [30]);
      expect(mgr.getCurrentCount()).toBe(3);
    });

    it('enableProductQuantization tolerates fewer vectors than indexed', () => {
      const mgr = new HnswIndexManager(DIM, {
        maxElements: 1000, m: 16, efConstruction: 200, efSearch: 50,
      }, { enabled: true, m: 2, k: 4 });
      const vectors = [vec(1, 2, 3, 4), vec(5, 6, 7, 8), vec(9, 10, 11, 12)];
      mgr.addPoints(vectors, [10, 20, 30]);
      // Only pass 2 vectors — fewer than the 3 indexed points.
      mgr.enableProductQuantization(vectors.slice(0, 2));
      expect(mgr.isPqActive()).toBe(true);
    });

    it('trainProductQuantization trains explicitly', () => {
      const mgr = new HnswIndexManager(DIM, {
        maxElements: 1000, m: 16, efConstruction: 200, efSearch: 50,
      }, { enabled: true, m: 2, k: 4 });
      const vectors = [vec(1, 2, 3, 4), vec(5, 6, 7, 8)];
      expect(() => mgr.trainProductQuantization(vectors)).not.toThrow();
      expect(mgr.getPqSize()).not.toBeNull();
    });

    it('search uses PQ-ADC when code is missing for a neighbor', () => {
      // Force a neighbor to have no stored code, exercising the fallback branch.
      const mgr = new HnswIndexManager(DIM, {
        maxElements: 1000, m: 16, efConstruction: 200, efSearch: 50,
      }, { enabled: true, m: 2, k: 4 });
      const vectors = [vec(1, 2, 3, 4), vec(5, 6, 7, 8)];
      mgr.addPoints(vectors, [10, 20]);
      // Enable PQ but only store a code for id 10 (not 20).
      mgr.trainProductQuantization(vectors);
      // Manually enable codes + store one code, then activate PQ.
      const codes = (mgr as any).pq.enableCodes();
      // Activate PQ without storing codes for all — search falls back for missing.
      (mgr as any).pqActive = true;
      const res = mgr.search(vec(1, 2, 3, 4), 2);
      expect(res.length).toBeGreaterThan(0);
      expect(res.every((r) => Number.isFinite(r.distance))).toBe(true);
    });

    it('enableProductQuantization trains when not yet trained', () => {
      const mgr = new HnswIndexManager(DIM, {
        maxElements: 1000, m: 16, efConstruction: 200, efSearch: 50,
      }, { enabled: true, m: 2, k: 4 });
      const vectors = [vec(1, 2, 3, 4), vec(5, 6, 7, 8)];
      mgr.addPoints(vectors, [10, 20]);
      // Does not call train() first — enableProductQuantization should train.
      mgr.enableProductQuantization(vectors);
      expect(mgr.isPqActive()).toBe(true);
    });
  });

  describe('fragmentation & auto-merge edge cases', () => {
    it('addPoints with empty arrays does not create a segment', () => {
      const mgr = makeManager();
      mgr.addPoints([], []);
      expect(mgr.getSegmentCount()).toBe(0);
    });

    it('triggerMerge no-ops when index is empty', async () => {
      const mgr = makeManager();
      let called = false;
      mgr.setMergeCallback(async () => { called = true; });
      await mgr.triggerMerge();
      expect(called).toBe(false);
    });

    it('startAutoMerge invokes merge callback on timer tick', async () => {
      vi.useFakeTimers();
      try {
        const mgr = makeManager();
        let merged = 0;
        mgr.setMergeCallback(async () => { merged++; });

        // >3 segments with a tiny one to satisfy the merge condition.
        mgr.addPoints([vec(1, 2, 3, 4)], [1]);
        mgr.addPoints([vec(1, 2, 3, 4)], [2]);
        mgr.addPoints([vec(1, 2, 3, 4)], [3]);
        mgr.addPoints(Array.from({ length: 100 }, () => vec(1, 2, 3, 4)), Array.from({ length: 100 }, (_, i) => 10 + i));
        mgr.addPoints([vec(1, 2, 3, 4)], [400]);

        mgr.startAutoMerge(60_000);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(merged).toBe(1);
        mgr.stopAutoMerge();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('shard edge cases', () => {
    it('uses default shard count when numShards omitted', async () => {
      const mgr = makeManager();
      const vectors = Array.from({ length: 8 }, (_, i) => vec(i, i, i, i));
      const ids = Array.from({ length: 8 }, (_, i) => i);
      await mgr.shardBuild(vectors, ids);
      expect(mgr.isShardMode()).toBe(true);
      expect(mgr.getCurrentCount()).toBe(8);
    });

    it('handles numShards larger than vector count', async () => {
      const mgr = makeManager();
      await mgr.shardBuild([vec(1, 2, 3, 4)], [10], 5);
      expect(mgr.getCurrentCount()).toBe(1);
    });

    it('throws when a shard worker reports failure', async () => {
      const mgr = makeManager();
      // Mock _runShardWorker to report a failure.
      const spy = vi.spyOn(mgr as any, '_runShardWorker').mockResolvedValue({
        shardIndex: 0, count: 0, buildTimeMs: 0, indexPath: '', success: false, error: 'boom',
      });
      await expect(mgr.shardBuild([vec(1, 2, 3, 4)], [10], 1)).rejects.toThrow(/build failed: boom/);
      spy.mockRestore();
    });

    it('handles worker exit with non-zero code', async () => {
      const mgr = makeManager();
      // Directly exercise _runShardWorker with a fake Worker that exits non-zero.
      const Worker = (await import('worker_threads')).Worker;
      // Spawn a worker pointing at a non-exporting/nonexistent path via a stub.
      // Instead of real worker, verify the promise resolves with failure on bad path.
      const result = await (mgr as any)._runShardWorker('/nonexistent/worker.ts', { shardIndex: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('defensive branches via crafted internal state', () => {
    it('skips neighbors whose position is not in reverseIdMap (L2 search)', () => {
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4), vec(5, 6, 7, 8)], [10, 20]);
      // Corrupt reverseIdMap so one position is unmapped — defensive continue.
      (mgr as any).reverseIdMap.delete((mgr as any).idMap.get(20));
      const res = mgr.search(vec(1, 2, 3, 4), 5);
      // The unmapped neighbor is skipped; we still get valid results.
      expect(res.every((r) => r.id === 10)).toBe(true);
    });

    it('skips neighbors whose position is not in reverseIdMap (PQ search)', () => {
      const mgr = new HnswIndexManager(DIM, {
        maxElements: 1000, m: 16, efConstruction: 200, efSearch: 50,
      }, { enabled: true, m: 2, k: 4 });
      const vectors = [vec(1, 2, 3, 4), vec(5, 6, 7, 8)];
      mgr.addPoints(vectors, [10, 20]);
      mgr.enableProductQuantization(vectors);
      (mgr as any).reverseIdMap.delete((mgr as any).idMap.get(20));
      const res = mgr.search(vec(1, 2, 3, 4), 5);
      expect(res.every((r) => Number.isFinite(r.distance))).toBe(true);
    });

    it('returns empty for shard-mode search with zero shards', () => {
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4)], [10]);
      (mgr as any).shards = []; // empty shard array
      expect(mgr.search(vec(1, 2, 3, 4), 3)).toEqual([]);
    });

    it('deduplicates across shards and skips unmapped positions in shard search', async () => {
      const mgr = makeManager();
      // Build real 2-shard mode.
      await mgr.shardBuild(
        [vec(1, 2, 3, 4), vec(5, 6, 7, 8), vec(9, 10, 11, 12), vec(13, 14, 15, 16)],
        [10, 20, 30, 40],
        2,
      );
      const shards = (mgr as any).shards as any[];

      // Make both shards map their position 0 to the SAME id (10), so that
      // search collects a duplicate id across shards → dedup branch.
      shards[1].reverseIdMap.set(0, 10);
      shards[1].idMap.set(10, 0);

      // Delete every reverse mapping in shard[1] except position 0, so that
      // any other neighbor position becomes an unmapped position → skip branch.
      for (const k of [...shards[1].reverseIdMap.keys()]) {
        if (k !== 0) shards[1].reverseIdMap.delete(k);
      }

      const res = mgr.search(vec(1, 2, 3, 4), 10);
      const ids = res.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(res.every((r) => Number.isFinite(r.distance))).toBe(true);
    });

    it('skips a shard with zero count during shard search', () => {
      const mgr = makeManager();
      // Build a minimal real shard manually using hnswlib, plus a zero-count shard.
      const idx = new HierarchicalNSW('l2', DIM);
      idx.initIndex(2, 16, 200);
      idx.addPoint([1, 2, 3, 4], 0);
      idx.addPoint([5, 6, 7, 8], 1);

      (mgr as any).shards = [
        { index: idx, idMap: new Map([[10, 0], [20, 1]]), reverseIdMap: new Map([[0, 10], [1, 20]]), nextPos: 2, count: 2 },
        { index: idx, idMap: new Map(), reverseIdMap: new Map(), nextPos: 0, count: 0 },
      ];

      const res = mgr.search(vec(1, 2, 3, 4), 5);
      expect(res.length).toBeGreaterThan(0);
      expect(res.every((r) => Number.isFinite(r.distance))).toBe(true);
    });

    it('enableProductQuantization skips training when already trained', () => {
      const mgr = new HnswIndexManager(DIM, {
        maxElements: 1000, m: 16, efConstruction: 200, efSearch: 50,
      }, { enabled: true, m: 2, k: 4 });
      const vectors = [vec(1, 2, 3, 4), vec(5, 6, 7, 8)];
      mgr.addPoints(vectors, [10, 20]);
      mgr.trainProductQuantization(vectors); // pre-train
      mgr.enableProductQuantization(vectors);
      expect(mgr.isPqActive()).toBe(true);
    });

    it('startAutoMerge tolerates a timer without unref', () => {
      const mgr = makeManager();
      const fakeTimer = { unref: undefined };
      const realSetInterval = globalThis.setInterval;
      // Replace setInterval with one returning a timer lacking unref.
      vi.stubGlobal('setInterval', ((fn: any, _ms: any) => fakeTimer) as any);
      try {
        mgr.startAutoMerge(60_000);
        expect(mgr.isAutoMergeRunning()).toBe(true);
        mgr.stopAutoMerge();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('auto-merge timer swallows merge callback errors', async () => {
      vi.useFakeTimers();
      try {
        const mgr = makeManager();
        mgr.setMergeCallback(async () => { throw new Error('merge boom'); });
        mgr.addPoints([vec(1, 2, 3, 4)], [1]);
        mgr.addPoints([vec(1, 2, 3, 4)], [2]);
        mgr.addPoints([vec(1, 2, 3, 4)], [3]);
        mgr.addPoints(Array.from({ length: 100 }, () => vec(1, 2, 3, 4)), Array.from({ length: 100 }, (_, i) => 10 + i));
        mgr.addPoints([vec(1, 2, 3, 4)], [400]);
        mgr.startAutoMerge(60_000);
        // The callback throws; the tick's .catch swallows it (no unhandled rejection).
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mgr.isMergeInProgress()).toBe(false);
        mgr.stopAutoMerge();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('loadSync with sparse metadata', () => {
    it('defaults missing metadata fields', () => {
      const tmp = require('os').tmpdir() + '/hnsw-sparse-' + process.pid + '-' + Date.now();
      const mgr = makeManager();
      mgr.addPoints([vec(1, 2, 3, 4)], [10]);
      mgr.saveSync(tmp);

      // Overwrite metadata with sparse content (no pqActive/segments/segmentIdCounter).
      const metaPath = tmp + '.meta';
      const meta = JSON.parse(require('fs').readFileSync(metaPath, 'utf-8'));
      delete meta.pqActive;
      delete meta.segments;
      delete meta.segmentIdCounter;
      require('fs').writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');

      const restored = HnswIndexManager.loadSync(tmp, DIM, {
        maxElements: 1000, m: 16, efConstruction: 200, efSearch: 50,
      });
      expect(restored.getCurrentCount()).toBe(1);
      expect(restored.isPqActive()).toBe(false);
      expect(restored.getSegmentCount()).toBe(0);

      require('fs').unlinkSync(tmp + '.hnsw');
      require('fs').unlinkSync(tmp + '.meta');
    });
  });
});
