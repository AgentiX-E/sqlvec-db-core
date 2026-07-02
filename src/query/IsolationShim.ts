/**
 * IsolationShim — Rewrites PostgreSQL transaction isolation level statements
 * for SQLite compatibility.
 *
 * ## Background
 *
 * PostgreSQL supports four transaction isolation levels:
 *   - READ UNCOMMITTED
 *   - READ COMMITTED (default)
 *   - REPEATABLE READ
 *   - SERIALIZABLE
 *
 * SQLite's transaction isolation is always SERIALIZABLE (file-level locking via
 * `sqlite3_enable_load_extension` or by design). SQLite **does not accept** any
 * explicit isolation-level SET syntax, so all such PG statements must be
 * stripped or rewritten.
 *
 * **Note:** This shim handles all **non-SERIALIZABLE** isolation level
 * statements. The SERIALIZABLE case is handled by {@link SerializableShim}
 * (which replaces it with REPEATABLE READ — a level SQLite accepts — to
 * minimise application breakage).
 *
 * ## Strategy
 *
 * | PostgreSQL syntax                                                  | SQLite-compatible result          |
 * |:-------------------------------------------------------------------|:----------------------------------|
 * | `SET [SESSION|LOCAL] TRANSACTION ISOLATION LEVEL READ COMMITTED`   | `SELECT 1`                        |
 * | `SET [SESSION|LOCAL] TRANSACTION ISOLATION LEVEL REPEATABLE READ`  | `SELECT 1`                        |
 * | `SET [SESSION|LOCAL] TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` | `SELECT 1`                        |
 * | `SET [SESSION|LOCAL] default_transaction_isolation = 'read committed'` | `SELECT 1`                    |
 * | `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED` | `SELECT 1` (stripped — no-op) |
 * | `SHOW transaction_isolation`                                       | `SELECT 'serializable' AS transaction_isolation` |
 * | `SHOW default_transaction_isolation`                               | `SELECT 'serializable' AS default_transaction_isolation` |
 * | Other SQL statements                                               | (pass-through unchanged)          |
 *
 * Since SQLite inherently enforces serializable isolation via its file-level
 * locking, any PG code that sets or inspects the isolation level can be safely
 * replaced with a no-op or a constant-response query. This preserves
 * correctness while avoiding a syntax error.
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite syntax
 * - Detection is conservative — only top-level isolation statements
 * - No false positives on SQL containing these keywords in string literals or
 *   identifiers (the regexes anchor with `^` and require whole-statement
 *   patterns from the start)
 * - PinoLogger integration for debugging and audit trails
 *
 * @module query/IsolationShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

// ── Logger ──────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('IsolationShim');

// ── Types ──────────────────────────────────────────────────────

export interface IsolationResult {
  /** Rewritten SQL string (unchanged if no rewriting was needed) */
  sql: string;
  /** Whether an isolation-level rewrite was performed */
  rewritten: boolean;
}

// ── Constants — Regex patterns ──────────────────────────────────

/**
 * Matches `SET [SESSION|LOCAL] TRANSACTION ISOLATION LEVEL <level>` where
 * <level> is READ COMMITTED, REPEATABLE READ, or READ UNCOMMITTED.
 *
 * Group 1 — Prefix including the `SET`, optional `SESSION|LOCAL`, and
 *           `TRANSACTION ISOLATION LEVEL ` text (used for reconstruction if
 *           needed, though in this shim the whole statement is replaced).
 *
 * Coverage:
 *   SET TRANSACTION ISOLATION LEVEL READ COMMITTED
 *   SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED
 *   SET LOCAL TRANSACTION ISOLATION LEVEL READ COMMITTED
 *   SET TRANSACTION ISOLATION LEVEL REPEATABLE READ
 *   SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED
 *
 * Does **not** match SERIALIZABLE (handled by SerializableShim).
 */
const SET_TRANSACTION_ISOLATION_RE =
  /^(\s*SET\s+(?:(?:SESSION|LOCAL)\s+)?TRANSACTION\s+ISOLATION\s+LEVEL\s+)(?:READ\s+(?:COMMITTED|UNCOMMITTED)|REPEATABLE\s+READ)\s*;?\s*$/i;

/**
 * Matches `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL <level>`
 * where <level> is any non-SERIALIZABLE level (READ COMMITTED, REPEATABLE READ,
 * READ UNCOMMITTED).
 *
 * This form sets the **default** isolation level for all transactions in the
 * current PG session. SQLite has no equivalent; the statement can be safely
 * stripped.
 *
 * SERIALIZABLE variant is handled by SerializableShim.
 */
const SET_SESSION_CHARACTERISTICS_ISOLATION_RE =
  /^\s*SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION\s+ISOLATION\s+LEVEL\s+(?:READ\s+(?:COMMITTED|UNCOMMITTED)|REPEATABLE\s+READ)\s*;?\s*$/i;

