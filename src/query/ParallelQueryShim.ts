/**
 * ParallelQueryShim — PostgreSQL parallel query compatibility shim for SQLite.
 *
 * This shim detects PG parallel query related SET/SHOW/comment-hint statements
 * and **stores them in a session-level context** so that downstream components
 * (QueryRouter + ParallelExecutor) can use them to drive real parallel query
 * execution via Piscina worker_threads.
 *
 * ## Parallel query parameters tracked
 *
 * The following PG GUCs are detected and stored into {@link ParallelSessionContext}:
 *
 *   - `/*+ PARALLEL(workers N) *&#47;` (optimizer hint comment)
 *   - `SET parallel_workers = N`
 *   - `SET max_parallel_workers_per_gather = N`
 *   - `SET max_parallel_workers = N`
 *   - `SET enable_parallel_hash`
 *   - `SET force_parallel_mode`
 *   - `SET parallel_leader_participation`
 *   - `SET min_parallel_table_scan_size`
 *   - `SET min_parallel_index_scan_size`
 *   - `SHOW max_parallel_workers_per_gather` — returns stored value or '0'
 *   - `SHOW enable_parallel_hash` — returns stored value or 'off'
 *   - `SHOW force_parallel_mode` — returns stored value or 'off'
 *   - `SHOW parallel_leader_participation` — returns stored value or 'on'
 *
 * ## Strategy
 *
 * Instead of rewriting these to no-op `SELECT 1`, we now:
 *   1. Parse the value (e.g. number of workers)
 *   2. Store it in {@link ParallelSessionContext}
 *   3. Return a no-op result for SET (or a constant-select for SHOW)
 *   4. QueryRouter checks {@link ParallelSessionContext} when deciding whether
 *      to execute a cross-shard SELECT in parallel
 *
 * ## Key guarantees
 *
 * - All returned SQL is valid SQLite (same as before for SET/SHOW)
 * - No false positives on non-parallel-query SQL
 * - Session context is isolated per {@link ParallelSessionContext} instance
 * - PinoLogger integration for debugging and audit trails
 *
 * @module query/ParallelQueryShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('ParallelQueryShim');

// ── Types ──────────────────────────────────────────────────────

export interface ParallelQueryResult {
  /** Rewritten SQL (no-op SELECT for SET, constant SELECT for SHOW, original for pass-through) */
  sql: string;
  /** Whether the statement was detected as parallel-query-related and rewritten */
  rewritten: boolean;
}

/**
 * Session-level parallel query configuration.
 * An instance of this is stored per-session in QueryRouter.
 */
export class ParallelSessionContext {
  /**
   * Number of parallel workers requested via SET or hint.
   * 0 means "not set" (default sequential execution).
   */
  public parallelWorkers: number = 0;

  /**
   * pgParallelWorkers — Application-level GUC for controlling parallel query execution.
   * This is an SqlVec DB extension (not a standard PG GUC).
   * When set to a value > 0, enables automatic parallel query execution
   * for large SELECT queries on multi-shard databases.
   * Default: 0 (disabled).
   */
  public pgParallelWorkers: number = 0;

  /** max_parallel_workers_per_gather (legacy PG GUC) */
  public maxParallelWorkersPerGather: number = 0;

  /** max_parallel_workers (legacy PG GUC) */
  public maxParallelWorkers: number = 0;

  /** enable_parallel_hash */
  public enableParallelHash: boolean = false;

  /** force_parallel_mode */
  public forceParallelMode: boolean = false;

  /** parallel_leader_participation */
  public parallelLeaderParticipation: boolean = true;

  /** min_parallel_table_scan_size */
  public minParallelTableScanSize: number = 0;

  /** min_parallel_index_scan_size */
  public minParallelIndexScanSize: number = 0;

  /**
   * Whether any parallel hint has been set in this session.
   */
  get isParallelEnabled(): boolean {
    return this.parallelWorkers > 0 || this.pgParallelWorkers > 0 || this.maxParallelWorkersPerGather > 0 || this.maxParallelWorkers > 0;
  }

  /**
   * Get the effective number of parallel workers to use.
   * Returns the highest value among the various parallel settings.
   */
  get effectiveWorkers(): number {
    return Math.max(
      this.parallelWorkers,
      this.pgParallelWorkers,
      this.maxParallelWorkersPerGather,
      this.maxParallelWorkers,
    );
  }

