/**
 * LikeIndexShim — LIKE / ILIKE / SIMILAR TO index support via SQLite FTS5 trigram tokenizer.
 *
 * PostgreSQL allows index scans for `LIKE '%foo%'` via:
 *   CREATE INDEX ON t USING GIN (col gin_trgm_ops)
 *
 * SQLite has no GIN or pg_trgm, but we can use FTS5 with the trigram tokenizer
 * to achieve comparable performance for substring matching.
 *
 * Strategy:
 *   1. `createLikeIndex()` → creates FTS5 virtual table + sync triggers + populates
 *   2. `rewriteLikeQuery()` → rewrites WHERE conditions to use FTS5 MATCH
 *
 * FTS5 trigram breaks text into 3-character substrings, enabling efficient
 * substring search. The trigram tokenizer is case-insensitive by default.
 *
 * For case-sensitive LIKE: FTS5 pre-filters candidates, original LIKE re-checks.
 * For ILIKE / SIMILAR TO: FTS5 MATCH alone suffices (FTS5 is already CI).
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('LikeIndexShim');

// ── Types ────────────────────────────────────────────────────────

/**
 * Map of column references to FTS5 virtual table names.
 * Key: column reference as it appears in the query (e.g. "col" or "t.col")
 * Value: FTS5 virtual table name to use for matching
 */
export interface FTSMap {
  [columnRef: string]: string;
}

export interface RewriteResult {
  sql: string;
  rewritten: boolean;
  rewrites: Array<{
    column: string;
    pattern: string;
    operator: 'LIKE' | 'ILIKE' | 'SIMILAR TO';
    ftsTable: string;
  }>;
}

export interface CreateLikeIndexResult {
  sql: string;
  ftsTableName: string;
  rewritten: boolean;
}

// ── Regex Patterns ───────────────────────────────────────────────

/** Matches `column LIKE 'pattern'` — column can be qualified (t.col) */
const LIKE_RE = /(\w+(?:\.\w+)?)\s+LIKE\s+'([^']*)'/gi;

/** Matches `column ILIKE 'pattern'` */
const ILIKE_RE = /(\w+(?:\.\w+)?)\s+ILIKE\s+'([^']*)'/gi;

/** Matches `column SIMILAR TO 'pattern'` (note: SIMILAR TO is two words) */
const SIMILAR_TO_RE = /(\w+(?:\.\w+)?)\s+SIMILAR\s+TO\s+'([^']*)'/gi;

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Build an FTS5 MATCH query string from a LIKE/ILIKE pattern.
 *
 * Rules:
 *   - Leading/trailing `%` → strip (substring match via trigram)
 *   - Internal `%` → split into separate terms joined by AND
 *   - `_` → `?` (single-character wildcard in FTS5)
 *   - Escaped chars → pass through
 *
 * Examples:
 *   '%foo%'                → '"foo"'
 *   '%foo%bar%'            → '"foo" AND "bar"'
 *   'foo%'                 → '"foo"'
 *   '%foo_bar%'            → '"foo?bar"'
 */
