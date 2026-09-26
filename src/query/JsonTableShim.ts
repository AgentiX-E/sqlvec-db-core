/**
 * JsonTableShim — Rewrites PostgreSQL JSON_TABLE(...) COLUMNS(...) syntax
 * into equivalent SQLite-compatible SQL using json_each + json_extract.
 *
 * PostgreSQL 16 supports the SQL/JSON standard JSON_TABLE function:
 *
 * @example
 * ```sql
 * -- Original (PG 16):
 * SELECT jt.*
 * FROM json_table(
 *   '[{"a":1,"b":"x"},{"a":2,"b":"y"}]',
 *   '$[*]' COLUMNS (
 *     a int PATH '$.a',
 *     b text PATH '$.b'
 *   )
 * ) AS jt;
 *
 * -- Rewritten (SQLite):
 * SELECT *
 * FROM (
 *   SELECT json_extract(value, '$.a') AS a,
 *          json_extract(value, '$.b') AS b
 *   FROM json_each('[{"a":1,"b":"x"},{"a":2,"b":"y"}]')
 * ) AS jt;
 * ```
 *
 * Supported features:
 * - Simple flat JSON arrays with $[*] path
 * - Nested path expressions: $.a.b.c
 * - COLUMNS with name, optional type, PATH 'path'
 * - EXISTS columns (boolean check if path exists)
 * - ORDINALITY (FOR ORDINALITY / WITH ORDINALITY)
 * - Multiple JSON_TABLE in same query
 * - Nested PATH → CROSS JOIN json_each
 * - ON ERROR / ON EMPTY / ON NULL clauses (NULL ON ERROR, etc.)
 * - JSON tree recursion: $.stores[*].books[*].title
 *
 * Limitations:
 * - Strict mode is not supported (always treats as relaxed)
 * - Does not handle JSON_TABLE in subqueries with complex nesting
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('JsonTableShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface JsonTableRewriteResult {
  /** Rewritten SQL string (unchanged if no JSON_TABLE found) */
  sql: string;
  /** Whether JSON_TABLE was detected and rewritten */
  rewritten: boolean;
  /** Number of JSON_TABLE expressions rewritten */
  count: number;
}

// ──────────────────────────────────────────────
//  Interface for parsed JSON_TABLE components
// ──────────────────────────────────────────────

export interface JsonTableParsed {
  /** The JSON array/string argument */
  jsonString: string;
  /** Path expression (e.g., '$[*]') */
  pathExpr: string;
  /** Column definitions */
  columns: JsonTableColumn[];
  /** Nested path definitions with their sub-columns */
  nestedPaths: NestedPathInfo[];
  /** Alias name (e.g., 'jt') */
  alias: string;
  /** The full original text of this JSON_TABLE expression */
  originalText: string;
  /** Whether it has NESTED PATH columns */
  hasNestedPaths: boolean;
}

export interface JsonTableColumn {
  /** Column name */
  name: string;
  /** Column type (int, text, boolean, etc.) - may be empty */
  type: string;
  /** JSON path for extraction (e.g., '$.a') - may be empty for ORDINALITY */
  path: string;
  /** Column kind: 'regular', 'exists', 'ordinality', 'nested' */
  kind: 'regular' | 'exists' | 'ordinality' | 'nested';
  /** ON ERROR/EMPTY/NULL clause (e.g., 'NULL ON ERROR', 'DEFAULT 0 ON EMPTY') */
  onClause: string;
}

export interface NestedPathInfo {
  /** The NESTED PATH expression (e.g., '$.items[*]') */
  path: string;
  /** Columns within this nested path */
  columns: JsonTableColumn[];
}

// ──────────────────────────────────────────────
//  Constants – Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches individual column definitions within the COLUMNS block.
 *
 * Patterns:
 * - colname type PATH 'path' (regular column)
 * - colname type EXISTS PATH 'path' (EXISTS column)
 * - colname FOR ORDINALITY (ORDINALITY column)
 * - NESTED PATH 'path' COLUMNS (...) (nested path)
 */
/**
 * Column regex: captures column name, optional type, and PATH value.
 * Also captures ON ERROR / ON EMPTY / ON NULL clause if present.
 *
 * Group 1: column name
 * Group 2: optional type (with optional size, e.g., varchar(100))
 * Group 3: JSON path (e.g., $.a)
 * Group 4: ON clause (e.g., NULL ON ERROR, DEFAULT 'x' ON EMPTY) — captured as last part
 */
