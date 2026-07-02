/**
 * RowLevelSecurityShim — PostgreSQL Row-Level Security compatibility shim for SQLite.
 *
 * PostgreSQL supports row-level security (RLS) which allows fine-grained
 * access control at the row level:
 *
 * ```sql
 * ALTER TABLE t ENABLE ROW LEVEL SECURITY;
 * ALTER TABLE t FORCE ROW LEVEL SECURITY;
 * CREATE POLICY p ON t FOR SELECT TO role USING (expr);
 * ALTER POLICY p ON t USING (expr);
 * DROP POLICY p ON t;
 * ```
 *
 * SQLite has no equivalent RLS mechanism. Since sqlvec-db relies on
 * SQLite as its embedded engine, all RLS-related DDL must be elided.
 *
 * ## Strategy
 *
 * All RLS-related statements are rewritten to `SELECT 1`, a safe no-op
 * that returns a single-row result (avoids breaking code that expects
 * a result set from the statement).
 *
 * | Input                                                | Output     | rewritten |
 * |------------------------------------------------------|------------|-----------|
 * | `ALTER TABLE t ENABLE ROW LEVEL SECURITY`            | `SELECT 1` | true      |
 * | `ALTER TABLE t DISABLE ROW LEVEL SECURITY`           | `SELECT 1` | true      |
 * | `ALTER TABLE t FORCE ROW LEVEL SECURITY`             | `SELECT 1` | true      |
 * | `ALTER TABLE t NO FORCE ROW LEVEL SECURITY`          | `SELECT 1` | true      |
 * | `CREATE POLICY p ON t FOR SELECT TO role USING (e)`  | `SELECT 1` | true      |
 * | `CREATE POLICY p ON t AS PERMISSIVE FOR ALL TO role` | `SELECT 1` | true      |
 * | `ALTER POLICY p ON t USING (expr)`                   | `SELECT 1` | true      |
 * | `ALTER POLICY p ON t RENAME TO p2`                   | `SELECT 1` | true      |
 * | `DROP POLICY p ON t`                                 | `SELECT 1` | true      |
 * | `DROP POLICY IF EXISTS p ON t`                       | `SELECT 1` | true      |
 * | `SELECT 1;`                                          | (pass-through) | false |
 * | `INSERT INTO t VALUES (1);`                          | (pass-through) | false |
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-RLS SQL (e.g. columns named `policy`)
 * - Detection is conservative: only top-level ALTER TABLE ... ROW LEVEL SECURITY,
 *   CREATE/ALTER/DROP POLICY statements
 * - PinoLogger integration for debugging and audit trails
 *
 * @module RowLevelSecurityShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('RowLevelSecurityShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface RLSResult {
  /** Rewritten SQL ("SELECT 1" if rewritten, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as RLS-related and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches ALTER TABLE ... ENABLE/DISABLE/FORCE/NO FORCE ROW LEVEL SECURITY.
 *
 * PostgreSQL grammar:
 *   ALTER TABLE [ONLY] name [*] SET ACCESS METHOD ...
 *   ALTER TABLE [ONLY] name [*] ENABLE ROW LEVEL SECURITY
 *   ALTER TABLE [ONLY] name [*] DISABLE ROW LEVEL SECURITY
 *   ALTER TABLE [ONLY] name [*] FORCE ROW LEVEL SECURITY
 *   ALTER TABLE [ONLY] name [*] NO FORCE ROW LEVEL SECURITY
 *
 * Key tokens: `ALTER TABLE` followed by the suffix `ROW LEVEL SECURITY`,
 * with an optional `NO` before `FORCE`.
 */
const ALTER_TABLE_RLS = /^\s*ALTER\s+TABLE\s+.+?(?:ENABLE|DISABLE|(?:NO\s+)?FORCE)\s+ROW\s+LEVEL\s+SECURITY\s*;?\s*$/i;

/**
 * Matches CREATE POLICY statements.
 *
 * PostgreSQL grammar:
 *   CREATE POLICY name ON table_name
 *     [AS { PERMISSIVE | RESTRICTIVE }]
 *     [FOR { ALL | SELECT | INSERT | UPDATE | DELETE }]
 *     [TO { role_name | PUBLIC | CURRENT_USER | SESSION_USER } [, ...]]
 *     [USING (using_expression)]
 *     [WITH CHECK (check_expression)]
 *
 * We match the leading keyword structure and let the regex capture
 * the full statement. The query is case-insensitive.
 */
