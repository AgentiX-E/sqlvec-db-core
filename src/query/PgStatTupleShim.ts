/**
 * PgStatTupleShim — pgstattuple extension compatibility shim for sqlvec-db.
 *
 * PostgreSQL's pgstattuple extension provides functions that return
 * tuple-level table and index statistics. These are used by monitoring
 * tools, migration tooling, and health checkers to inspect table
 * bloat and dead tuple ratios.
 *
 * Since sqlvec-db delegates to SQLite (which is append-only and
 * has no dead tuples), all values are approximated from the
 * PgStatCollector's table/index stats or returned as sensible mocks.
 *
 * ## Functions provided
 *
 *   pgstattuple(regclass)      → record  — Full table-level stats
 *   pgstatindex(regclass)      → record  — B-tree index stats
 *   pg_relpages(regclass)      → bigint  — Page count for a relation
 *   pgstattuple_approx(regclass)→ record — Approximate tuple stats (no full scan)
 *   pgstatginindex(regclass)   → record  — GIN index stats
 *
 * ## Usage
 *
 *   SELECT * FROM pgstattuple('my_table');
 *   SELECT * FROM pgstatindex('my_idx');
 *   SELECT pg_relpages('my_table');
 *
 * @module query/PgStatTupleShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('pg-stat-tuple');

// ── Constants ────────────────────────────────────────────────────

/** Default PostgreSQL block/page size */
export const DEFAULT_PAGE_SIZE = 8192;

/** Default rows per page approximation */
const DEFAULT_ROWS_PER_PAGE = 100;

