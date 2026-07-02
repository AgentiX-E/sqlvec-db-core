/**
 * SerializableShim — PostgreSQL SERIALIZABLE isolation level compatibility shim for SQLite.
 *
 * ## Background
 *
 * PostgreSQL supports four transaction isolation levels:
 *   - READ UNCOMMITTED
 *   - READ COMMITTED (default)
 *   - REPEATABLE READ
 *   - SERIALIZABLE
 *
 * SQLite's transaction isolation is always SERIALIZABLE (file-level locking).
 * However, SQLite does **not** accept the SQL syntax for setting SERIALIZABLE
 * isolation, so these statements must be rewritten or stripped.
 *
 * ## Strategy (V2 — Real SSI Support)
 *
 * This version **preserves** SERIALIZABLE isolation level instead of downgrading
 * it to REPEATABLE READ. The system has a real SSI implementation via
 * {@link MVCCExecutor}'s `readSets`/`writeSets` + `detectSerializationConflict()`,
 * so there is no need to rewrite SERIALIZABLE → REPEATABLE READ.
 *
 * | PostgreSQL syntax                                   | SQLite-compatible result          |
 * |:----------------------------------------------------|:----------------------------------|
 * | `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`      | (preserved unchanged)             |
 * | `SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE` | (preserved unchanged)           |
 * | `SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE` | (preserved unchanged)            |
 * | `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE` | (stripped — no-op) |
 * | Non-SERIALIZABLE SET statements                     | (pass-through unchanged)          |
 * | Other SQL statements                                | (pass-through unchanged)          |
 *
 * For **transaction-level** SET with SERIALIZABLE, the SQL is preserved unchanged.
 * The SSI detection in MVCCExecutor will only activate when isolation level is
 * SERIALIZABLE.
 *
 * For **session characteristics** SET (second group), the statement is entirely
 * stripped (returns empty SQL string). The isolation level is stored in GucSystem
 * so SHOW commands return the correct value.
 *
 * ## Key guarantees
 *
 * - SERIALIZABLE is preserved — SSI logic can activate correctly
 * - All rewritten output is valid SQLite syntax
 * - Detection is conservative — only top-level SERIALIZABLE isolation statements
 * - Non-SERIALIZABLE statements (e.g. READ COMMITTED, REPEATABLE READ) pass through
 * - No false positives on SQL containing 'SERIALIZABLE' in string literals or identifiers
 * - PinoLogger integration for debugging and audit trails
 *
 * @module query/SerializableShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { DatabaseError } from '../error/DatabaseError';
import { GucSystem } from '../core/GucSystem';

// ── Logger ──────────────────────────────────────────────────────

const logger = PinoLogger.forComponent('SerializableShim');

// ── Types ──────────────────────────────────────────────────────

export interface SerializableResult {
  /** Rewritten SQL string (unchanged if no rewriting was needed) */
  sql: string;
  /** Whether a SERIALIZABLE-related rewrite was performed */
  rewritten: boolean;
}

// ── Constants – Regex patterns ─────────────────────────────────

/**
 * Matches `SET [SESSION|LOCAL] TRANSACTION ISOLATION LEVEL SERIALIZABLE`.
 *
 * Groups:
 *   1 — Prefix including the `SET`, optional `SESSION|LOCAL`, and
 *       `TRANSACTION ISOLATION LEVEL ` text (captured for reconstruction)
 *
 * Covers:
 *   SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
 *   SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE
 *   SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE
 *
 * V2: No longer replaces SERIALIZABLE with REPEATABLE READ — the SQL is
 * preserved as-is since we have real SSI support.
 */
const SET_TRANSACTION_SERIALIZABLE_RE =
  /^(\s*SET\s+(?:(?:SESSION|LOCAL)\s+)?TRANSACTION\s+ISOLATION\s+LEVEL\s+)SERIALIZABLE\b/i;

/**
 * Matches `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE`.
 *
 * This form sets the **default** isolation level for all transactions in the
 * current session, rather than the current transaction. SQLite has no equivalent,
 * but since SQLite's default is already SERIALIZABLE, the statement can be safely
 * stripped.
 */
const SET_SESSION_CHARACTERISTICS_SERIALIZABLE_RE =
  /^\s*SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION\s+ISOLATION\s+LEVEL\s+SERIALIZABLE\s*;?\s*$/i;

// ── Public API ─────────────────────────────────────────────────

/**
 * Detect whether the given SQL string sets the SERIALIZABLE transaction
 * isolation level.
 *
 * Checks for two PostgreSQL syntax patterns (case-insensitive):
 *
 * 1. `SET [SESSION|LOCAL] TRANSACTION ISOLATION LEVEL SERIALIZABLE`
 *    — Sets isolation for the current transaction.
 *
 * 2. `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE`
 *    — Sets default isolation for the session.
 *
 * Returns `false` for:
 *   - Non-SET or non-SERIALIZABLE statements
 *   - Statements setting a different isolation level (e.g. READ COMMITTED)
 *   - Empty or non-string input
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL requests SERIALIZABLE isolation
 *
 * @example
 * ```ts
 * detectSerializable("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");                // true
 * detectSerializable("SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE");        // true
 * detectSerializable("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE"); // true
 * detectSerializable("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");              // false
 * detectSerializable("SELECT 1");                                                     // false
 * detectSerializable("");                                                             // false
 * ```
 */
