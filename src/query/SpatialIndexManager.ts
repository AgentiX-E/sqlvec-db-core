/**
 * SpatialIndexManager — In-memory spatial index using flatbush (static R-tree).
 *
 * Flatbush is a fast, memory-efficient static R-tree index that supports:
 *   - Bulk loading (all items must be inserted before building)
 *   - Bounding-box search
 *   - kNN (k-nearest-neighbor) search
 *
 * Usage:
 * ```typescript
 * const sim = new SpatialIndexManager();
 * sim.begin();                    // Start bulk-loading phase
 * sim.insert(1, 0, 0, 10, 10);   // id=1, bbox (0,0)-(10,10)
 * sim.insert(2, 5, 5, 15, 15);
 * sim.finish();                   // Build the R-tree (immutable after)
 *
 * const results = sim.search(3, 3, 8, 8);  // → [1, 2] (ids in overlap)
 * ```
 *
 * This mirrors PostgreSQL GiST index behaviour for spatial columns, providing
 * bounding-box-level pre-filtering before exact geometric predicates.
 */

import FlatbushModule from 'flatbush';
const Flatbush = FlatbushModule as unknown as new (numItems: number) => {
  add(minX: number, minY: number, maxX: number, maxY: number): void;
  finish(): void;
  search(minX: number, minY: number, maxX: number, maxY: number): number[];
  neighbors(x: number, y: number, k?: number): number[];
};

export interface SpatialIndexEntry {
  /** Application-level ID (can be row ID, shard ID, etc.) */
  id: number;
  /** Minimum X (west/longitude) */
  minX: number;
  /** Minimum Y (south/latitude) */
  minY: number;
  /** Maximum X (east/longitude) */
  maxX: number;
  /** Maximum Y (north/latitude) */
  maxY: number;
}

export class SpatialIndexManager {
  /** The underlying Flatbush R-tree instance (null until .finish() is called) */
  private tree: any | null = null;
  /** Pending entries during bulk-loading phase */
  private pending: SpatialIndexEntry[] = [];
  /** Whether the tree has been finalized (immutable) */
  private built = false;
  /** Name for this index (useful when managing multiple indexes) */
  private readonly indexName: string;

  constructor(indexName = 'default') {
    this.indexName = indexName;
  }

  /**
   * Begin the bulk-loading phase.
   * Call before any inserts. If the tree was already built, calling begin()
   * resets the index for re-building.
   */
  begin(): void {
    if (this.built) {
      this.tree = null;
      this.pending = [];
      this.built = false;
    }
  }

  /**
   * Insert a bounding box entry during the loading phase.
   * Must call begin() first.
   *
   * @param id - Application-level identifier
   * @param minX - Minimum X coordinate
   * @param minY - Minimum Y coordinate
   * @param maxX - Maximum X coordinate
   * @param maxY - Maximum Y coordinate
   */
  insert(id: number, minX: number, minY: number, maxX: number, maxY: number): void {
    if (this.built) {
      throw new Error('Cannot insert after finalize(). Call begin() first.');
    }
    this.pending.push({ id, minX, minY, maxX, maxY });
  }

  /**
   * Finalize the index (build the R-tree).
   * After this call, no more inserts are allowed.
   */
  finish(): void {
    if (this.built) return;
    const numItems = this.pending.length;
    if (numItems === 0) {
      // Flatbush doesn't support 0 items — create an empty tree manually
      this.tree = null;
      this.built = true;
      return;
    }

    this.tree = new Flatbush(numItems);
    for (let i = 0; i < numItems; i++) {
      const entry = this.pending[i];
      this.tree.add(entry.minX, entry.minY, entry.maxX, entry.maxY);
    }
    this.tree.finish();
    this.built = true;
  }

  /**
   * Search the R-tree for entries whose bounding boxes overlap the query box.
   *
   * @param minX - Query box minimum X
   * @param minY - Query box minimum Y
   * @param maxX - Query box maximum X
   * @param maxY - Query box maximum Y
   * @returns Array of matching entry IDs
   */
  search(minX: number, minY: number, maxX: number, maxY: number): number[] {
    if (!this.built) {
      throw new Error('Index not finalized. Call finish() before search().');
    }
    if (!this.tree || this.pending.length === 0) {
      return [];
    }
    const indices = this.tree.search(minX, minY, maxX, maxY);
    return indices.map((idx: number) => this.pending[idx].id);
  }

  /**
   * Perform a k-nearest-neighbor search.
   *
   * @param queryX - Query X coordinate
   * @param queryY - Query Y coordinate
   * @param k - Maximum number of results
   * @returns Array of matching entry IDs, sorted by distance (nearest first)
   */
  knn(queryX: number, queryY: number, k: number = 10): number[] {
    if (!this.built) {
      throw new Error('Index not finalized. Call finish() before knn().');
    }
    if (!this.tree || this.pending.length === 0) {
      return [];
    }
    const indices = this.tree.neighbors(queryX, queryY, k);
    return indices.map((idx: number) => this.pending[idx].id);
  }

  /**
   * Get the total number of entries in the index.
   */
  size(): number {
    return this.pending.length;
  }

  /**
   * Check if the index has been finalized.
   */
  isBuilt(): boolean {
    return this.built;
  }

  /**
   * Get the index name.
   */
  name(): string {
    return this.indexName;
  }

  /**
   * Get all stored entries (only available before finish() or via internal tracking).
   */
  entries(): readonly SpatialIndexEntry[] {
    return this.pending;
  }

  /**
   * Clear the index entirely.
   */
  clear(): void {
    this.tree = null;
    this.pending = [];
    this.built = false;
  }

  /**
   * Search for entries using a bounding box defined by center and half-extents.
   *
   * @param cx - Center X
   * @param cy - Center Y
   * @param hx - Half-extent X
   * @param hy - Half-extent Y
   * @returns Array of matching entry IDs
   */
  searchAround(cx: number, cy: number, hx: number, hy: number): number[] {
    return this.search(cx - hx, cy - hy, cx + hx, cy + hy);
  }
}
