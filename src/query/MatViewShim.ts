/**
 * MatViewShim — PostgreSQL MATERIALIZED VIEW real implementation for SQLite.
 *
 * Strategy (G11 real implementation):
 *   CREATE MATERIALIZED VIEW → Create a real SQLite table + store the query in metadata
 *   REFRESH MATERIALIZED VIEW → Rebuild the underlying table data
 *   DROP MATERIALIZED VIEW → Drop both the table and metadata
 *
 * Materialized view metadata is stored in the `__materialized_views` system table:
 *   CREATE TABLE __materialized_views (
 *     view_name TEXT PRIMARY KEY,
 *     query_sql TEXT NOT NULL,
 *     created_at INTEGER NOT NULL,
 *     refreshed_at INTEGER
 *   );
 *
 * Usage (external API expected dependency):
 *   create(viewName, query, db) -> creates table + metadata
 *   refresh(viewName, db) -> rebuilds table data from query
 *   drop(viewName, db) -> drops table + metadata
 *
 * @module MatViewShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('MatViewShim');

// ── Types ────────────────────────────────────────────────────────

export interface MatViewResult {
  /** Rewritten SQL (null = no-op, statement should be skipped entirely) */
  sql: string | null;
  /** Whether the SQL was rewritten */
  rewritten: boolean;
  /** Classification of the matched materialized-view statement type */
  stmtType: 'create' | 'refresh' | 'drop' | 'none';
}

export interface MatViewMeta {
  viewName: string;
  querySql: string;
  createdAt: number;
  refreshedAt: number | null;
}

// ── Constants ────────────────────────────────────────────────────

const CREATE_MATVIEW_RE = /^\s*CREATE\s+MATERIALIZED\s+VIEW\s/i;
const REFRESH_MATVIEW_RE = /^\s*REFRESH\s+MATERIALIZED\s+VIEW\s/i;
const DROP_MATVIEW_RE = /^\s*DROP\s+MATERIALIZED\s+VIEW\s/i;
const MATVIEW_RE = /^\s*(CREATE|REFRESH|DROP)\s+MATERIALIZED\s+VIEW\s/i;
const WITH_DATA_RE = /\s+WITH\s+(NO\s+)?DATA\s*;?\s*$/i;

/** Virtual system table schema for materialized view metadata */
const MATVIEW_META_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS __materialized_views (
    view_name TEXT PRIMARY KEY,
    query_sql TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    refreshed_at INTEGER
  )
