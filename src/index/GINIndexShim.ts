/**
 * GINIndexShim — Translates PostgreSQL GIN indexes to SQLite (FTS5 inverted index).
 *
 * PostgreSQL's Generalized Inverted Index (GIN) is used for:
 *   - Array contains (@>), overlaps (&&)
 *   - JSONB path queries
 *   - Full-text search (tsvector)
 *   - Trigram similarity
 *
 * SQLite has no GIN equivalent. We emulate with FTS5 inverted index tables
 * backed by triggers.
 *
 * For array columns, we create an FTS5 virtual table where each element
 * is a token in the FTS5 index, enabling fast contains/overlaps queries.
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('GINIndexShim');

// ── Types ────────────────────────────────────────────────────────

export interface GINIndexResult {
  sql: string | null;
  rewritten: boolean;
  strategy: 'fts5_inverted' | 'gin_unknown' | 'not_gin';
  ftsTableName?: string;
}

export interface GINQueryRewrite {
  sql: string;
  rewritten: boolean;
}

// ── Constants ────────────────────────────────────────────────────

/** Detect USING GIN in CREATE INDEX */
const USING_GIN_RE = /\bUSING\s+GIN\b/i;

/** Detect array contains operator: col @> ARRAY[...] */
const ARRAY_CONTAINS_RE = /(\w+(?:\.\w+)?)\s*@>\s*ARRAY\s*\[([^\]]*)\]/i;

/** Detect array overlaps operator: col && ARRAY[...] */
const ARRAY_OVERLAPS_RE = /(\w+(?:\.\w+)?)\s*&&\s*ARRAY\s*\[([^\]]*)\]/i;

/**
 * Detect if SQL contains USING GIN clause.
 */
export function detectGIN(sql: string): boolean {
  return USING_GIN_RE.test(sql.trim());
}

/**
 * Rewrite a CREATE INDEX ... USING GIN statement to FTS5-based inverted index.
 *
 * Strategy:
 *   CREATE INDEX idx ON t USING GIN (col)
 *   → CREATE VIRTUAL TABLE __gin_idx USING fts5(col, content='t', content_rowid='rowid')
 *   → Sync triggers
 *   → Populate from existing data
 *
 * @param sql - The CREATE INDEX statement with USING GIN
 * @returns GINIndexResult with rewritten SQL
 */
