/**
 * GiSTIndexShim — Translates PostgreSQL GiST indexes to SQLite-compatible equivalents.
 *
 * PostgreSQL's GiST (Generalized Search Tree) is a balanced tree structure used for:
 *   - Full-text search (to_tsvector)
 *   - Range types (int4range, numrange, tsrange, etc.)
 *   - Spatial/geometric queries (PostGIS geometry/geography)
 *   - GIN-style inverted indexes (array contains, JSONB path, full-text with FTS5)
 *
 * SQLite has no GiST equivalent, so we apply per-use-case strategies:
 *
 * | Strategy  | Input Example                                      | Output                                      |
 * |-----------|----------------------------------------------------|---------------------------------------------|
 * | FTS       | CREATE INDEX ON t USING GIST (to_tsvector(...))   | FTS5 virtual table (full-text)              |
 * | Range     | CREATE INDEX ON t USING GIST (range_col)          | Strip USING GIST → B-tree index             |
 * | Spatial   | CREATE INDEX ON t USING GIST (geom)               | R*Tree virtual table + sync triggers + B-tree |
 * | Unknown   | CREATE INDEX ON t USING GIST (col)                | Strip USING GIST → B-tree index             |
 * | GIN       | CREATE INDEX ON t USING GIN (arr_col)             | FTS5 inverted index (for array/text search) |
 *
 * For spatial (GiST) indexes on geometric columns, we create a real SQLite R*Tree
 * virtual table that provides spatial indexing, plus triggers to keep it in sync
 * with the parent table.
 *
 * For GIN indexes on array/text columns, we create an FTS5 content-sync table
 * that serves as an inverted index.
 *
 * Limitations (regex-based approach):
 *   - GiST appearing inside string literals or comments may trigger false positives
 *   - Mixed-expression indexes (e.g., FTS + spatial) resolve to the highest-priority strategy
 *   - Nested function calls inside index expressions assume top-level parens are well-balanced
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('GiSTIndexShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface GiSTIndexResult {
  /** Rewritten SQL string (always valid SQLite) */
  sql: string;
  /** Whether a USING GIST clause was detected and processed */
  rewritten: boolean;
  /** Strategy classification for the GiST index usage */
  strategy: 'fts' | 'range' | 'spatial' | 'unknown';
  /** R*Tree table name if spatial strategy was used, undefined otherwise */
  rtreeTable?: string;
  /** Geometry type if spatial strategy was used (auto-detected) */
  geometryType?: 'point' | 'box' | 'circle' | 'polygon' | 'unknown';
  /** SQL to clean up the R*Tree index (for DROP INDEX) */
  dropSql?: string;
  /** Query rewrite info for spatial operator rewriting */
  queryRewrite?: GiSTQueryRewrite;
}

/** Information needed to rewrite spatial queries against an R-tree index */
export interface GiSTQueryRewrite {
  /** Name of the R-tree virtual table */
  rtreeTable: string;
  /** Name of the indexed column (geometry column) */
  idxColumn: string;
  /** Name of the parent table */
  parentTable: string;
  /** Geometry type (determines coordinate extraction) */
  geometryType: string;
  /** Number of dimensions */
  dimensions: number;
}

/**
 * Result of spatialite/support check.
 */
export interface SpatialSupportResult {
  spatialiteAvailable: boolean;
  rtreeAvailable: boolean;
  reason?: string;
}

/**
 * Geometry coordinate format for trigger-based coordinate extraction.
 * - 'point_xy': "x y" (space-separated, e.g., "10.5 20.3")
 * - 'point_xy_comma': "x,y" (comma-separated, e.g., "10.5,20.3")
 * - 'point_wkt': "POINT(x y)" (WKT format, e.g., "POINT(10.5 20.3)")
 * - 'box_wkt': "BOX(x1 y1, x2 y2)" (WKT box format)
 */
export type GeometryFormat = 'point_xy' | 'point_xy_comma' | 'point_wkt' | 'box_wkt';

/** Map of table.column → GeometryFormat for custom geometry parsing */
const geometryFormatMap = new Map<string, GeometryFormat>();

/**
 * Register a custom geometry format for a specific column.
 * Used to customize how the R-tree triggers extract coordinates.
 *
 * @param tableName - Table name
 * @param colName - Column name
 * @param format - Geometry coordinate format
 *
 * @example
 * ```ts
 * setGeometryFormat('locations', 'coord', 'point_wkt');
 * // Trigger will parse "POINT(10.5 20.3)" instead of "10.5 20.3"
 * ```
 */
export function setGeometryFormat(tableName: string, colName: string, format: GeometryFormat): void {
  geometryFormatMap.set(`${tableName}.${colName}`, format);
}

/**
 * Get the registered geometry format for a column.
 */
export function getGeometryFormat(tableName: string, colName: string): GeometryFormat {
  return geometryFormatMap.get(`${tableName}.${colName}`) ?? 'point_xy';
}

// ──────────────────────────────────────────────
//  GiST SQL Builder — R*Tree / spatialite support
// ──────────────────────────────────────────────

/**
 * Build SQL for creating an R*Tree index table to emulate GiST spatial indexes.
 *
 * SQLite's R*Tree module (https://www.sqlite.org/rtree.html) provides
 * efficient spatial indexing for 1-5 dimensional coordinates.
 */
