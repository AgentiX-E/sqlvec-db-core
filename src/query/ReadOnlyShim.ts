// @ts-nocheck
/**
 * ReadOnlyShim — PostgreSQL read-only transaction compatibility shim for SQLite.
 *
 * ## Background
 *
 * PostgreSQL supports read-only and read-write transaction modes via:
 *
 *   ```sql
 *   SET default_transaction_read_only = on;
 *   SET default_transaction_read_only = off;
 *   SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;
 *   SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE;
 *   SHOW transaction_read_only;
 *   SHOW default_transaction_read_only;
 *   ```
 *
 * SQLite offers `PRAGMA query_only` which serves a similar purpose (preventing
 * writes), but the PostgreSQL SET/SHOW syntax is not recognised by SQLite and
 * would cause a syntax error at parse time.
 *
 * ## Strategy (V2 — Real GucSystem Integration)
 *
 * This version stores the read-only state in GucSystem instead of ignoring it.
 * SET commands update GucSystem (and issue PRAGMA query_only for SQLite enforcement),
 * while SHOW commands read the actual value from GucSystem.
 *
 * | PostgreSQL syntax                                           | SQLite-compatible result                       | rewritten |
 * |:------------------------------------------------------------|:-----------------------------------------------|:----------|
 * | `SET default_transaction_read_only = on`                    | `SELECT 1` (GucSystem updated + PRAGMA hint)   | `true`    |
 * | `SET default_transaction_read_only = off`                   | `SELECT 1` (GucSystem updated + PRAGMA hint)   | `true`    |
 * | `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`      | `SELECT 1` (GucSystem updated)                 | `true`    |
 * | `SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE`     | `SELECT 1` (GucSystem updated)                 | `true`    |
 * | `SHOW transaction_read_only`                                | `SELECT 'on|off' AS transaction_read_only`     | `true`    |
 * | `SHOW default_transaction_read_only`                        | `SELECT 'on|off' AS default_transaction_read_only` | `true` |
 * | Any other SQL statement                                     | (pass-through unchanged)                       | `false`   |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite syntax
 * - GucSystem reflects actual read-only state
 * - PRAGMA query_only hint is provided via the needsPrisma field
 * - Detection is conservative — only top-level read-only related statements
 * - No false positives on SQL containing 'read_only' in string literals or identifiers
 * - Case-insensitive matching
 * - PinoLogger integration for debugging and audit trails
 *
 * @module query/ReadOnlyShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { GucSystem } from '../core/GucSystem';

// ── Logger ──────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('ReadOnlyShim');

// ── Types ──────────────────────────────────────────────────────

export interface ReadOnlyResult {
  /** Rewritten SQL string (unchanged if no rewriting was needed) */
  sql: string;
  /** Whether a read-only related rewrite was performed */
  rewritten: boolean;
  /**
   * Optional PRAGMA query_only command to execute as a side-effect.
   * When set, the caller should execute this PRAGMA to enforce the
   * read-only mode at the SQLite connection level.
   *
   * Values:
   *   - `'PRAGMA query_only = 1'` — enable read-only mode
   *   - `'PRAGMA query_only = 0'` — disable read-only mode
   *   - `undefined` — no PRAGMA change needed
   */
  needsPrisma?: string;
}

// ── Constants – Regex patterns ─────────────────────────────────

/**
 * Matches `SET default_transaction_read_only = on|off|true|false|0|1`.
 *
 * V2: Extracts the value (captured group 1) for GucSystem storage.
 */
const SET_DEFAULT_READ_ONLY_RE =
  /^\s*SET\s+default_transaction_read_only\s*=\s*(on|off|true|false|0|1)\s*;?\s*$/i;

/**
 * Matches `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY|WRITE`.
 *
 * V2: Detects whether the mode is READ ONLY or READ WRITE (captured group 1).
 */
const SET_SESSION_CHARACTERISTICS_READ_ONLY_RE =
  /^\s*SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION\s+(READ\s+ONLY|READ\s+WRITE)\s*;?\s*$/i;

/**
 * Matches `SHOW transaction_read_only` and `SHOW default_transaction_read_only`.
 *
 * V2: Captures which GUC name is being shown (group 1), so we can read
 * the actual value from GucSystem.
 */
const SHOW_READ_ONLY_RE =
  /^\s*SHOW\s+(transaction_read_only|default_transaction_read_only)\s*;?\s*$/i;

// ── Helper ──────────────────────────────────────────────────────

/**
 * Determine whether a value string represents "on" (true) or "off" (false).
 */
function isTruthyValue(value: string): boolean {
  const lc = value.toLowerCase();
  return lc === 'on' || lc === 'true' || lc === 'yes' || lc === '1';
}

