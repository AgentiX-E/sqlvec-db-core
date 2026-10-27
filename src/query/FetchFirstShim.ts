/**
 * FetchFirstShim — Rewrites SQL-standard / PostgreSQL row-limiting syntax into
 * SQLite's LIMIT / OFFSET clauses.
 *
 * PostgreSQL accepts the standard grammar:
 *
 *   SELECT … OFFSET n ROWS                      → SELECT … LIMIT -1 OFFSET n
 *   SELECT … FETCH FIRST n ROWS ONLY            → SELECT … LIMIT n
 *   SELECT … FETCH NEXT n ROWS ONLY             → SELECT … LIMIT n
 *   SELECT … OFFSET n ROWS FETCH NEXT m ROWS …  → SELECT … LIMIT m OFFSET n
 *
 * SQLite only knows `LIMIT expr [OFFSET expr]`, so `FETCH FIRST/… ROWS ONLY`
 * (and the `… ROWS` suffix on OFFSET) reach SQLite as `near "FIRST"/"ROWS":
 * syntax error`. This shim normalizes those forms before execution.
 *
 * @module FetchFirstShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('FetchFirstShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface FetchFirstResult {
  sql: string;
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/** Matches `OFFSET n ROWS [FETCH …]` — the SQL-standard OFFSET spelling. */
const OFFSET_ROWS_RE = /\bOFFSET\s+(\d+|\?|\$\w+|:\w+)\s+ROWS?\b/gi;

/** Matches `FETCH (FIRST|NEXT) n ROWS [ONLY|WITH TIES]`. */
const FETCH_FIRST_RE = /\bFETCH\s+(FIRST|NEXT)\s+(\d+|\?|\$\w+|:\w+)\s+ROWS?\s+(ONLY|WITH\s+TIES)\b/gi;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect SQL-standard row-limiting clauses that SQLite does not understand.
 */
export function detectFetchFirst(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  // Run detection on literal-protected SQL so a FETCH/ROWS token inside a
  // string literal, quoted identifier, or comment is never reported (BUG #22).
  const protectedSql = protectSQL(sql).protectedSql;
  // Global regexes share a mutable lastIndex across .test() calls; reset it
  // before each check so repeated detection is deterministic.
  OFFSET_ROWS_RE.lastIndex = 0;
  const hasOffset = OFFSET_ROWS_RE.test(protectedSql);
  FETCH_FIRST_RE.lastIndex = 0;
  const hasFetch = FETCH_FIRST_RE.test(protectedSql);
  return hasOffset || hasFetch;
}

/**
 * Rewrite SQL-standard `OFFSET n ROWS` / `FETCH FIRST n ROWS ONLY` into
 * SQLite `LIMIT` / `OFFSET`.
 */
export function rewriteFetchFirst(sql: string): FetchFirstResult {
  if (!detectFetchFirst(sql)) return { sql, rewritten: false };

  // Protect literals/comments so the replace below never rewrites a token
  // inside them; restoreSQL at the end maps placeholders back to the original.
  const protectedSql = protectSQL(sql);
  let out = protectedSql.protectedSql;

  // 1. Normalize `OFFSET n ROWS` → a placeholder-free `OFFSET n`.
  OFFSET_ROWS_RE.lastIndex = 0;
  out = out.replace(OFFSET_ROWS_RE, (m, n) => `OFFSET ${n}`);

  // 2. `FETCH (FIRST|NEXT) n ROWS ONLY/WITH TIES` → `LIMIT n`.
  //    (WITH TIES is a superset of LIMIT; we degrade to plain LIMIT.)
  FETCH_FIRST_RE.lastIndex = 0;
  out = out.replace(FETCH_FIRST_RE, (_m, _first, n) => `LIMIT ${n}`);

  // 3. SQLite requires `LIMIT … OFFSET …` (offset must come after limit), but
  //    the SQL-standard spelling is `OFFSET … FETCH …`, which step 1–2 turned
  //    into `OFFSET … LIMIT …`. Swap them back to a canonical LIMIT/OFFSET.
  out = out.replace(/\bOFFSET\s+(-?\d+|\?|\$\w+|:\w+)\s+LIMIT\s+(-?\d+|\?|\$\w+|:\w+)\b/gi, 'LIMIT $2 OFFSET $1');

  out = restoreSQL({ ...protectedSql, protectedSql: out });

  logger.debug('Rewrote SQL-standard FETCH FIRST/OFFSET ROWS to LIMIT/OFFSET');
  return { sql: out, rewritten: true };
}
