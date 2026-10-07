/**
 * ForUpdateShim — Parse and strip FOR UPDATE / FOR SHARE clauses from SELECT SQL.
 *
 * Delegate row-level locking execution to ForUpdateExecutor.
 * Locks are managed via RowLockManager.
 *
 * PostgreSQL supports row-level locking clauses on SELECT:
 *   - FOR UPDATE
 *   - FOR NO KEY UPDATE
 *   - FOR SHARE
 *   - FOR KEY SHARE
 *
 * Each can be combined with NOWAIT or SKIP LOCKED, and optionally restricted
 * to specific tables via `OF table [, ...]`.
 *
 * SQLite does not support any of these clauses, so we must:
 *   1. Parse and extract the locking clause before passing to SQLite
 *   2. Apply row-level locking after getting results
 *
 * @module query/ForUpdateShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('ForUpdateShim');

// ── Types ────────────────────────────────────────────────────────

export type LockStrength = 'UPDATE' | 'NO_KEY_UPDATE' | 'SHARE' | 'KEY_SHARE';

export interface ForUpdateClause {
  hasForUpdate: boolean;
  hasForShare: boolean;
  hasForNoKeyUpdate: boolean;
  hasForKeyShare: boolean;
  lockStrength: LockStrength;
  nowait: boolean;
  skipLocked: boolean;
  tables?: string[]; // OF table1, table2 — if specified
}

// ── Constants — Regex patterns ───────────────────────────────────

/**
 * Matches the FOR UPDATE clause at the end of a SELECT statement.
 *
 * PostgreSQL Syntax:
 *   FOR UPDATE [OF table_name [, ...]] [NOWAIT | SKIP LOCKED]
 *   FOR NO KEY UPDATE [OF table_name [, ...]] [NOWAIT | SKIP LOCKED]
 *   FOR SHARE [OF table_name [, ...]] [NOWAIT | SKIP LOCKED]
 *   FOR KEY SHARE [OF table_name [, ...]] [NOWAIT | SKIP LOCKED]
 *
 * We match these clauses anchored to the end of the SQL string, with optional
 * trailing semicolon and whitespace.
 *
 * Groups:
 *   1 — Lock strength keyword (UPDATE | NO KEY UPDATE | SHARE | KEY SHARE)
 *   2 — OF table list (optional)
 *   3 — NOWAIT or SKIP LOCKED (optional)
 *
 * IMPORTANT: This regex must match the ENTIRE remainder of the SQL.
 *   - FOR NO KEY UPDATE must be tested before FOR UPDATE (since "UPDATE"
 *     is a substring of "NO KEY UPDATE")
 *   - FOR KEY SHARE must be tested before FOR SHARE (since "SHARE"
 *     is a substring of "KEY SHARE")
 */
const FOR_CLAUSE_PATTERN = /\s+FOR\s+(NO\s+KEY\s+UPDATE|KEY\s+SHARE|SHARE|UPDATE)(?:\s+OF\s+([^\s,]+(?:\s*,\s*[^\s,]+)*))?(?:\s+(NOWAIT|SKIP\s+LOCKED))?\s*;?\s*$/i;

/**
 * Simpler pattern just to detect the presence of a FOR UPDATE / FOR SHARE
 * clause. Lists the four real lock strengths explicitly (matching
 * FOR_CLAUSE_PATTERN) so it does NOT accept the nonexistent "NO KEY SHARE".
 */
const FOR_CLAUSE_DETECT = /\s+FOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|SHARE|UPDATE)\b/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * Check if the SQL string contains a FOR UPDATE / FOR SHARE clause.
 *
 * @param sql - The raw SQL string to inspect.
 * @returns `true` if the SQL contains a row-level locking clause.
 *
 * @example
 * ```ts
 * hasForUpdate('SELECT * FROM users FOR UPDATE');              // true
 * hasForUpdate('SELECT * FROM users FOR UPDATE NOWAIT');       // true
 * hasForUpdate('SELECT * FROM users FOR SHARE');               // true
 * hasForUpdate('SELECT * FROM users FOR NO KEY UPDATE');       // true
 * hasForUpdate('SELECT * FROM users FOR KEY SHARE');           // true
 * hasForUpdate('SELECT * FROM users');                          // false
 * ```
 */
export function hasForUpdate(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return FOR_CLAUSE_DETECT.test(sql.trim());
}