export function detectSerializable(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check — avoids unnecessary regex on non-SET statements
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SET ')) {
    return false;
  }

  // Check both patterns
  const isTransactionSerializable = SET_TRANSACTION_SERIALIZABLE_RE.test(trimmed);
  const isSessionCharacteristicsSerializable =
    SET_SESSION_CHARACTERISTICS_SERIALIZABLE_RE.test(trimmed);

  const detected = isTransactionSerializable || isSessionCharacteristicsSerializable;

  if (detected) {
    logger.debug({ sql: sql.substring(0, 120) }, 'SERIALIZABLE isolation detected');
  }

  return detected;
}

/**
 * Rewrite a SERIALIZABLE isolation level SQL statement to SQLite-compatible format.
 *
 * **Processing rules (V2):**
 *
 * | Input                                                                     | Output                                          | rewritten |
 * |:--------------------------------------------------------------------------|:------------------------------------------------|:----------|
 * | `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`                            | (preserved unchanged)                            | `false`   |
 * | `SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE`                    | (preserved unchanged)                            | `false`   |
 * | `SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE`                      | (preserved unchanged)                            | `false`   |
 * | `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE` | `''` (empty — no-op)                             | `true`    |
 * | `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`                          | (original unchanged)                             | `false`   |
 * | `SELECT * FROM t`                                                         | (original unchanged)                             | `false`   |
 *
 * **Design rationale (V2):**
 *
 * - **SERIALIZABLE preserved (not → REPEATABLE READ):** The system now has a real
 *   SSI (Serializable Snapshot Isolation) implementation via MVCCExecutor's
 *   `readSets`/`writeSets` + `detectSerializationConflict()`. To activate SSI,
 *   the isolation level must be SERIALIZABLE. Therefore, we no longer downgrade
 *   it. The SQL is preserved as-is; SSI will apply during execution.
 *
 * - **Session characteristics stripping:** `SET SESSION CHARACTERISTICS ...`
 *   sets the **default** isolation level for the entire session. Since SQLite
 *   defaults to SERIALIZABLE file-level locking and has no equivalent session-level
 *   isolation knob, the statement is stripped. The value is stored in GucSystem
 *   for SHOW command compatibility.
 *
 * @param sql   The raw SQL string to process
 * @returns     A `SerializableResult` with the (potentially rewritten) SQL
 *              and whether a rewrite was performed.
 *
 * @example
 * ```ts
 * // Transaction-level SET — preserved unchanged (V2)
 * rewriteSerializable("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
 * // → { sql: "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", rewritten: false }
 *
 * // With SESSION prefix — preserved unchanged (V2)
 * rewriteSerializable("SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE");
 * // → { sql: "SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE", rewritten: false }
 *
 * // Session characteristics — strip entirely
 * rewriteSerializable("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE");
 * // → { sql: "", rewritten: true }
 *
 * // Non-SERIALIZABLE — pass through
 * rewriteSerializable("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
 * // → { sql: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED", rewritten: false }
 * ```
 */
export function rewriteSerializable(sql: string): SerializableResult {
  const original = sql;

  // Guard: reject non-string or empty input
  if (typeof original !== 'string' || original.trim().length === 0) {
    return {
      sql: original ?? '',
      rewritten: false,
    };
  }

  // ── Case 1: SET SESSION CHARACTERISTICS AS … SERIALIZABLE ──────
  // Strip entirely — no SQLite equivalent, and the default is already SERIALIZABLE.
  // The isolation level is stored in GucSystem for SHOW compatibility.
  const sessionCharacteristicsMatch = original.match(
    SET_SESSION_CHARACTERISTICS_SERIALIZABLE_RE,
  );
  if (sessionCharacteristicsMatch) {
    // Store the isolation level in GucSystem for SHOW commands
    try {
      const guc = GucSystem.getDefaultInstance();
      guc.handleSet('default_transaction_isolation', 'serializable');
      guc.handleSet('transaction_isolation', 'serializable');
    } catch {
      // Non-fatal — GucSystem may not be initialized
    }

    logger.info(
      {
        original: original.trim().substring(0, 120),
        action: 'stripped',
        isolationStored: 'serializable',
      },
      'SET SESSION CHARACTERISTICS … SERIALIZABLE stripped (no-op)',
    );
    return {
      sql: '',
      rewritten: true,
    };
  }

  // ── Case 2: SET [SESSION|LOCAL] TRANSACTION ISOLATION LEVEL SERIALIZABLE ──
  // V2: Preserve unchanged — we have real SSI support now.
  // Store the isolation level in GucSystem for SHOW queries.
  const transactionMatch = original.match(SET_TRANSACTION_SERIALIZABLE_RE);
  if (transactionMatch) {
    // Store in GucSystem for SHOW commands
    try {
      const guc = GucSystem.getDefaultInstance();
      guc.handleSet('transaction_isolation', 'serializable');
    } catch {
      // Non-fatal
    }

    logger.info(
      {
        original: original.trim().substring(0, 120),
        action: 'preserved',
      },
      'SERIALIZABLE isolation preserved (SSI available)',
    );
    // Return the original SQL unchanged
    return {
      sql: original,
      rewritten: false,
    };
  }

  // ── Case 3: Non-SERIALIZABLE — pass through unchanged ──────────

  return {
    sql: original,
    rewritten: false,
  };
}

