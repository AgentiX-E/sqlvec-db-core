// @ts-nocheck
/**
 * QueryHintShim — PostgreSQL pg_hint_plan compatibility shim for SQLite.
 *
 * PostgreSQL supports query hints via the pg_hint_plan extension, which
 * uses special `/*+ ... *​/` comment annotations to influence the query
 * planner (e.g., `/*+ SeqScan(t) *​/`, `/*+ HashJoin(a b) *​/`).
 *
 * SQLite does not have a planner hint mechanism. This shim strips all
 * pg_hint_plan style hint comments from SQL statements so they can be
 * executed without error. Non-hint comments (`/* ... *​/`, `-- ...`) are
 * preserved and passed through unchanged.
 *
 * Additionally, this shim provides GUC (Grand Unified Configuration)
 * integration for PostgreSQL query hint parameters. SET statements for
 * supported GUCs (e.g., `SET enable_hashjoin = off`) are stored in
 * the GucSystem and can influence the QueryRouter's execution plan
 * decisions.
 *
 * @module QueryHintShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { GucSystem } from '../core/GucSystem';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('QueryHintShim');

// ── Types ────────────────────────────────────────────────────────

export interface QueryHintResult {
  /** Rewritten SQL string */
  sql: string;
  /** Whether any hint comments were found and stripped */
  rewritten: boolean;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * The set of PostgreSQL GUC parameters that act as query hints and can
 * be stored/retrieved via the GucSystem.
 *
 * These correspond to PostgreSQL's planner method configuration and
 * optimizer cost parameters.
 */
export const QUERY_HINT_GUCS = [
  'enable_hashagg',
  'enable_hashjoin',
  'enable_indexscan',
  'enable_indexonlyscan',
  'enable_material',
  'enable_mergejoin',
  'enable_nestloop',
  'enable_parallel_append',
  'enable_parallel_hash',
  'enable_partition_pruning',
  'enable_partitionwise_join',
  'enable_partitionwise_aggregate',
  'enable_seqscan',
  'enable_sort',
  'enable_tidscan',
  'max_parallel_workers',
  'max_parallel_workers_per_gather',
  'parallel_setup_cost',
  'parallel_tuple_cost',
  'from_collapse_limit',
  'join_collapse_limit',
] as const;

export type QueryHintGuc = typeof QUERY_HINT_GUCS[number];

/**
 * Regex to detect and capture pg_hint_plan hint comments.
 *
 * The pattern matches `/*+` followed by hint content and then `*​/`.
 * The `g` flag ensures all occurrences in the SQL string are matched.
 * The `s` flag (dotAll) allows `.` to match newline characters.
 *
 * Breakdown:
 * - `\/\*\+` -- opening `/*+`
 * - `.*?`    -- non-greedy match of hint contents (e.g. `SeqScan(t)`)
 * - `\*\/`   -- closing `*​/`
 */
/**
 * Collect the [start, end) byte ranges of every pg_hint_plan `/*+ ... *​/`
 * hint comment in `sql`, skipping string literals, quoted identifiers,
 * dollar-quoted strings, line comments, and ordinary `/* ... *​/` block
 * comments whose contents merely *look* like a hint.
 *
 * A hint comment is recognized only by the literal opener `/*+` (a `/`, `*`,
 * then `+`). The closing `*​/` is located from there; an unterminated hint is
 * ignored rather than stripping to end-of-string.
 */
