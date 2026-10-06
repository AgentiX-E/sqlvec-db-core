/**
 * ExpressionIndexEnhancer — Enhanced expression index support for the query layer.
 *
 * Extends the basic ExpressionIndexRewriter with support for additional
 * expression types commonly used in PostgreSQL expression indexes that
 * are also compatible with SQLite.
 *
 * ## Enhanced expression types
 *
 * | Type                  | Example                                      | SQLite Compatible |
 * |-----------------------|----------------------------------------------|-------------------|
 * | Function calls        | `CREATE INDEX ON t (lower(name))`            | Yes               |
 * | Type casts            | `CREATE INDEX ON t ((col::text))`            | Yes (stripped)    |
 * | JSON access           | `CREATE INDEX ON t ((data->>'key'))`         | Yes (rewritten)   |
 * | Arithmetic            | `CREATE INDEX ON t ((price * qty))`          | Yes               |
 * | Conditional (CASE)    | `CREATE INDEX ON t ((CASE WHEN ... END))`    | Yes               |
 * | Subquery expressions  | `CREATE INDEX ON t (((SELECT ...)))`         | Limited           |
 * | Concatenation         | `CREATE INDEX ON t ((first_name || ' ' || last_name))` | Yes    |
 *
 * ## Integration
 *
 * This enhancer works alongside ExpressionIndexRewriter by:
 * 1. Detecting enhanced expression patterns in CREATE INDEX statements.
 * 2. Rewriting PG-specific syntax to SQLite-compatible forms.
 * 3. Preserving SQLite-native expression patterns.
 *
 * @module index/ExpressionIndexEnhancer
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('ExprIdxEnhancer');

// ── Types ────────────────────────────────────────────────────────

export interface ExprIndexEnhancementResult {
  sql: string;
  enhanced: boolean;
  expressionType: string;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * PostgreSQL type cast patterns: ::type, ::TYPE[], ::schema.type
 */
const PG_TYPE_CAST_RE = /::\w+(?:\s*\[\])?(?:::pg_catalog\.\w+)?/g;

/**
 * PostgreSQL JSON access operators to detect.
 * ->    Returns JSON (json expression)
 * ->>   Returns text (text expression)
 * #>    Path access (json)
 * #>>   Path access (text)
 * @>    Contains (used in GIN indexes)
 * ?     Exists (used in GIN indexes)
 */
const PG_JSON_OP_RE = /->>?|#>[:>]|@>|\?/;

/**
 * PostgreSQL string concatenation operator (||).
 * In PostgreSQL, || is concatenation (not OR logic).
 * In SQLite, || is also concatenation — but it's also a valid
 * expression in CREATE INDEX, so we can pass it through.
 */
const PG_CONCAT_RE = /\|\|/;

/**
 * PostgreSQL subquery pattern: (SELECT ...) inside expression index.
 * SQLite supports expression indexes with scalar subqueries when
 * they have proper syntax.
 */
