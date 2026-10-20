/**
 * QueryCacheShim — PostgreSQL query cache compatibility shim for SQLite.
 *
 * PostgreSQL provides shared_buffer and plan_cache mechanisms with several
 * runtime-controllable knobs:
 *
 * | SQL pattern                                | PG semantics                          |
 * |--------------------------------------------|---------------------------------------|
 * | `SET enable_plan_cache = on|off`           | Enable/disable plan caching           |
 * | `SHOW plan_cache_mode`                     | Display current plan cache mode       |
 * | `SELECT pg_prewarm('relation')`            | Pre-warm shared buffer for a table    |
 *
 * SQLite has no equivalent caching infrastructure. All of these are
 * meaningless in an SQLite context. This shim detects them and rewrites
 * them into no-op `SELECT` statements that are valid SQLite.
 *
 * ## Strategy
 *
 * | Input                                         | Output                                | rewritten |
 * |-----------------------------------------------|---------------------------------------|-----------|
 * | `SET enable_plan_cache = on`                  | `SELECT 1`                            | true      |
 * | `SET enable_plan_cache = off`                 | `SELECT 1`                            | true      |
 * | `SET enable_plan_cache TO on`                 | `SELECT 1`                            | true      |
 * | `SET SESSION enable_plan_cache = on`          | `SELECT 1`                            | true      |
 * | `SET LOCAL enable_plan_cache = off`           | `SELECT 1`                            | true      |
 * | `SHOW plan_cache_mode`                        | `SELECT 'auto' as plan_cache_mode`    | true      |
 * | `SELECT pg_prewarm('t')`                      | `SELECT 1`                            | true      |
 * | `SELECT pg_prewarm('my_table', 'buffer')`     | `SELECT 1`                            | true      |
 * | `SELECT 1`                                    | (pass-through)                        | false     |
 * | `CREATE TABLE t (id int)`                     | (pass-through)                        | false     |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on SQL that merely contains matching identifiers
 *   inside strings, comments, or subqueries
 * - Detection is conservative: only top-level statements that start with
 *   the relevant keyword are rewritten
 * - PinoLogger integration for debugging and audit trails
 *
 * @module QueryCacheShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { PgCatalog } from '../system/PgCatalog';

const logger = PinoLogger.forComponent('QueryCacheShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface QueryCacheResult {
  /** Rewritten SQL (no-op SELECT, or original if pass-through) */
  sql: string;
  /** Whether the statement was detected as cache-related and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  pg_prewarm helpers
// ──────────────────────────────────────────────

/**
 * Extract the oid from `SELECT pg_prewarm(oid)`.
 * Handles both numeric oids and quoted table names.
 *
 * Examples:
 *   `SELECT pg_prewarm(16384)` → 16384
 *   `SELECT pg_prewarm('16384')` → 16384
 *   `SELECT pg_prewarm('my_table')` → null (string name, not oid)
 *   `SELECT pg_prewarm('my_table', 'buffer')` → null
 *
 * @param sql The raw SQL string
 * @returns The numeric oid, or null if the argument is not a numeric oid
 */
