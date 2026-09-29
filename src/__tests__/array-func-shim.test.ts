import { describe, it, expect } from 'vitest';
import { detectArrayFunc, rewriteArrayFunc } from '../query/ArrayFuncShim';

describe('detectArrayFunc', () => {
  it('returns false for empty / non-string / blank', () => {
    expect(detectArrayFunc('')).toBe(false);
    expect(detectArrayFunc('   ')).toBe(false);
    expect(detectArrayFunc(null as unknown as string)).toBe(false);
    expect(detectArrayFunc(undefined as unknown as string)).toBe(false);
  });

  it('detects each supported array function', () => {
    for (const fn of [
      'array_append',
      'array_cat',
      'array_fill',
      'array_length',
      'array_position',
      'array_prepend',
      'array_remove',
      'unnest',
    ]) {
      expect(detectArrayFunc(`SELECT ${fn}(x) FROM t`)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(detectArrayFunc('SELECT ARRAY_APPEND(x, 1)')).toBe(true);
    expect(detectArrayFunc('SELECT UnNest(x)')).toBe(true);
  });

  it('does not match a partial prefix (no word boundary)', () => {
    expect(detectArrayFunc('SELECT my_array_append(x, 1)')).toBe(false);
    expect(detectArrayFunc('SELECT array_appendx(x, 1)')).toBe(false);
  });

  it('does not detect a function name inside a string literal', () => {
    expect(detectArrayFunc("SELECT 'array_append(1,2)' FROM t")).toBe(false);
  });

  it('does not detect a function name inside a comment', () => {
    expect(detectArrayFunc('-- array_length(a,1)\nSELECT 1')).toBe(false);
    expect(detectArrayFunc('/* unnest(x) */ SELECT 1')).toBe(false);
  });

  it('does not detect non-array SQL', () => {
    expect(detectArrayFunc('SELECT 1')).toBe(false);
    expect(detectArrayFunc('SELECT coalesce(a, b)')).toBe(false);
  });
});

describe('rewriteArrayFunc', () => {
  it('returns unchanged for empty / non-string / blank', () => {
    expect(rewriteArrayFunc('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteArrayFunc(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteArrayFunc('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites array_append', () => {
    const r = rewriteArrayFunc('SELECT array_append(arr, 42) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe("SELECT json_insert(COALESCE(json(arr), '[]'), '$[#]', 42) FROM t");
  });

  it('rewrites array_cat', () => {
    const r = rewriteArrayFunc('SELECT array_cat(a, b) FROM t');
    expect(r.sql).toBe("SELECT json_patch(COALESCE(json(a), '[]'), COALESCE(json(b), '[]')) FROM t");
  });

  it('rewrites array_remove', () => {
    expect(rewriteArrayFunc('SELECT array_remove(arr, x) FROM t').sql).toBe(
      "SELECT COALESCE(json(arr), '[]') FROM t",
    );
  });

  it('rewrites array_position', () => {
    expect(rewriteArrayFunc('SELECT array_position(arr, x) FROM t').sql).toBe(
      'SELECT CASE WHEN json(arr) IS NOT NULL THEN 1 END FROM t',
    );
  });

  it('rewrites array_length (dropping the dim argument)', () => {
    expect(rewriteArrayFunc('SELECT array_length(arr, 1) FROM t').sql).toBe(
      'SELECT json_array_length(json(arr)) FROM t',
    );
  });

  it('rewrites array_prepend (swapping elem/arr order)', () => {
    expect(rewriteArrayFunc('SELECT array_prepend(x, arr) FROM t').sql).toBe(
      "SELECT json_insert(COALESCE(json(arr), '[]'), '$[0]', x) FROM t",
    );
  });

  it('rewrites unnest', () => {
    expect(rewriteArrayFunc('SELECT unnest(arr) FROM t').sql).toBe(
      "SELECT json_extract(json(arr), '$[0]') FROM t",
    );
  });

  it('rewrites array_fill (dropping the dims argument)', () => {
    expect(rewriteArrayFunc('SELECT array_fill(0, ARRAY[3]) FROM t').sql).toBe(
      'SELECT json_array(json(0)) FROM t',
    );
  });

  it('rewrites multiple calls in one SQL', () => {
    const r = rewriteArrayFunc('SELECT array_length(arr, 1), unnest(arr2) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe("SELECT json_array_length(json(arr)), json_extract(json(arr2), '$[0]') FROM t");
  });

  it('preserves a function name inside a string literal', () => {
    expect(rewriteArrayFunc("SELECT 'array_append(1,2)' FROM t").rewritten).toBe(false);
  });

  it('preserves a function name inside a line comment', () => {
    expect(rewriteArrayFunc('-- array_length(a,1)\nSELECT 1').rewritten).toBe(false);
  });

  it('preserves a function name inside a block comment', () => {
    expect(rewriteArrayFunc('/* unnest(x) */ SELECT 1').rewritten).toBe(false);
  });

  it('keeps a comma inside a string literal argument intact', () => {
    // Regression #355: 'a,b' must remain a single argument.
    expect(rewriteArrayFunc("SELECT array_append(arr, 'a,b') FROM t").sql).toBe(
      "SELECT json_insert(COALESCE(json(arr), '[]'), '$[#]', 'a,b') FROM t",
    );
  });

  it('keeps a paren inside a string literal argument intact', () => {
    expect(rewriteArrayFunc("SELECT array_append(arr, 'a)b') FROM t").sql).toBe(
      "SELECT json_insert(COALESCE(json(arr), '[]'), '$[#]', 'a)b') FROM t",
    );
  });

  it('handles nested function calls in arguments', () => {
    expect(rewriteArrayFunc("SELECT array_append(arr, f('a,b')) FROM t").sql).toBe(
      "SELECT json_insert(COALESCE(json(arr), '[]'), '$[#]', f('a,b')) FROM t",
    );
  });

  it('handles a double-quoted identifier with a comma', () => {
    expect(rewriteArrayFunc('SELECT array_append("weird,name", 42) FROM t').sql).toBe(
      "SELECT json_insert(COALESCE(json(\"weird,name\"), '[]'), '$[#]', 42) FROM t",
    );
  });

  it('rewrites a real call while leaving a string-literal mention untouched', () => {
    const r = rewriteArrayFunc("SELECT array_append(arr, 'x'), 'unnest(y)' FROM t");
    expect(r.sql).toBe("SELECT json_insert(COALESCE(json(arr), '[]'), '$[#]', 'x'), 'unnest(y)' FROM t");
  });

  it('skips a call with an unmatched parenthesis', () => {
    expect(rewriteArrayFunc('SELECT array_append(arr, 42 FROM t').rewritten).toBe(false);
  });

  it('skips an insufficient-argument call (returns null from rewriter)', () => {
    // array_append needs 2 args; a single-arg call is preserved.
    expect(rewriteArrayFunc('SELECT array_append(arr) FROM t').rewritten).toBe(false);
  });

  it('preserves every rewriter when its arguments are insufficient', () => {
    // Each rewriter guards a minimum arity; a too-short call is left untouched
    // (returns null) rather than producing invalid SQL.
    expect(rewriteArrayFunc('SELECT array_append(a) FROM t').rewritten).toBe(false);
    expect(rewriteArrayFunc('SELECT array_cat(a) FROM t').rewritten).toBe(false);
    expect(rewriteArrayFunc('SELECT array_remove() FROM t').rewritten).toBe(false);
    expect(rewriteArrayFunc('SELECT array_position() FROM t').rewritten).toBe(false);
    expect(rewriteArrayFunc('SELECT array_length() FROM t').rewritten).toBe(false);
    expect(rewriteArrayFunc('SELECT array_prepend(a) FROM t').rewritten).toBe(false);
    expect(rewriteArrayFunc('SELECT unnest() FROM t').rewritten).toBe(false);
    expect(rewriteArrayFunc('SELECT array_fill() FROM t').rewritten).toBe(false);
  });

  it('splits a trailing empty argument away', () => {
    // A trailing comma yields no extra empty arg; the call is preserved because
    // array_append then only sees a single argument.
    expect(rewriteArrayFunc('SELECT array_append(arr,) FROM t').rewritten).toBe(false);
  });
});
