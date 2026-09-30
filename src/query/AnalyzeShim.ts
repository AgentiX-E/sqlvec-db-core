/**
 * AnalyzeShim — PostgreSQL ANALYZE compatibility shim for SQLite.
 *
 * SQLite natively supports `ANALYZE` and `ANALYZE table_name`, but does NOT
 * support PostgreSQL-specific extensions such as the VERBOSE keyword or
 * column list syntax `(col1, col2)`.
 *
 * This shim detects PG-specific ANALYZE patterns and rewrites them into
 * their SQLite-compatible equivalents.
 *
 * ## PG syntax vs SQLite support
 *
 * | PG Syntax                              | Rewrite                        | Rewritten |
 * |----------------------------------------|--------------------------------|-----------|
 * | `ANALYZE;`                             | `ANALYZE` (pass-through)       | ❌        |
 * | `ANALYZE table_name;`                  | `ANALYZE table_name` (pass)    | ❌        |
 * | `ANALYZE VERBOSE;`                     | `ANALYZE`                      | ✅        |
 * | `ANALYZE table_name (col1, col2);`     | `ANALYZE table_name`           | ✅        |
 * | `ANALYZE VERBOSE table_name (col1, col2);` | `ANALYZE table_name`      | ✅        |
 * | `ANALYZE (col1, col2);`                | `ANALYZE`                      | ✅        |
 * | `ANALYZE VERBOSE table_name;`          | `ANALYZE table_name`           | ✅        |
 *
 * ## Strategy
 * 1. Detect if the SQL is a PG-specific ANALYZE (contains VERBOSE or column list)
 * 2. Strip VERBOSE keyword
 * 3. Strip column list `(col1, col2)` suffix
 * 4. Leave bare `ANALYZE` / `ANALYZE table_name` untouched
 *
 * ## Autovacuum Hook
 * A mutation notification callback can be registered via
 * `setAnalyzeMutationHook()`. When an ANALYZE is detected, the hook
 * is called with the table name so the AutovacuumDaemon can reset
 * its modification counter.
 *
 * @module AnalyzeShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('AnalyzeShim');

// ── Autovacuum Hook ─────────────────────────────────────────────

/**
 * Callback type for analyze mutation notifications.
 */
export type AnalyzeHookCallback = (tableName?: string) => void;

/** Registered autovacuum hook (null if not set) */
let analyzeMutationHook: AnalyzeHookCallback | null = null;

/**
 * Register a callback to be notified when ANALYZE is processed.
 * Used by AutovacuumDaemon to reset internal modification counters.
 *
 * @param hook  The callback to invoke on ANALYZE detection, or null to clear
 */
export function setAnalyzeMutationHook(hook: AnalyzeHookCallback | null): void {
  analyzeMutationHook = hook;
}

// ── Types ────────────────────────────────────────────────────────

export interface AnalyzeResult {
  /** Rewritten SQL (original SQL if no rewrite needed) */
  sql: string;
  /** Whether the SQL was rewritten */
  rewritten: boolean;
}

// ── Constants — Matching primitives ─────────────────────────────

/**
 * Matches SQL statements that start with ANALYZE (case-insensitive).
 */
const ANALYZE_START_PATTERN = /^\s*ANALYZE\b/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL is a PostgreSQL-specific ANALYZE statement
 * that requires rewriting for SQLite compatibility.
 *
 * Returns `true` if the statement is an ANALYZE containing VERBOSE or a
 * column list `(col1, col2)`. Returns `false` for bare `ANALYZE` or
 * `ANALYZE table_name` (both supported natively by SQLite).
 *
 * @param sql - The raw SQL string to inspect.
 * @returns `true` if the SQL is a PG-specific ANALYZE statement.
 *
 * @example
 * ```ts
 * detectPgAnalyze('ANALYZE;');                                  // false
 * detectPgAnalyze('ANALYZE users;');                            // false
 * detectPgAnalyze('ANALYZE VERBOSE;');                          // true
 * detectPgAnalyze('ANALYZE users (id, name);');                 // true
 * detectPgAnalyze('ANALYZE VERBOSE users (id, name);');         // true
 * detectPgAnalyze('SELECT * FROM users;');                      // false
 * ```
 */