const COLUMN_REGEX = /(\w+)\s+(?:(\w+(?:\s*\(\s*\d*\s*\))?)\s+)?(?:EXISTS\s+)?PATH\s+'([^']*)'(\s+(?:NULL|DEFAULT\s+[^\s,)]+|ERROR)\s+(?:ON\s+ERROR|ON\s+EMPTY|ON\s+NULL))?/gi;

const ORDINALITY_REGEX = /(\w+)\s+FOR\s+ORDINALITY/gi;
const WITH_ORDINALITY_REGEX = /(\w+)\s+WITH\s+ORDINALITY/gi;
const NESTED_PATH_REGEX = /NESTED\s+PATH\s+'([^']*)'\s*COLUMNS\s*\(([\s\S]*?)\)/gi;

// ──────────────────────────────────────────────
//  Detection
// ──────────────────────────────────────────────

/**
 * Detect if a SQL statement contains JSON_TABLE usage.
 *
 * Uses the same literal-aware scan as `rewriteJsonTable` so that a
 * `json_table(` occurrence inside a string literal (or a JSON string argument
 * containing a doubled single-quote escape) is never mistaken for real syntax.
 *
 * @param sql - The SQL statement to check
 * @returns true if JSON_TABLE is detected
 */
export function detectJsonTable(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;

  // Quick pre-check for json_table keyword
  if (!/\bjson_table\s*\(/i.test(sql)) return false;

  // Literal-aware scan: skip string literals and comments so only a real
  // structural `json_table(` counts. Reuse findAllJsonTables (already
  // literal-aware) for a single source of truth.
  return findAllJsonTables(sql).length > 0;
}

// ──────────────────────────────────────────────
//  Parsing
// ──────────────────────────────────────────────

/**
 * Parse column definitions from a COLUMNS block.
 * Uses a fresh regex instance internally to avoid lastIndex pollution
 * from recursive calls.
 *
 * @param columnsBlock - The text inside COLUMNS(...)
 * @returns Object with columns array and nestedPaths array
 */
export function _parseColumns(columnsBlock: string): { columns: JsonTableColumn[]; nestedPaths: NestedPathInfo[] } {
  const columns: JsonTableColumn[] = [];
  const nestedPaths: NestedPathInfo[] = [];
  let trimmed = columnsBlock.trim();

  // Use a fresh regex instance to avoid lastIndex issues with recursive calls
  const nestedPathRe = /NESTED\s+PATH\s+'([^']*)'\s*COLUMNS\s*\(([\s\S]*?)\)/i;

  // Collect all NESTED PATH definitions and their positions for removal
  let match: RegExpExecArray | null;
  const nestedMatches: Array<{ match: RegExpExecArray; index: number }> = [];

  // Need a global regex to find all, but reset lastIndex between calls
  const globalNestedRe = new RegExp(nestedPathRe.source, 'g' + (nestedPathRe.flags.includes('i') ? 'i' : ''));
  
  // Extract NESTED PATH definitions (run before column parsing to avoid
  // the NESTED keyword being incorrectly captured as a column name)
  while ((match = globalNestedRe.exec(trimmed)) !== null) {
    // Deep clone the match object since it will be overwritten
    const capturedMatch: RegExpExecArray = [match[0], match[1], match[2]] as unknown as RegExpExecArray;
    capturedMatch.index = match.index;
    capturedMatch.input = match.input;
    nestedMatches.push({ match: capturedMatch, index: match.index });
  }

  // Process nested paths (use fresh regex to avoid lastIndex pollution)
  for (const { match: nm } of nestedMatches) {
    const nestedPathStr = nm[1];
    const nestedColumnsBlock = nm[2];
    const nestedResult = _parseColumns(nestedColumnsBlock);
    // Mark all nested columns with kind='nested'
    for (const col of nestedResult.columns) {
      const adjustedPath = col.path && !col.path.startsWith('$.')
        ? nestedPathStr.replace(/\[.*?\]$/, '') + '.' + col.path.replace(/^\./, '')
        : col.path;
      columns.push({
        name: col.name,
        type: col.type,
        path: adjustedPath,
        kind: 'nested',
        onClause: col.onClause || '',
      });
    }
    nestedPaths.push({
      path: nestedPathStr,
      columns: nestedResult.columns.map(c => ({ ...c, kind: 'nested' as const })),
    });
  }

  // Remove NESTED PATH blocks from the main columns text for regular parsing
  // by iteratively replacing each matched text
  let mainColumnsText = trimmed;
  for (const { match: nm } of nestedMatches) {
    mainColumnsText = mainColumnsText.replace(nm[0], '');
  }

  // Parse ORDINALITY columns (FOR ORDINALITY syntax)
  ORDINALITY_REGEX.lastIndex = 0;
  let ordinalMatch: RegExpExecArray | null;
  while ((ordinalMatch = ORDINALITY_REGEX.exec(mainColumnsText)) !== null) {
    columns.push({
      name: ordinalMatch[1].trim(),
      type: '',
      path: '',
      kind: 'ordinality',
      onClause: '',
    });
  }

  // Parse WITH ORDINALITY syntax (alternative form)
  WITH_ORDINALITY_REGEX.lastIndex = 0;
  let withOrdinalMatch: RegExpExecArray | null;
  while ((withOrdinalMatch = WITH_ORDINALITY_REGEX.exec(mainColumnsText)) !== null) {
    columns.push({
      name: withOrdinalMatch[1].trim(),
      type: '',
      path: '',
      kind: 'ordinality',
      onClause: '',
    });
  }

  // Parse regular and EXISTS columns
  COLUMN_REGEX.lastIndex = 0;
  let colMatch: RegExpExecArray | null;
  while ((colMatch = COLUMN_REGEX.exec(mainColumnsText)) !== null) {
    const name = colMatch[1].trim();
    const type = colMatch[2] ? colMatch[2].trim() : '';
    const path = colMatch[3].trim();
    const onClause = colMatch[4] ? colMatch[4].trim() : '';

    // Check if this is an EXISTS column by looking at the original text
    const afterMatch = mainColumnsText.substring(
      colMatch.index,
      colMatch.index + colMatch[0].length + 10,
    );
    const isExists = /\bEXISTS\b/i.test(afterMatch.substring(0, colMatch[0].length + 5));

    columns.push({
      name,
      type,
      path,
      kind: isExists ? 'exists' : 'regular',
      onClause,
    });
  }

  return { columns, nestedPaths };
}

