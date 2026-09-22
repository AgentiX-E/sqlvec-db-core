/**
 * ChineseTokenizer — jieba-unavailable fallback path tests.
 *
 * These tests force `require('jieba-wasm')` to throw (via a Module.prototype
 * spy) so that getJieba() records a load error and tokenize() degrades to the
 * per-character CJK fallback. This exercises both the require-failure catch
 * branch and the error-caching branch that returns null on subsequent calls.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Module from 'module';

import { tokenize, tokenizeForFTS, isChinese } from '../query/ChineseTokenizer';

describe('ChineseTokenizer fallback (jieba unavailable)', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  const originalRequire = Module.prototype.require;

  function makeJiebaUnavailable() {
    spy = vi.spyOn(Module.prototype, 'require').mockImplementation(function (
      this: any,
      id: string,
    ) {
      if (id === 'jieba-wasm') throw new Error('jieba-wasm unavailable (mocked)');
      return originalRequire.apply(this, [id]);
    });
  }

  afterEach(() => {
    spy?.mockRestore();
  });

  it('wraps a non-Error throw into an Error', async () => {
    // Throw a plain string (non-Error) BEFORE any Error is cached by other
    // tests, exercising the `err instanceof Error ? err : new Error(...)`
    // else-branch. A fresh module instance is imported so the module-level
    // _jiebaLoadError cache starts clean.
    vi.resetModules();
    const nonErrorRequire = vi.spyOn(Module.prototype, 'require').mockImplementation(
      function (this: any, id: string) {
        if (id === 'jieba-wasm') throw 'plain string failure';
        return originalRequire.apply(this, [id]);
      },
    );
    try {
      const fresh = await import('../query/ChineseTokenizer');
      expect(fresh.tokenize('中文')).toEqual(['中', '文']);
    } finally {
      nonErrorRequire.mockRestore();
    }
  });

  it('splits consecutive CJK characters into individual tokens', () => {
    makeJiebaUnavailable();
    expect(tokenize('你好世界')).toEqual(['你', '好', '世', '界']);
  });

  it('keeps ASCII runs intact next to CJK', () => {
    makeJiebaUnavailable();
    expect(tokenize('你好world')).toEqual(['你', '好', 'world']);
  });

  it('preserves apostrophes and hyphens in ASCII runs', () => {
    makeJiebaUnavailable();
    expect(tokenize("O'Brien")).toEqual(["O'Brien"]);
    expect(tokenize('hello-world')).toEqual(['hello-world']);
  });

  it('splits punctuation-separated ASCII', () => {
    makeJiebaUnavailable();
    expect(tokenize('test@x.com')).toEqual(['test', 'x', 'com']);
  });

  it('flushes trailing ASCII buffer after CJK', () => {
    makeJiebaUnavailable();
    expect(tokenize('中文abc')).toEqual(['中', '文', 'abc']);
  });

  it('flushes leading ASCII buffer before CJK', () => {
    makeJiebaUnavailable();
    expect(tokenize('abc中文')).toEqual(['abc', '中', '文']);
  });

  it('flushes multiple buffers across mixed segments', () => {
    makeJiebaUnavailable();
    expect(tokenize('a你好b世界c')).toEqual(['a', '你', '好', 'b', '世', '界', 'c']);
  });

  it('caches the load error for subsequent calls', () => {
    makeJiebaUnavailable();
    // First call triggers require failure and caches _jiebaLoadError.
    expect(tokenize('中文')).toEqual(['中', '文']);
    // Second call must not re-require; the cached error short-circuits.
    expect(tokenize('中文')).toEqual(['中', '文']);
  });

  it('tokenizeForFTS joins fallback tokens', () => {
    makeJiebaUnavailable();
    expect(tokenizeForFTS('你好world')).toBe('你 好 world');
  });

  it('isChinese and unaccent still work without jieba', () => {
    makeJiebaUnavailable();
    expect(isChinese('你好')).toBe(true);
    expect(isChinese('hello')).toBe(false);
  });
});