/** Regex to detect pgstattuple extension function calls in SQL */
export const PG_STAT_TUPLE_FUNC_RE =
  /\b(pgstattuple|pgstatindex|pg_relpages|pgstattuple_approx|pgstatginindex)\s*\(/i;

// ── Types ────────────────────────────────────────────────────────

export interface PgStatTupleRow {
  table_len: number;
  tuple_count: number;
  tuple_len: number;
  tuple_percent: number;
  dead_tuple_count: number;
  dead_tuple_len: number;
  dead_tuple_percent: number;
  free_space: number;
  free_percent: number;
}

export interface PgStatIndexRow {
  version: number;
  tree_level: number;
  index_size: number;
  root_block_no: number;
  internal_pages: number;
  leaf_pages: number;
  empty_pages: number;
  deleted_pages: number;
  avg_leaf_density: number;
  leaf_fragmentation: number;
}

export interface PgStatGinIndexRow {
  version: number;
  pending_pages: number;
  pending_tuples: number;
}

export interface PgStatTupleApproxRow {
  table_len: number;
  scanned_percent: number;
  tuple_count: number;
  dead_tuple_count: number;
}

// ── PgStatTupleShim ──────────────────────────────────────────────

export class PgStatTupleShim {
  /**
   * pgstattuple(tableName: regclass) → record
   *
   * Returns tuple-level table statistics.
   * In SQLite/sqlvec-db, dead tuples do not exist (no MVCC),
   * so dead_tuple_count is always 0.
   *
   * @param tableName - Name of the table to inspect
   * @param statsCollector - Optional PgStatCollector instance for real stats
   * @returns PgStatTupleRow with approximate statistics
   */
  static pgstattuple(
    tableName: string,
    getTableStats: (name: string) => { rowCount: number; pageCount: number } | null = () => null,
  ): PgStatTupleRow {
    const tableStats = getTableStats(tableName);
    const rowCount = tableStats?.rowCount ?? 0;
    let pageCount = tableStats?.pageCount ?? 0;

    // Estimate page count from row count if no stats available
    if (pageCount <= 0) {
      pageCount = Math.max(1, Math.ceil(rowCount / DEFAULT_ROWS_PER_PAGE));
    }

    const tableLen = pageCount * DEFAULT_PAGE_SIZE;
    const tupleLen = rowCount * 128; // approximate: 128 bytes per tuple
    const freeSpace = tableLen - tupleLen;
    const tuplePercent = tableLen > 0
      ? Math.min(100, Math.max(0, (tupleLen / tableLen) * 100))
      : 0;
    const freePercent = Math.max(0, 100 - tuplePercent);

    return {
      table_len: tableLen,
      tuple_count: rowCount,
      tuple_len: tupleLen,
      tuple_percent: Math.round(tuplePercent * 100) / 100,
      dead_tuple_count: 0,
      dead_tuple_len: 0,
      dead_tuple_percent: 0,
      free_space: Math.max(0, freeSpace),
      free_percent: Math.round(freePercent * 100) / 100,
    };
  }

  /**
   * pgstatindex(indexName: regclass) → record
   *
   * Returns B-tree index statistics.
   * Since SQLite uses B-trees natively, we provide sensible mock values
   * based on the index size.
   *
   * @param indexName - Name of the index to inspect
   * @param getIndexStats - Optional function to get real index stats
   * @returns PgStatIndexRow with approximate statistics
   */
  static pgstatindex(
    indexName: string,
    getIndexStats: (name: string) => { rowCount: number; distinctKeys: number } | null = () => null,
  ): PgStatIndexRow {
    const idxStats = getIndexStats(indexName);
    const rowCount = idxStats?.rowCount ?? 1000;

    // Approximate number of leaf pages based on rows
    const leafPages = Math.max(1, Math.ceil(rowCount / DEFAULT_ROWS_PER_PAGE));
    const internalPages = Math.max(1, Math.ceil(leafPages / 100));
    const indexSize = DEFAULT_PAGE_SIZE * (leafPages + internalPages + 1); // +1 for root

    return {
      version: 4,
      tree_level: internalPages > 1 ? 2 : 1,
      index_size: indexSize,
      root_block_no: 0,
      internal_pages: internalPages,
      leaf_pages: leafPages,
      empty_pages: 0,
      deleted_pages: 0,
      avg_leaf_density: 100,
      leaf_fragmentation: 0,
    };
  }

  /**
   * pg_relpages(relation: regclass) → bigint
   *
   * Returns the number of pages in a relation.
   *
   * @param tableName - Name of the table
   * @param getTableStats - Optional function to get real table stats
   * @returns Page count
   */
  static pgRelpages(
    tableName: string,
    getTableStats: (name: string) => { rowCount: number; pageCount: number } | null = () => null,
  ): number {
    const tableStats = getTableStats(tableName);
    if (tableStats && tableStats.pageCount > 0) {
      return tableStats.pageCount;
    }
    // Fallback: guess from row count
    return Math.max(1, Math.ceil((tableStats?.rowCount ?? 0) / DEFAULT_ROWS_PER_PAGE));
  }

  /**
   * pgstattuple_approx(tableName: regclass) → record
   *
   * Approximate version of pgstattuple that avoids a full table scan.
   * In sqlvec-db this is identical to pgstattuple since we don't
   * actually scan pages.
   *
   * @param tableName - Name of the table to inspect
   * @param getTableStats - Optional function to get real table stats
   * @returns PgStatTupleApproxRow with approximate statistics
   */
  static pgstattupleApprox(
    tableName: string,
    getTableStats: (name: string) => { rowCount: number; pageCount: number } | null = () => null,
  ): PgStatTupleApproxRow {
    const tableStats = getTableStats(tableName);
    const rowCount = tableStats?.rowCount ?? 0;
    let pageCount = tableStats?.pageCount ?? 0;

    if (pageCount <= 0) {
      pageCount = Math.max(1, Math.ceil(rowCount / DEFAULT_ROWS_PER_PAGE));
    }

    return {
      table_len: pageCount * DEFAULT_PAGE_SIZE,
      scanned_percent: 100,
      tuple_count: rowCount,
      dead_tuple_count: 0,
    };
  }

  /**
   * pgstatginindex(indexName: regclass) → record
   *
   * Returns GIN index statistics.
   * Since SQLite doesn't have GIN indexes, returns mock values.
   *
   * @param indexName - Name of the GIN index
   * @returns PgStatGinIndexRow with approximate statistics
   */
  static pgstatginindex(
    indexName: string,
    getIndexStats: (name: string) => { rowCount: number } | null = () => null,
  ): PgStatGinIndexRow {
    const idxStats = getIndexStats(indexName);
    const pendingTuples = idxStats?.rowCount ?? 0;
    const pendingPages = Math.max(1, Math.ceil(pendingTuples / DEFAULT_ROWS_PER_PAGE));

    return {
      version: 1,
      pending_pages: pendingPages,
      pending_tuples: pendingTuples,
    };
  }

  /**
   * Detect whether a SQL string contains pgstattuple extension function calls.
   *
   * @param sql - SQL query to inspect
   * @returns true if any pgstattuple function is detected
   */
  static detect(sql: string): boolean {
    PG_STAT_TUPLE_FUNC_RE.lastIndex = 0;
    return PG_STAT_TUPLE_FUNC_RE.test(sql);
  }

  /**
   * Rewrite a pgstattuple function call into a SELECT that returns
   * compatible records. This takes a SQL like:
   *
   *   SELECT * FROM pgstattuple('my_table');
   *
   * And rewrites it so the SQLite executor can look up the function.
   *
   * @param sql - SQL query to rewrite
   * @param getTableStats - Function to get table stats
   * @param getIndexStats - Function to get index stats
   * @returns The result of the function call, or null if no match
   */
  static evaluate(
    sql: string,
    getTableStats: (name: string) => { rowCount: number; pageCount: number } | null = () => null,
    getIndexStats: (name: string) => { rowCount: number; distinctKeys: number } | null = () => null,
  ): any {
    const trimmed = sql.trim().replace(/;$/g, '');
    const lower = trimmed.toLowerCase();

    // Match: pgstattuple('/name/') OR pgstattuple('name')
    // Try to extract the table/index name from the function call
    const pgstattupleMatch = trimmed.match(/pgstattuple\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
    if (pgstattupleMatch) {
      return PgStatTupleShim.pgstattuple(pgstattupleMatch[1], getTableStats);
    }

    const pgstatindexMatch = trimmed.match(/pgstatindex\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
    if (pgstatindexMatch) {
      return PgStatTupleShim.pgstatindex(pgstatindexMatch[1], getIndexStats);
    }

    const pgRelpagesMatch = trimmed.match(/pg_relpages\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
    if (pgRelpagesMatch) {
      return PgStatTupleShim.pgRelpages(pgRelpagesMatch[1], getTableStats);
    }

    const pgstattupleApproxMatch = trimmed.match(/pgstattuple_approx\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
    if (pgstattupleApproxMatch) {
      return PgStatTupleShim.pgstattupleApprox(pgstattupleApproxMatch[1], getTableStats);
    }

    const pgstatginindexMatch = trimmed.match(/pgstatginindex\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
    if (pgstatginindexMatch) {
      return PgStatTupleShim.pgstatginindex(pgstatginindexMatch[1], getIndexStats);
    }

    return null;
  }
}

// ── Catalog registration ─────────────────────────────────────────

/**
 * Metadata for each pgstattuple function for pg_proc catalog registration.
 */
export interface FunctionMeta {
  /** Function name as exposed to SQL */
  name: string;
  /** Argument count (0 = variadic) */
  argCount: number;
  /** Comma-separated argument types */
  argTypes: string;
  /** Return type */
  returnType: string;
  /** Brief description */
  description: string;
}

/**
 * Full list of pgstattuple extension functions with metadata.
 * Can be registered in pg_proc so they appear in `SELECT * FROM pg_proc`.
 */
export const PG_STAT_TUPLE_FUNCTIONS: FunctionMeta[] = [
  {
    name: 'pgstattuple',
    argCount: 1,
    argTypes: 'regclass',
    returnType: 'record',
    description: 'Get tuple-level statistics for a table',
  },
  {
    name: 'pgstatindex',
    argCount: 1,
    argTypes: 'regclass',
    returnType: 'record',
    description: 'Get B-tree index statistics',
  },
  {
    name: 'pg_relpages',
    argCount: 1,
    argTypes: 'regclass',
    returnType: 'bigint',
    description: 'Get number of pages in a relation',
  },
  {
    name: 'pgstattuple_approx',
    argCount: 1,
    argTypes: 'regclass',
    returnType: 'record',
    description: 'Get approximate table statistics (no full scan)',
  },
  {
    name: 'pgstatginindex',
    argCount: 1,
    argTypes: 'regclass',
    returnType: 'record',
    description: 'Get GIN index statistics',
  },
];

/**
 * Convenience object mapping function name → PgStatTupleShim static method.
 * Useful for dynamic dispatch when intercepting SQL function calls.
 */
export const PG_STAT_TUPLE_FN_MAP: Record<string, (...args: any[]) => any> = {
  pgstattuple: PgStatTupleShim.pgstattuple,
  pgstatindex: PgStatTupleShim.pgstatindex,
  pg_relpages: PgStatTupleShim.pgRelpages,
  pgstattuple_approx: PgStatTupleShim.pgstattupleApprox,
  pgstatginindex: PgStatTupleShim.pgstatginindex,
};

/**
 * Detect whether a SQL string contains pgstattuple function calls.
 *
 * @param sql - SQL query to inspect
 * @returns true if any pgstattuple function is detected
 */
export function detectPgStatTupleFunction(sql: string): boolean {
  return PgStatTupleShim.detect(sql);
}
