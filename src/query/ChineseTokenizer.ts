/**
 * ChineseTokenizer — Chinese text tokenizer.
 *
 * Prefer jieba-wasm for Chinese word segmentation; fall back to a minimal
 * per-character split over the CJK Unicode ranges when jieba-wasm is
 * unavailable. Pure-ASCII input (no CJK ideographs) is short-circuited to a
 * fast whitespace/punctuation tokenizer so that English words, apostrophes and
 * hyphens are never shredded by jieba.
 *
 * Integrates the FTS dictionary system:
 *   - Unaccent (diacritic removal) via NFKD normalization
 *   - Composable with the FtsTranslator dictionary chain
 *
 * @module query/ChineseTokenizer
 */

// ── CJK Unicode ranges ───────────────────────────────────────────
// Common Han ideographs, CJK punctuation, and fullwidth symbols.
const CJK_RANGES = [
  [0x2e80, 0x2eff],   // CJK Radicals Supplement
  [0x2f00, 0x2fdf],   // Kangxi Radicals
  [0x3000, 0x303f],   // CJK Symbols and Punctuation
  [0x3400, 0x4dbf],   // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff],   // CJK Unified Ideographs
  [0xf900, 0xfaff],   // CJK Compatibility Ideographs
  [0xff00, 0xffef],   // Fullwidth ASCII and fullwidth punctuation
] as const;

/** True when the given codepoint falls inside any CJK range. */
function isCJKCode(code: number): boolean {
  return CJK_RANGES.some(([start, end]) => code >= start && code <= end);
}

/**
 * Return true if the text contains any CJK ideograph (Chinese character).
 *
 * @param text - text to inspect
 * @returns true when a CJK character is present, false otherwise
 */
export function isChinese(text: string): boolean {
  for (const char of text) {
    if (isCJKCode(char.charCodeAt(0))) {
      return true;
    }
  }
  return false;
}

// ── jieba-wasm loading ──────────────────────────────────────────

let _jieba: typeof import('jieba-wasm') | null = null;
let _jiebaLoadError: Error | null = null;

function getJieba(): typeof import('jieba-wasm') | null {
  if (_jieba !== null) return _jieba;
  if (_jiebaLoadError !== null) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _jieba = require('jieba-wasm');
    return _jieba;
  } catch (err) {
    _jiebaLoadError = err instanceof Error ? err : new Error(String(err));
    return null;
  }
}

/**
 * Tokenize text for FTS indexing.
 *
 * Pure-ASCII input (no CJK ideographs) is handled by a fast tokenizer that
 * preserves apostrophes and hyphens, so words like `O'Brien`, `don't` and
 * `hello-world` remain single tokens. Mixed or pure-Chinese input is segmented
 * with jieba-wasm (precise mode, HMM disabled); if jieba cannot be loaded or
 * throws at runtime, it degrades to a per-character CJK fallback.
 *
 * @param text - text to tokenize
 * @returns an array of tokens
 */
export function tokenize(text: string): string[] {
  // Short-circuit pure-ASCII input to avoid jieba shredding English words,
  // apostrophes, numbers and emails into punctuation fragments.
  if (!isChinese(text)) {
    return tokenizeAscii(text);
  }

  const jieba = getJieba();

  if (jieba !== null) {
    try {
      // cut() in precise mode (HMM disabled). Drop whitespace-only tokens so
      // jieba never emits an empty token for inter-word spaces.
      return jieba.cut(text, false).filter((t: string) => t.trim().length > 0);
    } catch {
      // Runtime failure → degrade to fallback tokenization.
    }
  }

  return fallbackTokenize(text);
}

/**
 * Tokenize text and return a space-separated string ready for FTS5 insertion.
 *
 * For mixed Chinese/English content, the Chinese portion is segmented via
 * jieba while ASCII runs are kept intact (English words are space-delimited).
 *
 * @param text - text to tokenize
 * @returns space-delimited token string
 */
export function tokenizeForFTS(text: string): string {
  return tokenize(text).join(' ');
}

// ── Unaccent (diacritic removal) ────────────────────────────────

/**
 * Remove combining diacritics via NFKD normalization.
 *
 * For example: é → e, ü → u, ñ → n.
 *
 * @param s - text that may contain diacritics
 * @returns text with diacritics removed
 */
export function unaccent(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

// ── ASCII fast-path tokenizer ───────────────────────────────────

/**
 * Split pure-ASCII text on runs of characters that are neither word characters
 * nor apostrophes/hyphens. This keeps `O'Brien`, `don't` and `hello-world` as
 * single tokens while splitting on spaces and punctuation such as `.`, `@`.
 */
function tokenizeAscii(text: string): string[] {
  return text
    .split(/[^\w'-]+/)
    .filter((t) => t.length > 0);
}

// ── Fallback (CJK) tokenizer ────────────────────────────────────

/**
 * Minimal CJK fallback tokenizer.
 *
 * Strategy:
 *   - Each consecutive CJK character becomes its own token
 *   - Non-CJK runs (English, numbers, …) are normalized via punctuation-free
 *     splitting and pushed as-is
 *
 * @param text - text to tokenize
 * @returns an array of tokens
 */
function fallbackTokenize(text: string): string[] {
  const tokens: string[] = [];
  let currentBuffer = '';

  for (const char of text) {
    const isCJK = isCJKCode(char.charCodeAt(0));

    if (isCJK) {
      // Flush any accumulated non-CJK buffer first.
      if (currentBuffer.length > 0) {
        pushNormalized(tokens, currentBuffer);
        currentBuffer = '';
      }
      // A single CJK character maps to a single token.
      tokens.push(char);
    } else {
      currentBuffer += char;
    }
  }

  // Flush trailing non-CJK content.
  if (currentBuffer.length > 0) {
    pushNormalized(tokens, currentBuffer);
  }

  return tokens.filter(Boolean);
}

/**
 * Split a non-CJK run into tokens by whitespace/punctuation while preserving
 * apostrophes and hyphens; append results to the token list.
 */
function pushNormalized(tokens: string[], text: string): void {
  const parts = text
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);

  for (const part of parts) {
    tokens.push(part);
  }
}
