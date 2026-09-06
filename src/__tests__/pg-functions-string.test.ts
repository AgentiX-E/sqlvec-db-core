/**
 * PgFunctions unit tests — string section.
 *
 * Exercises PostgreSQL string functions registered by `buildPgFunctions`.
 * Focuses on 1-based indexing (substr/left/right), padding, trim, and
 * regexp edge cases where SQL semantics commonly diverge from JS defaults.
 */
import { describe, it, expect } from 'vitest';
import { buildPgFunctions } from '../system/PgFunctions';

const map = buildPgFunctions();
const call = (name: string, ...args: any[]) => map.get(name)!.fn(...args);

describe('string — upper / lower / initcap', () => {
  it('changes case', () => {
    expect(call('upper', 'Hello')).toBe('HELLO');
    expect(call('lower', 'Hello')).toBe('hello');
  });

  it('initcap capitalizes the first letter of each word', () => {
    expect(call('initcap', 'hello world')).toBe('Hello World');
  });
});

describe('string — length / char_length / octet_length / bit_length', () => {
  it('computes character length', () => {
    expect(call('length', 'hello')).toBe(5);
    expect(call('char_length', 'hello')).toBe(5);
    expect(call('character_length', 'hello')).toBe(5);
  });

  it('computes octet and bit length', () => {
    expect(call('octet_length', 'abc')).toBe(3);
    expect(call('bit_length', 'abc')).toBe(24); // 3 bytes * 8 bits
  });

  it('returns null length for null input', () => {
    expect(call('length', null)).toBeNull();
  });
});

describe('string — substr / substring (1-based indexing)', () => {
  it('extracts a substring with 1-based start', () => {
    expect(call('substr', 'hello', 1, 3)).toBe('hel');
    expect(call('substr', 'hello', 2)).toBe('ello');
  });

  it('handles substring alias', () => {
    expect(call('substring', 'hello', 2, 3)).toBe('ell');
  });
});

describe('string — left / right / reverse', () => {
  it('extracts from the left and right', () => {
    expect(call('left', 'hello', 2)).toBe('he');
    expect(call('right', 'hello', 3)).toBe('llo');
  });

  it('reverses a string', () => {
    expect(call('reverse', 'hello')).toBe('olleh');
  });
});

describe('string — lpad / rpad', () => {
  it('pads on the right with a default space', () => {
    expect(call('rpad', 'hi', 4)).toBe('hi  ');
  });

  it('pads on the left with a specified fill', () => {
    expect(call('lpad', '7', 3, '0')).toBe('007');
  });

  it('truncates when the string is longer than the target length', () => {
    expect(call('rpad', 'hello', 3)).toBe('hel');
  });
});

describe('string — trim / ltrim / rtrim / btrim', () => {
  it('trims whitespace by default', () => {
    expect(call('trim', '  hi  ')).toBe('hi');
    expect(call('ltrim', '  hi  ')).toBe('hi  ');
    expect(call('rtrim', '  hi  ')).toBe('  hi');
  });

  it('trims specific characters', () => {
    expect(call('btrim', 'xxhixx', 'x')).toBe('hi');
  });
});

describe('string — replace / translate / split_part', () => {
  it('replaces all occurrences', () => {
    expect(call('replace', 'a-b-c', '-', '_')).toBe('a_b_c');
  });

  it('splits on a delimiter and returns the nth field (1-based)', () => {
    expect(call('split_part', 'a,b,c', ',', 2)).toBe('b');
    expect(call('split_part', 'a,b,c', ',', 5)).toBe('');
  });
});

describe('string — concat / concat_ws', () => {
  it('concatenates strings', () => {
    expect(call('concat', 'a', 'b', 'c')).toBe('abc');
  });

  it('concat_ws joins with a separator skipping nulls', () => {
    expect(call('concat_ws', ',', 'a', null, 'b')).toBe('a,b');
  });
});

describe('string — strpos / position', () => {
  it('returns the 1-based position of a substring', () => {
    expect(call('strpos', 'hello', 'll')).toBe(3);
    expect(call('position', 'lo', 'hello')).toBe(4);
  });

  it('returns 0 when not found', () => {
    expect(call('strpos', 'hello', 'zz')).toBe(0);
  });
});
