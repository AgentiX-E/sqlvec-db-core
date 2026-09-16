import { describe, it, expect, beforeAll } from 'vitest';
import { buildPgFunctions, PgFunctionMap } from '../system/PgFunctions';

let map: PgFunctionMap;
const fn = (name: string, ...args: unknown[]) => map.get(name)!.fn(...args);

beforeAll(() => {
  map = buildPgFunctions();
});

describe('PgFunctions — left / right', () => {
  it('left takes the first n chars', () => {
    expect(fn('left', 'abcdef', 3)).toBe('abc');
  });

  it('left with n=0 returns empty', () => {
    expect(fn('left', 'abcdef', 0)).toBe('');
  });

  it('left with negative n drops the last |n| chars', () => {
    expect(fn('left', 'abcdef', -2)).toBe('abcd');
  });

  it('left returns null on null input', () => {
    expect(fn('left', null, 2)).toBeNull();
    expect(fn('left', 'abc', null)).toBeNull();
  });

  it('left returns null on non-numeric n', () => {
    expect(fn('left', 'abc', 'x')).toBeNull();
  });

  it('right takes the last n chars', () => {
    expect(fn('right', 'abcdef', 3)).toBe('def');
  });

  it('right with n=0 returns empty (BUG #118)', () => {
    expect(fn('right', 'abcdef', 0)).toBe('');
  });

  it('right with negative n drops the last |n| chars (BUG #118)', () => {
    expect(fn('right', 'abcdef', -2)).toBe('abcd');
  });

  it('right with n greater than length returns the whole string', () => {
    expect(fn('right', 'abc', 5)).toBe('abc');
  });

  it('right returns null on null input', () => {
    expect(fn('right', null, 2)).toBeNull();
    expect(fn('right', 'abc', null)).toBeNull();
  });
});

describe('PgFunctions — substr / substring / overlay', () => {
  it('substr with positive start is 1-indexed', () => {
    expect(fn('substr', 'abcdef', 2)).toBe('bcdef');
    expect(fn('substr', 'abcdef', 2, 3)).toBe('bcd');
  });

  it('substr with negative start counts from the end', () => {
    expect(fn('substr', 'abcdef', -2)).toBe('ef');
  });

  it('substr with negative count returns empty', () => {
    expect(fn('substr', 'abcdef', 1, -1)).toBe('');
  });

  it('substring with string position handles a negative sign (BUG #119)', () => {
    expect(fn('substring', 'abcdef', '-1')).toBe('f');
    expect(fn('substring', 'abcdef', '-2')).toBe('ef');
  });

  it('substring with numeric position matches substr', () => {
    expect(fn('substring', 'abcdef', 2, 3)).toBe('bcd');
    expect(fn('substring', 'abcdef', -2)).toBe('ef');
  });

  it('substring with a regex pattern extracts the first match', () => {
    expect(fn('substring', 'foobar', 'o+')).toBe('oo');
  });

  it('substring with no regex match returns empty', () => {
    expect(fn('substring', 'foobar', 'zzz')).toBe('');
  });

  it('overlay replaces a substring', () => {
    expect(fn('overlay', 'abcdef', 'XYZ', 3, 2)).toBe('abXYZef');
  });

  it('overlay with default count (replacement length)', () => {
    expect(fn('overlay', 'abcdef', 'XY', 3)).toBe('abXYef');
  });

  it('overlay returns null on null/non-numeric input', () => {
    expect(fn('overlay', null, 'X', 1)).toBeNull();
    expect(fn('overlay', 'abc', 'X', 'bad')).toBeNull();
  });
});

describe('PgFunctions — trim family', () => {
  it('trim without args trims whitespace', () => {
    expect(fn('trim', '  hi  ')).toBe('hi');
  });

  it('ltrim trims leading', () => {
    expect(fn('ltrim', 'xxhi', 'x')).toBe('hi');
    expect(fn('ltrim', '  hi')).toBe('hi');
  });

  it('rtrim trims trailing', () => {
    expect(fn('rtrim', 'hixx', 'x')).toBe('hi');
    expect(fn('rtrim', 'hi  ')).toBe('hi');
  });

  it('btrim trims both with a charset', () => {
    expect(fn('btrim', 'xxhixx', 'x')).toBe('hi');
    expect(fn('btrim', '  hi  ')).toBe('hi');
  });

  it('trim with LEADING/TRAILING/BOTH mode', () => {
    expect(fn('trim', 'xxhixx', 'x', 'LEADING')).toBe('hixx');
    expect(fn('trim', 'xxhixx', 'x', 'TRAILING')).toBe('xxhi');
    expect(fn('trim', 'xxhixx', 'x', 'BOTH')).toBe('hi');
  });

  it('trim with empty charset returns original', () => {
    expect(fn('ltrim', 'abc', '')).toBe('abc');
    expect(fn('rtrim', 'abc', '')).toBe('abc');
  });
});