// ──────────────────────────────────────────────
//  SQL Rewriting
// ──────────────────────────────────────────────

/**
 * Extracts the type-less alias for a column.
 * In the rewritten SQL, we strip PG type declarations.
 *
 * @param colType - PG type (e.g., 'int', 'text', 'varchar(100)')
 * @returns cleaned type for CAST() or empty
 */
export function _getSqliteCastType(colType: string): string {
  if (!colType) return '';
  const cleanType = colType.replace(/\(.*?\)/, '').trim().toLowerCase();

  switch (cleanType) {
    case 'int':
    case 'integer':
    case 'int4':
    case 'int8':
    case 'bigint':
    case 'smallint':
    case 'serial':
    case 'bigserial':
      return 'INTEGER';
    case 'real':
    case 'float':
    case 'float4':
    case 'float8':
    case 'double':
    case 'numeric':
    case 'decimal':
      return 'REAL';
    case 'boolean':
    case 'bool':
      return 'INTEGER'; // SQLite uses 0/1 for booleans
    case 'text':
    case 'varchar':
    case 'char':
    case 'character varying':
    case 'name':
    case 'json':
    case 'jsonb':
      return 'TEXT';
    default:
      return '';
  }
}

/**
 * Resolve an ON ERROR / ON EMPTY / ON NULL clause for a column extraction.
 *
 * PG JSON_TABLE defaults:
 * - NULL ON ERROR (default): return NULL if JSON path doesn't exist or is invalid
 * - ERROR ON ERROR: raise error (we can't replicate, use NULL as fallback)
 * - DEFAULT expr ON ERROR: return default value
 *
 * For SQLite, we wrap json_extract with CASE/COALESCE to handle these:
 * - NULL ON ERROR / NULL ON EMPTY / NULL ON NULL → default behavior of json_extract
 * - DEFAULT 'x' ON ERROR → COALESCE(json_extract(...), 'x')
 * - ERROR ON ERROR → we can't raise an error in SQLite, use NULL as best-effort
 *
 * @param onClause - The ON clause text, e.g. 'NULL ON ERROR', 'DEFAULT 0 ON EMPTY'
 * @param extractExpr - The column extraction expression
 * @returns Expression with ON clause applied
 */
