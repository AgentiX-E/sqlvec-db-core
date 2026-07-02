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

// Match OFFSET at the top level (after WHERE/HAVING/GROUP BY, but not inside subqueries)
// We look for OFFSET that:
// 1. Is not inside parentheses (subquery)
// 2. Has no LIMIT keyword before it at the same level
// 3. Is the last SELECT-level OFFSET in the query

const OFFSET_RE = /\bOFFSET\s+(?:\$?\d+|\?)\b/i;

/**
 * Check if the SQL has a bare OFFSET clause (no preceding LIMIT at the same level)
 */
export function hasBareOffset(sql: string): boolean {
  if (typeof sql !== 'string') return false;

  // Quick check: does it have OFFSET?
  if (!OFFSET_RE.test(sql)) return false;

  // For each non-nested OFFSET, verify there's no preceding LIMIT
  // at the same nesting level
  let depth = 0;
  let lastLimitIndex = -1;
  let lastOffsetIndex = -1;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === 'L' && /LIMIT\b/i.test(sql.slice(i, i + 5))) {
      i += 4; // skip 'LIMIT'
      lastLimitIndex = i;
    } else if (depth === 0 && ch === 'O' && /OFFSET\b/i.test(sql.slice(i, i + 6))) {
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

  // More precise: find the last top-level OFFSET and insert LIMIT -1 before it
  let depth = 0;
  let limitFound = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === 'L' && /^LIMIT\b/i.test(sql.slice(i))) {
      limitFound = true;
      i += 4;
    } else if (depth === 0 && ch === 'O' && /^OFFSET\b/i.test(sql.slice(i))) {
      if (!limitFound) {
        // Found bare OFFSET — insert LIMIT -1 before it
        const before = sql.slice(0, i);
        const after = sql.slice(i);
        return before + 'LIMIT -1 ' + after;
      }
      // Reset for next potential OFFSET
      limitFound = false;
      i += 5;
    }
  }

  return sql;
}
