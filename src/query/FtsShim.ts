/**
 * FtsShim — PostgreSQL ts_rank / ts_query → SQLite FTS5 ranking shim.
 *
 * Bridges PostgreSQL full-text search ranking constructs to SQLite FTS5's
 * built-in bm25() function. Provides targeted SQL rewriting and a ranking
 * helper that produces correct FTS5 MATCH queries with bm25 ordering.
 *
 * ## Extended Features (FTS-GAP)
 *
 * - FTS Dictionary System (stemming, synonyms, unaccent)
 * - TextSearchConfig with per-token-type dictionary chain
 * - Debug functions: ts_debug, ts_headline, ts_stat, ts_lexize
 * - Ranking customization: ts_rank weights → bm25 per-column params
 * - Operator coverage: @@@, ts_rewrite, similarity, show_trgm
 *
 * @module query/FtsShim
 */

import natural from 'natural';

// ── Regex patterns ───────────────────────────────────────────────

/**
 * Matches `plainto_tsquery(...)` calls with their arguments.
 */
const PLAINTO_TSQUERY_RE = /\bplainto_tsquery\s*\(([^)]*)\)/gi;

/**
 * Matches `to_tsquery(...)` calls.
 */
const TO_TSQUERY_RE = /\bto_tsquery\s*\(([^)]*)\)/gi;

/**
 * Matches `phraseto_tsquery(...)` calls.
 */
const PHRASETO_TSQUERY_RE = /\bphraseto_tsquery\s*\(([^)]*)\)/gi;

/**
 * Matches `websearch_to_tsquery(...)` calls.
 */
const WEBSRCH_TO_TSQUERY_RE = /\bwebsearch_to_tsquery\s*\(([^)]*)\)/gi;

/**
 * Matches `to_tsvector(...)` calls — can have 1 or 2 args (config, col).
 */
const TO_TSVECTOR_RE = /\bto_tsvector\s*\([^)]*\)/gi;

/**
 * Matches `ts_rank(...)` and `ts_rank_cd(...)` calls.
 */
const TS_RANK_RE = /\bts_rank(?:_cd)?\s*\([^)]*\)/gi;

/**
 * Matches the `@@` operator with the FULL function call (including closing paren):
 *   column_ref @@ funcname(args)
 * Captures: [fullMatch, col, funcName, argsStr]
 */
const TS_MATCH_OP_FULL_RE = /([`"'\w.]+)\s*@@\s*(to_tsquery|plainto_tsquery|phraseto_tsquery|websearch_to_tsquery)\s*\(([^)]*)\)/gi;

/**
 * Matches the `@@@` operator (PG synonym operator) → regex or FTS5 prefix.
 *   column_ref @@@ to_tsquery(...)
 */
const TS_MATCH_OP_TRIPLE_RE = /([`"'\w.]+)\s*@@@\s*(to_tsquery|plainto_tsquery|phraseto_tsquery|websearch_to_tsquery)\s*\(([^)]*)\)/gi;

/**
 * Matches `ts_rewrite(query, rules)` calls.
 */
const TS_REWRITE_RE = /\bts_rewrite\s*\([^)]*\)/gi;

/**
 * Matches `ts_debug(config, document)` calls.
 */
const TS_DEBUG_RE = /\bts_debug\s*\([^)]*\)/gi;

/**
 * Matches `ts_headline(config, document, query)` calls.
 */
const TS_HEADLINE_RE = /\bts_headline\s*\([^)]*\)/gi;

/**
 * Matches `ts_stat(sqlquery)` calls.
 */
const TS_STAT_RE = /\bts_stat\s*\([^)]*\)/gi;

/**
 * Matches `ts_lexize(dictName, token)` calls.
 */
const TS_LEXIZE_RE = /\bts_lexize\s*\([^)]*\)/gi;

/**
 * Matches `similarity(a, b)` calls.
 */
const SIMILARITY_RE = /\bsimilarity\s*\([^)]*\)/gi;

/**
 * Matches `show_trgm(s)` calls.
 */
const SHOW_TRGM_RE = /\bshow_trgm\s*\([^)]*\)/gi;

/**
 * Regex to detect any PG FTS function in SQL.
 */
const PG_FTS_RE = /\b(to_tsvector|to_tsquery|plainto_tsquery|phraseto_tsquery|websearch_to_tsquery|ts_rank|ts_rank_cd|ts_debug|ts_headline|ts_stat|ts_lexize|ts_rewrite|similarity|show_trgm)\s*\(/g;

/**
 * Reset a global regex to its initial state (lastIndex = 0).
 */
function resetRe(re: RegExp): void {
  re.lastIndex = 0;
}

// ── Porter stemmer ──────────────────────────────────────────────

const porterStemmer = natural.PorterStemmer;

// ── Dice coefficient for similarity() ───────────────────────────

const { DiceCoefficient } = natural;

// ── Default stop words ───────────────────────────────────────────

const DEFAULT_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
  'for', 'of', 'by', 'with', 'from', 'is', 'it', 'as', 'be', 'are',
  'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
  'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
  'can', 'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'that',
  'this', 'these', 'those', 'which', 'who', 'whom', 'what', 'when',
  'where', 'why', 'how',
]);

// ── Token types ─────────────────────────────────────────────────