function collectHintRanges(sql: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  const len = sql.length;

  while (i < len) {
    // A block-comment opener that is a hint (`/*+`).
    if (sql[i] === '/' && sql[i + 1] === '*' && sql[i + 2] === '+') {
      const close = sql.indexOf('*/', i + 3);
      if (close === -1) break; // unterminated hint — leave the rest untouched
      ranges.push({ start: i, end: close + 2 });
      i = close + 2;
      continue;
    }

    // Any other literal/identifier/comment — skip it wholesale. This covers
    // single/double/backtick/dollar-quoted strings, `--` line comments, and
    // ordinary `/* ... *​/` blocks (whose `/*+` would otherwise be a false hit).
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    i++;
  }

  return ranges;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Detects whether a SQL string contains pg_hint_plan query hint comments.
 *
 * @param sql — The SQL statement to inspect.
 * @returns `true` if at least one `/*+ ... *​/` hint is present.
 */
export function detectQueryHint(sql: string): boolean {
  if (typeof sql !== 'string') {
    logger.warn({ sql }, 'detectQueryHint: received non-string input');
    return false;
  }
  // Literal-aware: a `/*+` inside a string literal or an ordinary comment is
  // not a real hint, so we only report hints that are real comment openers.
  return collectHintRanges(sql).length > 0;
}

/**
 * Rewrites a SQL string by stripping all pg_hint_plan `/*+ ... *​/`
 * hint comments. Non-hint comments and all other SQL content are
 * preserved unchanged.
 *
 * @param sql — The SQL statement to rewrite.
 * @returns A `QueryHintResult` containing the cleaned SQL and a
 *          flag indicating whether any hints were removed.
 *
 * @example
 * ```ts
 * rewriteQueryHint('SELECT /*+ SeqScan(t) *​/ * FROM t');
 * // => { sql: 'SELECT  * FROM t', rewritten: true }
 *
 * rewriteQueryHint('SELECT * FROM t');
 * // => { sql: 'SELECT * FROM t', rewritten: false }
 *
 * rewriteQueryHint('SELECT /* regular comment *​/ * FROM t');
 * // => { sql: 'SELECT /* regular comment *​/ * FROM t', rewritten: false }
 * ```
 */
export function rewriteQueryHint(sql: string): QueryHintResult {
  if (typeof sql !== 'string' || sql.length === 0) {
    return { sql, rewritten: false };
  }

  const original = sql;
  const ranges = collectHintRanges(sql);
  if (ranges.length === 0) {
    return { sql: original, rewritten: false };
  }

  // Strip each hint range (right-to-left keeps earlier offsets valid).
  let rewritten = sql;
  for (let k = ranges.length - 1; k >= 0; k--) {
    const { start, end } = ranges[k];
    rewritten = rewritten.slice(0, start) + rewritten.slice(end);
  }

  logger.debug(
    { before: original, after: rewritten },
    'rewriteQueryHint: stripped pg_hint_plan comments',
  );
  return { sql: rewritten, rewritten: true };
}

// ── GUC Query Hint Integration (E8) ──────────────────────────────

/**
 * Regex to match `SET guc_name = value` statements for supported GUCs.
 * Groups: 1 = GUC name, 2 = value
 */
// eslint-disable-next-line require-unicode-regexp
const SET_GUC_RE = /^\s*SET\s+(enable_\w+|max_\w+|parallel_\w+|from_\w+|join_\w+)\s*=\s*(\S+)\s*$/im;

/**
 * Regex to match `SHOW guc_name` statements for supported GUCs.
 * Groups: 1 = GUC name
 */
// eslint-disable-next-line require-unicode-regexp
const SHOW_GUC_RE = /^\s*SHOW\s+(enable_\w+|max_\w+|parallel_\w+|from_\w+|join_\w+)\s*$/im;

/**
 * Check if a GUC name is one of the supported query hint GUCs.
 *
 * @param name - The GUC parameter name to check.
 * @returns `true` if the name is in the supported list.
 */
function isQueryHintGuc(name: string): boolean {
  return QUERY_HINT_GUCS.includes(name as QueryHintGuc);
}

/**
 * Detect whether a SQL statement is a SET or SHOW command for a supported
 * query hint GUC.
 *
 * @param sql - The SQL statement to inspect.
 * @returns `true` if the statement is a SET or SHOW for a supported GUC.
 */
export function detectQueryHintGuc(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;

  const trimmed = sql.trim();

  // Check SET
  const setMatch = trimmed.match(SET_GUC_RE);
  if (setMatch && isQueryHintGuc(setMatch[1])) return true;

  // Check SHOW
  const showMatch = trimmed.match(SHOW_GUC_RE);
  if (showMatch && isQueryHintGuc(showMatch[1])) return true;

  return false;
}

/**
 * Execute a SET or SHOW command for a supported query hint GUC.
 *
 * - `SET enable_hashjoin = on` → stores the value in GucSystem
 * - `SHOW enable_hashjoin`     → returns the current value from GucSystem
 *
 * @param sql - The SET or SHOW SQL statement.
 * @param gucSystem - Optional GucSystem instance (defaults to singleton).
 * @returns A QueryHintResult with the rewritten SQL and metadata.
 */
export function executeQueryHintGuc(
  sql: string,
  gucSystem?: GucSystem,
): QueryHintResult & { gucName?: string; gucValue?: string } {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();
  const guc = gucSystem ?? GucSystem.getDefaultInstance();

  // ── SET enable_hashjoin = on/off ──────────────────────
  const setMatch = trimmed.match(SET_GUC_RE);
  if (setMatch) {
    const name = setMatch[1].toLowerCase();
    const value = setMatch[2].toLowerCase();

    if (!isQueryHintGuc(name)) {
      return { sql: trimmed, rewritten: false };
    }

    // Store the value in GucSystem
    // Dynamically register the GUC if it doesn't exist yet
    const existing = guc.registry.get(name);
    if (!existing) {
      guc.registry.register({
        name,
        description: `Query hint GUC`,
        vartype: 'string',
        unit: '',
        context: 'user',
        default: 'on',
        value,
      });
    } else {
      guc.handleSet(name, value);
    }
    logger.debug({ guc: name, value }, 'Query hint GUC SET applied');

    return {
      sql: 'SELECT 1',
      rewritten: true,
      gucName: name,
      gucValue: value,
    };
  }

  // ── SHOW enable_hashjoin ─────────────────────────────
  const showMatch = trimmed.match(SHOW_GUC_RE);
  if (showMatch) {
    const name = showMatch[1].toLowerCase();

    if (!isQueryHintGuc(name)) {
      return { sql: trimmed, rewritten: false };
    }

    // Read the value from GucSystem
    const gucDef = guc.registry.get(name);
    const value = gucDef?.value ?? 'on'; // default to 'on' (PG defaults)
    logger.debug({ guc: name, value }, 'Query hint GUC SHOW executed');

    return {
      sql: `SELECT '${value}' as ${name}`,
      rewritten: true,
      gucName: name,
      gucValue: value,
    };
  }

  return { sql: trimmed, rewritten: false };
}

/**
 * Get the current value of a query hint GUC from the GucSystem.
 *
 * @param name - The GUC parameter name (e.g., 'enable_hashjoin').
 * @returns The current value, or 'on' if not explicitly set (PG default).
 */
export function getQueryHintGucValue(name: string): string {
  if (!isQueryHintGuc(name)) return 'on';
  const guc = GucSystem.getDefaultInstance();
  const gucDef = guc.registry.get(name);
  return gucDef?.value ?? 'on';
}

/**
 * Check whether a given planner method is enabled based on GUC settings.
 *
 * For enable_* GUCs (e.g., enable_hashjoin, enable_seqscan):
 * - Returns `true` if the GUC value is not 'off'
 * - Returns `false` if the GUC value is 'off'
 *
 * @param name - The GUC parameter name to check.
 * @returns `true` if enabled, `false` if disabled ('off').
 */
export function isPlannerMethodEnabled(name: string): boolean {
  return getQueryHintGucValue(name) !== 'off';
}