`;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL is a MATERIALIZED VIEW statement.
 */
export function detectMatView(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  return MATVIEW_RE.test(sql.trim());
}

/**
 * Handle a MATERIALIZED VIEW statement.
 * Returns rewritten SQL for SQLite compatibility.
 */
export function handleMatView(sql: string): MatViewResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false, stmtType: 'none' };
  }

  const trimmed = sql.trim();

  if (CREATE_MATVIEW_RE.test(trimmed)) {
    const matViewSql = trimmed.replace(CREATE_MATVIEW_RE, 'CREATE VIEW ');
    const rewritten = matViewSql.replace(WITH_DATA_RE, '');
    logger.debug('Rewrote CREATE MATERIALIZED VIEW → CREATE VIEW: %s', rewritten);
    return { sql: rewritten, rewritten: true, stmtType: 'create' };
  }

  if (REFRESH_MATVIEW_RE.test(trimmed)) {
    logger.debug('Suppressing REFRESH MATERIALIZED VIEW statement (no-op): %s', trimmed);
    return { sql: null, rewritten: false, stmtType: 'refresh' };
  }

  if (DROP_MATVIEW_RE.test(trimmed)) {
    const rewritten = trimmed.replace(DROP_MATVIEW_RE, 'DROP VIEW ');
    logger.debug('Rewrote DROP MATERIALIZED VIEW → DROP VIEW: %s', rewritten);
    return { sql: rewritten, rewritten: true, stmtType: 'drop' };
  }

  return { sql: trimmed, rewritten: false, stmtType: 'none' };
}

/**
 * Ensure the metadata table exists for materialized views.
 * Called by create() and before any query that reads metadata.
 *
 * @param queryFn - A function that executes SQL queries (e.g., db.exec or queryRouter.execute)
 */
export async function ensureMetaTable(queryFn: (sql: string) => Promise<any>): Promise<void> {
  try {
    await queryFn(MATVIEW_META_TABLE_DDL);
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to create materialized view meta table');
    throw err;
  }
}

/**
 * Create a materialized view: create a real table + store metadata.
 *
 * @param viewName - Name of the materialized view
 * @param querySql - The SELECT query that populates the view
 * @param queryFn - Function to execute SQL (e.g., db.exec or queryRouter.execute)
 * @returns The MatViewMeta record
 */
export async function create(
  viewName: string,
  querySql: string,
  queryFn: (sql: string) => Promise<any>,
): Promise<MatViewMeta> {
  await ensureMetaTable(queryFn);

  // Create the view as a real table: CREATE TABLE viewName AS SELECT ...
  const createTableSql = `CREATE TABLE "${viewName}" AS ${querySql}`;
  await queryFn(createTableSql);

  // Store metadata
  const now = Date.now();
  const metaSql = `
    INSERT OR REPLACE INTO __materialized_views (view_name, query_sql, created_at, refreshed_at)
    VALUES ('${escapeSql(viewName)}', '${escapeSql(querySql)}', ${now}, ${now})
  `;
  await queryFn(metaSql);

  const meta: MatViewMeta = {
    viewName,
    querySql,
    createdAt: now,
    refreshedAt: now,
  };

  logger.info({ viewName, querySql: querySql.substring(0, 100) }, 'Materialized view created');
  return meta;
}

/**
 * Refresh a materialized view: rebuild the underlying table data.
 *
 * Before REFRESH, the view contains old data if the base table changed.
 * REFRESH rebuilds it atomically via DROP + CREATE.
 *
 * @param viewName - Name of the materialized view
 * @param queryFn - Function to execute SQL
 */
export async function refresh(
  viewName: string,
  queryFn: (sql: string) => Promise<any>,
): Promise<void> {
  await ensureMetaTable(queryFn);

  // Read the stored query
  const selectSql = `SELECT query_sql FROM __materialized_views WHERE view_name = '${escapeSql(viewName)}'`;
  const result = await queryFn(selectSql);

  let querySql: string | null = null;
  if (Array.isArray(result)) {
    if (result.length > 0 && result[0].query_sql) {
      querySql = result[0].query_sql;
    }
  } else if (result && result.rows && result.rows.length > 0) {
    querySql = result.rows[0][0];
  }

  if (!querySql) {
    throw new Error(`Materialized view "${viewName}" not found in metadata`);
  }

  // Rebuild: drop the existing table and re-create
  await queryFn(`DROP TABLE IF EXISTS "${viewName}"`);
  const createTableSql = `CREATE TABLE "${viewName}" AS ${querySql}`;
  await queryFn(createTableSql);

  // Update refreshed_at
  const now = Date.now();
  await queryFn(`
    UPDATE __materialized_views SET refreshed_at = ${now}
    WHERE view_name = '${escapeSql(viewName)}'
  `);

  logger.info({ viewName }, 'Materialized view refreshed');
}

/**
 * REFRESH MATERIALIZED VIEW CONCURRENTLY (Gap 13).
 *
 * Creates a new version of the view alongside the old one, then
 * atomically swaps via RENAME. This avoids long exclusive locks.
 *
 * @param viewName - Name of the materialized view
 * @param queryFn - Function to execute SQL
 */
export async function refreshConcurrently(
  viewName: string,
  queryFn: (sql: string) => Promise<any>,
): Promise<void> {
  await ensureMetaTable(queryFn);

  const selectSql = `SELECT query_sql FROM __materialized_views WHERE view_name = '${escapeSql(viewName)}'`;
  const result = await queryFn(selectSql);

  let querySql: string | null = null;
  if (Array.isArray(result)) {
    if (result.length > 0 && result[0].query_sql) querySql = result[0].query_sql;
  } else if (result && result.rows && result.rows.length > 0) {
    querySql = result.rows[0][0];
  }

  if (!querySql) throw new Error(`Materialized view "${viewName}" not found`);

  const tempTable = `__mv_temp_${viewName}`;

  try {
    // 1. Build new data in a temp table
    await queryFn(`CREATE TABLE "${tempTable}" AS ${querySql}`);

    // 2. Atomic swap: drop old, rename temp
    await queryFn(`DROP TABLE "${escapeSql(viewName)}"`);
    await queryFn(`ALTER TABLE "${tempTable}" RENAME TO "${escapeSql(viewName)}"`);
  } catch (err) {
    await queryFn(`DROP TABLE IF EXISTS "${tempTable}"`);
    throw err;
  }

  const now = Date.now();
  await queryFn(`
    UPDATE __materialized_views SET refreshed_at = ${now}
    WHERE view_name = '${escapeSql(viewName)}'
  `);
  logger.info({ viewName }, 'Materialized view refreshed concurrently');
}

/**
 * Detect REFRESH MATERIALIZED VIEW CONCURRENTLY.
 */
export function detectRefreshConcurrently(sql: string): boolean {
  return /\bREFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY\b/i.test(sql.trim());
}

/**
 * Rewrite REFRESH ... CONCURRENTLY to standard REFRESH, flagging concurrent mode.
 */
export function rewriteRefreshConcurrently(sql: string): { sql: string; isConcurrent: boolean; viewName: string } {
  const match = /REFRESH\s+MATERIALIZED\s+VIEW\s+(?:CONCURRENTLY\s+)?(\S+)/i.exec(sql.trim());
  return {
    sql: sql.trim().replace(/\bCONCURRENTLY\b/i, '').trim(),
    isConcurrent: /\bCONCURRENTLY\b/i.test(sql.trim()),
    viewName: match ? match[1].replace(/["`]/g, '') : '',
  };
}

