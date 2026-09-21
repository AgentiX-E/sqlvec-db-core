/**
 * hnsw-shard-worker — builds a single HNSW shard in a worker thread.
 *
 * Tests exercise the exported pure `buildShard` against the real hnswlib
 * extension: flat-buffer deserialization, L2/IP index construction, index-file
 * persistence, error reporting (bad output dir / bad params), and the
 * `normalizeL2` zero-vector guard via the `ip` space.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import hnswlib from 'hnswlib-node';
import { buildShard, normalizeL2 } from '../vector/hnsw-shard-worker';
import type { ShardWorkerData } from '../vector/hnsw-shard-worker';

const { HierarchicalNSW } = hnswlib as unknown as typeof import('hnswlib-node');

const tempDirs: string[] = [];

function makeTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hnsw-worker-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function serialize(vectors: number[][]): Buffer {
  const dim = vectors[0].length;
  const flat = new Float32Array(vectors.length * dim);
  vectors.forEach((v, i) => v.forEach((x, j) => (flat[i * dim + j] = x)));
  return Buffer.from(flat.buffer);
}

function idsBuffer(count: number): Buffer {
  const ids = new Int32Array(count);
  for (let i = 0; i < count; i++) ids[i] = i + 1;
  return Buffer.from(ids.buffer);
}

function makeData(overrides: Partial<ShardWorkerData> = {}): ShardWorkerData {
  return {
    shardIndex: 0,
    numShards: 1,
    vectorsBuffer: serialize([[1, 0, 0], [0, 1, 0]]),
    idsBuffer: idsBuffer(2),
    count: 2,
    dimension: 3,
    m: 16,
    efConstruction: 200,
    outputDir: makeTmp(),
    spaceName: 'l2',
    ...overrides,
  };
}

describe('hnsw-shard-worker', () => {
  describe('normalizeL2', () => {
    it('normalizes a non-zero vector to unit length', () => {
      const out = normalizeL2(new Float32Array([3, 4, 0]));
      const norm = Math.hypot(out[0], out[1], out[2]);
      expect(norm).toBeCloseTo(1, 5);
      expect(out[0]).toBeCloseTo(0.6, 5);
      expect(out[1]).toBeCloseTo(0.8, 5);
    });

    it('returns a zero vector unnormalized to avoid NaN', () => {
      const v = new Float32Array([0, 0, 0]);
      const out = normalizeL2(v);
      expect(out).toBe(v); // same instance — no copy made
      expect(out[0]).toBe(0);
    });
  });

  it('buildShard writes a loadable HNSW index and reports success', () => {
    const data = makeData();
    const result = buildShard(data);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.shardIndex).toBe(0);
    expect(result.count).toBe(2);
    expect(result.buildTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.indexPath).toContain('shard-0.hnsw');
    expect(fs.existsSync(result.indexPath)).toBe(true);

    // The serialized index is loadable by hnswlib.
    const loaded = new HierarchicalNSW('l2', 3);
    loaded.readIndexSync(result.indexPath);
    const res = loaded.searchKnn([1, 0, 0], 1);
    expect(res.neighbors.length).toBe(1);
  });

  it('buildShard creates the output directory if missing', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hnsw-worker-nested-'));
    tempDirs.push(parent);
    const nestedOut = path.join(parent, 'a', 'b', 'c');
    const data = makeData({ outputDir: nestedOut });
    const result = buildShard(data);
    expect(result.success).toBe(true);
    expect(fs.existsSync(result.indexPath)).toBe(true);
  });

  it('buildShard handles a single vector', () => {
    const data = makeData({
      vectorsBuffer: serialize([[1, 2, 3]]),
      idsBuffer: idsBuffer(1),
      count: 1,
    });
    const result = buildShard(data);
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });

  it('buildShard normalizes vectors for ip space (zero-vector guard)', () => {
    // ip space triggers normalizeL2; a zero vector hits the norm < 1e-10 guard
    // and is returned unnormalized (avoiding NaN).
    const data = makeData({
      vectorsBuffer: serialize([[0, 0, 0], [3, 4, 0]]),
      idsBuffer: idsBuffer(2),
      count: 2,
      spaceName: 'ip',
    });
    const result = buildShard(data);
    expect(result.success).toBe(true);

    // The index is still searchable; the zero vector does not corrupt it.
    const loaded = new HierarchicalNSW('ip', 3);
    loaded.readIndexSync(result.indexPath);
    const res = loaded.searchKnn([3, 4, 0], 1);
    expect(res.neighbors.length).toBe(1);
  });

  it('buildShard reports failure for an invalid output directory', () => {
    // Use a path whose parent is a regular file, making mkdirSync throw.
    const filePath = path.join(makeTmp(), 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    const data = makeData({
      outputDir: path.join(filePath, 'child'),
    });
    const result = buildShard(data);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.indexPath).toBe('');
  });

  it('buildShard rejects m=0 without crashing the worker (param guard)', () => {
    // Before input validation, m=0 made hnswlib segfault natively — a crash
    // the try/catch could not catch, killing the whole worker process (#187).
    const data = makeData({ m: 0 });
    const result = buildShard(data);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid m parameter/);
    expect(result.indexPath).toBe('');
  });

  it('buildShard rejects invalid efConstruction, dimension, and spaceName', () => {
    expect(buildShard(makeData({ efConstruction: 0 })).error).toMatch(/invalid efConstruction/);
    expect(buildShard(makeData({ dimension: 0 })).error).toMatch(/invalid dimension/);
    expect(buildShard(makeData({ spaceName: 'cosine' as any })).error).toMatch(/invalid spaceName/);
  });

  it('buildShard rejects non-integer m', () => {
    const result = buildShard(makeData({ m: 2.5 }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid m parameter/);
  });

  it('runs end-to-end as a real worker thread (exercises the !isMainThread entry)', async () => {
    // Spawn the worker file as an actual worker_threads worker to prove the
    // `if (!isMainThread)` entry-point posts a valid ShardWorkerResult over the
    // parentPort. The worker sub-process runs via the tsx loader, matching how
    // HnswIndexManager.shardBuild() launches it.
    const workerPath = path.join(__dirname, '..', 'vector', 'hnsw-shard-worker.ts');
    const data = makeData();
    const result = await new Promise<any>((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: data, eval: false });
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`worker exited ${code}`));
      });
    });
    expect(result.success).toBe(true);
    expect(result.shardIndex).toBe(0);
    expect(result.count).toBe(2);
    expect(fs.existsSync(result.indexPath)).toBe(true);
  });
});