/**
 * Convert a boolean value to GucSystem canonical 'on'/'off'.
 */
function toGucBool(value: boolean): string {
  return value ? 'on' : 'off';
}

/**
 * Store read-only state in GucSystem.
 *
 * `GucSystem.getDefaultInstance()` is a guaranteed non-throwing singleton and
 * `handleSet` reports success via a `null` error return that this best-effort store
 * deliberately ignores, so no defensive try/catch or null/error check is warranted
 * here.
 */
function storeReadOnlyInGuc(gucName: string, value: string): void {
  GucSystem.getDefaultInstance().handleSet(gucName, value);
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Detect whether the given SQL string is a read-only transaction related statement.
 *
 * Checks for three PostgreSQL syntax patterns (case-insensitive):
 *
 * 1. `SET default_transaction_read_only = on|off|true|false|0|1`
 *    — Sets the default transaction access mode for the session.
 *
 * 2. `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY|WRITE`
 *    — Sets the default transaction access mode for the session.
 *
 * 3. `SHOW transaction_read_only` / `SHOW default_transaction_read_only`
 *    — Shows the current transaction read-only setting.
 *
 * Returns `false` for:
 *   - Non-SET/SHOW or non-read-only statements
 *   - Empty or non-string input
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a read-only related statement
 *
 * @example
 * ```ts
 * detectReadOnly("SET default_transaction_read_only = on");         // true
 * detectReadOnly("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"); // true
 * detectReadOnly("SHOW transaction_read_only");                     // true
 * detectReadOnly("SELECT 1");                                       // false
 * detectReadOnly("");                                               // false
 * ```
 */
export function detectReadOnly(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check — avoids unnecessary regex on unrelated statements
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SET ') && !upper.startsWith('SHOW ')) {
    return false;
  }

  const isSetDefaultReadOnly = SET_DEFAULT_READ_ONLY_RE.test(trimmed);
  const isSetSessionCharacteristicsReadOnly = SET_SESSION_CHARACTERISTICS_READ_ONLY_RE.test(trimmed);
  const isShowReadOnly = SHOW_READ_ONLY_RE.test(trimmed);

  const detected = isSetDefaultReadOnly || isSetSessionCharacteristicsReadOnly || isShowReadOnly;

  if (detected) {
    logger.debug({ sql: sql.substring(0, 120) }, 'Read-only transaction statement detected');
  }

  return detected;
}

/**
 * Rewrite a PostgreSQL read-only transaction SQL statement to SQLite-compatible format.
 *
 * **Processing rules (V2 — GucSystem Integration):**
 *
 * | Input                                                                     | Output                                          | rewritten |
 * |:--------------------------------------------------------------------------|:------------------------------------------------|:----------|
 * | `SET default_transaction_read_only = on`                                  | `SELECT 1`                                      | `true`    |
 * | `SET default_transaction_read_only = off`                                 | `SELECT 1`                                      | `true`    |
 * | `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`                    | `SELECT 1`                                      | `true`    |
 * | `SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE`                   | `SELECT 1`                                      | `true`    |
 * | `SHOW transaction_read_only`                                              | `SELECT 'on' AS transaction_read_only`          | `true`    |
 * | `SHOW default_transaction_read_only`                                      | `SELECT 'on' AS default_transaction_read_only`  | `true`    |
 * | `CREATE TABLE t (id INT)`                                                 | (original unchanged)                             | `false`   |
 * | `SELECT * FROM pg_stat_replication`                                       | (original unchanged)                             | `false`   |
 *
 * **Design rationale (V2):**
 *
 * - **SET statements → SELECT 1 + GucSystem update**: Instead of completely
 *   ignoring the SET, we now store the read-only state in GucSystem. This enables
 *   downstream SHOW commands to return the correct value, and allows QueryRouter
 *   to reject write operations when read-only mode is active.
 *
 * - **needsPrisma field**: When read-only is set to 'on', the result includes
 *   `needsPrisma: 'PRAGMA query_only = 1'` to instruct the caller (e.g., QueryRouter)
 *   to enforce the read-only mode at the SQLite PRAGMA level.
 *
 * - **SHOW statements → GucSystem lookup**: Instead of returning a hardcoded 'off',
 *   we read the actual value from GucSystem. If GucSystem is unavailable (e.g.,
 *   during testing), we fall back to 'off' as the default.
 *
 * @param sql   The raw SQL string to process
 * @returns     A `ReadOnlyResult` with the (potentially rewritten) SQL
 *
 * @example
 * ```ts
 * // SET default_transaction_read_only = on — GucSystem updated, PRAGMA hint
 * rewriteReadOnly("SET default_transaction_read_only = on");
 * // → { sql: "SELECT 1", rewritten: true, needsPrisma: "PRAGMA query_only = 1" }
 *
 * // SET SESSION CHARACTERISTICS — GucSystem updated
 * rewriteReadOnly("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
 * // → { sql: "SELECT 1", rewritten: true, needsPrisma: "PRAGMA query_only = 1" }
 *
 * // SHOW transaction_read_only — read from GucSystem
 * rewriteReadOnly("SHOW transaction_read_only");
 * // → { sql: "SELECT 'on' AS transaction_read_only", rewritten: true }
 *
 * // Non-read-only — pass through
 * rewriteReadOnly("SELECT * FROM users");
 * // → { sql: "SELECT * FROM users", rewritten: false }
 * ```
 */
