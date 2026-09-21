/**
 * HnswVectorIndex — Lightweight HNSW vector index wrapper
 *
 * A simpler API layer over hnswlib-node that uses cosine distance by default
 * and provides convenient save/load/persistence semantics.
 *
 * Design:
 *   - Delegates to hnswlib's `cosine` space, which normalizes vectors
 *     internally and reports cosine distance (1 - similarity)
 *   - Maps external (user) IDs to internal HNSW positions
 *   - Full persistence: binary index file + JSON metadata for ID mappings
 *   - Thread-safe for sequential read/write operations
 *
 * When to use vs HnswIndexManager:
 *   - HnswVectorIndex: simpler API, cosine-first, no PQ, no auto-merge
 *   - HnswIndexManager: full-featured with PQ compression, auto-merge, L2
 *
 * @module vector/HnswVectorIndex
 */

import { HierarchicalNSW } from 'hnswlib-node';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface HnswVectorIndexConfig {
  /** Vector dimension */
  dimension: number;
  /** Distance metric: 'cosine' (default), 'l2', or 'ip' */
  metric?: 'cosine' | 'l2' | 'ip';
  /** Maximum number of elements the index can hold (default: 1_000_000) */
  maxElements?: number;
  /** Number of bi-directional links per layer (M), default: 24 */
  m?: number;
  /** efConstruction — build quality vs speed tradeoff, default: 200 */
  efConstruction?: number;
  /** efSearch — search accuracy vs speed tradeoff, default: 200 */
  efSearch?: number;
}

export interface HnswSearchResult {
  /** External/user-facing ID */
  id: number;
  /** Distance from query vector (cosine = 1 - similarity) */
  distance: number;
}

// ── Metadata format for persistence ────────────────────────────────────────

interface IndexMeta {
  dimension: number;
  metric: 'cosine' | 'l2' | 'ip';
  nextId: number;
  idMap: [number, number][];      // externalId → internalId
  reverseMap: [number, number][]; // internalId → externalId
}

// ── Implementation ─────────────────────────────────────────────────────────

export class HnswVectorIndex {
  private index: HierarchicalNSW | null = null;
  private dimension: number;
  private metric: 'cosine' | 'l2' | 'ip';
  private maxElements: number;
  private m: number;
  private efConstruction: number;
  private efSearch: number;

  /** external ID → internal HNSW position */
  private idMap: Map<number, number> = new Map();
  /** internal HNSW position → external ID */
  private reverseMap: Map<number, number> = new Map();
  /** Next available internal ID */
  private nextId: number = 0;
  /** Whether init() has been called */
  private initialized: boolean = false;

