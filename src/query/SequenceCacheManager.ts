import Database from 'better-sqlite3';
import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('sequence-cache');

/**
 * SequenceCacheManager — PostgreSQL SERIAL / SEQUENCE compatibility for SQLVec.
 *
 * PostgreSQL sequences allocate values one-at-a-time. For SQLite-based
 * backends this creates excessive write amplification. This manager
 * pre-allocates ranges of sequence values (a "cache") and hands them
 * out from memory, falling back to SQLite only when the cache is
 * exhausted.
 *
 * Schema (created automatically):
 *   _sqlvec_sequences(name TEXT PRIMARY KEY, last_value INTEGER, increment INTEGER)
 *
 * Usage:
 *   const db = new Database(':memory:');
 *   const seq = new SequenceCacheManager(db, 100);
 *   const id = seq.nextVal('my_sequence');     // → 1
 *   const id2 = seq.nextVal('my_sequence');    // → 2
 *   const curr = seq.currVal('my_sequence');   // → 2
 *   seq.setVal('my_sequence', 1000);           // → 1000
 */

const DEFAULT_CACHE_SIZE = 20;
const SEQUENCES_TABLE = '_sqlvec_sequences';

export class SequenceCacheManager {
  private db: Database.Database;
  private cacheSize: number;

  /**
   * In-memory cache per sequence: { start, end, current }
   * current is the next value to hand out.
   */
  private caches: Map<string, { start: number; end: number; current: number }> = new Map();

  constructor(db: Database.Database, cacheSize: number = DEFAULT_CACHE_SIZE) {
    this.db = db;
    this.cacheSize = cacheSize;
    this.ensureTable();
  }

  /**
   * Ensure the sequences tracking table exists.
   */
  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${SEQUENCES_TABLE} (
        name TEXT PRIMARY KEY,
        last_value INTEGER NOT NULL DEFAULT 0,
        increment INTEGER NOT NULL DEFAULT 1
      )
    `);
  }

  /**
   * Get the next value from a sequence.
   *
   * @param name Sequence name
   * @returns Next integer value
   */
  nextVal(name: string): number {
    const cache = this.caches.get(name);

    if (cache && cache.current <= cache.end) {
      const val = cache.current;
      cache.current += 1;
      logger.debug({ sequence: name, value: val }, 'Sequence nextVal (cached)');
      return val;
    }

    // Cache exhausted or not initialised — allocate a new range
    return this.allocateRange(name);
  }

  /**
   * Allocate a new range from SQLite and populate the cache.
   */
  private allocateRange(name: string): number {
    const inc = this.getIncrement(name);

    // Atomically advance the stored last_value
    const stmt = this.db.prepare(`
      INSERT INTO ${SEQUENCES_TABLE} (name, last_value, increment)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        last_value = last_value + ?
    `);
    stmt.run(name, this.cacheSize, inc, this.cacheSize);

    // Read back the new last_value
    const row = this.db.prepare(
      `SELECT last_value, increment FROM ${SEQUENCES_TABLE} WHERE name = ?`,
    ).get(name) as { last_value: number; increment: number } | undefined;

    if (!row) {
      throw new Error(`Failed to allocate range for sequence "${name}"`);
    }

    const start = row.last_value - this.cacheSize + 1;

    this.caches.set(name, {
      start,
      end: row.last_value,
      current: start + 1, // first value handed out
    });

    logger.debug({ sequence: name, start, end: row.last_value }, 'Sequence range allocated');
    return start;
  }

  /**
   * Get the current value of a sequence (last handed-out value).
   *
   * @param name Sequence name
   * @returns Last value handed out, or 0 if the sequence was never used
   */
  currVal(name: string): number {
    const cache = this.caches.get(name);
    if (cache) {
      return cache.current - 1;
    }

    const row = this.db.prepare(
      `SELECT last_value FROM ${SEQUENCES_TABLE} WHERE name = ?`,
    ).get(name) as { last_value: number } | undefined;

    return row?.last_value ?? 0;
  }

  /**
   * Set a sequence to a specific value.
   *
   * @param name  Sequence name
   * @param value New value
   */
  setVal(name: string, value: number): void {
    // Invalidate cache
    this.caches.delete(name);

    const stmt = this.db.prepare(`
      INSERT INTO ${SEQUENCES_TABLE} (name, last_value, increment)
      VALUES (?, ?, 1)
      ON CONFLICT(name) DO UPDATE SET
        last_value = ?
    `);
    stmt.run(name, value, value);

    logger.info({ sequence: name, value }, 'Sequence setVal');
  }

  /**
   * Get the increment for a sequence (default 1).
   */
  private getIncrement(name: string): number {
    const row = this.db.prepare(
      `SELECT increment FROM ${SEQUENCES_TABLE} WHERE name = ?`,
    ).get(name) as { increment: number } | undefined;

    return row?.increment ?? 1;
  }

  /**
   * Set the increment for a sequence.
   */
  setIncrement(name: string, increment: number): void {
    // Invalidate cache
    this.caches.delete(name);

    const stmt = this.db.prepare(`
      INSERT INTO ${SEQUENCES_TABLE} (name, last_value, increment)
      VALUES (?, 0, ?)
      ON CONFLICT(name) DO UPDATE SET increment = ?
    `);
    stmt.run(name, increment, increment);
  }

  /**
   * Reset the cache for a specific sequence.
   * The next call to nextVal() will allocate a fresh batch.
   *
   * @param name Sequence name
   */
  resetCache(name: string): void {
    this.caches.delete(name);
    logger.debug({ sequence: name }, 'Sequence cache reset');
  }

  /**
   * Flush all cached sequences (clear all caches).
   */
  flushAllCaches(): void {
    const count = this.caches.size;
    this.caches.clear();
    logger.debug({ clearedCount: count }, 'All sequence caches flushed');
  }

  /**
   * Get the current cache size setting.
   */
  getCacheSize(): number {
    return this.cacheSize;
  }

  /**
   * Set a new cache size for future range allocations.
   */
  setCacheSize(size: number): void {
    this.cacheSize = size;
    // Flush all caches so next range uses the new size
    this.flushAllCaches();
  }
}