export function _applyOnClause(onClause: string, extractExpr: string): string {
  if (!onClause) return extractExpr;

  const trimmedClause = onClause.trim();

  // NULL ON ERROR / NULL ON EMPTY / NULL ON NULL → no wrapping needed
  if (/^NULL\s+ON\s+(ERROR|EMPTY|NULL)$/i.test(trimmedClause)) {
    return extractExpr;
  }

  // ERROR ON ERROR / ERROR ON EMPTY / ERROR ON NULL → best effort (can't raise error)
  if (/^ERROR\s+ON\s+(ERROR|EMPTY|NULL)$/i.test(trimmedClause)) {
    logger.warn(
      { onClause: trimmedClause },
      'ERROR ON clause cannot be fully replicated in SQLite—using NULL fallback',
    );
    return extractExpr;
  }

  // DEFAULT expr ON ERROR / DEFAULT expr ON EMPTY / DEFAULT expr ON NULL
  const defaultMatch = trimmedClause.match(/^DEFAULT\s+(.+?)\s+ON\s+(ERROR|EMPTY|NULL)$/i);
  if (defaultMatch) {
    const defaultValue = defaultMatch[1].trim();
    return `COALESCE(${extractExpr}, ${defaultValue})`;
  }

  // Unknown/unsupported ON clause — keep extraction as-is
  logger.warn(
    { onClause: trimmedClause },
    'Unknown ON clause in JSON_TABLE column definition — ignoring',
  );
  return extractExpr;
}

/**
 * Build the extraction expression for a single column.
 *
 * @param col - Parsed column definition
 * @returns SQL expression for extracting the column value
 */
export function _buildColumnExtract(col: JsonTableColumn): string {
  switch (col.kind) {
    case 'ordinality':
      return `ROW_NUMBER() OVER ()`;
    case 'exists': {
      const path = col.path || '$.dummy';
      const existsExpr = `CASE WHEN json_extract(value, '${_escapeJsonPath(path)}') IS NOT NULL THEN 1 ELSE 0 END`;
      return _applyOnClause(col.onClause, existsExpr);
    }
    case 'nested': {
      // For nested columns, extract from the nested value
      const path = col.path || '$."' + col.name + '"';
      const extracted = `json_extract(value, '${_escapeJsonPath(path)}')`;
      return _applyOnClause(col.onClause, extracted);
    }
    case 'regular':
    default: {
      const path = col.path || '$."' + col.name + '"';
      let extracted = `json_extract(value, '${_escapeJsonPath(path)}')`;
      // Apply ON clause before CAST
      extracted = _applyOnClause(col.onClause, extracted);
      // Apply CAST if type is specified
      const castType = _getSqliteCastType(col.type);
      if (castType) {
        if (col.onClause && /^DEFAULT\s+/i.test(col.onClause.trim())) {
          // For DEFAULT ON clause, wrap entire COALESCE with CAST
          return `CAST(${extracted} AS ${castType})`;
        }
        return `CAST(${extracted} AS ${castType})`;
      }
      return extracted;
    }
  }
}

/**
 * Escape a JSON path for use in SQLite json_extract.
 * Standard JSON path notation (dot-delimited, bracket notation for arrays)
 * is valid in SQLite json_extract, so only handle edge cases.
 */
export function _escapeJsonPath(path: string): string {
  if (!path || path === '$' || path === '$[*]') return path;

  // Standard JSON path patterns that work in SQLite json_extract:
  // $.a, $.a.b, $.items[0].name, $.items[*].name, $[0].a, $."a b", etc.
  // These use standard dot/bracket notation, and an already-quoted property
  // name (e.g. `$."a b"`) is also valid, so no extra escaping is needed.
  if (/^\$(\.[\w_]+|\[.*?\])*$/.test(path)) {
    return path;
  }
  // Already-quoted property names: the JSON path already uses SQLite's
  // `."name"` syntax, so return it verbatim rather than double-quoting.
  if (/^\$(\."([^"]|"")*"|\.[\w_]+|\[.*?\])*$/.test(path)) {
    return path;
  }

  // Fallback: if path contains unusual characters, try to handle them
  // by preserving bracket notation and quoting property names with special chars
  const parts = path.split('.');
  const escaped = parts.map((part) => {
    if (part.startsWith('$') || part.startsWith('[')) {
      return part; // Keep $, [*], [0] etc. as-is
    }
    // Check if segment needs quoting (has special chars or is empty)
    if (/^[\w_][\w\d_]*$/.test(part)) {
      // Simple identifier - use dot notation
      return part;
    }
    // Complex path segment - use bracket notation
    return `"${part.replace(/"/g, '\\"')}"`;
  });

  return escaped.join('.');
}