const CREATE_POLICY = /^\s*CREATE\s+POLICY\s+/i;

/**
 * Matches ALTER POLICY statements.
 *
 * PostgreSQL grammar:
 *   ALTER POLICY name ON table_name RENAME TO new_name
 *   ALTER POLICY name ON table_name TO { role_name | PUBLIC } [, ...]
 *   ALTER POLICY name ON table_name USING (using_expression)
 *   ALTER POLICY name ON table_name WITH CHECK (check_expression)
 */
const ALTER_POLICY = /^\s*ALTER\s+POLICY\s+/i;

/**
 * Matches DROP POLICY statements.
 *
 * PostgreSQL grammar:
 *   DROP POLICY [IF EXISTS] name ON table_name [CASCADE | RESTRICT]
 */
const DROP_POLICY = /^\s*DROP\s+POLICY\s+/i;

/**
 * Combined matcher for any RLS-related statement.
 *
 * This is the union of:
 *   - ALTER TABLE ... ROW LEVEL SECURITY
 *   - CREATE POLICY
 *   - ALTER POLICY
 *   - DROP POLICY
 */
const ANY_RLS = /^\s*(?:ALTER\s+TABLE\s+.+?(?:ENABLE|DISABLE|(?:NO\s+)?FORCE)\s+ROW\s+LEVEL\s+SECURITY|CREATE\s+POLICY\s+|ALTER\s+POLICY\s+|DROP\s+POLICY\s+)/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL Row-Level
 * Security statement that requires rewriting.
 *
 * Handles:
 * - `ALTER TABLE t ENABLE|DISABLE|FORCE|NO FORCE ROW LEVEL SECURITY`
 * - `CREATE POLICY p ON t ...`
 * - `ALTER POLICY p ON t ...`
 * - `DROP POLICY [IF EXISTS] p ON t ...`
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is an RLS-related statement
 *
 * @example
 * ```ts
 * detectRLS('ALTER TABLE users ENABLE ROW LEVEL SECURITY');  // true
 * detectRLS('CREATE POLICY user_sel ON users FOR SELECT');   // true
 * detectRLS('DROP POLICY p ON users');                       // true
 * detectRLS('SELECT * FROM users');                          // false
 * detectRLS('ALTER TABLE users ADD COLUMN x int');           // false
 * ```
 */
export function detectRLS(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Check if it matches any RLS pattern
  const result = ANY_RLS.test(trimmed);

  logger.debug(
    { sql: trimmed, detected: result },
    'RLS detection result',
  );

  return result;
}

/**
 * Rewrite a PostgreSQL Row-Level Security statement to a SQLite-compatible
 * no-op.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not an RLS-related statement, return unchanged with
 *    `rewritten: false`.
 * 2. If it is an RLS-related statement (any variant), rewrite to `SELECT 1`
 *    with `rewritten: true`.
 *
 * `SELECT 1` is chosen over an empty string because it returns a valid
 * single-row result set that won't break callers expecting query results.
 *
 * @param sql   The raw SQL string to process
 * @returns     An {@link RLSResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteRLS('ALTER TABLE users ENABLE ROW LEVEL SECURITY');
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteRLS('CREATE POLICY user_sel ON users FOR SELECT TO PUBLIC USING (active = true)');
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteRLS('DROP POLICY IF EXISTS old_policy ON users CASCADE');
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteRLS('SELECT * FROM users');
 * // → { sql: 'SELECT * FROM users', rewritten: false }
 * ```
 */
export function rewriteRLS(sql: string): RLSResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Is this even an RLS statement? ─────────────────────

  if (!detectRLS(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'Not an RLS statement — passing through unchanged',
    );
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 2: Determine which RLS variant for logging ─────────────

  let variant: string;

  if (ALTER_TABLE_RLS.test(trimmed)) {
    variant = 'ALTER TABLE ... ROW LEVEL SECURITY';
  } else if (CREATE_POLICY.test(trimmed)) {
    variant = 'CREATE POLICY';
  } else if (ALTER_POLICY.test(trimmed)) {
    variant = 'ALTER POLICY';
  } else if (DROP_POLICY.test(trimmed)) {
    variant = 'DROP POLICY';
  } else {
    variant = 'unknown RLS statement';
  }

  logger.debug(
    { sql: trimmed, variant },
    `RLS statement detected — rewriting to SELECT 1 (no-op for SQLite)`,
  );

  return {
    sql: 'SELECT 1',
    rewritten: true,
  };
}
