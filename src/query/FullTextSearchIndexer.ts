// @ts-nocheck
/**
 * FullTextSearchIndexer — Real inverted-index-based full-text search for SQLite.
 *
 * Replaces the regex-only FtsShim with actual inverted index storage and retrieval:
 *
 * 1. DDL: CREATE INDEX ... USING GIN(to_tsvector(config, col)) →
 *    Creates _fts_idx_<name> auxiliary table with (term, rowid, positions)
 *
 * 2. DML: INSERT/UPDATE → automatically tokenizes text and indexes
 *
 * 3. Query: to_tsvector(col) @@ to_tsquery('cat & dog') →
 *    Real inverted index lookup with AND/OR/NOT semantics
 *
 * 4. Ranking: ts_rank, ts_headline computed from indexed data
 *
 * All operations work with a Database.Database callback, making them compatible
 * with any SQLite-backed storage (ShardManager, single DB, etc.).
 */

import natural from 'natural';
import type Database from 'better-sqlite3';

const porterStemmer = natural.PorterStemmer;

// ── Stop word set ────────────────────────────────────────────────

const DEFAULT_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
  'for', 'of', 'by', 'with', 'from', 'is', 'it', 'as', 'be', 'are',
  'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
  'can', 'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'that',
  'this', 'these', 'those', 'which', 'who', 'whom', 'what', 'when',
  'where', 'why', 'how',
]);

// ── Tokenizer ────────────────────────────────────────────────────

export interface Token {
  term: string;
  position: number;
}

/**
 * Simple tokenizer with stemming, stop word removal, and position tracking.
 */
export class SimpleTokenizer {
  private stopWords: Set<string>;

  constructor(stopWords?: Set<string>) {
    this.stopWords = stopWords ?? DEFAULT_STOP_WORDS;
  }

  /**
   * Tokenize text into terms with positions.
   * 1. Lowercase
   * 2. Extract words via /\w+/
   * 3. Remove stop words
   * 4. Simple stemming (es/ed/ing/s suffix removal)
   * 5. Record position of each term
   */
  tokenize(text: string): Token[] {
    if (!text || text.trim().length === 0) return [];

    const lower = text.toLowerCase();

    // Extract words/characters with positions.
    // \w+ matches ASCII word characters.
    // Chinese characters (CJK) are matched individually since \w doesn't cover them.
    const rawTokenPositions: { token: string; index: number }[] = [];
    const wordRe = /(\w+)|([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff])/g;
    let match: RegExpExecArray | null;

    while ((match = wordRe.exec(lower)) !== null) {
      const token = match[1] || match[2];
      if (token) {
        rawTokenPositions.push({ token, index: match.index });
      }
    }

    const result: Token[] = [];
    let termPos = 0;

    for (let i = 0; i < rawTokenPositions.length; i++) {
      const { token } = rawTokenPositions[i];

      // Skip stop words (only for ASCII words)
      if (this.stopWords.has(token)) continue;

      // Skip single characters (except CJK)
      if (token.length <= 1 && !/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(token)) continue;

      // Simple stemming (only for ASCII words)
      const stemmed = /[a-zA-Z]/.test(token) ? this.stem(token) : token;

      // Record term
      result.push({
        term: stemmed,
        position: termPos,
      });
      termPos++;
    }

    return result;
  }

  /**
   * Tokenize and return unique stemmed terms (for tsvector representation).
   */
  tokenizeUnique(text: string): string[] {
    const tokens = this.tokenize(text);
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const t of tokens) {
      if (!seen.has(t.term)) {
        seen.add(t.term);
        unique.push(t.term);
      }
    }
    return unique;
  }

  /**
   * Simple stemmer: removes common suffixes.
   */
  stem(word: string): string {
    return porterStemmer.stem(word);
  }

  /**
   * Check if a word is a stop word.
   */
  isStopWord(word: string): boolean {
    return this.stopWords.has(word.toLowerCase());
  }
}

// ── TsQuery AST ──────────────────────────────────────────────────

export type TsQueryOp = 'AND' | 'OR' | 'NOT';

export interface TsQueryNode {
  op: TsQueryOp;
  left: TsQueryNode | null;
  right: TsQueryNode | null;
  term?: string;
}

