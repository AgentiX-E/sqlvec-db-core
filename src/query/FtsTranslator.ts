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
import { skipSqlLiteral } from './SqlLiteralScanner';

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
      // Phrase operator <-> → space (FTS5 implicit phrase)
      .replace(/<->/g, ' ')
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
    // Extract tokens from the vector. A tsvector is `'token':1 'token':2 ...`,
    // so we capture the quoted token (non-greedy, stops at the `':` separator)
    // rather than splitting on it (splitting would discard every token).
    const vectorTokens = new Set<string>();
    const tokenRe = /'([^']+)':\d+/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(vector)) !== null) {
      vectorTokens.add(m[1]);
    }

    // Extract query terms, dropping both FTS5 boolean keywords and PG tsquery
    // operator symbols (`&`, `|`, `!`, `<->`) so only actual terms remain.
    const queryTerms = query
      .replace(/\b(AND|OR|NOT)\b/gi, ' ')
      .replace(/[&|!<>\-]/g, ' ')
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

    const out: string[] = [];
    let i = 0;
    const len = sql.length;
    let changed = false;

    while (i < len) {
      // Preserve literals/comments verbatim.
      const skipped = skipSqlLiteral(sql, i);
      if (skipped !== -1) {
        out.push(sql.slice(i, skipped));
        i = skipped;
        continue;
      }

      // `@@` match operator: `col @@ fts_func(...)`.
      if (sql[i] === '@' && sql[i + 1] === '@') {
        const left = this.findLeftOperand(sql, i);
        const after = this.skipWs(sql, i + 2);
        const f = this.readFtsFuncName(sql, after);
        if (left !== null && f !== null) {
          const open = this.skipWs(sql, after + f.length);
          if (sql[open] === '(') {
            const close = this.findMatchingParen(sql, open);
            if (close !== -1) {
              const args = this.extractFunctionArgs(sql.slice(after, close + 1));
              const queryText = args[args.length - 1] || '';
              const fts5Query = this.translateQuery(f, queryText);
              // The left operand was already emitted char-by-char; drop it
              // from the buffer before emitting `left MATCH '...'`.
              this.dropTrailingText(out, left);
              out.push(`${left} MATCH '${fts5Query.replace(/'/g, "''")}'`);
              changed = true;
              i = close + 1;
              continue;
            }
          }
        }
        // Not a recognized match — copy the `@` and continue.
        out.push('@');
        i++;
        continue;
      }

      // Standalone FTS function names.
      const nameLen = this.matchFtsFuncName(sql, i);
      if (nameLen > 0) {
        const open = this.skipWs(sql, i + nameLen);
        if (sql[open] === '(') {
          const close = this.findMatchingParen(sql, open);
          if (close !== -1) {
            const name = sql.slice(i, i + nameLen).toLowerCase();
            if (name === 'to_tsvector') {
              // `to_tsvector(...)` has no FTS5 equivalent at query time (FTS5
              // tokenizes at index time). When it is the left operand of `@@`,
              // the MATCH column is its column argument — emit that column so
              // the `@@` rewrite below produces `col MATCH '...'`. Otherwise
              // (standalone to_tsvector) replace it with NULL so the slot stays
              // valid — `SELECT NULL FROM t` instead of an illegal `SELECT FROM t`.
              const after = this.skipWs(sql, close + 1);
              if (sql[after] === '@' && sql[after + 1] === '@') {
                const args = this.extractFunctionArgs(sql.slice(i, close + 1));
                // to_tsvector(config, column) → column is the last argument.
                const col = args[args.length - 1] || '';
                out.push(col);
                changed = true;
                i = close + 1;
                continue;
              }
              out.push('NULL');
              changed = true;
              i = close + 1;
              continue;
            }
            if (name === 'ts_rank') {
              out.push('1.0');
              changed = true;
              i = close + 1;
              continue;
            }
            if (name === 'ts_headline') {
              out.push("''");
              changed = true;
              i = close + 1;
              continue;
            }
            // to_tsquery & friends used standalone (no @@): strip quotes/refs.
            const args = this.extractFunctionArgs(sql.slice(i, close + 1));
            const queryText = args[args.length - 1] || '';
            out.push(`'${this.translateQuery(name, queryText).replace(/'/g, "''")}'`);
            changed = true;
            i = close + 1;
            continue;
          }
        }
      }

      out.push(sql[i]);
      i++;
    }

    const rewritten = out.join('');
    if (changed && rewritten !== sql) {
      this.logger.debug(
        { original: sql.substring(0, 120), rewritten: rewritten.substring(0, 120) },
        'FTS rewrite applied',
      );
      return rewritten;
    }
    return sql;
  }

  /** Read a left operand immediately before the `@@` at `at`, or null. */
  private findLeftOperand(sql: string, at: number): string | null {
    // The left operand may be a `to_tsvector(config, col)` call (the canonical
    // PostgreSQL full-text idiom). Unwrap it to its column argument so the
    // `@@` rewrite produces `col MATCH '...'` instead of a dangling `)`.
    const tsVector = this.findLeftToTsvector(sql, at);
    if (tsVector !== null) return tsVector;

    let j = at - 1;
    while (j >= 0 && /\s/.test(sql[j])) j--;
    if (j < 0) return null;
    const start = j;
    while (j >= 0 && /[`"'\w.$]/.test(sql[j])) j--;
    const operand = sql.slice(j + 1, start + 1).trim();
    return operand.length > 0 ? operand : null;
  }

  /**
   * If the text immediately before `@@` at `at` is a `to_tsvector(...)` call,
   * return the column argument (the last argument). Otherwise return null.
   */
  private findLeftToTsvector(sql: string, at: number): string | null {
    // Skip whitespace between the `@@` and the preceding operand.
    let j = at - 1;
    while (j >= 0 && /\s/.test(sql[j])) j--;
    if (sql[j] !== ')') return null;

    // Walk back to the matching open paren of the call.
    const close = j;
    const open = this.findOpenParen(sql, close);
    if (open < 0) return null;

    // Confirm the call name is `to_tsvector`.
    const nameStart = this.findNameStart(sql, open);
    const name = sql.slice(nameStart, open).trim().toLowerCase();
    if (name !== 'to_tsvector') return null;

    const args = this.extractFunctionArgs(sql.slice(nameStart, close + 1));
    const col = args[args.length - 1] || '';
    return col.length > 0 ? col : null;
  }

  /** Find the position of the `(` matching a `)` at `close`, or -1. */
  private findOpenParen(sql: string, close: number): number {
    let depth = 0;
    for (let i = close; i >= 0; i--) {
      if (sql[i] === ')') depth++;
      else if (sql[i] === '(') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** Find the start of an identifier immediately before `open`, or 0. */
  private findNameStart(sql: string, open: number): number {
    let j = open - 1;
    while (j >= 0 && /\s/.test(sql[j])) j--;
    const end = j;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(sql[j])) j--;
    return j + 1;
  }

  private skipWs(sql: string, i: number): number {
    while (i < sql.length && /\s/.test(sql[i])) i++;
    return i;
  }

  /** Read an FTS function name at `i`, returning its length or 0. */
  private matchFtsFuncName(sql: string, i: number): number {
    const names = [
      'to_tsvector', 'to_tsquery', 'plainto_tsquery', 'ts_rank',
      'ts_headline', 'phraseto_tsquery', 'websearch_to_tsquery',
    ];
    for (const n of names) {
      if (
        sql.startsWith(n, i) &&
        (i === 0 || !this.isIdentChar(sql[i - 1])) &&
        !this.isIdentChar(sql[i + n.length])
      ) {
        return n.length;
      }
    }
    return 0;
  }

  private readFtsFuncName(sql: string, i: number): string | null {
    const names = [
      'to_tsquery', 'plainto_tsquery', 'phraseto_tsquery', 'websearch_to_tsquery',
    ];
    for (const n of names) {
      if (
        sql.startsWith(n, i) &&
        !this.isIdentChar(sql[i + n.length])
      ) {
        return n;
      }
    }
    return null;
  }

  private translateQuery(funcName: string, queryText: string): string {
    const processed = this.processQueryText(queryText);
    switch (funcName.toLowerCase()) {
      case 'to_tsquery': return this.tsquery(processed);
      case 'plainto_tsquery': return this.plaintoTsquery(processed);
      case 'phraseto_tsquery': return this.phrasetoTsquery(processed);
      case 'websearch_to_tsquery': return this.websearchToTsquery(processed);
      default: return processed.replace(/['"]/g, '');
    }
  }

  /**
   * Remove a trailing run of emitted text equal to `text` (plus any whitespace
   * that precedes it), used to back out a left operand that was already copied
   * verbatim before its `@@` match operator was recognized.
   */
  private dropTrailingText(out: string[], text: string): void {
    // `out` holds a mix of single chars and whole-literal chunks, so collapse
    // it to a string, strip a trailing occurrence of `text` (plus immediately
    // preceding whitespace), then rebuild `out` from the result.
    const joined = out.join('');
    // Strip trailing whitespace that separated the left operand from `@@`,
    // then require `text` to be the last token.
    const noTrailingWs = joined.replace(/\s+$/, '');
    if (noTrailingWs.endsWith(text)) {
      // Drop `text`, keeping the whitespace that precedes it (that whitespace
      // separates the previous token from the left operand and must survive;
      // the replacement string supplies its own separating space).
      out.length = 0;
      const prefix = noTrailingWs.slice(0, noTrailingWs.length - text.length);
      if (prefix.length > 0) out.push(prefix);
    }
  }

  /**
   * Detect whether a SQL string contains PostgreSQL FTS constructs.
   *
   * @param sql - The SQL string to check.
   * @returns `true` if FTS patterns are found.
   */
  containsFts(sql: string): boolean {
    // Literal-aware scan: a keyword inside a string literal or comment is not a
    // real function call. We also avoid sharing the `g`-flag `PG_FTS_PATTERNS`
    // regexes for `test()` — a `g` regex leaks `lastIndex`, so repeated calls
    // on the same string flip between true/false (the stateful-regex trap).
    return this.firstFtsPosition(sql) !== -1;
  }

  /**
   * Scan `sql` for the first FTS construct outside literals/comments, returning
   * the byte offset of its function name, or `-1` when none is found.
   */
  private firstFtsPosition(sql: string): number {
    let i = 0;
    const names = [
      'to_tsvector', 'to_tsquery', 'plainto_tsquery', 'ts_rank',
      'ts_headline', 'phraseto_tsquery', 'websearch_to_tsquery',
    ];
    while (i < sql.length) {
      const skipped = skipSqlLiteral(sql, i);
      if (skipped !== -1) {
        i = skipped;
        continue;
      }
      for (const name of names) {
        if (
          sql.startsWith(name, i) &&
          (i === 0 || !this.isIdentChar(sql[i - 1])) &&
          !this.isIdentChar(sql[i + name.length])
        ) {
          return i;
        }
      }
      i++;
    }
    return -1;
  }

  private isIdentChar(c: string | undefined): boolean {
    return c !== undefined && /[A-Za-z0-9_$]/.test(c);
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
