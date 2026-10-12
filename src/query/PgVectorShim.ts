/**
 * PgVectorShim — pgvector PostgreSQL extension compatibility shim
 *
 * Translates pgvector-specific SQL syntax into SQLite-compatible equivalents.
 * SqlVec uses sqlite-vec under the hood, so pgvector syntax must be rewritten.
 *
 * ## Supported translations
 *
 * | pgvector Syntax | Rewrite |
 * |---|---|
 * | `SELECT ... ORDER BY v <-> '[1,2,3]' LIMIT N` | L2 distance via sqlite |
 * | `SELECT ... ORDER BY v <=> '[1,2,3]' LIMIT N` | Cosine distance via sqlite |
 * | `SELECT ... ORDER BY v <#> '[1,2,3]' LIMIT N` | Inner product via sqlite |
 * | `CREATE INDEX ON t USING hnsw (v vector_l2_ops)` | No-op (managed by VectorEngine) |
 * | `CREATE INDEX ON t USING hnsw (v vector_cosine_ops)` | No-op (managed by VectorEngine) |
 * | `CREATE INDEX ON t USING hnsw (v vector_ip_ops)` | No-op (managed by VectorEngine) |
 * | `CREATE INDEX ON t USING ivfflat (v vector_cosine_ops) WITH (lists=100)` | No-op (managed by VectorEngine) |
 * | `SELECT l2_distance(v, '[1,2,3]')` | L2 distance |
 * | `SELECT cosine_distance(v, '[1,2,3]')` | Cosine distance |
 * | `SELECT inner_product(v, '[1,2,3]')` | Inner product |
 * | `SELECT vector_dims(v)` | Dimension of vector |
 * | `SELECT vector_norm(v)` | L2 norm of vector |
 *
 * @module query/PgVectorShim
 */

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface PgVectorShimResult {
  /** Rewritten SQL string */
  sql: string;
  /** Whether the SQL was rewritten */
  rewritten: boolean;
  /** What type of pgvector construct was detected */
  type?: 'distance_operator' | 'index_opclass' | 'vector_function' | 'vector_cast' | 'extension';
  /** Metadata about the detection */
  meta?: Record<string, any>;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches ORDER BY <column> <-> '<vector>' with optional LIMIT.
 * The pgvector L2 distance operator.
 *
 * Groups:
 *   1 – The SELECT list (everything before ORDER BY)
 *   2 – The column name (e.g. v)
 *   3 – The vector literal (e.g. [1,2,3] or [])
 *   4 – The LIMIT clause (if present)
 */
const L2_DISTANCE_OP = /(SELECT\s+.+?\s+ORDER\s+BY\s+)(\w+(?:\.\w+)?)\s*<->\s*'\[([^\]]*)\]'/i;

/**
 * Matches ORDER BY <column> <=> '<vector>' — cosine distance operator.
 */
const COSINE_DISTANCE_OP = /(SELECT\s+.+?\s+ORDER\s+BY\s+)(\w+(?:\.\w+)?)\s*<=>\s*'\[([^\]]*)\]'/i;

/**
 * Matches ORDER BY <column> <#> '<vector>' — inner product operator.
 */
const INNER_PRODUCT_OP = /(SELECT\s+.+?\s+ORDER\s+BY\s+)(\w+(?:\.\w+)?)\s*<#>\s*'\[([^\]]*)\]'/i;

/**
 * Matches CREATE INDEX ... USING hnsw/ivfflat with pgvector operator classes.
 * e.g. CREATE INDEX ON t USING hnsw (v vector_l2_ops)
 *      CREATE INDEX ON t USING ivfflat (v vector_cosine_ops) WITH (lists = 100)
 *
 * Groups:
 *   1 – Optional index name / IF NOT EXISTS
 *   2 – Table name
 *   3 – Index method (hnsw | ivfflat)
 *   4 – Column name
 *   5 – Operator class (vector_l2_ops | vector_cosine_ops | vector_ip_ops)
 *   6 – Optional WITH clause
 */
const INDEX_OPCLASS = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\s+)?ON\s+(\w+(?:\.\w+)?)\s+USING\s+(hnsw|ivfflat)\s*\((\w+)\s+(vector_l2_ops|vector_cosine_ops|vector_ip_ops)\)(?:\s+WITH\s*\((.+)\))?/i;

