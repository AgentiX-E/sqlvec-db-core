/**
 * PreparedStatementManager — PREPARE/EXECUTE/DEALLOCATE statement lifecycle
 *
 * Manages prepared statements in-memory. Supports:
 * - PREPARE name (type1, type2) AS sql
 * - EXECUTE name (val1, val2)
 * - DEALLOCATE name / DEALLOCATE ALL
 * - LIST all prepared statements
 * - LRU eviction when cache exceeds max size
 *
 * @module query/PreparedStatementManager
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('PreparedStatementManager');

export interface PreparedStatement {
  /** The original SQL with parameter placeholders ($1, $2, etc.) */
  sql: string;
  /** Parameter type names as declared in PREPARE */
  paramTypes: string[];
  /** Parsed AST (if available) */
  parsed: any;
  /** Creation timestamp */
  createdAt: number;
}

export class PreparedStatementManager {
  private statements = new Map<string, PreparedStatement>();
  /** Track access order with a monotonically increasing sequence counter */
  private accessOrder = new Map<string, number>();
  /** Monotonically increasing access sequence counter */
  private accessSeq = 0;
  /** Maximum number of cached statements (default: 1000) */
  private maxCacheSize: number;

  constructor(maxCacheSize: number = 1000) {
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * Prepare a new statement.
   * If at capacity, evicts the least recently used statement first.
   * Throws if a statement with the same name already exists.
   *
   * @param name - Statement name (case-insensitive)
   * @param sql - SQL with $1, $2, ... placeholders
   * @param paramTypes - Array of type names
   */
  prepare(name: string, sql: string, paramTypes: string[]): void {
    const key = this.normalizeName(name);
    if (this.statements.has(key)) {
      throw new Error(`Prepared statement "${name}" already exists`);
    }

    // Auto-evict if at capacity
    if (this.statements.size >= this.maxCacheSize) {
      const evicted = this.evict(1);
      if (evicted.length > 0) {
        logger.debug({ evicted: evicted[0] }, 'LRU eviction: removed oldest prepared statement');
      }
    }

    // Emit warning if approaching capacity
    const usagePercent = (this.statements.size / this.maxCacheSize) * 100;
    if (usagePercent > 80) {
      logger.warn(
        { cacheSize: this.statements.size, maxCacheSize: this.maxCacheSize, usagePercent: usagePercent.toFixed(1) },
        'Prepared statement cache approaching capacity (>80% full)',
      );
    }

    const stmt: PreparedStatement = {
      sql,
      paramTypes,
      parsed: null,
      createdAt: Date.now(),
    };

    this.statements.set(key, stmt);
    this.accessOrder.set(key, ++this.accessSeq);
    logger.debug({ name: key, sql: sql.substring(0, 80) }, 'Prepared statement registered');
  }

  /**
   * Execute a prepared statement with the given parameters.
   * Marks the statement as recently used (for LRU tracking).
   * Substitutes $N placeholders with actual values.
   *
   * @param name - Statement name
   * @param params - Array of parameter values
   * @returns The substituted SQL and the raw params
   * @throws If the statement doesn't exist or param count mismatches
   */
  execute(name: string, params: any[]): { sql: string; params: any[] } {
    const key = this.normalizeName(name);
    const stmt = this.statements.get(key);
    if (!stmt) {
      throw new Error(`Prepared statement "${name}" not found`);
    }

    // Mark as recently used
    this.accessOrder.set(key, ++this.accessSeq);

    // Validate parameter count
    const placeholderCount = (stmt.sql.match(/\$(\d+)/g) || []).length;
    if (placeholderCount > 0 && params.length !== placeholderCount) {
      throw new Error(
        `Prepared statement "${name}" expects ${placeholderCount} parameters, but ${params.length} were provided`,
      );
    }

    // Substitute $1, $2, ... with escaped parameter values
    let substitutedSql = stmt.sql;
    for (let i = 0; i < params.length; i++) {
      const placeholder = `$${i + 1}`;
      const escapedValue = this.escapeParam(params[i]);
      substitutedSql = substitutedSql.replace(
        new RegExp(`\\${placeholder}(?![0-9])`, 'g'),
        escapedValue,
      );
    }

    logger.debug(
      { name: key, params },
      'Prepared statement executed',
    );

    return { sql: substitutedSql, params };
  }

  /**
   * Deallocate (remove) a prepared statement.
   * If name is 'ALL', deallocates all statements.
   *
   * @param name - Statement name to deallocate, or 'ALL'
   * @returns true if the statement was found and removed
   */
  deallocate(name: string): boolean {
    const upper = name.toUpperCase();
    if (upper === 'ALL') {
      return this.clearCache();
    }

    const key = this.normalizeName(name);
    const existed = this.statements.delete(key);
    this.accessOrder.delete(key);
    if (existed) {
      logger.debug({ name: key }, 'Prepared statement deallocated');
    }
    return existed;
  }

  /**
   * List all prepared statement names.
   */
  list(): string[] {
    return Array.from(this.statements.keys());
  }

  /**
   * Get a prepared statement by name.
   * Does NOT mark as recently used (use execute() for that).
   */
  get(name: string): PreparedStatement | undefined {
    const key = this.normalizeName(name);
    return this.statements.get(key);
  }

  /**
   * Check if a prepared statement exists.
   */
  has(name: string): boolean {
    const key = this.normalizeName(name);
    return this.statements.has(key);
  }

  /**
   * Clear all prepared statements.
   */
  clear(): void {
    this.statements.clear();
    this.accessOrder.clear();
    logger.debug('All prepared statements cleared');
  }

  /**
   * Get stats about prepared statements.
   */
  getStats(): { count: number; names: string[] } {
    return {
      count: this.statements.size,
      names: this.list(),
    };
  }

  // ════════════════════════════════════════════════
  //  LRU Cache Management
  // ════════════════════════════════════════════════

  /**
   * Get the current number of cached statements.
   */
  getCacheSize(): number {
    return this.statements.size;
  }

  /**
   * Get the maximum cache size.
   */
  getCacheMax(): number {
    return this.maxCacheSize;
  }

  /**
   * Set the maximum cache size.
   * If the new max is smaller than the current size, evicts the oldest entries.
   *
   * @param max - The new maximum cache size
   */
  setCacheMax(max: number): void {
    if (max < 1) {
      throw new Error('Cache max size must be at least 1');
    }
    this.maxCacheSize = max;
    if (this.statements.size > max) {
      const toEvict = this.statements.size - max;
      this.evict(toEvict);
    }
    logger.debug({ maxCacheSize: max }, 'Prepared statement cache max updated');
  }

  /**
   * Explicitly evict N least recently used entries.
   *
   * @param count - Number of entries to evict
   * @returns Array of evicted statement names
   */
  evict(count: number): string[] {
    if (count <= 0) return [];

    const evicted: string[] = [];

    // Sort by access time (oldest first)
    const sorted = [...this.accessOrder.entries()]
      .sort((a, b) => a[1] - b[1]);

    const toEvict = Math.min(count, sorted.length);
    for (let i = 0; i < toEvict; i++) {
      const [key] = sorted[i];
      this.statements.delete(key);
      this.accessOrder.delete(key);
      evicted.push(key);
    }

    if (evicted.length > 0) {
      logger.debug({ count: evicted.length, evicted }, 'LRU eviction performed');
    }

    return evicted;
  }

  /**
   * Clear all cached statements.
   *
   * @returns true if any statements were cleared
   */
  clearCache(): boolean {
    const count = this.statements.size;
    this.statements.clear();
    this.accessOrder.clear();
    if (count > 0) {
      logger.debug({ count }, 'All prepared statements deallocated');
    }
    return count > 0;
  }

  /**
   * Normalize statement name (case-insensitive).
   */
  private normalizeName(name: string): string {
    return name.toLowerCase();
  }

  /**
   * Escape a parameter value for safe SQL substitution.
   */
  private escapeParam(value: any): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE';
    }
    if (typeof value === 'number') {
      return String(value);
    }
    if (typeof value === 'string') {
      // Escape single quotes by doubling them
      const escaped = value.replace(/'/g, "''");
      return `'${escaped}'`;
    }
    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }
    if (Array.isArray(value)) {
      return `'${JSON.stringify(value)}'`;
    }
    if (typeof value === 'object') {
      return `'${JSON.stringify(value)}'`;
    }
    return String(value);
  }
}