export function rewriteGINIndex(sql: string): GINIndexResult {
  const trimmed = sql.trim();
  if (!detectGIN(trimmed)) {
    return { sql: trimmed, rewritten: false, strategy: 'not_gin' };
  }

  // Extract index name, table name, and column
  const idxNameMatch = trimmed.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/i);
  const tableNameMatch = trimmed.match(/ON\s+(\w+)/i);
  const colMatch = trimmed.match(/\(([^)]+)\)/);

  const idxName = idxNameMatch ? idxNameMatch[1].replace(/["`]/g, '') : 'gin_idx';
  const tableName = tableNameMatch ? tableNameMatch[1].replace(/["`]/g, '') : '';
  const colName = colMatch ? colMatch[1].trim() : '';

  if (!tableName || !colName) {
    logger.warn({ sql: trimmed }, 'GIN: could not extract table/column, stripping USING GIN');
    const rewritten = trimmed.replace(USING_GIN_RE, '').replace(/\s{2,}/g, ' ').trim();
    return { sql: rewritten, rewritten: true, strategy: 'gin_unknown' };
  }

  const ftsTable = `__gin_${idxName}`;

  const createFts = `CREATE VIRTUAL TABLE ${ftsTable} USING fts5(${colName}, tokenize='porter unicode61', content='${tableName}', content_rowid='rowid');`;

  const syncInsert = `
CREATE TRIGGER ${ftsTable}_ai AFTER INSERT ON ${tableName} BEGIN
  INSERT INTO ${ftsTable}(rowid, ${colName}) VALUES (new.rowid, new.${colName});
END;`;

  const syncDelete = `
CREATE TRIGGER ${ftsTable}_ad AFTER DELETE ON ${tableName} BEGIN
  INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colName}) VALUES ('delete', old.rowid, old.${colName});
END;`;

  const syncUpdate = `
CREATE TRIGGER ${ftsTable}_au AFTER UPDATE OF ${colName} ON ${tableName} BEGIN
  INSERT INTO ${ftsTable}(${ftsTable}, rowid, ${colName}) VALUES ('delete', old.rowid, old.${colName});
  INSERT INTO ${ftsTable}(rowid, ${colName}) VALUES (new.rowid, new.${colName});
END;`;

  const populate = `INSERT INTO ${ftsTable}(rowid, ${colName}) SELECT rowid, ${colName} FROM ${tableName};`;

  const fullSql = [createFts, syncInsert, syncDelete, syncUpdate, populate].join('\n');

  logger.info(
    { indexName: idxName, tableName, column: colName, ftsTable },
    'GIN index rewritten as FTS5 inverted index',
  );

  return {
    sql: fullSql,
    rewritten: true,
    strategy: 'fts5_inverted',
    ftsTableName: ftsTable,
  };
}

/**
 * Rewrite an array contains (@>) query to use the GIN/FTS5 inverted index.
 *
 * Query: SELECT * FROM t WHERE arr_col @> ARRAY['foo', 'bar']
 * → Use FTS5 MATCH: SELECT * FROM t WHERE rowid IN (SELECT rowid FROM __gin_idx WHERE __gin_idx MATCH '"foo" "bar"')
 */
export function rewriteArrayContains(
  sql: string,
  ftsTableName: string,
): GINQueryRewrite {
  const match = ARRAY_CONTAINS_RE.exec(sql.trim());
  if (!match) {
    return { sql, rewritten: false };
  }

  const colRef = match[1];
  const arrValues = match[2].split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, ''));
  const ftsQuery = arrValues.map((v) => `"${v.replace(/"/g, '""')}"`).join(' ');

  const tableRef = colRef.includes('.') ? colRef.split('.')[0] : 't';
  const rewritten = sql.replace(
    ARRAY_CONTAINS_RE,
    `${tableRef}.rowid IN (SELECT rowid FROM ${ftsTableName} WHERE ${ftsTableName} MATCH '${ftsQuery}')`,
  );

  logger.info({ original: sql, rewritten }, 'Array @> rewritten for GIN/FTS5 index');
  return { sql: rewritten, rewritten: true };
}

/**
 * Rewrite an array overlaps (&&) query to use the GIN/FTS5 inverted index.
 *
 * Query: SELECT * FROM t WHERE arr_col && ARRAY['foo', 'bar']
 * → Use FTS5 MATCH: SELECT * FROM t WHERE rowid IN (SELECT rowid FROM __gin_idx WHERE __gin_idx MATCH 'foo OR bar')
 */
export function rewriteArrayOverlaps(
  sql: string,
  ftsTableName: string,
): GINQueryRewrite {
  const match = ARRAY_OVERLAPS_RE.exec(sql.trim());
  if (!match) {
    return { sql, rewritten: false };
  }

  const colRef = match[1];
  const arrValues = match[2].split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, ''));
  const ftsQuery = arrValues.map((v) => `"${v.replace(/"/g, '""')}"`).join(' OR ');

  const tableRef = colRef.includes('.') ? colRef.split('.')[0] : 't';
  const rewritten = sql.replace(
    ARRAY_OVERLAPS_RE,
    `${tableRef}.rowid IN (SELECT rowid FROM ${ftsTableName} WHERE ${ftsTableName} MATCH '${ftsQuery}')`,
  );

  logger.info({ original: sql, rewritten }, 'Array && rewritten for GIN/FTS5 index');
  return { sql: rewritten, rewritten: true };
}

// ──────────────────────────────────────────────────────────────
//  GIN Index Runtime — in-memory rbush-based inverted index
// ──────────────────────────────────────────────────────────────

import * as rbush from 'rbush';

/**
 * A simple string hash function for encoding keys/values as rbush coordinates.
 * Converts any string to a numeric hash in [0, 2^32).
 */
function hashStr(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit int
  }
  return Math.abs(hash);
}

/**
 * GIN index entry stored in the rbush tree.
 * Coordinates encode the hash of the key/value for efficient search.
 */
interface GINRbushEntry {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  rowid: number;
  key: string;
  value: string;
}

/**
 * GIN index column types.
 */
export type GINColType = 'jsonb' | 'array' | 'tsvector' | 'simple';

/**
 * In-memory GIN (Generalized Inverted Index) using rbush + Maps.
 *
 * For JSONB columns:
 *   - Stores each key as an rbush entry with hash(key) → coordinate
 *   - Stores each key-value pair with hash(key+value) → coordinate
 *   - Supports @> (contains), ? (key exists), ?| (any key), ?& (all keys)
 *
 * For array columns:
 *   - Stores each array element as a separate inverted entry
 *
 * For simple types, falls back to B-tree-like Map.
 */
export class GINIndexRuntime {
  /** rbush tree for hash-based lookups */
  private tree: any;
  /** Exact inverted index: key → Set<rowid> */
  private keyIndex: Map<string, Set<number>> = new Map();
  /** Exact inverted index: key+":"+value → Set<rowid> */
  private kvIndex: Map<string, Set<number>> = new Map();
  /** Map rowid → set of keys in that row (for cleanup) */
  private rowKeys: Map<number, Set<string>> = new Map();
  /** Map rowid → {key: value} (for cleanup) */
  private rowKVs: Map<number, Map<string, string>> = new Map();
  /** Column classification */
  private colType: GINColType;
  private size = 0;
  /** Fallback for simple types */
  private fallback: Map<string, Set<number>> = new Map();

