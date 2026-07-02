/**
 * VectorIndexShim — Translates PG vector index DDL (`CREATE INDEX … USING HNSW|IVFPQ`)
 * into SQLite-compatible equivalents.
 *
 * SQLite has no native HNSW or IVFPQ index type. These vector indexes must be
 * managed through VectorEngine (hnswlib-node or pure-JS IVFPQ) rather than the
 * SQL storage engine. This shim makes the DDL succeed without error by rewriting
 * the statement to a SQLite-compatible no-op (comment) when the index type is
 * HNSW or IVFPQ.
 *
 * Strategy:
 *   `CREATE INDEX i ON t USING HNSW (embedding) WITH (metric = l2sq)` → no-op
 *   `CREATE INDEX i ON t USING IVFPQ (embedding) WITH (K=64, M=8)`  → no-op
 *
 * The VectorEngine is responsible for actually building and managing the index
 * based on configuration (mode: 'hnsw' | 'ivfpq').
 *
 * @module VectorIndexShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('VectorIndexShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface VectorIndexResult {
  /** Rewritten SQL string (empty no-op comment, or original if not a vector index) */
  sql: string;
  /** Whether a vector index type (HNSW/IVFPQ) was detected */
  rewritten: boolean;
  /** Parsed metadata (if rewritten), undefined otherwise */
  meta?: {
    indexName: string;
    tableName: string;
    columnName: string;
    indexType: 'hnsw' | 'ivfpq';
    metric?: string;
    params: Record<string, string>;
  };
}

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/**
 * Pattern to detect vector index type clauses in CREATE INDEX.
 * Captures:
 *   - index name
 *   - table name (with optional schema)
 *   - column name (inside parens)
 *   - index type (HNSW or IVFPQ)
 *   - WITH clause parameters
 */
const VECTOR_INDEX_PATTERN =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)\s+ON\s+(?:(\w+)\.)?(\w+)\s+USING\s+(HNSW|IVFPQ)\s*\((\w+)\)(?:\s+WITH\s*\((.+)\))?/i;

// ──────────────────────────────────────────────
//  Detection & Rewriting
// ──────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains a vector index DDL.
 *
 * @param sql  The raw SQL string to inspect
 * @returns    `true` if the statement is a vector index creation
 */
export function detectVectorIndex(sql: string): boolean {
  return VECTOR_INDEX_PATTERN.test(sql.trim());
}

/**
 * Rewrite a vector index DDL to a SQLite-compatible no-op comment.
 *
 * The caller (QueryRouter) should NOT execute the returned SQL on SQLite;
 * instead, it should return success to the user and delegate index
 * management to VectorEngine.
 *
 * @param sql  The raw SQL string to rewrite
 * @returns    A `VectorIndexResult` with a no-op SQL comment and metadata
 */
export function rewriteVectorIndex(sql: string): VectorIndexResult {
  const trimmed = sql.trim();
  const match = trimmed.match(VECTOR_INDEX_PATTERN);

  if (!match) {
    return { sql: trimmed, rewritten: false };
  }

  const schema = match[1] || match[3];
  const indexName = match[2];
  const tableName = match[4];
  const indexType = match[5].toLowerCase() as 'hnsw' | 'ivfpq';
  const columnName = match[6];
  const withClause = match[7];

  // Parse WITH params
  const params: Record<string, string> = {};
  if (withClause) {
    for (const pair of withClause.split(',')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const key = pair.slice(0, eqIdx).trim().toLowerCase();
        const val = pair.slice(eqIdx + 1).trim();
        params[key] = val;
      }
    }
  }

  const qualTable = schema ? `${schema}.${tableName}` : tableName;

  logger.info(
    `[VectorIndexShim] Intercepted ${indexType.toUpperCase()} index creation: ` +
    `"${indexName}" ON "${qualTable}" ("${columnName}") ` +
    (withClause ? `WITH (${withClause}) ` : '') +
    `— converted to no-op (delegated to VectorEngine)`
  );

  // Normalise metric: 'cosine' → 'ip' (HNSW uses IP for cosine with normalized vectors)
  // 'l2sq' → 'l2' (HNSW uses 'l2' internally)
  const rawMetric = (params.metric || params.distance || 'l2sq').toLowerCase();
  const metric = rawMetric === 'l2sq' ? 'l2' : rawMetric;

  return {
    sql: `-- Vector index "${indexName}" ON ${qualTable} (${indexType}, column=${columnName}) — managed by VectorEngine`,
    rewritten: true,
    meta: {
      indexName,
      tableName: qualTable,
      columnName,
      indexType,
      metric,
      params,
    },
  };
}