/**
 * Matches `SET [SESSION|LOCAL] default_transaction_isolation = '<value>'` or
 * `SET [SESSION|LOCAL] default_transaction_isolation TO '<value>'`.
 *
 * PostgreSQL allows setting the default isolation level for the session via
 * the `default_transaction_isolation` GUC:
 *   SET default_transaction_isolation = 'read committed';
 *   SET SESSION default_transaction_isolation = 'repeatable read';
 *   SET LOCAL default_transaction_isolation TO 'serializable';
 *
 * Since SQLite does not support this GUC, the statement is replaced with a
 * lightweight no-op (`SELECT 1`).
 */
const SET_DEFAULT_TRANSACTION_ISOLATION_RE =
  /^\s*SET\s+(?:(?:SESSION|LOCAL)\s+)?default_transaction_isolation\s*(?:=|TO)\s*'[^']*'\s*;?\s*$/i;

/**
 * Matches `SHOW transaction_isolation`.
 *
 * PostgreSQL returns the current transaction isolation level (e.g.
 * 'read committed'). Since SQLite's level is always SERIALIZABLE, we
 * replace this with:
 *   SELECT 'serializable' AS transaction_isolation
 */
const SHOW_TRANSACTION_ISOLATION_RE =
  /^\s*SHOW\s+transaction_isolation\s*;?\s*$/i;

/**
 * Matches `SHOW default_transaction_isolation`.
 *
 * PostgreSQL returns the session-default transaction isolation (e.g.
 * 'read committed'). Since SQLite has no such GUC and behaves as
 * SERIALIZABLE, we replace this with:
 *   SELECT 'serializable' AS default_transaction_isolation
 */
const SHOW_DEFAULT_TRANSACTION_ISOLATION_RE =
  /^\s*SHOW\s+default_transaction_isolation\s*;?\s*$/i;

// ── Public API ──────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL isolation level
 * statement that requires rewriting for SQLite compatibility.
 *
 * Checks for the following patterns (case-insensitive):
 *
 * 1. `SET [SESSION|LOCAL] TRANSACTION ISOLATION LEVEL (READ COMMITTED|REPEATABLE READ|READ UNCOMMITTED)`
 * 2. `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL (READ COMMITTED|REPEATABLE READ|READ UNCOMMITTED)`
 * 3. `SET [SESSION|LOCAL] default_transaction_isolation = '<value>'`
 * 4. `SHOW transaction_isolation`
 * 5. `SHOW default_transaction_isolation`
 *
 * Returns `false` for:
 *   - SERIALIZABLE isolation statements (handled by SerializableShim)
 *   - Non-isolation SQL statements
 *   - Empty or non-string input
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL requires isolation-level rewriting
 *
 * @example
 * ```ts
 * detectIsolation("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");               // true
 * detectIsolation("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");      // true
 * detectIsolation("SET default_transaction_isolation = 'read committed'");         // true
 * detectIsolation("SHOW transaction_isolation");                                    // true
 * detectIsolation("SHOW default_transaction_isolation");                            // true
 * detectIsolation("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");                  // false
 * detectIsolation("SELECT 1");                                                      // false
 * detectIsolation("");                                                              // false
 * ```
 */
export function detectIsolation(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check — avoids unnecessary regex on non-SET/SHOW statements
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SET ') && !upper.startsWith('SHOW ')) {
    return false;
  }

  // Check all patterns
  const detected =
    SET_TRANSACTION_ISOLATION_RE.test(trimmed) ||
    SET_SESSION_CHARACTERISTICS_ISOLATION_RE.test(trimmed) ||
    SET_DEFAULT_TRANSACTION_ISOLATION_RE.test(trimmed) ||
    SHOW_TRANSACTION_ISOLATION_RE.test(trimmed) ||
    SHOW_DEFAULT_TRANSACTION_ISOLATION_RE.test(trimmed);

  if (detected) {
    logger.debug({ sql: sql.substring(0, 120) }, 'Isolation-level statement detected');
  }

  return detected;
}