  constructor(colType: GINColType = 'jsonb') {
    this.tree = new rbush.default();
    this.colType = colType;
  }

  /**
   * Parse a JSONB value string into a flat map of keys/values.
   * Supports: '{"a":1,"b":"x"}' → {a: "1", b: "x"}
   *           '["a","b","c"]'   → each element as index key
   */
  static parseJSONB(jsonStr: string): Map<string, string> {
    const result = new Map<string, string>();
    try {
      const obj = JSON.parse(jsonStr);
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          result.set(`${i}`, String(obj[i]));
          result.set(String(obj[i]), String(obj[i]));
        }
      } else if (typeof obj === 'object' && obj !== null) {
        for (const [k, v] of Object.entries(obj)) {
          result.set(k, String(v));
        }
      }
    } catch {
      // Not valid JSON — treat as plain text
      result.set(jsonStr, jsonStr);
    }
    return result;
  }

  /**
   * Parse a PostgreSQL array string into elements.
   * Supports: '{a,b,c}' or ARRAY['a','b','c']
   */
  static parseArray(arrStr: string): string[] {
    const trimmed = arrStr.trim();
    // Try ARRAY[...] or array[...]
    const arrayMatch = trimmed.match(/^array\s*\[([\s\S]*)\]\s*$/i);
    if (arrayMatch) {
      return arrayMatch[1].split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''));
    }
    // Try {a,b,c}
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return trimmed.slice(1, -1).split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''));
    }
    // Try raw comma-separated
    return trimmed.split(',').map(v => v.trim());
  }

  /**
   * Parse a tsvector string into lexemes (ignoring weights and positions).
   * Supports: 'cat:3 dog:5' or 'a b c'
   */
  static parseTsvector(tsv: string): string[] {
    const trimmed = tsv.trim();
    if (!trimmed) return [];
    // Remove positions/weights: lexeme:pos,weight → lexeme
    return trimmed.split(/\s+/).map(token => {
      const colonIdx = token.indexOf(':');
      return colonIdx > 0 ? token.slice(0, colonIdx) : token;
    }).filter(Boolean);
  }

  /**
   * Insert a row into the GIN index.
   *
   * @param rowid - Row identifier
   * @param value - Raw column value (JSON string, array string, or tsvector)
   */
  insert(rowid: number, value: string | null | undefined): void {
    if (value == null) return;

    if (this.colType === 'simple') {
      this._insertFallback(rowid, value);
      return;
    }

    const entries = this._parseValueEntries(rowid, value);
    const keys = new Set<string>();
    const kvs = new Map<string, string>();

    for (const { key, kvKey } of entries) {
      // rbush entry with hash-based coordinates
      const hk = hashStr(key);
      this.tree.insert({
        minX: hk, maxX: hk,
        minY: 0, maxY: 0,
        rowid,
        key,
        value: '',
      });

      // Update keyIndex
      if (!this.keyIndex.has(key)) this.keyIndex.set(key, new Set());
      this.keyIndex.get(key)!.add(rowid);
      keys.add(key);

      // If there's a kvKey (for @> searches)
      if (kvKey) {
        const hkv = hashStr(kvKey);
        this.tree.insert({
          minX: hkv, maxX: hkv,
          minY: hk, maxY: hk,
          rowid,
          key: kvKey,
          value: key,
        });

        if (!this.kvIndex.has(kvKey)) this.kvIndex.set(kvKey, new Set());
        this.kvIndex.get(kvKey)!.add(rowid);
        kvs.set(key, kvKey);
      }
    }

    this.rowKeys.set(rowid, keys);
    if (kvs.size > 0) this.rowKVs.set(rowid, kvs);
    this.size++;
  }

  /**
   * Remove a row from the GIN index.
   */
  remove(rowid: number, value: string | null | undefined): void {
    if (this.colType === 'simple' && value != null) {
      this._removeFallback(rowid, value);
      return;
    }

    // Clean up keyIndex
    const keys = this.rowKeys.get(rowid);
    if (keys) {
      for (const key of keys) {
        const rows = this.keyIndex.get(key);
        if (rows) {
          rows.delete(rowid);
          if (rows.size === 0) this.keyIndex.delete(key);
        }
      }
      this.rowKeys.delete(rowid);
    }

    // Clean up kvIndex
    const kvs = this.rowKVs.get(rowid);
    if (kvs) {
      for (const [_, kvKey] of kvs) {
        const rows = this.kvIndex.get(kvKey);
        if (rows) {
          rows.delete(rowid);
          if (rows.size === 0) this.kvIndex.delete(kvKey);
        }
      }
      this.rowKVs.delete(rowid);
    }

    // Clean rbush tree entries for this rowid
    const all = this.tree.all();
    const toRemove = all.filter((e: any) => e.rowid === rowid);
    for (const entry of toRemove) {
      this.tree.remove(entry, (a: any, b: any) => a.rowid === b.rowid && a.key === b.key);
    }

    this.size = Math.max(0, this.size - 1);
  }

  /**
   * Search the GIN index.
   *
   * @param op - GIN operator: '@>' | '?' | '?|' | '?&'
   * @param query - Query value(s)
   * @returns Array of matching rowids
   */
  search(op: string, query: any): number[] {
    if (this.colType === 'simple') {
      return this._searchFallback(op, String(query));
    }

    switch (op) {
      case '@>': {
        // JSONB contains: all key-value pairs from query must match
        const qEntries = GINIndexRuntime.parseJSONB(typeof query === 'string' ? query : JSON.stringify(query));
        // Empty query (e.g. '{}') matches all rows
        if (qEntries.size === 0) {
          return [...[...this.keyIndex.values()].reduce((acc, set) => {
            for (const r of set) acc.add(r);
            return acc;
          }, new Set<number>())];
        }

        let resultSet: Set<number> | null = null;

        for (const [key, val] of qEntries) {
          const kvKey = `${key}:${val}`;
          const rows = this.kvIndex.get(kvKey);
          if (!rows || rows.size === 0) return [];

          if (resultSet === null) {
            resultSet = new Set(rows);
          } else {
            resultSet = new Set([...resultSet].filter((r: number) => (rows as Set<number>).has(r)));
          }
        }

        return resultSet ? [...resultSet] : [];
      }

      case '?': {
        // Key exists: row has this key
        const key = String(query).trim();
        const rows = this.keyIndex.get(key);
        return rows ? [...rows] : [];
      }

      case '?|': {
        // Any key exists
        const keys = Array.isArray(query) ? query.map(String) : String(query).split(',').map(s => s.trim());
        const matched = new Set<number>();
        for (const key of keys) {
          const rows = this.keyIndex.get(key);
          if (rows) for (const r of rows) matched.add(r);
        }
        return [...matched];
      }

      case '?&': {
        // All keys exist
        const keys = Array.isArray(query) ? query.map(String) : String(query).split(',').map(s => s.trim());
        if (keys.length === 0) return [];

        let resultSet: Set<number> | null = null;
        for (const key of keys) {
          const rows = this.keyIndex.get(key);
          if (!rows || rows.size === 0) return [];

          if (resultSet === null) {
            resultSet = new Set(rows);
          } else {
            resultSet = new Set([...resultSet].filter((r: number) => (rows as Set<number>).has(r)));
          }
        }

        return resultSet ? [...resultSet] : [];
      }

      case '=':
      case '==': {
        // Exact match (fallback)
        return this._searchFallback('=', String(query));
      }

      default:
        return [];
    }
  }

  /**
   * Get the total number of rows indexed.
   */
  getSize(): number {
    return this.size;
  }

  /**
   * Clear all entries from the index.
   */
  clear(): void {
    this.tree = new rbush.default();
    this.keyIndex.clear();
    this.kvIndex.clear();
    this.rowKeys.clear();
    this.rowKVs.clear();
    this.fallback.clear();
    this.size = 0;
  }

  /**
   * Get all unique keys in the index.
   */
  getKeys(): string[] {
    return [...this.keyIndex.keys()];
  }

  /**
   * Check if a specific key exists in the index.
   */
  hasKey(key: string): boolean {
    return this.keyIndex.has(key);
  }

  // ── Private helpers ──────────────────────────────

  private _parseValueEntries(rowid: number, value: string): Array<{ key: string; kvKey: string | null }> {
    const result: Array<{ key: string; kvKey: string | null }> = [];

    if (this.colType === 'jsonb') {
      const entries = GINIndexRuntime.parseJSONB(value);
      for (const [k, v] of entries) {
        result.push({ key: k, kvKey: `${k}:${v}` });
      }
    } else if (this.colType === 'array') {
      const elements = GINIndexRuntime.parseArray(value);
      for (const el of elements) {
        result.push({ key: el, kvKey: el });
      }
    } else if (this.colType === 'tsvector') {
      const lexemes = GINIndexRuntime.parseTsvector(value);
      for (const lex of lexemes) {
        result.push({ key: lex, kvKey: null });
      }
    }

    return result;
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

  private _searchFallback(op: string, queryValue: string): number[] {
    const rows = this.fallback.get(queryValue);
    return rows ? [...rows] : [];
  }
}
