/**
 * UnifiedRouter — Unified OLTP+OLAP query routing pipeline.
 *
 * Consolidates the 5-path QueryRouter.execute() flow into a single decision +
 * execution interface. The UnifiedRouter is a lightweight orchestrator that:
 *
 * 1. **decide()** — Runs classifier → circuit breaker → config gates to determine
 *    whether a query should go to DuckDB (OLAP) or SQLite (OLTP)
 * 2. **execute()** — Dispatches to DuckDBExecutor or SQLiteExecutor based on decision
 *
 * ## Current Integration
 *
 * UnifiedRouter does NOT replace QueryRouter.execute(). Instead, it plugs into
 * the existing `execSelectFast()` entry point (installed via P1 fix), providing
 * a cleaner abstraction that can be independently tested.
 *
 * ## Future (v3)
 *
 * When QueryRouter.execute() is ready for a full refactor, UnifiedRouter.decide()
 * will replace the SQL Profile Cache check + fast path dispatch, collapsing
 * the 5 parallel paths into a single `decide() → execute()` pipeline.
 *
 * ```
 * QueryRouter.execute()
 *   ├─ Step 0a: SQL rewrite pipeline (strip collar, striDefault, etc.)
 *   ├─ Step 0b: UnifiedRouter.decide(sql, parsed) → DuckDB/SQLite
 *   ├─ Step 0c: UnifiedRouter.execute(decision) → QueryResult
 *   └─ Step 0d: emitRouteMetrics(decision, result)
 * ```
 *
 * @see DuckDBExecutor  — DuckDB execution backend
 * @see SQLiteExecutor  — SQLite execution backend (future)
 * @see RouteDecision   — Shared decision types
 */

import { PinoLogger } from '../logger/PinoLogger';
import { DuckDBExecutor, DuckDBExecResult } from './DuckDBExecutor';
import { RouteDecision, DEFAULT_FALLBACK_DECISION, ExecutionResult } from './RouteDecision';
import {
  AnalyticQueryClassifier,
  QueryTarget,
  QueryClassifierContext,
} from '../analytics/AnalyticQueryClassifier';
import { ParsedStatement } from './SqlParser';
import { RouteMetrics } from '../monitoring/RouteMetrics';
import { CostEstimator } from './CostEstimator';
import { HotQueryCache } from './HotQueryCache';

const logger = PinoLogger.forComponent('UnifiedRouter');

export interface UnifiedRouterConfig {
  /** DuckDB executor for OLAP routing */
  duckDBExecutor: DuckDBExecutor;
  /** Optional: analytic query classifier */
  analyticClassifier?: AnalyticQueryClassifier;
  /** Whether to always route SELECT queries through DuckDB */
  alwaysRouteToDuckDB?: boolean;
  /** Whether to always route through SQLite (debug/override) */
  alwaysRouteToSQLite?: boolean;
  /** Optional: route metrics for observability */
  routeMetrics?: RouteMetrics;
  /** Optional: cost estimator for DuckDB routing */
  costEstimator?: CostEstimator;
  /** Optional: hot query cache for repeated SQL (LRU, default 4096 entries) */
  hotQueryCache?: HotQueryCache;
}

/**
 * Unified OLTP+OLAP query router.
 *
 * Decides whether a query should go through DuckDB (columnar analytics) or
 * SQLite (standard OLTP) based on query structure, classifier rules, and
 * circuit breaker state.
 */
export class UnifiedRouter {
  private readonly config: UnifiedRouterConfig;

  constructor(config: UnifiedRouterConfig) {
    this.config = config;
  }

  /**
   * Decide which engine should execute a query.
   *
   * Order of priority:
   *   0. Hot query cache: return cached decision for repeated SQL (fast path)
   *   1. Config override: alwaysRouteToSQLite → SQLite
   *   2. Config override: alwaysRouteToDuckDB → DuckDB
   *   3. Circuit breaker: if DuckDB repeatedly fails → SQLite
   *   4. Non-SELECT statements (INSERT/UPDATE/DELETE/DDL/TRANSACTION) → SQLite
   *   5. Transaction context (inTransaction === true) → SQLite
   *   6. Classifier (if available + parsed) → DuckDB or SQLite
   *     6a. Cost Estimator → upgrade to DuckDB if query benefits from columnar
   *   7. Default → SQLite (safest default)
   *
   * @param sql     Original SQL string
   * @param parsed  Optional: pre-parsed statement (required for classifier)
   * @param ctx     Optional: query context (transaction state, etc.)
   */
  decide(
    sql: string,
    parsed?: ParsedStatement,
    ctx?: QueryClassifierContext,
  ): RouteDecision {
    const { alwaysRouteToSQLite, alwaysRouteToDuckDB, analyticClassifier, hotQueryCache } = this.config;

    // Priority 0: Hot query cache — return cached decision for repeated SQL
    if (hotQueryCache && !ctx?.inTransaction) {
      const cached = hotQueryCache.get(sql);
      if (cached) return cached;
    }

    // Priority 1: Config override — force SQLite
    if (alwaysRouteToSQLite) {
      return { target: QueryTarget.SQLITE_OLTP, reason: 'config: alwaysRouteToSQLite', skipFallback: false };
    }

    // Priority 2: Config override — force DuckDB
    if (alwaysRouteToDuckDB) {
      return { target: QueryTarget.DUCKDB_OLAP, reason: 'config: alwaysRouteToDuckDB', skipFallback: true };
    }

    // Priority 3: Circuit breaker — if DuckDB repeatedly fails, route to SQLite
    if (analyticClassifier?.isCircuitBroken()) {
      return { target: QueryTarget.SQLITE_OLTP, reason: 'circuit-breaker: DuckDB failures exceed threshold', skipFallback: false };
    }

    // Priority 4: Non-SELECT statements — always SQLite (writes/DDL must go to OLTP)
    if (parsed && parsed.type !== 'SELECT') {
      return { target: QueryTarget.SQLITE_OLTP, reason: `non-SELECT (${parsed.type}) → SQLite`, skipFallback: false };
    }

    // Priority 5: Transaction context — route to SQLite to maintain OLTP consistency
    if (ctx?.inTransaction) {
      return { target: QueryTarget.SQLITE_OLTP, reason: 'in-transaction → SQLite', skipFallback: false };
    }

    // Priority 6: Classifier (P0+)
    if (analyticClassifier && parsed) {
      const classification = analyticClassifier.classify(sql, parsed, ctx);
      if (classification.target === QueryTarget.DUCKDB_OLAP) {
        return {
          target: QueryTarget.DUCKDB_OLAP,
          reason: classification.reason,
          skipFallback: true,
          confidence: 0.8,
        };
      }
      if (classification.target === QueryTarget.SQLITE_OLTP) {
        // Priority 6a: Cost Estimator — upgrade to DuckDB if query benefits from columnar
        if (this.config.costEstimator && parsed) {
          const cost = this.config.costEstimator.estimate(sql, parsed);
          if (cost.recommendDuckDB) {
            return {
              target: QueryTarget.DUCKDB_OLAP,
              reason: `cost_estimator: ${cost.reason}`,
              skipFallback: true,
              confidence: cost.confidence,
            };
          }
        }
        return {
          target: QueryTarget.SQLITE_OLTP,
          reason: classification.reason,
          skipFallback: false,
          confidence: 0.9,
        };
      }
    }

    // Priority 7: Default — SQLite
    return DEFAULT_FALLBACK_DECISION;
  }

