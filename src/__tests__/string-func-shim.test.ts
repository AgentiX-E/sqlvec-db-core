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

describe('pure string functions', () => {
  it('splitPart', () => {
    expect(splitPart('a,b,c', ',', 2)).toBe('b');
    expect(splitPart('a,b,c', ',', 0)).toBe('');
    expect(splitPart('a,b,c', ',', 99)).toBe('');
    expect(splitPart('a,,c', ',', 2)).toBe('');
  });

  it('repeatStr', () => {
    expect(repeatStr('ha', 3)).toBe('hahaha');
    expect(repeatStr('x', 0)).toBe('');
    expect(repeatStr('x', -2)).toBe('');
    expect(repeatStr('x', 2.7)).toBe('xx'); // floor
  });

  it('lpad / rpad', () => {
    expect(lpad('abc', 5, '*')).toBe('**abc');
    expect(rpad('abc', 5, '*')).toBe('abc**');
    expect(lpad('abc', 3, '*')).toBe('abc'); // already long enough
    expect(rpad('abc', 2, '*')).toBe('abc');
    expect(lpad('abc', 6, '')).toBe('abc'); // empty fill
    expect(rpad('abc', 6, '')).toBe('abc');
    expect(lpad('', 3, '*')).toBe('***');
    expect(rpad('', 3, '*')).toBe('***');
    expect(lpad('a', 5)).toBe('    a'); // default space fill
    expect(lpad('abc', 0, '*')).toBe('abc'); // zero length
    expect(rpad('abc', 0, '*')).toBe('abc');
    expect(lpad('abc', NaN as unknown as number, '*')).toBe('abc');
    expect(rpad('abc', -5, '*')).toBe('abc'); // negative length
  });

  it('leftStr / rightStr', () => {
    expect(leftStr('abcdef', 3)).toBe('abc');
    expect(leftStr('abcdef', -3)).toBe('abc'); // all but last 3
    expect(leftStr('abcdef', 0)).toBe('');
    expect(rightStr('abcdef', 3)).toBe('def');
    expect(rightStr('abcdef', -3)).toBe('def'); // all but first 3
    expect(rightStr('abcdef', 0)).toBe('');
  });

  it('translate', () => {
    expect(translate('abcdef', 'ace', 'XYZ')).toBe('XbYdZf');
    expect(translate('abcdef', 'a', '')).toBe('bcdef'); // remove only
    expect(translate('abcdef', '', 'xyz')).toBe('abcdef'); // empty from
    expect(translate('abab', 'a', 'x')).toBe('xbxb');
  });

  it('reverseStr', () => {
    expect(reverseStr('abc')).toBe('cba');
    expect(reverseStr('')).toBe('');
  });

  it('levenshteinCustom', () => {
    expect(levenshteinCustom('kitten', 'sitting')).toBe(3);
    expect(levenshteinCustom('', 'abc')).toBe(3);
    expect(levenshteinCustom('abc', '')).toBe(3);
    expect(levenshteinCustom('same', 'same')).toBe(0);
    // custom costs
    expect(levenshteinCustom('ab', 'ba', 10, 10, 10)).toBe(20);
    // swap shorter/longer preserves result
    expect(levenshteinCustom('abc', 'a')).toBe(2);
    // null / undefined inputs are coerced to empty strings
    expect(levenshteinCustom(null as unknown as string, 'ab')).toBe(2);
    expect(levenshteinCustom('ab', null as unknown as string)).toBe(2);
  });
});

describe('detectStringFunc', () => {
  it('detects each PG string function', () => {
    expect(detectStringFunc("SELECT split_part(a, ',', 2)")).toBe(true);
    expect(detectStringFunc("SELECT repeat('x', 3)")).toBe(true);
    expect(detectStringFunc('SELECT lpad(a, 5)')).toBe(true);
    expect(detectStringFunc('SELECT rpad(a, 5)')).toBe(true);
    expect(detectStringFunc('SELECT left(a, 3)')).toBe(true);
    expect(detectStringFunc('SELECT right(a, 3)')).toBe(true);
    expect(detectStringFunc('SELECT translate(a, b, c)')).toBe(true);
    expect(detectStringFunc('SELECT reverse(a)')).toBe(true);
  });

  it('does not detect a literal', () => {
    expect(detectStringFunc("SELECT 'left(a,3)'")).toBe(false);
  });

  it('does not detect a comment', () => {
    expect(detectStringFunc('-- left(a,3)\nSELECT 1')).toBe(false);
  });

  it('does not detect identifier prefixes/suffixes', () => {
    expect(detectStringFunc('SELECT leftward(a)')).toBe(false);
    expect(detectStringFunc('SELECT myleft(a)')).toBe(false);
    expect(detectStringFunc('SELECT "left"(a,3)')).toBe(false); // quoted identifier
  });

  it('detects schema-qualified call', () => {
    expect(detectStringFunc('SELECT pg_catalog.left(a, 3)')).toBe(true);
  });

  it('returns false for empty / non-string', () => {
    expect(detectStringFunc('')).toBe(false);
    expect(detectStringFunc(undefined as unknown as string)).toBe(false);
  });

  it('returns false when the function name is at end-of-string with no paren', () => {
    expect(detectStringFunc('SELECT left')).toBe(false);
    expect(detectStringFunc('SELECT right')).toBe(false);
  });
});