/**
 * Rewrite a PostgreSQL isolation level SQL statement to SQLite-compatible format.
 *
 * **Processing rules:**
 *
 * | Input                                                                     | Output                                              | rewritten |
 * |:--------------------------------------------------------------------------|:----------------------------------------------------|:----------|
 * | `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`                          | `SELECT 1`                                          | `true`    |
 * | `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED`                  | `SELECT 1`                                          | `true`    |
 * | `SET LOCAL TRANSACTION ISOLATION LEVEL REPEATABLE READ`                   | `SELECT 1`                                          | `true`    |
 * | `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED`                        | `SELECT 1`                                          | `true`    |
 * | `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED` | `SELECT 1`                                        | `true`    |
 * | `SET default_transaction_isolation = 'read committed'`                    | `SELECT 1`                                          | `true`    |
 * | `SET SESSION default_transaction_isolation TO 'repeatable read'`          | `SELECT 1`                                          | `true`    |
 * | `SHOW transaction_isolation`                                              | `SELECT 'serializable' AS transaction_isolation`     | `true`    |
 * | `SHOW default_transaction_isolation`                                      | `SELECT 'serializable' AS default_transaction_isolation` | `true` |
 * | `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`                            | (unchanged — handled by SerializableShim)           | `false`   |
 * | `SELECT * FROM t`                                                         | (unchanged)                                         | `false`   |
 *
 * **Design rationale:**
 *
 * - **SET → `SELECT 1`**: Stripping isolation SET statements entirely (empty
 *   string) could break application expectations or frameworks that validate
 *   statement count. Replacing with a lightweight no-op (`SELECT 1`) satisfies
 *   both syntactic correctness and semantic safety — SQLite's underlying
 *   isolation is always SERIALIZABLE, so there's no actual isolation change to
 *   preserve.
 *
 * - **SHOW → `SELECT 'serializable' AS ...`**: PG applications that inspect the
 *   isolation level typically branch on the result. Returning `'serializable'`
 *   is the most conservative answer (SQLite's actual behaviour) and avoids
 *   confusing application logic that expects a known isolation level string.
 *
 * @param sql   The raw SQL string to process
 * @returns     An `IsolationResult` with the (potentially rewritten) SQL
 *
 * @example
 * ```ts
 * // Transaction-level SET READ COMMITTED → SELECT 1
 * rewriteIsolation("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
 * // → { sql: "SELECT 1", rewritten: true }
 *
 * // With SESSION prefix
 * rewriteIsolation("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
 * // → { sql: "SELECT 1", rewritten: true }
 *
 * // GUC-style SET → SELECT 1
 * rewriteIsolation("SET default_transaction_isolation = 'read committed'");
 * // → { sql: "SELECT 1", rewritten: true }
 *
 * // SHOW → constant response
 * rewriteIsolation("SHOW transaction_isolation");
 * // → { sql: "SELECT 'serializable' AS transaction_isolation", rewritten: true }
 *
 * rewriteIsolation("SHOW default_transaction_isolation");
 * // → { sql: "SELECT 'serializable' AS default_transaction_isolation", rewritten: true }
 *
 * // Non-isolation — pass through
 * rewriteIsolation("SELECT * FROM t");
 * // → { sql: "SELECT * FROM t", rewritten: false }
 * ```
 */
export function rewriteIsolation(sql: string): IsolationResult {
  const original = sql;

  // Guard: reject non-string or empty input
  if (typeof original !== 'string' || original.trim().length === 0) {
    return {
      sql: original ?? '',
      rewritten: false,
    };
  }

  // ── Case 1: SET [SESSION|LOCAL] TRANSACTION ISOLATION LEVEL (READ|REPEATABLE) ──
  // Strip by replacing with SELECT 1 — the actual SQLite isolation is always
  // SERIALIZABLE regardless, so this is a safe no-op.
  if (SET_TRANSACTION_ISOLATION_RE.test(original)) {
    logger.info(
      { original: original.trim().substring(0, 120) },
      'SET TRANSACTION ISOLATION LEVEL rewritten to SELECT 1 (no-op)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Case 2: SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL … ──
  // Strip entirely — no SQLite equivalent for session-level default isolation.
  if (SET_SESSION_CHARACTERISTICS_ISOLATION_RE.test(original)) {
    logger.info(
      { original: original.trim().substring(0, 120) },
      'SET SESSION CHARACTERISTICS … rewritten to SELECT 1 (no-op)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Case 3: SET [SESSION|LOCAL] default_transaction_isolation = '...' ──
  // PG GUC setting — no SQLite equivalent, safe to strip.
  if (SET_DEFAULT_TRANSACTION_ISOLATION_RE.test(original)) {
    logger.info(
      { original: original.trim().substring(0, 120) },
      'SET default_transaction_isolation rewritten to SELECT 1 (no-op)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Case 4: SHOW transaction_isolation ──
  // Return constant 'serializable' — SQLite always behaves as SERIALIZABLE.
  if (SHOW_TRANSACTION_ISOLATION_RE.test(original)) {
    const rewritten = "SELECT 'serializable' AS transaction_isolation";
    logger.info(
      {
        original: original.trim().substring(0, 120),
        rewritten: rewritten.substring(0, 120),
      },
      'SHOW transaction_isolation rewritten to constant-response SELECT',
    );
    return {
      sql: rewritten,
      rewritten: true,
    };
  }

  // ── Case 5: SHOW default_transaction_isolation ──
  // Return constant 'serializable'.
  if (SHOW_DEFAULT_TRANSACTION_ISOLATION_RE.test(original)) {
    const rewritten = "SELECT 'serializable' AS default_transaction_isolation";
    logger.info(
      {
        original: original.trim().substring(0, 120),
        rewritten: rewritten.substring(0, 120),
      },
      'SHOW default_transaction_isolation rewritten to constant-response SELECT',
    );
    return {
      sql: rewritten,
      rewritten: true,
    };
  }

  // ── Case 6: Non-isolation — pass through unchanged ────────────

  return {
    sql: original,
    rewritten: false,
  };
}
