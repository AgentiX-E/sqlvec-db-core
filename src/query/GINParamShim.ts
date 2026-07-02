/**
 * GINParamShim — PostgreSQL GIN index pending-list parameter compatibility shim for SQLite.
 *
 * PostgreSQL provides the `gin_pending_list_limit` GUC (Grand Unified Configuration)
 * parameter to control the maximum size of the pending list for GIN indexes.
 * The pending list is used to buffer inserts during fast-update mode; when the
 * list exceeds the configured limit, it is merged into the main index structure.
 *
 * SQLite does not support GIN indexes at all, so the gin_pending_list_limit
 * parameter is meaningless. This shim detects and rewrites related SET/SHOW
 * statements to SQLite-compatible no-ops.
 *
 * ## Strategy
 * 1. `SET gin_pending_list_limit = N` → Rewrite as `SELECT 1` (no-op)
 * 2. `SHOW gin_pending_list_limit` → Rewrite as `SELECT '0' as gin_pending_list_limit`
 *    (informational query reporting the absence of GIN index support)
 * 3. All other SQL → Passthrough (unchanged)
 *
 * ## Supported patterns
 *
 * ### SET variants:
 * ```sql
 * SET gin_pending_list_limit = 4096;              -- = value
 * SET gin_pending_list_limit = 0;                 -- = value
 * SET gin_pending_list_limit TO 4096;             -- TO value
 * SET SESSION gin_pending_list_limit = 4096;      -- SESSION prefix
 * SET LOCAL gin_pending_list_limit = 4096;        -- LOCAL prefix
 * ```
 *
 * ### SHOW variants:
 * ```sql
 * SHOW gin_pending_list_limit;
 * ```
 *
 * ## Key guarantees
 * - No false positives on SQL containing 'gin_pending_list_limit' in identifiers,
 *   strings, or comments
 * - Detection is case-insensitive
 * - PinoLogger integration for debugging and audit trails
 *
 * @module GINParamShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('GINParamShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface GINParamResult {
  /** Rewritten SQL (original SQL if not rewritten) */
  sql: string;
  /** Whether GIN parameter was detected and processed */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants – Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches a SET statement for gin_pending_list_limit.
 *
 * Captures: the value (numeric)
 *
 * Covers:
 *   SET gin_pending_list_limit = 4096
 *   SET gin_pending_list_limit = 0
 *   SET gin_pending_list_limit TO 4096
 *   SET SESSION gin_pending_list_limit = 4096
 *   SET LOCAL gin_pending_list_limit = 4096
 */
const SET_GIN_PARAM_PATTERN =
  /^\s*SET\s+(?:SESSION\s+|LOCAL\s+|TEMP(?:ORARY)?\s+)?gin_pending_list_limit\s*(?:[=:]\s*|\s+TO\s+)(\d+)\s*;?\s*$/i;

/**
 * Matches a SHOW statement for gin_pending_list_limit.
 *
 * Covers:
 *   SHOW gin_pending_list_limit;
 */
const SHOW_GIN_PARAM_PATTERN =
  /^\s*SHOW\s+gin_pending_list_limit\s*;?\s*$/i;

/**
 * Broad detection pattern — matches any statement containing
 * "gin_pending_list_limit" as a significant token (not inside a string literal).
 * Used by `detectGINParam` for early fast-path detection.
 */
const GIN_PARAM_TOKEN_PATTERN = /gin_pending_list_limit/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string references `gin_pending_list_limit`.
 *
 * Performs a case-insensitive check for the token `gin_pending_list_limit`
 * anywhere in the statement. Intentionally broad to catch both SET and SHOW
 * variants.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL references GIN index parameter configuration
 *
 * @example
 * ```ts
 * detectGINParam("SET gin_pending_list_limit = 4096;");   // true
 * detectGINParam("SHOW gin_pending_list_limit;");         // true
 * detectGINParam("SELECT * FROM users");                  // false
 * ```
 */
export function detectGINParam(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast keyword check before regex matching
  if (!GIN_PARAM_TOKEN_PATTERN.test(trimmed)) {
    return false;
  }

  // Confirm it's either a SET or SHOW targeting gin_pending_list_limit
  return (
    SET_GIN_PARAM_PATTERN.test(trimmed) ||
    SHOW_GIN_PARAM_PATTERN.test(trimmed)
  );
}

/**
 * Rewrite a PostgreSQL GIN index parameter SQL statement for SQLite compatibility.
 *
 * **Processing rules:**
 * | Input                                           | Output                                    | rewritten |
 * |-------------------------------------------------|-------------------------------------------|-----------|
 * | `SET gin_pending_list_limit = 4096`             | `SELECT 1`                                | true      |
 * | `SET gin_pending_list_limit = 0`                | `SELECT 1`                                | true      |
 * | `SET gin_pending_list_limit TO 4096`            | `SELECT 1`                                | true      |
 * | `SET SESSION gin_pending_list_limit = 4096`     | `SELECT 1`                                | true      |
 * | `SET LOCAL gin_pending_list_limit = 4096`       | `SELECT 1`                                | true      |
 * | `SHOW gin_pending_list_limit`                   | `SELECT '0' as gin_pending_list_limit`    | true      |
 * | Non-GIN-param SQL                               | `<original>`                              | false     |
 * | Empty string                                    | `''`                                      | false     |
 *
 * @param sql   The raw SQL string to process
 * @returns     A GINParamResult indicating the handling outcome
 *
 * @example
 * ```ts
 * const result = rewriteGINParam("SET gin_pending_list_limit = 4096");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * const result = rewriteGINParam("SHOW gin_pending_list_limit");
 * // → { sql: "SELECT '0' as gin_pending_list_limit", rewritten: true }
 *
 * const result = rewriteGINParam("SELECT * FROM users");
 * // → { sql: "SELECT * FROM users", rewritten: false }
 * ```
 */
export function rewriteGINParam(sql: string): GINParamResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Fast-path: no "gin_pending_list_limit" token at all ──

  if (!GIN_PARAM_TOKEN_PATTERN.test(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Check SHOW pattern first ─────────────────────────────

  if (SHOW_GIN_PARAM_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SHOW gin_pending_list_limit detected — rewriting to SELECT',
    );
    return {
      sql: "SELECT '0' as gin_pending_list_limit",
      rewritten: true,
    };
  }

  // ── Check SET pattern ────────────────────────────────────

  if (SET_GIN_PARAM_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SET gin_pending_list_limit detected — rewriting to SELECT 1',
    );
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Token present but not a SET/SHOW we handle → passthrough ──

  logger.debug(
    { sql: trimmed },
    'gin_pending_list_limit token found but not a handled pattern — passing through',
  );

  return {
    sql: trimmed,
    rewritten: false,
  };
}
