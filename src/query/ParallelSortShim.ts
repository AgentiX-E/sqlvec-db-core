/**
 * ParallelSortShim — PostgreSQL parallel sort compatibility shim for SQLite.
 *
 * PostgreSQL supports parallel query execution with configuration parameters
 * such as `max_parallel_workers_per_gather`, `parallel_setup_cost`,
 * `parallel_tuple_cost`, and `max_parallel_workers`. SQLite has no concept
 * of parallel sort or parallel query execution natively.
 *
 * This shim detects PG parallel-sort related statements and stores them into
 * a shared {@link ParallelSessionContext} (from ParallelQueryShim) so that
 * the QueryRouter + ParallelExecutor can use the values to drive real parallel
 * query execution via Piscina worker_threads.
 *
 * ## Strategy
 *
 * | Input SQL                                                         | Output SQL                                     | rewritten |
 * |-------------------------------------------------------------------|------------------------------------------------|-----------|
 * | `SET max_parallel_workers_per_gather = 4`                         | `SELECT 1` (hint stored in context)            | true      |
 * | `SET parallel_setup_cost = 1000`                                  | `SELECT 1`                                     | true      |
 * | `SET parallel_tuple_cost = 0.1`                                   | `SELECT 1`                                     | true      |
 * | `SET max_parallel_workers = 2`                                    | `SELECT 1` (hint stored in context)            | true      |
 * | `SHOW max_parallel_workers_per_gather`                            | returns stored value via session context       | true      |
 * | `SELECT * FROM t ORDER BY c;`                                     | (pass-through)                                 | false     |
 * | `CREATE INDEX ON t(c);`                                           | (pass-through)                                 | false     |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-parallel-sort SQL
 * - PinoLogger integration for debugging and audit trails
 *
 * @module ParallelSortShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { ParallelSessionContext } from './ParallelQueryShim';

const logger = PinoLogger.forComponent('ParallelSortShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ParallelSortResult {
  /** Rewritten SQL (no-op for SET variants, SELECT for SHOW, original for pass-through) */
  sql: string;
  /** Whether the statement was detected as parallel-sort-related and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches SET statements for PostgreSQL parallel query parameters.
 *
 * Supported parameters:
 *   - max_parallel_workers_per_gather
 *   - parallel_setup_cost
 *   - parallel_tuple_cost
 *   - max_parallel_workers
 *
 * Handles optional SESSION/LOCAL prefixes and `=` or `TO` value assignment.
 * Case-insensitive, allows leading whitespace.
 *
 * Patterns matched:
 *   SET parameter = value
 *   SET parameter TO value
 *   SET SESSION parameter = value
 *   SET LOCAL parameter = value
 *
 * Value can be a number (integer or decimal), optionally quoted.
 */
const SET_PARALLEL_PARAM =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?(max_parallel_workers_per_gather|parallel_setup_cost|parallel_tuple_cost|max_parallel_workers)\s*(?:\s*[=:]\s*|\s+TO\s+)(\S+);?\s*$/i;

/**
 * Matches SHOW max_parallel_workers_per_gather statement.
 */
const SHOW_PARALLEL_PARAM =
  /^\s*SHOW\s+max_parallel_workers_per_gather\s*;?\s*$/i;

/**
 * Fast prefix check.
 */
const SET_START = /^\s*SET\s+/i;
const SHOW_START = /^\s*SHOW\s+/i;

/**
 * Parse a SET value from a string.
 */
function parseSetValue(value: string): number | boolean {
  const lower = value.toLowerCase().replace(/['"]/g, '');
  if (lower === 'on') return true;
  if (lower === 'off') return false;
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  const num = Number(value);
  if (!isNaN(num)) return num;
  return 0;
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL parallel sort
 * related statement.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a PG parallel-sort-related statement
 *
 * @example
 * ```ts
 * detectParallelSort('SET max_parallel_workers_per_gather = 4');  // true
 * detectParallelSort('SET parallel_setup_cost = 1000');           // true
 * detectParallelSort('SET parallel_tuple_cost = 0.1');            // true
 * detectParallelSort('SET max_parallel_workers = 2');             // true
 * detectParallelSort('SHOW max_parallel_workers_per_gather');     // true
 * detectParallelSort('SELECT 1');                                  // false
 * ```
 */
export function detectParallelSort(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  if (!SET_START.test(trimmed) && !SHOW_START.test(trimmed)) {
    return false;
  }

  if (SET_PARALLEL_PARAM.test(trimmed)) return true;
  if (SHOW_PARALLEL_PARAM.test(trimmed)) return true;

  return false;
}

/**
 * Rewrite a PostgreSQL parallel sort related SQL statement.
 *
 * Instead of rewriting to a no-op, this now stores the parameter value into
 * the provided {@link ParallelSessionContext} so that real parallel execution
 * can be triggered downstream.
 *
 * @param sql   The raw SQL string to process
 * @param ctx   Optional session-level parallel context to update
 * @returns     A {@link ParallelSortResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * const ctx = new ParallelSessionContext();
 * rewriteParallelSort('SET max_parallel_workers_per_gather = 4', ctx);
 * // → { sql: 'SELECT 1', rewritten: true }
 * // ctx.maxParallelWorkersPerGather === 4
 * ```
 */
export function rewriteParallelSort(
  sql: string,
  ctx?: ParallelSessionContext,
): ParallelSortResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Fast prefix exit ──────────────────
  if (!SET_START.test(trimmed) && !SHOW_START.test(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  // ── Step 2: Check for SET parallel parameter ──
  const setMatch = trimmed.match(SET_PARALLEL_PARAM);
  if (setMatch) {
    const paramName = setMatch[1].toLowerCase();
    const rawValue = setMatch[2];
    const parsed = parseSetValue(rawValue);

    if (ctx) {
      switch (paramName) {
        case 'max_parallel_workers_per_gather':
          ctx.maxParallelWorkersPerGather = typeof parsed === 'number' ? parsed : (parsed ? 2 : 0);
          break;
        case 'max_parallel_workers':
          ctx.maxParallelWorkers = typeof parsed === 'number' ? parsed : (parsed ? 2 : 0);
          break;
        // parallel_setup_cost and parallel_tuple_cost are informational only
      }
    }

    logger.debug(
      { sql: trimmed, parameter: paramName, value: rawValue, parsed },
      'SET for parallel sort parameter detected — stored in session context',
    );

    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 3: Check for SHOW max_parallel_workers_per_gather ──
  if (SHOW_PARALLEL_PARAM.test(trimmed)) {
    const workerCount = ctx ? ctx.maxParallelWorkersPerGather : 0;
    const responseSql = `SELECT ${workerCount} as max_parallel_workers_per_gather`;

    logger.debug(
      { sql: trimmed, workers: workerCount },
      'SHOW max_parallel_workers_per_gather detected — returning session value',
    );

    return {
      sql: responseSql,
      rewritten: true,
    };
  }

  // ── Step 4: Not a parallel-sort-related statement ──
  return { sql: trimmed, rewritten: false };
}
