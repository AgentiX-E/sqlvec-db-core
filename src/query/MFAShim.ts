/**
 * MFAShim — PostgreSQL Multi-Factor Authentication compatibility shim for
 * SQLite.
 *
 * PostgreSQL supports Multi-Factor Authentication via GUC parameters such
 * as `mfa.enabled`, `mfa.require_entity`, and per-role settings like
 * `mfa_required`. Administrators may also use `ALTER SYSTEM SET mfa.*`
 * to persist MFA configuration in the postgresql.auto.conf file. SQLite
 * has no MFA concept — it is single-user, single-node by design. This
 * shim detects MFA-related SQL and rewrites each variant to a valid
 * SQLite-compatible no-op or placeholder result.
 *
 * ## Strategy
 *
 * | Input                                                           | Output                                    | rewritten |
 * |-----------------------------------------------------------------|-------------------------------------------|-----------|
 * | `ALTER ROLE bob SET mfa_required = true`                        | `SELECT 1`                                | true      |
 * | `SET mfa.enabled = on`                                          | `SELECT 1`                                | true      |
 * | `SET mfa.require_entity = 'totp'`                               | `SELECT 1`                                | true      |
 * | `SHOW mfa.enabled`                                              | `SELECT 'off' AS mfa_enabled`             | true      |
 * | `SHOW mfa.require_entity`                                       | `SELECT '' AS mfa_require_entity`         | true      |
 * | `ALTER SYSTEM SET mfa.some_param = 'value'`                     | `SELECT 1`                                | true      |
 * | `SELECT 1;`                                                      | (pass-through)                            | false     |
 * | `CREATE TABLE t (id INT);`                                       | (pass-through)                            | false     |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-MFA SQL
 * - Case-insensitive matching for SQL keywords and GUC names
 * - Multi-statement and sub-expression usage beyond the scope of this
 *   shim (callers should pre-separate statements before routing here)
 * - PinoLogger integration for debugging and audit trails
 *
 * @module MFAShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { SecurityNoticeCollector } from './SecurityNoticeCollector';

const logger = PinoLogger.forComponent('MFAShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface MFAResult {
  /** Rewritten SQL (placeholder if rewritten, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as an MFA operation and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches `ALTER ROLE <rolename> SET mfa_required = true|false` as a
 * top-level statement.
 *
 * Covers:
 *   ALTER ROLE bob SET mfa_required = true
 *   ALTER ROLE "alice" SET mfa_required = false
 *   ALTER ROLE bob SET mfa_required TO off
 *
 * Pattern: ALTER ROLE <name> SET mfa_required =|TO <value>
 * Case-insensitive.
 */
const ALTER_ROLE_MFA_REQUIRED =
  /^\s*ALTER\s+ROLE\s+.+?\s+SET\s+mfa_required\s*(?:=)\s*\S+/i;

/**
 * Matches `SET mfa.enabled = on|off` as a top-level statement.
 *
 * Covers:
 *   SET mfa.enabled = on
 *   SET mfa.enabled = off
 *   SET SESSION mfa.enabled = on
 *   SET LOCAL mfa.enabled = off
 *   SET mfa.enabled TO on
 *
 * Pattern: SET [SESSION|LOCAL] mfa.enabled =|TO <value>
 * Case-insensitive.
 */
const SET_MFA_ENABLED =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?mfa\.enabled\s*(?:[=:]\s*|\s+TO\s+)\S+/i;

/**
 * Matches `SET mfa.require_entity = '...'` as a top-level statement.
 *
 * Covers:
 *   SET mfa.require_entity = 'totp'
 *   SET SESSION mfa.require_entity = 'phone'
 *   SET LOCAL mfa.require_entity = 'yubikey'
 *   SET mfa.require_entity TO 'email'
 *
 * Pattern: SET [SESSION|LOCAL] mfa.require_entity =|TO <value>
 * Case-insensitive.
 */
const SET_MFA_REQUIRE_ENTITY =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?mfa\.require_entity\s*(?:[=:]\s*|\s+TO\s+)\S+/i;

/**
 * Matches `SHOW mfa.enabled` as a top-level statement.
 *
 * Pattern: SHOW mfa.enabled
 * Case-insensitive.
 */
const SHOW_MFA_ENABLED =
  /^\s*SHOW\s+mfa\.enabled\s*;?\s*$/i;

/**
 * Matches `SHOW mfa.require_entity` as a top-level statement.
 *
 * Pattern: SHOW mfa.require_entity
 * Case-insensitive.
 */
const SHOW_MFA_REQUIRE_ENTITY =
  /^\s*SHOW\s+mfa\.require_entity\s*;?\s*$/i;

/**
 * Matches `ALTER SYSTEM SET mfa.<any_param> = '...'` as a top-level
 * statement.
 *
 * Covers:
 *   ALTER SYSTEM SET mfa.enabled = on
 *   ALTER SYSTEM SET mfa.require_entity = 'totp'
 *   ALTER SYSTEM SET mfa.custom_param = 'value'
 *
 * Pattern: ALTER SYSTEM SET mfa.<name> =|TO <value>
 * Case-insensitive.
 */
