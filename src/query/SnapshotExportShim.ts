/**
 * SnapshotExportShim — PostgreSQL snapshot export compatibility shim for SQLite.
 *
 * PostgreSQL supports cross-transaction consistent snapshots via:
 *
 * ```sql
 * SELECT pg_export_snapshot();        -- Returns a snapshot identifier
 * SET TRANSACTION SNAPSHOT 'id';      -- Import a snapshot into the current txn
 * ```
 *
 * SQLite has no equivalent mechanism — it uses its own internal snapshotting
 * (single-writer at the file level). Since sqlvec-db's SQLite backend
 * serialises writes within transactional context, PG-style snapshot export
 * and import operations are unnecessary and can be safely rewritten to no-ops.
 *
 * ## Strategy
 *
 * | SQL                                                              | Output                                                         | rewritten |
 * |------------------------------------------------------------------|----------------------------------------------------------------|-----------|
 * | `SELECT pg_export_snapshot()`                                    | `SELECT '<random-uuid>' as snapshot`  | true      |
 * | `select pg_export_snapshot()`                                    | same                                                           | true      |
 * | `SELECT PG_EXPORT_SNAPSHOT()`                                    | same                                                           | true      |
 * | `SET TRANSACTION SNAPSHOT '010ABCD-1.0'`                         | `SELECT 1`                                                     | true      |
 * | `SET TRANSACTION SNAPSHOT 'id'`                                  | `SELECT 1`                                                     | true      |
 * | `set transaction snapshot 'abc'`                                 | `SELECT 1`                                                     | true      |
 * | `BEGIN ISOLATION LEVEL REPEATABLE READ`                          | (pass-through)                                                 | false     |
 * | `BEGIN ISOLATION LEVEL SERIALIZABLE`                             | (pass-through, PG serializable is handled elsewhere)           | false     |
 * | `SELECT * FROM users`                                            | (pass-through)                                                 | false     |
 *
 * Note: `BEGIN {ISOLATION LEVEL REPEATABLE READ|SERIALIZABLE}` is detected
 * as snapshot-adjacent but preserved verbatim — SQLite supports
 * `BEGIN IMMEDIATE` / `BEGIN EXCLUSIVE` semantics and REPEATABLE READ
 * is handled at the engine layer.
 *
 * ## Key guarantees
 *
 * - All handled output is valid SQLite
 * - No false positives on non-snapshot SQL (e.g. column named `snapshot`)
 * - Detection is conservative: only top-level snapshot-export/import statements
 * - PinoLogger integration for debugging and audit trails
 *
 * @module SnapshotExportShim
 */
import { randomUUID } from 'crypto';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('SnapshotExportShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface SnapshotResult {
  /** Rewritten SQL (rewritten version if rewritten, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as snapshot-related and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches `SELECT pg_export_snapshot()` with optional whitespace / parentheses.
 *
 * PostgreSQL syntax:
 *   SELECT pg_export_snapshot()
 *
 * The function takes no arguments. The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Allows optional trailing semicolon
 *
 * Note: `pg_export_snapshot` is the only snapshot-export function in PG;
 * there are no argument variants.
 */
const EXPORT_SNAPSHOT = /^\s*SELECT\s+pg_export_snapshot\s*\(\s*\)\s*;?\s*$/i;

/**
 * Matches `SET TRANSACTION SNAPSHOT 'id'`.
 *
 * PostgreSQL syntax:
 *   SET TRANSACTION SNAPSHOT 'snapshot_id'
 *
 * The snapshot id is a single-quoted string literal. The pattern:
 * - Case-insensitive
 * - Allows leading whitespace
 * - Allows optional trailing semicolon
 */
const SET_SNAPSHOT = /^\s*SET\s+TRANSACTION\s+SNAPSHOT\s+'[^']*'\s*;?\s*$/i;

/**
 * Matches `BEGIN [WORK|TRANSACTION] ISOLATION LEVEL REPEATABLE READ`.
 *
 * PostgreSQL syntax:
 *   BEGIN [WORK | TRANSACTION] [ISOLATION LEVEL REPEATABLE READ]
 *   BEGIN [WORK | TRANSACTION] [ISOLATION LEVEL SERIALIZABLE]
 *
 * Only REPEATABLE READ is detected here (SERIALIZABLE is handled by
 * a separate shim). This is detected but NOT rewritten — SQLite supports
 * repeatable read semantics and the engine layer handles it.
 *
 * Pattern components:
 * - `BEGIN` optionally followed by `WORK` or `TRANSACTION`
 * - `ISOLATION LEVEL REPEATABLE READ`
 */
