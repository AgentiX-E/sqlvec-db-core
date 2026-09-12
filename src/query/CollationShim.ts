/**
 * CollationShim — Strips COLLATE clauses from SQL for SQLite compatibility.
 *
 * PostgreSQL's COLLATE clause specifies sorting rules (e.g., `ORDER BY name COLLATE "C"`).
 * SQLite does not support COLLATE in the same way. This shim removes COLLATE clauses
 * from SQL before passing them to the SQLite engine, since collation is irrelevant
 * for SQLite's storage/comparison logic.
 *
 * Contexts where COLLATE appears:
 *   - Column type definition:  col TEXT COLLATE "C"
 *   - ORDER BY:                ORDER BY name COLLATE "C"
 *   - Comparison:              name COLLATE "C" > 'foo'
 *   - GROUP BY:                GROUP BY name COLLATE "C"
 *   - DISTINCT ON:             DISTINCT ON (name COLLATE "C")
 *   - Window functions:        PARTITION BY name COLLATE "C"
 *   - CREATE INDEX:            CREATE INDEX i ON t (name COLLATE "C")
 *   - CREATE/ALTER TABLE:      col TEXT COLLATE "C"
 *
 * Strategy: Remove the `COLLATE <identifier-or-string>` token pair from the SQL string
 * using regex. COLLATE is a reserved keyword in PG, so the risk of false positives
 * is low. String literals, quoted identifiers, and comments are protected first so
 * a COLLATE token inside them is never stripped.
 */

import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

/**
 * Regex source for `COLLATE <identifier-or-string>` (the `g`/`i` flags are applied
 * per-call via a fresh instance, never via a shared module-level RegExp).
 */
const COLLATE_PATTERN_SOURCE = '\\s+COLLATE\\s+(?:"[^"]*"|\'[^\']*\'|[a-zA-Z_][a-zA-Z0-9_.]*)';

/**
 * Strip all COLLATE clauses from a SQL string.
 * Returns the SQL with COLLATE removed.
 *
 * String literals, quoted identifiers, and comments are shielded behind
 * placeholders before stripping so a COLLATE keyword that appears inside them is
 * preserved verbatim.
 */
export function stripCollate(sql: string): string {
  const protectedSql = protectSQL(sql);
  const stripped = protectedSql.protectedSql.replace(
    new RegExp(COLLATE_PATTERN_SOURCE, 'gi'),
    '',
  );
  return restoreSQL({ ...protectedSql, protectedSql: stripped });
}

/**
 * Check if a SQL string contains a COLLATE clause.
 *
 * Uses a fresh (non-shared) regex instance on each call so `lastIndex` state from
 * a previous `test()` never leaks across invocations (a shared `/g` RegExp would
 * return different results for the same input depending on call order — the same
 * trap documented in MacAddrShim and LiteralProtectionLayer).
 */
export function hasCollate(sql: string): boolean {
  return new RegExp(COLLATE_PATTERN_SOURCE, 'gi').test(sql);
}
