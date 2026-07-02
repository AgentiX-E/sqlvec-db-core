/**
 * CostEstimator — Estimate query execution cost to guide OLTP/OLAP routing.
 *
 * ## Purpose
 * Provides a cost-based signal for UnifiedRouter to choose between SQLite (OLTP)
 * and DuckDB (OLAP) execution. The estimator uses table-level row counts and
 * query structure to produce a confidence score.
 *
 * ## Thresholds
 * - Row count > ANALYTIC_THRESHOLD (default 10,000): DuckDB preferred
 * - Aggregate functions: DuckDB preferred
 * - Otherwise: SQLite (lower latency for simple queries)
 *
 * ## Integration
 * ```
 * UnifiedRouter.decide()
 *   ├─ Config override (highest priority)
 *   ├─ Classifier (P0+, checked first)
 *   └─ CostEstimator (optional, when classifier unavailable)
 * ```
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { ParsedStatement } from './SqlParser';

const logger = PinoLogger.forComponent('CostEstimator');

export interface TableStats {
  /** Table name (lowercase) */
  tableName: string;
  /** Estimated row count */
  rowCount: number;
  /** Last updated timestamp */
  updatedAt: number;
}

export interface CostEstimate {
  /** Estimated row count for the query */
  estimatedRows: number;
  /** Whether DuckDB analytics engine is recommended */
  recommendDuckDB: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Human-readable reason */
  reason: string;
}

export interface CostEstimatorConfig {
  /** Row count threshold above which DuckDB is preferred (default: 10,000) */
  analyticThreshold: number;
  /** Whether to enable cost estimation for all queries */
  enabled: boolean;
}

const DEFAULT_CONFIG: CostEstimatorConfig = {
  analyticThreshold: 10_000,
  enabled: true,
};

/**
 * Estimate query cost based on table statistics and query structure.
 */
export class CostEstimator {
  private readonly config: CostEstimatorConfig;
  private readonly tableStats: Map<string, TableStats> = new Map();

  constructor(config?: Partial<CostEstimatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Update or add a table's estimated row count.
   */
  updateTableStats(tableName: string, rowCount: number): void {
    this.tableStats.set(tableName.toLowerCase(), {
      tableName: tableName.toLowerCase(),
      rowCount,
      updatedAt: Date.now(),
    });
  }

  /**
   * Update multiple table stats at once.
   */
  updateBulk(entries: Array<{ tableName: string; rowCount: number }>): void {
    for (const e of entries) {
      this.updateTableStats(e.tableName, e.rowCount);
    }
  }

  /**
   * Get stored stats for a table.
   */
  getTableStats(tableName: string): TableStats | undefined {
    return this.tableStats.get(tableName.toLowerCase());
  }

  /**
   * Get all stored table statistics.
   */
  getAllStats(): Map<string, TableStats> {
    return new Map(this.tableStats);
  }

  /**
   * Estimate the cost of executing a query.
   *
   * Analyzes table references, aggregations, and known statistics to
   * recommend the optimal execution engine.
   */
  estimate(sql: string, parsed: ParsedStatement): CostEstimate {
    if (!this.config.enabled) {
      return { estimatedRows: 0, recommendDuckDB: false, confidence: 0, reason: 'cost estimator disabled' };
    }

    // Type-safe access: narrow ParsedStatement union before accessing
    // SelectStatement-only fields. Aggregation is detected from SQL text
    // since the parser doesn't populate a hasAggregation flag.
    const isSelect = parsed.type === 'SELECT';
    const tables: string[] = isSelect ? parsed.tables : [];
    const hasJoin = isSelect ? parsed.hasJoin : false;
    const hasAggregation = /\b(COUNT|SUM|AVG|MIN|MAX|GROUP\s+BY)\b/i.test(sql);

    // No tables referenced — cannot estimate
    if (tables.length === 0) {
      return { estimatedRows: 0, recommendDuckDB: false, confidence: 0.5, reason: 'no tables referenced' };
    }

    // Estimate total rows from known stats
    let totalEstimatedRows = 0;
    let knownTables = 0;
    for (const t of tables) {
      const stats = this.tableStats.get(t.toLowerCase());
      if (stats) {
        totalEstimatedRows += stats.rowCount;
        knownTables++;
      }
    }

    // Unknown tables: estimate conservatively
    const unknownTables = tables.length - knownTables;
    if (unknownTables > 0) {
      // Assume 1000 rows per unknown table
      totalEstimatedRows += unknownTables * 1000;
    }

    // Multi-table JOIN → higher cost estimate (DuckDB optimizes joins better)
    if (hasJoin && tables.length > 1) {
      totalEstimatedRows *= 2;
    }

    // Decision logic
    if (hasAggregation || hasJoin || totalEstimatedRows >= this.config.analyticThreshold) {
      const confidence = hasAggregation ? 0.85 : hasJoin ? 0.75 : 0.65;
      const reason = hasAggregation
        ? `aggregation detected (~${this.formatCount(totalEstimatedRows)} rows)`
        : hasJoin
          ? `JOIN between ${tables.length} tables (~${this.formatCount(totalEstimatedRows)} rows)`
          : `estimated ${this.formatCount(totalEstimatedRows)} rows exceeds threshold`;
      return {
        estimatedRows: totalEstimatedRows,
        recommendDuckDB: true,
        confidence,
        reason,
      };
    }

    return {
      estimatedRows: totalEstimatedRows,
      recommendDuckDB: false,
      confidence: 0.9,
      reason: `small query (~${this.formatCount(totalEstimatedRows)} rows) — SQLite preferred`,
    };
  }

  /**
   * Clear all stored statistics.
   */
  clear(): void {
    this.tableStats.clear();
  }

  /**
   * Get total number of tracked tables.
   */
  get trackedTableCount(): number {
    return this.tableStats.size;
  }

  private formatCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }
}
