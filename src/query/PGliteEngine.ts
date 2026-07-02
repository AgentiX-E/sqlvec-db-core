/**
 * PGliteEngine — In-memory PostgreSQL evaluation via @electric-sql/pglite
 *
 * Wraps PGlite as an optional SQL evaluation engine for the QueryRouter.
 * Used for executing SQL that requires PostgreSQL-specific dialect features
 * (window functions, CTEs, full-text search) during shard-local evaluation.
 *
 * Production enhancements (G8):
 * - Connection timeout: default 30s, configurable per call
 * - LRU cache: caches most recent 100 query results
 * - Concurrency control: async-mutex Mutex serializes access
 * - Start retry: up to 3 retries with exponential backoff
 *
 * Track I3: PGlite SQL Engine Evaluation
 */

import { Mutex } from 'async-mutex';
import { PinoLogger } from '../monitoring/PinoLogger';
import { QueryCacheShim } from './QueryCacheShim';
import type { PGlite } from '@electric-sql/pglite';
import Database from 'better-sqlite3';

const logger = PinoLogger.forComponent('PGliteEngine');

export interface PGliteEvalResult {
  columns: string[];
  rows: any[];
  error?: string;
}

export class PGliteEngine {
  private pg: PGlite | null = null;
  private _ready: boolean = false;
  private readonly connectionTimeout: number;
  private readonly mutex = new Mutex();
  private readonly queryCache = new QueryCacheShim(100);
  private readonly CACHE_TTL = 60_000; // 60 seconds TTL for cached results

  /** Fallback database (better-sqlite3) used when PGlite is unavailable. */
  private fallbackDb: Database.Database;
  /** Whether the engine is currently using the fallback database. */
  private _usingFallback = false;

  constructor(connectionTimeout: number = 30000) {
    this.connectionTimeout = connectionTimeout;
    this.fallbackDb = new Database(':memory:');
  }

  /**
   * Start the PGlite engine with retry logic.
   * Retries up to 3 times with exponential backoff.
   */
  async start(): Promise<void> {
    if (this._ready) return;

    let lastError: Error | null = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.connectionTimeout);

