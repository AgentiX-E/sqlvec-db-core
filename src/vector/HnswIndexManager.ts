/**
 * HnswIndexManager — Wraps hnswlib-node's HierarchicalNSW to provide
 * a convenient mapping between SQLite row IDs and HNSW internal positions.
 *
 * HNSW offers O(log n) approximate nearest-neighbor search, replacing the
 * O(N*d) brute-force vec0 virtual table when the dataset is large enough.
 *
 * Key design choices:
 *   - L2 distance (internally); caller provides vectors, we map norms as needed
 *   - idMap / reverseIdMap: bidirectional mapping between sqlite rowid and HNSW position
 *   - addPoints is idempotent per sqlite id (last write wins)
 *   - The index can be rebuilt from vec0 data on startup
 *
 * Auto-merge (M08):
 *   - Tracks logical segments created by each addPoints call
 *   - startAutoMerge() spawns a background timer that checks for fragmentation
 *   - When segments > 3 and a segment is < 10% of total size, triggerMerge fires
 *   - onMerge callback allows external actors to rebuild index from source data
 *
 * Parallel build (Wave 2-A):
 *   - shardBuild() splits data into K shards, builds each on a separate worker thread
 *   - search() merges results from all shards
 *   - Near-linear speedup on multi-core machines
 */

import { HierarchicalNSW } from 'hnswlib-node';
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import { HnswConfig, ProductQuantizationConfig, DEFAULT_PQ_CONFIG } from '../types';
import { ProductQuantizer } from './ProductQuantizer';

/** Internal structure for a single shard */
interface ShardState {
  index: HierarchicalNSW;
  idMap: Map<number, number>;       // sqlite rowid → shard-local position
  reverseIdMap: Map<number, number>; // shard-local position → sqlite rowid
  nextPos: number;
  count: number;
}

/**
 * Normalize a vector to unit length (L2 norm = 1).
 * Used for IP/cosine space where hnswlib-node expects unit vectors.
 */
function normalizeL2(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq);
  if (norm < 1e-10) return v; // Zero vector, skip normalization
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** Info about a single logical segment created by addPoints. */
export interface SegmentInfo {
  /** Auto-incrementing segment id. */
  id: number;
  /** Number of points in this segment. */
  count: number;
  /** Timestamp (epoch ms) when this segment was created. */
  createdAt: number;
}

/** Callback signature for performing an actual merge (re-build index from source). */
export type MergeCallback = () => Promise<void>;

export class HnswIndexManager {
  private index: HierarchicalNSW;
  private idMap: Map<number, number>;        // sqlite rowid → hnsw index position
  private reverseIdMap: Map<number, number>;  // hnsw index position → sqlite rowid
  private nextPos: number = 0;
  private dimension: number;

  /** Product Quantizer (optional, for memory-efficient storage) */
  readonly pq: ProductQuantizer | null;
  private pqConfig: ProductQuantizationConfig;
  /** Whether PQ codes are being stored and used for search */
  private pqActive: boolean = false;

  // ── Auto-merge (M08) ─────────────────────────
  private segments: SegmentInfo[] = [];
  private segmentIdCounter: number = 0;
  private autoMergeTimer: ReturnType<typeof setInterval> | null = null;
  private autoMergeInterval: number = 60_000; // default 60s
  private _onMerge: MergeCallback | null = null;
  private mergeInProgress: boolean = false;
  private spaceName: 'l2' | 'ip' = 'l2';

  // ── Shard build (Wave 2-A) ───────────────────
  private shards: ShardState[] | null = null;

  constructor(dimension: number, config: HnswConfig, pqConfig?: Partial<ProductQuantizationConfig>) {
    this.pqConfig = { ...DEFAULT_PQ_CONFIG, ...pqConfig };
    this.pq = this.pqConfig.enabled ? new ProductQuantizer(this.pqConfig) : null;
    this.spaceName = config.spaceName || 'l2';
    this.index = new HierarchicalNSW(this.spaceName, dimension);
    this.index.initIndex(
      config.maxElements,
      config.m,
      config.efConstruction,
    );
    this.idMap = new Map();
    this.reverseIdMap = new Map();
    this.dimension = dimension;
    this.index.setEf(config.efSearch);
  }