const SUBQUERY_RE = /\(\s*SELECT\s/i;

/**
 * CASE expression pattern.
 */
const CASE_EXPR_RE = /\bCASE\s+WHEN\b/i;

/**
 * COALESCE / NULLIF function patterns.
 */
const COALESCE_RE = /\bCOALESCE\s*\(/i;
const NULLIF_RE = /\bNULLIF\s*\(/i;

// ── Helper: Detect expression index types ────────────────────────

export type ExpressionIndexType =
  | 'function'
  | 'cast'
  | 'json'
  | 'arithmetic'
  | 'case'
  | 'subquery'
  | 'concat'
  | 'coalesce'
  | 'unknown';

/**
 * Detect what type of expression is used in a CREATE INDEX statement.
 */
export function detectExpressionType(sql: string): ExpressionIndexType {
  // Extract the column expression part from CREATE INDEX ON t (...)
  const match = sql.match(/\((.+)\)\s*(?:;|\s*$)/s);
  if (!match) return 'unknown';

  const expr = match[1].trim();

  // Remove outer double parens if present for PG expression syntax
  const inner = expr.startsWith('(') && expr.endsWith(')')
    ? expr.slice(1, -1).trim()
    : expr;

  // Priority order: most specific pattern first, generic function/arithmetic
  // as fallbacks.
  if (SUBQUERY_RE.test(inner)) return 'subquery';
  if (CASE_EXPR_RE.test(inner)) return 'case';
  if (COALESCE_RE.test(inner) || NULLIF_RE.test(inner)) return 'coalesce';
  if (PG_TYPE_CAST_RE.test(inner)) return 'cast';
  if (PG_JSON_OP_RE.test(inner)) return 'json';
  if (PG_CONCAT_RE.test(inner)) return 'concat';
  if (/[a-zA-Z_]\w*\s*\(/.test(inner)) return 'function';
  if (/[+\-*/%]/.test(inner)) return 'arithmetic';

  return 'unknown';
}

/**
 * Detect whether a SQL statement contains an expression index with
 * enhanced expression types.
 */
export function detectEnhancedExpressionIndex(sql: string): boolean {
  const type = detectExpressionType(sql);
  return type !== 'unknown';
}

// ── Type Cast Rewriting ─────────────────────────────────────────

/**
 * Rewrite PostgreSQL type casts (::type) to SQLite-compatible function calls.
 *
 * | PG Expression            | Rewritten                       |
 * |--------------------------|---------------------------------|
 * | col::text                | col                             |
 * | (col::text)              | (col)                           |
 * | (col::integer)           | (CAST(col AS INTEGER))          |
 * | (amount::numeric(10,2))  | (CAST(amount AS NUMERIC))       |
 *
 * For expression indexes, SQLite may handle simple casts inline,
 * but we normalize them for consistency.
 */
export function rewriteTypeCast(expression: string): string {
  // Only rewrite the `col::type` cast itself; do NOT consume surrounding
  // parentheses, which may belong to the CREATE INDEX expression wrapper
  // (e.g. `CREATE INDEX ON t (col::text)`). Consuming them produced
  // syntactically broken output like `CREATE INDEX ON t col`.
  return expression.replace(
    /([\w.]+)\s*::\s*(\w+)(?:\([^)]*\))?/g,
    (match, column, type) => {
      const upperType = type.toUpperCase();
      // Simple aliases that SQLite handles natively
      if (upperType === 'TEXT' || upperType === 'VARCHAR') {
        return column;
      }
      // Numeric types
      if (['INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'REAL', 'FLOAT', 'DOUBLE', 'NUMERIC', 'DECIMAL'].includes(upperType)) {
        return `CAST(${column} AS ${upperType === 'FLOAT' || upperType === 'DOUBLE' ? 'REAL' : upperType === 'BIGINT' || upperType === 'SMALLINT' ? 'INTEGER' : upperType})`;
      }
      // Pass through unknown types
      return column;
    },
  );
}

// ── JSON Access Rewriting ──────────────────────────────────────

/**
 * Rewrite PostgreSQL JSON access operators to SQLite json_extract calls.
 *
 * | PG Expression            | Rewritten                            |
 * |--------------------------|--------------------------------------|
 * | data->'key'              | json_extract(data, '$.key')          |
 * | data->>'key'             | json_extract(data, '$.key')          |
 * | data#>'{path,to,val}'    | json_extract(data, '$.path.to.val')  |
 * | data#>>'{path,to,val}'   | json_extract(data, '$.path.to.val')  |
 */
export function rewriteJsonAccess(expression: string): string {
  let result = expression;

  // Rewrite data->>'key' and data->'key'
  result = result.replace(
    /(\w+)\s*->>\s*'([^']+)'/g,
    (_, column, key) => `json_extract(${column}, '$.${key}')`,
  );
  result = result.replace(
    /(\w+)\s*->\s*'([^']+)'/g,
    (_, column, key) => `json_extract(${column}, '$.${key}')`,
  );

  // Rewrite data#>>'{path}' style. The PG path is `{p1,p2,p3}`; the SQLite
  // json path is `$.p1.p2.p3`. The previous rewrite emitted `'$.' + 'p1.p2'`,
  // which uses `+` for string concatenation — invalid in SQLite (where `+` is
  // numeric addition). Emit a single path literal instead.
  result = result.replace(
    /(\w+)\s*#>>\s*'\{([^}]+)\}'/g,
    (_, column, path) => `json_extract(${column}, '$.${path.replace(/,/g, '.')}')`,
  );
  result = result.replace(
    /(\w+)\s*#>\s*'\{([^}]+)\}'/g,
    (_, column, path) => `json_extract(${column}, '$.${path.replace(/,/g, '.')}')`,
  );

  return result;
}