/**
 * Parse a FOR UPDATE / FOR SHARE clause from a SELECT SQL string.
 *
 * Returns `null` if no locking clause is found.
 *
 * @param sql - The raw SQL string to parse.
 * @returns The parsed ForUpdateClause, or `null`.
 *
 * @example
 * ```ts
 * parseForUpdate('SELECT * FROM users FOR UPDATE');
 * // → { hasForUpdate: true, hasForShare: false, ..., lockStrength: 'UPDATE',
 * //     nowait: false, skipLocked: false, tables: undefined }
 *
 * parseForUpdate('SELECT * FROM users FOR UPDATE NOWAIT');
 * // → { ..., nowait: true, skipLocked: false }
 *
 * parseForUpdate('SELECT * FROM users FOR SHARE OF t1, t2');
 * // → { ..., lockStrength: 'SHARE', tables: ['t1', 't2'] }
 *
 * parseForUpdate('SELECT * FROM users');
 * // → null
 * ```
 */
export function parseForUpdate(sql: string): ForUpdateClause | null {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return null;
  }

  const trimmed = sql.trim();

  // Check for FOR NO KEY UPDATE first (before plain UPDATE)
  // Check for FOR KEY SHARE first (before plain SHARE)
  const match = trimmed.match(FOR_CLAUSE_PATTERN);

  if (!match) {
    return null;
  }

  const rawStrength = match[1].trim();
  const rawTables = match[2] ? match[2].trim() : undefined;
  const rawOption = match[3] ? match[3].trim() : undefined;

  let lockStrength: LockStrength;
  let hasForUpdate = false;
  let hasForShare = false;
  let hasForNoKeyUpdate = false;
  let hasForKeyShare = false;

  const upperStrength = rawStrength.toUpperCase();
  if (upperStrength === 'UPDATE') {
    lockStrength = 'UPDATE';
    hasForUpdate = true;
  } else if (upperStrength === 'NO KEY UPDATE') {
    lockStrength = 'NO_KEY_UPDATE';
    hasForNoKeyUpdate = true;
  } else if (upperStrength === 'SHARE') {
    lockStrength = 'SHARE';
    hasForShare = true;
  } else if (upperStrength === 'KEY SHARE') {
    lockStrength = 'KEY_SHARE';
    hasForKeyShare = true;
  } else {
    // Should not happen — regex only matches known patterns
    return null;
  }

  let tables: string[] | undefined;
  if (rawTables) {
    tables = rawTables.split(',').map(t => t.trim()).filter(t => t.length > 0);
  }

  const upperOption = rawOption ? rawOption.toUpperCase() : '';
  const nowait = upperOption === 'NOWAIT';
  const skipLocked = upperOption === 'SKIP LOCKED';
  // NOWAIT and SKIP LOCKED are mutually exclusive; NOWAIT takes precedence per PG

  logger.debug(
    { lockStrength, nowait, skipLocked, tables, sql: trimmed },
    'Parsed FOR UPDATE clause',
  );

  return {
    hasForUpdate,
    hasForShare,
    hasForNoKeyUpdate,
    hasForKeyShare,
    lockStrength,
    nowait,
    skipLocked,
    tables,
  };
}

/**
 * Strip the FOR UPDATE / FOR SHARE clause from a SELECT SQL string,
 * returning SQL that SQLite can execute.
 *
 * If no locking clause is found, the original SQL is returned unchanged.
 *
 * @param sql - The raw SQL string.
 * @returns SQL with any FOR UPDATE clause removed.
 *
 * @example
 * ```ts
 * stripForUpdate('SELECT * FROM users FOR UPDATE');
 * // → 'SELECT * FROM users'
 *
 * stripForUpdate('SELECT * FROM users FOR UPDATE NOWAIT');
 * // → 'SELECT * FROM users'
 *
 * stripForUpdate('SELECT * FROM users');
 * // → 'SELECT * FROM users'
 * ```
 */
export function stripForUpdate(sql: string): string {
  if (typeof sql !== 'string') {
    return '';
  }
  if (sql.trim().length === 0) {
    return sql;
  }

  // Replace the FOR clause with empty string
  const stripped = sql.replace(FOR_CLAUSE_PATTERN, '');

  if (stripped !== sql) {
    logger.debug({ original: sql, stripped }, 'Stripped FOR UPDATE clause from SQL');
  }

  return stripped;
}
