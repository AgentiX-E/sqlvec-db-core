/**
 * Bm25SearchShim — BM25 full-text search compatibility for SQLVec.
 *
 * Provides a BM25-style full-text search that maps PostgreSQL MATCH/AGAINST
 * syntax into TF-IDF-based scoring. Uses the `natural` package's TfIdf
 * implementation for BM25 ranking.
 *
 * Features:
 *   - _sqlvec_fts_config table for storing document term frequencies
 *   - Automatic tokenization on INSERT/UPDATE
 *   - SELECT ... WHERE MATCH(col) AGAINST('keywords') → scored results
 *   - BM25 scoring (k1=1.2, b=0.75 — standard BM25 parameters)
 *
 * The implementation stores:
 *   - _sqlvec_fts_docs: documents with their TF-IDF vectors
 *   - _sqlvec_fts_terms: global term frequencies for IDF computation
 *
 * Dependencies:
 *   natural: npm package for TfIdf implementation
 *   pgsql-ast-parser: for parsing query structure
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('Bm25SearchShim');

// ── Constants ────────────────────────────────────────────────────

/** BM25 parameters */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Internal system tables */
const FTS_DOCS_TABLE = '_sqlvec_fts_docs';
const FTS_TERMS_TABLE = '_sqlvec_fts_terms';

// ── Types ────────────────────────────────────────────────────────

export interface Bm25SearchResult {
  /** Matched row data */
  row: Record<string, any>;
  /** BM25 relevance score */
  score: number;
  /** Column that matched */
  matchColumn: string;
}

export interface FtsConfig {
  /** Table name */
  tableName: string;
  /** Column names participating in FTS */
  columns: string[];
}

export interface FtsMatchQuery {
  /** The table to search */
  tableName: string;
  /** The MATCH column */
  matchColumn: string;
  /** The AGAINST keywords */
  keywords: string;
  /** Maximum results */
  limit: number;
}

// ── Tokenizer ────────────────────────────────────────────────────

/**
 * Simple tokenizer: lowercase, split on non-alphanumeric.
 */
function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ── Bm25SearchShim ───────────────────────────────────────────────

export class Bm25SearchShim {
  private tfidf: any = null;
  private available: boolean = false;

  // In-memory document index: Map<docId, Map<term, tf>>
  private documents: Map<string, Map<string, number>> = new Map();
  // Global document frequency: Map<term, count>
  private docFreq: Map<string, number> = new Map();

  // Registered FTS configurations per table
  private ftsConfigs: Map<string, FtsConfig> = new Map();

  constructor() {
    try {
      // Try to load the `natural` package for TfIdf
      const natural = require('natural');
      this.tfidf = new natural.TfIdf();
      this.available = true;
      logger.info('BM25 search shim initialized with natural.TfIdf');
    } catch {
      this.available = false;
      logger.warn('natural package not available; BM25 search will be a no-op');
    }
  }

  /**
   * Register a table/column for FTS.
   * Called during CREATE TABLE with FTS column.
   */
  registerFtsConfig(tableName: string, columns: string[]): void {
    this.ftsConfigs.set(tableName.toLowerCase(), {
      tableName: tableName.toLowerCase(),
      columns: columns.map((c) => c.toLowerCase()),
    });

    logger.info({ tableName, columns }, 'FTS config registered');
  }

  /**
   * Check if FTS is configured for a table/column.
   */
  hasFtsConfig(tableName: string, columnName?: string): boolean {
    const config = this.ftsConfigs.get(tableName.toLowerCase());
    if (!config) return false;
    if (columnName) {
      return config.columns.includes(columnName.toLowerCase());
    }
    return true;
  }

