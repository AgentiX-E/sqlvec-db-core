import { describe, it, expect, vi } from 'vitest';
import {
  splitPart,
  repeatStr,
  lpad,
  rpad,
  leftStr,
  rightStr,
  translate,
  reverseStr,
  levenshteinCustom,
  detectStringFunc,
  rewriteStringFunc,
  detectAndRewriteStringFunc,
  registerStringFunctions,
  STRING_FUNCTIONS_META,
} from '../query/StringFuncShim';

describe('pure JS string functions', () => {
  it('splitPart returns the nth field', () => {
    expect(splitPart('a,b,c', ',', 2)).toBe('b');
    expect(splitPart('a,b,c', ',', 1)).toBe('a');
    expect(splitPart('a,b,c', ',', 5)).toBe('');
    expect(splitPart('a,b,c', ',', 0)).toBe('');
    expect(splitPart('a,b,c', ',', -1)).toBe('');
  });
  it('repeatStr repeats and clamps negative/zero', () => {
    expect(repeatStr('hi', 3)).toBe('hihihi');
    expect(repeatStr('hi', 0)).toBe('');
    expect(repeatStr('hi', -1)).toBe('');
    expect(repeatStr('hi', 2.9)).toBe('hihi');
  });
  it('lpad pads left with truncation', () => {
    expect(lpad('ab', 5, '*')).toBe('***ab');
    expect(lpad('ab', 2, '*')).toBe('ab');
    expect(lpad('ab', 5, '')).toBe('ab');
    expect(lpad('ab', 5)).toBe('   ab');
    expect(lpad('ab', 0, '*')).toBe('ab');
    expect(lpad('ab', NaN, '*')).toBe('ab');
  });
  it('rpad pads right with truncation', () => {
    expect(rpad('ab', 5, '*')).toBe('ab***');
    expect(rpad('ab', 2, '*')).toBe('ab');
    expect(rpad('ab', 5, '')).toBe('ab');
    expect(rpad('ab', 5)).toBe('ab   ');
    expect(rpad('ab', 0, '*')).toBe('ab');
    expect(rpad('ab', NaN, '*')).toBe('ab');
  });
  it('leftStr handles positive and negative n', () => {
    expect(leftStr('abc', 2)).toBe('ab');
    expect(leftStr('abc', -1)).toBe('ab');
    expect(leftStr('abc', 0)).toBe('');
  });
  it('rightStr handles positive, zero, and negative n', () => {
    expect(rightStr('abc', 2)).toBe('bc');
    expect(rightStr('abc', 0)).toBe('');
    expect(rightStr('abc', -1)).toBe('bc');
  });
  it('translate replaces and deletes unmatched chars', () => {
    expect(translate('aabbcc', 'abc', 'xy')).toBe('xxyy');
    expect(translate('abc', '', 'xyz')).toBe('abc');
    expect(translate('abc', 'ab', 'x')).toBe('xc');
  });
  it('reverseStr reverses', () => {
    expect(reverseStr('abc')).toBe('cba');
  });
  it('levenshteinCustom computes edit distance', () => {
    expect(levenshteinCustom('kitten', 'sitting')).toBe(3);
    expect(levenshteinCustom('', 'abc')).toBe(3);
    expect(levenshteinCustom('abc', 'abc')).toBe(0);
    expect(levenshteinCustom('abc', 'def', 2, 3, 4)).toBe(12);
    expect(levenshteinCustom(null as unknown as string, 'abc')).toBe(3);
    expect(levenshteinCustom('abc', null as unknown as string)).toBe(3);
  });
});

describe('detectStringFunc', () => {
  it('detects rewritable functions', () => {
    expect(detectStringFunc('SELECT left(name, 3) FROM t')).toBe(true);
    expect(detectStringFunc('SELECT right(name, 2) FROM t')).toBe(true);
  });
  it('detects custom-only functions', () => {
    expect(detectStringFunc('SELECT split_part(a, b, c) FROM t')).toBe(true);
    expect(detectStringFunc('SELECT repeat(x, 3) FROM t')).toBe(true);
    expect(detectStringFunc('SELECT reverse(x) FROM t')).toBe(true);
    expect(detectStringFunc('SELECT translate(x, a, b) FROM t')).toBe(true);
  });
  it('detects schema-qualified calls', () => {
    expect(detectStringFunc('SELECT schema.left(name, 3) FROM t')).toBe(true);
  });
  it('does not detect a string literal', () => {
    expect(detectStringFunc("SELECT 'left(a, b)' FROM t")).toBe(false);
  });
  it('does not detect a comment', () => {
    expect(detectStringFunc('-- left(name, 3)\nSELECT 1')).toBe(false);
    expect(detectStringFunc('/* right(a, b) */ SELECT 1')).toBe(false);
  });
  it('does not detect a prefix-identifier', () => {
    expect(detectStringFunc('SELECT left_unrelated(a, b) FROM t')).toBe(false);
  });
  it('does not detect bare identifier without call parens', () => {
    expect(detectStringFunc('SELECT left FROM t')).toBe(false);
  });
  it('does not detect a digit after a schema dot', () => {
    expect(detectStringFunc('SELECT a.1(a) FROM t')).toBe(false);
  });
  it('does not detect a trailing dot', () => {
    expect(detectStringFunc('SELECT left.')).toBe(false);
  });
  it('detects a call with a literal argument', () => {
    expect(detectStringFunc("SELECT left('a)b', 3) FROM t")).toBe(true);
  });
  it('is deterministic across calls', () => {
    const s = 'SELECT left(a, b)';
    expect([0, 1, 2, 3].map(() => detectStringFunc(s))).toEqual([true, true, true, true]);
  });
  it('rejects null / undefined / blank', () => {
    expect(detectStringFunc(null as unknown as string)).toBe(false);
    expect(detectStringFunc(undefined as unknown as string)).toBe(false);
    expect(detectStringFunc('   ')).toBe(false);
  });
});

