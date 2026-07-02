/**
 * TrigramIndexShim — LIKE / regex index via trigram FTS5 for SQLite.
 *
 * PostgreSQL supports LIKE / regex index via pg_trgm (trigram) extension.
 * SQLite doesn't have this, so we emulate it with an FTS5 virtual table
 * that indexes trigrams of the source column.
 *
 * Strategy:
 *   CREATE INDEX ON t USING FTS5 LIKE col
 *   → CREATE VIRTUAL TABLE t_like_idx USING fts5(col, tokenize='trigram')
 *   → Trigger to keep the FTS5 table in sync
 *
 * LIMIT clause on LIKE queries is translated to:
 *   SELECT ... FROM t WHERE col LIKE '%foo%' LIMIT 10
 *   → SELECT ... FROM t_like_idx('foo') JOIN t ON t.rowid = t_like_idx.rowid LIMIT 10
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('TrigramIndexShim');

// ── Types ────────────────────────────────────────────────────────

export interface TrigramIndexResult {
  /** Rewritten SQL for creating the FTS5 trigram index */
  sql: string | null;
  /** Whether a trigram index pattern was detected */
  rewritten: boolean;
  /** Name of the FTS5 virtual table */
  ftsTableName: string;
  /** Source column being indexed */
  indexedColumn: string;
}

export interface LikeRewriteResult {
  /** Rewritten SQL using FTS5 trigram search */
  sql: string;
  /** Whether the LIKE was rewritten */
  rewritten: boolean;
  /** The original LIKE pattern */
  pattern?: string;
}

// ── Constants ────────────────────────────────────────────────────

/** Detects CREATE INDEX ... USING FTS5 LIKE <col> */
const CREATE_FTS5_LIKE_RE = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s+ON\s+(\S+)\s+USING\s+FTS5\s+LIKE\s+(\S+)/i;

/** Detects LIKE pattern: col LIKE '%foo%' */
const LIKE_PATTERN_RE = /(\w+(?:\.\w+)?)\s+LIKE\s+'([^']*)'/i;

/** Detects REGEXP pattern: col ~ 'pattern' or col ~* 'pattern' */
const REGEX_PATTERN_RE = /(\w+(?:\.\w+)?)\s*~[*]?\s*'([^']*)'/i;

/** Detects LIMIT clause */
const LIMIT_RE = /\s+LIMIT\s+(\d+)/i;

/** Generates trigrams from a string */
function generateTrigrams(s: string): string[] {
  const trigrams: string[] = [];
  const cleaned = s.toLowerCase();
  if (cleaned.length < 3) {
    trigrams.push(cleaned);
    return trigrams;
  }
  for (let i = 0; i <= cleaned.length - 3; i++) {
    trigrams.push(cleaned.substring(i, i + 3));
  }
  return [...new Set(trigrams)];
}

/**
 * Generate a trigram query string for FTS5.
 * E.g., "foo bar" → "foo AND bar" (approximate)
 */
