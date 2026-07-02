/**
 * hnsw-shard-worker.ts — Worker thread for building a single HNSW shard.
 *
 * Each worker receives a chunk of vectors, builds an independent HNSW index,
 * saves it to a temp file, and signals completion.
 *
 * Used by HnswIndexManager.shardBuild() for parallel build.
 */

import { parentPort, workerData } from 'worker_threads';
import { HierarchicalNSW } from 'hnswlib-node';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ShardWorkerData {
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

interface ShardWorkerResult {
  shardIndex: number;
  count: number;
  buildTimeMs: number;
  indexPath: string;
  success: boolean;
  error?: string;
}

function normalizeL2(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq);
  if (norm < 1e-10) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

async function main(): Promise<void> {
  const data = workerData as ShardWorkerData;

  try {
    // Ensure output dir exists
    fs.mkdirSync(data.outputDir, { recursive: true });

    // Deserialize vectors from flat buffer
    const vectors: Float32Array[] = [];
    const floatView = new Float32Array(
      data.vectorsBuffer.buffer,
      data.vectorsBuffer.byteOffset,
      data.vectorsBuffer.byteLength / 4,
    );
    const ids = new Int32Array(
      data.idsBuffer.buffer,
      data.idsBuffer.byteOffset,
      data.idsBuffer.byteLength / 4,
    );

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

    // Report success back to main thread
    const result: ShardWorkerResult = {
      shardIndex: data.shardIndex,
      count: data.count,
      buildTimeMs,
      indexPath,
      success: true,
    };

    parentPort!.postMessage(result);

  } catch (err: any) {
    const result: ShardWorkerResult = {
      shardIndex: data.shardIndex,
      count: data.count,
      buildTimeMs: 0,
      indexPath: '',
      success: false,
      error: err.message ?? String(err),
    };
    parentPort!.postMessage(result);
  }
}

main();