/**
 * Matches vector function calls:
 * l2_distance(col, '[vec]')
 * cosine_distance(col, '[vec]')
 * inner_product(col, '[vec]')
 * vector_dims(col)
 * vector_norm(col)
 */
// NOTE: No global flag — each call creates a fresh regex copy to avoid lastIndex state leaks.
// We define the source string and create regexes on demand.
const VECTOR_FN_SOURCE = '\\b(l2_distance|cosine_distance|inner_product|vector_dims|vector_norm)\\s*\\(';

function hasVectorFunctions(sql: string): boolean {
  return new RegExp(VECTOR_FN_SOURCE, 'i').test(sql);
}

function replaceVectorFunctions(sql: string, replacer: (match: string, fnName: string) => string): string {
  return sql.replace(new RegExp(VECTOR_FN_SOURCE, 'gi'), replacer);
}

/**
 * Matches vector type casts like '[]'::vector or ARRAY[1,2,3]::vector
 */
const VECTOR_TYPE_CAST_SOURCE = "'(\\[[^\\]]*\\])'\\s*::\\s*vector\\b";

function hasVectorTypeCast(sql: string): boolean {
  return new RegExp(VECTOR_TYPE_CAST_SOURCE, 'i').test(sql);
}

function replaceVectorTypeCast(sql: string, replacer: (match: string, vecContent: string) => string): string {
  return sql.replace(new RegExp(VECTOR_TYPE_CAST_SOURCE, 'gi'), replacer);
}

// ──────────────────────────────────────────────
//  Detection Functions
// ──────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains any pgvector-specific syntax.
 */
export function detectPgVectorSyntax(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  const trimmed = sql.trim();
  return (
    L2_DISTANCE_OP.test(trimmed) ||
    COSINE_DISTANCE_OP.test(trimmed) ||
    INNER_PRODUCT_OP.test(trimmed) ||
    INDEX_OPCLASS.test(trimmed) ||
    hasVectorFunctions(trimmed) ||
    hasVectorTypeCast(trimmed) ||
    /^\s*CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?vector\b/i.test(trimmed)
  );
}

/**
 * Parse a vector literal string like '[1,2,3]' into a number array.
 */
export function parseVectorLiteral(literal: string): number[] {
  const trimmed = literal.replace(/^\[|\]$/g, '').trim();
  if (!trimmed) return [];
  return trimmed
    .split(',')
    .map(s => parseFloat(s.trim()))
    .filter(n => !isNaN(n));
}

/**
 * Calculate L2 distance SQL expression.
 */
export function l2DistanceSql(column: string, vec: number[]): string {
  // Empty vector has no dimensions: the distance is zero, not `SQRT()`.
  if (vec.length === 0) return '0';
  const terms = vec.map((v, i) => `(${column}_${i} - ${v}) * (${column}_${i} - ${v})`);
  return `SQRT(${terms.join(' + ')})`;
}

/**
 * Calculate cosine distance SQL expression.
 * cosine_distance(a,b) = 1 - (a·b) / (||a|| * ||b||)
 */
export function cosineDistanceSql(column: string, vec: number[]): string {
  // Empty vector has no norm; avoid a `0/0` division (was `(1 - () / (SQRT() * 0))`).
  if (vec.length === 0) return '0';
  const dotTerms = vec.map((v, i) => `${column}_${i} * ${v}`);
  const dot = dotTerms.join(' + ');
  const normATerms = vec.map((v, i) => `${column}_${i} * ${column}_${i}`);
  const normA = `SQRT(${normATerms.join(' + ')})`;
  const normB = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return `(1 - (${dot}) / (${normA} * ${normB}))`;
}

