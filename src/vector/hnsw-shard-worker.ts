/**
 * hnsw-shard-worker.ts — Worker thread for building a single HNSW shard.
 *
 * Each worker receives a chunk of vectors, builds an independent HNSW index,
 * saves it to a temp file, and signals completion.
 *
 * Used by HnswIndexManager.shardBuild() for parallel build.
 *
 * The pure build logic is exported as `buildShard` so it can be unit-tested
 * directly in the main thread; the worker entry-point only runs when the file
 * is loaded as a real worker thread (`!isMainThread`).
 */

import { isMainThread, parentPort, workerData } from 'worker_threads';
import hnswlib from 'hnswlib-node';
import * as fs from 'fs';
import * as path from 'path';

// hnswlib-node is CommonJS. Under a native ESM loader (worker threads) the
// named export cannot be statically resolved, so we go through the default
// interop and destructure the constructor.
const { HierarchicalNSW } = hnswlib as unknown as typeof import('hnswlib-node');

export interface ShardWorkerData {
  /** Worker index (0-based) */
  shardIndex: number;
  /** Total number of shards */
  numShards: number;
  /** Vectors serialized as flat Float32Array buffer */
  vectorsBuffer: Buffer;
  /** IDs for this shard (serialized Int32Array buffer) */
  idsBuffer: Buffer;
  /** Number of vectors in this shard */
  count: number;
  /** Vector dimension */
  dimension: number;
  /** HNSW parameters */
  m: number;
  efConstruction: number;
  /** Output path for serialized index */
  outputDir: string;
  /** Space name ('l2' or 'ip') */
  spaceName: 'l2' | 'ip';
}

export interface ShardWorkerResult {
  shardIndex: number;
  count: number;
  buildTimeMs: number;
  indexPath: string;
  success: boolean;
  error?: string;
}

/**
 * L2-normalize a vector. Returns the input unnormalized when its norm is (near)
 * zero, to avoid dividing by zero / producing NaN.
 */
export function normalizeL2(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq);
  if (norm < 1e-10) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * Deserialize the flat vector buffers, build the HNSW index, and write it to
 * `<outputDir>/shard-<shardIndex>.hnsw`.
 *
 * Returns a ShardWorkerResult without throwing: failures are reported via
 * `success: false` + `error`, mirroring the worker IPC contract.
 */
export function buildShard(data: ShardWorkerData): ShardWorkerResult {
  try {
    // Validate HNSW parameters BEFORE entering the native layer. hnswlib
    // segfaults (rather than throwing) on invalid construction params — e.g.
    // m = 0 — and a C++ segfault cannot be caught by this try/catch, so a
    // single bad parameter would crash the whole worker process. Guard here.
    if (!Number.isInteger(data.m) || data.m < 1) {
      return { shardIndex: data.shardIndex, count: data.count, buildTimeMs: 0, indexPath: '', success: false, error: `invalid m parameter: ${data.m} (must be a positive integer)` };
    }
    if (!Number.isInteger(data.efConstruction) || data.efConstruction < 1) {
      return { shardIndex: data.shardIndex, count: data.count, buildTimeMs: 0, indexPath: '', success: false, error: `invalid efConstruction parameter: ${data.efConstruction} (must be a positive integer)` };
    }
    if (!Number.isInteger(data.dimension) || data.dimension < 1) {
      return { shardIndex: data.shardIndex, count: data.count, buildTimeMs: 0, indexPath: '', success: false, error: `invalid dimension parameter: ${data.dimension} (must be a positive integer)` };
    }
    if (data.spaceName !== 'l2' && data.spaceName !== 'ip') {
      return { shardIndex: data.shardIndex, count: data.count, buildTimeMs: 0, indexPath: '', success: false, error: `invalid spaceName parameter: ${data.spaceName} (must be 'l2' or 'ip')` };
    }

    // Ensure output dir exists
    fs.mkdirSync(data.outputDir, { recursive: true });

    // Deserialize vectors from flat buffer
    const floatView = new Float32Array(
      data.vectorsBuffer.buffer,
      data.vectorsBuffer.byteOffset,
      data.vectorsBuffer.byteLength / 4,
    );

    const vectors: Float32Array[] = [];
    for (let i = 0; i < data.count; i++) {
      const start = i * data.dimension;
      const vec = new Float32Array(data.dimension);
      for (let j = 0; j < data.dimension; j++) {
        vec[j] = floatView[start + j];
      }
      vectors.push(vec);
    }

    // Build HNSW index
    const t0 = Date.now();
    const index = new HierarchicalNSW(data.spaceName, data.dimension);
    index.initIndex(data.count, data.m, data.efConstruction);

    for (let i = 0; i < data.count; i++) {
      const vec = data.spaceName === 'ip' ? normalizeL2(vectors[i]) : vectors[i];
      index.addPoint(Array.from(vec), i);
    }

    const buildTimeMs = Date.now() - t0;

    // Save index to temp file
    const indexPath = path.join(data.outputDir, `shard-${data.shardIndex}.hnsw`);
    index.writeIndexSync(indexPath);

    return {
      shardIndex: data.shardIndex,
      count: data.count,
      buildTimeMs,
      indexPath,
      success: true,
    };
  } catch (err: any) {
    return {
      shardIndex: data.shardIndex,
      count: data.count,
      buildTimeMs: 0,
      indexPath: '',
      success: false,
      // Use an instanceof check so a non-Error thrown value is stringified
      // safely (e.g. String(null) === "null") instead of dereferencing
      // `.message` on null and throwing a secondary TypeError.
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Worker entry-point: only executes when loaded as a real worker thread.
 */
if (!isMainThread) {
  const data = workerData as ShardWorkerData;
  const result = buildShard(data);
  parentPort!.postMessage(result);
}
