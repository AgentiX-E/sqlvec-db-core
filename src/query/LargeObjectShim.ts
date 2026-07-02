/**
 * LargeObjectShim — PostgreSQL large object function compatibility shim for SQLite.
 *
 * PostgreSQL supports large objects (BLOBs stored in pg_largeobject system catalog)
 * accessed through functions like lo_write, lo_read, lo_tell.
 *
 * SQLite has no large object system. This shim provides stub implementations
 * that return sensible defaults for compatibility.
 *
 * ## Strategy
 *
 * All large object functions are no-ops that return default values:
 *   - `lo_write` — no-op, returns 0 (bytes written)
 *   - `lo_read` — no-op, returns empty bytea ('' )
 *   - `lo_tell` — no-op, returns 0 (position)
 *
 * @module LargeObjectShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('LargeObjectShim');

// ── Types ────────────────────────────────────────────────────────

export interface LargeObjectResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Constants – Regex patterns ───────────────────────────────────

/**
 * Detects `lo_write(handle, buf)` — write buffer to large object.
 * Returns int (bytes written).
 */
const LO_WRITE_RE = /\blo_write\s*\(([^)]+)\)/gi;

/**
 * Detects `lo_read(handle, len)` — read from large object.
 * Returns bytea.
 */
const LO_READ_RE = /\blo_read\s*\(([^)]+)\)/gi;

/**
 * Detects `lo_tell(handle)` — tell position in large object.
 * Returns int (position).
 */
const LO_TELL_RE = /\blo_tell\s*\(([^)]+)\)/gi;

/**
 * Combined pattern for detecting any large object function.
 */
const ANY_LO_FUNC_RE = /\b(lo_write|lo_read|lo_tell)\s*\(/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains PostgreSQL large object
 * functions not supported by SQLite.
 *
 * @param sql - The raw SQL string to inspect
 * @returns `true` if a large object function is detected
 *
 * @example
 * ```ts
 * detectLargeObjectFunc("SELECT lo_write(1, 'data')"); // true
 * detectLargeObjectFunc("SELECT lo_tell(1)");          // true
 * detectLargeObjectFunc("SELECT 1");                   // false
 * ```
 */
export function detectLargeObjectFunc(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return ANY_LO_FUNC_RE.test(sql.trim());
}

/**
 * Rewrite PostgreSQL large object function calls to no-op stubs
 * compatible with SQLite.
 *
 * Processing rules:
 *
 * | Input                       | Output          | rewritten |
 * |-----------------------------|-----------------|-----------|
 * | `lo_write(handle, buf)`     | `0`             | true      |
 * | `lo_read(handle, len)`      | `X''`           | true      |
 * | `lo_tell(handle)`           | `0`             | true      |
 * | No large object function    | Pass through    | false     |
 *
 * @param sql - The raw SQL string to process
 * @returns A LargeObjectResult with the rewritten SQL and rewritten flag
 *
 * @example
 * ```ts
 * rewriteLargeObjectFunc("SELECT lo_write(1, 'data')")
 * // → { sql: "SELECT 0", rewritten: true }
 *
 * rewriteLargeObjectFunc("SELECT lo_read(1, 100)")
 * // → { sql: "SELECT X''", rewritten: true }
 *
 * rewriteLargeObjectFunc("SELECT lo_tell(1)")
 * // → { sql: "SELECT 0", rewritten: true }
 *
 * rewriteLargeObjectFunc("SELECT 1")
 * // → { sql: "SELECT 1", rewritten: false }
 * ```
 */
export function rewriteLargeObjectFunc(sql: string): LargeObjectResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  // Quick check first: bail early if no large object function is present
  if (!detectLargeObjectFunc(sql)) {
    return { sql, rewritten: false };
  }

  let working = sql;
  let rewritten = false;

  // ── Phase 1: lo_write(handle, buf) → 0 ──
  working = working.replace(LO_WRITE_RE, () => {
    rewritten = true;
    return '0';
  });

  // ── Phase 2: lo_read(handle, len) → X'' (empty bytea) ──
  working = working.replace(LO_READ_RE, () => {
    rewritten = true;
    return "X''";
  });

  // ── Phase 3: lo_tell(handle) → 0 ──
  working = working.replace(LO_TELL_RE, () => {
    rewritten = true;
    return '0';
  });

  if (rewritten) {
    logger.debug({ before: sql, after: working }, 'Large object function rewritten');
  }

  return { sql: working, rewritten };
}
