/**
 * DuckDBExecutor — Execute analytic queries against DuckDB columnar engine.
 *
 * Wraps DuckDBRouter.tryRouteDuckDB() for use by the UnifiedRouter pipeline.
 *
 * ## Integration
 * ```
 * UnifiedRouter
 *   ├─ decid() → 'duckdb_olap'
 *   └─ execute() → DuckDBExecutor.execute()
 *       └─ tryRouteDuckDB(sql, duckDB, start, classifier, parsed, ctx, fedClient)
 *           └─ DuckDB result or fallback indicator
 * ```
 */

import { PinoLogger } from '../logger/PinoLogger';
import { DuckDBAnalyticsManager } from '../analytics/DuckDBAnalyticsManager';
import {
  AnalyticQueryClassifier,
  QueryClassifierContext,
} from '../analytics/AnalyticQueryClassifier';
import { ParsedStatement } from './SqlParser';
import type { AnalyticsFederationClient } from '../analytics/AnalyticsFederationClient';
import { tryRouteDuckDB, DuckDBRouteResult } from './DuckDBRouter';

const logger = PinoLogger.forComponent('DuckDBExecutor');

export interface DuckDBExecutorConfig {
  /** DuckDB analytics manager */
  duckDBAnalytics: DuckDBAnalyticsManager;
  /** Optional: analytic query classifier for intelligent routing */
  analyticClassifier?: AnalyticQueryClassifier;
  /** Optional: federation client for distributed execution */
  analyticsFederation?: AnalyticsFederationClient;
}

export interface DuckDBExecResult {
  rows: any[];
  rowCount: number;
  queryTimeMs: number;
  engine: 'duckdb' | 'duckdb_federated';
  federated?: boolean;
  routed: boolean;
  reason?: string;
}

/**
 * Execute analytic queries against DuckDB columnar engine.
 *
 * Delegates to DuckDBRouter.tryRouteDuckDB() for actual routing + execution.
 * Used by UnifiedRouter as the DuckDB execution backend.
 */
export class DuckDBExecutor {
  private readonly config: DuckDBExecutorConfig;

  constructor(config: DuckDBExecutorConfig) {
    this.config = config;
  }

  /**
   * Try to execute a query via DuckDB.
   * Returns { routed: true, ... } if successful, { routed: false, ... } if not routable.
   */
  async execute(
    sql: string,
    startTime: number,
    parsed?: ParsedStatement,
    ctx?: QueryClassifierContext,
  ): Promise<DuckDBExecResult> {
    const { duckDBAnalytics, analyticClassifier, analyticsFederation } = this.config;

    const routeResult: DuckDBRouteResult = await tryRouteDuckDB(
      sql,
      duckDBAnalytics,
      startTime,
      analyticClassifier,
      parsed,
      ctx,
      analyticsFederation,
    );

    if (!routeResult.routed) {
      return {
        rows: [],
        rowCount: 0,
        queryTimeMs: Date.now() - startTime,
        engine: 'duckdb',
        routed: false,
        reason: routeResult.reason,
      };
    }

    // Successfully routed to DuckDB
    if (routeResult.result) {
      return {
        rows: routeResult.result.rows,
        rowCount: routeResult.result.rowCount,
        queryTimeMs: routeResult.result.queryTimeMs,
        engine: analyticsFederation ? 'duckdb_federated' : 'duckdb',
        federated: !!analyticsFederation,
        routed: true,
      };
    }

    // Shouldn't reach here — if routed is true, result should exist
    return {
      rows: [],
      rowCount: 0,
      queryTimeMs: Date.now() - startTime,
      engine: 'duckdb',
      routed: false,
      reason: 'Route result missing',
    };
  }

  /**
   * Quick check if DuckDB is available for routing.
   */
  get isAvailable(): boolean {
    return this.config.duckDBAnalytics.isAvailable;
  }

  /**
   * Get the underlying DuckDBAnalyticsManager.
   */
  get manager(): DuckDBAnalyticsManager {
    return this.config.duckDBAnalytics;
  }
}
