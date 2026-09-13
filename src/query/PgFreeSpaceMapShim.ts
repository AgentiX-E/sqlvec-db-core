/**
 * PgFreeSpaceMapShim — PostgreSQL pg_freespacemap extension shim for SQLite.
 *
 * PostgreSQL's pg_freespacemap extension exposes per-page free space via
 * the `pg_freespacemap(rel)` function.  SQLite has no such concept (SQLite
 * manages page space internally), so we provide a synthetic view that
 * estimates available space from pragma data.
 *
 * ## Exported functions
 *
 * | Function                       | Description                               |
 * |--------------------------------|-------------------------------------------|
 * | `pgFreespacemap(rel)`          | Return free-space rows for a relation     |
 * | `detectPgFreeSpaceMap(sql)`    | Regex-detect references to pg_freespacemap|
 * | `rewritePgFreeSpaceMap(sql)`   | Rewrite queries targeting pg_freespacemap |
 *
 * Each row contains:
 *   - relfilenode : OID of the relation
 *   - blkno       : block number
 *   - avail       : available free space in bytes (estimated)
 *
 * @module query/PgFreeSpaceMapShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('PgFreeSpaceMapShim');

// ── Types ────────────────────────────────────────────────────────

export interface PgFreeSpaceMapRow {
  relfilenode: number;
  blkno: number;
  avail: number;
}

export interface FsmRewriteResult {
  sql: string;
  rewritten: boolean;
}

// ── Implementation ───────────────────────────────────────────────

/**
 * Generate synthetic free-space-map rows for a relation.
 *
 * Page size is assumed at 4096 bytes (SQLite default).  We estimate
 * 30% free space per page as a reasonable default for an append-mostly
 * workload.
 *
 * @param relfilenode - Relation OID (0 if unknown).
 * @param pageCount   - Number of pages allocated to the relation.
 * @param pageSize    - SQLite page size in bytes (default 4096).
 * @returns An array of free-space-map row objects.
 */
export function pgFreespacemap(
  relfilenode: number = 0,
  pageCount: number = 0,
  pageSize: number = 4096,
): PgFreeSpaceMapRow[] {
  const count = Math.max(pageCount, 1);
  // PG's fsm reports available bytes per page.
  // For SQLite we estimate ~30% free on each page.
  const estimatedFree = Math.floor(pageSize * 0.3);
  const rows: PgFreeSpaceMapRow[] = [];

  for (let i = 0; i < count; i++) {
    rows.push({
      relfilenode,
      blkno: i,
      avail: estimatedFree,
    });
  }

  return rows;
}

// ── SQL-level detection & rewriting ─────────────────────────────

const RE_PG_FREESPACEMAP = /\bpg_freespacemap\b/i;

/**
 * Detect whether a SQL string references pg_freespacemap.
 */
export function detectPgFreeSpaceMap(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  // Detect only outside string literals, quoted identifiers, and comments so
  // `SELECT 'pg_freespacemap'` is not treated as a reference.
  return RE_PG_FREESPACEMAP.test(protectSQL(sql).protectedSql);
}

/**
 * Rewrite a query targeting pg_freespacemap into a VALUES clause.
 *
 * Pattern:
 *   SELECT * FROM pg_freespacemap('relation_name')
 *   → SELECT * FROM (VALUES (...)) AS pg_freespacemap(...)
 */
export function rewritePgFreeSpaceMap(sql: string): FsmRewriteResult {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql ?? '', rewritten: false };
  }

  // Protect string literals, quoted identifiers, and comments so a
  // pg_freespacemap mention inside them is never rewritten.
  const protectedSql = protectSQL(sql);

  if (!RE_PG_FREESPACEMAP.test(protectedSql.protectedSql)) {
    return { sql, rewritten: false };
  }

  const rewrittenProtected = protectedSql.protectedSql.replace(
    /\bpg_freespacemap\b/gi,
    '(SELECT 0 AS relfilenode, 0 AS blkno, 1228 AS avail)',
  );

  const result = restoreSQL({ ...protectedSql, protectedSql: rewrittenProtected });

  // Reaching this point means a pg_freespacemap outside literals was matched
  // above, so `result` necessarily differs from `sql` (the replacement always
  // changes the text). `rewritten` is still computed defensively for the
  // return contract.
  const rewritten = result !== sql;
  logger.debug({ original: sql, rewritten: result }, 'Rewrote pg_freespacemap reference');

  return { sql: result, rewritten };
}

export { logger };