  // ──────────────────────────────────────────────
  //  Point management
  // ──────────────────────────────────────────────

  /**
   * Add one or more vectors to the index.
   * If a sqlite id already exists in the index, the old entry is removed
   * and the new one takes its place (via markDeleted then addPoint).
   *
   * @param vectors  Array of Float32Array vectors (one per point)
   * @param ids      Array of sqlite rowids (parallel to vectors)
   */
  addPoints(vectors: Float32Array[], ids: number[]): void {
    if (vectors.length !== ids.length) {
      throw new Error(
        `HnswIndexManager: vectors.length (${vectors.length}) !== ids.length (${ids.length})`,
      );
    }

    for (let i = 0; i < vectors.length; i++) {
      const sqliteId = ids[i];
      const vector = vectors[i];

      // Validate dimension
      if (vector.length !== this.dimension) {
        throw new Error(
          `HnswIndexManager: expected dimension ${this.dimension}, got ${vector.length}`,
        );
      }

      // Normalize vector for IP/cosine space (hnswlib-node expects unit vectors)
      const vec = this.spaceName === 'ip' ? normalizeL2(vector) : vector;

      // If this sqlite id already exists, mark its old position as deleted
      const existingPos = this.idMap.get(sqliteId);
      if (existingPos !== undefined) {
        try {
          this.index.markDelete(existingPos);
        } catch {
          // Already deleted or not found — safe to ignore
        }
        this.reverseIdMap.delete(existingPos);
      }

      // Assign new position and add to index
      const pos = this.nextPos++;
      this.index.addPoint(Array.from(vec), pos);
      this.idMap.set(sqliteId, pos);
      this.reverseIdMap.set(pos, sqliteId);

      // If PQ is active, encode and store the code
      if (this.pqActive && this.pq) {
        const code = this.pq.encode(vector);
        this.pq.storeCode(sqliteId, code);
      }
    }

    // Track this batch as a logical segment (auto-merge M08)
    if (vectors.length > 0) {
      this.segments.push({
        id: ++this.segmentIdCounter,
        count: vectors.length,
        createdAt: Date.now(),
      });
    }
  }

  // ──────────────────────────────────────────────
  //  Shard build (Wave 2-A)
  // ──────────────────────────────────────────────

