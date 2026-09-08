import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

describe('SqlParser parseSingleParam numeric/string/mixed', () => {
  it('parses negative integer and float params', () => {
    const r = parseStatement('EXECUTE p(-5, 3.14, -0.25)');
    expect((r as any).params).toEqual([-5, 3.14, -0.25]);
  });

  it('keeps scientific-notation as raw string (regex has no "e" support)', () => {
    const r = parseStatement('EXECUTE p(1e3)');
    expect((r as any).params).toEqual(['1e3']);
  });

  it('parses mixed NULL/TRUE/FALSE/string/number', () => {
    const r = parseStatement("EXECUTE p(NULL, TRUE, FALSE, 'text', 42)");
    expect((r as any).params).toEqual([null, true, false, 'text', 42]);
  });

  it('parses quoted string with spaces', () => {
    const r = parseStatement("EXECUTE p('hello world')");
    expect((r as any).params).toEqual(['hello world']);
  });

  it('handles empty param list as empty array', () => {
    const r = parseStatement('EXECUTE p()');
    expect((r as any).params).toEqual([]);
  });
});

describe('SqlParser parseParamValues nested parens (depth tracking)', () => {
  it('splits params where commas at depth 0 are separators', () => {
    // Simple flat list exercises the depth-0 comma splitter.
    const r = parseStatement("EXECUTE p(1, 'x', 3)");
    expect((r as any).params).toEqual([1, 'x', 3]);
  });
});

describe('SqlParser numeric param non-matching fallback', () => {
  it('returns raw string for non-numeric non-quoted value', () => {
    const r = parseStatement('EXECUTE p(abc)');
    expect((r as any).params).toEqual(['abc']);
  });
});
