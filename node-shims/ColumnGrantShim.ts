/**
 * ColumnGrantShim — PostgreSQL column-level GRANT compatibility shim for SQLite.
 *
 * PostgreSQL supports column-level privilege grants:
 *   GRANT SELECT(col1, col2) ON t TO user;
 *   GRANT INSERT(col1)   ON t TO user;
 *   GRANT UPDATE(col1)   ON t TO user;
 *   GRANT REFERENCES(col1) ON t TO user;
 *
 * SQLite only supports table-level GRANT (no column list).
 * This shim strips the column list specification from GRANT statements
 * while preserving all other semantics.
 *
 * Strategy:
 *   1. GRANT privilege(col1, col2, ...) ON ... TO ... → GRANT privilege ON ... TO ...
 *   2. GRANT privilege ON ... TO ... (no column list) → pass through unchanged
 *
 * Column-list syntax is matched for any GRANT privilege keyword immediately
 * followed by a parenthesized column list. The column list is removed,
 * leaving the rest of the statement intact.
 *
 * @module ColumnGrantShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { ColumnGrantChecker } from '../security/ColumnGrantChecker';

const logger = PinoLogger.forComponent('ColumnGrantShim');

// ── Types ────────────────────────────────────────────────────────

export interface ColumnGrantResult {
  sql: string;
  rewritten: boolean;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * Regex matching column-level GRANT syntax.
 *
 * Matches:
 *   GRANT <privilege>(<column-list>) ON <object> TO <grantee>
 *   e.g. GRANT SELECT(col1, col2) ON my_table TO my_user
 *
 * The capture groups extract:
 *   - The full GRANT prefix up to and including the privilege keyword (group 1)
 *   - The parenthesized column list (group 2)
 *   - The remainder from ON onward (group 3)
 *
 * The regex also captures the grantee (the word or quoted identifier after TO) in group 4.
 *
 * Groups:
 *   1: "GRANT privilege"
 *   2: column list content (e.g. "col1, col2")
 *   3: " ON ... TO grantee..."
 *   4: grantee identifier
 */
const COLUMN_GRANT_RE = /^(GRANT\s+(\w+))\s*\(([^)]*)\)\s+(ON\s+.+?)\s+TO\s+([^\s;]+)/im;

// ── Exports ──────────────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains a column-level GRANT.
 *
 * A column-level GRANT has the form:
 *   GRANT privilege(col1, col2, ...) ON object TO grantee
 *
 * @param sql - The SQL statement to inspect.
 * @returns `true` if the statement is a column-level GRANT.
 */
export function detectColumnGrant(sql: string): boolean {
  return COLUMN_GRANT_RE.test(sql.trim());
}

/**
 * Rewrite a column-level GRANT statement by stripping the column list.
 *
 * Transformations:
 *   1. Column-level GRANT:
 *        GRANT SELECT(col1, col2) ON t TO user
 *        → GRANT SELECT ON t TO user
 *
 *   2. Table-level GRANT (no column list):
 *        GRANT SELECT ON t TO user
 *        → GRANT SELECT ON t TO user (pass through, rewritten=false)
 *
 *   3. Non-GRANT statements:
 *        → pass through unchanged (rewritten=false)
 *
 * If a ColumnGrantChecker is provided, the column-level grant metadata is
 * recorded via `grantColumnPrivilege()` for later enforcement.
 *
 * @param sql     - The SQL statement to rewrite.
 * @param checker - Optional ColumnGrantChecker to record column-level grants.
 * @returns A `ColumnGrantResult` with the (possibly rewritten) SQL and
 *          a flag indicating whether a rewrite occurred.
 */
export function rewriteColumnGrant(
  sql: string,
  checker?: ColumnGrantChecker,
): ColumnGrantResult {
  const trimmed = sql.trim();
  const match = COLUMN_GRANT_RE.exec(trimmed);

  if (!match) {
    // Not a column-level GRANT — pass through unchanged
    return { sql: trimmed, rewritten: false };
  }

  // match[1] = "GRANT privilege"          (e.g. "GRANT SELECT")
  // match[2] = privilege keyword           (e.g. "SELECT")
  // match[3] = column list content         (e.g. "col1, col2")
  // match[4] = " ON ..." part             (e.g. " ON t")
  // match[5] = grantee identifier          (e.g. "user")
  const grantPrefix = match[1];
  const privilegeKeyword = match[2];
  const columnListStr = match[3];
  const onPart = match[4];
  const grantee = match[5];

  // Record the column-level grant if a checker is available
  if (checker && checker.isReady()) {
    const tableName = extractTableFromOnClause(onPart);
    const columns = columnListStr
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    if (tableName && columns.length > 0) {
      checker.grantColumnPrivilege(grantee, tableName, privilegeKeyword, columns);
    }
  }

  const rewritten = `${grantPrefix} ${onPart} TO ${grantee}`;

  logger.debug('Rewritten column-level GRANT: original=%s rewritten=%s', trimmed, rewritten);

  return { sql: rewritten, rewritten: true };
}

/**
 * Extract the table name from an ON clause fragment.
 *
 * Handles:
 *   " ON t"         → "t"
 *   " ON schema.t"  → "schema.t"
 *   " ON public.t"  → "public.t"
 *
 * @param onClause - The ON clause fragment (e.g. " ON t").
 * @returns The table name, or empty string if not found.
 */
function extractTableFromOnClause(onClause: string): string {
  // Strip leading "ON " and any schema prefix
  const trimmed = onClause.replace(/^\s*ON\s+/i, '').trim();
  // Return everything up to the first whitespace or end
  return trimmed.split(/\s+/)[0] || '';
}