/**
 * Get the SQLite json_each source expression from the JSON string argument.
 *
 * @param jsonStr - The JSON string literal (e.g., "'[{\"a\":1}]'")
 * @returns The SQLite json_each expression
 */
function buildJsonEachSource(jsonStr: string): string {
  return `json_each(${jsonStr})`;
}

/**
 * Determine whether a JSON path expression contains wildcard array iteration markers ($[*]).
 * Used to distinguish between simple extraction paths and iteration paths.
 */
export function _hasWildcardIteration(path: string): boolean {
  return /\[\*\]/.test(path);
}

/**
 * Extract the base path up to a wildcard iteration point.
 * e.g., '$.stores[*].books[*].title' → ['$.stores', 'stores']
 */
export function _extractIterationBase(path: string): string {
  const starIndex = path.indexOf('[*]');
  if (starIndex < 0) return path;
  return path.substring(0, starIndex);
}

/**
 * Build a recursive json_each chain for multi-level [*] paths.
 *
 * For path $.stores[*].books[*].title, we need:
 * ```
 * SELECT json_extract(books_nested.value, '$.title') AS title
 * FROM json_each(...) AS base,
 *      json_each(json_extract(base.value, '$.stores')) AS stores,
 *      json_each(json_extract(stores.value, '$.books')) AS books
 * ```
 *
 * @param fullPath - The full JSON path (e.g., $.stores[*].books[*].title)
 * @returns Structured info about the iteration chain
 */
export function _parseIterationPath(fullPath: string): {
  segments: string[];         // path segments: ['stores', 'books']
  finalKey: string;           // final property key: 'title'
  aliasChain: string[];       // alias for each level: ['_lv0', '_lv1']
  extractFrom: string;        // which alias to extract the final value from
} {
  // Remove leading $
  let path = fullPath.replace(/^\$\.?/, '');
  // Split by [*] to get iteration points
  const parts = path.split('[*]');
  const segments: string[] = [];
  const aliasChain: string[] = ['_jt_value']; // start from the json_each of the input

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].replace(/^\./, '').replace(/\.$/, '').trim();
    if (part) {
      segments.push(part);
      if (i < parts.length - 1) {
        aliasChain.push(`_lv${i}`);
      }
    }
  }

  // The final segment is the property to extract
  const finalKey = segments.length > 0 ? segments[segments.length - 1] : '';
  const iterationKeys = segments.slice(0, -1); // all segments except the last one

  // The value to extract finalKey from
  const extractFrom = iterationKeys.length > 0
    ? aliasChain[aliasChain.length - 1]
    : '_jt_value';

  return { segments, finalKey, aliasChain, extractFrom };
}

/**
 * Build FROM clause for iterative [*] paths with CROSS JOIN json_each chain.
 *
 * @param jsonStr - The JSON string
 * @param iterationPath - The iteration path info
 * @param baseAlias - The alias for the base json_each
 * @returns SQL fragment for FROM clause
 */
export function _buildIterationFromClause(
  jsonStr: string,
  path: string,
  baseAlias: string,
): string {
  const { segments } = _parseIterationPath(path);
  const iterationKeys = segments.slice(0, -1); // all except final property

  if (iterationKeys.length === 0) {
    // Single-level [*], just use json_each directly
    return `json_each(${jsonStr}) AS ${baseAlias}`;
  }

  // Multi-level iteration
  const parts: string[] = [];
  parts.push(`json_each(${jsonStr}) AS ${baseAlias}`);

  for (let i = 0; i < iterationKeys.length; i++) {
    const key = iterationKeys[i];
    const parentAlias = i === 0 ? baseAlias : `_lv${i - 1}`;
    const currentAlias = `_lv${i}`;
    parts.push(
      `CROSS JOIN json_each(json_extract(${parentAlias}.value, '$.${key}')) AS ${currentAlias}`,
    );
  }

  return parts.join('\n         ');
}

/**
 * Rewrite a single JSON_TABLE expression into a SQLite-compatible
 * parenthesized subquery expression ready for use in a FROM clause.
 *
 * @param parsed - Parsed JSON_TABLE components
 * @returns Rewritten SQL fragment — a parenthesized subquery with alias
 */
