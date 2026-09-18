/**
 * PostGISShim — PostgreSQL PostGIS spatial extension compatibility shim for SQLite.
 *
 * PostGIS adds spatial capabilities to PostgreSQL through hundreds of `ST_*`
 * functions (OGC Simple Features). SQLite has `spatialite` as an extension,
 * but it is not bundled. This shim provides basic compatibility by:
 *
 * - Replacing DDL-like spatial operations with `SELECT 1` (no-ops)
 * - Passthrough of geometry values for functions that return geometry
 * - Mock return values for analytic functions (distance, area, containment)
 *
 * ## Supported functions and rewrite strategy
 *
 * | Input                                    | Output             | Strategy    |
 * |------------------------------------------|--------------------|-------------|
 * | `ST_GeomFromText(wkt, srid)`             | `wkt`              | passthrough |
 * | `ST_AsText(geom)`                        | `geom`             | passthrough |
 * | `ST_AsGeoJSON(geom)`                     | `geom`             | passthrough |
 * | `ST_Distance(a, b)`                      | `0`                | mock        |
 * | `ST_Contains(a, b)`                      | `true`             | mock        |
 * | `ST_Intersects(a, b)`                    | `true`             | mock        |
 * | `ST_Area(geom)`                          | `0`                | mock        |
 * | `ST_Buffer(geom, dist)`                  | `geom`             | passthrough |
 * | `ST_Transform(geom, srid)`               | `geom`             | passthrough |
 * | `ST_SetSRID(geom, srid)`                 | `geom`             | passthrough |
 * | `ST_MakePoint(x, y)`                     | `''`               | passthrough |
 * | `CREATE SPATIAL INDEX ...`               | `SELECT 1`         | no-op       |
 * | `AddGeometryColumn(...)`                 | `SELECT 1`         | no-op       |
 * | Non-spatial SQL                          | (passthrough)      | —           |
 *
 * ## Edge-case handling
 *
 * - **Case-insensitive matching**: All `ST_` function names are matched
 *   case-insensitively.
 * - **Nested calls**: `ST_Distance(ST_Transform(a, 4326), ST_Transform(b, 4326))`
 *   is rewritten but the mocks are shallow — the inner function calls are
 *   not individually rewritten.
 * - **Argument variations**: Handles functions with 1, 2, or 3 arguments as
 *   appropriate.
 * - **Non-ST_ SQL**: Detection is fast — checks for the `ST_` prefix near
 *   known function names. False positives are avoided by scoping to known
 *   function names.
 *
 * ## Limitations
 *
 * - Regex-based rewriting does not parse full SQL grammar. Complex nested
 *   spatial expressions may produce syntactically valid but semantically
 *   incorrect SQL.
 * - All spatial predicates (Contains, Intersects) return `true` — this is
 *   safe for INSERT/DDL contexts but incorrect for spatial query filtering.
 * - Distance and area return `0` — unsuitable for any real spatial analysis.
 * - Geometry passthrough functions return the input expression as-is; no
 *   WKT/GeoJSON conversion is performed.
 *
 * @module PostGISShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('PostGISShim');

// ── Types ──────────────────────────────────────────────────────

export interface PostGISResult {
  /** Rewritten SQL (SELECT 1 for no-ops, mock values for analytic functions, original otherwise) */
  sql: string;
  /** Whether the statement was detected as a spatial operation and rewritten */
  rewritten: boolean;
  /** Human-readable label of the spatial operation category */
  category?: string;
}

// ── Constants — function families ──────────────────────────────

/**
 * Functions that should be rewritten to "0" (mock numeric result).
 */
const MOCK_NUMERIC_FUNCS = new Set([
  'st_distance', 'st_area', 'st_length', 'st_perimeter',
  'st_3ddistance', 'st_3darea', 'st_3dlength',
]);

/**
 * Functions that should be rewritten to "true" (mock boolean result).
 */
const MOCK_BOOL_FUNCS = new Set([
  'st_contains', 'st_intersects', 'st_within', 'st_dwithin',
  'st_touches', 'st_overlaps', 'st_crosses', 'st_disjoint',
  'st_equals', 'st_relate', 'st_3dintersects',
]);

/**
 * Functions that should pass through their first argument unchanged
 * (geometry passthrough — return the geometry input as-is).
 */