/**
 * Get the default isolation level string.
 *
 * QueryRouter uses this when starting transactions. Returns 'SERIALIZABLE'
 * so that SSI (Serializable Snapshot Isolation) is enabled by default.
 *
 * @returns The string 'SERIALIZABLE'
 */
export function setDefaultIsolation(): string {
  return 'SERIALIZABLE';
}

// ── Write-Skew Detection ──────────────────────────────────────

/**
 * Check for write-skew anomaly in SERIALIZABLE transactions.
 *
 * Write-skew occurs when two concurrent transactions read overlapping data
 * sets but write to disjoint rows, producing a result that cannot happen
 * under any serial execution order.
 *
 * This function performs SI-based (Snapshot Isolation) write-skew detection
 * by checking if any rows in the given read set have been modified by
 * concurrent transactions since the snapshot.
 *
 * @param rowVersions - Map of all current row version entries
 *   (key → `{ xmin, xmax | null }`)
 * @param activeXidSet - Set of XIDs for currently active (uncommitted) transactions
 * @param txnXid - The XID of the transaction being checked
 * @param snapshot - The snapshot XID at which the txn began
 * @param readKeys - Set of `${table}:${rowId}` keys this txn read
 * @param writeKeys - Set of `${table}:${rowId}` keys this txn wrote (excluded from
 *   write-skew check since row-level conflict detection handles them)
 * @returns `true` if a write-skew anomaly was detected
 *
 * @throws {DatabaseError} With SQLSTATE '40001' and message
 *   'serialization_anomaly' if write-skew is detected.
 *
 * @example
 * ```ts
 * // Two concurrent SERIALIZABLE transactions:
 * // T1: SELECT x,y FROM t; UPDATE t SET x=1 WHERE id=1;
 * // T2: SELECT x,y FROM t; UPDATE t SET y=2 WHERE id=2;
 * // Both read {row1, row2}, T1 writes row1, T2 writes row2
 * // → Write-skew: neither saw the other's write, result is inconsistent
 *
 * const hasSkew = checkWriteSkew(rowVersions, activeXids, 5, 4, readSet, writeSet);
 * ```
 */
export function checkWriteSkew(
  rowVersions: Map<string, { xmin: number; xmax: number | null }>,
  activeXidSet: Set<number>,
  txnXid: number,
  snapshot: number,
  readKeys: Set<string>,
  writeKeys: Set<string>,
): boolean {
  if (!readKeys || readKeys.size === 0) return false;

  for (const key of readKeys) {
    // Skip rows this txn also wrote (row-level conflict detection covers those)
    if (writeKeys && writeKeys.has(key)) continue;

    const currentRv = rowVersions.get(key);
    if (!currentRv) continue;

    const isOurWrite = currentRv.xmin === txnXid;
    if (isOurWrite) continue;

    // Check if the row was modified by an active concurrent txn
    // that is still in progress (anomaly risk)
    const modifiedByActiveConcurrent =
      currentRv.xmin > snapshot &&
      currentRv.xmin !== txnXid &&
      activeXidSet.has(currentRv.xmin);

    // Also check if the row was deleted by an active concurrent txn
    const deletedByActiveConcurrent =
      currentRv.xmax !== null &&
      currentRv.xmax > snapshot &&
      currentRv.xmax !== txnXid &&
      activeXidSet.has(currentRv.xmax);

    if (modifiedByActiveConcurrent || deletedByActiveConcurrent) {
      const detail =
        `Write-skew anomaly detected on row "${key}": ` +
        `txn ${txnXid} (snapshot=${snapshot}) read row that was ` +
        (modifiedByActiveConcurrent
          ? `modified by active txn ${currentRv.xmin}`
          : `deleted by active txn ${currentRv.xmax}`);

      const err = new DatabaseError(
        'serialization_anomaly',
        '40001',
        'ERROR',
        detail,
        'Retry the transaction with a fresh snapshot. Reduce concurrent SERIALIZABLE transactions.',
      );

      logger.error(
        { txnXid, key, rowXmin: currentRv.xmin, rowXmax: currentRv.xmax, snapshot },
        'Write-skew anomaly detected',
      );

      throw err;
    }
  }

  return false;
}
