/**
 * OffsetShim.ts — Fix bare OFFSET clauses for SQLite
 *
 * PostgreSQL allows `SELECT ... OFFSET n` without LIMIT (treated as LIMIT ALL).
 * SQLite requires `LIMIT` before `OFFSET`. This shim detects bare OFFSET
 * clauses (OFFSET appearing without a preceding LIMIT keyword) and inserts
 * `LIMIT -1` before them.
 *
 * Strategy:
 * 1. Find the last SELECT-level (not subquery) OFFSET clause
 * 2. Check if there's a LIMIT between SELECT and OFFSET at the same level
 * 3. If no LIMIT found, insert `LIMIT -1` just before the OFFSET
 *
 * This is a pragmatic approach — fully parsing SQL to track nested subqueries
 * is complex. For Prisma's specific patterns (simple SELECT with bare OFFSET),
 * this handles the common case.
 */

import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

// Match OFFSET at the top level (after WHERE/HAVING/GROUP BY, but not inside subqueries)
// We look for OFFSET that:
// 1. Is not inside parentheses (subquery)
// 2. Has no LIMIT keyword before it at the same level
// 3. Is the last SELECT-level OFFSET in the query

// A bare OFFSET may be followed by a numeric literal, a `$n` parameter, or a
// `?` placeholder. The trailing bound uses `(?!\w)` rather than `\b` because a
// `?` placeholder is a non-word character — `\b` would fail between `?` and the
// following non-word/end-of-input, silently missing `OFFSET ?`.
//
// The SQL-standard `OFFSET n ROWS` / `OFFSET n ROW` spelling (optionally
// followed by `FETCH …`) is *not* a bare OFFSET — it is handled separately by
// FetchFirstShim. Exclude it here so `OFFSET 1 ROW FETCH NEXT 2 ROWS ONLY`
// does not get a spurious `LIMIT -1` injected (which would later collide with
// FetchFirstShim's `LIMIT n` and produce a double-LIMIT error, BUG #23).
const OFFSET_RE = /\bOFFSET\s+(?:\$?\d+|\?)(?!\s*ROWS?\b)/i;

/**
 * Check if the SQL has a bare OFFSET clause (no preceding LIMIT at the same level).
 *
 * The scan runs on literal-protected SQL so an OFFSET token inside a string
 * literal, quoted identifier, or comment is never reported (BUG #97).
 */
export function hasBareOffset(sql: string): boolean {
  if (typeof sql !== 'string') return false;

  // Quick check: does it have OFFSET?
  if (!OFFSET_RE.test(sql)) return false;

  // Protect literals/comments so the character scan below (which only tracks
  // parentheses depth) cannot mistake a token inside them for a real keyword.
  const protectedSql = protectSQL(sql).protectedSql;

  // For each non-nested OFFSET, verify there's no preceding LIMIT
  // at the same nesting level
  let depth = 0;
  let lastLimitIndex = -1;
  let lastOffsetIndex = -1;

  for (let i = 0; i < protectedSql.length; i++) {
    const ch = protectedSql[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === 'L' && /LIMIT\b/i.test(protectedSql.slice(i, i + 5))) {
      i += 4; // skip 'LIMIT'
      lastLimitIndex = i;
    } else if (depth === 0 && ch === 'O' && /OFFSET\b/i.test(protectedSql.slice(i, i + 6))) {
      i += 5; // skip 'OFFSET'
      lastOffsetIndex = i;
    }
  }

  // If we have OFFSET but no LIMIT at the top level → bare OFFSET
  return lastOffsetIndex > 0 && lastLimitIndex < 0;
}

/**
 * Add `LIMIT -1` before bare OFFSET clauses.
 *
 * @param sql - SQL string that may contain bare OFFSET
 * @returns SQL with LIMIT -1 inserted before bare OFFSET
 */
export function fixBareOffset(sql: string): string {
  if (!hasBareOffset(sql)) return sql;

  // Protect literals/comments so the scan never rewrites a token inside them;
  // restoreSQL at the end maps placeholders back to the original text.
  const protectedSql = protectSQL(sql);

  // hasBareOffset already guarantees there is no top-level LIMIT, so the scan
  // only needs to locate the first top-level (depth 0) OFFSET and insert
  // `LIMIT -1` before it. A `limitFound` guard would be unreachable dead code
  // here, because the entry guard filters out every SQL containing a top-level
  // LIMIT before this loop ever runs.
  let depth = 0;
  const working = protectedSql.protectedSql;

  for (let i = 0; i < working.length; i++) {
    const ch = working[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === 'O' && /^OFFSET\b/i.test(working.slice(i))) {
      // Found the bare top-level OFFSET — insert LIMIT -1 before it and restore.
      const before = working.slice(0, i);
      const after = working.slice(i);
      return restoreSQL({
        ...protectedSql,
        protectedSql: before + 'LIMIT -1 ' + after,
      });
    }
  }

  return restoreSQL({ ...protectedSql, protectedSql: working });
}
