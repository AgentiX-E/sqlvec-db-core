import { describe, it, expect, beforeAll } from 'vitest';
import { buildPgFunctions, type PgFunctionMap } from '../system/PgFunctions';

let map: PgFunctionMap;
const fn = (name: string, ...args: unknown[]) => map.get(name)!.fn(...args);

beforeAll(() => { map = buildPgFunctions(); });

describe('PgFunctions — edge branches', () => {
  it('format with percents', () => {
    expect(fn('format', 'Hello %s', 'World')).toBe('Hello World');
  });
  it('format with %I quotes identifier', () => {
    expect(fn('format', 'SELECT * FROM %I', 'tbl')).toBe('SELECT * FROM tbl');
  });
  it('format with null fmt returns null', () => {
    expect(fn('format', null, 'x')).toBeNull();
  });
  it('quote_ident returns identifier as-is for simple names', () => {
    expect(typeof fn('quote_ident', 'tbl')).toBe('string');
  });
  it('quote_literal quotes literals', () => {
    expect(fn('quote_literal', "it's")).toBe("'it''s'");
  });
  it('quote_nullable returns NULL for null', () => {
    expect(fn('quote_nullable', null)).toBe('NULL');
  });
  it('regexp_match with single match', () => {
    expect(fn('regexp_match', 'hello', 'l')).toBe('l');
  });
  it('regexp_split_to_array splits', () => {
    const r = fn('regexp_split_to_array', 'a,b,c', ',');
    expect(r).toEqual(['a', 'b', 'c']);
  });
});