export function extractPgPrewarmOid(sql: string): number | null {
  const match = sql.trim().match(
    /^\s*SELECT\s+pg_prewarm\s*\(\s*(?:'?\s*(\d+)\s*'?)\s*(?:,.*)?\)\s*;?\s*$/i,
  );
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Resolve a numeric oid to a table name using PgCatalog.
 *
 * @param oid The pg_class oid to resolve
 * @returns The table name, or null if not found
 */
export function resolveOidToTable(oid: number): string | null {
  try {
    const classRows = PgCatalog.getClassRows();
    const row = classRows.find((r: any) => r.oid === oid && r.relkind === 'r');
    return row?.relname ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract the first argument from pg_prewarm (could be table name or oid).
 * Returns the raw argument string (without quotes).
 */
export function extractPgPrewarmFirstArg(sql: string): string | null {
  const match = sql.trim().match(
    /^\s*SELECT\s+pg_prewarm\s*\(\s*'([^']+)'\s*(?:,.*)?\)\s*;?\s*$/i,
  );
  if (match) {
    return match[1];
  }
  // Try numeric (without quotes)
  const numMatch = sql.trim().match(
    /^\s*SELECT\s+pg_prewarm\s*\(\s*(\d+)\s*(?:,.*)?\)\s*;?\s*$/i,
  );
  if (numMatch) {
    return numMatch[1];
  }
  return null;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches SET enable_plan_cache with either = or TO syntax, with optional
 * SESSION/LOCAL prefix and optional trailing semicolon:
 *
 *   SET enable_plan_cache = on
 *   SET enable_plan_cache = off
 *   SET enable_plan_cache TO on
 *   SET SESSION enable_plan_cache = on
 *   SET LOCAL enable_plan_cache = off
 */
const SET_PLAN_CACHE_PATTERN =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?enable_plan_cache\s*(?:=|TO)\s*(?:on|off)\s*;?\s*$/i;

/**
 * Matches SHOW plan_cache_mode:
 *
 *   SHOW plan_cache_mode
 *   SHOW plan_cache_mode;
 */
const SHOW_PLAN_CACHE_PATTERN = /^\s*SHOW\s+plan_cache_mode\s*;?\s*$/i;

/**
 * Matches SELECT pg_prewarm(...):
 *
 *   SELECT pg_prewarm('t')
 *   SELECT pg_prewarm('my_table')
 *   SELECT pg_prewarm('t', 'buffer')
 *   select pg_prewarm('my_table', 'main', 'prewarm')
 *
 * pg_prewarm is a function call, so the pattern matches:
 *   SELECT\s+pg_prewarm\(...\)
 *
 * We are intentionally broad on the arguments: any invocation of
 * pg_prewarm (single or multiple arguments) is treated as a cache
 * operation.
 */
const PG_PREWARM_PATTERN = /^\s*SELECT\s+(?:pg_catalog\.)?pg_prewarm\s*\(.*\)\s*;?\s*$/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL query-cache
 * related statement that should be rewritten for SQLite compatibility.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a cache-related PG statement
 *
 * @example
 * ```ts
 * detectQueryCache("SET enable_plan_cache = on");        // true
 * detectQueryCache("SHOW plan_cache_mode");               // true
 * detectQueryCache("SELECT pg_prewarm('t')");             // true
 * detectQueryCache("SELECT * FROM users");                // false
 * ```
 */
export function detectQueryCache(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast path: check for keyword prefixes before running full regex
  const upper = trimmed.toUpperCase();
  const hasSetEnable = /^\s*SET\s+/i.test(trimmed) &&
    /enable_plan_cache/i.test(trimmed);
  const hasShow = /^\s*SHOW\s+/i.test(trimmed) &&
    /plan_cache_mode/i.test(trimmed);
  const hasPrewarm = /^\s*SELECT\s+/i.test(trimmed) &&
    /pg_prewarm\s*\(/i.test(trimmed);

  if (!hasSetEnable && !hasShow && !hasPrewarm) {
    return false;
  }

  // Confirm with specific regex
  if (SET_PLAN_CACHE_PATTERN.test(trimmed)) {
    return true;
  }

  if (SHOW_PLAN_CACHE_PATTERN.test(trimmed)) {
    return true;
  }

  if (PG_PREWARM_PATTERN.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL query-cache related SQL statement to an
 * SQLite-compatible no-op.
 *
 * **Processing rules:**
 *
 * | Input                                          | Output                              |
 * |------------------------------------------------|-------------------------------------|
 * | `SET enable_plan_cache = on`                   | `SELECT 1`                          |
 * | `SET SESSION enable_plan_cache = off`          | `SELECT 1`                          |
 * | `SHOW plan_cache_mode`                         | `SELECT 'auto' as plan_cache_mode`  |
 * | `SELECT pg_prewarm('my_table')`                | `SELECT 1`                          |
 * | Non-cache SQL                                  | pass-through unchanged              |
 * | Empty / non-string                             | pass-through with `rewritten: false` |
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link QueryCacheResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteQueryCache("SET enable_plan_cache = on");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteQueryCache("SHOW plan_cache_mode");
 * // → { sql: "SELECT 'auto' as plan_cache_mode", rewritten: true }
 *
 * rewriteQueryCache("SELECT pg_prewarm('orders')");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteQueryCache("SELECT * FROM users");
 * // → { sql: "SELECT * FROM users", rewritten: false }
 * ```
 */
export function rewriteQueryCache(sql: string): QueryCacheResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: SET enable_plan_cache → SELECT 1 ──────────────

  if (SET_PLAN_CACHE_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SET enable_plan_cache detected — rewriting to SELECT 1',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 2: SHOW plan_cache_mode → SELECT 'auto' as plan_cache_mode ──

  if (SHOW_PLAN_CACHE_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SHOW plan_cache_mode detected — rewriting to SELECT literal',
    );
    return {
      sql: "SELECT 'auto' as plan_cache_mode",
      rewritten: true,
    };
  }

  // ── Step 3: SELECT pg_prewarm(...) → prewarm (SELECT COUNT(*) FROM table) ──

  if (PG_PREWARM_PATTERN.test(trimmed)) {
    // Try to resolve oid → table name for actual prewarming
    let prewarmSql = 'SELECT 1';

    const oid = extractPgPrewarmOid(trimmed);
    if (oid !== null) {
      const tableName = resolveOidToTable(oid);
      if (tableName) {
        // Quote the table name to handle reserved words and special chars
        const quotedName = `"${tableName.replace(/"/g, '""')}"`;
        prewarmSql = `SELECT COUNT(*) FROM ${quotedName}`;
        logger.debug(
          { sql: trimmed, oid, tableName },
          `SELECT pg_prewarm() — rewriting to SELECT COUNT(*) for ${tableName}`,
        );
      } else {
        logger.warn(
          { sql: trimmed, oid },
          'SELECT pg_prewarm() — oid not found in pg_class, falling back to SELECT 1',
        );
      }
    } else {
      // Try using the first arg as a table name directly
      const tableArg = extractPgPrewarmFirstArg(trimmed);
      if (tableArg && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableArg)) {
        const quotedName = `"${tableArg.replace(/"/g, '""')}"`;
        prewarmSql = `SELECT COUNT(*) FROM ${quotedName}`;
        logger.debug(
          { sql: trimmed, tableName: tableArg },
          `SELECT pg_prewarm() — rewriting to SELECT COUNT(*) for ${tableArg} (name)`,
        );
      } else {
        logger.debug(
          { sql: trimmed },
          'SELECT pg_prewarm() — no oid or valid table name found, falling back to SELECT 1',
        );
      }
    }

    return {
      sql: prewarmSql,
      rewritten: true,
    };
  }

  // ── Step 4: Not cache-related — pass through ──────────────

  return {
    sql: trimmed,
    rewritten: false,
  };
}