export function detectPgAnalyze(sql: string): boolean {
  const parsed = parseAnalyzeStatement(sql);
  return parsed !== null && parsed.pgSpecific;
}

/**
 * Parse an ANALYZE statement into its structural parts.
 *
 * Grammar (PostgreSQL):
 *   ANALYZE [ ( option [, ...] ) ]
 *   ANALYZE [ VERBOSE ] [ table_name [ ( column [, ...] ) ] ]
 *
 * For SQLite compatibility we only care about the VERBOSE keyword and the
 * `table_name (column, ...)` column-list suffix; those require rewriting.
 * Returns `null` when the input is not an ANALYZE statement at all.
 */
interface AnalyzeParse {
  /** True when VERBOSE or a trailing column list is present (needs rewrite). */
  pgSpecific: boolean;
  /** The table name (unquoted or verbatim quoted identifier), if any. */
  tableName: string | undefined;
  /** True when VERBOSE was found. */
  hasVerbose: boolean;
  /** True when a trailing `(column, ...)` list was found. */
  hasColList: boolean;
  /** Index past the `ANALYZE` keyword (start of the body). */
  bodyStart: number;
}

function parseAnalyzeStatement(sql: string): AnalyzeParse | null {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return null;
  }
  const trimmed = sql.trim();
  if (!ANALYZE_START_PATTERN.test(trimmed)) {
    return null;
  }

  // Advance past leading whitespace + the ANALYZE keyword.
  let i = 0;
  while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
  if (/^ANALYZE/i.exec(trimmed.slice(i)) === null) {
    return null;
  }
  i += 'ANALYZE'.length;

  let hasVerbose = false;
  let tableName: string | undefined;
  let hasColList = false;

  // Scan the body tokens outside literals.
  const len = trimmed.length;
  for (;;) {
    // Skip whitespace.
    while (i < len && /\s/.test(trimmed[i])) i++;
    if (i >= len) break;

    const ch = trimmed[i];
    if (ch === ';') {
      // Trailing semicolon terminates the body.
      i++;
      break;
    }

    // Quoted identifier (table name) — must be handled BEFORE skipSqlLiteral,
    // which would otherwise swallow the double-quoted identifier as a literal.
    if (ch === '"') {
      const close = findQuotedIdentifierEnd(trimmed, i);
      if (close === -1) {
        // Unterminated — bail.
        i = len;
        break;
      }
      tableName = trimmed.slice(i, close);
      i = close;
      continue;
    }

    // Skip comments / string literals that may appear in the body.
    const skipped = skipSqlLiteral(trimmed, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    // VERBOSE keyword (case-insensitive, whole word).
    if (/^VERBOSE\b/i.exec(trimmed.slice(i)) !== null && isWordBoundaryEnd(trimmed, i + 'VERBOSE'.length)) {
      hasVerbose = true;
      i += 'VERBOSE'.length;
      continue;
    }

    // Parenthesized column list (or option list right after ANALYZE).
    if (ch === '(') {
      const close = matchingParen(trimmed, i);
      if (close === -1) {
        i = len;
        break;
      }
      hasColList = true;
      i = close;
      continue;
    }

    // Bare identifier (table name). Stop at non-identifier characters.
    const identMatch = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(trimmed.slice(i));
    if (identMatch !== null) {
      // Only treat a bare word as a table name when we haven't seen one yet.
      if (tableName === undefined) {
        tableName = identMatch[0];
      }
      i += identMatch[0].length;
      continue;
    }

    // Any other unexpected character — stop parsing the body.
    i++;
  }

  const pgSpecific = hasVerbose || hasColList;
  return { pgSpecific, tableName, hasVerbose, hasColList, bodyStart: i };
}

