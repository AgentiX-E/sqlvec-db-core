import { describe, it, expect } from 'vitest';
import {
  rewriteArraySubscript,
  rewriteUnnestCall,
  rewriteArrayJoin,
  rewriteArrayLength,
  rewriteArrayPosition,
  detectArrayFunction,
} from '../query/ArrayFuncShimAddition';

describe('rewriteArraySubscript', () => {
  it('rewrites a simple subscript', () => {
    expect(rewriteArraySubscript('SELECT arr[1] FROM t')).toBe(
      "SELECT json_extract(arr, '$[0]') FROM t",
    );
  });
  it('rewrites a slice using the start index', () => {
    expect(rewriteArraySubscript('SELECT arr[1:3] FROM t')).toBe(
      "SELECT json_extract(arr, '$[0]') FROM t",
    );
  });
  it('rewrites a multi-dimensional subscript', () => {
    expect(rewriteArraySubscript('SELECT arr[1][2] FROM t')).toBe(
      "SELECT json_extract(arr, '$[0][1]') FROM t",
    );
  });
  it('handles whitespace in slices and chains', () => {
    expect(rewriteArraySubscript('SELECT arr[ 1 : 3 ][2] FROM t')).toBe(
      "SELECT json_extract(arr, '$[0][1]') FROM t",
    );
  });
  it('clamps a zero-based index at 0', () => {
    expect(rewriteArraySubscript('SELECT arr[0] FROM t')).toBe(
      "SELECT json_extract(arr, '$[0]') FROM t",
    );
  });

  it('does not rewrite a subscript inside a string literal', () => {
    expect(rewriteArraySubscript("SELECT 'arr[1]' FROM t")).toBe("SELECT 'arr[1]' FROM t");
  });
  it('does not rewrite a subscript inside a comment', () => {
    expect(rewriteArraySubscript('-- arr[1]\nSELECT 1')).toBe('-- arr[1]\nSELECT 1');
  });
  it('does not rewrite an empty subscript', () => {
    expect(rewriteArraySubscript('SELECT arr[] FROM t')).toBe('SELECT arr[] FROM t');
  });
  it('does not rewrite a non-numeric subscript', () => {
    expect(rewriteArraySubscript('SELECT arr[abc] FROM t')).toBe('SELECT arr[abc] FROM t');
  });
  it('does not rewrite a subscript with no preceding identifier', () => {
    expect(rewriteArraySubscript('SELECT [1] FROM t')).toBe('SELECT [1] FROM t');
  });
  it('returns empty for null / undefined', () => {
    expect(rewriteArraySubscript(null as unknown as string)).toBe('');
    expect(rewriteArraySubscript(undefined as unknown as string)).toBe('');
  });
  it('handles a multi-char identifier', () => {
    expect(rewriteArraySubscript('SELECT abc_def[1] FROM t')).toBe(
      "SELECT json_extract(abc_def, '$[0]') FROM t",
    );
  });
  it('stops a chain at a non-numeric subscript', () => {
    expect(rewriteArraySubscript('SELECT arr[1][abc] FROM t')).toBe(
      "SELECT json_extract(arr, '$[0]')[abc] FROM t",
    );
  });
  it('leaves an unbalanced subscript untouched', () => {
    expect(rewriteArraySubscript('SELECT arr[1 FROM t')).toBe('SELECT arr[1 FROM t');
  });
  it('does not rewrite a non-numeric inner bracket', () => {
    expect(rewriteArraySubscript('SELECT arr[f(1)] FROM t')).toBe('SELECT arr[f(1)] FROM t');
  });
  it('rewrites multiple subscripts in one statement', () => {
    expect(rewriteArraySubscript('SELECT a[1], b[2] FROM t')).toBe(
      "SELECT json_extract(a, '$[0]'), json_extract(b, '$[1]') FROM t",
    );
  });
  it('stops the chain at an unbalanced follow-up bracket', () => {
    expect(rewriteArraySubscript('SELECT arr[1][ FROM t')).toBe(
      "SELECT json_extract(arr, '$[0]')[ FROM t",
    );
  });
});