        try {
          const { PGlite } = await import('@electric-sql/pglite');
          this.pg = new PGlite();
          await Promise.race([
            (this.pg as any).ready,
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error(`PGliteEngine start timed out after ${this.connectionTimeout}ms`));
              });
            }),
          ]);
          this._ready = true;
          logger.info({ attempt }, 'PGliteEngine started successfully');
          clearTimeout(timeoutId);
          return;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err: any) {
        lastError = err;
        this._ready = false;
        this.pg = null;

        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          logger.warn(
            { attempt, maxRetries, backoffMs, error: err.message },
            'PGliteEngine start attempt failed, retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    this._ready = false;
    logger.error({ error: lastError?.message }, 'PGliteEngine failed to start after all retries');
    throw new Error(
      `PGliteEngine failed to start after ${maxRetries} retries: ${lastError?.message}`,
    );
  }

  /**
   * Stop the PGlite engine and release resources.
   */
  async stop(): Promise<void> {
    if (this.pg) {
      try {
        await this.pg.close();
      } catch {
        // Ignore close errors
      }
    }
    this.pg = null;
    this._ready = false;
    this._usingFallback = false;
    this.queryCache.clear();
    try {
      this.fallbackDb.close();
    } catch {
      // Ignore close errors
    }
    logger.info('PGliteEngine stopped');
  }

  /**
   * Whether the engine is ready for queries.
   */
  get ready(): boolean {
    return this._ready;
  }

  /**
   * Evaluate a SQL statement on the in-memory PostgreSQL instance.
   *
   * Features:
   * - LRU cache: caches last 100 SELECT results (TTL 60s)
   * - Timeout: configurable per call, default connectionTimeout
   * - Mutex: serializes all access to the underlying PGlite instance
   *
   * @param sql - SQL statement to execute
   * @param timeoutMs - Optional timeout override (default: connectionTimeout)
   */
  async evaluate(sql: string, timeoutMs?: number): Promise<PGliteEvalResult> {
    if (!this._ready || !this.pg) {
      return {
        columns: [],
        rows: [],
        error: 'PGliteEngine not started. Call start() first.',
      };
    }

    const effectiveTimeout = timeoutMs ?? this.connectionTimeout;
    const trimmedSql = sql.trim();
    const isSelect = /^\s*SELECT\b/i.test(trimmedSql);

    // ── 0. Fallback to better-sqlite3 if PGlite is not ready ──
    if (!this._ready || !this.pg) {
      try {
        const rows = this.fallbackDb.prepare(trimmedSql).all() as any[];
        const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
        const result: PGliteEvalResult = { columns: cols, rows };
        this._usingFallback = true;
        return result;
      } catch (fallbackErr: any) {
        this._usingFallback = true;
        return {
          columns: [],
          rows: [],
          error: `PGliteEngine fallback error: ${fallbackErr.message}`,
        };
      }
    }

    const normalizedSql = this.normalizeCacheKey(trimmedSql);

    // ── 1. Check cache (SELECT only) ──────────────────────────
    if (isSelect) {
      const cached = this.queryCache.get(normalizedSql, this.CACHE_TTL);
      if (cached) {
        logger.debug({ sql: trimmedSql.substring(0, 60) }, 'Cache hit');
        return cached;
      }
    }

    // ── 2. Acquire mutex lock ─────────────────────────────────
    const release = await this.mutex.acquire();
    try {
      // ── 3. Execute with timeout ─────────────────────────────
      const result = await this.executeWithTimeout(trimmedSql, effectiveTimeout);

      // ── 4. Write to cache (SELECT only, no error) ───────────
      if (isSelect && !result.error) {
        this.queryCache.set(normalizedSql, result);
      }

      return result;
    } finally {
      release();
    }
  }

  /**
   * Execute a SQL query with timeout using Promise.race.
   * On PGlite error, falls back to better-sqlite3.
   */
  private async executeWithTimeout(sql: string, timeoutMs: number): Promise<PGliteEvalResult> {
    try {
      const execPromise = this.doExec(sql);

      if (timeoutMs > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`PGlite query timed out after ${timeoutMs}ms: ${sql.substring(0, 80)}`));
          }, timeoutMs);
        });

        const results = await Promise.race([execPromise, timeoutPromise]);
        return results;
      }

      return await execPromise;
    } catch (err: any) {
      // Check if it's a timeout error
      if (err.message && err.message.includes('timed out')) {
        return {
          columns: [],
          rows: [],
          error: err.message,
        };
      }

      // PGlite execution error → log warning and fallback to better-sqlite3
      logger.warn({ error: err.message, sql: sql.substring(0, 80) }, 'PGlite query failed, falling back to better-sqlite3');
      this._usingFallback = true;
      try {
        const rows = this.fallbackDb.prepare(sql).all() as any[];
        const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
        return { columns: cols, rows };
      } catch (fallbackErr: any) {
        return {
          columns: [],
          rows: [],
          error: `PGlite+fallback error: PGlite: ${err.message}, fallback: ${fallbackErr.message}`,
        };
      }
    }
  }

  /**
   * Execute SQL against PGlite.
   */
  private async doExec(sql: string): Promise<PGliteEvalResult> {
    if (!this.pg) {
      return {
        columns: [],
        rows: [],
        error: 'PGliteEngine not started. Call start() first.',
      };
    }

    const results = await this.pg.exec(sql);
    if (!results || results.length === 0) {
      return { columns: [], rows: [] };
    }

    // PGlite.exec() returns an array of result objects
    const firstResult = results[0];
    const columns: string[] = firstResult.fields
      ? firstResult.fields.map((f: any) => f.name)
      : [];
    const rows: any[] = firstResult.rows || [];

    return { columns, rows };
  }

  /**
   * Normalize a SQL string to produce a canonical cache key.
   * - Lowercases the string
   * - Collapses consecutive whitespace to single space
   * - Strips trailing semicolons
   */
  private normalizeCacheKey(sql: string): string {
    return sql
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/;+$/, '')
      .trim();
  }

  /**
   * Clear the LRU cache.
   */
  clearCache(): void {
    this.queryCache.clear();
    logger.debug('PGliteEngine cache cleared');
  }

  /**
   * Get current cache stats.
   */
  getCacheStats(): { size: number; maxSize: number; ttlMs: number } {
    return {
      size: this.queryCache.size(),
      maxSize: this.queryCache.getMaxSize(),
      ttlMs: this.CACHE_TTL,
    };
  }

  /**
   * Set maximum cache size.
   * Adjusts eviction behavior if the current cache exceeds the new limit.
   * @param size - Maximum number of cached entries
   */
  setMaxCacheSize(size: number): void {
    this.queryCache.setMaxSize(size);
    logger.debug({ maxSize: size }, 'PGliteEngine max cache size updated');
  }

  /**
   * Check if PGlite supports the given SQL dialect feature.
   * PGlite is a PostgreSQL-compatible engine, so it supports most PostgreSQL features.
   */
  supportsFeature(
    feature: 'window' | 'cte' | 'fts' | 'join' | 'subquery',
  ): boolean {
    switch (feature) {
      case 'window':
        return true; // PostgreSQL natively supports window functions
      case 'cte':
        return true; // PostgreSQL natively supports CTEs (WITH)
      case 'fts':
        return true; // PostgreSQL natively supports full-text search
      case 'join':
        return true; // PostgreSQL supports all JOIN types
      case 'subquery':
        return true; // PostgreSQL supports subqueries
      default:
        return false;
    }
  }

  /**
   * Health check returning engine status and whether fallback is active.
   */
  healthCheck(): { healthy: boolean; usingFallback: boolean } {
    return {
      healthy: this._ready || this._usingFallback,
      usingFallback: this._usingFallback,
    };
  }
}
