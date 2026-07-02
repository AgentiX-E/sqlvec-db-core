/**
 * NullsIndexShim — Translates PostgreSQL NULLS FIRST/LAST index clauses
 * to SQLite-compatible equivalents.
 *
 * PostgreSQL allows explicit NULLS FIRST / NULLS LAST ordering in index
 * definitions:
 *   CREATE INDEX ON t (col DESC NULLS FIRST);
 *   CREATE INDEX ON t (col ASC NULLS LAST);
 *   CREATE INDEX ON t (col NULLS FIRST);
 *
 * SQLite supports ASC / DESC but **does not** support NULLS FIRST / NULLS LAST
 * clauses. Any explicit NULLS ordering must be stripped.
 *
 * Grammar mapping:
 *
 * | PostgreSQL                      | SQLite output    | Strategy                |
 * |---------------------------------|------------------|-------------------------|
 * | `col ASC`                       | `col ASC`        | ✅ Pass-through         |
 * | `col DESC`                      | `col DESC`       | ✅ Pass-through         |
 * | `col NULLS FIRST`               | `col`            | ⚠️ Strip NULLS FIRST    |
 * | `col NULLS LAST`                | `col`            | ⚠️ Strip NULLS LAST     |
 * | `col DESC NULLS FIRST`          | `col DESC`       | ⚠️ Strip NULLS FIRST    |
 * | `col ASC NULLS LAST`            | `col ASC`        | ⚠️ Strip NULLS LAST     |
 *
 * Limitations (regex-based):
 *   - NULLS FIRST/LAST appearing inside string literals or comments may trigger
 *     false positives (should be rare in index DDL).
 *   - Does not validate index structural correctness; it only performs
 *     syntactic clause removal.
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('NullsIndexShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface NullsIndexResult {
  /** Rewritten SQL string (always valid SQLite) */
  sql: string;
  /** Whether a NULLS FIRST/LAST clause was detected and removed */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — detection patterns
// ──────────────────────────────────────────────

/**
 * Detect any NULLS FIRST or NULLS LAST clause (case-insensitive).
 * Matches:
 *   - NULLS FIRST
 *   - NULLS LAST
 *   - nulls first
 *   - nulls last
 */
const NULLS_CLAUSE_PATTERN = /\bNULLS\s+(FIRST|LAST)\b/i;

/**
 * Match an explicit sort direction (ASC or DESC) immediately followed by
 * a NULLS FIRST/LAST clause.
 *
 * e.g. `DESC NULLS FIRST` → group 1 = 'DESC'  (group 0 = 'DESC NULLS FIRST')
 *      `ASC NULLS LAST`   → group 1 = 'ASC'
 *
 * Used to preserve the sort direction while removing the NULLS clause.
 */
const SORT_AND_NULLS_PATTERN = /\b(ASC|DESC)\s+NULLS\s+(FIRST|LAST)\b/i;

// ──────────────────────────────────────────────
//  Private helpers
// ──────────────────────────────────────────────

/**
 * Remove all NULLS FIRST/LAST clauses from a SQL string.
 *
 * Two-pass strategy:
 *   1. Handle `ASC/DESC NULLS FIRST/LAST` → keep only `ASC`/`DESC`
 *   2. Handle bare `NULLS FIRST/LAST` (no preceding sort direction) → remove entirely
 *
 * @param sql - Input SQL string
 * @returns Cleaned SQL string with NULLS clauses removed
 */
function stripNullsClauses(sql: string): string {
  // Pass 1: `DESC NULLS FIRST` → `DESC`  /  `ASC NULLS LAST` → `ASC`
  let result = sql.replace(SORT_AND_NULLS_PATTERN, '$1');

  // Pass 2: Bare `NULLS FIRST` or `NULLS LAST` → empty string
  result = result.replace(NULLS_CLAUSE_PATTERN, '');

  // Clean up any double spaces left by removals
  return result.replace(/\s{2,}/g, ' ').trim();
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains a NULLS FIRST or NULLS LAST clause.
 *
 * @param sql - A SQL statement (typically a CREATE INDEX)
 * @returns `true` if the SQL contains NULLS FIRST or NULLS LAST
 *
 * @example
 * ```ts
 * detectNullsClause('CREATE INDEX ON t (col DESC NULLS FIRST)'); // true
 * detectNullsClause('CREATE INDEX ON t (col ASC NULLS LAST)');   // true
 * detectNullsClause('CREATE INDEX ON t (col NULLS FIRST)');       // true
 * detectNullsClause('CREATE INDEX ON t (col ASC)');               // false
 * detectNullsClause('CREATE INDEX ON t (col)');                   // false
 * ```
 */
export function detectNullsClause(sql: string): boolean {
  return NULLS_CLAUSE_PATTERN.test(sql);
}

/**
 * Rewrite a SQL statement by removing all NULLS FIRST / NULLS LAST clauses.
 *
 * The function handles three patterns:
 *   - `col DESC NULLS FIRST` → `col DESC`  (preserves sort direction)
 *   - `col ASC NULLS LAST`   → `col ASC`   (preserves sort direction)
 *   - `col NULLS FIRST`      → `col`       (bare NULLS removed)
 *   - `col NULLS LAST`       → `col`       (bare NULLS removed)
 *
 * If no NULLS clause is detected, the SQL is returned unchanged with
 * `rewritten: false`.
 *
 * @param sql - A SQL statement that may contain NULLS FIRST/LAST clauses
 * @returns A {@link NullsIndexResult} with the rewritten SQL
 *
 * @example
 * ```ts
 * rewriteNullsClause('CREATE INDEX idx ON t (col DESC NULLS FIRST)');
 * // → { sql: 'CREATE INDEX idx ON t (col DESC)', rewritten: true }
 *
 * rewriteNullsClause('CREATE INDEX idx ON t (col NULLS FIRST)');
 * // → { sql: 'CREATE INDEX idx ON t (col)', rewritten: true }
 *
 * rewriteNullsClause('CREATE INDEX idx ON t (col ASC)');
 * // → { sql: 'CREATE INDEX idx ON t (col ASC)', rewritten: false }
 * ```
 */
export function rewriteNullsClause(sql: string): NullsIndexResult {
  const trimmed = sql.trim();

  if (!detectNullsClause(trimmed)) {
    // No NULLS clause detected — pass through unchanged
    return { sql: trimmed, rewritten: false };
  }

  const rewritten = stripNullsClauses(trimmed);

  logger.info(
    { original: trimmed, rewritten },
    'NullsIndexShim: NULLS FIRST/LAST clause stripped',
  );

  return { sql: rewritten, rewritten: true };
}
