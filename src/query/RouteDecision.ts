/**
 * RouteDecision — Unified routing decision types for OLTP+OLAP query pipeline.
 *
 * Defines the shared types used by UnifiedRouter, DuckDBExecutor, and SQLiteExecutor.
 *
 * ## Engine Options
 * - `sqlite_oltp`: Standard OLTP execution via SQLite
 * - `duckdb_olap`: Analytic execution via DuckDB columnar engine
 * - `duckdb_federated`: Distributed execution via AnalyticsFederationClient
 * - `unknown`: Defer to caller's default path
 */

import { QueryTarget } from '../analytics/AnalyticQueryClassifier';

/**
 * Unified route decision returned by UnifiedRouter.decide().
 */
export interface RouteDecision {
  /** Target execution engine */
  target: QueryTarget;
  /** Human-readable reason for the decision */
  reason: string;
  /** Whether to skip the standard SQLite fallback */
  skipFallback: boolean;
  /** Circuit breaker is open (force SQLite) */
  circuitOpen?: boolean;
  /** Classifier score (0-1) if available */
  confidence?: number;
}

/**
 * Result of a unified execution.
 */
export interface ExecutionResult {
  rows: any[];
  rowCount: number;
  queryTimeMs: number;
  engine: 'sqlite_oltp' | 'duckdb_olap' | 'duckdb_federated';
  federated?: boolean;
  /** True if execution succeeded on the selected engine */
  success: boolean;
  /** Error message if execution failed */
  error?: string;
}

/**
 * Default fallback decision — always use SQLite OLTP engine.
 */
export const DEFAULT_FALLBACK_DECISION: RouteDecision = {
  target: QueryTarget.SQLITE_OLTP,
  reason: 'Fallback: default SQLite OLTP path',
  skipFallback: false,
};