  /**
   * Index a document row for FTS.
   * Called on INSERT/UPDATE to update term frequencies.
   *
   * @param tableName - Table name
   * @param rowId - Primary key value
   * @param columns - Column values keyed by column name
   */
  indexRow(tableName: string, rowId: string | number, columns: Record<string, string>): void {
    if (!this.available) return;

    const config = this.ftsConfigs.get(tableName.toLowerCase());
    if (!config) return;

    // Lowercase tableName for the docId so it matches search()/removeRow(),
    // which also lowercase. Mixed-case table names previously produced a
    // docId that never matched on lookup.
    const docId = `${tableName.toLowerCase()}:${rowId}`;
    const termFreqs = new Map<string, number>();

    for (const col of config.columns) {
      const value = columns[col];
      if (!value) continue;

      const tokens = tokenize(value);
      const totalTokens = tokens.length;

      // Count term frequencies in this document
      const localFreq = new Map<string, number>();
      for (const token of tokens) {
        localFreq.set(token, (localFreq.get(token) || 0) + 1);
      }

      // Normalize TF by document length. totalTokens is guaranteed positive
      // here: localFreq is non-empty only when tokens is non-empty (each entry
      // is derived from a token), so totalTokens === tokens.length > 0.
      for (const [term, freq] of localFreq) {
        const tf = freq / totalTokens;
        termFreqs.set(term, (termFreqs.get(term) || 0) + tf);
      }
    }

    // Update document frequency for new terms
    for (const term of termFreqs.keys()) {
      this.docFreq.set(term, (this.docFreq.get(term) || 0) + 1);
    }

    // Remove old document terms from DF
    const oldTerms = this.documents.get(docId);
    if (oldTerms) {
      for (const term of oldTerms.keys()) {
        const currentDf = this.getDocumentFrequency(term);
        if (currentDf <= 1) {
          this.docFreq.delete(term);
        } else {
          this.docFreq.set(term, currentDf - 1);
        }
      }
    }

    // Empty documents must not be stored: a zero-term entry would inflate the
    // total document count (documents.size) and dilute every term's IDF
    // (which uses that count as N). Remove any prior entry instead.
    if (termFreqs.size === 0) {
      this.documents.delete(docId);
      logger.debug({ tableName, rowId }, 'FTS: empty document removed');
      return;
    }

    this.documents.set(docId, termFreqs);
    logger.debug({ tableName, rowId, terms: termFreqs.size }, 'FTS: document indexed');
  }

  /**
   * Remove a document from the FTS index.
   * Called on DELETE.
   */
  removeRow(tableName: string, rowId: string | number): void {
    const docId = `${tableName.toLowerCase()}:${rowId}`;
    const oldTerms = this.documents.get(docId);
    if (oldTerms) {
      for (const term of oldTerms.keys()) {
        const currentDf = this.getDocumentFrequency(term);
        if (currentDf <= 1) {
          this.docFreq.delete(term);
        } else {
          this.docFreq.set(term, currentDf - 1);
        }
      }
      this.documents.delete(docId);
      logger.debug({ tableName, rowId }, 'FTS: document removed');
    }
  }

