/**
 * DclShim — PostgreSQL Data Control Language (GRANT/REVOKE) no-op shim.
 *
 * SQLite ships without a DCL grammar, so a bare table-level
 * `GRANT SELECT ON t TO reader` (or REVOKE) would otherwise reach SQLite and
 * fail with `near "GRANT": syntax error`. This compatibility layer does not
 * implement a role/privilege enforcement model, so table-level GRANT/REVOKE
 * statements are advisory metadata and are accepted as no-ops.
 *
 * Column-level GRANT (`GRANT SELECT(col) ON t TO u`) is handled separately by
 * ColumnGrantShim, which records the per-column privilege and strips the
 * column list. This shim only covers the generic table-level form.
 *
 * @module DclShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('DclShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface DclResult {
  /** `null` turns the statement into a no-op; otherwise the (un)modified SQL. */
  sql: string | null;
  /** Whether a DCL statement was recognized and handled. */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/**
 * Matches a table-level (no column list) GRANT or REVOKE statement. The
 * negative lookahead `(?!\s*\()` ensures `GRANT SELECT(col) …` is left for
 * ColumnGrantShim rather than swallowed here.
 */
const DCL_RE = /^\s*(GRANT|REVOKE)\s+\w+(?!\s*\()/i;

/**
 * Detect a table-level GRANT or REVOKE (DCL) statement.
 */
export function detectDcl(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  return DCL_RE.test(protectSQL(sql.trim()).protectedSql);
}

/**
 * Turn a table-level GRANT/REVOKE into a no-op.
 *
 * Returns `{ sql: null, rewritten: true }` so the caller can skip execution.
 *
 * @param sql - A GRANT/REVOKE statement (already filtered by detectDcl).
 */
export function rewriteDcl(sql: string): DclResult {
  logger.debug('Table-level DCL accepted as a no-op (SQLite has no DCL grammar)');
  return { sql: null, rewritten: true };
}
