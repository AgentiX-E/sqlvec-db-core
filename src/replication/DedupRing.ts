/**
 * DedupRing — bounded in-memory deduplication ring.
 *
 * A FIFO ring used by `ShardReplica` to make Raft entry application
 * idempotent: each `msgId` is recorded on first apply, and a repeated `msgId`
 * is rejected so replayed entries are skipped (Layer 1 replay protection).
 *
 * The ring is bounded to a configurable capacity; once full, the oldest
 * entries are evicted first.  This keeps memory use bounded while preserving
 * replay protection for the most recent window of entries.
 *
 * @module replication/DedupRing
 */

export class DedupRing {
  private readonly capacity: number;
  private readonly keys = new Set<string>();

  /**
   * @param capacity Maximum number of distinct keys to retain.  Defaults to
   *                 10_000.  Values are normalized to a positive integer.
   */
  constructor(capacity: number = 10_000) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** Number of distinct keys currently retained. */
  get size(): number {
    return this.keys.size;
  }

  /** The configured capacity (max distinct keys retained). */
  get maxSize(): number {
    return this.capacity;
  }

  /**
   * Record a key.
   *
   * Returns `true` if the key was newly added, `false` if it was already
   * present (i.e. a duplicate).  Evicts the oldest key first when the ring
   * is at capacity.
   */
  add(key: string): boolean {
    if (this.keys.has(key)) {
      return false;
    }
    // Evict oldest (FIFO) before inserting if at capacity.  At this point
    // `size >= capacity >= 1`, so the set is non-empty and `next().value`
    // always yields a string (the first-inserted key).
    if (this.keys.size >= this.capacity) {
      this.keys.delete(this.keys.values().next().value!);
    }
    this.keys.add(key);
    return true;
  }

  /** Whether the key is currently retained. */
  has(key: string): boolean {
    return this.keys.has(key);
  }
}
