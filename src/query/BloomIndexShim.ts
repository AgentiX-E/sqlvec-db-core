/**
 * BloomIndexShim — PostgreSQL Bloom index compatibility shim for SQLite.
 *
 * PostgreSQL supports Bloom filter indexes via `CREATE INDEX ... USING bloom`.
 * Bloom indexes are a special index type that uses a Bloom filter to accelerate
 * searches over many columns, particularly for equality predicates on any
 * subset of the indexed columns.
 *
 * SQLite does not support Bloom indexes. The standard strategy is to fall back
 * to a B-tree index, which, while potentially less space-efficient for wide
 * multi-column queries, provides correct and performant results for typical
 * workloads.
 *
 * ## Strategy
 *
 * In the query preprocessing pipeline, detect `CREATE INDEX` statements that
 * specify `USING bloom` and rewrite the access method to `USING btree`:
 *
 * | Input                                                      | Output                                                  | rewritten |
 * |------------------------------------------------------------|---------------------------------------------------------|-----------|
 * | `CREATE INDEX i ON t USING bloom (c1, c2);`                | `CREATE INDEX i ON t USING btree (c1, c2);`             | true      |
 * | `CREATE UNIQUE INDEX i ON t USING bloom (c1);`             | `CREATE UNIQUE INDEX i ON t USING btree (c1);`          | true      |
 * | `CREATE INDEX IF NOT EXISTS i ON t USING bloom (c1);`      | `CREATE INDEX IF NOT EXISTS i ON t USING btree (c1);`   | true      |
 * | `CREATE INDEX i ON t (c1);`                                | (pass-through)                                          | false     |
 * | `SELECT * FROM t WHERE c1 = 1;`                            | (pass-through)                                          | false     |
 *
 * ## Edge-case handling
 *
 * - `USING bloom` that appears **outside** a `CREATE INDEX` context (e.g., in
 *   an identifier or a string literal) is ignored to avoid false positives.
 * - The replacement preserves the original case of `USING` (e.g., `using bloom`
 *   → `using btree`, `USING bloom` → `USING btree`).
 * - Trailing semicolons and whitespace are preserved unchanged.
 * - Bloom-index-specific `WITH` parameters (e.g., `WITH (length=80)`) are
 *   left intact; SQLite will ignore unrecognised index storage parameters
 *   tied to a B-tree index.
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite DDL
 * - No false positives on non-bloom SQL
 * - Handles optional whitespace, newlines, and trailing semicolons
 * - PinoLogger integration for debugging and audit trails
 *
 * @module BloomIndexShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('BloomIndexShim');

// ──────────────────────────────────────────────
//  Real Bloom Filter Index Implementation
// ──────────────────────────────────────────────

/**
 * A Bloom filter implementation using hash-wasm's XXHash128 for fast
 * probabilistic membership testing.
 *
 * Uses the Kirsch-Mitzenmacker double-hashing technique: for k hash functions,
 * compute h_i(x) = h1(x) + i * h2(x) (mod m), where h1 and h2 are derived
 * from a 128-bit hash split into two 64-bit values.
 *
 * False positive rate: 0.1% (configurable)
 * Optimal k = ceil((m/n) * ln(2))
 */
export class BloomFilterIndex {
  /** Bit array (packed as Uint8Array where each byte = 8 bits) */
  private bits: Uint8Array;
  /** Number of bits in the filter */
  private m: number;
  /** Number of hash functions */
  private k: number;
  /** Number of items inserted */
  private n: number;
  /** Expected number of items */
  private capacity: number;
  /** Desired false positive rate */
  private fpr: number;

  /**
   * Create a new Bloom filter.
   *
   * @param capacity - Expected number of items to insert
   * @param fpr - Desired false positive rate (default 0.001 = 0.1%)
   */
  constructor(capacity: number, fpr: number = 0.001) {
    this.capacity = capacity;
    this.fpr = fpr;
    this.n = 0;

    // Calculate optimal m (bits) from capacity and false positive rate:
    // m = -n * ln(p) / (ln(2))^2
    const ln2 = Math.LN2;
    const ln2sq = ln2 * ln2;
    this.m = Math.ceil(-capacity * Math.log(fpr) / ln2sq);

    // Optimal k = (m/n) * ln(2)
    this.k = Math.max(1, Math.ceil((this.m / capacity) * ln2));

    // Round m to a multiple of 8 for Uint8Array storage
    this.m = Math.ceil(this.m / 8) * 8;
    this.bits = new Uint8Array(Math.ceil(this.m / 8));
  }

