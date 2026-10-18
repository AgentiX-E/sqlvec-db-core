/**
 * FdwShim — PostgreSQL Foreign Data Wrapper (FDW) compatibility shim for SQLite.
 *
 * SQLite has no concept of foreign data wrappers, servers, or foreign tables.
 * PostgreSQL uses FDW syntax extensively for external authentication sources
 * (LDAP, RADIUS, Kerberos, PAM) — all of which must be elided or converted
 * to SQLite-compatible forms when running schemas that reference FDW objects.
 *
 * ## Strategy
 *
 * | Source statement                                    | Rewritten to         | Behaviour             |
 * |-----------------------------------------------------|----------------------|-----------------------|
 * | `CREATE FOREIGN DATA WRAPPER name …`                | `SELECT 1`           | No-op (suppressed)    |
 * | `CREATE SERVER name FOREIGN DATA WRAPPER …`         | `SELECT 1`           | No-op (suppressed)    |
 * | `CREATE FOREIGN TABLE t (...) SERVER s [OPTIONS]`   | `CREATE TABLE t (...)`| Strips FDW-only parts |
 * | `ALTER SERVER name …`                               | `SELECT 1`           | No-op (suppressed)    |
 * | `DROP FOREIGN DATA WRAPPER name …`                  | `SELECT 1`           | No-op (suppressed)    |
 * | `DROP SERVER name …`                                | `SELECT 1`           | No-op (suppressed)    |
 * | `DROP FOREIGN TABLE [IF EXISTS] name`               | `DROP TABLE [IF EXISTS] name` | Translates to standard DDL |
 * | Non-FDW SQL                                         | (pass-through)       | Unchanged             |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite
 * - No false positives on non-FDW SQL
 * - Detection is conservative: only top-level FDW keywords
 * - Column-level `OPTIONS (...)` clauses are stripped from `CREATE FOREIGN TABLE`
 * - The `SERVER` + `OPTIONS` suffix is stripped from `CREATE FOREIGN TABLE`
 * - PinoLogger integration for debugging and audit trails
 *
 * @module FdwShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('FdwShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface FdwResult {
  /** Rewritten SQL (or original if not rewritten) */
  sql: string;
  /** Whether the statement was detected as FDW and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/** Matches `CREATE FOREIGN DATA WRAPPER name …` */
const CREATE_FDW_RE = /^\s*CREATE\s+FOREIGN\s+DATA\s+WRAPPER\s+/i;

/** Matches `CREATE SERVER name …` (always FDW-related in PG) */
const CREATE_SERVER_RE = /^\s*CREATE\s+SERVER\s+/i;

/** Matches `CREATE FOREIGN TABLE [IF NOT EXISTS] name …` */
const CREATE_FOREIGN_TABLE_RE = /^\s*CREATE\s+FOREIGN\s+TABLE\s+/i;

/** Matches `ALTER SERVER name …` */
const ALTER_SERVER_RE = /^\s*ALTER\s+SERVER\s+/i;

/** Matches `DROP FOREIGN DATA WRAPPER [IF EXISTS] name …` */
const DROP_FDW_RE = /^\s*DROP\s+FOREIGN\s+DATA\s+WRAPPER\s+/i;

/** Matches `DROP SERVER [IF EXISTS] name …` */
const DROP_SERVER_RE = /^\s*DROP\s+SERVER\s+/i;

/** Matches `DROP FOREIGN TABLE [IF EXISTS] name …` */
const DROP_FOREIGN_TABLE_RE = /^\s*DROP\s+FOREIGN\s+TABLE\s+/i;

/**
 * Combined regex for any FDW-related statement.
 *
 * Covers all seven statement families to power the {@link detectFdw}
 * function in a single pass.
 */
const FDW_RE =
  /^\s*(?:CREATE\s+(?:FOREIGN\s+DATA\s+WRAPPER|SERVER|FOREIGN\s+TABLE)|ALTER\s+SERVER|DROP\s+(?:FOREIGN\s+DATA\s+WRAPPER|SERVER|FOREIGN\s+TABLE))\s+/i;

/**
 * Strips column-level `OPTIONS (key 'value', …)` clauses.
 *
 * These are FDW-specific annotations attached to individual column definitions:
 * ```sql
 *   uid  int  OPTIONS (secret_value 'cn=admin,dc=example')
 * ```
 * They are not valid in SQLite and must be removed.
 *
 * Uses a non-greedy match inside parentheses, which works for the common
 * case where option values are simple quoted strings. Deeply nested parens
 * inside options are extremely rare in practice.
 */