  /**
   * Build the HNSW index in parallel shards using worker threads.
   *
   * Splits the data into `numShards` roughly equal chunks, spawns a worker
   * thread per shard to build an independent HNSW sub-index, then loads
   * all sub-indexes into memory for merged search.
   *
   * After shardBuild(), the index operates in sharded mode:
   *   - search() queries each shard and merges results by distance
   *   - addPoints/removePoint are disabled (use rebuild for mutations)
   *
   * @param vectors   Array of Float32Array vectors
   * @param ids       Array of sqlite rowids (parallel to vectors)
   * @param numShards Number of shards to create (default: os.cpus().length)
   */
  async shardBuild(
    vectors: Float32Array[],
    ids: number[],
    numShards?: number,
  ): Promise<void> {
    if (vectors.length !== ids.length) {
      throw new Error(
        `HnswIndexManager: vectors.length (${vectors.length}) !== ids.length (${ids.length})`,
      );
    }

    const k = numShards ?? Math.max(2, os.cpus().length);
    const vecPerShard = Math.ceil(vectors.length / k);

    // Create temp directory for shard indexes
    const tmpDir = path.join(os.tmpdir(), `hnsw-shards-${process.pid}-${Date.now()}`);
    require('fs').mkdirSync(tmpDir, { recursive: true });

    const workerPath = path.join(__dirname, 'hnsw-shard-worker.ts');

    // ── Build shard data ──────────────────
    const workerDataList: any[] = [];
    let idx = 0;
    for (let s = 0; s < k; s++) {
      const chunkSize = Math.min(vecPerShard, vectors.length - idx);
      if (chunkSize <= 0) break;

      // Serialize vectors to flat Float32 buffer
      const vecsBuffer = new Float32Array(chunkSize * this.dimension);
      const idsBuffer = new Int32Array(chunkSize);
      for (let i = 0; i < chunkSize; i++) {
        idsBuffer[i] = ids[idx + i];
        const src = vectors[idx + i];
        for (let j = 0; j < this.dimension; j++) {
          vecsBuffer[i * this.dimension + j] = src[j];
        }
      }

      workerDataList.push({
        shardIndex: s,
        numShards: k,
        vectorsBuffer: Buffer.from(vecsBuffer.buffer),
        idsBuffer: Buffer.from(idsBuffer.buffer),
        count: chunkSize,
        dimension: this.dimension,
        m: 0, // Will be read from existing index config
        efConstruction: 0,
        outputDir: tmpDir,
        spaceName: this.spaceName,
      });

      idx += chunkSize;
    }

    // Determine HNSW params from existing index
    const m = 32;    // Default M value
    const efC = 200; // Default efConstruction
    for (const wd of workerDataList) {
      wd.m = m;
      wd.efConstruction = efC;
    }

    // ── Spawn workers ─────────────────────
    const numWorkers = workerDataList.length;
    const results = await Promise.all(
      workerDataList.map((data) => this._runShardWorker(workerPath, data)),
    );

    // Check for failures
    for (const r of results) {
      if (!r.success) {
        throw new Error(`Shard ${r.shardIndex} build failed: ${r.error}`);
      }
    }

    // ── Load shard indexes ────────────────
    this.shards = [];

    for (const r of results) {
      const shardIndex = new HierarchicalNSW(this.spaceName, this.dimension);
      shardIndex.readIndexSync(r.indexPath);

      // Rebuild id maps from worker data
      const wd = workerDataList[r.shardIndex];
      const idMap = new Map<number, number>();
      const reverseIdMap = new Map<number, number>();

      const idsArr = new Int32Array(
        wd.idsBuffer.buffer,
        wd.idsBuffer.byteOffset,
        wd.idsBuffer.byteLength / 4,
      );
      for (let i = 0; i < wd.count; i++) {
        const sqliteId = idsArr[i];
        idMap.set(sqliteId, i);
        reverseIdMap.set(i, sqliteId);
      }

      this.shards.push({
        index: shardIndex,
        idMap,
        reverseIdMap,
        nextPos: wd.count,
        count: wd.count,
      });
    }

    // Clean up temp files
    try {
      const fs = require('fs');
      for (const r of results) {
        fs.unlinkSync(r.indexPath);
      }
      fs.rmdirSync(tmpDir);
    } catch {
      // Temp cleanup is best-effort
    }
  }