describe('rewriteStringFunc', () => {
  it('rewrites left to a CASE/substr expression', () => {
    expect(rewriteStringFunc('SELECT left(name, 3) FROM t')).toContain('CASE WHEN (3) >= 0');
    expect(rewriteStringFunc('SELECT left(name, 3) FROM t')).toContain('substr(name, 1, (3))');
  });

  it('rewrites right with correct negative semantics', () => {
    const r = rewriteStringFunc('SELECT right(name, -3) FROM t');
    expect(r).toContain('substr(name, -(-3))');
    expect(r).not.toContain('--'); // no accidental comment
    expect(r).toContain('1 - (-3)');
  });

  it('handles nested function call arguments', () => {
    const r = rewriteStringFunc('SELECT left(trim(name), f(x)) FROM t');
    expect(r).toContain('trim(name)');
    expect(r).toContain('f(x)');
  });

  it('handles nested calls to left and right', () => {
    const r = rewriteStringFunc('SELECT right(left(a,2), 3) FROM t');
    expect(r).toContain('left(a,2)');
    expect(r).toContain('CASE WHEN (3) >= 0');
  });

  it('does not rewrite a literal (BUG #447)', () => {
    expect(rewriteStringFunc("SELECT 'left(a,3)' FROM t")).toBe("SELECT 'left(a,3)' FROM t");
  });

  it('does not rewrite inside a comment (BUG #447)', () => {
    expect(rewriteStringFunc('SELECT left(a,3) -- left(b,2)\nFROM t')).toBe(
      'SELECT ' + rewriteStringFunc('SELECT left(a,3)').slice('SELECT '.length) + ' -- left(b,2)\nFROM t',
    );
  });

  it('strips a schema qualifier (BUG #445)', () => {
    const r = rewriteStringFunc('SELECT s.left(a, 3) FROM t');
    expect(r).not.toContain('s.CASE');
    expect(r).not.toContain('s.substr');
    expect(r).toContain('CASE WHEN (3) >= 0');
  });

  it('leaves an empty-argument call untouched (BUG #444)', () => {
    expect(rewriteStringFunc('SELECT left(a, ) FROM t')).toBe('SELECT left(a, ) FROM t');
    expect(rewriteStringFunc('SELECT right(a,) FROM t')).toBe('SELECT right(a,) FROM t');
  });

  it('leaves wrong-arity calls untouched', () => {
    expect(rewriteStringFunc('SELECT left(a) FROM t')).toBe('SELECT left(a) FROM t');
    expect(rewriteStringFunc('SELECT left(a,b,c) FROM t')).toBe('SELECT left(a,b,c) FROM t');
  });

  it('leaves an unbalanced call untouched', () => {
    expect(rewriteStringFunc('SELECT left(a, 3 FROM t')).toBe('SELECT left(a, 3 FROM t');
  });

  it('honors a comma inside a string literal argument', () => {
    const r = rewriteStringFunc("SELECT left(name, length('a,b')) FROM t");
    expect(r).toContain("length('a,b')");
    expect(r).toContain('CASE WHEN');
  });

  it('skips a non-rewritable function with an unbalanced paren', () => {
    expect(rewriteStringFunc('SELECT translate(a, b FROM t')).toBe('SELECT translate(a, b FROM t');
  });

  it('leaves a schema-qualified non-identifier untouched', () => {
    // `s..left` — after the dot there is no identifier, so it is not a function call.
    expect(rewriteStringFunc('SELECT s..left(a,3)')).toBe('SELECT s..left(a,3)');
  });

  it('does not rewrite non-rewritable functions', () => {
    expect(rewriteStringFunc('SELECT translate(a,b,c)')).toBe('SELECT translate(a,b,c)');
    expect(rewriteStringFunc('SELECT reverse(a)')).toBe('SELECT reverse(a)');
  });

  it('returns input unchanged for empty / non-string', () => {
    expect(rewriteStringFunc('')).toBe('');
    expect(rewriteStringFunc(undefined as unknown as string)).toBe(undefined);
  });
});

describe('detectAndRewriteStringFunc', () => {
  it('returns rewritten:true with rewritten SQL', () => {
    const r = detectAndRewriteStringFunc('SELECT left(a, 3)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('CASE WHEN');
  });

  it('returns rewritten:false when nothing detected', () => {
    const r = detectAndRewriteStringFunc('SELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });
});

describe('registerStringFunctions', () => {
  it('registers all eight functions on a db with .function()', () => {
    const db = { function: vi.fn() };
    registerStringFunctions(db);
    expect(db.function).toHaveBeenCalledTimes(8);
    const names = db.function.mock.calls.map((c: any[]) => c[0]);
    for (const n of ['split_part', 'repeat', 'lpad', 'rpad', 'left', 'right', 'translate', 'reverse']) {
      expect(names).toContain(n);
    }
  });

  it('warns and returns when db has no .function()', () => {
    const db = {} as any;
    // Should not throw.
    expect(() => registerStringFunctions(db)).not.toThrow();
    expect(() => registerStringFunctions(null as any)).not.toThrow();
  });
});

describe('STRING_FUNCTIONS_META', () => {
  it('has an entry for every string function', () => {
    const names = STRING_FUNCTIONS_META.map((m) => m.name);
    for (const n of ['split_part', 'repeat', 'lpad', 'rpad', 'left', 'right', 'translate', 'reverse']) {
      expect(names).toContain(n);
    }
    expect(STRING_FUNCTIONS_META).toHaveLength(8);
  });
});
