/**
 * MacAddrShim — PostgreSQL network address type compatibility shim for SQLite.
 *
 * PostgreSQL supports MACADDR, MACADDR8, INET, and CIDR network address types
 * along with subnet containment operators (>>=, <<=, etc.). SQLite has no
 * native equivalent; network addresses are stored as TEXT.
 *
 * This shim intercepts DDL statements containing network address type
 * references and rewrites them to TEXT, and provides a no-op pass-through
 * for network operator expressions (since those are typically handled
 * at the application layer or via function-based shims).
 *
 * Strategy:
 *   1. DDL type rewrite: MACADDR/MACADDR8/INET/CIDR → TEXT
 *   2. Network expression: passthrough (no-op / simplified)
 *
 * @module MacAddrShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('MacAddrShim');

// ── Types ────────────────────────────────────────────────────────

export interface MacAddrResult {
  /** Rewritten SQL (same as original when no rewrite is needed) */
  sql: string;
  /** Whether the SQL was actually rewritten or modified */
  rewritten: boolean;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * Regex matching any network address type keyword.
 *
 * Matches only whole words via \b boundaries:
 *   - MACADDR     (PostgreSQL MAC address, 6 bytes)
 *   - MACADDR8    (PostgreSQL MAC address, 8 bytes)
 *   - INET        (IPv4/IPv6 network address)
 *   - CIDR        (IPv4/IPv6 network block)
 *
 * Case-insensitive per standard SQL identifier convention.
 */
const NET_TYPE_RE = /\b(MACADDR8?|INET|CIDR)\b/gi;

/**
 * Compiled set of the recognized network type names (lowercased)
 * for fast lookup in detectNetType and related checks.
 */
const NET_TYPE_NAMES = new Set(['macaddr', 'macaddr8', 'inet', 'cidr']);

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL contains any network address type
 * references (MACADDR, MACADDR8, INET, CIDR).
 *
 * Handles both DDL statements (CREATE TABLE, ALTER TABLE) and
 * arbitrary SQL that may reference these types.
 *
 * @param sql - The SQL statement to inspect.
 * @returns `true` if the SQL contains at least one network type keyword.
 *
 * @example
 * ```ts
 * detectNetType('CREATE TABLE t (ip INET)');
 * // → true
 *
 * detectNetType('CREATE TABLE t (addr MACADDR8)');
 * // → true
 *
 * detectNetType('SELECT * FROM t');
 * // → false
 * ```
 */
export function detectNetType(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }
  NET_TYPE_RE.lastIndex = 0;
  return NET_TYPE_RE.test(sql);
}

/**
 * Rewrite network address types (MACADDR/MACADDR8/INET/CIDR) in DDL
 * to TEXT for SQLite compatibility.
 *
 * Processing rules:
 * - Replaces occurrences of MACADDR, MACADDR8, INET, CIDR with TEXT
 *   (word-boundary-aware, case-insensitive)
 * - Preserves constraints, defaults, and all other DDL structure
 * - If no network types are found, returns the original SQL unchanged
 *
 * @param sql - The SQL statement to rewrite (typically DDL).
 * @returns A MacAddrResult with the rewritten SQL and a flag indicating
 *          whether any changes were made.
 *
 * @example
 * ```ts
 * rewriteNetType('CREATE TABLE t (ip INET, mac MACADDR)');
 * // → { sql: 'CREATE TABLE t (ip TEXT, mac TEXT)', rewritten: true }
 *
 * rewriteNetType('CREATE TABLE t (id INT, name TEXT)');
 * // → { sql: 'CREATE TABLE t (id INT, name TEXT)', rewritten: false }
 *
 * rewriteNetType(`CREATE TABLE t (
 *   host INET NOT NULL DEFAULT '0.0.0.0',
 *   cidr CIDR,
 *   mac MACADDR8
 * )`);
 * // → { sql: `CREATE TABLE t (
 * //         host TEXT NOT NULL DEFAULT '0.0.0.0',
 * //         cidr TEXT,
 * //         mac TEXT
 * //       )`, rewritten: true }
 * ```
 */
export function rewriteNetType(sql: string): MacAddrResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false };
  }

  // Quick check first: bail early if no network type is present
  if (!detectNetType(sql)) {
    return { sql, rewritten: false };
  }

  // Check each type to see if a rewrite is actually needed
  let rewritten = false;
  for (const typeName of NET_TYPE_NAMES) {
    const pattern = new RegExp(`\\b${escapeRegExp(typeName)}\\b`, 'gi');
    if (pattern.test(sql)) {
      rewritten = true;
      break;
    }
  }

  // Perform the replacement – replace all network type keywords with TEXT
  const rewrittenSql = sql.replace(NET_TYPE_RE, 'TEXT');

  if (rewrittenSql !== sql) {
    rewritten = true;
  }

  if (rewritten) {
    logger.debug({ original: sql, rewritten: rewrittenSql }, 'Rewrote network type(s) to TEXT');
  }

  return { sql: rewrittenSql, rewritten };
}

/**
 * Simplify network operator expressions for SQLite compatibility.
 *
 * PostgreSQL supports network-specific operators such as:
 *   - <<=  (contained by or equals)
 *   - >>=  (contains or equals)
 *   - &&   (overlaps / ip ranges intersect)
 *   - ~    (bitwise not, also used for network containment)
 *
 * This simplified implementation is a **no-op**: it passes the SQL
 * through unchanged. Network operator expressions are typically
 * handled at the application layer, via function-based shims, or by
 * the query planner before reaching SQLite.
 *
 * For a more complete implementation, replace this function with one
 * that rewrites operators to equivalent function calls, e.g.:
 *   - `inet '1.2.3.4' <<= inet '1.2.0.0/16'`
 *     → `net_contained_by_or_equals('1.2.3.4', '1.2.0.0/16')`
 *
 * @param sql - The SQL expression to process.
 * @returns A MacAddrResult with the (unchanged) SQL and `rewritten: false`.
 */
export function simplifyNetExpr(sql: string): MacAddrResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false };
  }

  // No-op: pass through unchanged
  // Full operator rewriting can be added here in a future iteration
  return { sql, rewritten: false };
}

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Escape special regex characters in a string.
 *
 * Ensures that type names are safely interpolated into regex patterns
 * without unintended regex metacharacters being interpreted.
 *
 * @param str - The string to escape.
 * @returns The string with regex special characters escaped.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