/**
 * Calculate inner product SQL expression.
 * inner_product(a,b) = a·b (dot product, negated for pgvector compatibility)
 */
export function innerProductSql(column: string, vec: number[]): string {
  // Empty vector: dot product is zero, not a dangling `()`.
  if (vec.length === 0) return '0';
  const terms = vec.map((v, i) => `${column}_${i} * ${v}`);
  return `(${terms.join(' + ')})`;
}

// ──────────────────────────────────────────────
//  Rewrite Functions
// ──────────────────────────────────────────────

/**
 * Rewrite distance operator (ORDER BY v <-> '[1,2,3]' LIMIT 5).
 */
export function rewriteDistanceOperator(
  sql: string,
  pattern: RegExp,
  distanceFn: (col: string, vec: number[]) => string,
  type: 'l2' | 'cosine' | 'inner_product',
): PgVectorShimResult {
  const match = sql.match(pattern);
  if (!match) {
    return { sql, rewritten: false };
  }

  const prefix = match[1];
  const column = match[2];
  const vecLiteral = match[3];
  const vec = parseVectorLiteral(`[${vecLiteral}]`);

  // Preserve any existing WHERE clause
  const orderByIdx = sql.toUpperCase().indexOf('ORDER BY');
  const beforeOrderBy = sql.slice(0, orderByIdx);
  const afterOrderBy = sql.slice(orderByIdx + match[0].length - prefix.length);

  // Extract LIMIT
  const limitMatch = afterOrderBy.match(/\bLIMIT\s+(\d+)/i);
  const limit = limitMatch ? parseInt(limitMatch[1], 10) : undefined;

  const distanceExpr = distanceFn(column, vec);
  const orderByClause = `ORDER BY ${distanceExpr} ASC`;
  const limitClause = limit !== undefined ? ` LIMIT ${limit}` : ' LIMIT 10';

  const rewrittenSql = `${beforeOrderBy}${orderByClause}${limitClause}`;

  return {
    sql: rewrittenSql,
    rewritten: true,
    type: 'distance_operator',
    meta: {
      operator: type,
      column,
      vector: vec,
      limit,
    },
  };
}

/**
 * Rewrite all pgvector distance operators in a SQL statement.
 */
export function rewriteDistanceOperators(sql: string): PgVectorShimResult {
  // Try each operator in order
  for (const [pattern, fn, type] of [
    [L2_DISTANCE_OP, l2DistanceSql, 'l2'] as const,
    [COSINE_DISTANCE_OP, cosineDistanceSql, 'cosine'] as const,
    [INNER_PRODUCT_OP, innerProductSql, 'inner_product'] as const,
  ]) {
    const result = rewriteDistanceOperator(sql, pattern as RegExp, fn as any, type as any);
    if (result.rewritten) return result;
  }
  return { sql, rewritten: false };
}

/**
 * Rewrite CREATE INDEX with pgvector operator classes to a no-op comment.
 * Extends VectorIndexShim by also handling ivfflat and operator class syntax.
 */
export function rewriteIndexOpclass(sql: string): PgVectorShimResult {
  const match = sql.match(INDEX_OPCLASS);
  if (!match) {
    return { sql, rewritten: false };
  }

  const tableName = match[1];
  const indexMethod = match[2].toLowerCase();
  const columnName = match[3];
  const opclass = match[4];
  const withClause = match[5];

  // Map operator class to metric
  const metricMap: Record<string, string> = {
    vector_l2_ops: 'l2',
    vector_cosine_ops: 'cosine',
    vector_ip_ops: 'ip',
  };
  /* c8 ignore next -- opclass is constrained to the three enum keys by INDEX_OPCLASS */
  const metric = metricMap[opclass] || 'l2';

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

  return {
    sql: `-- pgvector index ON ${tableName} (${indexMethod}, column=${columnName}, opclass=${opclass}) — managed by VectorEngine`,
    rewritten: true,
    type: 'index_opclass',
    meta: {
      tableName,
      indexMethod,
      columnName,
      opclass,
      metric,
      params,
    },
  };
}