const PASSTHROUGH_GEOM_FUNCS = new Set([
  'st_astext', 'st_asewkt', 'st_asgeojson', 'st_ashexewkb',
  'st_asbinary', 'st_asgml', 'st_askml', 'st_assvg',
  'st_buffer', 'st_transform', 'st_setsrid',
  'st_simplify', 'st_union', 'st_intersection',
  'st_difference', 'st_symdifference', 'st_collect',
]);

/**
 * Functions that return WKT-like string passthrough (return the first
 * coordinate argument or the WKT argument as-is).
 */
const PASSTHROUGH_STRING_FUNCS = new Set([
  'st_geomfromtext', 'st_geomfromgeojson', 'st_geomfromwkb',
  'st_makepoint', 'st_makeline', 'st_makepolygon',
  'st_point', 'st_pointfromgeohash',
]);

/**
 * DDL / setup patterns that should be replaced with SELECT 1.
 */
const SPATIAL_DDL_RE =
  /^\s*(CREATE\s+(SPATIAL|GIST)\s+INDEX|AddGeometryColumn|DropGeometryColumn|Populate_Geometry_Columns)\b/i;

/**
 * Regex to locate an ST_ function name (the `ST_\w+` prefix), case-insensitive.
 * The arguments are extracted separately with balanced-paren scanning so WKT
 * literals like `ST_GeomFromText('POINT(1 2)', 4326)` are parsed correctly.
 */
const ST_FUNC_NAME_RE = /\b(ST_\w+)\s*\(/i;
const ST_FUNC_CALL_GLOBAL_RE = /\b(ST_\w+)\s*\(([^)]*)\)\s*/gi;

/**
 * Locate the first `ST_x(...)` call in `sql` using balanced-paren scanning.
 *
 * Returns the parsed call, or `null` when no `ST_` function call is present.
 * Unlike a naive `[^)]*` regex, this correctly handles nested parentheses
 * inside arguments (e.g. WKT `'POINT(1 2)'` or `ST_Transform(..., ...)`).
 */