describe('rewriteStringFunc', () => {
  it('rewrites left → substr', () => {
    expect(rewriteStringFunc('SELECT left(name, 3) FROM t')).toBe(
      'SELECT substr(name, 1, 3) FROM t',
    );
  });
  it('rewrites right → substr', () => {
    expect(rewriteStringFunc('SELECT right(name, 2) FROM t')).toBe(
      'SELECT substr(name, -2, 2) FROM t',
    );
  });
  it('handles nested parens in the first argument', () => {
    expect(rewriteStringFunc('SELECT left(f(a, b), 3) FROM t')).toBe(
      'SELECT substr(f(a, b), 1, 3) FROM t',
    );
  });
  it('handles nested parens in the second argument', () => {
    expect(rewriteStringFunc('SELECT left(name, (2+1)) FROM t')).toBe(
      'SELECT substr(name, 1, (2+1)) FROM t',
    );
  });
  it('does not rewrite a string literal', () => {
    expect(rewriteStringFunc("SELECT 'left(a, b)' FROM t")).toBe("SELECT 'left(a, b)' FROM t");
  });
  it('does not rewrite comments', () => {
    expect(rewriteStringFunc('-- left(name, 3)\nSELECT 1')).toBe('-- left(name, 3)\nSELECT 1');
    expect(rewriteStringFunc('/* right(a, b) */ SELECT 1')).toBe('/* right(a, b) */ SELECT 1');
  });
  it('does not rewrite non-rewritable functions', () => {
    expect(rewriteStringFunc('SELECT split_part(a, b, c) FROM t')).toBe(
      'SELECT split_part(a, b, c) FROM t',
    );
    expect(rewriteStringFunc('SELECT repeat(x, 3) FROM t')).toBe('SELECT repeat(x, 3) FROM t');
  });
  it('rewrites multiple calls', () => {
    expect(rewriteStringFunc('SELECT left(name, 3), right(name, 2) FROM t')).toBe(
      'SELECT substr(name, 1, 3), substr(name, -2, 2) FROM t',
    );
  });
  it('preserves a schema qualifier', () => {
    expect(rewriteStringFunc('SELECT schema.left(name, 3) FROM t')).toBe(
      'SELECT schema.substr(name, 1, 3) FROM t',
    );
  });
  it('leaves wrong-arity calls verbatim', () => {
    expect(rewriteStringFunc('SELECT left(name) FROM t')).toBe('SELECT left(name) FROM t');
  });
  it('leaves an unbalanced call untouched', () => {
    expect(rewriteStringFunc('SELECT left(name, 3')).toBe('SELECT left(name, 3');
  });
  it('handles a literal with parens inside an argument', () => {
    expect(rewriteStringFunc("SELECT left('a)b', 3) FROM t")).toBe(
      "SELECT substr('a)b', 1, 3) FROM t",
    );
  });
  it('handles a comma inside a string literal argument', () => {
    expect(rewriteStringFunc("SELECT left(concat('a,b', 'c'), 3) FROM t")).toBe(
      "SELECT substr(concat('a,b', 'c'), 1, 3) FROM t",
    );
  });
  it('leaves an unbalanced custom-only function untouched', () => {
    expect(rewriteStringFunc('SELECT repeat(a, b')).toBe('SELECT repeat(a, b');
  });
  it('returns input unchanged when no rewritable function present', () => {
    expect(rewriteStringFunc('SELECT 1')).toBe('SELECT 1');
  });
  it('passes through null / undefined / blank', () => {
    expect(rewriteStringFunc(null as unknown as string)).toBe(null as unknown as string);
    expect(rewriteStringFunc(undefined as unknown as string)).toBe(undefined as unknown as string);
    expect(rewriteStringFunc('   ')).toBe('   ');
  });
});

describe('detectAndRewriteStringFunc', () => {
  it('returns rewritten when a rewritable function exists', () => {
    expect(detectAndRewriteStringFunc('SELECT left(a, b)')).toEqual({
      sql: 'SELECT substr(a, 1, b)',
      rewritten: true,
    });
  });
  it('returns unchanged for a custom-only function', () => {
    expect(detectAndRewriteStringFunc('SELECT repeat(a, 3)')).toEqual({
      sql: 'SELECT repeat(a, 3)',
      rewritten: false,
    });
  });
  it('returns unchanged for no function', () => {
    expect(detectAndRewriteStringFunc('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });
});

describe('registerStringFunctions', () => {
  it('warns and returns when db.function is missing', () => {
    const db = {};
    expect(() => registerStringFunctions(db)).not.toThrow();
  });
  it('registers all eight functions', () => {
    const fn = vi.fn();
    const db = { function: fn };
    registerStringFunctions(db);
    expect(fn).toHaveBeenCalledTimes(8);
    const names = fn.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      'split_part',
      'repeat',
      'lpad',
      'rpad',
      'left',
      'right',
      'translate',
      'reverse',
    ]);
  });
});

describe('STRING_FUNCTIONS_META', () => {
  it('documents all eight functions', () => {
    expect(STRING_FUNCTIONS_META).toHaveLength(8);
    expect(STRING_FUNCTIONS_META.map((m) => m.name)).toEqual([
      'split_part',
      'repeat',
      'lpad',
      'rpad',
      'left',
      'right',
      'translate',
      'reverse',
    ]);
  });
});