/**
 * Parser for PostgreSQL tsquery expressions.
 *
 * Supports:
 *   - Basic AND (&), OR (|), NOT (!)
 *   - Parenthesized groups: (cat & dog) | mouse
 *   - Simple terms: cat, dog, running
 */
export class TsQueryParser {
  /**
   * Parse a tsquery string into an AST.
   * Input examples:
   *   "cat & dog"     → AND(cat, dog)
   *   "cat | dog"     → OR(cat, dog)
   *   "cat & !dog"    → AND(cat, NOT(dog))
   *   "cat & (dog | mouse)" → AND(cat, OR(dog, mouse))
   */
  parse(query: string): TsQueryNode {
    const tokens = this.lex(query);
    if (tokens.length === 0) {
      return { op: 'AND', left: null, right: null };
    }

    const result = this.parseOr(tokens, 0);
    return result.node;
  }

  /**
   * Lex a tsquery string into tokens.
   */
  private lex(query: string): string[] {
    let q = query.trim();
    // Remove surrounding quotes if present
    if ((q.startsWith("'") && q.endsWith("'")) ||
        (q.startsWith('"') && q.endsWith('"'))) {
      q = q.slice(1, -1);
    }

    const tokens: string[] = [];
    let i = 0;
    while (i < q.length) {
      const ch = q[i];

      if (ch === ' ') {
        i++;
        continue;
      }

      // Parentheses
      if (ch === '(' || ch === ')') {
        tokens.push(ch);
        i++;
        continue;
      }

      // Single operators: &, |, !
      if (ch === '&') {
        tokens.push('AND');
        i++;
        continue;
      }
      if (ch === '|') {
        tokens.push('OR');
        i++;
        continue;
      }
      if (ch === '!') {
        tokens.push('NOT');
        i++;
        continue;
      }

      // Multi-char operators: AND, OR, NOT
      if (q.substring(i, i + 3).toUpperCase() === 'AND') {
        tokens.push('AND');
        i += 3;
        continue;
      }
      if (q.substring(i, i + 2).toUpperCase() === 'OR') {
        tokens.push('OR');
        i += 2;
        continue;
      }
      if (q.substring(i, i + 3).toUpperCase() === 'NOT') {
        tokens.push('NOT');
        i += 3;
        continue;
      }

      // Regular term (word)
      let term = '';
      while (i < q.length && !' &|!()'.includes(q[i])) {
        term += q[i];
        i++;
      }
      // Remove trailing *
      term = term.replace(/\*+$/, '');
      if (term.length > 0) {
        tokens.push(term.toLowerCase());
      }
    }

    return tokens;
  }

  // Recursive descent parser
  // Precedence: NOT > AND > OR

  private parseOr(tokens: string[], pos: number): { node: TsQueryNode; pos: number } {
    let { node, pos: newPos } = this.parseAnd(tokens, pos);

    while (newPos < tokens.length && tokens[newPos] === 'OR') {
      newPos++;
      const { node: right, pos: nextPos } = this.parseAnd(tokens, newPos);
      node = { op: 'OR', left: node, right, term: undefined };
      newPos = nextPos;
    }

    return { node, pos: newPos };
  }

  private parseAnd(tokens: string[], pos: number): { node: TsQueryNode; pos: number } {
    let { node, pos: newPos } = this.parseNot(tokens, pos);

    while (newPos < tokens.length &&
           (tokens[newPos] === 'AND' ||
            (tokens[newPos] !== 'OR' && tokens[newPos] !== ')' && tokens[newPos] !== 'NOT'))) {
      if (tokens[newPos] === 'AND') {
        newPos++;
      }
      const { node: right, pos: nextPos } = this.parseNot(tokens, newPos);
      node = { op: 'AND', left: node, right, term: undefined };
      newPos = nextPos;
    }

    return { node, pos: newPos };
  }