// ── G23: QueryCacheShim — actual query result cache ──────────────

import type { PGliteEvalResult } from './PGliteEngine';

export interface CacheEntry {
  result: PGliteEvalResult;
  ts: number;
  tables: string[];
}

export class QueryCacheShim {
  /**
   * Internal cache using Map insertion order for LRU tracking.
   * - Most recently accessed entries are at the end of the Map.
   * - Least recently used entries are at the front.
   * - Every `get()` re-inserts the entry to move it to the end.
   */
  private cache = new Map<string, CacheEntry>();
  private maxSize = 100;

  /**
   * Create a QueryCacheShim with the given max size.
   * @param maxSize - Maximum number of entries before LRU eviction (default 100)
   */
  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  /**
   * Whether the cache is enabled.
   */
  private _enabled = true;

  /**
   * Get the enabled state.
   */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Enable or disable the cache.
   */
  set enabled(val: boolean) {
    this._enabled = val;
    if (!val) {
      this.cache.clear();
    }
  }

  /**
   * Get a cached result by key.
   * Re-inserts the entry to maintain LRU ordering (most recently used at tail).
   * @param key  - Cache key (typically the normalized SQL)
   * @param ttlMs - Optional TTL in milliseconds; returns null if entry is stale
   * @returns Cached PGliteEvalResult, or null if not found or expired
   */
  get(key: string, ttlMs?: number): PGliteEvalResult | null {
    if (!this._enabled) return null;

    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check TTL if specified
    if (ttlMs !== undefined && (Date.now() - entry.ts) > ttlMs) {
      this.cache.delete(key);
      logger.debug({ key: key.substring(0, 60) }, 'Query cache entry expired (TTL)');
      return null;
    }

    // Re-insert to move this entry to the tail (most recently used)
    entry.ts = Date.now();
    this.cache.delete(key);
    this.cache.set(key, entry);

    logger.debug({ key: key.substring(0, 60) }, 'Query cache hit');
    return entry.result;
  }