  /**
   * Reset all parallel settings to defaults.
   */
  reset(): void {
    this.parallelWorkers = 0;
    this.pgParallelWorkers = 0;
    this.maxParallelWorkersPerGather = 0;
    this.maxParallelWorkers = 0;
    this.enableParallelHash = false;
    this.forceParallelMode = false;
    this.parallelLeaderParticipation = true;
    this.minParallelTableScanSize = 0;
    this.minParallelIndexScanSize = 0;
  }
}

// ── Constants — Regex patterns ──────────────────────────────────

/**
 * Matches PostgreSQL optimizer hint comment: `/*+ PARALLEL(workers N) *&#47;`
 * Can appear at the start of a query or inline.
 */
const HINT_PARALLEL = /\/\*\+\s*PARALLEL\s*\(\s*workers\s+(\d+)\s*\)\s*\*\//i;

/**
 * Matches SET statements for PostgreSQL parallel query parameters.
 *
 * Covered parameters:
 *   - parallel_workers (PG 16+: direct parallel workers hint)
 *   - enable_parallel_hash
 *   - force_parallel_mode
 *   - parallel_leader_participation
 *   - min_parallel_table_scan_size
 *   - min_parallel_index_scan_size
 *
 * Handles the following syntactic variants:
 *   `SET parameter = value`
 *   `SET parameter TO value`
 *   `SET SESSION parameter = value`
 *   `SET SESSION parameter TO value`
 *   `SET LOCAL parameter = value`
 *   `SET LOCAL parameter TO value`
 *
 * Case-insensitive. Allows leading whitespace and optional trailing semicolon.
 * Value can be a word (on/off), a number, or (for the size parameters) a
 * number optionally followed by a unit (kB, MB, etc.).
 */
const SET_PARALLEL_QUERY_PARAM =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?(pgParallelWorkers|parallel_workers|enable_parallel_hash|force_parallel_mode|parallel_leader_participation|min_parallel_table_scan_size|min_parallel_index_scan_size)\s*(?:\s*[=:]\s*|\s+TO\s+)(\S+);?\s*$/i;

/**
 * Matches SET statements for parallel query parameters handled by ParallelSortShim.
 * We detect them here too for unified tracking.
 */
const SET_PARALLEL_SORT_PARAM =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?(max_parallel_workers_per_gather|parallel_setup_cost|parallel_tuple_cost|max_parallel_workers)\s*(?:\s*[=:]\s*|\s+TO\s+)(\S+);?\s*$/i;

/**
 * Matches SHOW statements for parallel query parameters.
 */
const SHOW_PARALLEL_QUERY_PARAM =
  /^\s*SHOW\s+(pgParallelWorkers|parallel_workers|enable_parallel_hash|force_parallel_mode|parallel_leader_participation|max_parallel_workers_per_gather|max_parallel_workers|min_parallel_table_scan_size|min_parallel_index_scan_size)\s*;?\s*$/i;

/**
 * Fast prefix check: does the trimmed SQL start with SET or SHOW or /*+?
 */
const SET_START = /^\s*SET\s+/i;
const SHOW_START = /^\s*SHOW\s+/i;

/**
 * Parse a SET value (on/off/number) from a string.
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

/**
 * Get the SHOW response value for a given parameter from the session context.
 */