describe('PgFunctions — padding (lpad / rpad)', () => {
  it('lpad pads the left', () => {
    expect(fn('lpad', 'hi', 5)).toBe('   hi');
    expect(fn('lpad', 'hi', 5, 'xy')).toBe('xyxhi');
  });

  it('rpad pads the right', () => {
    expect(fn('rpad', 'hi', 5)).toBe('hi   ');
    expect(fn('rpad', 'hi', 5, 'xy')).toBe('hixyx');
  });

  it('lpad/rpad truncate when target length is shorter', () => {
    expect(fn('lpad', 'hello', 3)).toBe('hel');
    expect(fn('rpad', 'hello', 3)).toBe('hel');
  });

  it('lpad/rpad return original on empty fill', () => {
    expect(fn('lpad', 'hi', 5, '')).toBe('hi');
    expect(fn('rpad', 'hi', 5, '')).toBe('hi');
  });

  it('lpad/rpad return null on null/non-numeric', () => {
    expect(fn('lpad', null, 5)).toBeNull();
    expect(fn('rpad', 'hi', 'x')).toBeNull();
  });
});

describe('PgFunctions — translate / replace / reverse / initcap', () => {
  it('translate maps characters', () => {
    expect(fn('translate', 'abca', 'a', 'x')).toBe('xbcx');
  });

  it('translate deletes chars absent from the target (from longer than to)', () => {
    expect(fn('translate', 'abca', 'ab', 'x')).toBe('xcx');
  });

  it('translate returns null on null input', () => {
    expect(fn('translate', null, 'a', 'b')).toBeNull();
  });

  it('replace substitutes all occurrences', () => {
    expect(fn('replace', 'aaa', 'a', 'b')).toBe('bbb');
    expect(fn('replace', 'abc', '', 'x')).toBe('abc');
  });

  it('reverse reverses a string', () => {
    expect(fn('reverse', 'abc')).toBe('cba');
    expect(fn('reverse', null)).toBeNull();
  });

  it('initcap capitalizes each word', () => {
    expect(fn('initcap', 'hello WORLD')).toBe('Hello World');
    expect(fn('initcap', null)).toBeNull();
  });
});

describe('PgFunctions — repeat / split_part / strpos / position', () => {
  it('repeat repeats a string', () => {
    expect(fn('repeat', 'ab', 3)).toBe('ababab');
    expect(fn('repeat', 'ab', 0)).toBe('');
  });

  it('repeat returns null on negative/non-numeric/null', () => {
    expect(fn('repeat', 'ab', -1)).toBeNull();
    expect(fn('repeat', 'ab', 'x')).toBeNull();
    expect(fn('repeat', null, 2)).toBeNull();
  });

  it('split_part splits by a delimiter', () => {
    expect(fn('split_part', 'a,b,c', ',', 2)).toBe('b');
    expect(fn('split_part', 'a,b,c', ',', -1)).toBe('c');
  });

  it('split_part returns empty for out-of-range fields', () => {
    expect(fn('split_part', 'a,b', ',', 5)).toBe('');
    expect(fn('split_part', 'a,b', ',', 0)).toBe('');
  });

  it('split_part returns null on null/non-numeric field', () => {
    expect(fn('split_part', 'a,b', ',', 'x')).toBeNull();
    expect(fn('split_part', null, ',', 1)).toBeNull();
  });

  it('strpos returns 1-indexed position or 0', () => {
    expect(fn('strpos', 'hello', 'll')).toBe(3);
    expect(fn('strpos', 'hello', 'zz')).toBe(0);
    expect(fn('strpos', 'hello', '')).toBe(1);
  });

  it('position finds a substring', () => {
    expect(fn('position', 'll', 'hello')).toBe(3);
    expect(fn('position', 'zz', 'hello')).toBe(0);
  });
});

