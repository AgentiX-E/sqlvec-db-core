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

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

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
  // Protect string literals, quoted identifiers, and comments so a network
  // type name inside them (`SELECT 'inet'`) is not reported as a type reference.
  // Reset lastIndex because NET_TYPE_RE is a shared module-level global regex.
  NET_TYPE_RE.lastIndex = 0;
  return NET_TYPE_RE.test(protectSQL(sql).protectedSql);
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

  // Quick check first: bail early if no network type is present (outside literals).
  if (!detectNetType(sql)) {
    return { sql, rewritten: false };
  }

  // Protect string literals, quoted identifiers, and comments so a network
  // type name inside them (e.g. `SELECT 'inet'`) is never rewritten to TEXT.
  const protectedSql = protectSQL(sql);
  const rewrittenSql = restoreSQL({
    ...protectedSql,
    protectedSql: protectedSql.protectedSql.replace(NET_TYPE_RE, 'TEXT'),
  });

  // detectNetType() already guaranteed a network type keyword is present, so
  // the replacement above necessarily changed the SQL.
  logger.debug({ original: sql, rewritten: rewrittenSql }, 'Rewrote network type(s) to TEXT');

  return { sql: rewrittenSql, rewritten: true };
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