  /**
   * Run a single shard worker thread.
   */
  private _runShardWorker(
    workerPath: string,
    data: any,
  ): Promise<{ shardIndex: number; count: number; buildTimeMs: number; indexPath: string; success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const worker = new Worker(workerPath, {
        workerData: data,
        // tsx handles .ts files via the node --import tsx loader
        eval: false,
      });
      worker.on('message', resolve);
      worker.on('error', (err) => {
        resolve({
          shardIndex: data.shardIndex,
          count: 0,
          buildTimeMs: 0,
          indexPath: '',
          success: false,
          error: err.message,
        });
      });
      worker.on('exit', (code) => {
        if (code !== 0) {
          resolve({
            shardIndex: data.shardIndex,
            count: 0,
            buildTimeMs: 0,
            indexPath: '',
            success: false,
            error: `Worker exited with code ${code}`,
          });
        }
      });
    });
  }

  /**
   * Returns true if the index is in shard build mode.
   */
  isShardMode(): boolean {
    return this.shards !== null && this.shards.length > 0;
  }

  /**
   * Get the number of active shards (0 = single-index mode).
   */
  getShardCount(): number {
    return this.shards?.length ?? 0;
  }

  /**
   * Remove a point from the index by sqlite rowid.
   */
  removePoint(sqliteId: number): void {
    const pos = this.idMap.get(sqliteId);
    if (pos === undefined) return;

    try {
      this.index.markDelete(pos);
    } catch {
      // Already deleted — safe to ignore
    }
    this.idMap.delete(sqliteId);
    this.reverseIdMap.delete(pos);
  }

  // ──────────────────────────────────────────────
  //  Search
  // ──────────────────────────────────────────────

  /**
   * Search the HNSW index for the top-K nearest neighbors.
   * Uses PQ-ADC for distance computation when PQ is active.
   *
   * When shard build mode is active, queries all shard sub-indexes
   * and merges results by distance ordering.
   *
   * @returns Array of { id: sqlite rowid, distance: L2 distance } sorted by distance asc
   */
  search(
    query: Float32Array,
    topK: number,
  ): Array<{ id: number; distance: number }> {
    // ── Multi-shard search ─────────────────────
    if (this.shards) {
      return this._searchShards(query, topK);
    }

    const result = this.index.searchKnn(Array.from(query), Math.max(topK, 1));
    const { distances, neighbors } = result;

    const out: Array<{ id: number; distance: number }> = [];

    // If PQ is active, use ADC to recompute distances for higher accuracy
    if (this.pqActive && this.pq && this.pq.isTrained()) {
      // Precompute distance table from query to all centroids
      const distTable = this.pq.computeDistanceTable(query);

      for (let i = 0; i < neighbors.length; i++) {
        const hnswPos = neighbors[i];
        const sqliteId = this.reverseIdMap.get(hnswPos);
        if (sqliteId === undefined) continue;

        // Get PQ code and compute ADC distance
        const code = this.pq.getCode(sqliteId);
        if (code) {
          const adcDist = this.pq.computeAdcDistance(code, distTable);
          out.push({
            id: sqliteId,
            distance: adcDist,
          });
        } else {
          // Fallback to raw HNSW distance if no code available
          out.push({
            id: sqliteId,
            distance: distances[i],
          });
        }
      }

      // Re-sort by ADC distance
      out.sort((a, b) => a.distance - b.distance);

      return out;
    }

    // Standard HNSW distance output
    for (let i = 0; i < neighbors.length; i++) {
      const hnswPos = neighbors[i];
      const sqliteId = this.reverseIdMap.get(hnswPos);
      if (sqliteId === undefined) continue; // sanity: position not mapped
      out.push({
        id: sqliteId,
        distance: distances[i],
      });
    }

    return out;
  }

  /**
   * Search across all shard sub-indexes and merge results.
   * Queries each shard for `topK * numShards` candidates to maintain recall,
   * then collects, deduplicates, sorts by distance, and returns top-K.
   */
  private _searchShards(
    query: Float32Array,
    topK: number,
  ): Array<{ id: number; distance: number }> {
    if (!this.shards || this.shards.length === 0) {
      return [];
    }

    const numShards = this.shards.length;
    // Search each shard with extra candidates to compensate for partitioning
    const candidatesPerShard = Math.max(topK * numShards * 2, topK + 100);

    // Collect candidates from all shards
    const candidates: Array<{ id: number; distance: number }> = [];

    for (let s = 0; s < numShards; s++) {
      const shard = this.shards[s];
      if (shard.count === 0) continue;

      try {
        const result = shard.index.searchKnn(
          Array.from(query),
          Math.min(candidatesPerShard, shard.count),
        );
        const { neighbors, distances } = result;

        for (let i = 0; i < neighbors.length; i++) {
          const shardLocalPos = neighbors[i];
          const sqliteId = shard.reverseIdMap.get(shardLocalPos);
          if (sqliteId === undefined) continue;
          candidates.push({
            id: sqliteId,
            distance: distances[i],
          });
        }
      } catch {
        // Shard search failed — skip this shard
      }
    }

    // Sort by distance and deduplicate by id (keep lowest distance)
    candidates.sort((a, b) => a.distance - b.distance);

    const seen = new Set<number>();
    const out: Array<{ id: number; distance: number }> = [];
    for (const c of candidates) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      if (out.length >= topK) break;
    }

    return out;
  }

  // ──────────────────────────────────────────────
  //  Configuration
  // ──────────────────────────────────────────────

  /**
   * Set the efSearch parameter dynamically (trade-off: accuracy vs speed).
   */
  setEfSearch(ef: number): void {
    this.index.setEf(ef);
    // Propagate to all shards if in shard mode
    if (this.shards) {
      for (const shard of this.shards) {
        shard.index.setEf(ef);
      }
    }
  }

  // ──────────────────────────────────────────────
  //  Stats
  // ──────────────────────────────────────────────

  getCurrentCount(): number {
    if (this.shards) {
      return this.shards.reduce((sum, s) => sum + s.count, 0);
    }
    return this.idMap.size;
  }

  getMaxElements(): number {
    return this.index.getMaxElements();
  }

  getDimension(): number {
    return this.dimension;
  }

  // ──────────────────────────────────────────────
  //  Product Quantization (F2)
  // ──────────────────────────────────────────────

  /**
   * Train Product Quantization on all vectors currently in the index.
   * This compresses the vectors into PQ codes for memory-efficient storage.
   *
   * @param vectors  All vectors to train on (must match index data)
   */
  trainProductQuantization(vectors: Float32Array[]): void {
    if (!this.pq) {
      throw new Error('HnswIndexManager: PQ is not configured (set enabled: true)');
    }
    this.pq.train(vectors);
  }

  /**
   * Enable Product Quantization: compress all existing vectors and
   * begin storing codes. After calling this, search uses ADC for
   * approximate distance computation.
   *
   * @param vectors  All vectors currently in the index (for encoding)
   */
  enableProductQuantization(vectors: Float32Array[]): void {
    if (!this.pq) {
      throw new Error('HnswIndexManager: PQ is not configured (set enabled: true)');
    }
    if (!this.pq.isTrained()) {
      this.pq.train(vectors);
    }

    // Encode all existing vectors
    this.pq.enableCodes();
    for (const [sqliteId] of this.idMap) {
      // We need the vector to encode — passed in as `vectors`
    }

    // Encode all vectors
    let vecIdx = 0;
    for (const [sqliteId] of this.idMap) {
      if (vecIdx < vectors.length) {
        const code = this.pq.encode(vectors[vecIdx]);
        this.pq.storeCode(sqliteId, code);
      }
      vecIdx++;
    }

    this.pqActive = true;
  }

  /**
   * Check if PQ is active for search.
   */
  isPqActive(): boolean {
    return this.pqActive;
  }

  /**
   * Get PQ memory statistics.
   */
  getPqSize(): { centroidsBytes: number; codeSizeBytes: number } | null {
    return this.pq?.getSize() ?? null;
  }

  /**
   * Serialize PQ state to JSON.
   */
  serializePq(): any {
    return this.pq?.toJSON() ?? null;
  }

  /**
   * Restore PQ state from serialized JSON.
   */
  deserializePq(data: any): boolean {
    if (!this.pq) return false;
    const restored = ProductQuantizer.fromJSON(data);
    // Copy restored state into existing pq
    Object.assign(this.pq, {
      centroids: (restored as any).centroids,
      codes: (restored as any).codes,
      subDim: (restored as any).subDim,
      codesEnabled: (restored as any).codesEnabled,
      trained: true,
    });
    this.pqActive = true;
    return true;
  }

  // ──────────────────────────────────────────────
  //  Auto-Merge (M08)
  // ──────────────────────────────────────────────

  /**
   * Register a callback that will be invoked when a merge is needed.
   * The callback should rebuild the index from source data (e.g., vec0 tables).
   */
  setMergeCallback(cb: MergeCallback): void {
    this._onMerge = cb;
  }

  /**
   * Start a background timer that checks for index fragmentation and
   * triggers merge when the strategy condition is met.
   *
   * Strategy: segments.length > 3 AND any single segment's count < 10% of total.
   *
   * @param intervalMs  Polling interval in milliseconds (default 60_000).
   */
  startAutoMerge(intervalMs: number = 60_000): void {
    if (this.autoMergeTimer !== null) {
      return; // already running — idempotent
    }
    this.autoMergeInterval = intervalMs;
    this.autoMergeTimer = setInterval(() => {
      this.triggerMerge().catch(() => {
        // Merge failures are non-fatal; the next tick will retry.
      });
    }, this.autoMergeInterval);

    // Unref so it doesn't keep the process alive
    if (typeof (this.autoMergeTimer as any)?.unref === 'function') {
      (this.autoMergeTimer as any).unref();
    }
  }

  /**
   * Stop the background auto-merge timer.
   * Idempotent — safe to call when already stopped.
   */
  stopAutoMerge(): void {
    if (this.autoMergeTimer !== null) {
      clearInterval(this.autoMergeTimer);
      this.autoMergeTimer = null;
    }
  }

  /**
   * Check merge conditions and, if met, invoke the merge callback.
   *
   * Merge condition:
   *   - segments.length > 3
   *   - AND any segment's count < 10% of total current count
   *
   * After a successful merge, segment tracking is reset since the
   * callback is expected to have rebuilt the index from scratch.
   */
  async triggerMerge(): Promise<void> {
    // Guard: no concurrent merges
    if (this.mergeInProgress) return;
    if (!this._onMerge) return;

    const total = this.getCurrentCount();
    if (total === 0) return;

    const segCount = this.segments.length;
    const minSegmentFraction = 0.1; // 10%

    // Condition: more than 3 segments AND at least one is too small
    const tooManySmallSegments =
      segCount > 3 &&
      this.segments.some((s) => s.count < total * minSegmentFraction);

    if (!tooManySmallSegments) return;

    this.mergeInProgress = true;
    try {
      await this._onMerge();

      // Reset segment tracking — the index has been rebuilt
      this.segments = [];
      this.segmentIdCounter = 0;
    } finally {
      this.mergeInProgress = false;
    }
  }

  /** Number of logical segments currently tracked. */
  getSegmentCount(): number {
    return this.segments.length;
  }

  /** Get a snapshot of segment info (for diagnostics). */
  getSegments(): readonly SegmentInfo[] {
    return this.segments;
  }

  /** Whether a merge is currently in progress. */
  isMergeInProgress(): boolean {
    return this.mergeInProgress;
  }

  /** Whether the auto-merge timer is currently running. */
  isAutoMergeRunning(): boolean {
    return this.autoMergeTimer !== null;
  }

  // ──────────────────────────────────────────────
  //  Persistence — pre‑built index save/load
  // ──────────────────────────────────────────────

  /**
   * Save the HNSW index + metadata to disk.
   * Produces two files:
   *   <basePath>.hnsw   — hnswlib‑node binary index
   *   <basePath>.meta   — JSON metadata (id maps, config, PQ)
   */
  saveSync(basePath: string): void {
    const fs = require('fs');
    const pathMod = require('path');
    const dir = pathMod.dirname(basePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Serialise idMaps as plain arrays for JSON
    const idMapArr: [number, number][] = [];
    const revMapArr: [number, number][] = [];
    for (const [k, v] of this.idMap) idMapArr.push([k, v]);
    for (const [k, v] of this.reverseIdMap) revMapArr.push([k, v]);

    const meta = {
      dimension: this.dimension,
      nextPos: this.nextPos,
      idMap: idMapArr,
      reverseIdMap: revMapArr,
      pq: this.serializePq(),
      pqActive: this.pqActive,
      segments: this.segments,
      segmentIdCounter: this.segmentIdCounter,
    };

    this.index.writeIndexSync(basePath + '.hnsw');
    fs.writeFileSync(basePath + '.meta', JSON.stringify(meta), 'utf-8');
  }

  /**
   * Load a previously saved HNSW index + metadata.
   * Caller must provide the same dimension and hnswConfig used during save.
   * Returns a fully restored HnswIndexManager instance.
   */
  static loadSync(basePath: string, dimension: number, config: HnswConfig): HnswIndexManager {
    const fs = require('fs');

    // Read metadata
    const meta = JSON.parse(fs.readFileSync(basePath + '.meta', 'utf-8'));

    // Create instance with constructor (creates empty index)
    const instance = new HnswIndexManager(dimension, config, {
      enabled: !!meta.pq,
      ...(meta.pq ?? {}),
    });

    // Replace the empty index with the saved binary
    instance.index.readIndexSync(basePath + '.hnsw');

    // Restore metadata
    instance.nextPos = meta.nextPos;
    instance.idMap = new Map(meta.idMap);
    instance.reverseIdMap = new Map(meta.reverseIdMap);
    instance.pqActive = meta.pqActive ?? false;
    instance.segments = meta.segments ?? [];
    instance.segmentIdCounter = meta.segmentIdCounter ?? 0;

    // Restore PQ state if present
    if (meta.pq && instance.pq) {
      instance.deserializePq(meta.pq);
    }

    return instance;
  }
}