// ── Expression Index Validation ──────────────────────────────────

export interface ExprIndexValidationResult {
  /** Whether this expression index can be used in SQLite */
  compatible: boolean;
  /** Warnings about potential issues */
  warnings: string[];
  /** Recommended SQLite syntax */
  recommendedSQL?: string;
}

/**
 * Validate whether a PostgreSQL expression index would work in SQLite.
 */
export function validateExpressionIndexCompatibility(
  expression: string,
): ExprIndexValidationResult {
  const warnings: string[] = [];
  let compatible = true;

  // Check for subqueries
  if (SUBQUERY_RE.test(expression)) {
    warnings.push('Subqueries in expression indexes may have limited SQLite support');
    compatible = false;
  }

  // Check for specific functions
  const unsupportedFns = ['pg_catalog.', 'to_tsvector', 'to_tsquery', 'gin', 'gist'];
  for (const fn of unsupportedFns) {
    if (expression.toLowerCase().includes(fn)) {
      warnings.push(`PostgreSQL-specific function "${fn}" is not supported in SQLite`);
      compatible = false;
    }
  }

  // Check for specific operators
  const unsupportedOps = ['@@', '@@@', '%%%'];
  for (const op of unsupportedOps) {
    if (expression.includes(op)) {
      warnings.push(`PostgreSQL-specific operator "${op}" is not supported in SQLite`);
    }
  }

  return { compatible, warnings };
}

// ── Main Enhancement Function ────────────────────────────────────

/**
 * Enhance a CREATE INDEX statement with advanced expression support.
 *
 * Detects and rewrites:
 * 1. Function calls in expressions (pass-through to SQLite)
 * 2. Type cast expressions (::text → pass-through)
 * 3. JSON access expressions (->'key' → json_extract)
 * 4. CASE expressions (pass-through)
 * 5. Arithmetic expressions (pass-through)
 * 6. Concatenation expressions (pass-through)
 *
 * @param sql - The CREATE INDEX SQL statement
 * @returns Enhanced result with rewritten SQL and metadata
 */
export function enhanceExpressionIndex(sql: string): ExprIndexEnhancementResult {
  if (!sql.trim().toUpperCase().includes('CREATE INDEX')) {
    return { sql, enhanced: false, expressionType: 'unknown' };
  }

  const expressionType = detectExpressionType(sql);

  if (expressionType === 'unknown') {
    return { sql, enhanced: false, expressionType: 'unknown' };
  }

  let rewritten = sql;

  // Step 1: Rewrite JSON access operators
  if (expressionType === 'json') {
    rewritten = rewriteJsonAccess(rewritten);
  }

  // Step 2: Rewrite type casts
  if (expressionType === 'cast') {
    rewritten = rewriteTypeCast(rewritten);
  }

  // Step 3: Apply basic expression rewriting (unwrap PG double parens)
  rewritten = rewritten.replace(/\(\(([^)]+)\)\)/g, '($1)');

  // Check validation
  const exprMatch = rewritten.match(/\((.+)\)\s*(?:;|\s*$)/s);
  const validation = exprMatch
    ? validateExpressionIndexCompatibility(exprMatch[1])
    : { compatible: true, warnings: [] };

  logger.info(
    {
      expressionType,
      compatible: validation.compatible,
      warningsCount: validation.warnings.length,
      original: sql.substring(0, 100),
      rewritten: rewritten.substring(0, 100),
    },
    'Expression index enhanced',
  );

  return {
    sql: rewritten,
    enhanced: true,
    expressionType,
  };
}

/**
 * Process a full CREATE INDEX statement through the enhancement pipeline.
 *
 * Combines ExpressionIndexRewriter's double-paren unwrapping with the
 * enhanced expression type support from this module.
 *
 * @param sql - The raw CREATE INDEX statement (possibly PG-syntax)
 * @returns Enhanced SQL string
 */
export function processExpressionIndex(sql: string): string {
  const result = enhanceExpressionIndex(sql);
  return result.sql;
}
