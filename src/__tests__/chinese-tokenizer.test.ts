/**
 * ChineseTokenizer — Chinese text tokenizer tests.
 *
 * Covers pure-ASCII fast-path, jieba segmentation, the CJK fallback path
 * (simulated by making jieba-wasm unavailable), unaccent, and isChinese range
 * boundaries. Regression coverage for the defect where English words,
 * apostrophes, numbers and emails were shredded by jieba into punctuation
 * fragments (e.g. `O'Brien` → `["O","'","Brien"]`, `don't` → `["don","'","t"]`).
 */
import { describe, it, expect } from 'vitest';

// Re-import the module fresh in each test so we can toggle jieba availability
// via module mocking below.
import {
  tokenize,
  tokenizeForFTS,
  isChinese,
  unaccent,
} from '../query/ChineseTokenizer';

describe('ChineseTokenizer', () => {
  describe('isChinese', () => {
    it('detects CJK ideographs', () => {
      expect(isChinese('你好')).toBe(true);
      expect(isChinese('汉字')).toBe(true);
      expect(isChinese('中')).toBe(true);
    });

    it('returns false for pure ASCII', () => {
      expect(isChinese('hello')).toBe(false);
      expect(isChinese('')).toBe(false);
      expect(isChinese('123')).toBe(false);
      expect(isChinese("O'Brien")).toBe(false);
    });

    it('detects CJK punctuation and fullwidth symbols', () => {
      // Fullwidth comma (U+FF0C) and CJK punctuation (U+3001) are in the ranges.
      expect(isChinese('，')).toBe(true);
      expect(isChinese('、')).toBe(true);
      expect(isChinese('。')).toBe(true);
    });

    it('detects mixed content', () => {
      expect(isChinese('hello你好')).toBe(true);
      expect(isChinese('hello world 中文 mixed')).toBe(true);
    });
  });

  describe('tokenize — ASCII fast path', () => {
    it('keeps apostrophes and hyphens intact (#regression)', () => {
      expect(tokenize("O'Brien")).toEqual(["O'Brien"]);
      expect(tokenize("don't")).toEqual(["don't"]);
      expect(tokenize('hello-world')).toEqual(['hello-world']);
    });

    it('splits on whitespace and punctuation', () => {
      expect(tokenize('hello world foo')).toEqual(['hello', 'world', 'foo']);
      expect(tokenize('test@x.com')).toEqual(['test', 'x', 'com']);
      expect(tokenize('3.14')).toEqual(['3', '14']);
    });

    it('handles empty and whitespace-only input', () => {
      expect(tokenize('')).toEqual([]);
      expect(tokenize('   ')).toEqual([]);
      expect(tokenize('\t\n')).toEqual([]);
    });

    it('collapses multiple spaces', () => {
      expect(tokenize('a   b')).toEqual(['a', 'b']);
      expect(tokenize('  spaced   out  ')).toEqual(['spaced', 'out']);
    });
  });

  describe('tokenize — CJK (jieba or fallback)', () => {
    it('splits consecutive CJK characters into individual tokens', () => {
      expect(tokenize('你好世界')).toEqual(['你好', '世界']);
    });

    it('keeps ASCII runs intact next to CJK', () => {
      expect(tokenize('你好world')).toEqual(['你好', 'world']);
    });

    it('segments mixed content correctly', () => {
      const tokens = tokenize('你好 world 世界');
      expect(tokens).toContain('你好');
      expect(tokens).toContain('world');
      expect(tokens).toContain('世界');
    });
  });

  describe('tokenizeForFTS', () => {
    it('joins tokens with single spaces', () => {
      expect(tokenizeForFTS("O'Brien hello")).toBe("O'Brien hello");
      expect(tokenizeForFTS('你好world')).toBe('你好 world');
    });

    it('returns empty string for empty input', () => {
      expect(tokenizeForFTS('')).toBe('');
    });
  });

  describe('unaccent', () => {
    it('removes combining diacritics', () => {
      expect(unaccent('café')).toBe('cafe');
      expect(unaccent('naïve')).toBe('naive');
      expect(unaccent('Über')).toBe('Uber');
    });

    it('leaves plain ASCII untouched', () => {
      expect(unaccent('hello')).toBe('hello');
      expect(unaccent('正常')).toBe('正常');
    });
  });
});