describe('rewriteUnnestCall', () => {
  it('rewrites unnest to json_each', () => {
    expect(rewriteUnnestCall('SELECT * FROM unnest(arr)')).toBe('SELECT * FROM json_each(arr)');
  });
  it('rewrites multiple unnest calls', () => {
    expect(rewriteUnnestCall('SELECT * FROM unnest(a), unnest(b)')).toBe(
      'SELECT * FROM json_each(a), json_each(b)',
    );
  });
  it('does not rewrite unnest inside a string literal', () => {
    expect(rewriteUnnestCall("SELECT 'unnest(x)' FROM t")).toBe("SELECT 'unnest(x)' FROM t");
  });
  it('leaves an unbalanced unnest untouched', () => {
    expect(rewriteUnnestCall('SELECT * FROM unnest(arr')).toBe('SELECT * FROM unnest(arr');
  });
  it('returns empty for null / undefined', () => {
    expect(rewriteUnnestCall(null as unknown as string)).toBe('');
  });
  it('does not rewrite a bare function name without parens', () => {
    expect(rewriteUnnestCall('SELECT unnest FROM t')).toBe('SELECT unnest FROM t');
    expect(rewriteUnnestCall('SELECT unnestx(a) FROM t')).toBe('SELECT unnestx(a) FROM t');
  });
});

describe('rewriteArrayJoin', () => {
  it('rewrites array_to_string with a delimiter', () => {
    expect(rewriteArrayJoin("SELECT array_to_string(arr, ',') FROM t")).toBe(
      "SELECT (SELECT group_concat(json_each.value, ',') FROM json_each(arr)) FROM t",
    );
  });
  it('ignores a third null_string argument', () => {
    expect(rewriteArrayJoin("SELECT array_to_string(arr, ',', 'NULL') FROM t")).toBe(
      "SELECT (SELECT group_concat(json_each.value, ',') FROM json_each(arr)) FROM t",
    );
  });
  it('handles a nested expression as the array argument', () => {
    expect(rewriteArrayJoin("SELECT array_to_string(f(x, y), ',') FROM t")).toBe(
      "SELECT (SELECT group_concat(json_each.value, ',') FROM json_each(f(x, y))) FROM t",
    );
  });
  it('does not rewrite inside a string literal', () => {
    expect(rewriteArrayJoin("SELECT 'array_to_string(a, b)' FROM t")).toBe(
      "SELECT 'array_to_string(a, b)' FROM t",
    );
  });
  it('leaves an insufficient-argument call untouched', () => {
    expect(rewriteArrayJoin('SELECT array_to_string(arr) FROM t')).toBe(
      'SELECT array_to_string(arr) FROM t',
    );
  });
  it('leaves an unbalanced call untouched', () => {
    expect(rewriteArrayJoin('SELECT array_to_string(arr FROM t')).toBe(
      'SELECT array_to_string(arr FROM t',
    );
  });
  it('rewrites multiple calls in one statement', () => {
    expect(rewriteArrayJoin("SELECT array_to_string(a, ','), array_to_string(b, ';') FROM t")).toBe(
      "SELECT (SELECT group_concat(json_each.value, ',') FROM json_each(a)), (SELECT group_concat(json_each.value, ';') FROM json_each(b)) FROM t",
    );
  });
  it('returns empty for null / undefined', () => {
    expect(rewriteArrayJoin(null as unknown as string)).toBe('');
  });
});