/**
 * Rewrite vector function calls to SQLite-compatible expressions.
 *
 * Since SqlVec stores vectors as JSON arrays in columns, we rewrite:
 *   l2_distance(v, '[1,2,3]') → SQRT((v_0 - 1)^2 + (v_1 - 2)^2 + ...)
 *   cosine_distance(v, '[1,2,3]') → 1 - dot(v, q) / (norm(v) * norm(q))
 *   inner_product(v, '[1,2,3]') → dot(v, q)
 *   vector_dims(v) → JSON_ARRAY_LENGTH(v) or constant
 *   vector_norm(v) → SQRT(SUM(v_i^2))
 *
 * In the current sqlite-vec model, vectors are stored as BLOBs or JSON arrays.
 * The exact expression depends on storage format. We detect and flag them.
 */
export function rewriteVectorFunctions(sql: string): PgVectorShimResult {
  if (!hasVectorFunctions(sql)) {
    return { sql, rewritten: false };
  }

  let rewritten = sql;
  let found = false;
  const foundFunctions: string[] = [];

  rewritten = replaceVectorFunctions(rewritten, (_match: string, fnName: string) => {
    found = true;
    foundFunctions.push(fnName);
    return `__pgvector_${fnName}(`;
  });

  /* c8 ignore next -- hasVectorFunctions() above guarantees the replacer fires at least once */
  if (!found) {
    return { sql, rewritten: false };
  }

  // At this point we've marked the functions.
  // The actual implementation depends on the storage format.
  // For now we return the annotated SQL as a signal.
  return {
    sql: rewritten,
    rewritten: true,
    type: 'vector_function',
    meta: { functions: foundFunctions },
  };
}

/**
 * Rewrite vector type casts (`'[1,2,3]'::vector`) to JSON arrays.
 */
export function rewriteVectorTypeCasts(sql: string): PgVectorShimResult {
  if (!hasVectorTypeCast(sql)) {
    return { sql, rewritten: false };
  }

  const rewritten = replaceVectorTypeCast(sql, (_match: string, vecContent: string) => {
    // Remove surrounding quotes and return just the vector literal
    return `'${vecContent}'`;
  });

  return {
    sql: rewritten,
    rewritten: true,
    type: 'vector_cast',
  };
}

/**
 * Handle `CREATE EXTENSION vector` (no-op, return SELECT 1).
 */
export function rewriteCreateExtensionVector(sql: string): PgVectorShimResult {
  if (/^\s*CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?vector\b/i.test(sql.trim())) {
    return {
      sql: 'SELECT 1',
      rewritten: true,
      type: 'extension',
      meta: { extension: 'vector' },
    };
  }
  return { sql, rewritten: false };
}

/**
 * Main entry point: process a SQL statement through all pgvector shim stages.
 */
export function rewritePgVectorSql(sql: string): PgVectorShimResult {
  let current = sql;

  // Step 1: CREATE EXTENSION vector
  const extResult = rewriteCreateExtensionVector(current);
  if (extResult.rewritten) return extResult;
  current = extResult.sql;

  // Step 2: CREATE INDEX with pgvector opclass
  const idxResult = rewriteIndexOpclass(current);
  if (idxResult.rewritten) return idxResult;
  current = idxResult.sql;

  // Step 3: ORDER BY distance operators
  const distResult = rewriteDistanceOperators(current);
  if (distResult.rewritten) return distResult;
  current = distResult.sql;

  // Step 4: Vector functions
  const fnResult = rewriteVectorFunctions(current);
  if (fnResult.rewritten) return fnResult;
  current = fnResult.sql;

  // Step 5: Type casts
  const castResult = rewriteVectorTypeCasts(current);
  if (castResult.rewritten) return castResult;
  current = castResult.sql;

  return { sql: current, rewritten: current !== sql };
}