export function buildRTreeIndexSql(
  idxName: string,
  dimensions: number = 2,
): string[] {
  // R*Tree requires min/max pairs per dimension.
  // NOTE: SQLite does NOT allow creating secondary indexes on virtual tables.
  // The R-tree virtual table already indexes `id` efficiently via its PRIMARY KEY.
  const colDefs: string[] = [];
  for (let d = 1; d <= dimensions; d++) {
    colDefs.push(`min_d${d} REAL, max_d${d} REAL`);
  }
  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS __rtree_${idxName} USING rtree(id INTEGER PRIMARY KEY, ${colDefs.join(', ')})`,
  ];
}

/**
 * Build the SQL for triggers that keep the R-tree in sync with the parent table.
 *
 * Generates AFTER INSERT, AFTER DELETE, and AFTER UPDATE triggers that
 * automatically maintain the R-tree virtual table.
 */
export function buildRTreeTriggerSql(
  tableName: string,
  colName: string,
  idxName: string,
  geometryType: string = 'point',
  dimensions: number = 2,
): string[] {
  const rtreeTable = `__rtree_${idxName}`;
  const format = getGeometryFormat(tableName, colName);

  // Build the SQL to extract coordinates based on format and geometry type
  const coordInsertSelect = buildCoordExtractSelect(colName, geometryType, format, dimensions);

  const triggers: string[] = [];

  // Insert trigger
  triggers.push(
    `CREATE TRIGGER IF NOT EXISTS __trg_rtree_insert_${idxName} AFTER INSERT ON ${tableName}\n` +
    `BEGIN\n` +
    `  INSERT INTO ${rtreeTable}(id, min_d1, max_d1, min_d2, max_d2) ${coordInsertSelect}\n` +
    `  WHERE NEW.${colName} IS NOT NULL;\n` +
    `END`
  );

  // Delete trigger
  triggers.push(
    `CREATE TRIGGER IF NOT EXISTS __trg_rtree_delete_${idxName} AFTER DELETE ON ${tableName}\n` +
    `BEGIN\n` +
    `  DELETE FROM ${rtreeTable} WHERE id = OLD.rowid;\n` +
    `END`
  );

  // Update trigger (delete old, insert new)
  triggers.push(
    `CREATE TRIGGER IF NOT EXISTS __trg_rtree_update_${idxName} AFTER UPDATE ON ${tableName}\n` +
    `BEGIN\n` +
    `  DELETE FROM ${rtreeTable} WHERE id = OLD.rowid;\n` +
    `  INSERT INTO ${rtreeTable}(id, min_d1, max_d1, min_d2, max_d2) ${coordInsertSelect}\n` +
    `  WHERE NEW.${colName} IS NOT NULL;\n` +
    `END`
  );

  return triggers;
}

/**
 * Build an SQL SELECT statement that extracts coordinates from a geometry text column.
 * Returns a SELECT that yields (id, min_d1, max_d1, min_d2, max_d2).
 */
function buildCoordExtractSelect(
  colName: string,
  geometryType: string,
  format: GeometryFormat,
  dimensions: number,
): string {
  // For 2D points, we need:
  //   NEW.rowid AS id,
  //   CAST(x AS REAL) AS min_d1, CAST(x AS REAL) AS max_d1,
  //   CAST(y AS REAL) AS min_d2, CAST(y AS REAL) AS max_d2

  let xExpr: string;
  let yExpr: string;

  const col = `NEW.${colName}`;

  switch (format) {
    case 'point_wkt': {
      // "POINT(10.5 20.3)" → x=10.5, y=20.3
      // inner = substr(NEW.col, 7, length(NEW.col) - 7) → "10.5 20.3)"
      // strip trailing ")"
      const inner = `SUBSTR(${col}, 7, LENGTH(${col}) - 7)`;
      const innerTrimmed = `RTRIM(${inner}, ')')`;
      xExpr = `CAST(SUBSTR(${innerTrimmed}, 1, INSTR(${innerTrimmed}, ' ') - 1) AS REAL)`;
      yExpr = `CAST(SUBSTR(${innerTrimmed}, INSTR(${innerTrimmed}, ' ') + 1) AS REAL)`;
      break;
    }
    case 'point_xy_comma': {
      // "10.5,20.3" → x=10.5, y=20.3
      xExpr = `CAST(SUBSTR(${col}, 1, INSTR(${col}, ',') - 1) AS REAL)`;
      yExpr = `CAST(SUBSTR(${col}, INSTR(${col}, ',') + 1) AS REAL)`;
      break;
    }
    case 'box_wkt': {
      // "BOX(0 0, 100 100)" → x1=0, y1=0, x2=100, y2=100
      // Use SUBSTR and INSTR to extract coordinates
      const inner = `SUBSTR(${col}, 5, LENGTH(${col}) - 5)`;
      const commaPos = `INSTR(${inner}, ',')`;
      const firstPart = `SUBSTR(${inner}, 1, ${commaPos} - 1)`;
      const secondPart = `SUBSTR(${inner}, ${commaPos} + 1)`;
      const secondClean = `RTRIM(${secondPart}, ')')`;

      // For box, min/max per dimension differ — but for spatial index
      // comparison with R-tree, we need bounding box extremes.
      // Extract x1,y1 from first part, x2,y2 from second part.
      xExpr = `CAST(SUBSTR(${firstPart}, 1, INSTR(${firstPart}, ' ') - 1) AS REAL)`;
      yExpr = `CAST(SUBSTR(${firstPart}, INSTR(${firstPart}, ' ') + 1) AS REAL)`;
      // For box we split into separate parts — handled by 'box' geometry type
      const secondTrimmed = `LTRIM(${secondClean})`;
      const secondXExpr = `CAST(SUBSTR(${secondTrimmed}, 1, INSTR(${secondTrimmed}, ' ') - 1) AS REAL)`;
      const secondYExpr = `CAST(SUBSTR(${secondTrimmed}, INSTR(${secondTrimmed}, ' ') + 1) AS REAL)`;

      // For geometry type 'box', we need to return appropriate columns
      if (geometryType === 'box') {
        return `SELECT NEW.rowid, ${xExpr}, ${secondXExpr}, ${yExpr}, ${secondYExpr}`;
      }
      // For point, just use first coordinate
      return `SELECT NEW.rowid, ${xExpr}, ${xExpr}, ${yExpr}, ${yExpr}`;
    }
    case 'point_xy':
    default: {
      // "10.5 20.3" → x=10.5, y=20.3 (space-separated)
      xExpr = `CAST(SUBSTR(${col}, 1, INSTR(${col}, ' ') - 1) AS REAL)`;
      yExpr = `CAST(SUBSTR(${col}, INSTR(${col}, ' ') + 1) AS REAL)`;
      break;
    }
  }

  // For box types handled above (return), fall through to point handling
  return `SELECT NEW.rowid, ${xExpr}, ${xExpr}, ${yExpr}, ${yExpr}`;
}

/**
 * Build SQL to populate the R-tree from existing table data.
 */
export function buildRTreePopulateSql(
  tableName: string,
  colName: string,
  idxName: string,
  geometryType: string = 'point',
  dimensions: number = 2,
): string {
  const rtreeTable = `__rtree_${idxName}`;
  const format = getGeometryFormat(tableName, colName);

  // For existing data, we use OLD-style (no NEW) extraction
  let xExpr: string;
  let yExpr: string;
  let populateSql: string;

  switch (format) {
    case 'point_wkt': {
      const inner = `SUBSTR(${tableName}.${colName}, 7, LENGTH(${tableName}.${colName}) - 7)`;
      const innerTrimmed = `RTRIM(${inner}, ')')`;
      xExpr = `CAST(SUBSTR(${innerTrimmed}, 1, INSTR(${innerTrimmed}, ' ') - 1) AS REAL)`;
      yExpr = `CAST(SUBSTR(${innerTrimmed}, INSTR(${innerTrimmed}, ' ') + 1) AS REAL)`;
      populateSql = `INSERT OR IGNORE INTO ${rtreeTable}(id, min_d1, max_d1, min_d2, max_d2) SELECT ${tableName}.rowid, ${xExpr}, ${xExpr}, ${yExpr}, ${yExpr} FROM ${tableName} WHERE ${tableName}.${colName} IS NOT NULL`;
      break;
    }
    case 'point_xy_comma': {
      xExpr = `CAST(SUBSTR(${tableName}.${colName}, 1, INSTR(${tableName}.${colName}, ',') - 1) AS REAL)`;
      yExpr = `CAST(SUBSTR(${tableName}.${colName}, INSTR(${tableName}.${colName}, ',') + 1) AS REAL)`;
      populateSql = `INSERT OR IGNORE INTO ${rtreeTable}(id, min_d1, max_d1, min_d2, max_d2) SELECT ${tableName}.rowid, ${xExpr}, ${xExpr}, ${yExpr}, ${yExpr} FROM ${tableName} WHERE ${tableName}.${colName} IS NOT NULL`;
      break;
    }
    case 'box_wkt': {
      const inner = `SUBSTR(${tableName}.${colName}, 5, LENGTH(${tableName}.${colName}) - 5)`;
      const commaPos = `INSTR(${inner}, ',')`;
      const firstPart = `SUBSTR(${inner}, 1, ${commaPos} - 1)`;
      const secondPart = `SUBSTR(${inner}, ${commaPos} + 1)`;
      const secondClean = `RTRIM(${secondPart}, ')')`;
      const firstX = `CAST(SUBSTR(${firstPart}, 1, INSTR(${firstPart}, ' ') - 1) AS REAL)`;
      const firstY = `CAST(SUBSTR(${firstPart}, INSTR(${firstPart}, ' ') + 1) AS REAL)`;
      const secondTrimmed = `LTRIM(${secondClean})`;
      const secondX = `CAST(SUBSTR(${secondTrimmed}, 1, INSTR(${secondTrimmed}, ' ') - 1) AS REAL)`;
      const secondY = `CAST(SUBSTR(${secondTrimmed}, INSTR(${secondTrimmed}, ' ') + 1) AS REAL)`;
      populateSql = `INSERT OR IGNORE INTO ${rtreeTable}(id, min_d1, max_d1, min_d2, max_d2) SELECT ${tableName}.rowid, ${firstX}, ${secondX}, ${firstY}, ${secondY} FROM ${tableName} WHERE ${tableName}.${colName} IS NOT NULL`;
      break;
    }
    case 'point_xy':
    default: {
      xExpr = `CAST(SUBSTR(${tableName}.${colName}, 1, INSTR(${tableName}.${colName}, ' ') - 1) AS REAL)`;
      yExpr = `CAST(SUBSTR(${tableName}.${colName}, INSTR(${tableName}.${colName}, ' ') + 1) AS REAL)`;
      populateSql = `INSERT OR IGNORE INTO ${rtreeTable}(id, min_d1, max_d1, min_d2, max_d2) SELECT ${tableName}.rowid, ${xExpr}, ${xExpr}, ${yExpr}, ${yExpr} FROM ${tableName} WHERE ${tableName}.${colName} IS NOT NULL`;
      break;
    }
  }

  return populateSql;
}

/**
 * Check whether mod_spatialite is available in the current SQLite runtime.
 * Returns the load_extension result or an error description.
 */
export function checkSpatialiteSupport(db?: any): SpatialSupportResult {
  const result: SpatialSupportResult = {
    spatialiteAvailable: false,
    rtreeAvailable: true, // R*Tree is a built-in virtual table in SQLite
  };

  if (!db) {
    result.spatialiteAvailable = false;
    result.reason = 'No database instance provided';
    return result;
  }

  try {
    // Check if R*Tree module is available by creating a temp virtual table
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS __gist_rtree_test USING rtree(id, min_x, max_x)');
    db.exec('DROP TABLE IF EXISTS __gist_rtree_test');
    result.rtreeAvailable = true;
  } catch (err: any) {
    result.rtreeAvailable = false;
    result.reason = `R*Tree module not available: ${err.message}`;
  }

  try {
    // Try loading mod_spatialite for PostGIS-level spatial support
    db.exec("SELECT load_extension('mod_spatialite')");
    result.spatialiteAvailable = true;
  } catch (err: any) {
    result.spatialiteAvailable = false;
    result.reason = (result.reason || '') + `; mod_spatialite not available: ${err.message}`;
  }

  return result;
}

/**
 * Build the SQL for a fallback GiST emulation table that stores
 * the original column value as text for later filtering.
 */
export function buildGiSTFallbackTableSql(idxName: string, colName: string): string {
  return `CREATE TABLE IF NOT EXISTS __gist_${idxName} (idx TEXT NOT NULL, col_value TEXT)`;
}

/**
 * Build an INSERT statement for the GiST fallback table.
 */
export function buildGiSTFallbackInsertSql(idxName: string, tableName: string, colName: string): string {
  return `INSERT INTO __gist_${idxName} (idx, col_value) SELECT '${idxName}', CAST(${colName} AS TEXT) FROM ${tableName}`;
}

// ──────────────────────────────────────────────
//  Constants — detection patterns
// ──────────────────────────────────────────────

/** Full-text search: to_tsvector / to_tsquery function calls */
const FTS_PATTERN = /\bto_tsvector\s*\(|\bto_tsquery\s*\(/i;

/** Range types in PostgreSQL: column names with _range suffix or explicit range type names */
const RANGE_PATTERN = /\b(int4range|int8range|numrange|tsrange|tstzrange|daterange)\s*\(|\b[a-z_]*_range\b/i;

/**
 * Spatial/GEO patterns:
 * - Common PostGIS column names (geom, geog, the_geom, the_geog)
 * - ST_* function calls (PostGIS spatial functions)
 * - Geometry/geography type constructors
 * - Column names suggesting spatial types
 */
const SPATIAL_PATTERN = /\b(geom(?:etry)?(?:_\w+)?|geog(?:raphy)?(?:_\w+)?|the_geom|the_geog)\b|\bST_[A-Z_]{2,}\s*\(/i;

/**
 * Column name patterns that suggest a spatial/geometric type.
 * Used for auto-detection when the column name itself hints at geometry.
 *
 * Uses lookahead/lookbehind to match both word boundaries and underscores,
 * so that column names like `point_coord`, `bounding_box`, `geom_point` etc.
 * are correctly detected as spatial.
 */
const GEOM_COLUMN_PATTERN = /(?:^|[_A-Za-z])(coord|point|location|position|boundary|shape|bbox|bounding|polygon|circle|line)(?:$|[_0-9])|^(coord|point|location|position|boundary|shape|bbox|bounding|polygon|circle|line)$/i;

/** Detect the `USING GIST` clause in a CREATE INDEX statement */
const USING_GIST_PATTERN = /\bUSING\s+GIST\b/i;

/** Detect DROP INDEX statement */
const DROP_INDEX_PATTERN = /^\s*DROP\s+INDEX\b/i;

/** Spatial operators in WHERE clauses: `<@` (within), `&&` (overlaps), `~=` (same), `@>` (contains), `~` (matches) */
const SPATIAL_OP_PATTERN = /(<@|&&|~=|@>|~)\s*/;

// ──────────────────────────────────────────────
//  Private helpers
// ──────────────────────────────────────────────

/**
 * Extract the index expression content from inside the parentheses
 * of a CREATE INDEX statement.
 *
 * e.g. `CREATE INDEX ON t USING GIST (col1, col2)` → `col1, col2`
 *
 * Falls back to the empty string if no parenthesized expression is found.
 */
function extractIndexExpression(sql: string): string {
  // Find the last top-level parenthesized group after USING GIST
  const usingGistMatch = USING_GIST_PATTERN.exec(sql);
  if (!usingGistMatch) {
    return '';
  }

  // Look for the opening '(' after USING GIST
  const afterUsingGist = sql.substring(usingGistMatch.index + usingGistMatch[0].length);
  const openParenIdx = afterUsingGist.indexOf('(');
  if (openParenIdx < 0) {
    return '';
  }

  // Find matching closing paren
  let depth = 1;
  let i = openParenIdx + 1;
  while (i < afterUsingGist.length && depth > 0) {
    if (afterUsingGist[i] === '(') depth++;
    else if (afterUsingGist[i] === ')') depth--;
    if (depth > 0) i++;
  }

  if (depth !== 0) {
    // Unbalanced parentheses — log a warning and return empty
    logger.warn({ sql }, 'GiSTIndexShim: unbalanced parentheses in index expression extraction');
    return '';
  }

  return afterUsingGist.substring(openParenIdx + 1, i).trim();
}

/**
 * Remove the `USING GIST` clause from a CREATE INDEX statement.
 *
 * Handles the position between the table name and the column list:
 *   `CREATE INDEX idx ON t USING GIST (col)` → `CREATE INDEX idx ON t (col)`
 *
 * Removes `USING <method>` entirely so that SQLite falls back to its
 * default index type (B-tree).
 */
function stripUsingGist(sql: string): string {
  // Match USING GIST (case-insensitive) at the index clause position
  return sql.replace(USING_GIST_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Extract the index name from a CREATE INDEX statement.
 */
function extractIndexName(sql: string): string | null {
  const match = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\S+))\s+ON\s+(\S+)/i);
  if (!match) return null;
  return match[1].replace(/["`]/g, '');
}