const COLUMN_OPTIONS_RE = /\s+OPTIONS\s*\([^)]*\)\s*/gi;

/**
 * Strips the trailing `SERVER server_name [OPTIONS (…)]` clause.
 *
 * This clause always appears at the end of a `CREATE FOREIGN TABLE`
 * statement and has no SQLite equivalent.
 *
 * This must be reapplied after COLUMN_OPTIONS_RE because the SERVER
 * clause's own OPTIONS sub-clause would otherwise be consumed by the
 * column-level pattern.
 */
const SERVER_CLAUSE_RE = /\s+SERVER\s+[A-Za-z_]\w*(?:\s+OPTIONS\s*\([^)]*\))?\s*;?\s*$/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains an FDW-related statement.
 *
 * Checks for any of the following as the first keyword group:
 * - `CREATE FOREIGN DATA WRAPPER`
 * - `CREATE SERVER`
 * - `CREATE FOREIGN TABLE`
 * - `ALTER SERVER`
 * - `DROP FOREIGN DATA WRAPPER`
 * - `DROP SERVER`
 * - `DROP FOREIGN TABLE`
 *
 * @param sql  The raw SQL string to inspect.
 * @returns    `true` if the SQL is FDW-related.
 *
 * @example
 * ```ts
 * detectFdw('CREATE FOREIGN DATA WRAPPER ldap VALIDATOR ldap_fdw_validator');  // true
 * detectFdw('CREATE SERVER auth FOREIGN DATA WRAPPER ldap');                   // true
 * detectFdw('CREATE FOREIGN TABLE users (id int) SERVER auth');               // true
 * detectFdw('ALTER SERVER auth VERSION "1.0"');                               // true
 * detectFdw('DROP FOREIGN DATA WRAPPER ldap');                                 // true
 * detectFdw('DROP SERVER auth');                                               // true
 * detectFdw('DROP FOREIGN TABLE remote_users');                                // true
 * detectFdw('SELECT * FROM users');                                            // false
 * detectFdw('CREATE TABLE users (id int)');                                    // false
 * ```
 */
export function detectFdw(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return FDW_RE.test(sql.trim());
}

/**
 * Rewrite a PostgreSQL FDW statement to a SQLite-compatible equivalent.
 *
 * **Processing rules:**
 *
 * 1. `CREATE FOREIGN DATA WRAPPER name …` → `SELECT 1`
 * 2. `CREATE SERVER name FOREIGN DATA WRAPPER …` → `SELECT 1`
 * 3. `CREATE FOREIGN TABLE name (columns) SERVER s [OPTIONS]` → `CREATE TABLE name (columns)`
 *    — Strips the `FOREIGN` keyword, column-level `OPTIONS (...)` clauses,
 *      and the trailing `SERVER … OPTIONS (...)` suffix.
 * 4. `ALTER SERVER name …` → `SELECT 1`
 * 5. `DROP FOREIGN DATA WRAPPER name …` → `SELECT 1`
 * 6. `DROP SERVER name …` → `SELECT 1`
 * 7. `DROP FOREIGN TABLE [IF EXISTS] name …` → `DROP TABLE [IF EXISTS] name …`
 * 8. Non-FDW statements → pass-through (rewritten: false)
 *
 * @param sql  The raw SQL string to process.
 * @returns    An {@link FdwResult} indicating how the statement was handled.
 *
 * @example
 * ```ts
 * rewriteFdw('CREATE FOREIGN DATA WRAPPER ldap');
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteFdw('CREATE SERVER auth FOREIGN DATA WRAPPER ldap');
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteFdw('CREATE FOREIGN TABLE remote_users (id int, name text) SERVER auth');
 * // → { sql: 'CREATE TABLE remote_users (id int, name text)', rewritten: true }
 *
 * rewriteFdw(
 *   'CREATE FOREIGN TABLE t (uid int OPTIONS (secret \'val\')) SERVER s OPTIONS (url \'ldap://\')'
 * );
 * // → { sql: 'CREATE TABLE t (uid int)', rewritten: true }
 *
 * rewriteFdw('ALTER SERVER auth VERSION \'1.0\'');
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteFdw('DROP FOREIGN TABLE IF EXISTS remote_users');
 * // → { sql: 'DROP TABLE IF EXISTS remote_users', rewritten: true }
 *
 * rewriteFdw('SELECT 1');
 * // → { sql: 'SELECT 1', rewritten: false }
 * ```
 */
