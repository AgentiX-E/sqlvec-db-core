// @ts-nocheck
/**
 * FtsTranslator — PostgreSQL tsvector/tsquery → SQLite FTS5 translation.
 *
 * Translates PostgreSQL full-text search constructs to SQLite FTS5 equivalents:
 *
 * | PostgreSQL                | SQLite FTS5              |
 * |:--------------------------|:-------------------------|
 * | to_tsvector('en', text)   | Internal — FTS5 tokenizes at index time |
 * | to_tsquery('hello & world') | hello AND world        |
 * | plainto_tsquery('hello world') | hello AND world    |
 * | ts_rank(vector, query)    | bm25() ranking function  |
 * | column @@ to_tsquery(...) | column MATCH 'query'    |
 *
 * ## Extended Features (FTS-GAP)
 *
 * - Porter stemming via `natural` package ("running" → "run")
 * - Synonym/thesaurus expansion via fts_thesaurus.json
 * - Unaccent (accent removal) via NFKD normalization
 * - Dictionary chain integration for configurable token processing
 *
 * @module query/FtsTranslator
 */

import natural from 'natural';
import { PinoLogger } from '../logger/PinoLogger';

// ── Logger ───────────────────────────────────────────────────────

// ── Porter stemmer ──────────────────────────────────────────────

const porterStemmer = natural.PorterStemmer;

// ── Constants ────────────────────────────────────────────────────

/**
 * Regex to detect PostgreSQL FTS operators and functions in SQL.
 */