function getShowResponse(paramName: string, ctx: ParallelSessionContext): string {
  switch (paramName.toLowerCase()) {
    case 'pgparallelworkers':
      return String(ctx.pgParallelWorkers);
    case 'parallel_workers':
      return String(ctx.parallelWorkers);
    case 'max_parallel_workers_per_gather':
      return String(ctx.maxParallelWorkersPerGather);
    case 'max_parallel_workers':
      return String(ctx.maxParallelWorkers);
    case 'enable_parallel_hash':
      return ctx.enableParallelHash ? 'on' : 'off';
    case 'force_parallel_mode':
      return ctx.forceParallelMode ? 'on' : 'off';
    case 'parallel_leader_participation':
      return ctx.parallelLeaderParticipation ? 'on' : 'off';
    case 'min_parallel_table_scan_size':
      return String(ctx.minParallelTableScanSize);
    case 'min_parallel_index_scan_size':
      return String(ctx.minParallelIndexScanSize);
    default:
      return '0';
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL parallel query
 * related SET, SHOW, or hint comment.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a PG parallel-query-related statement
 */
export function detectParallelQuery(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Check for hint comment
  if (HINT_PARALLEL.test(trimmed)) {
    return true;
  }

  // Fast prefix check for SET/SHOW
  if (!SET_START.test(trimmed) && !SHOW_START.test(trimmed)) {
    return false;
  }

  if (SET_PARALLEL_QUERY_PARAM.test(trimmed)) return true;
  if (SET_PARALLEL_SORT_PARAM.test(trimmed)) return true;
  if (SHOW_PARALLEL_QUERY_PARAM.test(trimmed)) return true;

  return false;
}

/**
 * Process a PostgreSQL parallel query related SQL statement.
 *
 * This replaces the old `rewriteParallelQuery` that converted all parallel
 * GUCs into no-op statements. Now it:
 *   1. Detects the parameter and value
 *   2. Stores it into the provided {@link ParallelSessionContext}
 *   3. Returns a no-op SQL for SET, or a constant-response SQL for SHOW
 *
 * @param sql   The raw SQL string to process
 * @param ctx   The session-level parallel query context to update
 * @returns     A {@link ParallelQueryResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * const ctx = new ParallelSessionContext();
 * rewriteParallelQuery('SET parallel_workers = 4', ctx);
 * // → { sql: 'SELECT 1', rewritten: true }
 * // ctx.parallelWorkers === 4
 *
 * rewriteParallelQuery('SHOW parallel_workers', ctx);
 * // → { sql: "SELECT '4'", rewritten: true }
 * ```
 */
export function rewriteParallelQuery(
  sql: string,
  ctx?: ParallelSessionContext,
): ParallelQueryResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  const trimmed = sql.trim();

  // ── Step 1: Check for optimizer hint comment ──────────
  const hintMatch = trimmed.match(HINT_PARALLEL);
  if (hintMatch) {
    const workers = parseInt(hintMatch[1], 10);
    if (ctx && workers > 0) {
      ctx.parallelWorkers = workers;
      logger.debug(
        { sql: trimmed, workers },
        'PARALLEL optimizer hint detected — stored in session context',
      );
    }
    return { sql: trimmed.replace(HINT_PARALLEL, '').trim(), rewritten: true };
  }

  // ── Step 2: Fast prefix exit (neither SET nor SHOW) ──
  if (!SET_START.test(trimmed) && !SHOW_START.test(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  // ── Step 3: Check for SET parallel query parameter ────
  const setMatch = trimmed.match(SET_PARALLEL_QUERY_PARAM);
  if (setMatch) {
    const paramName = setMatch[1].toLowerCase();
    const rawValue = setMatch[2];
    const parsed = parseSetValue(rawValue);

    if (ctx) {
      switch (paramName) {
        case 'pgparallelworkers':
          ctx.pgParallelWorkers = typeof parsed === 'number' ? parsed : (parsed ? 2 : 0);
          break;
        case 'parallel_workers':
          ctx.parallelWorkers = typeof parsed === 'number' ? parsed : (parsed ? 2 : 0);
          break;
        case 'enable_parallel_hash':
          ctx.enableParallelHash = parsed === true;
          break;
        case 'force_parallel_mode':
          ctx.forceParallelMode = parsed === true;
          break;
        case 'parallel_leader_participation':
          ctx.parallelLeaderParticipation = parsed !== false;
          break;
        case 'min_parallel_table_scan_size':
          ctx.minParallelTableScanSize = typeof parsed === 'number' ? parsed : 0;
          break;
        case 'min_parallel_index_scan_size':
          ctx.minParallelIndexScanSize = typeof parsed === 'number' ? parsed : 0;
          break;
      }
    }

    logger.debug(
      { sql: trimmed, parameter: paramName, value: rawValue, parsed },
      'SET for parallel query parameter detected — stored in session context',
    );

    return { sql: 'SELECT 1', rewritten: true };
  }

  // ── Step 3b: Check for SET parallel sort parameter ────
  const sortMatch = trimmed.match(SET_PARALLEL_SORT_PARAM);
  if (sortMatch) {
    const paramName = sortMatch[1].toLowerCase();
    const rawValue = sortMatch[2];
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

    return { sql: 'SELECT 1', rewritten: true };
  }

  // ── Step 4: Check for SHOW parallel query parameter ────
  const showMatch = trimmed.match(SHOW_PARALLEL_QUERY_PARAM);
  if (showMatch) {
    const paramName = showMatch[1].toLowerCase();
    const response = ctx ? getShowResponse(paramName, ctx) : '0';
    const responseSql = `SELECT '${response}' as ${paramName}`;

    logger.debug(
      { sql: trimmed, parameter: paramName, response },
      'SHOW parallel query parameter detected — returning session value',
    );

    return { sql: responseSql, rewritten: true };
  }

  // ── Step 5: Not a parallel-query-related statement ────
  return { sql: trimmed, rewritten: false };
}