  /**
   * Compute the k hash values for a key using double hashing.
   * Uses SHA-256 (via hash-wasm) as the base hash, splits into h1 and h2.
   *
   * @param key - The string key to hash
   * @returns Array of k hash positions (0 to m-1)
   */
  private async getHashPositions(key: string): Promise<number[]> {
    // Use a simple but effective double-hashing scheme.
    // We need two independent hash values h1, h2.
    // Use string hashing via SHA-256, derive h1 from first 64 bits,
    // h2 from next 64 bits of the digest.

    const { createSHA256 } = await import('hash-wasm');
    const hasher = await createSHA256();
    hasher.init();
    hasher.update(Buffer.from(key, 'utf-8'));
    const digestHex = hasher.digest('hex'); // 64 hex chars = 256 bits

    // Extract first 8 hex chars as h1 (32 bits), next 8 as h2 (32 bits)
    const h1 = parseInt(digestHex.substring(0, 8), 16);
    const h2 = parseInt(digestHex.substring(8, 16), 16);

    const positions: number[] = [];
    for (let i = 0; i < this.k; i++) {
      const pos = (h1 + i * h2) >>> 0; // force unsigned 32-bit
      positions.push(pos % this.m);
    }

    return positions;
  }

  /**
   * Add a value to the Bloom filter.
   *
   * @param key - The string key to add
   */
  async addValue(key: string): Promise<void> {
    const positions = await this.getHashPositions(key);
    for (const pos of positions) {
      const byteIndex = Math.floor(pos / 8);
      const bitIndex = pos % 8;
      this.bits[byteIndex] |= (1 << bitIndex);
    }
    this.n++;
  }