export function rewriteFdw(sql: string): FdwResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  const trimmed = sql.trim();

  // ── Step 1: Is this even an FDW statement? ──────────────────────

  if (!detectFdw(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  // ── Step 2: Route by statement type ─────────────────────────────

  // CREATE FOREIGN DATA WRAPPER → SELECT 1 (no-op)
  if (CREATE_FDW_RE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'CREATE FOREIGN DATA WRAPPER → SELECT 1 (no-op for SQLite)',
    );
    return { sql: 'SELECT 1', rewritten: true };
  }

  // DROP FOREIGN DATA WRAPPER → SELECT 1 (no-op)
  if (DROP_FDW_RE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'DROP FOREIGN DATA WRAPPER → SELECT 1 (no-op for SQLite)',
    );
    return { sql: 'SELECT 1', rewritten: true };
  }

  // CREATE SERVER → SELECT 1 (no-op)
  if (CREATE_SERVER_RE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'CREATE SERVER → SELECT 1 (no-op for SQLite)',
    );
    return { sql: 'SELECT 1', rewritten: true };
  }

  // ALTER SERVER → SELECT 1 (no-op)
  if (ALTER_SERVER_RE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER SERVER → SELECT 1 (no-op for SQLite)',
    );
    return { sql: 'SELECT 1', rewritten: true };
  }

  // DROP SERVER → SELECT 1 (no-op)
  if (DROP_SERVER_RE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'DROP SERVER → SELECT 1 (no-op for SQLite)',
    );
    return { sql: 'SELECT 1', rewritten: true };
  }

  // CREATE FOREIGN TABLE → CREATE TABLE (strip FOREIGN keyword,
  // column-level OPTIONS, and trailing SERVER clause)
  if (CREATE_FOREIGN_TABLE_RE.test(trimmed)) {
    let rewritten = trimmed.replace(CREATE_FOREIGN_TABLE_RE, 'CREATE TABLE ');

    // Strip column-level OPTIONS (...). The leading `\s+` in
    // COLUMN_OPTIONS_RE already consumes the whitespace before the OPTIONS
    // keyword, so replacing with an empty string (rather than a single space)
    // avoids leaving a stray trailing space before the closing `)` or `,`.
    rewritten = rewritten.replace(COLUMN_OPTIONS_RE, '');

    // Strip trailing SERVER server_name [OPTIONS (...)]
    rewritten = rewritten.replace(SERVER_CLAUSE_RE, '');

    // Normalize trailing whitespace
    rewritten = rewritten.replace(/[;\s]+$/, '').trim();

    logger.debug(
      { original: trimmed },
      'Rewrote CREATE FOREIGN TABLE → CREATE TABLE: %s',
      rewritten,
    );
    return { sql: rewritten, rewritten: true };
  }

  // DROP FOREIGN TABLE → DROP TABLE (strip FOREIGN keyword,
  // keep IF EXISTS, table names, CASCADE/RESTRICT)
  // The false side of this final branch is unreachable: when detectFdw is
  // true and none of the six preceding patterns matched, the statement must
  // be a DROP FOREIGN TABLE (FDW_RE is their strict union), so this test is
  // always true at this point. Kept as an explicit guard.
  /* c8 ignore next */
  if (DROP_FOREIGN_TABLE_RE.test(trimmed)) {
    const rewritten = trimmed.replace(DROP_FOREIGN_TABLE_RE, 'DROP TABLE ');

    logger.debug(
      { original: trimmed },
      'Rewrote DROP FOREIGN TABLE → DROP TABLE: %s',
      rewritten,
    );
    return { sql: rewritten, rewritten: true };
  }

  // ── Fallback ────────────────────────────────────────────────────

  // Should not normally reach here if detectFdw is correct; defensive
  // pass-through ensures no statements are silently dropped. The combined
  // FDW_RE is a strict union of the seven individual patterns above, so if
  // detectFdw returned true at least one of the preceding branches would have
  // matched. This fallback is therefore unreachable and kept as a defensive
  // guard only.
  /* c8 ignore next 5 */
  logger.warn(
    { sql: trimmed },
    'detectFdw returned true but no FDW pattern matched — passing through unchanged',
  );
  /* c8 ignore next */
  return { sql: trimmed, rewritten: false };
}