  /**
   * Execute a query based on a route decision.
   *
   * @param sql        Original SQL string
   * @param decision   Route decision from decise()
   * @param startTime  Performance start time
   * @param parsed     Optional: parsed statement
   * @param ctx        Optional: query context
   * @returns          ExecutionResult with query data
   */
  async execute(
    sql: string,
    decision: RouteDecision,
    startTime: number,
    parsed?: ParsedStatement,
    ctx?: QueryClassifierContext,
  ): Promise<ExecutionResult> {
    const metrics = this.config.routeMetrics;
    const cache = this.config.hotQueryCache;

    // Cache the routing decision for future hot queries.
    // Only cache non-transactional decisions (transaction context changes per call).
    if (cache && !ctx?.inTransaction) {
      cache.set(sql, decision);
    }

    const result: ExecutionResult = await this._doExecute(sql, decision, startTime, parsed, ctx);

    // Record route metrics after execution
    if (metrics) {
      const latencyMs = performance.now() - startTime;
      const wasFallback = !result.success && decision.target === QueryTarget.DUCKDB_OLAP;
      metrics.emitRouteEvent(result.engine as any, latencyMs, wasFallback);
    }

    return result;
  }

  /**
   * Internal execution — separated from metrics recording for clean control flow.
   */
  private async _doExecute(
    sql: string,
    decision: RouteDecision,
    startTime: number,
    parsed?: ParsedStatement,
    ctx?: QueryClassifierContext,
  ): Promise<ExecutionResult> {
    if (decision.target === QueryTarget.DUCKDB_OLAP) {
      // alwaysRouteToDuckDB: execute directly without classifier routing
      if (this.config.alwaysRouteToDuckDB) {
        try {
          const duckDBResult = await this.config.duckDBExecutor.manager.execute(sql);
          return {
            rows: duckDBResult.rows,
            rowCount: duckDBResult.rowCount,
            queryTimeMs: performance.now() - startTime,
            engine: 'duckdb_olap',
            success: true,
          };
        } catch (err: any) {
          logger.error({ err: err.message }, 'UnifiedRouter: DuckDB direct execution error');
          return {
            rows: [],
            rowCount: 0,
            queryTimeMs: performance.now() - startTime,
            engine: 'duckdb_olap',
            success: false,
            error: err.message,
          };
        }
      }

      try {
        const duckResult: DuckDBExecResult = await this.config.duckDBExecutor.execute(
          sql,
          startTime,
          parsed,
          ctx,
        );

        if (duckResult.routed) {
          return {
            rows: duckResult.rows,
            rowCount: duckResult.rowCount,
            queryTimeMs: duckResult.queryTimeMs,
            engine: duckResult.federated ? 'duckdb_federated' : 'duckdb_olap',
            federated: duckResult.federated,
            success: true,
          };
        }

        // DuckDB execution didn't route — this is unexpected given the decision
        logger.warn({ sql, reason: duckResult.reason }, 'UnifiedRouter: DuckDB decision but no route');
        return {
          rows: [],
          rowCount: 0,
          queryTimeMs: Date.now() - startTime,
          engine: 'duckdb_olap',
          success: false,
          error: duckResult.reason || 'DuckDB route failed unexpectedly',
        };
      } catch (err: any) {
        logger.error({ err: err.message }, 'UnifiedRouter: DuckDB execution error');
        return {
          rows: [],
          rowCount: 0,
          queryTimeMs: Date.now() - startTime,
          engine: 'duckdb_olap',
          success: false,
          error: err.message,
        };
      }
    }

    // SQLite OLTP: not executed here — falls through to caller's existing path
    return {
      rows: [],
      rowCount: 0,
      queryTimeMs: 0,
      engine: 'sqlite_oltp',
      success: false,
      error: 'Not executed — defer to caller',
    };
  }

  /**
   * Quick availability check.
   */
  get isAvailable(): boolean {
    return this.config.duckDBExecutor.isAvailable;
  }
}
