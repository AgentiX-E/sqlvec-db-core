import { PinoLogger } from '../logger/PinoLogger';

// ── Types ────────────────────────────────────────────────────────

export interface CoveringIndexResult {
  sql: string;
  rewritten: boolean;
}

// ── Constants ────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('CoveringIndexRewriter');

/** Match the start of a CREATE INDEX statement (optionally UNIQUE). */
const CREATE_INDEX_RE = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s/i;

/** Match the INCLUDE (...) clause. */
const INCLUDE_CLAUSE_RE = /\bINCLUDE\s*\([^)]*\)/i;

/** Match and remove the CONCURRENTLY keyword. */
const CONCURRENTLY_RE = /\bCONCURRENTLY\b\s*/gi;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether a SQL statement is a CREATE INDEX that contains a
 * PostgreSQL-only INCLUDE clause for covering columns.
 *
 * @param sql - The raw SQL statement.
 * @returns `true` if the statement is a CREATE INDEX with an INCLUDE clause.
 */
export function detectCoveringIndex(sql: string): boolean {
  const trimmed = sql.trim();
  return CREATE_INDEX_RE.test(trimmed) && INCLUDE_CLAUSE_RE.test(trimmed);
}

/**
 * Rewrite a `CREATE INDEX … INCLUDE (…)` statement to be SQLite-compatible.
 *
 * PostgreSQL supports `CREATE INDEX ON t (a, b) INCLUDE (c, d)` to add
 * covering / index-only-scan columns.  SQLite does **not** support INCLUDE,
 * so the clause is stripped entirely.
 *
 * @example
 * ```ts
 * rewriteCoveringIndex('CREATE INDEX ix ON t (a, b) INCLUDE (c, d)')
 * // → { sql: 'CREATE INDEX ix ON t (a, b)', rewritten: true }
 * ```
 *
 * Also handles:
 *  - `CREATE INDEX CONCURRENTLY … INCLUDE` → removes both CONCURRENTLY and INCLUDE
 *  - `CREATE UNIQUE INDEX … INCLUDE`     → preserves UNIQUE, strips INCLUDE
 *  - `… INCLUDE (…) WHERE …` / `… WHERE … INCLUDE (…)` → handles both orderings
 *
 * @param sql - The original PostgreSQL SQL string.
 * @returns A result object with the rewritten SQL and a `rewritten` flag.
 */
export function rewriteCoveringIndex(sql: string): CoveringIndexResult {
  const trimmed = sql.trim();

  // Fast-path: not a CREATE INDEX or doesn't contain an INCLUDE clause
  if (!CREATE_INDEX_RE.test(trimmed) || !INCLUDE_CLAUSE_RE.test(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  let result = trimmed;

  // 1. Remove CONCURRENTLY — not supported by SQLite
  const hadConcurrently = /\bCONCURRENTLY\b/i.test(result);
  result = result.replace(CONCURRENTLY_RE, '');

  // 2. Strip the INCLUDE (col1, col2, …) clause entirely
  result = result.replace(INCLUDE_CLAUSE_RE, '');

  // 3. Normalise whitespace (collapses double/triple spaces left by removal)
  result = result.replace(/\s+/g, ' ').trim();

  logger.info(
    { original: sql, rewritten: result, hadConcurrently },
    'rewrote covering index SQL for SQLite compatibility',
  );

  return { sql: result, rewritten: true };
}