  constructor(config: HnswVectorIndexConfig) {
    this.dimension = config.dimension;
    this.metric = config.metric ?? 'cosine';
    this.maxElements = config.maxElements ?? 1_000_000;
    this.m = config.m ?? 24;
    this.efConstruction = config.efConstruction ?? 200;
    this.efSearch = config.efSearch ?? 200;

    if (this.dimension < 1) {
      throw new Error(`HnswVectorIndex: dimension must be >= 1, got ${this.dimension}`);
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Initialize (or re-initialize) the underlying HNSW index.
   * Must be called before add/search.
   *
   * @param maxElements Optional override for max capacity
   */
  init(maxElements?: number) {
    if (this.index) {
      // Dispose old index (memory cleared by GC after null assignment)
      this.index = null;
    }

    const cap = maxElements ?? this.maxElements;
    this.index = new HierarchicalNSW(this.metric, this.dimension);
    this.index.initIndex(cap, this.m, this.efConstruction);
    this.index.setEf(this.efSearch);

    // Reset state on re-init
    this.idMap.clear();
    this.reverseMap.clear();
    this.nextId = 0;
    this.initialized = true;
  }

  /**
   * Check whether the index is initialized and ready.
   */
  isInitialized(): boolean {
    return this.initialized && this.index !== null;
  }

  // ── Point operations ─────────────────────────────────────────────────

  /**
   * Add a single vector with the given external ID.
   * If the ID already exists, the old entry is replaced.
   */
  add(id: number, vector: number[]): void {
    this.ensureInitialized();
    if (vector.length !== this.dimension) {
      throw new Error(
        `HnswVectorIndex: expected dimension ${this.dimension}, got ${vector.length}`,
      );
    }
    const existingPos = this.idMap.get(id);
    if (existingPos !== undefined) {
      try { this.index!.markDelete(existingPos); } catch { /* already deleted */ }
      this.reverseMap.delete(existingPos);
    }
    const internalId = this.nextId++;
    this.index!.addPoint(vector, internalId);
    this.idMap.set(id, internalId);
    this.reverseMap.set(internalId, id);
  }

  /**
   * Add multiple vectors in a single tight loop.
   * Synchronous — no async/await overhead per element.
   */
  addBatch(ids: number[], vectors: number[][]): void {
    if (ids.length !== vectors.length) {
      throw new Error(
        `HnswVectorIndex: ids.length (${ids.length}) !== vectors.length (${vectors.length})`,
      );
    }
    const index = this.index!;
    const idMap = this.idMap;
    const reverseMap = this.reverseMap;
    let nextId = this.nextId;
    const dim = this.dimension;

    for (let i = 0; i < ids.length; i++) {
      const vector = vectors[i];
      if (vector.length !== dim) {
        throw new Error(
          `HnswVectorIndex: expected dimension ${dim}, got ${vector.length} at index ${i}`,
        );
      }
      const id = ids[i];
      // Remove existing point if any (unlikely in batch-first scenario)
      const existingPos = idMap.get(id);
      if (existingPos !== undefined) {
        try { index.markDelete(existingPos); } catch { /* already deleted */ }
        reverseMap.delete(existingPos);
      }
      const internalId = nextId++;
      index.addPoint(vector, internalId);
      idMap.set(id, internalId);
      reverseMap.set(internalId, id);
    }
    this.nextId = nextId;
  }

  /**
   * Remove a point from the index by external ID.
   */
  remove(id: number) {
    this.ensureInitialized();

    const pos = this.idMap.get(id);
    if (pos === undefined) return;

    try {
      this.index!.markDelete(pos);
    } catch {
      // Already deleted
    }
    this.idMap.delete(id);
    this.reverseMap.delete(pos);
  }

  // ── Search ───────────────────────────────────────────────────────────

  /**
   * Search the index for the k nearest neighbors.
   *
   * @param query  Query vector (must match dimension)
   * @param k      Number of results
   * @returns      Results sorted by distance (ascending)
   */
  search(query: number[], k: number): HnswSearchResult[] {
    this.ensureInitialized();

    if (k < 1) {
      throw new Error(`HnswVectorIndex: k must be >= 1, got ${k}`);
    }
    if (query.length !== this.dimension) {
      throw new Error(
        `HnswVectorIndex: query dimension ${query.length} !== index dimension ${this.dimension}`,
      );
    }

    // Set search ef for this query
    const ef = Math.max(k * 2, this.efSearch);
    this.index!.setEf(ef);

    // Execute search
    const result = this.index!.searchKnn(query, Math.max(k, 1));
    const { neighbors, distances } = result;

    // Map internal positions back to external IDs
    const out: HnswSearchResult[] = [];
    for (let i = 0; i < neighbors.length && i < k; i++) {
      const internalId = neighbors[i];
      const externalId = this.reverseMap.get(internalId);
      if (externalId === undefined) continue; // safety: should never happen
      out.push({
        id: externalId,
        distance: distances[i],
      });
    }

    return out;
  }

  // ── Stats ────────────────────────────────────────────────────────────

  /** Number of active (non-deleted) points in the index. */
  getCount(): number {
    return this.idMap.size;
  }

  /** Maximum capacity configured for the index. */
  getMaxElements(): number {
    return this.maxElements;
  }

  /** Dimension of vectors in the index. */
  getDimension(): number {
    return this.dimension;
  }

  /** Currently configured efSearch parameter. */
  getEfSearch(): number {
    return this.efSearch;
  }

  /** Set efSearch at runtime. */
  setEfSearch(ef: number): void {
    this.efSearch = ef;
    if (this.index) {
      this.index.setEf(ef);
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  /**
   * Save the index to disk.
   * Produces two files:
   *   - <path>        : HNSW binary index
   *   - <path>.meta.json : ID mapping metadata
   *
   * @param filePath  Path to save the index (without extension)
   */
  save(filePath: string) {
    this.ensureInitialized();

    // Ensure parent directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Save HNSW binary index
    this.index!.writeIndexSync(filePath);

    // Save metadata
    const meta: IndexMeta = {
      dimension: this.dimension,
      metric: this.metric,
      nextId: this.nextId,
      idMap: [...this.idMap.entries()],
      reverseMap: [...this.reverseMap.entries()],
    };
    fs.writeFileSync(filePath + '.meta.json', JSON.stringify(meta, null, 2), 'utf-8');
  }

  /**
   * Load the index from disk.
   *
   * @param filePath  Path to load the index from (without extension)
   */
  async load(filePath: string) {
    // Read metadata first
    const metaPath = filePath + '.meta.json';
    if (!fs.existsSync(filePath)) {
      throw new Error(`HnswVectorIndex: index file not found: ${filePath}`);
    }
    if (!fs.existsSync(metaPath)) {
      throw new Error(`HnswVectorIndex: metadata file not found: ${metaPath}`);
    }

    const metaRaw = fs.readFileSync(metaPath, 'utf-8');
    const meta: IndexMeta = JSON.parse(metaRaw);

    // Validate
    if (meta.dimension !== this.dimension) {
      throw new Error(
        `HnswVectorIndex: saved dimension ${meta.dimension} !== constructor dimension ${this.dimension}`,
      );
    }

    // Restore metadata
    this.metric = meta.metric;
    this.nextId = meta.nextId;
    this.idMap = new Map(meta.idMap);
    this.reverseMap = new Map(meta.reverseMap);

    // Re-initialize HNSW index and restore binary
    this.index = new HierarchicalNSW(this.metric, this.dimension);
    this.index.readIndexSync(filePath);
    this.index.setEf(this.efSearch);
    this.initialized = true;
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.initialized || !this.index) {
      throw new Error(
        'HnswVectorIndex: not initialized. Call await init() before operations.',
      );
    }
  }
}