function buildTrigramQuery(pattern: string): string {
  // Strip leading/trailing %
  let clean = pattern.replace(/^%+|%+$/g, '');

  // Replace % with * wildcard for FTS5
  clean = clean.replace(/%/g, '*');

  // Replace _ with single-char wildcard
  clean = clean.replace(/_/g, '?');

  return clean;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether a SQL statement is a CREATE INDEX ... USING FTS5 LIKE statement.
 */
export function detectTrigramIndex(sql: string): boolean {
  return CREATE_FTS5_LIKE_RE.test(sql.trim());
}

/**
 * Rewrite a CREATE INDEX ... USING FTS5 LIKE <col> into FTS5 virtual table creation + triggers.
 *
 * @param sql - The CREATE INDEX statement
 * @returns TrigramIndexResult with rewritten SQL
 */
export function rewriteTrigramIndex(sql: string): TrigramIndexResult {
  const trimmed = sql.trim();
  const match = CREATE_FTS5_LIKE_RE.exec(trimmed);

  if (!match) {
    return { sql: null, rewritten: false, ftsTableName: '', indexedColumn: '' };
  }

  const idxName = match[1].replace(/["`]/g, '');
  const tableName = match[2].replace(/["`]/g, '');
  const colName = match[3].replace(/["`]/g, '');
  const ftsTable = `__trigram_${idxName}`;

  const createFts = `CREATE VIRTUAL TABLE ${ftsTable} USING fts5(${colName}, tokenize='trigram', content='${tableName}', content_rowid='rowid');`;

  const syncTriggerInsert = `
CREATE TRIGGER ${ftsTable}_ai AFTER INSERT ON ${tableName} BEGIN
  INSERT INTO ${ftsTable}(rowid, ${colName}) VALUES (new.rowid, new.${colName});
END;`;

  const syncTriggerDelete = `
CREATE TRIGGER ${ftsTable}_ad AFTER DELETE ON ${tableName} BEGIN
  INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colName}) VALUES ('delete', old.rowid, old.${colName});
END;`;

  const syncTriggerUpdate = `
CREATE TRIGGER ${ftsTable}_au AFTER UPDATE OF ${colName} ON ${tableName} BEGIN
  INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colName}) VALUES ('delete', old.rowid, old.${colName});
  INSERT INTO ${ftsTable}(rowid, ${colName}) VALUES (new.rowid, new.${colName});
END;`;

  const populateExisting = `
INSERT INTO ${ftsTable}(rowid, ${colName}) SELECT rowid, ${colName} FROM ${tableName};`;

  const fullSql = [createFts, syncTriggerInsert, syncTriggerDelete, syncTriggerUpdate, populateExisting].join('\n');

  logger.info(
    { indexName: idxName, tableName, column: colName, ftsTable },
    'Trigram index rewritten as FTS5 virtual table',
  );

  return {
    sql: fullSql,
    rewritten: true,
    ftsTableName: ftsTable,
    indexedColumn: colName,
  };
}

/**
 * Rewrite a LIKE query to use the FTS5 trigram index for faster search.
 *
 * @param sql - Original SQL with LIKE clause
 * @param ftsTableName - The FTS5 trigram table name
 * @param indexedColumn - The column that has the trigram index
 * @returns Rewritten SQL using FTS5 search
 */
export function rewriteLikeQuery(
  sql: string,
  ftsTableName: string,
  indexedColumn: string,
): LikeRewriteResult {
  const trimmed = sql.trim();
  const likeMatch = LIKE_PATTERN_RE.exec(trimmed);

  if (!likeMatch) {
    return { sql: trimmed, rewritten: false };
  }

  const colRef = likeMatch[1];
  const pattern = likeMatch[2];

  // Only rewrite patterns that start and end with %
  if (!pattern.startsWith('%') || !pattern.endsWith('%')) {
    return { sql: trimmed, rewritten: false };
  }

  const trigramQuery = buildTrigramQuery(pattern);

  // Replace the LIKE clause with FTS5 match + join
  const tableRef = colRef.includes('.') ? colRef.split('.')[0] : 't';
  let rewritten = trimmed.replace(
    LIKE_PATTERN_RE,
    `${tableRef}.rowid IN (SELECT rowid FROM ${ftsTableName}('${trigramQuery.replace(/'/g, "''")}') WHERE ${ftsTableName} MATCH '${trigramQuery.replace(/'/g, "''")}')`,
  );

  // Add a CAST to ensure the LIKE filter is also applied (FTS5 is approximate)
  // Actually, keep the original LIKE condition with OR — FTS5 match is the fast path
  // Better approach: use FTS5 match to filter first, then still apply LIKE for verification
  const originalCondition = `${colRef} LIKE '${pattern}'`;
  rewritten = trimmed.replace(
    LIKE_PATTERN_RE,
    `(${colRef} LIKE '${pattern}' AND ${tableRef}.rowid IN (SELECT rowid FROM ${ftsTableName} WHERE ${ftsTableName} MATCH '${trigramQuery.replace(/'/g, "''")}'))`,
  );

  logger.info({ original: trimmed, rewritten, pattern }, 'LIKE query rewritten for FTS5 trigram index');
  return { sql: rewritten, rewritten: true, pattern };
}

/**
 * Rewrite a regex (~) query to use the trigram index.
 * Regex is harder — we can only filter on likely candidates via trigrams.
 *
 * @param sql - Original SQL with regex pattern
 * @param ftsTableName - The FTS5 trigram table name
 * @returns Rewritten SQL
 */
export function rewriteRegexQuery(sql: string, ftsTableName: string): LikeRewriteResult {
  const trimmed = sql.trim();
  const regexMatch = REGEX_PATTERN_RE.exec(trimmed);
  if (!regexMatch) {
    return { sql: trimmed, rewritten: false };
  }

  // For regex, we extract literal substrings and use trigram pre-filtering
  const pattern = regexMatch[2];
  const tableRef = regexMatch[1].includes('.') ? regexMatch[1].split('.')[0] : 't';

  // Extract literal prefixes from regex pattern
  // E.g., "^foo.*bar$" → "foo" and "bar"
  const literalParts = pattern.match(/[a-zA-Z0-9_]{3,}/g) || [];
  if (literalParts.length === 0) {
    return { sql: trimmed, rewritten: false };
  }

  // Use the longest literal part for trigram filtering
  const longestLiteral = literalParts.reduce((a, b) => (a.length >= b.length ? a : b));
  const trigramQuery = buildTrigramQuery(longestLiteral);

  const rewritten = trimmed.replace(
    REGEX_PATTERN_RE,
    `(${regexMatch[1]} ~ '${pattern}' AND ${tableRef}.rowid IN (SELECT rowid FROM ${ftsTableName} WHERE ${ftsTableName} MATCH '${trigramQuery}'))`,
  );

  logger.info({ original: trimmed, rewritten, pattern }, 'Regex query rewritten with trigram pre-filter');
  return { sql: rewritten, rewritten: true, pattern };
}
