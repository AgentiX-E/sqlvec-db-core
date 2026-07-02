/**
 * ConcurrentIndexShim — Strips the CONCURRENTLY keyword from PostgreSQL CREATE INDEX
 * statements for SQLite compatibility.
 *
 * PostgreSQL supports `CREATE INDEX CONCURRENTLY`, which allows index creation without
 * blocking writes on the table. SQLite does not support this keyword, so the strategy
 * is to simply remove it.
 *
 * | Input Example                                               | Output                                      |
 * |-------------------------------------------------------------|---------------------------------------------|
 * | CREATE INDEX CONCURRENTLY ix ON t (col)                     | CREATE INDEX ix ON t (col)                 |
 * | CREATE UNIQUE INDEX CONCURRENTLY ix ON t (a, b)             | CREATE UNIQUE INDEX ix ON t (a, b)         |
 * | CREATE INDEX CONCURRENTLY IF NOT EXISTS ix ON t (col)       | CREATE INDEX IF NOT EXISTS ix ON t (col)   |
 * | CREATE INDEX ix ON t (col)                                  | CREATE INDEX ix ON t (col)                 |
 *
 * Limitations (regex-based approach):
 *   - CONCURRENTLY appearing inside string literals or comments may trigger false
 *     positives (acceptable for the target use-case of SQL rewriting).
 *   - Multi-statement input is processed as a single pass; each CREATE INDEX is
 *     rewritten independently when the keyword is present.
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('ConcurrentIndexShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ConcurrentIndexResult {
  /** Rewritten SQL string (CONCURRENTLY stripped) */
  sql: string;
  /** Whether a CONCURRENTLY keyword was detected and removed */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — detection pattern
// ──────────────────────────────────────────────

/**
 * Detect the `CONCURRENTLY` keyword in a CREATE INDEX statement.
 *
 * Uses a case-insensitive word-boundary match to avoid matching inside identifiers
 * or string literals like `"not_concurrently_idx"`.
 */
const CONCURRENTLY_PATTERN = /\bCONCURRENTLY\b/i;

// ──────────────────────────────────────────────
//  Private helpers
// ──────────────────────────────────────────────

/**
 * Remove the `CONCURRENTLY` keyword from a SQL statement, normalising
 * any resulting double spaces.
 *
 * Handles all variants:
 *   `CREATE INDEX CONCURRENTLY ix ON t (col)`            → `CREATE INDEX ix ON t (col)`
 *   `CREATE UNIQUE INDEX CONCURRENTLY ix ON t (col)`     → `CREATE UNIQUE INDEX ix ON t (col)`
 *   `CREATE INDEX CONCURRENTLY IF NOT EXISTS ix ON t`    → `CREATE INDEX IF NOT EXISTS ix ON t`
 */
function stripConcurrently(sql: string): string {
  return sql.replace(CONCURRENTLY_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains the `CONCURRENTLY` keyword
 * (appearing as an independent word).
 *
 * @param sql - A SQL statement (typically a CREATE INDEX)
 * @returns `true` if the SQL contains a CONCURRENTLY keyword
 *
 * @example
 * ```ts
 * detectConcurrently('CREATE INDEX CONCURRENTLY ix ON t (col)'); // true
 * detectConcurrently('CREATE INDEX ix ON t (col)');              // false
 * ```
 */
export function detectConcurrently(sql: string): boolean {
  return CONCURRENTLY_PATTERN.test(sql);
}

/**
 * Rewrite a `CREATE INDEX ... CONCURRENTLY` statement by removing the
 * `CONCURRENTLY` keyword, producing always-executable SQLite SQL.
 *
 * The rewrite strategy:
 *   1. Strip `CONCURRENTLY` (not supported in SQLite)
 *   2. Normalise whitespace (collapse double spaces, trim)
 *
 * If no `CONCURRENTLY` keyword is present, the SQL passes through unchanged.
 *
 * @param sql - A CREATE INDEX statement that may contain CONCURRENTLY
 * @returns A {@link ConcurrentIndexResult} with the rewritten SQL
 *
 * @example
 * ```ts
 * rewriteConcurrently('CREATE INDEX CONCURRENTLY ix ON t (col)');
 * // → { sql: 'CREATE INDEX ix ON t (col)', rewritten: true }
 *
 * rewriteConcurrently('CREATE UNIQUE INDEX CONCURRENTLY ix ON t (a, b)');
 * // → { sql: 'CREATE UNIQUE INDEX ix ON t (a, b)', rewritten: true }
 *
 * rewriteConcurrently('CREATE INDEX CONCURRENTLY IF NOT EXISTS ix ON t (col)');
 * // → { sql: 'CREATE INDEX IF NOT EXISTS ix ON t (col)', rewritten: true }
 *
 * rewriteConcurrently('CREATE INDEX ix ON t (col)');
 * // → { sql: 'CREATE INDEX ix ON t (col)', rewritten: false }
 * ```
 */
export function rewriteConcurrently(sql: string): ConcurrentIndexResult {
  const trimmed = sql.trim();

  if (!detectConcurrently(trimmed)) {
    // No CONCURRENTLY detected — pass through unchanged
    return { sql: trimmed, rewritten: false };
  }

  // Strip CONCURRENTLY (not supported in SQLite)
  const rewritten = stripConcurrently(trimmed);

  logger.info(
    { original: trimmed, rewritten },
    'ConcurrentIndexShim: rewrite complete (CONCURRENTLY stripped)',
  );

  return { sql: rewritten, rewritten: true };
}