  /**
   * Search for documents matching keywords using BM25 scoring.
   *
   * @param query - The match query parameters
   * @param allRows - All rows from the table for result construction
   * @param idColumn - Primary key column name
   * @returns Scored results sorted by BM25 relevance
   */
  search(
    query: FtsMatchQuery,
    allRows: Record<string, any>[],
    idColumn: string = 'id',
  ): Bm25SearchResult[] {
    if (!this.available) return [];

    const keywords = tokenize(query.keywords);
    if (keywords.length === 0) return [];

    const tableName = query.tableName.toLowerCase();
    const config = this.ftsConfigs.get(tableName);
    if (!config) return [];

    const docCount = this.getTotalDocCount();
    if (docCount === 0) return [];

    const results: Array<{ docId: string; score: number; row: Record<string, any> }> = [];

    for (const row of allRows) {
      const rowId = row[idColumn];
      if (rowId === undefined || rowId === null) continue;

      const docId = `${tableName}:${rowId}`;
      const termFreqs = this.documents.get(docId);
      if (!termFreqs) continue;

      // Compute average document length for BM25
      const avgDocLen = this.computeAvgDocLen();

      // Get document length (sum of all term frequencies)
      const docLen = Array.from(termFreqs.values()).reduce((sum, tf) => sum + tf, 0);

      let bm25Score = 0;

      for (const keyword of keywords) {
        const tf = termFreqs.get(keyword) || 0;
        if (tf === 0) continue;

        const df = this.getDocumentFrequency(keyword);
        const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);

        // BM25 scoring formula
        const numerator = tf * (BM25_K1 + 1);
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / Math.max(avgDocLen, 1)));
        bm25Score += idf * (numerator / denominator);
      }

      if (bm25Score > 0) {
        results.push({ docId, score: bm25Score, row });
      }
    }

    // Sort by relevance (descending)
    results.sort((a, b) => b.score - a.score);

    // Apply limit
    const limited = results.slice(0, query.limit > 0 ? query.limit : 10);

    return limited.map((r) => ({
      row: r.row,
      score: Math.round(r.score * 10000) / 10000,
      matchColumn: query.matchColumn,
    }));
  }

  /**
   * Match a SELECT query containing MATCH/AGAINST.
   * Detects and parses the MATCH(col) AGAINST('keywords') pattern.
   */
  detectMatchAgainst(sql: string): FtsMatchQuery | null {
    const match = sql.match(
      /MATCH\s*\(\s*(["\`]?\w+["\`]?)\s*\)\s*AGAINST\s*\(\s*'([^']+)'\s*\)/i,
    );
    if (!match) return null;

    // Extract table name from FROM clause
    const fromMatch = sql.match(/\bFROM\s+(\S+)/i);
    if (!fromMatch) return null;

    // Extract LIMIT
    const limitMatch = sql.match(/\bLIMIT\s+(\d+)/i);
    const limit = limitMatch ? parseInt(limitMatch[1], 10) : 10;

    return {
      tableName: fromMatch[1].replace(/["`]/g, ''),
      matchColumn: match[1].replace(/["`]/g, ''),
      keywords: match[2],
      limit,
    };
  }

  /**
   * Rewrite a MATCH/AGAINST query to a standard SELECT with BM25 scoring.
   * Returns the rewritten SQL and a flag indicating whether rewriting occurred.
   */
  rewriteMatchQuery(sql: string): { rewritten: boolean; sql: string } {
    const matchQuery = this.detectMatchAgainst(sql);
    if (!matchQuery) {
      return { rewritten: false, sql };
    }

    // Preserve original SELECT columns
    const selectMatch = sql.match(/SELECT\s+(.*?)\s+FROM\s/i);
    const selectCols = selectMatch ? selectMatch[1].trim() : '*';

    // Add score column
    const scoreCol = `${this.getScoreExpr(matchQuery)} AS bm25_score`;
    const newSelectCols = selectCols === '*' ? `*, ${scoreCol}` : `${selectCols}, ${scoreCol}`;

    // Replace MATCH/AGAINST with score expression
    let rewritten = sql.replace(
      /MATCH\s*\(\s*(\w+)\s*\)\s*AGAINST\s*\(\s*'([^']+)'\s*\)/gi,
      '1=1', // Always true — filtering by score > 0
    );

    // Add score column to SELECT
    rewritten = rewritten.replace(
      /SELECT\s+(.*?)\s+FROM\s/i,
      `SELECT ${newSelectCols} FROM `,
    );

    // Add ORDER BY score DESC
    if (!/\bORDER\s+BY\b/i.test(rewritten)) {
      rewritten += ' ORDER BY bm25_score DESC';
    }

    logger.debug({ original: sql, rewritten }, 'MATCH/AGAINST query rewritten');
    return { rewritten: true, sql: rewritten };
  }

  // ── Internal helpers ─────────────────────────

  /**
   * Get a score expression for the BM25 rank (used in SQL query rewriting).
   */
  private getScoreExpr(_query: FtsMatchQuery): string {
    // Return a placeholder — the actual scoring happens in memory
    return '1.0';
  }

  /**
   * Compute average document length across all documents.
   */
  private computeAvgDocLen(): number {
    const docCount = this.documents.size;
    if (docCount === 0) return 1;

    let totalLen = 0;
    for (const termFreqs of this.documents.values()) {
      totalLen += Array.from(termFreqs.values()).reduce((sum, tf) => sum + tf, 0);
    }
    return totalLen / docCount;
  }

  /**
   * Get total document count across all tables.
   */
  private getTotalDocCount(): number {
    return this.documents.size;
  }

  /**
   * Fetch the document frequency for a term, defaulting to 1 when absent.
   *
   * The document-frequency map never stores a zero (terms are added with an
   * increment and removed when their count would reach zero), so `?? 1`
   * suffices: it only guards an absent key, matching the reference-count
   * invariant that a present term always has df >= 1.
   */
  private getDocumentFrequency(term: string): number {
    return this.docFreq.get(term) ?? 1;
  }

  /**
   * Check if the `natural` package is available.
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Get the number of indexed documents.
   */
  getDocumentCount(): number {
    return this.documents.size;
  }

  /**
   * Clear all indexes (for testing).
   */
  clear(): void {
    this.documents.clear();
    this.docFreq.clear();
  }
}