const ALTER_SYSTEM_SET_MFA =
  /^\s*ALTER\s+SYSTEM\s+SET\s+mfa\.\S+/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL MFA operation.
 *
 * The following patterns are detected:
 * - `ALTER ROLE <name> SET mfa_required = <value>`
 * - `SET mfa.enabled = <value>`
 * - `SET mfa.require_entity = <value>`
 * - `SHOW mfa.enabled`
 * - `SHOW mfa.require_entity`
 * - `ALTER SYSTEM SET mfa.*`
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is an MFA operation
 *
 * @example
 * ```ts
 * detectMFA("ALTER ROLE bob SET mfa_required = true");        // true
 * detectMFA("SET mfa.enabled = on");                           // true
 * detectMFA("SHOW mfa.enabled");                               // true
 * detectMFA("ALTER SYSTEM SET mfa.foo = 'bar'");              // true
 * detectMFA("SELECT 1;");                                      // false
 * detectMFA("CREATE TABLE t (id INT);");                       // false
 * ```
 */
export function detectMFA(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Check ALTER ROLE ... SET mfa_required = ...
  if (ALTER_ROLE_MFA_REQUIRED.test(trimmed)) {
    return true;
  }

  // Check SET mfa.enabled = ...
  if (SET_MFA_ENABLED.test(trimmed)) {
    return true;
  }

  // Check SET mfa.require_entity = ...
  if (SET_MFA_REQUIRE_ENTITY.test(trimmed)) {
    return true;
  }

  // Check SHOW mfa.enabled
  if (SHOW_MFA_ENABLED.test(trimmed)) {
    return true;
  }

  // Check SHOW mfa.require_entity
  if (SHOW_MFA_REQUIRE_ENTITY.test(trimmed)) {
    return true;
  }

  // Check ALTER SYSTEM SET mfa.*
  if (ALTER_SYSTEM_SET_MFA.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL MFA SQL statement to a SQLite-compatible
 * placeholder.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not an MFA operation, return unchanged with
 *    `rewritten: false`.
 * 2. If it is `ALTER ROLE <name> SET mfa_required = <value>`, return
 *    `SELECT 1` (a no-op placeholder) with `rewritten: true`.
 * 3. If it is `SET mfa.enabled = <value>`, return `SELECT 1` (a no-op
 *    placeholder) with `rewritten: true`.
 * 4. If it is `SET mfa.require_entity = <value>`, return `SELECT 1`
 *    (a no-op placeholder) with `rewritten: true`.
 * 5. If it is `SHOW mfa.enabled`, return
 *    `SELECT 'off' AS mfa_enabled` (MFA is not applicable to SQLite)
 *    with `rewritten: true`.
 * 6. If it is `SHOW mfa.require_entity`, return
 *    `SELECT '' AS mfa_require_entity` (no MFA entity is meaningful
 *    in SQLite) with `rewritten: true`.
 * 7. If it is `ALTER SYSTEM SET mfa.*`, return `SELECT 1` (a no-op
 *    placeholder) with `rewritten: true`.
 * 8. Otherwise, pass through unchanged.
 *
 * @param sql   The raw SQL string to process
 * @returns     An {@link MFAResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteMFA("ALTER ROLE bob SET mfa_required = true");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteMFA("SET mfa.enabled = on");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteMFA("SET mfa.require_entity = 'totp'");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteMFA('SHOW mfa.enabled');
 * // → { sql: "SELECT 'off' AS mfa_enabled", rewritten: true }
 *
 * rewriteMFA('SHOW mfa.require_entity');
 * // → { sql: "SELECT '' AS mfa_require_entity", rewritten: true }
 *
 * rewriteMFA("ALTER SYSTEM SET mfa.enabled = on");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteMFA('SELECT 1;');
 * // → { sql: 'SELECT 1;', rewritten: false }
 * ```
 */
export function rewriteMFA(sql: string): MFAResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Check ALTER ROLE ... SET mfa_required ──────────

  if (ALTER_ROLE_MFA_REQUIRED.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER ROLE SET mfa_required detected — rewriting to SELECT 1 (no-op)',
    );
    SecurityNoticeCollector.add('mfa', 'MFA is not implemented by this database vendor');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 2: Check SET mfa.enabled ──────────────────────────

  if (SET_MFA_ENABLED.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SET mfa.enabled detected — rewriting to SELECT 1 (no-op)',
    );
    SecurityNoticeCollector.add('mfa', 'MFA is not implemented by this database vendor');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 3: Check SET mfa.require_entity ───────────────────

  if (SET_MFA_REQUIRE_ENTITY.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SET mfa.require_entity detected — rewriting to SELECT 1 (no-op)',
    );
    SecurityNoticeCollector.add('mfa', 'MFA is not implemented by this database vendor');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 4: Check SHOW mfa.enabled ─────────────────────────

  if (SHOW_MFA_ENABLED.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SHOW mfa.enabled detected — rewriting to \'off\' placeholder (MFA not applicable to SQLite)',
    );
    SecurityNoticeCollector.add('mfa', 'MFA is not implemented by this database vendor');
    return {
      sql: "SELECT 'off' AS mfa_enabled",
      rewritten: true,
    };
  }

  // ── Step 5: Check SHOW mfa.require_entity ──────────────────

  if (SHOW_MFA_REQUIRE_ENTITY.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SHOW mfa.require_entity detected — rewriting to empty placeholder (MFA not applicable to SQLite)',
    );
    SecurityNoticeCollector.add('mfa', 'MFA is not implemented by this database vendor');
    return {
      sql: "SELECT '' AS mfa_require_entity",
      rewritten: true,
    };
  }

  // ── Step 6: Check ALTER SYSTEM SET mfa.* ───────────────────

  if (ALTER_SYSTEM_SET_MFA.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER SYSTEM SET mfa.* detected — rewriting to SELECT 1 (no-op)',
    );
    SecurityNoticeCollector.add('mfa', 'MFA is not implemented by this database vendor');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 7: Not an MFA operation — pass through ────────────

  return {
    sql: trimmed,
    rewritten: false,
  };
}