export type TokenType =
  | 'word'
  | 'numword'
  | 'email'
  | 'url'
  | 'host'
  | 'sfloat'
  | 'int'
  | 'hword';

// ── TextSearchConfig ────────────────────────────────────────────

/**
 * TextSearchConfig — per-query text search configuration.
 *
 * Mirrors PostgreSQL's `ALTER TEXT SEARCH CONFIGURATION` concept,
 * allowing per-token-type dictionary chains to be specified.
 *
 * Serializes to/from JSON for persistence.
 */
export class TextSearchConfig {
  /** Configuration name (e.g. 'english', 'simple'). */
  name: string;

  /** Parser type: unicode61 (default) or trigram. */
  parser: 'unicode61' | 'trigram';

  /** Per-token-type dictionary chain mappings. */
  mappings: Map<TokenType, string[]>;

  constructor(name: string = 'simple', parser: 'unicode61' | 'trigram' = 'unicode61') {
    this.name = name;
    this.parser = parser;
    this.mappings = new Map<TokenType, string[]>();

    // Default mappings mirroring PG's default configuration
    this.mappings.set('word', ['porter', 'simple']);
    this.mappings.set('numword', ['simple']);
    this.mappings.set('email', ['simple']);
    this.mappings.set('url', ['simple']);
    this.mappings.set('host', ['simple']);
    this.mappings.set('sfloat', ['simple']);
    this.mappings.set('int', ['simple']);
    this.mappings.set('hword', ['porter', 'simple']);
  }

  /**
   * Alter the dictionary chain for a specific token type.
   *
   * @param tokenType - The token type to modify.
   * @param dictionaries - Ordered list of dictionary names.
   */
  alterMapping(tokenType: string, dictionaries: string[]): void {
    this.mappings.set(tokenType as TokenType, dictionaries);
  }

  /**
   * Serialize this configuration to a JSON-compatible object.
   */
  toJSON(): Record<string, unknown> {
    const mappingsObj: Record<string, string[]> = {};
    for (const [key, value] of this.mappings.entries()) {
      mappingsObj[key] = value;
    }
    return {
      name: this.name,
      parser: this.parser,
      mappings: mappingsObj,
    };
  }

  /**
   * Deserialize from a JSON-compatible object.
   *
   * @param json - JSON object produced by toJSON().
   * @returns A new TextSearchConfig instance.
   */
  static fromJSON(json: Record<string, unknown>): TextSearchConfig {
    const config = new TextSearchConfig(
      (json.name as string) ?? 'simple',
      (json.parser as 'unicode61' | 'trigram') ?? 'unicode61',
    );
    const mappings = json.mappings as Record<string, string[]> | undefined;
    if (mappings) {
      for (const [key, dicts] of Object.entries(mappings)) {
        config.mappings.set(key as TokenType, dicts);
      }
    }
    return config;
  }
}

// ── Thesaurus / synonym support ─────────────────────────────────

/**
 * Loaded thesaurus data: maps a term to its synonyms.
 * Loaded from fts_thesaurus.json at data/fts_thesaurus.json.
 */
let _thesaurus: Record<string, string[]> | null = null;

/**
 * Load the thesaurus from disk (lazy, cached).
 */
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
  // Direct key match
  if (thesaurus[lowerTerm]) {
    return [term, ...thesaurus[lowerTerm]];
  }
  // Check if any thesaurus key's synonym list contains this term
  for (const [key, synonyms] of Object.entries(thesaurus)) {
    if (synonyms.some(s => s.toLowerCase() === lowerTerm)) {
      return [term, key, ...synonyms.filter(s => s.toLowerCase() !== lowerTerm)];
    }
  }
  return [term];
}

// ── Unaccent (accent removal) ───────────────────────────────────

/**
 * Remove accents/diacritics from a string using Unicode normalization.
 *
 * @param s - Input string potentially containing accented characters.
 * @returns String with accents removed (NFKD decomposed, then combining marks stripped).
 */