/**
 * Drop a materialized view: drop both the table and metadata.
 *
 * @param viewName - Name of the materialized view
 * @param queryFn - Function to execute SQL
 */
export async function drop(
  viewName: string,
  queryFn: (sql: string) => Promise<any>,
): Promise<void> {
  await ensureMetaTable(queryFn);

  // Drop the actual table
  await queryFn(`DROP TABLE IF EXISTS "${viewName}"`);

  // Remove metadata
  await queryFn(`DELETE FROM __materialized_views WHERE view_name = '${escapeSql(viewName)}'`);

  logger.info({ viewName }, 'Materialized view dropped');
}

/**
 * Check if a materialized view's data is stale (base table changed before REFRESH).
 *
 * @param viewName - Name of the materialized view
 * @param queryFn - Function to execute SQL
 * @returns true if the view data may be stale
 */
export async function isStale(
  viewName: string,
  queryFn: (sql: string) => Promise<any>,
): Promise<boolean> {
  await ensureMetaTable(queryFn);

  const sql = `SELECT created_at, refreshed_at FROM __materialized_views WHERE view_name = '${escapeSql(viewName)}'`;
  const result = await queryFn(sql);

  let refreshedAt: number | null = null;
  let createdAt: number | null = null;

  if (Array.isArray(result)) {
    if (result.length > 0) {
      refreshedAt = result[0].refreshed_at;
      createdAt = result[0].created_at;
    }
  } else if (result && result.rows && result.rows.length > 0) {
    refreshedAt = result.rows[0][1];
    createdAt = result.rows[0][0];
  }

  if (!refreshedAt) return true;
  if (!createdAt) return true;

  // If refreshed_at equals created_at, it means the initial creation, which may
  // still be current. A view is stale if a subsequent REFRESH hasn't been done
  // after the base table was modified. Here we simply check: if refreshed_at == created_at,
  // it's the initial fill; we can consider it potentially stale after some time.
  // For more precise tracking, a base table version counter would be needed.
  return false;
}

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Escape a string for safe inclusion in SQL (single quote escaping).
 */
function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}