/** Whether position `at` is a valid word boundary after a keyword ending. */
function isWordBoundaryEnd(sql: string, at: number): boolean {
  return at >= sql.length || !/[A-Za-z0-9_$]/.test(sql[at]);
}

/** Index just past the closing double-quote of a quoted identifier (V.. V""). */
function findQuotedIdentifierEnd(sql: string, open: number): number {
  let i = open + 1;
  while (i < sql.length) {
    if (sql[i] === '"') {
      if (i + 1 < sql.length && sql[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

/** Index just past the matching `)` for the `(` at `open`, ignoring nesting. */
function matchingParen(sql: string, open: number): number {
  let depth = 1;
  let i = open + 1;
  while (i < sql.length) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Rewrite a PostgreSQL ANALYZE statement into SQLite-compatible form.
 *
 * **Processing rules:**
 * | Input                                   | Output                   | rewritten |
 * |-----------------------------------------|--------------------------|-----------|
 * | `ANALYZE`                               | `ANALYZE` (pass-through) | `false`   |
 * | `ANALYZE table_name`                    | `ANALYZE table_name`     | `false`   |
 * | `ANALYZE VERBOSE`                       | `ANALYZE`                | `true`    |
 * | `ANALYZE table_name (col1, col2)`       | `ANALYZE table_name`     | `true`    |
 * | `ANALYZE VERBOSE table_name (col1, col2)` | `ANALYZE table_name` | `true`    |
 * | `ANALYZE (col1, col2)`                  | `ANALYZE`                | `true`    |
 * | `ANALYZE VERBOSE table_name`            | `ANALYZE table_name`     | `true`    |
 * | Non-ANALYZE SQL                         | `<original>`             | `false`   |
 *
 * The rewrite process:
 * 1. Strip the VERBOSE keyword and trailing whitespace
 * 2. Strip the column list `(...)` suffix if present at end of statement
 * 3. Normalize whitespace and ensure proper termination
 *
 * @param sql - The raw SQL string to process.
 * @returns An `AnalyzeResult` with the (possibly rewritten) SQL and a flag.
 *
 * @example
 * ```ts
 * rewriteAnalyze('ANALYZE VERBOSE users (id, name);');
 * // → { sql: 'ANALYZE users', rewritten: true }
 *
 * rewriteAnalyze('ANALYZE users;');
 * // → { sql: 'ANALYZE users', rewritten: false }
 * ```
 */
export function rewriteAnalyze(sql: string): AnalyzeResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  const trimmed = sql.trim();

  // Not an ANALYZE statement — pass through unchanged.
  if (!ANALYZE_START_PATTERN.test(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  const parsed = parseAnalyzeStatement(sql);
  if (parsed === null || !parsed.pgSpecific) {
    // Bare ANALYZE / ANALYZE table_name — pass through unchanged.
    return { sql: trimmed, rewritten: false };
  }

  // Build the SQLite-compatible form: `ANALYZE [table_name]`.
  // VERBOSE and the trailing column list are dropped.
  let out = 'ANALYZE';
  if (parsed.tableName !== undefined) {
    out += ` ${parsed.tableName}`;
  }

  // Preserve a trailing semicolon when the input had one.
  const hadSemicolon = /;\s*$/.test(trimmed);
  if (hadSemicolon) {
    out += ';';
  }

  // Notify the autovacuum hook (only for genuinely rewritten statements).
  if (analyzeMutationHook) {
    analyzeMutationHook(parsed.tableName);
  }

  logger.debug(
    { original: sql, rewritten: out },
    'Rewrote PG ANALYZE to SQLite-compatible form',
  );

  return { sql: out, rewritten: true };
}

// ── Internal helpers (exported for testing) ─────────────────────

/**
 * Check if the given string starts with ANALYZE (case-insensitive).
 *
 * @internal Exported for unit testing only.
 */
export function _isAnalyzeStart(s: string): boolean {
  return ANALYZE_START_PATTERN.test(s);
}
