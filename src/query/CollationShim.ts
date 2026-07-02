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
 * is low.
 */

const COLLATE_PATTERN = /\s+COLLATE\s+(?:"[^"]*"|'[^']*'|[a-zA-Z_][a-zA-Z0-9_.]*)/gi;

/**
 * Strip all COLLATE clauses from a SQL string.
 * Returns the SQL with COLLATE removed.
 */
export function stripCollate(sql: string): string {
  return sql.replace(COLLATE_PATTERN, '');
}

/**
 * Check if a SQL string contains a COLLATE clause.
 */
export function hasCollate(sql: string): boolean {
  return COLLATE_PATTERN.test(sql);
}