  /**
   * Store a result in the cache.
   * New entries are inserted at the tail (most recently used position).
   * If at capacity, the head entry (least recently used) is evicted.
   * @param key    - Cache key
   * @param result - PGliteEvalResult to cache
   * @param tables - Tables involved (for invalidation)
   */
  set(key: string, result: PGliteEvalResult, tables: string[] = []): void {
    if (!this._enabled) return;

    // If the key already exists, delete it so the re-insertion goes to the tail
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict LRU (head of Map) if at capacity
    if (this.cache.size >= this.maxSize) {
      const lruKey = this.cache.keys().next().value;
      // Unreachable false side: `size >= maxSize` with `maxSize >= 1` (the
      // constructor default and setMaxSize clamp both enforce >= 1) guarantees
      // a non-empty map, so the LRU head key is always defined.
      /* c8 ignore next */
      if (lruKey !== undefined) {
        this.cache.delete(lruKey);
        logger.debug(
          { evictedKey: lruKey.substring(0, 60) },
          'Query cache LRU eviction',
        );
      }
    }

    this.cache.set(key, {
      result,
      ts: Date.now(),
      tables: [...tables],
    });

    logger.debug(
      { key: key.substring(0, 60), tables: tables.length, size: this.cache.size },
      'Query cache set',
    );
  }

  /**
   * Invalidate all cache entries that involve the given table.
   * @param table - Table name to invalidate
   */
  invalidate(table: string): void {
    const tableLower = table.toLowerCase();
    let invalidated = 0;

    for (const [key, entry] of this.cache) {
      if (entry.tables.some((t) => t.toLowerCase() === tableLower)) {
        this.cache.delete(key);
        invalidated++;
      }
    }

    if (invalidated > 0) {
      logger.debug({ table, invalidated }, 'Query cache invalidated');
    }
  }

  /**
   * Clear all caches.
   */
  clear(): void {
    this.cache.clear();
    logger.debug('Query cache cleared');
  }

  /**
   * Get current cache size.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Get maximum cache size.
   */
  getMaxSize(): number {
    return this.maxSize;
  }

  /**
   * Set maximum cache size. If the current size exceeds the new limit,
   * entries are evicted (LRU first) until the cache fits.
   * @param size - New maximum cache size
   */
  setMaxSize(size: number): void {
    if (size < 1) {
      logger.warn({ requestedSize: size }, 'setMaxSize: size must be >= 1, clamping to 1');
      size = 1;
    }
    this.maxSize = size;

    // Evict LRU entries (from Map head) if over the new limit
    while (this.cache.size > this.maxSize) {
      const lruKey = this.cache.keys().next().value;
      // Unreachable false side: `size > maxSize` with `maxSize >= 1` (clamped
      // above) guarantees a non-empty map, so the LRU head key is always defined.
      /* c8 ignore next */
      if (lruKey !== undefined) {
        this.cache.delete(lruKey);
      }
    }

    logger.debug({ maxSize: size, currentSize: this.cache.size }, 'Query cache max size updated');
  }
}