/**
 * Detect if any column path contains multi-level [*] iteration.
 * e.g., $.stores[*].books[*].title has 2 levels of iteration.
 */
export function _hasMultiLevelIteration(parsed: JsonTableParsed): boolean {
  if (parsed.hasNestedPaths) return true;
  for (const col of parsed.columns) {
    if (col.path && (col.path.match(/\[\*\]/g) || []).length >= 2) {
      return true;
    }
  }
  return false;
}

/**
 * Rewrite a single JSON_TABLE expression into a SQLite-compatible
 * parenthesized subquery expression ready for use in a FROM clause.
 *
 * @param parsed - Parsed JSON_TABLE components
 * @returns Rewritten SQL fragment — a parenthesized subquery with alias
 */
export function _rewriteSingleJsonTable(parsed: JsonTableParsed): string {
  if (parsed.columns.length === 0) {
    logger.warn('JSON_TABLE with no columns — returning empty result');
    // Empty column set: return subquery that produces no rows
    return `(SELECT 1 WHERE 0) AS ${parsed.alias || 'jt'}`;
  }

  const jsonEachSource = buildJsonEachSource(parsed.jsonString);
  const alias = parsed.alias || 'jt';

  // Handle JSON tree recursion (multi-level [*] paths)
  if (_hasMultiLevelIteration(parsed)) {
    if (parsed.hasNestedPaths && parsed.nestedPaths.length > 0) {
      // NESTED PATH with multi-level — build CROSS JOIN chain
      const regularCols = parsed.columns.filter(c => c.kind !== 'nested');
      const regularSelectExprs = regularCols.map(c =>
        `${_buildColumnExtract(c)} AS ${c.name}`
      );
      const nestedSelectExprs = parsed.nestedPaths.flatMap(np =>
        np.columns.map(c =>
          `${_buildColumnExtract(c)} AS ${c.name}`
        )
      );
      const allSelects = [...regularSelectExprs, ...nestedSelectExprs].join(',\n       ');

      // Build nested path CROSS JOIN chain
      // For each NESTED PATH, we need CROSS JOIN json_each
      const nestedJoins = parsed.nestedPaths.map((np, idx) => {
        const nestedAlias = `${alias}_n${idx}`;
        const extractPath = np.path.replace(/\[\*\]$/, '');
        return `CROSS JOIN json_each(
    CASE WHEN json_type(${alias}.value, '${_escapeJsonPath(extractPath)}') IS NOT NULL
         THEN json_extract(${alias}.value, '${_escapeJsonPath(extractPath)}')
         ELSE '[]'
    END
  ) AS ${nestedAlias}`;
      }).join('\n         ');

      return `(
  SELECT ${allSelects}
  FROM json_each(${parsed.jsonString}) AS ${alias}
  ${nestedJoins}
) AS ${alias}`;
    }

    // Multi-level [*] in column paths (no NESTED PATH syntax)
    // This handles paths like $.stores[*].books[*].title
    // Pick the first column with a multi-level path to determine iteration structure
    const multiLevelCol = parsed.columns.find(
      c => c.path && (c.path.match(/\[\*\]/g) || []).length >= 2
    );
    if (multiLevelCol) {
      const { segments } = _parseIterationPath(multiLevelCol.path);
      const iterationKeys = segments.slice(0, -1); // all except final key

      // Build FROM with cross-join chain
      let fromClause = `json_each(${parsed.jsonString}) AS ${alias}`;
      for (let i = 0; i < iterationKeys.length; i++) {
        const key = iterationKeys[i];
        const prevAlias = i === 0 ? alias : `_lv${i - 1}`;
        fromClause += `\n         CROSS JOIN json_each(json_extract(${prevAlias}.value, '$.${key}')) AS _lv${i}`;
      }

      // Build SELECT expressions - each column needs to pick the right level
      const selectExprs = parsed.columns.map(col => {
        if (!col.path) {
          return `${_buildColumnExtract(col)} AS ${col.name}`;
        }
        const wildcardCount = (col.path.match(/\[\*\]/g) || []).length;

        if (wildcardCount >= 2) {
          // Multi-level path: extract from the right level
          const { extractFrom } = _parseIterationPath(col.path);
          const finalPath = col.path.replace(/\[\*\]/g, ''); // strip wildcards
          // Re-extract using the correct alias
          const lastSegment = segments[segments.length - 1];
          const depth = wildcardCount;
          const sourceAlias = depth >= 2 ? `_lv${depth - 1}` : alias;
          const extractExpr = `json_extract(${sourceAlias}.value, '$.${lastSegment}')`;
          const castType = _getSqliteCastType(col.type);
          let expr = _applyOnClause(col.onClause, extractExpr);
          if (castType) expr = `CAST(${expr} AS ${castType})`;
          return `${expr} AS ${col.name}`;
        }

        // Single-level or simple path — extract from base json_each's value
        const expr = _buildColumnExtract(col);
        return `${expr} AS ${col.name}`;
      });

      return `(
  SELECT ${selectExprs.join(',\n         ')}
  FROM ${fromClause}
) AS ${alias}`;
    }
  }

  const selectExprs: string[] = [];
  for (const col of parsed.columns) {
    selectExprs.push(`${_buildColumnExtract(col)} AS ${col.name}`);
  }

  const selectList = selectExprs.join(',\n       ');

  // NOTE: NESTED PATH handling happens exclusively in the multi-level branch
  // above. `_hasMultiLevelIteration` returns true whenever `hasNestedPaths` is
  // true, so a parsed JSON_TABLE with NESTED PATH columns never reaches this
  // point — the simple case below is only for flat (non-nested) JSON_TABLEs.

  // Simple case: just json_each + json_extract
  return `(
  SELECT ${selectList}
  FROM json_each(${parsed.jsonString})
) AS ${alias}`;
}