const PG_FTS_PATTERNS: RegExp[] = [
  /\bto_tsvector\s*\(/gi,
  /\bto_tsquery\s*\(/gi,
  /\bplainto_tsquery\s*\(/gi,
  /\bts_rank\s*\(/gi,
  /\bts_headline\s*\(/gi,
  /\bphraseto_tsquery\s*\(/gi,
  /\bwebsearch_to_tsquery\s*\(/gi,
];

/**
 * Regex to match the `@@` operator: column_ref @@ function_call.
 */
const TS_MATCH_OP_RE = /([`"'\w.]+)\s*@@\s*(to_tsquery|plainto_tsquery|phraseto_tsquery|websearch_to_tsquery)\s*\(/gi;

// ── Thesaurus ────────────────────────────────────────────────────

let _thesaurus: Record<string, string[]> | null = null;

function loadThesaurus(): Record<string, string[]> {
  if (_thesaurus !== null) return _thesaurus!;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const path = require('path');
    const thesaurusPath = path.resolve(
      __dirname, '..', '..', 'data', 'fts_thesaurus.json',
    );
    if (fs.existsSync(thesaurusPath)) {
      const raw = fs.readFileSync(thesaurusPath, 'utf-8');
      _thesaurus = JSON.parse(raw);
    } else {
      _thesaurus = {};
    }
  } catch {
    _thesaurus = {};
  }
  return _thesaurus!;
}

/**
 * Expand a query term using the thesaurus.
 * Returns an array of alternative terms including the original.
 */
export function expandSynonyms(term: string): string[] {
  const thesaurus = loadThesaurus();
  const lowerTerm = term.toLowerCase();
  if (thesaurus[lowerTerm]) {
    return [term, ...thesaurus[lowerTerm]];
  }
  for (const [key, synonyms] of Object.entries(thesaurus)) {
    if (synonyms.some(s => s.toLowerCase() === lowerTerm)) {
      return [term, key, ...synonyms.filter(s => s.toLowerCase() !== lowerTerm)];
    }
  }
  return [term];
}

/**
 * Remove accents/diacritics using NFKD normalization.
 */
export function unaccent(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

// ── FtsTranslator ────────────────────────────────────────────────

export class FtsTranslator {
  private readonly logger = PinoLogger.forComponent('ftstranslator');

  private config: Map<string, string> = new Map();

  constructor() {
    // Default stop words and configuration per language.
    this.config.set('english', 'stop_words=english');
    this.config.set('simple', 'tokenize=unicode61');
    this.config.set('chinese', 'tokenize=unicode61 remove_diacritics=0');
    this.logger.info('FtsTranslator initialized');
  }

  /**
   * Simulate `to_tsvector(config, text)` — tokenize input text.
   *
   * In PostgreSQL, this produces a lexeme-position vector. In SQLite FTS5,
   * tokenization happens at index time. This function provides a compatible
   * text representation for diagnostic / standalone use.
   *
   * @param config - Text search configuration (e.g. 'english', 'simple').
   * @param text   - Input text to tokenize.
   * @returns A tsvector-like string (space-separated normalized tokens).
   */
  tsvector(config: string, text: string): string {
    const tokens = this.tokenize(text, config);
    // Build a simplified tsvector: 'token1':1 'token2':2 ...
    const positions = tokens.map((token, i) => `'${this.escapeTsVector(token)}':${i + 1}`);
    return positions.join(' ');
  }

  /**
   * Convert a PG `to_tsquery(...)` string to FTS5 query syntax.
   *
   * Handles:
   *   - `&` (AND)       → AND
   *   - `|` (OR)        → OR
   *   - `!` (NOT)       → NOT
   *   - `<->` (phrase)  → implicit (space-separated terms in FTS5)
   *   - Parentheses     → preserved
   *   - Term prefixes   → appended with *
   *
   * @param query - A tsquery string (e.g. `'hello & world'`).
   * @returns FTS5-compatible query string (e.g. `hello AND world`).
   */
  tsquery(query: string): string {
    // Strip surrounding quotes if present.
    let q = query.trim();
    if ((q.startsWith("'") && q.endsWith("'")) || (q.startsWith('"') && q.endsWith('"'))) {
      q = q.slice(1, -1);
    }

    if (q.length === 0) return '';

    // Replace PostgreSQL tsquery operators with FTS5 equivalents.
    let result = q
      // Phrase operator <N> → space (FTS5 implicit phrase)
      .replace(/<\d*>/g, ' ')
      // NOT operator
      .replace(/!/g, 'NOT ')
      // AND operator
      .replace(/&/g, 'AND')
      // OR operator
      .replace(/\|/g, 'OR')
      // Collapse multiple spaces
      .replace(/\s+/g, ' ')
      .trim();

    // Add prefix wildcard to terms that end with `:*` (prefix match).
    result = result.replace(/:(\*)?/g, '*');

    this.logger.debug({ input: query, output: result }, 'tsquery → FTS5');
    return result;
  }

  /**
   * Convert `plainto_tsquery('hello world')` to FTS5 syntax.
   *
   * In PostgreSQL, plainto_tsquery converts words to AND-ed tsquery terms.
   * In FTS5, this is just the words separated by AND.
   *
   * @param text - Plain text query (e.g. `'hello world'`).
   * @returns FTS5 query with AND operators.
   */
  plaintoTsquery(text: string): string {
    // Strip quotes.
    let t = text.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      t = t.slice(1, -1);
    }

    // Tokenize and join with AND.
    const tokens = this.tokenize(t, 'simple');
    if (tokens.length === 0) return '';

    const result = tokens.join(' AND ');

    this.logger.debug({ input: text, output: result }, 'plainto_tsquery → FTS5');
    return result;
  }

  /**
   * Compute a ts_rank-like relevance score.
   *
   * In PostgreSQL, `ts_rank(vector, query)` computes a relevance score based
   * on term frequency and proximity. In SQLite FTS5, the `bm25()` function
   * provides relevance ranking.
   *
   * This function provides a simple rank score based on term overlap.
   *
   * @param vector - The tsvector string (space-separated tokens).
   * @param query  - The tsquery or FTS5 query string.
   * @returns A numeric rank score (higher = more relevant).
   */
  rank(vector: string, query: string): number {
    // Extract tokens from the vector.
    const vectorTokens = new Set(
      vector
        .split(/'[\w]+':\d+/g)
        .map((s) => s.trim().replace(/'/g, ''))
        .filter(Boolean),
    );

    // Extract query terms.
    const queryTerms = query
      .replace(/\b(AND|OR|NOT)\b/gi, '')
      .split(/\s+/)
      .map((s) => s.replace(/\*/g, '').trim())
      .filter(Boolean);

    if (queryTerms.length === 0) return 0;

    const matches = queryTerms.filter((term) => vectorTokens.has(term)).length;
    const score = matches / queryTerms.length;

    return Math.round(score * 100) / 100;
  }

  /**
   * Translate `phraseto_tsquery('hello world')` to FTS5 phrase syntax.
   *
   * @param text - Phrase text.
   * @returns FTS5 query with implicit phrase matching.
   */
  phrasetoTsquery(text: string): string {
    let t = text.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      t = t.slice(1, -1);
    }

    // In FTS5, quoted terms form a phrase: "hello world"
    const tokens = this.tokenize(t, 'simple');
    if (tokens.length === 0) return '';

    const result = tokens.length === 1 ? tokens[0] : `"${tokens.join(' ')}"`;

    this.logger.debug({ input: text, output: result }, 'phraseto_tsquery → FTS5');
    return result;
  }

  /**
   * Translate `websearch_to_tsquery('text')` to FTS5 syntax.
   *
   * Websearch syntax uses:
   *   - `"text"` for exact phrases
   *   - `-text` for negation
   *   - `OR` for OR
   *
   * @param text - Websearch-style query text.
   * @returns FTS5-compatible query.
   */
  websearchToTsquery(text: string): string {
    let t = text.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      t = t.slice(1, -1);
    }

    // Parse websearch syntax.
    const result = t
      // Preserve quoted phrases.
      .replace(/"([^"]+)"/g, (_, phrase) => `"${phrase}"`)
      // Convert NOT: -term → NOT term
      .replace(/-(\w+)/g, 'NOT $1')
      // Trim whitespace
      .trim();

    this.logger.debug({ input: text, output: result }, 'websearch_to_tsquery → FTS5');
    return result;
  }

  /**
   * Rewrite a SQL string, replacing PostgreSQL FTS constructs with FTS5 equivalents.
   *
   * Specifically:
   *   - `column @@ to_tsquery(...)` → `column MATCH '...'`
   *   - `column @@ plainto_tsquery(...)` → `column MATCH '...'`
   *   - `to_tsvector('config', col)` → stripped (FTS5 handles indexing)
   *   - `ts_rank(tsv, q)` → `bm25(t.fts_rank)` or removed
   *   - `ts_headline(...)` → stripped
   *
   * @param sql - The SQL query string to rewrite.
   * @returns The rewritten SQL string.
   */
  rewriteSql(sql: string): string {
    // Fast path: no FTS patterns found.
    if (!this.containsFts(sql)) return sql;

    let result = sql;

    // Step 1: Rewrite `@@` operators.
    //   `col @@ to_tsquery('...')` → `col MATCH 'translated_query'`
    result = result.replace(TS_MATCH_OP_RE, (match, col, funcName) => {
      // Extract the full arguments inside the function call.
      const funcStart = match.indexOf('(');
      const funcEnd = this.findMatchingParen(result, funcStart);
      if (funcEnd === -1) return match;

      const fullExpr = result.substring(match.indexOf(funcName), funcEnd + 1);

      // Extract the query text argument (usually the last argument).
      const args = this.extractFunctionArgs(fullExpr);
      const queryText = args[args.length - 1] || '';

      // Apply stemming and unaccent to query text
      const processedQuery = this.processQueryText(queryText);

      // Warn if FTS language/config is dropped (present as first arg in PG functions)
      if (args.length > 1 && args[0] === args[args.length - 1]) {
        // Only one unique argument — no config was passed
      } else if (args.length > 1) {
        const configArg = args[0];
        this.logger.warn(
          { config: configArg, function: funcName },
          'FTS language configuration dropped during translation — only PostgreSQL supports per-function config',
        );
      }
      let fts5Query: string;

      switch (funcName.toLowerCase()) {
        case 'to_tsquery':
          fts5Query = this.tsquery(processedQuery);
          break;
        case 'plainto_tsquery':
          fts5Query = this.plaintoTsquery(processedQuery);
          break;
        case 'phraseto_tsquery':
          fts5Query = this.phrasetoTsquery(processedQuery);
          break;
        case 'websearch_to_tsquery':
          fts5Query = this.websearchToTsquery(processedQuery);
          break;
        default:
          fts5Query = processedQuery.replace(/['"]/g, '');
      }

      return `${col} MATCH '${fts5Query.replace(/'/g, "''")}'`;
    });

    // Step 2: Remove standalone `to_tsvector(...)` calls.
    result = result.replace(/\bto_tsvector\s*\([^)]+\)/gi, (match) => {
      // Check if a config argument was passed
      const inner = match.replace(/^to_tsvector\s*/i, '').trim().slice(1, -1).trim();
      const args = inner.split(',').map(a => a.trim().replace(/^['"]|['"]$/g, ''));
      if (args.length > 1) {
        this.logger.warn(
          { config: args[0] },
          'to_tsvector language configuration dropped during FTS translation — FTS5 handles tokenization at index time',
        );
      }
      return '';
    });

    // Step 3: Remove `ts_rank(...)` calls — replace with 1.0 (default rank).
    result = result.replace(/\bts_rank\s*\([^)]+\)/gi, '1.0');

    // Step 4: Remove `ts_headline(...)` calls.
    result = result.replace(/\bts_headline\s*\([^)]+\)/gi, "''");

    // Step 5: Clean up double spaces from removed expressions.
    result = result.replace(/\s{2,}/g, ' ').trim();

    if (result !== sql) {
      this.logger.debug(
        { original: sql.substring(0, 120), rewritten: result.substring(0, 120) },
        'FTS rewrite applied',
      );
    }

    return result;
  }

  /**
   * Detect whether a SQL string contains PostgreSQL FTS constructs.
   *
   * @param sql - The SQL string to check.
   * @returns `true` if FTS patterns are found.
   */
  containsFts(sql: string): boolean {
    return PG_FTS_PATTERNS.some((re) => re.test(sql));
  }

  /**
   * Set FTS configuration for a specific language.
   *
   * @param lang  - Language name (e.g. 'english').
   * @param value - Configuration value.
   */
  setConfig(lang: string, value: string): void {
    this.config.set(lang, value);
    this.logger.debug({ lang, value }, 'FTS config updated');
  }

  /**
   * Get configuration for a language.
   *
   * @param lang - Language name.
   * @returns Configuration string, or default 'simple'.
   */
  getConfig(lang: string): string {
    return this.config.get(lang) || 'tokenize=unicode61';
  }

  // ── FTS Dictionary API ─────────────────────────────────────────

  /**
   * Apply Porter stemming to a single token.
   * E.g. "running" → "run", "jumps" → "jump".
   */
  stem(token: string): string {
    return porterStemmer.stem(token);
  }

  /**
   * Expand a term using the thesaurus.
   */
  expandSynonyms(term: string): string[] {
    return expandSynonyms(term);
  }

  /**
   * Remove accents from text.
   */
  unaccent(s: string): string {
    return unaccent(s);
  }

  /**
   * Process query text: apply unaccent → stem each non-operator term.
   */
  private processQueryText(text: string): string {
    // First remove accents
    let processed = unaccent(text);

    // Then stem each word (skip operators)
    processed = processed
      .split(/\s+/)
      .map(word => {
        const upper = word.toUpperCase();
        if (['AND', 'OR', 'NOT'].includes(upper)) return word;
        return porterStemmer.stem(word);
      })
      .join(' ');

    return processed;
  }

  // ── Private helpers ───────────────────────────────────────────

  /**
   * Advanced tokenizer: split text into normalized tokens with stemming,
   * unaccent, and synonym integration.
   *
   * Handles basic stop word removal for English.
   */
  private tokenize(text: string, _config: string): string[] {
    const stopWords = new Set([
      'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
      'for', 'of', 'by', 'with', 'from', 'is', 'it', 'as', 'be', 'are',
      'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
      'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
      'can', 'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'that',
      'this', 'these', 'those', 'which', 'who', 'whom', 'what', 'when',
      'where', 'why', 'how',
    ]);

    // Step 1: Unaccent — remove combining diacritical marks
    const unaccented = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

    // Step 2: Lowercase and split
    let tokens = unaccented
      .toLowerCase()
      .replace(/[^\w\s'-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !stopWords.has(t));

    // Step 3: Apply Porter stemmer to each token
    // ("running" → "run", "jumps" → "jump", "easily" → "easili")
    tokens = tokens.map(t => porterStemmer.stem(t));

    return [...new Set(tokens)];
  }

  /**
   * Find matching closing parenthesis.
   */
  private findMatchingParen(str: string, start: number): number {
    let depth = 1;
    for (let i = start + 1; i < str.length; i++) {
      if (str[i] === '(') depth++;
      else if (str[i] === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /**
   * Extract comma-separated arguments from a function call.
   * Handles nested parens and quoted strings.
   */
  private extractFunctionArgs(funcCall: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let current = '';
    let inQuote: string | null = null;

    // Skip the function name up to the first '('.
    const parenIdx = funcCall.indexOf('(');
    if (parenIdx === -1) return [];

    for (let i = parenIdx + 1; i < funcCall.length; i++) {
      const ch = funcCall[i];
      if (ch === ')' && depth === 0 && !inQuote) break;

      if (inQuote) {
        current += ch;
        if (ch === inQuote) inQuote = null;
        continue;
      }

      if (ch === "'" || ch === '"') {
        inQuote = ch;
        current += ch;
        continue;
      }

      if (ch === '(') {
        depth++;
        current += ch;
      } else if (ch === ')') {
        depth--;
        current += ch;
      } else if (ch === ',' && depth === 0) {
        args.push(current.trim().replace(/^['"]|['"]$/g, ''));
        current = '';
      } else {
        current += ch;
      }
    }

    const trimmed = current.trim().replace(/^['"]|['"]$/g, '');
    if (trimmed.length > 0) args.push(trimmed);

    return args;
  }

  /**
   * Escape special characters in a tsvector token.
   */
  private escapeTsVector(token: string): string {
    return token.replace(/'/g, "''");
  }
}
