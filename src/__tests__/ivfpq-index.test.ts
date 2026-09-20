/**
 * IVFPQIndex — pure-JS inverted-file-with-product-quantization index.
 *
 * These tests exercise the full train → add → search lifecycle against
 * synthetic, well-separated clusters and verify serialization round-trips.
 * They are written to (a) lock down correct nearest-neighbor behavior and
 * (b) expose real defects in incremental add() and id assignment.
 */
import { describe, it, expect } from 'vitest';
import {
  IVFPQIndex,
} from '../index/ivfpq-index';
import {
  DEFAULT_IVFPQ_PARAMS,
  kmeans,
  closestCentroid,
  nearestCentroids,
} from '../index/ivfpq-types';

/** A tiny deterministic index config that is cheap to train. */
function tinyIndex(overrides?: Partial<{ dim: number; M: number; K: number; codebookSize: number; nprobe: number }>) {
  const dim = overrides?.dim ?? 4;
  const M = overrides?.M ?? 4;
  const K = overrides?.K ?? 4;
  const codebookSize = overrides?.codebookSize ?? 16;
  const nprobe = overrides?.nprobe ?? 4;
  return new IVFPQIndex({ dim, M, K, codebookSize, nprobe });
}

/** Build `count` vectors spread evenly across `groups` well-separated clusters. */
function clusteredVectors(dim: number, groups: number, perGroup: number): { vectors: Float64Array[]; ids: number[] } {
  const vectors: Float64Array[] = [];
  const ids: number[] = [];
  let id = 0;
  for (let g = 0; g < groups; g++) {
    const center = g * 100;
    for (let j = 0; j < perGroup; j++) {
      const v = new Float64Array(dim);
      for (let d = 0; d < dim; d++) {
        v[d] = center + (Math.random() - 0.5) * 2;
      }
      vectors.push(v);
      ids.push(id++);
    }
  }
  return { vectors, ids };
}