/**
 * Extract a quoted string literal starting at `start`, returning its raw
 * text (including quotes) and the index just past the closing quote.
 *
 * Handles single quotes (with `''` and backslash escapes), double quotes, and
 * dollar-quoted strings. Returns null when `sql[start]` does not open a string.
 */
export function _readQuotedLiteral(sql: string, start: number): { raw: string; end: number } | null {
  const c = sql[start];
  if (c === "'" || c === '"') {
    const quote = c;
    let j = start + 1;
    while (j < sql.length) {
      if (quote === "'" && sql[j] === '\\' && j + 1 < sql.length) {
        j += 2; // E''-style escape
        continue;
      }
      if (sql[j] === quote) {
        if (sql[j + 1] === quote) { j += 2; continue; } // doubled-quote escape
        return { raw: sql.substring(start, j + 1), end: j + 1 };
      }
      j++;
    }
    return null; // unterminated
  }
  if (c === '$') {
    const end = skipSqlLiteral(sql, start);
    if (end !== -1 && end > start) {
      return { raw: sql.substring(start, end), end };
    }
    return null;
  }
  return null;
}

/**
 * Find all JSON_TABLE expressions in a SQL statement and parse them.
 *
 * Uses literal-aware scanning (via skipSqlLiteral) so that `json_table(`
 * occurrences inside string literals, and parentheses inside the JSON string
 * argument or column PATH literals, do not corrupt the structural parse.
 *
 * @param sql - The SQL statement
 * @returns Array of parsed JSON_TABLE components
 */