describe('rewriteArrayLength', () => {
  it('rewrites array_length dropping the dimension', () => {
    expect(rewriteArrayLength('SELECT array_length(arr, 1) FROM t')).toBe(
      'SELECT json_array_length(arr) FROM t',
    );
  });
  it('handles a nested array expression', () => {
    expect(rewriteArrayLength('SELECT array_length(f(x), 1) FROM t')).toBe(
      'SELECT json_array_length(f(x)) FROM t',
    );
  });
  it('handles a trailing comma with an empty dimension', () => {
    expect(rewriteArrayLength('SELECT array_length(arr,) FROM t')).toBe(
      'SELECT json_array_length(arr) FROM t',
    );
  });
  it('leaves an unbalanced call untouched', () => {
    expect(rewriteArrayLength('SELECT array_length(arr FROM t')).toBe(
      'SELECT array_length(arr FROM t',
    );
  });
  it('rewrites multiple calls in one statement', () => {
    expect(rewriteArrayLength('SELECT array_length(a, 1), array_length(b, 2) FROM t')).toBe(
      'SELECT json_array_length(a), json_array_length(b) FROM t',
    );
  });
  it('falls back to NULL for an empty argument', () => {
    expect(rewriteArrayLength('SELECT array_length() FROM t')).toBe(
      'SELECT json_array_length(NULL) FROM t',
    );
  });
  it('does not rewrite inside a string literal', () => {
    expect(rewriteArrayLength("SELECT 'array_length(a,1)' FROM t")).toBe(
      "SELECT 'array_length(a,1)' FROM t",
    );
  });
  it('returns empty for null / undefined', () => {
    expect(rewriteArrayLength(undefined as unknown as string)).toBe('');
  });
});

describe('rewriteArrayPosition', () => {
  it('rewrites array_position with a 1-based result', () => {
    expect(rewriteArrayPosition("SELECT array_position(arr, 'foo') FROM t")).toBe(
      "SELECT (SELECT MIN(json_each.key) + 1 FROM json_each(arr) WHERE json_each.value = 'foo') FROM t",
    );
  });
  it('preserves a comma inside the element literal', () => {
    expect(rewriteArrayPosition("SELECT array_position(arr, 'a,b') FROM t")).toBe(
      "SELECT (SELECT MIN(json_each.key) + 1 FROM json_each(arr) WHERE json_each.value = 'a,b') FROM t",
    );
  });
  it('leaves an insufficient-argument call untouched', () => {
    expect(rewriteArrayPosition('SELECT array_position(arr) FROM t')).toBe(
      'SELECT array_position(arr) FROM t',
    );
  });
  it('does not rewrite inside a string literal', () => {
    expect(rewriteArrayPosition("SELECT 'array_position(a, b)' FROM t")).toBe(
      "SELECT 'array_position(a, b)' FROM t",
    );
  });
  it('leaves an unbalanced call untouched', () => {
    expect(rewriteArrayPosition('SELECT array_position(arr, x FROM t')).toBe(
      'SELECT array_position(arr, x FROM t',
    );
  });
  it('rewrites multiple calls in one statement', () => {
    expect(rewriteArrayPosition("SELECT array_position(a, 'x'), array_position(b, 'y') FROM t")).toBe(
      "SELECT (SELECT MIN(json_each.key) + 1 FROM json_each(a) WHERE json_each.value = 'x'), (SELECT MIN(json_each.key) + 1 FROM json_each(b) WHERE json_each.value = 'y') FROM t",
    );
  });
  it('returns empty for null / undefined', () => {
    expect(rewriteArrayPosition(null as unknown as string)).toBe('');
  });
});

describe('detectArrayFunction', () => {
  it('detects and rewrites a mixed statement', () => {
    expect(detectArrayFunction('SELECT arr[1], array_length(arr, 1) FROM t')).toEqual({
      hasArrayFunction: true,
      rewrittenSql: "SELECT json_extract(arr, '$[0]'), json_array_length(arr) FROM t",
    });
  });
  it('returns false when there is nothing to rewrite', () => {
    expect(detectArrayFunction('SELECT 1 FROM t')).toEqual({
      hasArrayFunction: false,
      rewrittenSql: 'SELECT 1 FROM t',
    });
  });
  it('delegates remaining functions to ArrayFuncShim', () => {
    expect(detectArrayFunction('SELECT array_append(a, 1) FROM t')).toEqual({
      hasArrayFunction: true,
      rewrittenSql: "SELECT json_insert(COALESCE(json(a), '[]'), '$[#]', 1) FROM t",
    });
  });
  it('handles null / undefined', () => {
    expect(detectArrayFunction(null as unknown as string)).toEqual({
      hasArrayFunction: false,
      rewrittenSql: '',
    });
  });
});