describe('PgFunctions — regexp family', () => {
  it('regexp_match returns captured groups', () => {
    expect(fn('regexp_match', 'foobar', 'f(o+)bar')).toEqual(['oo']);
  });

  it('regexp_match returns full match when no capture group', () => {
    expect(fn('regexp_match', 'foobar', 'o+')).toBe('oo');
  });

  it('regexp_match returns null on no match or invalid pattern', () => {
    expect(fn('regexp_match', 'abc', 'zzz')).toBeNull();
    expect(fn('regexp_match', 'abc', '(')).toBeNull();
  });

  it('regexp_matches without g returns a single wrapped match', () => {
    expect(fn('regexp_matches', 'foobar', 'o+')).toEqual([['oo']]);
    expect(fn('regexp_matches', 'foobar', 'f(o+)')).toEqual([['oo']]);
  });

  it('regexp_matches with g returns all matches', () => {
    expect(fn('regexp_matches', 'foobaroob', 'o+', 'g')).toEqual([['oo'], ['oo']]);
  });

  it('regexp_matches returns null on no match', () => {
    expect(fn('regexp_matches', 'abc', 'zzz')).toBeNull();
  });

  it('regexp_replace replaces matches', () => {
    expect(fn('regexp_replace', 'foobar', 'o', 'x')).toBe('fxobar');
    expect(fn('regexp_replace', 'foobar', 'o', 'x', 'g')).toBe('fxxbar');
  });

  it('regexp_replace returns null on null/pattern null', () => {
    expect(fn('regexp_replace', null, 'o', 'x')).toBeNull();
    expect(fn('regexp_replace', 'foo', null, 'x')).toBeNull();
  });

  it('regexp_split_to_array splits on a pattern', () => {
    expect(fn('regexp_split_to_array', 'a1b2c', '\\d')).toEqual(['a', 'b', 'c']);
    expect(fn('regexp_split_to_array', null, '\\d')).toBeNull();
  });

  it('regexp_split_to_table returns [] on null', () => {
    expect(fn('regexp_split_to_table', null, '\\d')).toEqual([]);
    expect(fn('regexp_split_to_table', 'a1b', '\\d')).toEqual(['a', 'b']);
  });
});

describe('PgFunctions — encode / md5 / lengths', () => {
  it('char_length / character_length count characters', () => {
    expect(fn('char_length', 'abc')).toBe(3);
    expect(fn('character_length', 'abc')).toBe(3);
    expect(fn('char_length', null)).toBeNull();
  });

  it('length counts characters', () => {
    expect(fn('length', 'abc')).toBe(3);
    expect(fn('length', null)).toBeNull();
  });

  it('octet_length / bit_length count bytes', () => {
    expect(fn('octet_length', 'abc')).toBe(3);
    expect(fn('bit_length', 'abc')).toBe(24);
  });

  it('md5 returns a 32-char hex digest', () => {
    expect(fn('md5', 'abc')).toMatch(/^[0-9a-f]{32}$/);
    expect(fn('md5', null)).toBeNull();
  });
});

describe('PgFunctions — quoting / concat', () => {
  it('quote_ident quotes an identifier', () => {
    expect(fn('quote_ident', 'simple')).toBe('simple');
    expect(fn('quote_ident', 'has space')).toBe('"has space"');
    expect(fn('quote_ident', 'A"B')).toBe('"A""B"');
    expect(fn('quote_ident', null)).toBeNull();
  });

  it('quote_literal quotes a literal', () => {
    expect(fn('quote_literal', "it's")).toBe("'it''s'");
    expect(fn('quote_literal', null)).toBeNull();
  });

  it('quote_nullable returns NULL for null', () => {
    expect(fn('quote_nullable', null)).toBe('NULL');
    expect(fn('quote_nullable', 'x')).toBe("'x'");
  });

  it('concat joins non-null args', () => {
    expect(fn('concat', 'a', null, 'b', 'c')).toBe('abc');
    expect(fn('concat')).toBe('');
  });

  it('concat_ws joins with a separator, skipping nulls', () => {
    expect(fn('concat_ws', ',', 'a', null, 'b')).toBe('a,b');
    expect(fn('concat_ws', null, 'a', 'b')).toBeNull();
  });

  it('format fills %s/%L/%I placeholders', () => {
    expect(fn('format', 'x=%s', 42)).toBe('x=42');
    expect(fn('format', '%s-%s', 'a', 'b')).toBe('a-b');
    expect(fn('format', '%s', null)).toBe('');
  });
});

describe('PgFunctions — case / unistr', () => {
  it('upper / lower change case', () => {
    expect(fn('upper', 'abC')).toBe('ABC');
    expect(fn('lower', 'AbC')).toBe('abc');
    expect(fn('upper', null)).toBeNull();
  });

  it('unistr decodes unicode escapes', () => {
    expect(fn('unistr', '\\u0041')).toBe('A');
    expect(fn('unistr', null)).toBeNull();
  });
});