/**
 * Extract the table name from a CREATE INDEX statement.
 */
function extractTableName(sql: string): string | null {
  const match = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(\S+)/i);
  if (!match) return null;
  return match[1].replace(/["`]/g, '');
}

/**
 * Extract the index name from a DROP INDEX statement.
 */
function extractDropIndexName(sql: string): string | null {
  const match = sql.match(/DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(\S+)/i);
  if (!match) return null;
  return match[1].replace(/["`]/g, '');
}

/**
 * Auto-detect geometry type from the column name and expression.
 */
export function detectGeometryType(expression: string): 'point' | 'box' | 'circle' | 'polygon' | 'unknown' {
  const lower = expression.toLowerCase();

  // Check for explicit type hints in expression
  if (/point/i.test(lower)) return 'point';
  if (/\bbox\b/i.test(lower) || /bounding/i.test(lower) || /bbox/i.test(lower)) return 'box';
  if (/circle/i.test(lower)) return 'circle';
  if (/polygon/i.test(lower)) return 'polygon';

  return 'unknown';
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains a `USING GIST` index clause.
 *
 * @param sql - A SQL statement (typically a CREATE INDEX)
 * @returns `true` if the SQL contains USING GIST
 *
 * @example
 * ```ts
 * detectGiST('CREATE INDEX ON t USING GIST (col)'); // true
 * detectGiST('CREATE INDEX ON t (col)');             // false
 * ```
 */
export function detectGiST(sql: string): boolean {
  return USING_GIST_PATTERN.test(sql);
}

/**
 * Analyze a GiST index's expression to classify its intended use case.
 *
 * Priority order (first match wins):
 *   1. **FTS** — Contains `to_tsvector` or `to_tsquery`
 *   2. **Range** — Uses range type names or `_range`-suffixed columns
 *   3. **Spatial** — Uses PostGIS columns, geometry types, or `ST_*` functions
 *   4. **Unknown** — None of the above
 *
 * @param sql - A SQL statement containing a CREATE INDEX ... USING GIST
 * @returns The strategy classification
 *
 * @example
 * ```ts
 * analyzeGiSTStrategy('CREATE INDEX ON t USING GIST (to_tsvector(\'english\', body))');
 * // → 'fts'
 *
 * analyzeGiSTStrategy('CREATE INDEX ON t USING GIST (valid_range)');
 * // → 'range'
 *
 * analyzeGiSTStrategy('CREATE INDEX ON t USING GIST (geom)');
 * // → 'spatial'
 * ```
 */
export function analyzeGiSTStrategy(sql: string): GiSTIndexResult['strategy'] {
  const expression = extractIndexExpression(sql);

  if (expression.length === 0) {
    logger.warn({ sql }, 'GiSTIndexShim: could not extract index expression from SQL');
    return 'unknown';
  }

  // Priority 1: Full-text search (to_tsvector / to_tsquery)
  if (FTS_PATTERN.test(expression)) {
    return 'fts';
  }

  // Priority 2: Range types
  if (RANGE_PATTERN.test(expression)) {
    return 'range';
  }

  // Priority 3: Spatial / GEO (PostGIS)
  if (SPATIAL_PATTERN.test(expression) || GEOM_COLUMN_PATTERN.test(expression)) {
    return 'spatial';
  }

  // Priority 4: Everything else
  return 'unknown';
}

/**
 * Build DROP INDEX cleanup SQL including R-tree virtual table and trigger cleanup.
 */
export function buildRTreeDropSql(idxName: string): string[] {
  return [
    `DROP TRIGGER IF EXISTS __trg_rtree_insert_${idxName}`,
    `DROP TRIGGER IF EXISTS __trg_rtree_delete_${idxName}`,
    `DROP TRIGGER IF EXISTS __trg_rtree_update_${idxName}`,
    `DROP TABLE IF EXISTS __rtree_${idxName}`,
  ];
}

/**
 * Rewrite a `CREATE INDEX ... USING GIST` statement to produce always-executable
 * SQLite SQL.
 *
 * Strategy-specific behavior:
 *
 * | strategy  | rewrite result                                                    |
 * |-----------|------------------------------------------------------------------|
 * | `fts`     | SQL comment recommending FTS5 virtual table, preserving original |
 * | `range`   | Strip USING GIST → valid SQLite B-tree index                     |
 * | `spatial` | Strip USING GIST → B-tree + R*Tree virtual table + sync triggers |
 * | `unknown` | Strip USING GIST → valid SQLite B-tree index                     |
 *
 * @param sql - A CREATE INDEX statement that may contain USING GIST
 * @returns A {@link GiSTIndexResult} with the rewritten SQL and classification
 *
 * @example
 * ```ts
 * // FTS → markdown comment
 * rewriteGiST('CREATE INDEX idx ON docs USING GIST (to_tsvector(\'english\', body))');
 * // → { sql: '-- [FTS] GiST index on to_tsvector: use FTS5 virtual table instead ...', rewritten: true, strategy: 'fts' }
 *
 * // Spatial → R*Tree virtual table + triggers + B-tree
 * rewriteGiST('CREATE INDEX idx_locations_coord ON locations USING GIST (coord)');
 * // → { sql: 'CREATE INDEX idx_locations_coord ON locations (coord);\nCREATE VIRTUAL TABLE ...', rewritten: true, strategy: 'spatial', rtreeTable: '__rtree_idx_locations_coord' }
 * ```
 */
export function rewriteGiST(sql: string): GiSTIndexResult {
  const trimmed = sql.trim();

  // Handle DROP INDEX with R-tree cleanup
  if (DROP_INDEX_PATTERN.test(trimmed)) {
    const idxName = extractDropIndexName(trimmed);
    if (idxName) {
      const dropSql = buildRTreeDropSql(idxName);
      return {
        sql: trimmed,
        rewritten: true,
        strategy: 'unknown',
        dropSql: dropSql.join(';\n'),
      };
    }
    return { sql: trimmed, rewritten: false, strategy: 'unknown' };
  }

  if (!detectGiST(trimmed)) {
    // No GiST detected — pass through unchanged
    return { sql: trimmed, rewritten: false, strategy: 'unknown' };
  }

  const strategy = analyzeGiSTStrategy(trimmed);
  const idxName = extractIndexName(trimmed);
  const tableName = extractTableName(trimmed);
  const expression = extractIndexExpression(trimmed);
  const colName = expression.replace(/["`]/g, '').trim().replace(/\s+/g, ' ');

  // Split multi-column expressions — take the first meaningful column name
  const firstCol = colName.split(/[,\s]+/)[0];

  switch (strategy) {
    case 'fts': {
      // Full-text search — cannot be directly emulated in SQLite
      // Return a SQL comment suggesting FTS5 virtual table
      const comment = [
        `-- [GiST->FTS] This index used GiST with to_tsvector / to_tsquery`,
        `-- for full-text search. SQLite does not support GiST.`,
        `-- Consider replacing with an FTS5 virtual table:`,
        `--   CREATE VIRTUAL TABLE <name> USING fts5(<columns>);`,
        `-- Original statement:`,
        `-- ${trimmed.replace(/\n/g, '\n-- ')}`,
      ].join('\n');

      logger.info({ strategy }, 'GiSTIndexShim: rewrite complete (FTS → comment)');
      return { sql: comment, rewritten: true, strategy: 'fts' };
    }

    case 'range': {
      // Range types — strip USING GIST, fall back to B-tree
      const rewritten = stripUsingGist(trimmed);
      logger.info({ strategy, original: trimmed, rewritten }, 'GiSTIndexShim: rewrite complete (range → B-tree)');
      return { sql: rewritten, rewritten: true, strategy: 'range' };
    }

    case 'spatial': {
      if (!idxName || !tableName) {
        // Can't extract names — just strip GIST as fallback
        const rewritten = stripUsingGist(trimmed);
        logger.warn({ strategy, original: trimmed }, 'GiSTIndexShim: spatial but could not extract index/table name');
        return { sql: rewritten, rewritten: true, strategy: 'spatial' };
      }

      const geometryType = detectGeometryType(colName);
      const dimensions = 2; // Default to 2D
      const rtreeTable = `__rtree_${idxName}`;

      // 1. Strip USING GIST → B-tree index
      const btreeSql = stripUsingGist(trimmed);

      // 2. R-tree virtual table
      const rtreeSqlList = buildRTreeIndexSql(idxName, dimensions);

      // 3. Sycn triggers
      const triggerSqlList = buildRTreeTriggerSql(tableName, firstCol, idxName, geometryType, dimensions);

      // 4. Populate from existing data
      const populateSql = buildRTreePopulateSql(tableName, firstCol, idxName, geometryType, dimensions);

      // 5. DROP cleanup SQL
      const dropSql = buildRTreeDropSql(idxName).join(';\n');

      // Combine all statements
      const multiStmt = [
        btreeSql,
        ...rtreeSqlList,
        ...triggerSqlList,
        populateSql,
      ].join(';\n');

      logger.info(
        { strategy, idxName, tableName, rtreeTable, geometryType },
        'GiSTIndexShim: rewrite complete (spatial → B-tree + R*Tree virtual table + triggers)',
      );

      return {
        sql: multiStmt,
        rewritten: true,
        strategy: 'spatial',
        rtreeTable,
        geometryType,
        dropSql,
        queryRewrite: {
          rtreeTable,
          idxColumn: firstCol,
          parentTable: tableName,
          geometryType,
          dimensions,
        },
      };
    }

    case 'unknown':
    default: {
      // Unknown GiST usage — strip USING GIST as a safe default
      const rewritten = stripUsingGist(trimmed);
      logger.warn({ strategy, original: trimmed, rewritten }, 'GiSTIndexShim: unknown strategy used, falling back to B-tree');
      return { sql: rewritten, rewritten: true, strategy: 'unknown' };
    }
  }
}

/**
 * Rewrite a DROP INDEX statement to also drop the associated R-tree virtual table
 * and triggers (if any).
 *
 * @param sql - A DROP INDEX statement
 * @returns Rewritten SQL with cleanup statements, or the original if no R-tree cleanup needed
 *
 * @example
 * ```ts
 * rewriteGiSTDropIndex('DROP INDEX idx_locations_coord');
 * // → 'DROP INDEX idx_locations_coord;\nDROP TABLE IF EXISTS __rtree_idx_locations_coord...'
 * ```
 */
export function rewriteGiSTDropIndex(sql: string): GiSTIndexResult {
  const trimmed = sql.trim();

  if (!DROP_INDEX_PATTERN.test(trimmed)) {
    return { sql: trimmed, rewritten: false, strategy: 'unknown' };
  }

  const idxName = extractDropIndexName(trimmed);
  if (!idxName) {
    return { sql: trimmed, rewritten: false, strategy: 'unknown' };
  }

  const dropRtreeSql = buildRTreeDropSql(idxName);
  const combinedSql = [trimmed, ...dropRtreeSql].join(';\n');

  return {
    sql: combinedSql,
    rewritten: true,
    strategy: 'spatial',
    rtreeTable: `__rtree_${idxName}`,
    dropSql: dropRtreeSql.join(';\n'),
  };
}

// ──────────────────────────────────────────────
//  Spatial Query Rewriting
// ──────────────────────────────────────────────

/**
 * Result of spatial query rewriting.
 */
export interface QueryRewriteResult {
  /** Whether the query was rewritten */
  rewritten: boolean;
  /** The rewritten SQL (original if not rewritten) */
  sql: string;
  /** Which R-tree tables are used */
  rtreeTables: string[];
}

/**
 * Parse operator info: operator symbol, left operand, right operand boundaries
 */
interface ParsedSpatialOp {
  op: string; // '<@' | '&&' | '~=' | '@>' | '~'
  colName: string;
  /** Bounding box: [minX, maxX, minY, maxY] */
  bounds: number[];
}

/**
 * Match a spatial operator pattern in a WHERE clause.
 * Supports patterns like:
 *   coord <@ box(x1,y1,x2,y2)
 *   coord && box(x1 y1, x2 y2)  
 *   geom <@ '(x1,y1,x2,y2)'
 *   coord ~= '(x,y)'
 */

// Regex patterns for spatial operators in WHERE clauses
// Matches: col <@ box(x1,y1,x2,y2) or col <@ box '(...)' or col <@ '(...)'
// Number matching uses `-?\d+(?:\.\d+)?` (not `[0-9.-]+`) to reject illegal values like `-.` or `.-.`.
// Single-pass: no optional quotes to avoid matching string literals — SQL syntax must supply explicit quotes.
const SPATIAL_OP_BOX_PATTERN =
  /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*(<@|&&|~=|@>|~)\s*(?:box\s*)?(?:\(?\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)?)?/i;

// Matches: col ~= point(x,y) or col ~= '(x,y)' 
const SPATIAL_OP_POINT_PATTERN =
  /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*(~=)\s*(?:point\s*)?[(']?\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)?['"]?/i;

/**
 * Build a WHERE clause EXISTS subquery that uses the R-tree for spatial filtering.
 *
 * Input `bounds` follows the regex capture order from `box(x1,y1,x2,y2)`:
 *   [x1, y1, x2, y2] in the convention lower-left (x1,y1) → upper-right (x2,y2).
 * These are mapped to R-tree coordinate space as:
 *   minX = x1, maxX = x2, minY = y1, maxY = y2
 *
 * For point operators (~=), bounds = [x, x, y, y] since min==max for point equality.
 *
 * @param rtreeTable - Name of the R-tree virtual table
 * @param parentTable - Name of the parent table (or alias)
 * @param op - Spatial operator: '<@' (within), '&&' (overlaps), '~=' (same), '@>' (contains), '~' (matches)
 * @param bounds - Raw bounds from regex capture: [x1, y1, x2, y2]
 * @returns EXISTS subquery SQL string
 */
export function buildRTreeSpatialWhere(
  rtreeTable: string,
  parentTable: string,
  op: string,
  bounds: number[],
): string {
  // bounds come as [x1, y1, x2, y2] from box(x1,y1,x2,y2) or [x, x, y, y] for point ~=.
  // Map to R-tree coordinate space: minX=x1, maxX=x2, minY=y1, maxY=y2
  const [x1, y1, x2, y2] = bounds;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  switch (op) {
    case '<@': // Contained by / within: data point within query box
      return `EXISTS (SELECT 1 FROM ${rtreeTable} WHERE ${rtreeTable}.id = ${parentTable}.rowid AND ${rtreeTable}.min_d1 >= ${minX} AND ${rtreeTable}.max_d1 <= ${maxX} AND ${rtreeTable}.min_d2 >= ${minY} AND ${rtreeTable}.max_d2 <= ${maxY})`;

    case '&&': // Overlaps: data box overlaps query box
      return `EXISTS (SELECT 1 FROM ${rtreeTable} WHERE ${rtreeTable}.id = ${parentTable}.rowid AND ${rtreeTable}.max_d1 >= ${minX} AND ${rtreeTable}.min_d1 <= ${maxX} AND ${rtreeTable}.max_d2 >= ${minY} AND ${rtreeTable}.min_d2 <= ${maxY})`;

    case '~=': // Same as: points identical
      return `EXISTS (SELECT 1 FROM ${rtreeTable} WHERE ${rtreeTable}.id = ${parentTable}.rowid AND ${rtreeTable}.min_d1 = ${x1} AND ${rtreeTable}.max_d1 = ${x1} AND ${rtreeTable}.min_d2 = ${y1} AND ${rtreeTable}.max_d2 = ${y1})`;
    // For ~= (point equality), bounds = [x, x, y, y] so x1==x2==x, y1==y2==y

    case '@>': // Contains: data box contains query point/box
      return `EXISTS (SELECT 1 FROM ${rtreeTable} WHERE ${rtreeTable}.id = ${parentTable}.rowid AND ${rtreeTable}.min_d1 <= ${minX} AND ${rtreeTable}.max_d1 >= ${maxX} AND ${rtreeTable}.min_d2 <= ${minY} AND ${rtreeTable}.max_d2 >= ${maxY})`;

    case '~': // Matches: similar to overlaps (bounding box match)
      return `EXISTS (SELECT 1 FROM ${rtreeTable} WHERE ${rtreeTable}.id = ${parentTable}.rowid AND ${rtreeTable}.min_d1 <= ${minX} AND ${rtreeTable}.max_d1 >= ${maxX} AND ${rtreeTable}.min_d2 <= ${minY} AND ${rtreeTable}.max_d2 >= ${maxY})`;

    default:
      return '';
  }
}

/**
 * Register an R-tree index for query rewriting.
 * Maps a column name (fully qualified or not) to its associated R-tree table.
 */
const rtreeIndexRegistry = new Map<string, GiSTQueryRewrite>();

/**
 * Register a GiST spatial index in the query rewrite registry.
 * This allows `rewriteGiSTQuery` to find the corresponding R-tree table
 * for spatial operator rewriting.
 *
 * @param queryRewrite - GiST query rewrite info (from rewriteGiST result)
 *
 * @example
 * ```ts
 * registerRTreeIndex(rewriteGiST('CREATE INDEX ...').queryRewrite);
 * // Now spatial queries with this column will be rewritten
 * ```
 */
export function registerRTreeIndex(queryRewrite?: GiSTQueryRewrite): void {
  if (!queryRewrite) return;

  // Register by unqualified column name
  rtreeIndexRegistry.set(queryRewrite.idxColumn, queryRewrite);

  // Register by qualified name (table.column)
  rtreeIndexRegistry.set(`${queryRewrite.parentTable}.${queryRewrite.idxColumn}`, queryRewrite);
}

/**
 * Unregister an R-tree index (e.g. on DROP INDEX).
 */
export function unregisterRTreeIndex(idxColumn: string, parentTable?: string): void {
  rtreeIndexRegistry.delete(idxColumn);
  if (parentTable) {
    rtreeIndexRegistry.delete(`${parentTable}.${idxColumn}`);
  }
}

/**
 * Look up the R-tree index registration for a given column name.
 */
function lookupRTreeIndex(colName: string): GiSTQueryRewrite | undefined {
  // Try exact match first
  const exact = rtreeIndexRegistry.get(colName);
  if (exact) return exact;

  // Try unqualified match (if qualified was given)
  if (colName.includes('.')) {
    const parts = colName.split('.');
    const unqualified = parts[parts.length - 1];
    return rtreeIndexRegistry.get(unqualified);
  }

  return undefined;
}

/**
 * Rewrite a SELECT/UPDATE/DELETE query to use R-tree spatial indexes.
 *
 * Detects GiST spatial operators in WHERE clauses and rewrites them to
 * use the registered R-tree virtual tables.
 *
 * Supports multiple spatial operators in a single query by iterating
 * until no more rewrites are found (handles overlapping matches).
 *
 * @param sql - A SQL query with potential spatial operators
 * @returns Rewritten query or original if no spatial operators found
 *
 * @example
 * ```ts
 * // Before:
 * //   SELECT * FROM locations WHERE coord <@ box(0,0,100,100)
 * // After:
 * //   SELECT * FROM locations WHERE EXISTS (SELECT 1 FROM __rtree_idx WHERE ...)
 * ```
 */
export function rewriteGiSTQuery(sql: string): QueryRewriteResult {
  const usedTables: string[] = [];

  // Skip non-SELECT/UPDATE/DELETE
  const stmtType = sql.trim().match(/^\s*(SELECT|UPDATE|DELETE)\b/i);
  if (!stmtType) {
    return { rewritten: false, sql, rtreeTables: [] };
  }

  let rewritten = sql;
  let didRewrite = false;

  // Iterate multiple passes to catch multiple spatial operators in one query.
  // Each pass replaces the first unprocessed match found.
  let passChanged = true;
  while (passChanged) {
    passChanged = false;

    // Try to match box-based spatial operators: <@, &&, @>, ~
    rewritten = rewritten.replace(SPATIAL_OP_BOX_PATTERN, (match, colName: string, op: string, ...args: string[]) => {
      // Don't rewrite if already rewritten (avoid infinite loop)
      if (match.startsWith('EXISTS (SELECT')) return match;

      const bounds: number[] = args.slice(0, 4).filter(v => v !== undefined).map(Number);
      if (bounds.length !== 4 || bounds.some(isNaN)) return match;

      const rewrite = lookupRTreeIndex(colName);
      if (!rewrite) return match;

      // If colName is qualified (table.col), use just the table part
      const tableRef = colName.includes('.') ? colName.split('.')[0] : rewrite.parentTable;

      const subquery = buildRTreeSpatialWhere(rewrite.rtreeTable, tableRef, op, bounds);
      if (subquery) {
        didRewrite = true;
        passChanged = true;
        if (!usedTables.includes(rewrite.rtreeTable)) {
          usedTables.push(rewrite.rtreeTable);
        }
        return subquery;
      }
      return match;
    });

    // Try to match point-based operators: ~= (same as)
    rewritten = rewritten.replace(SPATIAL_OP_POINT_PATTERN, (match, colName: string, op: string, xStr: string, yStr: string) => {
      // Don't rewrite if already rewritten
      if (match.startsWith('EXISTS (SELECT')) return match;

      const x = Number(xStr);
      const y = Number(yStr);
      if (isNaN(x) || isNaN(y)) return match;

      const rewrite = lookupRTreeIndex(colName);
      if (!rewrite) return match;

      const tableRef = colName.includes('.') ? colName.split('.')[0] : rewrite.parentTable;

      // For ~= (same as), bounds = [x, y, x, y] matching [x1, y1, x2, y2] destructure
      const subquery = buildRTreeSpatialWhere(rewrite.rtreeTable, tableRef, op, [x, y, x, y]);
      if (subquery) {
        didRewrite = true;
        passChanged = true;
        if (!usedTables.includes(rewrite.rtreeTable)) {
          usedTables.push(rewrite.rtreeTable);
        }
        return subquery;
      }
      return match;
    });
  }

  if (!didRewrite) {
    return { rewritten: false, sql, rtreeTables: [] };
  }

  return { rewritten: true, sql: rewritten, rtreeTables: usedTables };
}

/**
 * Clear the R-tree index registry (useful for testing).
 */
export function clearRTreeRegistry(): void {
  rtreeIndexRegistry.clear();
}

/**
 * Clear all geometry format overrides (useful for testing).
 */
export function clearGeometryFormats(): void {
  geometryFormatMap.clear();
}

// ──────────────────────────────────────────────
//  GiST KNN Distance Operator (ORDER BY <->)
// ──────────────────────────────────────────────

/**
 * Regex to detect the `<->` distance operator in SQL.
 * Matches patterns like:
 *   `col <-> POINT(10,20)`
 *   `geom <-> point(10,20)`
 *   `l.coord <-> POINT(10,20)`
 */
const DISTANCE_OP_PATTERN = /([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*<->\s*(?:POINT|point)\(\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)/i;

/**
 * Detect whether the given SQL string contains a GiST-style distance operator
 * (`<->`) typically used in KNN (K-Nearest Neighbor) queries.
 *
 * Example patterns:
 *   `ORDER BY geom <-> POINT(10,20)`
 *   `ORDER BY coord <-> point(10,20)`
 *
 * @param sql - Raw SQL string to inspect
 * @returns `true` if the SQL contains a `<-> POINT(...)` expression
 */
export function isDistanceOperator(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  return DISTANCE_OP_PATTERN.test(sql);
}

/**
 * Result of KNN distance query rewriting.
 */
export interface KnnRewriteResult {
  /** Rewritten SQL string */
  sql: string;
  /** Whether the query was rewritten */
  rewritten: boolean;
  /** Extracted column name used for distance */
  distanceColumn: string;
  /** Extracted point x coordinate */
  pointX: number;
  /** Extracted point y coordinate */
  pointY: number;
  /** Limit value */
  limit: number;
}

/**
 * Rewrite a KNN (K-Nearest Neighbor) ORDER BY distance query to a
 * SQLite-compatible form.
 *
 * Detects the pattern:
 *   `ORDER BY col <-> POINT(x,y) LIMIT n`
 *
 * And rewrites it to compute Euclidean distance in the ORDER BY clause:
 *   `ORDER BY sqrt((col_x - x)*(col_x - x) + (col_y - y)*(col_y - y)) LIMIT n`
 *
 * When a registered R*Tree index exists for the column, adds a spatial
 * pre-filter using the R*Tree to limit the candidate set for efficient
 * nearest-neighbor search.
 *
 * @param sql - The raw SQL query to rewrite
 * @returns A {@link KnnRewriteResult} with the rewritten SQL and metadata
 *
 * @example
 * ```ts
 * isDistanceOperator("SELECT * FROM t ORDER BY geom <-> POINT(10,20) LIMIT 5");
 * // → true
 *
 * rewriteKnnOrderBy("SELECT * FROM t ORDER BY geom <-> POINT(10,20) LIMIT 5");
 * // → rewritten SQL with Euclidean distance in ORDER BY
 * ```
 */
export function rewriteKnnOrderBy(sql: string): KnnRewriteResult {
  const result: KnnRewriteResult = {
    sql,
    rewritten: false,
    distanceColumn: '',
    pointX: 0,
    pointY: 0,
    limit: 0,
  };

  if (typeof sql !== 'string' || sql.trim().length === 0) return result;

  const trimmed = sql.trim();

  // Step 1: Detect the distance operator pattern
  const match = DISTANCE_OP_PATTERN.exec(trimmed);
  if (!match) return result;

  const [, colName, xStr, yStr] = match;
  const x = parseFloat(xStr);
  const y = parseFloat(yStr);

  if (isNaN(x) || isNaN(y)) return result;

  result.distanceColumn = colName;
  result.pointX = x;
  result.pointY = y;

  // Step 2: Extract LIMIT
  const limitMatch = trimmed.match(/\bLIMIT\s+(\d+)\b/i);
  const limit = limitMatch ? parseInt(limitMatch[1], 10) : 10;
  result.limit = limit;

  // Step 3: Extract the column extraction expressions for x and y
  // The data coordinates are stored as "x y" in the column (point_xy format).
  // We extract them for distance computation.
  const colRef = colName.includes('.') ? colName : colName;
  const colX = `CAST(SUBSTR(${colRef}, 1, INSTR(${colRef}, ' ') - 1) AS REAL)`;
  const colY = `CAST(SUBSTR(${colRef}, INSTR(${colRef}, ' ') + 1) AS REAL)`;

  // Step 4: Build the Euclidean distance expression
  const distExpr = `SQRT((${colX} - ${x}) * (${colX} - ${x}) + (${colY} - ${y}) * (${colY} - ${y}))`;

  // Step 5: Check for an R*Tree index on the column and add pre-filtering
  const rtreeInfo = lookupRTreeIndex(colName);

  let rtreeFilter = '';
  if (rtreeInfo) {
    // Use the R-tree to compute an initial bounding box around the query point
    // Add a generous search radius (will be refined by ORDER BY)
    // We use a default radius that covers a large area
    const searchRadius = Math.max(Math.abs(x), Math.abs(y), 1000) * 2 + 1000;
    const minX = x - searchRadius;
    const maxX = x + searchRadius;
    const minY = y - searchRadius;
    const maxY = y + searchRadius;

    rtreeFilter = ` AND EXISTS (SELECT 1 FROM ${rtreeInfo.rtreeTable} r WHERE r.id = ${rtreeInfo.parentTable}.rowid AND r.min_d1 >= ${minX} AND r.max_d1 <= ${maxX} AND r.min_d2 >= ${minY} AND r.max_d2 <= ${maxY})`;
  }

  // Step 6: Replace the ORDER BY clause
  // The ORDER BY <-> POINT(x,y) is replaced by:
  //   ORDER BY SQRT((col_x - x)^2 + (col_y - y)^2)
  let rewritten = trimmed.replace(DISTANCE_OP_PATTERN, distExpr);

  // Step 7: Add R-tree pre-filter if available
  // The R-tree filter needs to be inserted before any GROUP BY or ORDER BY
  if (rtreeFilter) {
    // Insert after the WHERE clause (or after table name if no WHERE)
    const whereMatch = rewritten.match(/\bWHERE\b/i);
    if (whereMatch) {
      // Insert the R-tree filter after the WHERE clause content
      // Find the position after WHERE conditions, before ORDER BY / GROUP BY / LIMIT
      const orderByPos = rewritten.search(/\bORDER\s+BY\b/i);
      const groupByPos = rewritten.search(/\bGROUP\s+BY\b/i);
      const havingPos = rewritten.search(/\bHAVING\b/i);
      const limitPos = rewritten.search(/\bLIMIT\b/i);

      const insertPositions = [orderByPos, groupByPos, havingPos, limitPos]
        .filter(p => p >= 0);
      const insertPos = insertPositions.length > 0
        ? Math.min(...insertPositions)
        : rewritten.length;

      if (insertPos >= 0 && insertPos <= rewritten.length) {
        rewritten = rewritten.slice(0, insertPos) + rtreeFilter + ' ' + rewritten.slice(insertPos);
      }
    } else {
      // No WHERE clause, add one with R-tree filter before ORDER BY
      const orderByPos = rewritten.search(/\bORDER\s+BY\b/i);
      if (orderByPos >= 0) {
        rewritten = rewritten.slice(0, orderByPos) + `WHERE 1=1${rtreeFilter} ` + rewritten.slice(orderByPos);
      }
    }
  }

  // Ensure LIMIT is present
  if (!/\bLIMIT\b/i.test(rewritten)) {
    rewritten += ` LIMIT ${limit}`;
  }

  result.sql = rewritten;
  result.rewritten = true;

  return result;
}

// ──────────────────────────────────────────────────────────────
//  GiST Index Runtime — in-memory rbush-based R-tree
// ──────────────────────────────────────────────────────────────

import * as rbush from 'rbush';
// Re-export rbush module for use by index runtime
export { rbush };

/**
 * Represents a single entry in the GiST index.
 */
export interface GiSTIndexEntry {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  rowid: number;
  /** Original value for post-filtering (e.g., the range string or geometry WKT) */
  value: string;
  /** Type hint: 'point' | 'range' | 'geometry' */
  typeHint: string;
}

/**
 * Operator types supported by the GiST index runtime.
 */
export type GiSTOperator = '&&' | '@>' | '<@' | '=' | '~=';

/**
 * In-memory GiST index using rbush (dynamic R-tree).
 *
 * Supports:
 *   - Point data (2D points)
 *   - Range data (int4range, numrange encoded as 1D segments)
 *   - Geometry bounding boxes
 *
 * For simple types (non-range, non-geometry), falls back to a B-tree-like
 * sorted map.
 */
export class GiSTIndexRuntime {
  private rtree: any;
  /** Fallback index for non-spatial types: value → Set<rowid> */
  private fallback: Map<string, Set<number>> = new Map();
  /** Column type classification */
  private colType: 'spatial' | 'range' | 'simple';
  private size = 0;

  /**
   * @param colType - The type of data this index will store
   */
  constructor(colType: 'spatial' | 'range' | 'simple' = 'spatial') {
    this.rtree = new rbush.default();
    this.colType = colType;
  }

  /**
   * Insert a row into the GiST index.
   *
   * @param rowid - Row identifier
   * @param value - Raw value (e.g., "1 2" for point, "[1,10)" for range)
   */
  insert(rowid: number, value: string | null | undefined): void {
    if (value == null) return;

    if (this.colType === 'simple') {
      this._insertFallback(rowid, value);
      return;
    }

    const bbox = this._valueToBbox(value);
    if (!bbox) {
      this._insertFallback(rowid, value);
      return;
    }

    const entry: GiSTIndexEntry = {
      minX: bbox[0],
      maxX: bbox[1],
      minY: bbox[2],
      maxY: bbox[3],
      rowid,
      value,
      typeHint: this.colType,
    };
    this.rtree.insert(entry);
    this.size++;
  }

  /**
   * Remove a row from the GiST index.
   */
  remove(rowid: number, value: string | null | undefined): void {
    if (this.colType === 'simple' && value != null) {
      this._removeFallback(rowid, value);
      return;
    }

    if (value == null) {
      // Remove from fallback map
      for (const [v, rows] of this.fallback) {
        if (rows.has(rowid)) {
          rows.delete(rowid);
          if (rows.size === 0) this.fallback.delete(v);
          return;
        }
      }
      return;
    }

    const bbox = this._valueToBbox(value);
    if (bbox) {
      const candidate = { minX: bbox[0], maxX: bbox[1], minY: bbox[2], maxY: bbox[3], rowid, value, typeHint: this.colType };
      this.rtree.remove(candidate, (a: any, b: any) => a.rowid === b.rowid);
      this.size = Math.max(0, this.size - 1);
    } else {
      this._removeFallback(rowid, value);
    }
  }

  /**
   * Search the index using a GiST operator.
   *
   * @param op - GiST operator
   * @param queryValue - The query value to compare against
   * @returns Array of matching rowids
   */
  search(op: GiSTOperator, queryValue: string): number[] {
    if (this.colType === 'simple') {
      return this._searchFallback(op, queryValue);
    }

    const qBbox = this._valueToBbox(queryValue);
    if (!qBbox) {
      return this._searchFallback(op, queryValue);
    }

    const [qx1, qx2, qy1, qy2] = qBbox;

    switch (op) {
      case '&&': {
        // Overlap: search rbush and filter for actual overlap
        const results = this.rtree.search({ minX: qx1, maxX: qx2, minY: qy1, maxY: qy2 });
        return [...new Set(results.map((e: any) => e.rowid as number))] as number[];
      }
      case '@>': {
        // Contains: data must contain query — data bbox must fully cover query bbox
        const all = this.rtree.all();
        return all
          .filter((e: any) => e.minX <= qx1 && e.maxX >= qx2 && e.minY <= qy1 && e.maxY >= qy2)
          .map((e: any) => e.rowid);
      }
      case '<@': {
        // Contained-by: data must be within query — query bbox must fully cover data bbox
        const all = this.rtree.all();
        return all
          .filter((e: any) => qx1 <= e.minX && qx2 >= e.maxX && qy1 <= e.minY && qy2 >= e.maxY)
          .map((e: any) => e.rowid);
      }
      case '=':
      case '~=': {
        // Exact match: search for exact bounding box
        const results = this.rtree.search({
          minX: qx1, maxX: qx2, minY: qy1, maxY: qy2,
        });
        // Post-filter for exact value match
        return results
          .filter((e: any) => e.value === queryValue)
          .map((e: any) => e.rowid);
      }
      default:
        return [];
    }
  }

  /**
   * Get the total number of entries in the index.
   */
  getSize(): number {
    return this.size;
  }

  /**
   * Clear all entries from the index.
   */
  clear(): void {
    this.rtree = new rbush.default();
    this.fallback.clear();
    this.size = 0;
  }

  // ── Private helpers ──────────────────────────────

  /**
   * Convert a value string to a bounding box [minX, maxX, minY, maxY].
   *
   * Supports:
   *   - Point: "x y" or "POINT(x y)" → [x, x, y, y]
   *   - Range: "[low,high)" or "(low,high)" → [low, high, 0, 0]
   *   - Geometry: "BOX(x1 y1,x2 y2)" or WKT → parsed bbox
   */
  private _valueToBbox(value: string): number[] | null {
    const trimmed = value.trim();

    // Try WKT POINT(x y)
    const pointMatch = trimmed.match(/^POINT\s*\(\s*([\d.-]+)\s+([\d.-]+)\s*\)$/i);
    if (pointMatch) {
      const x = parseFloat(pointMatch[1]);
      const y = parseFloat(pointMatch[2]);
      if (isFinite(x) && isFinite(y)) return [x, x, y, y];
    }

    // Try POINT(x,y)
    const pointCommaMatch = trimmed.match(/^POINT\s*\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)$/i);
    if (pointCommaMatch) {
      const x = parseFloat(pointCommaMatch[1]);
      const y = parseFloat(pointCommaMatch[2]);
      if (isFinite(x) && isFinite(y)) return [x, x, y, y];
    }

    // Try "x y" (space-separated point)
    const spacePointMatch = trimmed.match(/^([\d.-]+)\s+([\d.-]+)$/);
    if (spacePointMatch) {
      const x = parseFloat(spacePointMatch[1]);
      const y = parseFloat(spacePointMatch[2]);
      if (isFinite(x) && isFinite(y)) return [x, x, y, y];
    }

    // Try "x,y" (comma-separated point)
    const commaPointMatch = trimmed.match(/^([\d.-]+)\s*,\s*([\d.-]+)$/);
    if (commaPointMatch) {
      const x = parseFloat(commaPointMatch[1]);
      const y = parseFloat(commaPointMatch[2]);
      if (isFinite(x) && isFinite(y)) return [x, x, y, y];
    }

    // Try range format: [low,high) or (low,high) or int4range(low,high)
    const rangeMatch = trimmed.match(/^[\[\(]\s*([\d.-]+)\s*,\s*([\d.-]+)\s*[\)\]]$|^int4range\s*\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)$/i);
    if (rangeMatch) {
      const low = parseFloat(rangeMatch[1] || rangeMatch[3]);
      const high = parseFloat(rangeMatch[2] || rangeMatch[4]);
      if (isFinite(low) && isFinite(high)) {
        // Encode range as 1D segment: x-axis = range space, y-axis = 0
        return [low, high, 0, 0];
      }
    }

    // Try numrange(low,high)
    const numrangeMatch = trimmed.match(/^numrange\s*\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)$/i);
    if (numrangeMatch) {
      const low = parseFloat(numrangeMatch[1]);
      const high = parseFloat(numrangeMatch[2]);
      if (isFinite(low) && isFinite(high)) return [low, high, 0, 0];
    }

    // Try simple numeric value (for 1D range equality)
    const numMatch = trimmed.match(/^([\d.-]+)$/);
    if (numMatch) {
      const n = parseFloat(numMatch[1]);
      if (isFinite(n)) return [n, n, 0, 0];
    }

    // Try BOX(x1 y1, x2 y2)
    const boxMatch = trimmed.match(/^BOX\s*\(\s*([\d.-]+)\s+([\d.-]+)\s*,\s*([\d.-]+)\s+([\d.-]+)\s*\)$/i);
    if (boxMatch) {
      const x1 = parseFloat(boxMatch[1]), y1 = parseFloat(boxMatch[2]);
      const x2 = parseFloat(boxMatch[3]), y2 = parseFloat(boxMatch[4]);
      if (isFinite(x1) && isFinite(y1) && isFinite(x2) && isFinite(y2)) {
        return [Math.min(x1, x2), Math.max(x1, x2), Math.min(y1, y2), Math.max(y1, y2)];
      }
    }

    return null;
  }

  private _insertFallback(rowid: number, value: string): void {
    if (!this.fallback.has(value)) {
      this.fallback.set(value, new Set());
    }
    this.fallback.get(value)!.add(rowid);
    this.size++;
  }

  private _removeFallback(rowid: number, value: string): void {
    const rows = this.fallback.get(value);
    if (rows) {
      rows.delete(rowid);
      if (rows.size === 0) this.fallback.delete(value);
      this.size = Math.max(0, this.size - 1);
    }
  }

  private _searchFallback(op: GiSTOperator, queryValue: string): number[] {
    switch (op) {
      case '=':
      case '~=':
      case '@>':
      case '<@': {
        const rows = this.fallback.get(queryValue);
        return rows ? [...rows] : [];
      }
      case '&&': {
        // For fallback, we can't easily do overlap. Return all rows with same value.
        const results: number[] = [];
        for (const [v, rows] of this.fallback) {
          if (v === queryValue) results.push(...rows);
        }
        return results;
      }
      default:
        return [];
    }
  }
}