export function buildFTSQuery(pattern: string): string {
  // Remove escaped chars handling
  let clean = pattern;

  // Strip leading/trailing % (substring markers)
  clean = clean.replace(/^%+|%+$/g, '');

  // Replace _ with FTS5 single-char wildcard
  clean = clean.replace(/_/g, '?');

  // Replace internal % with FTS5 AND
  clean = clean.replace(/%+/g, ' ');

  // Split by whitespace into terms
  const terms = clean.split(/\s+/).filter((t) => t.length > 0);

  if (terms.length === 0) return '';

  if (terms.length === 1) {
    // Single term — use phrase match for trigram
    const term = terms[0].replace(/"/g, '""');
    return `"${term}"`;
  }

  // Multiple terms — AND them together (always quote each term for phrase match)
  return terms
    .map((t) => {
      const term = t.replace(/"/g, '""');
      return `"${term}"`;
    })
    .join(' AND ');
}

/**
 * Extract the bare column name from a possibly-qualified reference.
 *   't.col' → 'col'
 *   'col'   → 'col'
 */
function bareColumn(colRef: string): string {
  return colRef.includes('.') ? colRef.split('.')[1] : colRef;
}

/**
 * Normalize a column reference for ftsMap lookup.
 * Tries bare column name first, then qualified, then unqualified-ified.
 */
function lookupFtsTable(colRef: string, ftsMap: FTSMap): string | null {
  // Exact match
  if (ftsMap[colRef]) return ftsMap[colRef];

  // Bare column match (if qualified)
  const bare = bareColumn(colRef);
  if (ftsMap[bare]) return ftsMap[bare];

  return null;
}

/**
 * Apply one specific operator regex, replace matching conditions,
 * and return { sql, rewrites } for that operator type.
 */
function rewriteOperator(
  sql: string,
  regex: RegExp,
  operator: 'LIKE' | 'ILIKE' | 'SIMILAR TO',
  ftsMap: FTSMap,
): { sql: string; rewrites: RewriteResult['rewrites'] } {
  const rewrites: RewriteResult['rewrites'] = [];
  let result = sql;

  // Reset lastIndex for global regex
  regex.lastIndex = 0;

  // We need to replace one at a time because the replacement adds length
  // and can interfere with regex state. Use a while loop with exec.
  const matches: Array<{
    fullMatch: string;
    colRef: string;
    pattern: string;
    index: number;
  }> = [];

  let match: RegExpExecArray | null;
  while ((match = regex.exec(result)) !== null) {
    matches.push({
      fullMatch: match[0],
      colRef: match[1],
      pattern: match[2],
      index: match.index,
    });
  }

  // Process in reverse order to preserve indices
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const ftsTable = lookupFtsTable(m.colRef, ftsMap);

    if (!ftsTable) continue;

    const ftsQuery = buildFTSQuery(m.pattern);
    if (!ftsQuery) continue;

    const isCaseSensitive = operator === 'LIKE';
    const tableName = m.colRef.includes('.') ? m.colRef.split('.')[0] : undefined;

    let replacement: string;

    if (isCaseSensitive) {
      // Case-sensitive LIKE: keep original condition + FTS5 pre-filter
      // FTS5 trigram is case-insensitive, so we need the original LIKE as post-filter
      if (tableName) {
        replacement = `(${m.fullMatch} AND ${tableName}.rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH '${ftsQuery.replace(/'/g, "''")}'))`;
      } else {
        replacement = `(${m.fullMatch} AND rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH '${ftsQuery.replace(/'/g, "''")}'))`;
      }
    } else {
      // ILIKE or SIMILAR TO: FTS5 is already case-insensitive, so use it directly
      // But keep original condition as safety filter (FTS5 can have false positives with short patterns)
      if (tableName) {
        replacement = `(${m.fullMatch} AND ${tableName}.rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH '${ftsQuery.replace(/'/g, "''")}'))`;
      } else {
        replacement = `(${m.fullMatch} AND rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH '${ftsQuery.replace(/'/g, "''")}'))`;
      }
    }

    const before = result.substring(0, m.index);
    const after = result.substring(m.index + m.fullMatch.length);
    result = before + replacement + after;

    rewrites.push({
      column: m.colRef,
      pattern: m.pattern,
      operator,
      ftsTable,
    });

    // Recalculate matches for remaining regex
    // Since we're processing backwards, earlier indices are unaffected
  }

  return { sql: result, rewrites };
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Create a LIKE/ILIKE index via FTS5 virtual table with trigram tokenizer.
 *
 * Generates:
 *   1. CREATE VIRTUAL TABLE ... USING fts5(col, tokenize='trigram', content='t', content_rowid='rowid')
 *   2. AFTER INSERT trigger to sync new rows
 *   3. AFTER DELETE trigger to sync deleted rows
 *   4. AFTER UPDATE trigger to sync updated rows
 *   5. INSERT ... SELECT to populate existing data
 *
 * @param table    - Source table name
 * @param column   - Column to index for LIKE/ILIKE matching
 * @param caseSensitive - True for LIKE (case-sensitive), false for ILIKE (case-insensitive).
 *                        Affects query rewriting but FTS5 table creation is the same.
 * @returns CreateLikeIndexResult with the full SQL
 */
export function createLikeIndex(
  table: string,
  column: string,
  caseSensitive: boolean = false,
): CreateLikeIndexResult {
  const safeTable = table.replace(/["`]/g, '');
  const safeCol = column.replace(/["`]/g, '');
  const ftsTable = `__like_${safeTable}_${safeCol}`;

  const createFts = `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(${safeCol}, tokenize='trigram', content='${safeTable}', content_rowid='rowid');`;

  const syncInsert =
    `CREATE TRIGGER IF NOT EXISTS ${ftsTable}_ai AFTER INSERT ON ${safeTable} BEGIN\n` +
    `  INSERT INTO ${ftsTable}(rowid, ${safeCol}) VALUES (new.rowid, new.${safeCol});\n` +
    `END;`;

  const syncDelete =
    `CREATE TRIGGER IF NOT EXISTS ${ftsTable}_ad AFTER DELETE ON ${safeTable} BEGIN\n` +
    `  INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${safeCol}) VALUES ('delete', old.rowid, old.${safeCol});\n` +
    `END;`;

  const syncUpdate =
    `CREATE TRIGGER IF NOT EXISTS ${ftsTable}_au AFTER UPDATE OF ${safeCol} ON ${safeTable} BEGIN\n` +
    `  INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${safeCol}) VALUES ('delete', old.rowid, old.${safeCol});\n` +
    `  INSERT INTO ${ftsTable}(rowid, ${safeCol}) VALUES (new.rowid, new.${safeCol});\n` +
    `END;`;

  const populate =
    `INSERT OR IGNORE INTO ${ftsTable}(rowid, ${safeCol}) SELECT rowid, ${safeCol} FROM ${safeTable};`;

  const fullSql = [createFts, syncInsert, syncDelete, syncUpdate, populate].join('\n');

  logger.info(
    { table: safeTable, column: safeCol, caseSensitive, ftsTable },
    'Like index created as FTS5 virtual table with trigram tokenizer',
  );

  return {
    sql: fullSql,
    ftsTableName: ftsTable,
    rewritten: true,
  };
}

/**
 * Rewrite a SQL query to use FTS5-based LIKE/ILIKE/SIMILAR TO index scans.
 *
 * For each LIKE/ILIKE/SIMILAR TO condition whose column is in `ftsMap`,
 * the condition is rewritten to use an FTS5 MATCH subquery for efficient
 * trigram-based substring matching.
 *
 * Both case-sensitive (LIKE) and case-insensitive (ILIKE, SIMILAR TO) are
 * supported. For LIKE, the original condition is retained as a post-filter
 * because FTS5 trigram is case-insensitive.
 *
 * @param sql    - Original SQL query (typically a SELECT)
 * @param ftsMap - Map of column references to FTS5 virtual table names
 * @returns RewriteResult with rewritten SQL and list of rewrites performed
 *
 * @example
 * ```typescript
 * const ftsMap = { name: '__like_users_name' };
 * const result = rewriteLikeQuery(
 *   "SELECT * FROM users WHERE name LIKE '%john%'",
 *   ftsMap
 * );
 * // result.sql: "SELECT * FROM users WHERE (name LIKE '%john%' AND rowid IN (SELECT rowid FROM __like_users_name WHERE __like_users_name MATCH '\"john\"'))"
 * ```
 */
export function rewriteLikeQuery(sql: string, ftsMap: FTSMap): RewriteResult {
  if (!ftsMap || Object.keys(ftsMap).length === 0) {
    return { sql, rewritten: false, rewrites: [] };
  }

  let result = sql;
  const allRewrites: RewriteResult['rewrites'] = [];

  // Phase 1: Rewrite LIKE (case-sensitive)
  const likeResult = rewriteOperator(result, LIKE_RE, 'LIKE', ftsMap);
  result = likeResult.sql;
  allRewrites.push(...likeResult.rewrites);

  // Phase 2: Rewrite ILIKE (case-insensitive)
  const ilikeResult = rewriteOperator(result, ILIKE_RE, 'ILIKE', ftsMap);
  result = ilikeResult.sql;
  allRewrites.push(...ilikeResult.rewrites);

  // Phase 3: Rewrite SIMILAR TO (case-insensitive)
  const similarResult = rewriteOperator(result, SIMILAR_TO_RE, 'SIMILAR TO', ftsMap);
  result = similarResult.sql;
  allRewrites.push(...similarResult.rewrites);

  const rewritten = allRewrites.length > 0;

  if (rewritten) {
    logger.info(
      { rewrites: allRewrites.length },
      'Query rewritten with FTS5 trigram LIKE index',
    );
  }

  return {
    sql: result,
    rewritten,
    rewrites: allRewrites,
  };
}

/**
 * Convenience function: detect whether a CREATE INDEX statement targets LIKE indexing.
 *
 * Matches patterns like:
 *   CREATE INDEX ON t USING gin (col gin_trgm_ops)
 *   CREATE INDEX ON t USING fts5 LIKE col
 *
 * @param sql - CREATE INDEX statement to detect
 * @returns true if the statement is a LIKE-targeted index
 */
export function detectLikeIndex(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase();
  return (
    /\busing\s+(gin|fts5)\b/.test(trimmed) &&
    /(gin_trgm_ops|like)\b/.test(trimmed)
  );
}