const BEGIN_REPEATABLE_READ = /^\s*BEGIN\s+(?:WORK\s+|TRANSACTION\s+)?ISOLATION\s+LEVEL\s+REPEATABLE\s+READ\s*;?\s*$/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string is snapshot-related.
 *
 * Returns `true` for:
 * - `SELECT pg_export_snapshot()`
 * - `SET TRANSACTION SNAPSHOT 'id'`
 * - `BEGIN ISOLATION LEVEL REPEATABLE READ` (snapshot-adjacent)
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is snapshot-related
 *
 * @example
 * ```ts
 * detectSnapshot("SELECT pg_export_snapshot()");          // true
 * detectSnapshot("SET TRANSACTION SNAPSHOT 'abc'");       // true
 * detectSnapshot("BEGIN ISOLATION LEVEL REPEATABLE READ");// true
 * detectSnapshot("SELECT * FROM users");                  // false
 * detectSnapshot("-- snapshot comment");                  // false
 * ```
 */
export function detectSnapshot(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Check for pg_export_snapshot()
  if (EXPORT_SNAPSHOT.test(trimmed)) {
    return true;
  }

  // Check for SET TRANSACTION SNAPSHOT 'id'
  if (SET_SNAPSHOT.test(trimmed)) {
    return true;
  }

  // Check for BEGIN ISOLATION LEVEL REPEATABLE READ
  if (BEGIN_REPEATABLE_READ.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL snapshot-export SQL statement to a SQLite-compatible
 * equivalent.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is not snapshot-related, return unchanged with
 *    `rewritten: false`.
 * 2. If the SQL is `SELECT pg_export_snapshot()`, rewrite to
 *    `SELECT '<random-uuid>' as snapshot`
 *    with `rewritten: true`.
 * 3. If the SQL is `SET TRANSACTION SNAPSHOT 'id'`, rewrite to `SELECT 1`
 *    with `rewritten: true`.
 * 4. If the SQL is `BEGIN ISOLATION LEVEL REPEATABLE READ`, return
 *    unchanged with `rewritten: false` — SQLite supports this at the
 *    engine layer.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link SnapshotResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteSnapshot("SELECT pg_export_snapshot()");
 * // → { sql: "SELECT '<random-uuid>' as snapshot", rewritten: true }
 *
 * rewriteSnapshot("SET TRANSACTION SNAPSHOT '010ABCD-1.0'");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteSnapshot("BEGIN ISOLATION LEVEL REPEATABLE READ");
 * // → { sql: "BEGIN ISOLATION LEVEL REPEATABLE READ", rewritten: false }
 *
 * rewriteSnapshot("SELECT * FROM users");
 * // → { sql: "SELECT * FROM users", rewritten: false }
 * ```
 */
export function rewriteSnapshot(sql: string): SnapshotResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Is this even a snapshot-related statement? ──────────

  if (!detectSnapshot(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'Not a snapshot statement — passing through unchanged',
    );
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 2: Dispatch based on variant ───────────────────────────

  // Case A: SELECT pg_export_snapshot()
  if (EXPORT_SNAPSHOT.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'pg_export_snapshot() detected — rewriting to no-op UUID',
    );
    return {
      sql: `SELECT '${randomUUID()}' as snapshot`,
      rewritten: true,
    };
  }

  // Case B: SET TRANSACTION SNAPSHOT 'id'
  if (SET_SNAPSHOT.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SET TRANSACTION SNAPSHOT detected — rewriting to SELECT 1 (no-op for SQLite)',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // Case C: BEGIN ISOLATION LEVEL REPEATABLE READ
  // Detected but NOT rewritten — SQLite supports REPEATABLE READ semantics
  // at the engine layer. Pass through with rewritten: false.
  // The false branch is unreachable: detectSnapshot() returns true only for
  // the three patterns checked above, so dispatch always matches one of them.
  /* c8 ignore next */
  if (BEGIN_REPEATABLE_READ.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'BEGIN ISOLATION LEVEL REPEATABLE READ detected — preserving verbatim (SQLite compatible)',
    );
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // Fallback — defensive; should not be reached if detectSnapshot
  // and the dispatch checks stay in sync.
  /* c8 ignore start */
  logger.warn(
    { sql: trimmed },
    'Snapshot-related SQL detected but no rewrite rule matched — passing through unchanged',
  );
  return {
    sql: trimmed,
    rewritten: false,
  };
  /* c8 ignore stop */
}