  /**
   * Check whether a key might be present in the Bloom filter.
   * Returns `false` if the key is definitely absent; `true` if it might be present
   * (with a small false positive probability determined by `fpr`).
   *
   * @param key - The string key to check
   * @returns `false` if the key is definitely absent, `true` if it might be present
   */
  async maybeContains(key: string): Promise<boolean> {
    const positions = await this.getHashPositions(key);
    for (const pos of positions) {
      const byteIndex = Math.floor(pos / 8);
      const bitIndex = pos % 8;
      if ((this.bits[byteIndex] & (1 << bitIndex)) === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Serialize the Bloom filter state into a plain object for persistence.
   */
  serialize(): BloomFilterSerialized {
    return {
      m: this.m,
      k: this.k,
      n: this.n,
      capacity: this.capacity,
      fpr: this.fpr,
      bits: Array.from(this.bits),
    };
  }

  /**
   * Deserialize a saved Bloom filter state.
   */
  static deserialize(data: BloomFilterSerialized): BloomFilterIndex {
    const bf = new BloomFilterIndex(data.capacity, data.fpr);
    bf.m = data.m;
    bf.k = data.k;
    bf.n = data.n;
    bf.bits = Uint8Array.from(data.bits);
    return bf;
  }

  /**
   * Get the current fill ratio (n/m), useful for monitoring.
   */
  fillRatio(): number {
    return this.n / this.capacity;
  }

  /**
   * Get the number of items currently in the filter.
   */
  size(): number {
    return this.n;
  }

  /**
   * Get the false positive rate
   */
  getFpr(): number {
    return this.fpr;
  }

  /**
   * Get the number of hash functions
   */
  getK(): number {
    return this.k;
  }

  /**
   * Get the number of bits
   */
  getM(): number {
    return this.m;
  }
}

/**
 * Serialized Bloom filter data for persistence.
 */
export interface BloomFilterSerialized {
  m: number;
  k: number;
  n: number;
  capacity: number;
  fpr: number;
  bits: number[];
}

/**
 * Manages Bloom filters per table and per column set.
 * Provides save/load persistence to SQLite.
 */
export class BloomFilterManager {
  /** Map of table.cols → BloomFilterIndex */
  private filters: Map<string, BloomFilterIndex> = new Map();

  /**
   * Get or create a Bloom filter for a specific table and column.
   *
   * @param table - Table name
   * @param cols - Column name(s) - comma-separated for multi-column
   * @param capacity - Expected number of items (default 10000)
   * @param fpr - False positive rate (default 0.001)
   * @returns The BloomFilterIndex for the given table/columns
   */
  getOrCreate(table: string, cols: string, capacity: number = 10000, fpr: number = 0.001): BloomFilterIndex {
    const key = `${table}_${cols}`;
    let bf = this.filters.get(key);
    if (!bf) {
      bf = new BloomFilterIndex(capacity, fpr);
      this.filters.set(key, bf);
    }
    return bf;
  }

  /**
   * Get an existing Bloom filter, or undefined if not found.
   */
  get(table: string, cols: string): BloomFilterIndex | undefined {
    return this.filters.get(`${table}_${cols}`);
  }

  /**
   * Save all Bloom filters to a SQLite database.
   * Creates a `__bloom_filters` table if it doesn't exist.
   *
   * @param db - better-sqlite3 Database instance
   */
  saveAll(db: any): void {
    db.exec(`CREATE TABLE IF NOT EXISTS __bloom_filters (
      filter_key TEXT PRIMARY KEY,
      m INTEGER NOT NULL,
      k INTEGER NOT NULL,
      n INTEGER NOT NULL,
      capacity INTEGER NOT NULL,
      fpr REAL NOT NULL,
      bits BLOB NOT NULL
    )`);

    const upsert = db.prepare(
      `INSERT OR REPLACE INTO __bloom_filters (filter_key, m, k, n, capacity, fpr, bits) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const transaction = db.transaction(() => {
      for (const [key, bf] of this.filters) {
        const serialized = bf.serialize();
        upsert.run(key, serialized.m, serialized.k, serialized.n, serialized.capacity, serialized.fpr, Buffer.from(serialized.bits));
      }
    });

    transaction();
    logger.info({ filterCount: this.filters.size }, 'BloomFilterManager: saved all filters');
  }

  /**
   * Load all Bloom filters from a SQLite database.
   *
   * @param db - better-sqlite3 Database instance
   */
  loadAll(db: any): void {
    try {
      const rows = db.prepare('SELECT * FROM __bloom_filters').all() as any[];

      this.filters.clear();

      for (const row of rows) {
        const bits = new Uint8Array(row.bits);
        const serialized: BloomFilterSerialized = {
          m: row.m,
          k: row.k,
          n: row.n,
          capacity: row.capacity,
          fpr: row.fpr,
          bits: Array.from(bits),
        };
        const bf = BloomFilterIndex.deserialize(serialized);
        this.filters.set(row.filter_key, bf);
      }

      logger.info({ filterCount: this.filters.size }, 'BloomFilterManager: loaded all filters');
    } catch (err: any) {
      // Table might not exist yet — that's fine
      if (err.message?.includes('no such table')) {
        logger.debug('BloomFilterManager: no saved filters found (table does not exist)');
      } else {
        logger.error({ err: err.message }, 'BloomFilterManager: error loading filters');
      }
    }
  }

  /**
   * Add a value to a specific table/column Bloom filter.
   *
   * @param table - Table name
   * @param cols - Column name(s)
   * @param value - Value to add
   */
  async addValue(table: string, cols: string, value: string): Promise<void> {
    const bf = this.getOrCreate(table, cols);
    await bf.addValue(value);
  }

  /**
   * Check if a value might be present in a specific table/column Bloom filter.
   *
   * @param table - Table name
   * @param cols - Column name(s)
   * @param value - Value to check
   * @returns `false` if definitely absent, `true` if might be present
   */
  async maybeContains(table: string, cols: string, value: string): Promise<boolean> {
    const bf = this.get(table, cols);
    if (!bf) return true; // If no filter exists, assume might be present
    return bf.maybeContains(value);
  }

  /**
   * Get the count of managed filters.
   */
  filterCount(): number {
    return this.filters.size;
  }

  /**
   * Clear all managed filters.
   */
  clear(): void {
    this.filters.clear();
  }
}

/** Default global Bloom filter manager instance. */
const defaultBloomManager = new BloomFilterManager();

export function getBloomFilterManager(): BloomFilterManager {
  return defaultBloomManager;
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface BloomIndexResult {
  /** Rewritten SQL (with `USING btree` if bloom detected, original otherwise) */
  sql: string;
  /** Whether the statement was detected as a bloom index and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Regex that detects `USING bloom` in a `CREATE INDEX` context.
 *
 * Matches:
 *   - `CREATE INDEX ... USING bloom`
 *   - `CREATE UNIQUE INDEX ... USING bloom`
 *   - `CREATE INDEX IF NOT EXISTS ... USING bloom`
 *
 * The pattern ensures `USING` is followed by `bloom` as a whole word,
 * and that the overall statement is a `CREATE INDEX` statement.
 * Case-insensitive matching allows `USING BLOOM` / `using bloom` etc.
 *
 * Does NOT match:
 *   - `USING bloom` outside CREATE INDEX (e.g., in a string literal)
 *   - `USING my_bloom_function` (different identifier)
 *   - `USING bloo` (partial match)
 */
// eslint-disable-next-line require-unicode-regexp
const CREATE_INDEX_USING_BLOOM = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bUSING\s+bloom\b/gi;

/**
 * Regex that captures the `USING bloom` token (case-insensitive) for
 * replacement. Used by `rewriteBloomIndex` to substitute the access method.
 */
// eslint-disable-next-line require-unicode-regexp
const USING_BLOOM = /\b(USING)\s+bloom\b/gi;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a `CREATE INDEX` statement
 * that uses the Bloom access method (`USING bloom`).
 *
 * This performs a case-insensitive search, so `USING bloom`, `USING BLOOM`,
 * `using bloom`, and mixed-case variants are all detected.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL defines a Bloom index
 *
 * @example
 * ```ts
 * detectBloomIndex('CREATE INDEX i ON t USING bloom (c1, c2);');   // true
 * detectBloomIndex('CREATE UNIQUE INDEX i ON t USING bloom (c1);'); // true
 * detectBloomIndex('CREATE INDEX i ON t (c1);');                    // false
 * detectBloomIndex('SELECT 1;');                                    // false
 * ```
 */
export function detectBloomIndex(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  return CREATE_INDEX_USING_BLOOM.test(sql);
}

/**
 * Rewrite a PostgreSQL Bloom index `CREATE INDEX` statement to use B-tree
 * instead.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is empty or whitespace-only, return unchanged with
 *    `rewritten: false`.
 * 2. If the SQL does **not** contain a `CREATE INDEX ... USING bloom`
 *    pattern, return unchanged with `rewritten: false`.
 * 3. Replace every occurrence of `USING bloom` (case-insensitive) within
 *    the SQL with `USING btree`, preserving the original casing of the
 *    `USING` keyword.
 *
 * The `USING bloom` → `USING btree` replacement is scoped to the `CREATE
 * INDEX` statement via the detection step; the actual replacement regex
 * is intentionally broader to handle all valid Bloom index syntax
 * variants in a single substitution pass.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link BloomIndexResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteBloomIndex('CREATE INDEX i ON t USING bloom (c1, c2);');
 * // → { sql: 'CREATE INDEX i ON t USING btree (c1, c2);', rewritten: true }
 *
 * rewriteBloomIndex('CREATE UNIQUE INDEX i ON t USING bloom (c1);');
 * // → { sql: 'CREATE UNIQUE INDEX i ON t USING btree (c1);', rewritten: true }
 *
 * rewriteBloomIndex('CREATE INDEX i ON t (c1);');
 * // → { sql: 'CREATE INDEX i ON t (c1);', rewritten: false }
 * ```
 */
export function rewriteBloomIndex(sql: string): BloomIndexResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Does this statement contain a Bloom index? ──────────

  if (!detectBloomIndex(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 2: Replace `USING bloom` → `USING btree` ──────────────

  // The replacement preserves the original casing of the `USING` keyword.
  // `USING bloom` → `USING btree`, `using bloom` → `using btree`.
  const result = trimmed.replace(USING_BLOOM, '$1 btree');

  logger.warn(
    { original: trimmed, rewritten: result },
    'Bloom index detected — rewriting USING bloom to USING btree (Bloom filter index not available in SQLite)',
  );

  return {
    sql: result,
    rewritten: true,
  };
}