function findAllJsonTables(sql: string): JsonTableParsed[] {
  const results: JsonTableParsed[] = [];
  const len = sql.length;

  // Scan character-by-character so we can skip string literals and comments
  // and only treat a `json_table(` as structural when it is real SQL.
  let idx = 0;
  while (idx < len) {
    const skip = skipSqlLiteral(sql, idx);
    if (skip !== -1) {
      idx = skip;
      continue;
    }

    // Detect the `json_table(` keyword at the current position.
    if (/\bjson_table\s*\(/i.test(sql.slice(idx))) {
      const m = /\bjson_table\s*\(/i.exec(sql.slice(idx))!;
      const startIdx = idx + m.index;
      const functionBodyStart = startIdx + m[0].length;

      const parsed = parseJsonTableAt(sql, startIdx, functionBodyStart);
      if (parsed) {
        results.push(parsed);
        idx = startIdx + parsed.originalText.length;
        continue;
      }
    }

    idx++;
  }

  return results;
}

/**
 * Parse a single JSON_TABLE call whose keyword spans `[startIdx, functionBodyStart)`.
 * Returns the parsed structure (including `originalText` for replacement) or
 * null when the call is malformed.
 */
function parseJsonTableAt(
  sql: string,
  startIdx: number,
  functionBodyStart: number,
): JsonTableParsed | null {
  // ── First argument: the JSON string ──
  // Skip whitespace, then read a quoted literal.
  let p = functionBodyStart;
  while (p < sql.length && /\s/.test(sql[p])) p++;
  const jsonLit = _readQuotedLiteral(sql, p);
  if (!jsonLit) return null;
  const jsonString = jsonLit.raw;

  // Expect a comma after the JSON string.
  p = jsonLit.end;
  while (p < sql.length && /\s/.test(sql[p])) p++;
  if (sql[p] !== ',') return null;
  p++; // skip comma

  // ── Second argument: the root path ──
  while (p < sql.length && /\s/.test(sql[p])) p++;
  const pathLit = _readQuotedLiteral(sql, p);
  if (!pathLit) return null;
  const pathExpr = pathLit.raw;

  // ── Locate the COLUMNS keyword (literal-aware) ──
  p = pathLit.end;
  while (p < sql.length) {
    const skip = skipSqlLiteral(sql, p);
    if (skip !== -1) { p = skip; continue; }
    if (/\bCOLUMNS\s*\(/i.test(sql.slice(p))) {
      const cm = /\bCOLUMNS\s*\(/i.exec(sql.slice(p))!;
      p += cm.index + cm[0].length; // p now just past "COLUMNS("
      break;
    }
    p++;
  }
  if (p >= sql.length) return null;

  const colsBlockStart = p;

  // ── Find the matching close paren of the COLUMNS block (literal-aware) ──
  let depth = 1;
  let i = colsBlockStart;
  while (i < sql.length && depth > 0) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) { i = skip; continue; }
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth--;
    i++;
  }
  if (depth !== 0) return null; // unclosed COLUMNS block

  const columnsBlock = sql.substring(colsBlockStart, i - 1);

  // ── Find the matching close paren of the json_table( call ──
  // The COLUMNS block is closed; continue scanning for the single remaining
  // close paren that ends the json_table function.
  while (i < sql.length && /\s/.test(sql[i])) i++;
  if (sql[i] !== ')') return null;
  const fullMatchEnd = i + 1;
  const fullJsonTableText = sql.substring(startIdx, fullMatchEnd);

  // ── Alias (optional) ──
  const aliasMatch = sql.slice(fullMatchEnd).match(/^\s*(?:AS\s+)?([A-Za-z_]\w*)/);
  let alias = 'jt';
  let originalText = fullJsonTableText;
  if (aliasMatch) {
    alias = aliasMatch[1];
    originalText = sql.substring(startIdx, fullMatchEnd + aliasMatch[0].length);
  }

  const { columns, nestedPaths } = _parseColumns(columnsBlock);

  return {
    jsonString,
    pathExpr,
    columns,
    nestedPaths,
    alias,
    originalText,
    hasNestedPaths: nestedPaths.length > 0,
  };
}

// ──────────────────────────────────────────────
//  Main rewrite entry point
// ──────────────────────────────────────────────

/**
 * Rewrite a SQL statement containing JSON_TABLE calls into SQLite-compatible SQL.
 *
 * @param sql - The SQL statement to rewrite
 * @returns Rewrite result with the transformed SQL
 */
export function rewriteJsonTable(sql: string): JsonTableRewriteResult {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql || '', rewritten: false, count: 0 };
  }

  // Quick check
  if (!/\bjson_table\s*\(/i.test(sql)) {
    return { sql, rewritten: false, count: 0 };
  }

  // Find all JSON_TABLE expressions in the SQL
  const tables = findAllJsonTables(sql);
  if (tables.length === 0) {
    return { sql, rewritten: false, count: 0 };
  }

  logger.debug({ count: tables.length }, 'JSON_TABLE expressions found — rewriting');

  // Replace each JSON_TABLE expression with its rewritten subquery
  let resultSql = sql;

  // Process from last to first to preserve string positions during replacement
  for (let i = tables.length - 1; i >= 0; i--) {
    const table = tables[i];
    const rewritten = _rewriteSingleJsonTable(table);
    // Replace the original text with the rewritten version
    // Use simple string replacement at the first occurrence (which is the last one in reverse)
    const idx = resultSql.lastIndexOf(table.originalText);
    if (idx >= 0) {
      resultSql =
        resultSql.substring(0, idx) +
        rewritten +
        resultSql.substring(idx + table.originalText.length);
    } else {
      logger.warn('Could not find JSON_TABLE original text in SQL — skipping replacement');
    }
  }

  return {
    sql: resultSql,
    rewritten: true,
    count: tables.length,
  };
}