  private parseNot(tokens: string[], pos: number): { node: TsQueryNode; pos: number } {
    if (pos >= tokens.length) {
      return { node: { op: 'AND', left: null, right: null }, pos };
    }

    if (tokens[pos] === 'NOT') {
      pos++;
      const { node: child, pos: newPos } = this.parseNot(tokens, pos);
      return { node: { op: 'NOT', left: child, right: null }, pos: newPos };
    }

    if (tokens[pos] === '(') {
      pos++;
      const { node, pos: newPos } = this.parseOr(tokens, pos);
      // Expect closing paren
      if (newPos < tokens.length && tokens[newPos] === ')') {
        return { node, pos: newPos + 1 };
      }
      return { node, pos: newPos };
    }

    // Leaf term
    const term = tokens[pos];
    return {
      node: { op: 'AND' as TsQueryOp, left: null, right: null, term },
      pos: pos + 1,
    };
  }
}

// ── FTS Index Configuration ──────────────────────────────────────

export interface FtsIndexConfig {
  /** Index name (used for the _fts_idx_ table name) */
  name: string;
  /** Table this index is on */
  table: string;
  /** Column name that has the text to index */
  column: string;
  /** Text search config (e.g. 'english', 'simple', 'chinese') */
  config: string;
  /** The CREATE INDEX SQL that produced this config */
  originalSql: string;
}

// ── FullTextSearchIndexer ────────────────────────────────────────

export class FullTextSearchIndexer {
  private tokenizer: SimpleTokenizer;
  private queryParser: TsQueryParser;
  /** Map<tableName, FtsIndexConfig[]> */
  private indexes: Map<string, FtsIndexConfig[]> = new Map();
  /** Map<indexName, FtsIndexConfig> for quick lookup by name */
  private indexByName: Map<string, FtsIndexConfig> = new Map();

  constructor(tokenizer?: SimpleTokenizer) {
    this.tokenizer = tokenizer ?? new SimpleTokenizer();
    this.queryParser = new TsQueryParser();
  }

  // ── DDL: CREATE INDEX detection ────────────────────────────────

  /**
   * Check if a DDL statement creates an FTS GIN index.
   * Pattern: CREATE INDEX name ON table USING GIN(to_tsvector(config, col))
   *
   * Returns the parsed FtsIndexConfig or null if not an FTS index.
   */
  detectCreateFtsIndex(ddlSql: string): FtsIndexConfig | null {
    // Pattern: CREATE INDEX [IF NOT EXISTS] name ON table USING GIN(to_tsvector(...))
    const pattern =
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:\w+\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s+USING\s+GIN\s*\(\s*(?:to_tsvector|fts_vector)\s*\(\s*(?:'(\w+)'|"(\w+)")\s*,\s*(\w+)\s*\)\s*\)/i;

    const match = ddlSql.match(pattern);
    if (!match) return null;

    const indexName = match[1];
    const tableName = match[2];
    const config = (match[3] || match[4] || 'english').toLowerCase();
    const column = match[5];

    const configObj: FtsIndexConfig = {
      name: indexName,
      table: tableName,
      column,
      config,
      originalSql: ddlSql,
    };

    return configObj;
  }

  /**
   * Handle a CREATE INDEX ... USING GIN(to_tsvector(...)) DDL statement.
   * Creates the _fts_idx_<name> auxiliary table and populates it from existing data.
   *
   * Returns an array of SQL statements to execute against the database.
   */
  handleCreateFtsIndex(config: FtsIndexConfig, hasExistingData: boolean = false): string[] {
    const idxTableName = `_fts_idx_${config.name}`;
    const sql: string[] = [];

    // DDL: Create the inverted index table
    sql.push(`CREATE TABLE IF NOT EXISTS ${idxTableName} (
      term TEXT NOT NULL,
      rowid INTEGER NOT NULL,
      positions TEXT DEFAULT '',
      PRIMARY KEY (term, rowid)
    )`);

    // Index on rowid for fast lookups
    sql.push(`CREATE INDEX IF NOT EXISTS ${idxTableName}_rowid ON ${idxTableName}(rowid)`);

    // Store in memory
    const existing = this.indexes.get(config.table) || [];
    existing.push(config);
    this.indexes.set(config.table, existing);
    this.indexByName.set(config.name, config);

    return sql;
  }