function findStCall(sql: string): {
  funcName: string;
  args: string;
  fullMatch: string;
} | null {
  const head = ST_FUNC_NAME_RE.exec(sql);
  if (!head) return null;

  const funcName = head[1];
  // Index just after the opening parenthesis of the call.
  const openParen = head.index + head[0].length - 1;
  let depth = 1;
  let i = openParen + 1;
  for (; i < sql.length && depth > 0; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
  }
  if (depth !== 0) return null; // unbalanced — treat as no match

  return {
    funcName,
    args: sql.slice(openParen + 1, i - 1),
    fullMatch: sql.slice(head.index, i),
  };
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains PostGIS spatial operations.
 *
 * Checks for the presence of known `ST_*` function calls or spatial DDL
 * statements. Returns `true` if any spatial operation is detected.
 *
 * @param sql - The SQL statement to inspect
 * @returns `true` if the statement appears to use PostGIS spatial features
 *
 * @example
 * ```typescript
 * detectPostGIS('SELECT ST_Distance(a.geom, b.geom) FROM ...');
 * // → true
 * ```
 */
export function detectPostGIS(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  const trimmed = sql.trim();

  // Check for spatial DDL
  if (SPATIAL_DDL_RE.test(trimmed)) {
    return true;
  }

  // Check for any known ST_ function call via regex
  const matches = trimmed.matchAll(ST_FUNC_CALL_GLOBAL_RE);
  for (const match of matches) {
    const funcName = match[1].toLowerCase();
    if (
      MOCK_NUMERIC_FUNCS.has(funcName) ||
      MOCK_BOOL_FUNCS.has(funcName) ||
      PASSTHROUGH_GEOM_FUNCS.has(funcName) ||
      PASSTHROUGH_STRING_FUNCS.has(funcName)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Rewrite a PostGIS spatial SQL statement into a SQLite-compatible form.
 *
 * - DDL spatial statements → `SELECT 1` (no-op)
 * - Predicates (Contains, Intersects) → wrapper that returns `true`
 * - Metrics (Distance, Area) → wrapper that returns `0`
 * - Geometry passthrough (AsText, Transform) → original expression unchanged
 * - Non-spatial SQL → passthrough unchanged
 *
 * The function applies replacements at the statement level, wrapping the
 * first detected spatial function. For simple queries with a single spatial
 * function call, this produces a functional mock. Complex nested expressions
 * may not be handled perfectly.
 *
 * @param sql - The SQL statement to rewrite
 * @returns A `PostGISResult` with the (possibly rewritten) SQL
 *
 * @example
 * ```typescript
 * rewritePostGIS('SELECT ST_Distance(a, b) FROM t');
 * // → { sql: 'SELECT 0 FROM t', rewritten: true, category: 'st_distance' }
 * ```
 */
export function rewritePostGIS(sql: string): PostGISResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();

  // ── Spatial DDL → SELECT 1 ────────────────────────────────────
  if (SPATIAL_DDL_RE.test(trimmed)) {
    logger.debug({ sql: trimmed }, 'Spatial DDL → SELECT 1');
    return { sql: 'SELECT 1', rewritten: true, category: 'spatial_ddl' };
  }

  // ── Replace the first ST_ function call ───────────────────────
  const call = findStCall(trimmed);
  if (!call) {
    return { sql: trimmed.replace(/;+\s*$/, '') + ';', rewritten: false };
  }

  const fullMatch = call.fullMatch;
  const funcName = call.funcName.toLowerCase();
  const args = call.args.trim();

  if (MOCK_NUMERIC_FUNCS.has(funcName)) {
    // Replace the function call with "0"
    const resultSql = trimmed.replace(fullMatch, '0');
    logger.debug({ sql: trimmed, func: funcName }, `PostGIS mock numeric → 0`);
    return { sql: resultSql.replace(/;+\s*$/, '') + ';', rewritten: true, category: funcName };
  }

  if (MOCK_BOOL_FUNCS.has(funcName)) {
    // Replace the function call with "true"
    const resultSql = trimmed.replace(fullMatch, 'true');
    logger.debug({ sql: trimmed, func: funcName }, `PostGIS mock boolean → true`);
    return { sql: resultSql.replace(/;+\s*$/, '') + ';', rewritten: true, category: funcName };
  }

  if (PASSTHROUGH_GEOM_FUNCS.has(funcName)) {
    // Replace the function call with the first argument (geometry passthrough)
    const firstArg = args.split(',').map(a => a.trim())[0] || 'NULL';
    const resultSql = trimmed.replace(fullMatch, firstArg);
    logger.debug({ sql: trimmed, func: funcName }, `PostGIS geometry passthrough`);
    return { sql: resultSql.replace(/;+\s*$/, '') + ';', rewritten: true, category: funcName };
  }

  if (PASSTHROUGH_STRING_FUNCS.has(funcName)) {
    // Replace with wrapping string or passthrough first arg
    if (funcName === 'st_makepoint' || funcName === 'st_point') {
      // ST_MakePoint(x,y) → '' (string passthrough)
      const resultSql = trimmed.replace(fullMatch, "''");
      logger.debug({ sql: trimmed, func: funcName }, `PostGIS make-point → ''`);
      return { sql: resultSql.replace(/;+\s*$/, '') + ';', rewritten: true, category: funcName };
    }
    // ST_GeomFromText(wkt, srid) → wkt
    if (funcName === 'st_geomfromtext') {
      const firstArg = args.split(',').map(a => a.trim())[0] || 'NULL';
      const resultSql = trimmed.replace(fullMatch, firstArg);
      logger.debug({ sql: trimmed, func: funcName }, `PostGIS GeomFromText passthrough`);
      return { sql: resultSql.replace(/;+\s*$/, '') + ';', rewritten: true, category: funcName };
    }
    // Other string functions: passthrough first arg
    const firstArg = args.split(',').map(a => a.trim())[0] || 'NULL';
    const resultSql = trimmed.replace(fullMatch, firstArg);
    logger.debug({ sql: trimmed, func: funcName }, `PostGIS string passthrough`);
    return { sql: resultSql.replace(/;+\s*$/, '') + ';', rewritten: true, category: funcName };
  }

  // ── Unknown ST_ function — pass through unchanged ─────────────
  return { sql: trimmed.replace(/;+\s*$/, '') + ';', rewritten: false };
}