export function unaccent(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

// ── FtsShim ──────────────────────────────────────────────────────

export class FtsShim {
  private stopWords: Set<string>;
  private activeConfig: TextSearchConfig;

  constructor(stopWords?: Set<string>, config?: TextSearchConfig) {
    this.stopWords = stopWords ?? DEFAULT_STOP_WORDS;
    this.activeConfig = config ?? new TextSearchConfig();
  }

  // ── Configuration API ──────────────────────────────────────────

  /**
   * Get the active TextSearchConfig.
   */
  getConfig(): TextSearchConfig {
    return this.activeConfig;
  }

  /**
   * Set the active TextSearchConfig.
   */
  setConfig(config: TextSearchConfig): void {
    this.activeConfig = config;
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Rewrite PostgreSQL ts_query constructs in SQL to FTS5 equivalents.
   *
   * Handles:
   *   - `to_tsvector(config, col)` → removed (FTS5 tokenizes at index time)
   *   - `to_tsvector(col)` → removed
   *   - `to_tsquery('hello & world')` → `hello AND world`
   *   - `plainto_tsquery('hello world')` → `hello AND world`
   *   - `phraseto_tsquery('hello world')` → `"hello world"` (quoted phrase)
   *   - `websearch_to_tsquery('hello -world')` → `hello NOT world`
   *   - `col @@ to_tsquery(...)` → `col MATCH '...'`
   *   - `col @@@ to_tsquery(...)` → `col MATCH '...'` (synonym-expanded)
   *   - `ts_debug(...)` → JSON mock
   *   - `ts_headline(...)` → highlighted snippet
   *   - `ts_stat(...)` → subquery wrapper
   *   - `ts_lexize(...)` → stemmed form
   *   - `ts_rewrite(...)` → synonym-expanded query
   *   - `similarity(a, b)` → Dice coefficient
   *   - `show_trgm(s)` → trigram tokenization
   *
   * @param sql - SQL query containing PostgreSQL FTS constructs.
   * @returns Rewritten SQL with FTS5-compatible syntax.
   */
  rewriteTsQuery(sql: string): string {
    resetRe(PG_FTS_RE);
    if (!this.containsPgFts(sql)) return sql;

    let result = sql;

    // Step 0: Rewrite `@@@` operators (synonym-aware) BEFORE double-@
    resetRe(TS_MATCH_OP_TRIPLE_RE);
    result = result.replace(TS_MATCH_OP_TRIPLE_RE, (_fullMatch, col, funcName, argsStr) => {
      const queryText = argsStr.replace(/^['"]|['"]$/g, '');

      let fts5Query: string;
      switch (funcName.toLowerCase()) {
        case 'to_tsquery':
          fts5Query = this.convertTsquery(queryText);
          break;
        case 'plainto_tsquery':
          fts5Query = this.convertPlaintoTsquery(queryText);
          break;
        case 'phraseto_tsquery':
          fts5Query = this.convertPhrasetoTsquery(queryText);
          break;
        case 'websearch_to_tsquery':
          fts5Query = this.convertWebsearchTsquery(queryText);
          break;
        default:
          fts5Query = queryText;
      }

      // Expand each term with synonyms
      const expandedTerms = fts5Query.split(/\s+(?:AND|OR)\s+/).flatMap(term => {
        const stripped = term.replace(/^"|"$/g, '').replace(/\*/g, '').toLowerCase();
        const synonyms = expandSynonyms(stripped);
        // Build OR chain: original AND synonym1 AND synonym2 ...
        // For FTS5 this becomes: (original OR synonym1 OR synonym2)
        if (synonyms.length <= 1) return [term];
        return [`(${synonyms.map(s => s.replace(/[^a-z0-9]/gi, '')).join(' OR ')})`];
      });

      fts5Query = expandedTerms.join(' AND ');

      return `${col} MATCH '${fts5Query.replace(/'/g, "''")}'`;
    });

    // Step 1: Rewrite `@@` operators using the full-match regex
    resetRe(TS_MATCH_OP_FULL_RE);
    result = result.replace(TS_MATCH_OP_FULL_RE, (_fullMatch, col, funcName, argsStr) => {
      const queryText = argsStr.replace(/^['"]|['"]$/g, '');

      // Use the active config's dictionary chain to process query text
      const dictionaryChain = this.activeConfig.mappings.get('word') ?? ['simple'];

      let fts5Query: string;
      switch (funcName.toLowerCase()) {
        case 'to_tsquery':
          fts5Query = this.convertTsquery(queryText);
          break;
        case 'plainto_tsquery':
          fts5Query = this.convertPlaintoTsquery(queryText);
          break;
        case 'phraseto_tsquery':
          fts5Query = this.convertPhrasetoTsquery(queryText);
          break;
        case 'websearch_to_tsquery':
          fts5Query = this.convertWebsearchTsquery(queryText);
          break;
        default:
          fts5Query = queryText;
      }

      // Apply dictionary chain: for each dictionary, process query text
      // 'porter' → apply stemming, 'simple' → lowercase/no-op, 'unaccent' → accent removal
      if (dictionaryChain.includes('porter')) {
        fts5Query = fts5Query
          .split(/\s+/)
          .map(term => {
            // Don't stem operators or quoted phrases or prefixed terms
            const upperTerm = term.toUpperCase();
            if (['AND', 'OR', 'NOT'].includes(upperTerm)) return term;
            if (term.startsWith('"') && term.endsWith('"')) return term;
            if (term.endsWith('*')) return porterStemmer.stem(term.slice(0, -1)) + '*';
            return porterStemmer.stem(term);
          })
          .join(' ');
      }
      if (dictionaryChain.includes('unaccent')) {
        fts5Query = unaccent(fts5Query);
      }

      return `${col} MATCH '${fts5Query.replace(/'/g, "''")}'`;
    });

    // Step 2: Rewrite independent to_tsvector(...) → empty string
    resetRe(TO_TSVECTOR_RE);
    result = result.replace(TO_TSVECTOR_RE, '');

    // Step 3: Rewrite independent `to_tsquery('text')` → 'fts5_query'
    resetRe(TO_TSQUERY_RE);
    result = result.replace(TO_TSQUERY_RE, (_match, argsStr) => {
      if (this.isAfterMatch(result, _match)) return _match;
      const args = argsStr.split(',').map((a: string) => a.trim().replace(/^['"]|['"]$/g, ''));
      const queryText = args[args.length - 1];
      const fts5Query = this.applyDictionaryToQuery(this.convertTsquery(queryText));
      return `'${fts5Query.replace(/'/g, "''")}'`;
    });

    // Step 4: Rewrite independent `plainto_tsquery('text')`
    resetRe(PLAINTO_TSQUERY_RE);
    result = result.replace(PLAINTO_TSQUERY_RE, (_match, argsStr) => {
      if (this.isAfterMatch(result, _match)) return _match;
      const args = argsStr.split(',').map((a: string) => a.trim().replace(/^['"]|['"]$/g, ''));
      const queryText = args[args.length - 1];
      const fts5Query = this.applyDictionaryToQuery(this.convertPlaintoTsquery(queryText));
      return `'${fts5Query.replace(/'/g, "''")}'`;
    });

    // Step 5: Rewrite independent `phraseto_tsquery('text')`
    resetRe(PHRASETO_TSQUERY_RE);
    result = result.replace(PHRASETO_TSQUERY_RE, (_match, argsStr) => {
      if (this.isAfterMatch(result, _match)) return _match;
      const text = argsStr.trim().replace(/^['"]|['"]$/g, '');
      const fts5Query = this.applyDictionaryToQuery(this.convertPhrasetoTsquery(text));
      return `'${fts5Query.replace(/'/g, "''")}'`;
    });

    // Step 6: Rewrite independent `websearch_to_tsquery('text')`
    resetRe(WEBSRCH_TO_TSQUERY_RE);
    result = result.replace(WEBSRCH_TO_TSQUERY_RE, (_match, argsStr) => {
      if (this.isAfterMatch(result, _match)) return _match;
      const text = argsStr.trim().replace(/^['"]|['"]$/g, '');
      const fts5Query = this.applyDictionaryToQuery(this.convertWebsearchTsquery(text));
      return `'${fts5Query.replace(/'/g, "''")}'`;
    });

    // Step 7: Rewrite ts_rewrite → synonym-expanded query
    // PG: ts_rewrite(query, rules) where rules is a table of (original, replacement)
    // We consult the thesaurus for each term.
    resetRe(TS_REWRITE_RE);
    result = result.replace(TS_REWRITE_RE, (_match) => {
      const args = this.extractArgs(_match);
      const queryArg = args[0] ?? '';
      const queryStr = queryArg.replace(/^['"]|['"]$/g, '');

      // Expand each term in the query
      const expanded = queryStr
        .split(/\s+/)
        .map(term => {
          const cleanTerm = term.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          if (!cleanTerm) return term;
          const synonyms = expandSynonyms(cleanTerm);
          if (synonyms.length <= 1) return term;
          return `(${synonyms.join(' OR ')})`;
        })
        .join(' ');

      return `'${expanded.replace(/'/g, "''")}'`;
    });

    // Step 8: Rewrite ts_debug(config, document) → JSON array mock
    resetRe(TS_DEBUG_RE);
    result = result.replace(TS_DEBUG_RE, (_match) => {
      const args = this.extractArgs(_match);
      const doc = args[args.length - 1] ?? '';
      const docStr = doc.replace(/^['"]|['"]$/g, '');
      return this.mockTsDebug(docStr);
    });

    // Step 9: Rewrite ts_headline(config, document, query) → highlighted snippet
    resetRe(TS_HEADLINE_RE);
    result = result.replace(TS_HEADLINE_RE, (_match) => {
      const args = this.extractArgs(_match);
      // ts_headline(config, document, query [, options])
      const doc = args.length >= 2 ? args[args.length >= 3 ? 1 : 0] : '';
      const query = args.length >= 3 ? args[args.length >= 3 ? 2 : 1] : '';
      const docStr = doc.replace(/^['"]|['"]$/g, '');
      const queryStr = query.replace(/^['"]|['"]$/g, '');

      // Parse options from last argument if it's a string (compat)
      let options: TsHeadlineOptions = {};
      if (args.length >= 4) {
        const optStr = args[3].replace(/^['"]|['"]$/g, '');
        options = parseHeadlineOptions(optStr);
      }
      // Also check for MaxWords=12 style in the query argument itself (PG format)
      if (queryStr.includes('=')) {
        options = { ...options, ...parseHeadlineOptions(queryStr) };
      }

      return `'${this.mockTsHeadline(docStr, queryStr, options).replace(/'/g, "''")}'`;
    });

    // Step 10: Rewrite ts_stat(sqlquery) → subquery wrapper
    resetRe(TS_STAT_RE);
    result = result.replace(TS_STAT_RE, (_match) => {
      return this.mockTsStat();
    });

    // Step 11: Rewrite ts_lexize(dictName, token) → stemmed form
    resetRe(TS_LEXIZE_RE);
    result = result.replace(TS_LEXIZE_RE, (_match) => {
      const args = this.extractArgs(_match);
      const dictName = (args[0] ?? '').replace(/^['"]|['"]$/g, '');
      const token = (args[1] ?? '').replace(/^['"]|['"]$/g, '');
      return this.mockTsLexize(dictName, token);
    });

    // Step 12: Rewrite similarity(a, b) → Dice coefficient
    resetRe(SIMILARITY_RE);
    result = result.replace(SIMILARITY_RE, (_match) => {
      const args = this.extractArgs(_match);
      const a = args[0] ?? '';
      const b = args[1] ?? '';
      return this.mockSimilarity(a, b);
    });

    // Step 13: Rewrite show_trgm(s) → trigram array
    resetRe(SHOW_TRGM_RE);
    result = result.replace(SHOW_TRGM_RE, (_match) => {
      const args = this.extractArgs(_match);
      const s = args[0] ?? '';
      return this.mockShowTrgm(s);
    });

    // Step 14: Clean up double spaces from removed expressions.
    result = result.replace(/\s{2,}/g, ' ').trim();

    return result;
  }

  /**
   * Apply the active config's dictionary chain to a query string.
   * Handles 'porter' (stemming), 'simple' (lowercase), and 'unaccent'.
   */
  private applyDictionaryToQuery(queryStr: string): string {
    const dictionaryChain = this.activeConfig.mappings.get('word') ?? ['simple'];

    let result = queryStr;

    if (dictionaryChain.includes('porter') || dictionaryChain.includes('english_stem')) {
      result = result
        .split(/\s+/)
        .map(term => {
          const upperTerm = term.toUpperCase();
          if (['AND', 'OR', 'NOT'].includes(upperTerm)) return term;
          if (term.startsWith('"') && term.endsWith('"')) return term;
          if (term.endsWith('*')) return porterStemmer.stem(term.slice(0, -1)) + '*';
          return porterStemmer.stem(term);
        })
        .join(' ');
    }

    if (dictionaryChain.includes('unaccent')) {
      result = unaccent(result);
    }

    return result;
  }

  /**
   * Rewrite `ts_rank(...)` or `ts_rank_cd(...)` calls to FTS5 `bm25(...)`.
   *
   * Supports PG ts_rank weights argument `{0.1, 0.2, 0.4, 1.0}` → maps to
   * FTS5 per-column bm25 k1 parameters.
   *
   * Supports normalization option 0 (none), 1 (divide by doc length).
   *
   * @param sql   - SQL query containing ts_rank or ts_rank_cd.
   * @param ftsTableName - Name of the FTS5 virtual table (used in bm25()).
   * @returns Rewritten SQL with bm25() calls.
   */
  rewriteTsRank(sql: string, ftsTableName: string = 'fts'): string {
    if (!sql.match(TS_RANK_RE)) return sql;

    const result = sql.replace(TS_RANK_RE, (_match) => {
      // Parse ts_rank arguments: ts_rank([weights,] vector, query [, normalization])
      // or ts_rank_cd([weights,] vector, query [, normalization])
      const args = this.extractArgs(_match);

      let weightsArg: string | null = null;
      let normalizationArg: number | null = null;

      // PG signature: ts_rank(vector, query) or ts_rank(weights, vector, query [, normalization])
      // or ts_rank_cd(weights, vector, query [, normalization])
      if (args.length >= 3) {
        // Check if first arg looks like a weight vector {0.1,0.2,0.4,1.0}
        const first = args[0].trim();
        if (first.startsWith('{') && first.endsWith('}')) {
          weightsArg = first;
          // normalization is the 4th arg if present
          if (args.length >= 4) {
            const normStr = args[3].trim();
            normalizationArg = parseInt(normStr, 10);
          }
        } else if (args.length >= 4) {
          // ts_rank(vector, query, normalization) — no weights
          const normStr = args[2].trim();
          normalizationArg = parseInt(normStr, 10);
        }
      } else if (args.length === 3) {
        // ts_rank(vector, query, normalization)
        const third = args[2].trim();
        if (third.startsWith('{')) {
          weightsArg = third;
        } else {
          normalizationArg = parseInt(third, 10);
        }
      }

      // Build bm25 arguments based on weights and normalization
      let bm25Args = '';
      if (weightsArg) {
        // PG format: {0.1, 0.2, 0.4, 1.0}
        // Extract numeric weights
        const weights = weightsArg
          .replace(/[{}]/g, '')
          .split(',')
          .map(w => parseFloat(w.trim()))
          .filter(w => !isNaN(w));

        // Map to FTS5 per-column bm25 tuning
        // FTS5 bm25(table, k1, b, col1_weight, col2_weight, ...)
        // We map first few weights as per-column parameters
        if (weights.length > 0) {
          bm25Args = weights.map(w => String(w)).join(', ');
        }
      }

      // Handle normalization
      let normExpr = '';
      if (normalizationArg != null) {
        if (normalizationArg === 0) {
          // No normalization — no change
          normExpr = '';
        } else if (normalizationArg === 1) {
          // Divide by doc length — use b parameter in bm25
          // b=1.0 means full length normalization
          normExpr = '1.0';
        } else {
          // Other normalization options → no-op (not supported)
          normExpr = '';
        }
      }

      // Build bm25 call: -bm25(table, ...) negated so higher = better (like PG)
      const bm25Params = bm25Args || normExpr
        ? `, ${[bm25Args, normExpr].filter(Boolean).join(', ')}`
        : '';

      return `-bm25(${ftsTableName}${bm25Params})`;
    });

    return result;
  }

  /**
   * Generate a complete FTS5 ranking query with bm25 ordering.
   *
   * Produces a SQL string that:
   *   1. MATCHes the query against an FTS5 table
   *   2. Computes a bm25 rank score
   *   3. Orders by rank (best match first)
   *
   * @param ftsTable - Name of the FTS5 virtual table.
   * @param query    - Search query text (plain text, will be AND-joined).
   * @param rankFn   - Optional custom ranking expression (default: bm25).
   * @param options  - Optional: { columns, limit, orderBy }
   * @returns SQL query string ready to execute against the FTS5 table.
   */
  scoreFts5(
    ftsTable: string,
    query: string,
    rankFn?: string,
    options?: {
      /** Columns to SELECT (default: '*') */
      columns?: string;
      /** Maximum results (default: no limit) */
      limit?: number;
      /** ORDER BY direction (default: 'ASC') */
      orderBy?: 'ASC' | 'DESC';
    },
  ): string {
    const fts5Query = this.convertPlaintoTsquery(query);
    if (!fts5Query) {
      // Empty query — no results
      return '';
    }

    const rankExpression = rankFn ?? `bm25(${ftsTable})`;
    const selectCols = options?.columns ?? '*';
    const orderDir = options?.orderBy ?? 'ASC';

    let sql =
      `SELECT ${selectCols}, ${rankExpression} AS rank ` +
      `FROM ${ftsTable} WHERE ${ftsTable} MATCH '${fts5Query.replace(/'/g, "''")}' ` +
      `ORDER BY rank ${orderDir}`;

    if (options?.limit != null && options.limit > 0) {
      sql += ` LIMIT ${options.limit}`;
    }

    return sql;
  }

  /**
   * Compute a coverage-based rank score (like ts_rank_cd simplified).
   *
   * Unlike bm25 which uses TF-IDF, coverage rank measures what fraction
   * of query terms appear in the document.
   *
   * @param vectorTokens - Token set from a tsvector or document.
   * @param queryTerms   - Query terms.
   * @returns A coverage score between 0 and 1 (higher = better).
   */
  coverageRank(vectorTokens: Set<string>, queryTerms: string[]): number {
    if (queryTerms.length === 0) return 0;

    const matches = queryTerms.filter((t) => vectorTokens.has(t.toLowerCase())).length;
    return matches / queryTerms.length;
  }

  /**
   * Check if a SQL string contains PostgreSQL FTS constructs.
   */
  containsPgFts(sql: string): boolean {
    resetRe(PG_FTS_RE);
    return PG_FTS_RE.test(sql);
  }

  // ── FTS Debug Functions ────────────────────────────────────────

  /**
   * Mock implementation of ts_debug(config, document).
   *
   * Returns a JSON array of { token, type, dictionary, output } for each
   * token in the document, simulating PostgreSQL's ts_debug output.
   *
   * @param config - Text search config name.
   * @param document - Document text to debug.
   * @returns JSON string of token analysis array.
   */
  tsDebug(config: string, document: string): string {
    return this.mockTsDebug(document);
  }

  /**
   * Mock implementation of ts_headline(config, document, query).
   *
   * Extracts snippets with matching terms highlighted with `<b>` tags.
   * Supports MaxWords, MinWords, StartSel('<b>'), EndSel('</b>') options.
   *
   * @param config - Text search config name.
   * @param document - Document text.
   * @param query - Search query.
   * @param options - Headline formatting options.
   * @returns Highlighted snippet string.
   */
  tsHeadline(
    config: string,
    document: string,
    query: string,
    options?: TsHeadlineOptions,
  ): string {
    return this.mockTsHeadline(document, query, options ?? {});
  }

  /**
   * Mock implementation of ts_stat(sqlquery).
   *
   * Returns a JSON string representing lexeme frequency statistics.
   * In practice returns empty stats since we don't have full document corpus data.
   *
   * @param sqlQuery - SQL query to analyze.
   * @returns JSON string of lexeme frequency stats.
   */
  tsStat(sqlQuery: string): string {
    return this.mockTsStat();
  }

  /**
   * Mock implementation of ts_lexize(dictName, token).
   *
   * Tests a dictionary lookup and returns the stemmed/processed form.
   *
   * @param dictName - Dictionary name (e.g. 'porter', 'simple', 'unaccent').
   * @param token - Token to lexize.
   * @returns JSON string of lexeme(s) or empty array.
   */
  tsLexize(dictName: string, token: string): string {
    return this.mockTsLexize(dictName, token);
  }

  // ── Novelty Operators ──────────────────────────────────────────

  /**
   * Expand a query using the thesaurus (used by ts_rewrite).
   *
   * @param query - Original query string.
   * @returns Expanded query string with OR-chained synonyms.
   */
  tsRewrite(query: string): string {
    const terms = query.split(/\s+/);
    const expanded = terms.map(term => {
      const cleanTerm = term.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      if (!cleanTerm) return term;
      const synonyms = expandSynonyms(cleanTerm);
      if (synonyms.length <= 1) return term;
      return `(${synonyms.join(' OR ')})`;
    });
    return expanded.join(' ');
  }

  /**
   * Compute Dice coefficient similarity between two strings.
   *
   * Uses natural's DiceCoefficient implementation.
   *
   * @param a - First string.
   * @param b - Second string.
   * @returns Dice coefficient (0.0 to 1.0).
   */
  similarity(a: string, b: string): number {
    const cleanA = a.replace(/^['"]|['"]$/g, '').toLowerCase();
    const cleanB = b.replace(/^['"]|['"]$/g, '').toLowerCase();
    // DiceCoefficient takes arguments in order (s1, s2) → matches first and second
    return DiceCoefficient(cleanA, cleanB);
  }

  /**
   * Tokenize a string into trigrams (like PG's show_trgm).
   *
   * @param s - Input string.
   * @returns JSON array of trigrams.
   */
  showTrgm(s: string): string {
    const clean = s.replace(/^['"]|['"]$/g, '').toLowerCase();
    const trigrams: string[] = [];
    // Pad with spaces on both sides
    const padded = `  ${clean} `;
    for (let i = 0; i < padded.length - 2; i++) {
      trigrams.push(padded.substring(i, i + 3));
    }
    // Remove duplicates
    const unique = [...new Set(trigrams)];
    return `'${JSON.stringify(unique)}'`;
  }

  // ── Query conversion helpers ───────────────────────────────────

  /**
   * Convert a tsquery string to FTS5 format.
   *
   * PostgreSQL tsquery operators:
   *   &  → AND
   *   |  → OR
   *   !  → NOT
   *   <N> → phrase (space in FTS5)
   *   :* → prefix (trailing *)
   */
  convertTsquery(query: string): string {
    let q = query.trim();
    if ((q.startsWith("'") && q.endsWith("'")) || (q.startsWith('"') && q.endsWith('"'))) {
      q = q.slice(1, -1);
    }

    if (q.length === 0) return '';

    let result = q
      // Phrase operator: <-> (adjacent) or <N> (distance N) → space
      .replace(/<[-\d]*>/g, ' ')
      .replace(/!/g, 'NOT ')
      .replace(/&/g, 'AND')
      .replace(/\|/g, 'OR')
      .replace(/:(\*)?/g, '*')
      .replace(/\s+/g, ' ')
      .trim();

    return result;
  }

  /**
   * Convert plainto_tsquery text to FTS5 AND-joined query.
   *
   * Also filters stop words and applies stemming from Porter stemmer
   * integrated via the dictionary system.
   */
  convertPlaintoTsquery(text: string): string {
    let t = text.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      t = t.slice(1, -1);
    }

    const tokens = this.tokenize(t);
    const filtered = tokens.filter((tok) => !this.stopWords.has(tok));

    if (filtered.length === 0) return '';

    return filtered.join(' AND ');
  }

  /**
   * Convert phraseto_tsquery text to FTS5 quoted phrase.
   */
  convertPhrasetoTsquery(text: string): string {
    let t = text.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      t = t.slice(1, -1);
    }

    const tokens = this.tokenize(t).filter((tok) => !this.stopWords.has(tok));
    if (tokens.length === 0) return '';

    return tokens.length === 1 ? tokens[0] : `"${tokens.join(' ')}"`;
  }

  /**
   * Convert websearch_to_tsquery text to FTS5 syntax.
   */
  convertWebsearchTsquery(text: string): string {
    let t = text.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      t = t.slice(1, -1);
    }

    return t
      .replace(/"([^"]+)"/g, (_, phrase) => `"${phrase}"`)
      .replace(/-(\w+)/g, 'NOT $1')
      .trim();
  }

  // ── Private helpers ────────────────────────────────────────────

  /**
   * Tokenizer with Porter stemming and unaccent integration.
   *
   * - Applies Porter stemmer to each token (e.g. "running" → "run")
   * - Applies unaccent (accent removal) via NFKD normalization
   * - Lowercases and splits on non-word characters
   */
  private tokenize(text: string): string[] {
    // Step 1: Unaccent — remove combining diacritical marks
    const unaccented = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

    // Step 2: Lowercase and split
    let result = unaccented
      .toLowerCase()
      .replace(/[^\w\s'-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0);

    // Step 3: Apply Porter stemmer to each token
    // (e.g. "running" → "run", "jumps" → "jump", "easily" → "easili")
    result = result.map(t => porterStemmer.stem(t));

    return result;
  }

  /**
   * Check whether a matched function call appears after a `@@` operator.
   */
  private isAfterMatch(sql: string, match: string): boolean {
    const idx = sql.indexOf(match);
    if (idx < 2) return false;
    const before = sql.substring(Math.max(0, idx - 8), idx).trimEnd();
    return before.endsWith('@@');
  }

  /**
   * Find the matching closing parenthesis starting from `openIdx`.
   */
  private findClosingParen(str: string, openIdx: number): number {
    let depth = 1;
    for (let i = openIdx + 1; i < str.length; i++) {
      if (str[i] === '(') depth++;
      else if (str[i] === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /**
   * Extract comma-separated arguments from a function call string.
   * Handles nested parens.
   */
  private extractArgs(funcCall: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let current = '';
    let inQuote: string | null = null;

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

  // ── Mock implementations ───────────────────────────────────────

  /**
   * Mock ts_debug: tokenize document and return analysis.
   */
  private mockTsDebug(document: string): string {
    const tokens = document
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 0);

    const dictChain = this.activeConfig.mappings.get('word') ?? ['simple'];

    const debugEntries = tokens.map(token => {
      // Simulate dictionary processing
      let output = token;
      if (dictChain.includes('porter') || dictChain.includes('english_stem')) {
        output = porterStemmer.stem(token);
      }

      return {
        token: token,
        type: 'word',
        dictionary: dictChain.join(', '),
        output: output,
      };
    });

    return `'${JSON.stringify(debugEntries).replace(/'/g, "''")}'`;
  }

  /**
   * Mock ts_headline: extract snippet with highlighted matches.
   */
  private mockTsHeadline(
    document: string,
    query: string,
    options: TsHeadlineOptions,
  ): string {
    const maxWords = options.MaxWords ?? 35;
    const minWords = options.MinWords ?? 15;
    const startSel = options.StartSel ?? '<b>';
    const endSel = options.EndSel ?? '</b>';

    // Extract query terms
    const queryTerms = query
      .toLowerCase()
      .replace(/\b(AND|OR|NOT)\b/gi, '')
      .split(/\s+/)
      .map(t => t.replace(/[^a-z0-9]/gi, ''))
      .filter(Boolean);

    if (queryTerms.length === 0 || document.length === 0) {
      return '';
    }

    const words = document.split(/\s+/);
    const lowerWords = words.map(w => w.toLowerCase().replace(/[^\w]/g, ''));

    // Find positions where query terms match
    const matchPositions: number[] = [];
    for (let i = 0; i < lowerWords.length; i++) {
      const stemmed = porterStemmer.stem(lowerWords[i]);
      for (const term of queryTerms) {
        const stemmedTerm = porterStemmer.stem(term);
        if (lowerWords[i] === term || stemmed === stemmedTerm) {
          matchPositions.push(i);
          break;
        }
      }
    }

    if (matchPositions.length === 0) {
      // No match found — return beginning of document
      return words.slice(0, maxWords).join(' ');
    }

    // Find best snippet window
    const center = matchPositions[Math.floor(matchPositions.length / 2)];
    const start = Math.max(0, center - Math.floor(minWords / 2));
    const end = Math.min(words.length, start + maxWords);

    // Build snippet with highlights
    const snippetWords: string[] = [];
    for (let i = start; i < end; i++) {
      const lower = words[i].toLowerCase().replace(/[^\w]/g, '');
      const stemmed = porterStemmer.stem(lower);
      const isMatch = queryTerms.some(term => {
        const stemmedTerm = porterStemmer.stem(term);
        return lower === term || stemmed === stemmedTerm;
      });

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

  /**
   * Mock ts_stat: return empty stats JSON.
   */
  private mockTsStat(): string {
    return "'[]'";
  }

  /**
   * Mock ts_lexize: apply the specified dictionary to a token.
   */
  private mockTsLexize(dictName: string, token: string): string {
    const cleanToken = token.replace(/^['"]|['"]$/g, '');

    let result = cleanToken.toLowerCase();

    switch (dictName.toLowerCase()) {
      case 'porter':
      case 'english_stem':
        result = porterStemmer.stem(result);
        break;
      case 'unaccent':
        result = unaccent(result);
        break;
      case 'simple':
        // simple dictionary: lowercase + no-op
        result = result.toLowerCase();
        break;
      default:
        // Unknown dictionary — try stemming as fallback
        result = porterStemmer.stem(result);
    }

    return result ? `'{"${result}"}'` : "'{}'";
  }

  /**
   * Mock similarity: compute Dice coefficient between two strings.
   */
  private mockSimilarity(a: string, b: string): string {
    const cleanA = a.replace(/^['"]|['"]$/g, '').toLowerCase();
    const cleanB = b.replace(/^['"]|['"]$/g, '').toLowerCase();
    const score = DiceCoefficient(cleanA, cleanB);
    return String(score);
  }

  /**
   * Mock show_trgm: tokenize into trigrams.
   */
  private mockShowTrgm(s: string): string {
    const clean = s.replace(/^['"]|['"]$/g, '').toLowerCase();
    const trigrams: string[] = [];
    const padded = `  ${clean} `;
    for (let i = 0; i < padded.length - 2; i++) {
      trigrams.push(padded.substring(i, i + 3));
    }
    const unique = [...new Set(trigrams)];
    return `'${JSON.stringify(unique)}'`;
  }

  /**
   * Alias for compatibility with existing tests that import expandSynonyms.
   */
  expandSynonyms(term: string): string[] {
    return expandSynonyms(term);
  }
}

// ── Headline options ────────────────────────────────────────────

export interface TsHeadlineOptions {
  MaxWords?: number;
  MinWords?: number;
  ShortWord?: number;
  HighlightAll?: boolean;
  MaxFragments?: number;
  StartSel?: string;
  EndSel?: string;
}

/**
 * Parse PG ts_headline options string like 'MaxWords=35,MinWords=15'.
 *
 * @param optStr - Options string in PG format.
 * @returns Parsed options object.
 */
function parseHeadlineOptions(optStr: string): TsHeadlineOptions {
  const opts: TsHeadlineOptions = {};
  const pairs = optStr.split(',');

  for (const pair of pairs) {
    const [key, value] = pair.split('=').map(s => s.trim());
    if (!key || value === undefined) continue;

    switch (key.toLowerCase()) {
      case 'maxwords':
        opts.MaxWords = parseInt(value, 10);
        break;
      case 'minwords':
        opts.MinWords = parseInt(value, 10);
        break;
      case 'shortword':
        opts.ShortWord = parseInt(value, 10);
        break;
      case 'highlightall':
        opts.HighlightAll = value.toLowerCase() === 'true';
        break;
      case 'maxfragments':
        opts.MaxFragments = parseInt(value, 10);
        break;
      case 'startsel':
        opts.StartSel = value;
        break;
      case 'endsel':
        opts.EndSel = value;
        break;
    }
  }

  return opts;
}