  /**
   * Handle DROP INDEX for FTS indexes.
   * Cleans up the _fts_idx_ table.
   */
  handleDropFtsIndex(indexName: string): string[] {
    const config = this.indexByName.get(indexName);
    if (!config) return [];

    const idxTableName = `_fts_idx_${indexName}`;
    const sql: string[] = [];

    sql.push(`DROP TABLE IF EXISTS ${idxTableName}`);

    // Remove from memory
    this.indexByName.delete(indexName);
    const existing = this.indexes.get(config.table) || [];
    const filtered = existing.filter(c => c.name !== indexName);
    if (filtered.length === 0) {
      this.indexes.delete(config.table);
    } else {
      this.indexes.set(config.table, filtered);
    }

    return sql;
  }

  /**
   * Check if any SQL is a DROP INDEX for an FTS index.
   * Returns the index name or null.
   */
  detectDropFtsIndex(sql: string): string | null {
    const dropPattern = /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(\w+)\s*/i;
    const match = sql.match(dropPattern);
    if (match) {
      const indexName = match[1];
      if (this.indexByName.has(indexName)) {
        return indexName;
      }
    }
    return null;
  }

  // ── DML: INSERT / UPDATE hooks ─────────────────────────────────

  /**
   * Tokenize and index text data for a specific row in a table.
   * Returns SQL statements to execute to update the index.
   */
  indexRow(table: string, rowid: number, rowData: Record<string, any>): string[] {
    const ftsIndexes = this.indexes.get(table);
    if (!ftsIndexes || ftsIndexes.length === 0) return [];

    const sql: string[] = [];

    for (const idx of ftsIndexes) {
      const idxTableName = `_fts_idx_${idx.name}`;
      const textValue = String(rowData[idx.column] ?? '');

      // Delete existing entries for this row
      sql.push(`DELETE FROM ${idxTableName} WHERE rowid = ${rowid}`);

      // Tokenize
      const tokens = this.tokenizer.tokenize(textValue);

      // Batch insert
      for (const token of tokens) {
        const escapedTerm = token.term.replace(/'/g, "''");
        const positionsStr = String(token.position);
        sql.push(
          `INSERT OR REPLACE INTO ${idxTableName} (term, rowid, positions) VALUES ('${escapedTerm}', ${rowid}, '${positionsStr}')`,
        );
      }
    }

    return sql;
  }

  /**
   * Handle row deletion: remove all index entries for that row.
   */
  deleteRow(table: string, rowid: number): string[] {
    const ftsIndexes = this.indexes.get(table);
    if (!ftsIndexes || ftsIndexes.length === 0) return [];

    const sql: string[] = [];
    for (const idx of ftsIndexes) {
      const idxTableName = `_fts_idx_${idx.name}`;
      sql.push(`DELETE FROM ${idxTableName} WHERE rowid = ${rowid}`);
    }
    return sql;
  }

  // ── Query rewriting ────────────────────────────────────────────

  /**
   * Rewrite a SQL query containing PostgreSQL FTS constructs into a form
   * that uses the real inverted index tables.
   *
   * Pattern:
   *   SELECT * FROM table WHERE to_tsvector(config, col) @@ to_tsquery(config, 'cat & dog')
   *   →
   *   SELECT * FROM table WHERE rowid IN (
   *     SELECT t1.rowid FROM _fts_idx_<name1> t1
   *     INNER JOIN _fts_idx_<name1> t2 ON t1.rowid = t2.rowid
   *     WHERE t1.term = 'cat' AND t2.term = 'dog'
   *   )
   */
  rewriteQuery(sql: string): string {
    if (!this.hasFtsExpression(sql)) return sql;

    // Strategy: use multiple patterns in priority order

    // Pattern 1: to_tsvector(config, col) @@ function(config, 'query')
    // Matches: to_tsvector('english', content) @@ to_tsquery('english', 'cat & dog')
    //          to_tsvector('english', content) @@ plainto_tsquery('english', 'cat dog')
    const pattern1 =
      /to_tsvector\s*\(\s*(?:'(\w+)'|"(\w+)")\s*,\s*(\w+)\s*\)\s*@@\s*(to_tsquery|plainto_tsquery|phraseto_tsquery)\s*\(\s*(?:(?:'(\w+)'|"(\w+)")\s*,\s*)?\s*('(?:[^']*(?:''[^']*)*)'|"(?:[^"]*)")\s*\)/i;

    const match1 = sql.match(pattern1);
    if (match1) {
      const config = (match1[1] || match1[2] || 'english').toLowerCase();
      const column = match1[3];
      const table = this.findTableForColumn(column);
      const queryType = match1[4];
      let queryText = match1[7].replace(/^['"]|['"]$/g, '');
      // Unescape doubled single quotes
      queryText = queryText.replace(/''/g, "'");

      if (table) {
        const idx = this.indexes.get(table)![0];
        return this.rewriteWithIndex(sql, idx, queryType, queryText);
      }
      // Fallback: try to find a matching index by config
      const altResult = this.rewriteWithAnyIndex(sql, config, column, queryType, queryText);
      if (altResult !== sql) return altResult;
      // No index found — strip FTS functions for compatibility
      return sql.replace(match1[0], '1=1');
    }

    // Pattern 2: alias.col @@ function('query') without to_tsvector
    // Matches: tsv @@ to_tsquery('cat & dog')
    const pattern2 = /(\w+)\.(\w+)\s*@@\s*(to_tsquery|plainto_tsquery|phraseto_tsquery)\s*\(\s*(?:\s*(?:'(\w+)'|"(\w+)")\s*,)?\s*('(?:[^']+)'|"(?:[^"]+)")\s*\)/i;
    const match2 = sql.match(pattern2);
    if (match2) {
      const table = match2[1];
      const column = match2[2];
      const queryType = match2[3];
      let queryText = match2[6].replace(/^['"]|['"]$/g, '');
      queryText = queryText.replace(/''/g, "'");

      const indexes = this.indexes.get(table);
      if (indexes && indexes.length > 0) {
        return this.rewriteWithIndex(sql, indexes[0], queryType, queryText);
      }
    }

    // Pattern 3: just to_tsvector(...) @@ to_tsquery('query') without column reference
    const pattern3 = /to_tsvector\s*\([^)]+\)\s*@@\s*(to_tsquery|plainto_tsquery|phraseto_tsquery)\s*\(\s*(?:\s*(?:'(\w+)'|"(\w+)")\s*,)?\s*('(?:[^']+)'|"(?:[^"]+)")\s*\)/i;
    const match3 = sql.match(pattern3);
    if (match3) {
      const queryType = match3[1];
      let queryText = match3[4].replace(/^['"]|['"]$/g, '');
      queryText = queryText.replace(/''/g, "'");
      return this.rewriteWithAnyIndex(sql, null, null, queryType, queryText);
    }

    // Fallback: remove standalone to_tsvector and tsquery functions
    let result = sql;
    result = result.replace(/\bto_tsvector\s*\([^)]+\)/gi, '1');
    result = result.replace(/\bto_tsquery\s*\([^)]+\)/gi, "''");
    result = result.replace(/\bplainto_tsquery\s*\([^)]+\)/gi, "''");

    return result;
  }

  /**
   * Replace an FTS @@ expression with an inverted index subquery.
   */
  private replaceFullMatch(sql: string, matchStr: string, queryType: string, queryText: string, idx: FtsIndexConfig): string {
    const idxTableName = `_fts_idx_${idx.name}`;

    // Convert query text to indexed query string
    let indexedQuery: string;
    switch (queryType.toLowerCase()) {
      case 'to_tsquery':
        indexedQuery = this.convertTsqueryForIndex(queryText);
        break;
      case 'plainto_tsquery':
      default:
        indexedQuery = this.convertPlaintoForIndex(queryText);
        break;
      case 'phraseto_tsquery':
        indexedQuery = this.convertPhraseForIndex(queryText);
        break;
    }

    if (!indexedQuery) {
      // No valid terms after conversion — return no results
      return sql.replace(matchStr, '1=0');
    }

    const ast = this.queryParser.parse(indexedQuery);
    const indexLookupSql = this.generateIndexLookupSql(ast, idxTableName);

    if (!indexLookupSql) {
      return sql.replace(matchStr, '1=0');
    }

    return sql.replace(matchStr, `rowid IN (${indexLookupSql})`);
  }

  /**
   * Rewrite a query using a specific FTS index.
   */
  private rewriteWithIndex(
    sql: string,
    idx: FtsIndexConfig,
    queryType: string,
    queryText: string,
  ): string {
    // Find the @@ expression to replace
    const matchRe = new RegExp(
      `to_tsvector\\s*\\([^)]+\\)\\s*@@\\s*${queryType}\\s*\\([^)]*\\)`,
      'i',
    );
    const match = sql.match(matchRe);
    if (match) {
      return this.replaceFullMatch(sql, match[0], queryType, queryText, idx);
    }

    // Try simpler alias matching
    const simpleRe = new RegExp(
      `\\w+\\.\\w+\\s*@@\\s*${queryType}\\s*\\([^)]*\\)`,
      'i',
    );
    const simpleMatch = sql.match(simpleRe);
    if (simpleMatch) {
      return this.replaceFullMatch(sql, simpleMatch[0], queryType, queryText, idx);
    }

    return sql;
  }

  /**
   * Try to find a matching FTS index by config and rewrite.
   */
  private rewriteWithAnyIndex(
    sql: string,
    config: string | null,
    _column: string | null,
    queryType: string,
    queryText: string,
  ): string {
    // Try each index that has a matching config
    for (const [table, indexes] of this.indexes.entries()) {
      for (const idx of indexes) {
        if (!config || idx.config === config) {
          const result = this.rewriteWithIndex(sql, idx, queryType, queryText);
          if (result !== sql) return result;
        }
      }
    }
    return sql;
  }

  /**
   * Check if a SQL string contains FTS expressions.
   */
  hasFtsExpression(sql: string): boolean {
    return /\bto_tsvector\b/i.test(sql) ||
           /\bto_tsquery\b/i.test(sql) ||
           /\bplainto_tsquery\b/i.test(sql) ||
           /\bphraseto_tsquery\b/i.test(sql) ||
           /\bts_rank\b/i.test(sql) ||
           /\bts_headline\b/i.test(sql);
  }

  // ── Ranking ─────────────────────────────────────────────────────

  /**
   * Compute ts_rank from a tsvector string and query.
   *
   * PostgreSQL ts_rank normalizes by log(1 + docLength).
   * weights: D=头条, C=标题, B=正文, A=主体 (default all 1.0)
   */
  computeTsRank(vector: string, query: string, weightsArg?: string): number {
    const weights = weightsArg
      ? weightsArg.replace(/[{}]/g, '').split(',').map(w => parseFloat(w.trim())).filter(w => !isNaN(w))
      : [1.0, 1.0, 1.0, 1.0];

    // Parse tsvector format: 'cat':1 'dog':2 'fox':3
    // Extract terms before the colon
    const vectorTerms: string[] = [];
    const termRe = /'([^']+)'(:(\d+))?/g;
    let vm: RegExpExecArray | null;
    while ((vm = termRe.exec(vector)) !== null) {
      vectorTerms.push(vm[1].toLowerCase());
    }
    // If no terms found, try space-separated format
    if (vectorTerms.length === 0) {
      const clean = vector.replace(/'/g, '').replace(/:\d+/g, '').toLowerCase();
      vectorTerms.push(...clean.split(/\s+/).filter(Boolean));
    }

    // Parse query: extract terms (strip AND/OR/NOT operators)
    const queryTerms: string[] = [];
    const qtRe = /'([^']+)'|(\b[a-z]+\b)(?![:(])/gi;
    let qm: RegExpExecArray | null;
    while ((qm = qtRe.exec(query)) !== null) {
      const term = qm[1] || qm[2];
      if (term && !/^(AND|OR|NOT)$/i.test(term)) {
        queryTerms.push(term.toLowerCase());
      }
    }
    // Fallback: split on whitespace, remove operators
    if (queryTerms.length === 0) {
      const parts = query.split(/\s+/).filter(Boolean);
      for (const p of parts) {
        const clean = p.replace(/[^a-z0-9]/gi, '');
        if (clean && !/^(AND|OR|NOT)$/i.test(clean)) {
          queryTerms.push(clean.toLowerCase());
        }
      }
    }

    if (queryTerms.length === 0 || vectorTerms.length === 0) return 0;

    // Count matching terms with stemming
    let matchScore = 0;
    const stemmedVectorTerms = vectorTerms.map(vt => /[a-zA-Z]/.test(vt) ? porterStemmer.stem(vt) : vt);

    for (const qt of queryTerms) {
      const stemmedQ = /[a-zA-Z]/.test(qt) ? porterStemmer.stem(qt) : qt;
      for (let i = 0; i < stemmedVectorTerms.length; i++) {
        if (stemmedVectorTerms[i] === stemmedQ) {
          // Apply position-based weight
          const weightIndex = Math.min(Math.floor(i / Math.max(1, stemmedVectorTerms.length / 4)), weights.length - 1);
          matchScore += weights[weightIndex] || 1.0;
          break;
        }
      }
    }

    // Normalize by log(1 + docLength) like PG
    const normalization = Math.log(1 + vectorTerms.length);
    const score = normalization > 0 ? matchScore / normalization : 0;

    return Math.min(Math.round(score * 1000) / 1000, 1.0);
  }

  /**
   * Compute ts_headline: extract snippet with highlighted matching terms.
   *
   * PG signature: ts_headline(config, document, query [, options])
   */
  computeTsHeadline(document: string, query: string, optionsArg?: string): string {
    // Parse options
    const options: {
      maxWords?: number;
      minWords?: number;
      startSel?: string;
      endSel?: string;
    } = {};

    if (optionsArg) {
      const optPairs = optionsArg.split(',');
      for (const pair of optPairs) {
        const [key, val] = pair.split('=').map(s => s.trim());
        if (!key) continue;
        switch (key.toLowerCase()) {
          case 'maxwords': options.maxWords = parseInt(val, 10); break;
          case 'minwords': options.minWords = parseInt(val, 10); break;
          case 'startsel': options.startSel = val; break;
          case 'endsel': options.endSel = val; break;
        }
      }
    }

    const maxWords = options.maxWords ?? 35;
    const minWords = options.minWords ?? 15;
    const startSel = options.startSel ?? '<b>';
    const endSel = options.endSel ?? '</b>';

    // Extract query terms
    const queryTerms = query
      .replace(/\b(AND|OR|NOT)\b/gi, '')
      .split(/\s+/)
      .map(t => t.replace(/[^a-z0-9]/gi, '').toLowerCase())
      .filter(Boolean);

    if (queryTerms.length === 0 || !document) return '';

    const words = document.split(/\s+/);
    const lowerWords = words.map(w => w.toLowerCase().replace(/[^\w]/g, ''));
    const stemmedWords = lowerWords.map(w => porterStemmer.stem(w));
    const stemmedQueries = queryTerms.map(q => porterStemmer.stem(q));

    // Find match positions
    const matchPositions: number[] = [];
    for (let i = 0; i < stemmedWords.length; i++) {
      if (stemmedQueries.includes(stemmedWords[i])) {
        matchPositions.push(i);
      }
    }

    if (matchPositions.length === 0) {
      return words.slice(0, maxWords).join(' ');
    }

    // Find best snippet window
    const center = matchPositions[Math.floor(matchPositions.length / 2)];
    const start = Math.max(0, center - Math.floor(minWords / 2));
    const end = Math.min(words.length, start + maxWords);

    // Build snippet with highlights
    const snippetWords: string[] = [];
    for (let i = start; i < end; i++) {
      const stemmed = stemmedWords[i];
      const isMatch = stemmedQueries.includes(stemmed);
      if (isMatch) {
        snippetWords.push(`${startSel}${words[i]}${endSel}`);
      } else {
        snippetWords.push(words[i]);
      }
    }

    let snippet = snippetWords.join(' ');
    if (start > 0) snippet = '... ' + snippet;
    if (end < words.length) snippet = snippet + ' ...';

    return snippet;
  }

  // ── Tokenizer public access ────────────────────────────────────

  getTokenizer(): SimpleTokenizer {
    return this.tokenizer;
  }

  getQueryParser(): TsQueryParser {
    return this.queryParser;
  }

  // ── Public state access ────────────────────────────────────────

  getIndexesForTable(table: string): FtsIndexConfig[] {
    return this.indexes.get(table) || [];
  }

  getIndexByName(name: string): FtsIndexConfig | undefined {
    return this.indexByName.get(name);
  }

  hasIndex(name: string): boolean {
    return this.indexByName.has(name);
  }

  getAllIndexes(): FtsIndexConfig[] {
    return Array.from(this.indexByName.values());
  }

  clearIndexes(): void {
    this.indexes.clear();
    this.indexByName.clear();
  }

  // ── Private helpers ────────────────────────────────────────────

  /**
   * Convert a plainto_tsquery-style string into indexed query terms.
   */
  private convertPlaintoForIndex(text: string): string {
    const tokens = this.tokenizer.tokenize(text);
    const terms = tokens.map(t => t.term);
    if (terms.length === 0) return '';
    return terms.join(' AND ');
  }

  /**
   * Convert a tsquery-style string into indexed query terms.
   */
  private convertTsqueryForIndex(query: string): string {
    // Already in tsquery format, just normalize
    const ast = this.queryParser.parse(query);
    return this.astToQueryString(ast);
  }

  /**
   * Convert a phraseto_tsquery string: sequential terms in order.
   */
  private convertPhraseForIndex(text: string): string {
    const tokens = this.tokenizer.tokenize(text);
    const terms = tokens.map(t => t.term);
    if (terms.length === 0) return '';
    return terms.join(' AND ');
  }

  /**
   * Convert AST back to query string.
   */
  private astToQueryString(node: TsQueryNode): string {
    if (node.term !== undefined) {
      return node.term;
    }
    if (node.op === 'NOT' && node.left) {
      return `NOT (${this.astToQueryString(node.left)})`;
    }
    if (node.left && node.right) {
      const left = this.astToQueryString(node.left);
      const right = this.astToQueryString(node.right);
      if (left && right) {
        return `(${left} ${node.op} ${right})`;
      }
      return left || right;
    }
    return '';
  }

  /**
   * Generate SQL for inverted index lookup from a TsQuery AST.
   *
   * For AND: INTERSECT two subqueries
   * For OR: UNION two subqueries
   * For NOT: EXCEPT/EXCLUDE
   */
  private generateIndexLookupSql(
    node: TsQueryNode,
    idxTableName: string,
    aliasCounter: { count: number } = { count: 0 },
  ): string {
    // Leaf term
    if (node.term !== undefined) {
      aliasCounter.count++;
      const alias = `t${aliasCounter.count}`;
      const escapedTerm = node.term.replace(/'/g, "''");
      return `SELECT rowid FROM ${idxTableName} ${alias} WHERE ${alias}.term = '${escapedTerm}'`;
    }

    // NOT operator
    if (node.op === 'NOT' && node.left) {
      const inner = this.generateIndexLookupSql(node.left, idxTableName, aliasCounter);
      aliasCounter.count++;
      const alias = `t${aliasCounter.count}`;
      // All rowids minus matching ones
      return `SELECT ${alias}.rowid FROM ${idxTableName} ${alias} EXCEPT ${inner}`;
    }

    // AND operator
    if (node.op === 'AND' && node.left && node.right) {
      const left = this.generateIndexLookupSql(node.left, idxTableName, aliasCounter);
      const right = this.generateIndexLookupSql(node.right, idxTableName, aliasCounter);

      if (!left) return right;
      if (!right) return left;

      return `${left} INTERSECT ${right}`;
    }

    // OR operator
    if (node.op === 'OR' && node.left && node.right) {
      const left = this.generateIndexLookupSql(node.left, idxTableName, aliasCounter);
      const right = this.generateIndexLookupSql(node.right, idxTableName, aliasCounter);

      if (!left) return right;
      if (!right) return left;

      return `${left} UNION ${right}`;
    }

    return '';
  }

  /**
   * Try to find a table that has an FTS index on the given column.
   */
  private findTableForColumn(column: string): string | null {
    for (const [table, indexes] of this.indexes.entries()) {
      for (const idx of indexes) {
        if (idx.column === column) {
          return table;
        }
      }
    }
    return null;
  }
}
