/**
 * HashIndexShim — Translates PostgreSQL Hash indexes to SQLite-compatible equivalents.
 *
 * PostgreSQL supports Hash indexes for simple equality comparisons. SQLite has
 * no equivalent index type, so we fall back to a B-tree index (SQLite's default
 * index type).
 *
 * Strategy:
 *   `CREATE INDEX ON t USING HASH (col)` → `CREATE INDEX ON t (col)`
 *
 * While a B-tree index is less efficient for pure equality lookups than a
 * true hash index, it is perfectly valid for the same WHERE col = ? queries
 * and ensures the DDL executes without errors on SQLite.
 *
 * @module HashIndexShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('HashIndexShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface HashIndexResult {
  /** Rewritten SQL string (always valid SQLite) */
  sql: string;
  /** Whether a USING HASH clause was detected and removed */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/**
 * Pattern to detect the `USING HASH` clause in a CREATE INDEX statement.
 * Matches case-insensitively, with flexible whitespace around `USING` and `HASH`.
 */
const USING_HASH_PATTERN = /\bUSING\s+HASH\b/i;

// ──────────────────────────────────────────────
//  Private helpers
// ──────────────────────────────────────────────

/**
 * Remove the `USING HASH` clause from a CREATE INDEX statement.
 *
 * Transforms:
 *   CREATE INDEX ix ON t USING HASH (col) → CREATE INDEX ix ON t (col)
 *   CREATE UNIQUE INDEX ON t USING HASH (a, b) → CREATE UNIQUE INDEX ON t (a, b)
 *
 * After removal, any excess whitespace is collapsed so the output is clean.
 */
function stripUsingHash(sql: string): string {
  return sql.replace(USING_HASH_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains a `USING HASH` index clause.
 *
 * @param sql - A SQL statement (typically a CREATE INDEX)
 * @returns `true` if the SQL contains USING HASH
 *
 * @example
 * ```ts
 * detectHash('CREATE INDEX ON t USING HASH (col)'); // true
 * detectHash('CREATE INDEX ON t (col)');             // false
 * ```
 */
export function detectHash(sql: string): boolean {
  return USING_HASH_PATTERN.test(sql);
}

/**
 * Rewrite a `CREATE INDEX ... USING HASH` statement to produce always-executable
 * SQLite SQL by removing the `USING HASH` clause, letting SQLite fall back to
 * its default B-tree index.
 *
 * If no `USING HASH` clause is found, the SQL is returned unchanged with
 * `rewritten: false`.
 *
 * @param sql - A CREATE INDEX statement that may contain USING HASH
 * @returns A {@link HashIndexResult} with the rewritten SQL
 *
 * @example
 * ```ts
 * rewriteHash('CREATE INDEX idx ON t USING HASH (col)');
 * // → { sql: 'CREATE INDEX idx ON t (col)', rewritten: true }
 *
 * rewriteHash('CREATE UNIQUE INDEX uq ON t USING HASH (a, b)');
 * // → { sql: 'CREATE UNIQUE INDEX uq ON t (a, b)', rewritten: true }
 * ```
 */
export function rewriteHash(sql: string): HashIndexResult {
  const trimmed = sql.trim();

  if (!detectHash(trimmed)) {
    // No Hash index detected — pass through unchanged
    return { sql: trimmed, rewritten: false };
  }

  const rewritten = stripUsingHash(trimmed);

  logger.info(
    { original: trimmed, rewritten },
    'HashIndexShim: rewrite complete (USING HASH → B-tree)',
  );

  return { sql: rewritten, rewritten: true };
}