describe('IVFPQIndex', () => {
  it('rejects a dimension not divisible by M', () => {
    expect(() => new IVFPQIndex({ dim: 5, M: 4 })).toThrow(/divisible by M/);
  });

  it('applies DEFAULT_IVFPQ_PARAMS as fallback for unspecified params', () => {
    const idx = new IVFPQIndex({ dim: 8, M: 4 });
    expect(idx.params.K).toBe(DEFAULT_IVFPQ_PARAMS.K);
    expect(idx.params.codebookSize).toBe(DEFAULT_IVFPQ_PARAMS.codebookSize);
    expect(idx.params.nprobe).toBe(DEFAULT_IVFPQ_PARAMS.nprobe);
    expect(idx.params.distance).toBe('l2');
  });

  it('throws when training with fewer vectors than K', () => {
    const idx = tinyIndex({ K: 4 });
    expect(() => idx.train([new Float64Array([1, 2, 3, 4])])).toThrow(/at least K=/);
  });

  it('throws when add() is called before train()', () => {
    const idx = tinyIndex();
    expect(() => idx.add([new Float64Array([1, 2, 3, 4])])).toThrow(/train\(\) before add/);
  });

  it('throws when search() is called before add()', () => {
    const idx = tinyIndex();
    expect(() => idx.search(new Float64Array([1, 2, 3, 4]), 3)).toThrow(/add\(\) before search/);
  });

  it('finds the correct cluster for a query near each centroid', () => {
    const idx = tinyIndex({ K: 4 });
    const { vectors, ids } = clusteredVectors(4, 3, 30);
    idx.train(vectors);
    idx.add(vectors, ids);

    const nearCluster0 = idx.search(new Float64Array([0, 0, 0, 0]), 5);
    expect(nearCluster0.length).toBe(5);
    // Every returned id belongs to the first cluster (ids 0..29).
    expect(nearCluster0.every((r) => r.id < 30)).toBe(true);

    const nearCluster2 = idx.search(new Float64Array([200, 200, 200, 200]), 5);
    expect(nearCluster2.every((r) => r.id >= 60)).toBe(true);

    // Distances are ascending.
    for (let i = 1; i < nearCluster0.length; i++) {
      expect(nearCluster0[i].distance).toBeGreaterThanOrEqual(nearCluster0[i - 1].distance);
    }
  });

  it('assigns default ids 0..N-1 when ids are omitted', () => {
    const idx = tinyIndex({ K: 4 });
    const { vectors } = clusteredVectors(4, 2, 10);
    idx.train(vectors);
    idx.add(vectors);
    expect(idx.count).toBe(20);
    const res = idx.search(new Float64Array([0, 0, 0, 0]), 20);
    const foundIds = res.map((r) => r.id).sort((a, b) => a - b);
    expect(foundIds).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('supports incremental add() across multiple batches without losing entries', () => {
    const idx = tinyIndex({ K: 4 });
    const { vectors } = clusteredVectors(4, 2, 20); // 40 vectors total
    idx.train(vectors);

    // First batch.
    idx.add(vectors.slice(0, 20), Array.from({ length: 20 }, (_, i) => i));
    // Second batch.
    idx.add(vectors.slice(20), Array.from({ length: 20 }, (_, i) => 20 + i));

    expect(idx.count).toBe(40);
    // Total indexed entries must equal the number of added vectors (40).
    const totalIndexed = idx.invertedLists.reduce((s, list) => s + list.length, 0);
    expect(totalIndexed).toBe(40);

    // A query near cluster 0 must still surface ids from the FIRST batch.
    const res = idx.search(new Float64Array([0, 0, 0, 0]), 40);
    const ids = res.map((r) => r.id);
    expect(ids.some((id) => id < 20)).toBe(true);
    expect(ids.some((id) => id >= 20)).toBe(true);
  });

  it('round-trips through toJSON / fromJSON', () => {
    const idx = tinyIndex({ K: 4 });
    const { vectors, ids } = clusteredVectors(4, 2, 16);
    idx.train(vectors);
    idx.add(vectors, ids);

    const json = idx.toJSON();
    const restored = IVFPQIndex.fromJSON(json);

    expect(restored.dim).toBe(idx.dim);
    expect(restored.count).toBe(idx.count);
    expect(restored.params).toEqual(idx.params);

    const q = new Float64Array([0, 0, 0, 0]);
    const original = idx.search(q, 5).map((r) => r.id);
    const roundTripped = restored.search(q, 5).map((r) => r.id);
    expect(roundTripped).toEqual(original);
  });

  it('returns empty when topK is 0', () => {
    const idx = tinyIndex({ K: 4 });
    const { vectors } = clusteredVectors(4, 1, 10);
    idx.train(vectors);
    idx.add(vectors);
    expect(idx.search(new Float64Array([0, 0, 0, 0]), 0)).toEqual([]);
  });

  it('caps nprobe results gracefully when nprobe exceeds K', () => {
    const idx = tinyIndex({ K: 2, nprobe: 100 });
    const { vectors } = clusteredVectors(4, 2, 20);
    idx.train(vectors);
    idx.add(vectors);
    // Should not throw, returns some results.
    const res = idx.search(new Float64Array([0, 0, 0, 0]), 20);
    expect(res.length).toBe(20);
  });
});

describe('ivfpq-types helpers', () => {
  it('closestCentroid returns the index of the nearest centroid', () => {
    const centroids = [new Float64Array([0, 0]), new Float64Array([10, 10]), new Float64Array([100, 100])];
    expect(closestCentroid(new Float64Array([0.1, 0.1]), centroids)).toBe(0);
    expect(closestCentroid(new Float64Array([9.9, 10.1]), centroids)).toBe(1);
    expect(closestCentroid(new Float64Array([100, 100]), centroids)).toBe(2);
  });

  it('nearestCentroids returns nprobe nearest indices sorted by distance', () => {
    const centroids = [new Float64Array([0, 0]), new Float64Array([1, 0]), new Float64Array([100, 0])];
    const nearest = nearestCentroids(new Float64Array([0, 0]), centroids, 2);
    expect(nearest).toEqual([0, 1]);
  });

  it('kmeans returns K centroids and converges on well-separated data', () => {
    const data = [
      new Float64Array([0, 0]),
      new Float64Array([0.1, 0.1]),
      new Float64Array([10, 10]),
      new Float64Array([10.1, 9.9]),
    ];
    const centroids = kmeans(data, 2, 2);
    expect(centroids.length).toBe(2);
    // One centroid near origin, one near (10,10).
    const nearOrigin = centroids.some((c) => Math.hypot(c[0], c[1]) < 1);
    const nearTen = centroids.some((c) => Math.hypot(c[0] - 10, c[1] - 10) < 1);
    expect(nearOrigin).toBe(true);
    expect(nearTen).toBe(true);
  });

  it('kmeans clamps K to data length when K exceeds data length', () => {
    const data = [new Float64Array([0, 0]), new Float64Array([1, 1])];
    const centroids = kmeans(data, 10, 2);
    expect(centroids.length).toBe(2);
  });

  it('kmeans throws on empty data', () => {
    expect(() => kmeans([], 2, 2)).toThrow(/empty data/);
  });

  it('kmeans sub-samples large datasets (>2000 vectors)', () => {
    // >2000 vectors triggers the working-set sub-sampling branch.
    const data = Array.from({ length: 2500 }, (_, i) => new Float64Array([i % 50, (i * 7) % 50]));
    const centroids = kmeans(data, 8, 2, 5);
    expect(centroids.length).toBe(8);
    expect(centroids.every((c) => c.length === 2)).toBe(true);
    // Centroids are finite (no NaN from empty clusters).
    expect(centroids.every((c) => c.every((v) => Number.isFinite(v)))).toBe(true);
  });

  it('kmeans clamps K down to the sub-sampled working-set size', () => {
    // >2000 vectors forces sub-sampling (~2000 retained). Asking for K = the
    // full dataset size means K >= workingSet, exercising the clamp-down branch.
    const N = 3000;
    const data = Array.from({ length: N }, (_, i) => new Float64Array([i % 40, (i * 7) % 40]));
    const centroids = kmeans(data, N, 2, 3);
    // K is clamped to the retained working set (>= 1 and <= N).
    expect(centroids.length).toBeGreaterThan(0);
    expect(centroids.length).toBeLessThanOrEqual(N);
    expect(centroids.every((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]))).toBe(true);
  });
});