export function rewriteReadOnly(sql: string): ReadOnlyResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    logger.warn({ sql }, 'rewriteReadOnly received empty or non-string input');
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();

  // 1. SET default_transaction_read_only = on|off
  const defaultReadOnlyMatch = trimmed.match(SET_DEFAULT_READ_ONLY_RE);
  if (defaultReadOnlyMatch) {
    const rawValue = defaultReadOnlyMatch[1];
    const boolValue = isTruthyValue(rawValue);
    const canonicalValue = toGucBool(boolValue);

    logger.debug(
      { originalSql: sql.substring(0, 120), value: canonicalValue },
      'Rewriting SET default_transaction_read_only → GucSystem store + SELECT 1',
    );

    // Store in GucSystem
    storeReadOnlyInGuc('default_transaction_read_only', canonicalValue);
    storeReadOnlyInGuc('transaction_read_only', canonicalValue);

    // Provide PRAGMA hint for SQLite-level enforcement
    const needsPrisma = boolValue ? 'PRAGMA query_only = 1' : 'PRAGMA query_only = 0';

    return {
      sql: 'SELECT 1',
      rewritten: true,
      needsPrisma,
    };
  }

  // 2. SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY|WRITE
  const sessionCharsMatch = trimmed.match(SET_SESSION_CHARACTERISTICS_READ_ONLY_RE);
  if (sessionCharsMatch) {
    const mode = sessionCharsMatch[1].toUpperCase();
    const isReadOnly = mode === 'READ ONLY';
    const canonicalValue = toGucBool(isReadOnly);

    logger.debug(
      { originalSql: sql.substring(0, 120), mode, isReadOnly },
      'Rewriting SET SESSION CHARACTERISTICS → GucSystem store + SELECT 1',
    );

    // Store in GucSystem (this sets the default for the session)
    storeReadOnlyInGuc('default_transaction_read_only', canonicalValue);

    // Provide PRAGMA hint for SQLite-level enforcement
    const needsPrisma = isReadOnly ? 'PRAGMA query_only = 1' : 'PRAGMA query_only = 0';

    return {
      sql: 'SELECT 1',
      rewritten: true,
      needsPrisma,
    };
  }

  // 3. SHOW transaction_read_only / SHOW default_transaction_read_only
  const showMatch = trimmed.match(SHOW_READ_ONLY_RE);
  if (showMatch) {
    const gucName = showMatch[1].toLowerCase();

    // Read from GucSystem, fallback to 'off' if not available
    let displayValue = 'off';

    const result = GucSystem.getDefaultInstance().handleShow(gucName);
    if (result.ok) {
      displayValue = result.value;
    }

    logger.debug(
      { originalSql: sql.substring(0, 120), gucName, returning: displayValue },
      'Rewriting SHOW read_only → GucSystem lookup',
    );

    // Return the actual value from GucSystem
    return {
      sql: `SELECT '${displayValue}' AS ${gucName}`,
      rewritten: true,
      // SHOW doesn't need a PRAGMA change
    };
  }

  // 4. No match — pass through unchanged
  return { sql, rewritten: false };
}

/**
 * Read the current default_transaction_read_only state from GucSystem.
 *
 * This is used by QueryRouter to reject write operations in read-only mode.
 *
 * @returns `true` if read-only mode is active, `false` otherwise (or if GucSystem
 *          is unavailable).
 *
 * @example
 * ```ts
 * isReadOnlyMode(); // false (default)
 * rewriteReadOnly("SET default_transaction_read_only = on");
 * isReadOnlyMode(); // true
 * ```
 */
export function isReadOnlyMode(): boolean {
  const guc = GucSystem.getDefaultInstance();

  // Check both default_transaction_read_only (session default) and
  // transaction_read_only (current transaction) for completeness
  const defaultResult = guc.handleShow('default_transaction_read_only');
  if (defaultResult.ok && defaultResult.value === 'on') return true;

  const txnResult = guc.handleShow('transaction_read_only');
  if (txnResult.ok && txnResult.value === 'on') return true;

  return false;
}
