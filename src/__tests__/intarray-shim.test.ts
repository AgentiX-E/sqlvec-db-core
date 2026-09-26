import { describe, it, expect } from 'vitest';
import {
  uniq,
  sort_asc,
  sort_desc,
  sort,
  idx,
  subarray,
  intset,
  icount,
  push_array,
  push_front_array,
  intarrayContains,
  intarrayContainedBy,
  intarrayOverlap,
  query_int,
  parsePgArray,
  detectIntarrayOperator,
  rewriteIntarrayOperators,
  detectIntarrayFunction,
  rewriteIntarrayFunctions,
  detectIntarray,
  rewriteIntarray,
  INTAARRAY_FUNCTIONS,
  INTAARRAY_FN_MAP,
  _parseQueryExpression,
  _tokenizeQuery,
} from '../query/IntarrayShim';

describe('array element functions', () => {
  it('uniq removes duplicates preserving order', () => {
    expect(uniq([1, 2, 2, 3, 1])).toEqual([1, 2, 3]);
    expect(uniq([])).toEqual([]);
  });

  it('sort_asc / sort_desc sort numerically', () => {
    expect(sort_asc([3, 1, 2])).toEqual([1, 2, 3]);
    expect(sort_desc([3, 1, 2])).toEqual([3, 2, 1]);
    expect(sort_asc([10, 2, 1])).toEqual([1, 2, 10]); // numeric, not lexicographic
  });

  it('sort accepts string, array, and direction', () => {
    expect(sort('{3,1,2}')).toEqual([1, 2, 3]);
    expect(sort('[3,1,2]', 'desc')).toEqual([3, 2, 1]);
    expect(sort([3, 1, 2], 'DESC')).toEqual([3, 2, 1]);
    expect(sort([3, 1, 2])).toEqual([1, 2, 3]);
    expect(sort([3, 1, 2], 'bogus')).toEqual([1, 2, 3]);
    expect(sort(undefined as any)).toEqual([]);
    expect(sort(null as any)).toEqual([]);
  });

  it('idx returns 1-based index or 0', () => {
    expect(idx([10, 20, 30], 20)).toBe(2);
    expect(idx([10, 20, 30], 99)).toBe(0);
    expect(idx([], 1)).toBe(0);
  });

  it('subarray slices from 1-based start', () => {
    expect(subarray([1, 2, 3, 4], 2)).toEqual([2, 3, 4]);
    expect(subarray([1, 2, 3, 4], 2, 2)).toEqual([2, 3]);
    expect(subarray([1, 2, 3, 4], 2, 0)).toEqual([]);
    expect(subarray([1, 2, 3, 4], 99)).toEqual([]);
    expect(subarray([1, 2, 3, 4], 0)).toEqual([1, 2, 3, 4]);
    expect(subarray([], 1)).toEqual([]);
    expect(subarray([1, 2, 3], 2, -1)).toEqual([2, 3]);
  });

  it('intset is an alias for uniq', () => {
    expect(intset([1, 1, 2])).toEqual([1, 2]);
  });

  it('icount counts elements', () => {
    expect(icount([1, 2, 3])).toBe(3);
    expect(icount([])).toBe(0);
  });

  it('push_array / push_front_array concatenate', () => {
    expect(push_array([1, 2], [3, 4])).toEqual([1, 2, 3, 4]);
    expect(push_front_array([1, 2], [3, 4])).toEqual([3, 4, 1, 2]);
  });
});

describe('operator implementations', () => {
  it('intarrayContains', () => {
    expect(intarrayContains([1, 2, 3], [2, 3])).toBe(true);
    expect(intarrayContains([1, 2], [2, 3])).toBe(false);
    expect(intarrayContains([1], [])).toBe(true);
  });

  it('intarrayContainedBy', () => {
    expect(intarrayContainedBy([2, 3], [1, 2, 3])).toBe(true);
    expect(intarrayContainedBy([2, 3], [1, 2])).toBe(false);
    expect(intarrayContainedBy([], [1])).toBe(true);
  });

  it('intarrayOverlap', () => {
    expect(intarrayOverlap([1, 2], [2, 3])).toBe(true);
    expect(intarrayOverlap([1, 2], [3, 4])).toBe(false);
    expect(intarrayOverlap([], [1])).toBe(false);
    expect(intarrayOverlap([1], [])).toBe(false);
  });
});

describe('query_int', () => {
  it('filters by simple value', () => {
    expect(query_int([1, 2, 3], '1')).toEqual([1]);
  });

  it('supports NOT', () => {
    expect(query_int([1, 2, 3], '!1')).toEqual([2, 3]);
  });

  it('supports OR', () => {
    expect(query_int([1, 2, 3], '1 | 3')).toEqual([1, 3]);
  });

  it('supports parentheses and grouping', () => {
    expect(query_int([1, 2, 3], '(1 | 2) & 2')).toEqual([2]);
    expect(query_int([1, 2, 3], '!(1 | 2)')).toEqual([3]);
  });

  it('returns empty for empty query or array', () => {
    expect(query_int([1, 2], '')).toEqual([]);
    expect(query_int([], '1')).toEqual([]);
    expect(query_int([1, 2], '   ')).toEqual([]);
  });

  it('evaluates AND of same value as empty (single value cannot be both)', () => {
    expect(query_int([1, 2, 3], '1 & 2')).toEqual([]);
  });

  it('handles negative numbers in query', () => {
    expect(query_int([-1, 0, 1], '-1 | 1')).toEqual([-1, 1]);
  });

  it('handles bare NOT and standalone dash (no operand)', () => {
    expect(query_int([1, 2], '!')).toEqual([]);
    expect(query_int([1, 2], '-')).toEqual([]);
  });
});

describe('parsePgArray', () => {
  it('parses PG literal, JSON-like, and bare comma-separated', () => {
    expect(parsePgArray('{1,2,3}')).toEqual([1, 2, 3]);
    expect(parsePgArray('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parsePgArray('1,2,3')).toEqual([1, 2, 3]);
  });

  it('handles empty forms', () => {
    expect(parsePgArray('{}')).toEqual([]);
    expect(parsePgArray('[]')).toEqual([]);
    expect(parsePgArray('')).toEqual([]);
    expect(parsePgArray('   ')).toEqual([]);
    expect(parsePgArray('{ }')).toEqual([]);
    expect(parsePgArray('[ ]')).toEqual([]);
  });

  it('coerces non-numeric elements to 0', () => {
    expect(parsePgArray('{1,abc,3}')).toEqual([1, 0, 3]);
  });

  it('handles whitespace and negative numbers', () => {
    expect(parsePgArray('{ 1, -2, 3 }')).toEqual([1, -2, 3]);
  });
});

describe('rewriteIntarrayOperators', () => {
  it('rewrites @>', () => {
    expect(rewriteIntarrayOperators('SELECT col @> ARRAY[1,2] FROM t')).toEqual({
      sql: 'SELECT intarray_contains(col, ARRAY[1,2]) FROM t',
      rewritten: true,
    });
  });

  it('rewrites ARRAY @> ARRAY', () => {
    expect(rewriteIntarrayOperators('SELECT ARRAY[1,2] @> ARRAY[1] FROM t')).toEqual({
      sql: 'SELECT intarray_contains(ARRAY[1,2], ARRAY[1]) FROM t',
      rewritten: true,
    });
  });

  it('rewrites <@', () => {
    expect(rewriteIntarrayOperators('SELECT col <@ ARRAY[1,2] FROM t')).toEqual({
      sql: 'SELECT intarray_contained_by(col, ARRAY[1,2]) FROM t',
      rewritten: true,
    });
  });

  it('rewrites &&', () => {
    expect(rewriteIntarrayOperators('SELECT ARRAY[1] && ARRAY[1,2] FROM t')).toEqual({
      sql: 'SELECT intarray_overlap(ARRAY[1], ARRAY[1,2]) FROM t',
      rewritten: true,
    });
  });

  it('does NOT rewrite inside a string literal', () => {
    expect(rewriteIntarrayOperators("SELECT 'col @> ARRAY[1]' FROM t")).toEqual({
      sql: "SELECT 'col @> ARRAY[1]' FROM t",
      rewritten: false,
    });
  });

  it('does NOT rewrite inside line/block comments', () => {
    expect(rewriteIntarrayOperators('SELECT 1 -- col @> ARRAY[1]').sql).toBe(
      'SELECT 1 -- col @> ARRAY[1]',
    );
    expect(rewriteIntarrayOperators('SELECT 1 /* col @> ARRAY[1] */ FROM t').sql).toBe(
      'SELECT 1 /* col @> ARRAY[1] */ FROM t',
    );
  });

  it('rewrites function-call and dotted lhs', () => {
    expect(rewriteIntarrayOperators('SELECT func(x) @> ARRAY[1] FROM t').sql).toBe(
      'SELECT intarray_contains(func(x), ARRAY[1]) FROM t',
    );
    expect(rewriteIntarrayOperators('SELECT a.b @> ARRAY[1] FROM t').sql).toBe(
      'SELECT intarray_contains(a.b, ARRAY[1]) FROM t',
    );
  });

  it('rewrites quoted/backtick identifiers', () => {
    expect(rewriteIntarrayOperators('SELECT "col" @> ARRAY[1] FROM t').sql).toBe(
      'SELECT intarray_contains("col", ARRAY[1]) FROM t',
    );
    expect(rewriteIntarrayOperators('SELECT `col` @> ARRAY[1] FROM t').sql).toBe(
      'SELECT intarray_contains(`col`, ARRAY[1]) FROM t',
    );
    expect(rewriteIntarrayOperators('SELECT sch."col" @> ARRAY[1] FROM t').sql).toBe(
      'SELECT intarray_contains(sch."col", ARRAY[1]) FROM t',
    );
  });

  it('rewrites multiple operators in one statement', () => {
    expect(
      rewriteIntarrayOperators('SELECT t.col @> ARRAY[1] AND s.x <@ ARRAY[2] FROM t').sql,
    ).toBe(
      'SELECT intarray_contains(t.col, ARRAY[1]) AND intarray_contained_by(s.x, ARRAY[2]) FROM t',
    );
  });

  it('handles ARRAY literal containing a string with a bracket', () => {
    expect(rewriteIntarrayOperators("SELECT ARRAY['a]b'] @> ARRAY[1] FROM t").sql).toBe(
      "SELECT intarray_contains(ARRAY['a]b'], ARRAY[1]) FROM t",
    );
  });

  it('rewrites a parenthesised expression lhs', () => {
    expect(rewriteIntarrayOperators('SELECT (a + b) @> ARRAY[1] FROM t').sql).toBe(
      'SELECT intarray_contains((a + b), ARRAY[1]) FROM t',
    );
  });

  it('rewrites a quoted identifier with doubled-quote escape', () => {
    expect(rewriteIntarrayOperators('SELECT "a""b" @> ARRAY[1] FROM t').sql).toBe(
      'SELECT intarray_contains("a""b", ARRAY[1]) FROM t',
    );
  });

  it('rewrites an identifier with a string-literal-quoted part', () => {
    // A single-quoted string inside a parenthesised lhs must not break scanning.
    expect(rewriteIntarrayOperators("SELECT f(')', g(x)) @> ARRAY[1] FROM t").sql).toBe(
      "SELECT intarray_contains(f(')', g(x)), ARRAY[1]) FROM t",
    );
  });

  it('does not rewrite when rhs is not an ARRAY literal', () => {
    expect(rewriteIntarrayOperators('SELECT a @> b FROM t')).toEqual({
      sql: 'SELECT a @> b FROM t',
      rewritten: false,
    });
    expect(rewriteIntarrayOperators('SELECT a @> FROM t')).toEqual({
      sql: 'SELECT a @> FROM t',
      rewritten: false,
    });
  });

  it('does not rewrite when the ARRAY is unterminated', () => {
    expect(rewriteIntarrayOperators('SELECT a @> ARRAY[1,2 FROM t')).toEqual({
      sql: 'SELECT a @> ARRAY[1,2 FROM t',
      rewritten: false,
    });
  });

  it('does not rewrite an operator with no lhs', () => {
    expect(rewriteIntarrayOperators('@> ARRAY[1]').rewritten).toBe(false);
  });

  it('rewrites an intset/uniq body through embedded array', () => {
    expect(rewriteIntarrayOperators('SELECT ARRAY[1,2,3] @> ARRAY[2,3] FROM t').sql).toBe(
      'SELECT intarray_contains(ARRAY[1,2,3], ARRAY[2,3]) FROM t',
    );
  });

  it('returns rewritten:false for empty/null input', () => {
    expect(rewriteIntarrayOperators('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteIntarrayOperators(undefined as any)).toEqual({
      sql: '',
      rewritten: false,
    });
  });

  it('rewrites a quoted identifier containing a single quote inside', () => {
    expect(rewriteIntarrayOperators("SELECT \"a'b\" @> ARRAY[1] FROM t").sql).toBe(
      "SELECT intarray_contains(\"a'b\", ARRAY[1]) FROM t",
    );
  });

  it('does not rewrite when ARRAY has no opening bracket', () => {
    expect(rewriteIntarrayOperators('SELECT a @> ARRAY FROM t')).toEqual({
      sql: 'SELECT a @> ARRAY FROM t',
      rewritten: false,
    });
  });

  it('does not rewrite when the lhs is a non-identifier token', () => {
    expect(rewriteIntarrayOperators('SELECT a, @> ARRAY[1] FROM t')).toEqual({
      sql: 'SELECT a, @> ARRAY[1] FROM t',
      rewritten: false,
    });
  });

  it('returns rewritten:false when no intarray operator present', () => {
    expect(rewriteIntarrayOperators('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });
});

describe('detectIntarrayOperator', () => {
  it('detects column @> ARRAY form (regression #265)', () => {
    expect(detectIntarrayOperator('SELECT col @> ARRAY[1] FROM t')).toBe(true);
    expect(detectIntarrayOperator('SELECT col <@ ARRAY[1] FROM t')).toBe(true);
    expect(detectIntarrayOperator('SELECT col && ARRAY[1] FROM t')).toBe(true);
  });

  it('detects query_int', () => {
    expect(detectIntarrayOperator("SELECT query_int(a, '1&2') FROM t")).toBe(true);
  });

  it('does NOT detect inside literals/comments', () => {
    expect(detectIntarrayOperator("SELECT 'col @> ARRAY[1]' FROM t")).toBe(false);
    expect(detectIntarrayOperator('SELECT 1 -- col @> ARRAY[1]')).toBe(false);
    expect(detectIntarrayOperator("SELECT 'query_int(a)' FROM t")).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(detectIntarrayOperator('')).toBe(false);
    expect(detectIntarrayOperator(undefined as any)).toBe(false);
  });
});

describe('detectIntarrayFunction', () => {
  it('detects function calls', () => {
    expect(detectIntarrayFunction('SELECT uniq(a) FROM t')).toBe(true);
    expect(detectIntarrayFunction('SELECT public.sort_asc(a) FROM t')).toBe(true);
    expect(detectIntarrayFunction('SELECT 1')).toBe(false);
  });
});

describe('rewriteIntarrayFunctions', () => {
  it('rewrites icount', () => {
    expect(rewriteIntarrayFunctions('SELECT icount(a) FROM t').sql).toBe(
      'SELECT json_array_length(a) FROM t',
    );
  });

  it('rewrites multi-argument functions (idx, subarray)', () => {
    expect(rewriteIntarrayFunctions('SELECT idx(a, b) FROM t').sql).toBe(
      'SELECT COALESCE((SELECT __je_idx."key"+1 FROM json_each(a) AS __je_idx WHERE __je_idx.value = b LIMIT 1), 0) FROM t',
    );
    expect(rewriteIntarrayFunctions('SELECT subarray(a, 2) FROM t').sql).toBe(
      'SELECT (SELECT json_group_array(__je_s2.value ORDER BY __je_s2."key") FROM json_each(a) AS __je_s2 WHERE __je_s2."key" >= (2)-1) FROM t',
    );
  });

  it('returns rewritten:false for empty input', () => {
    expect(rewriteIntarrayFunctions('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteIntarrayFunctions(undefined as any)).toEqual({
      sql: '',
      rewritten: false,
    });
    expect(rewriteIntarrayFunctions('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });
});

describe('detectIntarray / rewriteIntarray (combined)', () => {
  it('detectIntarray catches operators and functions', () => {
    expect(detectIntarray('SELECT col @> ARRAY[1] FROM t')).toBe(true);
    expect(detectIntarray('SELECT uniq(a) FROM t')).toBe(true);
    expect(detectIntarray('SELECT a @> b FROM t')).toBe(true);
    expect(detectIntarray('SELECT a <@ b FROM t')).toBe(true);
    expect(detectIntarray('SELECT a && b FROM t')).toBe(true);
    expect(detectIntarray('SELECT 1')).toBe(false);
    expect(detectIntarray('')).toBe(false);
    expect(detectIntarray(undefined as any)).toBe(false);
  });

  it('rewriteIntarray chains operator then function rewrite', () => {
    const out = rewriteIntarray('SELECT col @> ARRAY[1] FROM t');
    expect(out.sql).toBe('SELECT intarray_contains(col, ARRAY[1]) FROM t');
    expect(out.rewritten).toBe(true);
  });

  it('rewriteIntarray rewrites functions when no operator present', () => {
    const out = rewriteIntarray('SELECT uniq(a) FROM t');
    expect(out.rewritten).toBe(true);
  });
});

describe('catalog metadata', () => {
  it('INTAARRAY_FUNCTIONS lists known functions', () => {
    expect(INTAARRAY_FUNCTIONS.length).toBeGreaterThan(0);
    const names = INTAARRAY_FUNCTIONS.map((f) => f.name);
    expect(names).toContain('uniq');
    expect(names).toContain('idx');
    expect(names).toContain('subarray');
  });

  it('INTAARRAY_FN_MAP dispatches to implementations', () => {
    expect(INTAARRAY_FN_MAP.uniq([1, 1, 2])).toEqual([1, 2]);
    expect(INTAARRAY_FN_MAP.intarray_contains([1, 2], [2])).toBe(true);
    expect(INTAARRAY_FN_MAP.query_int([1, 2, 3], '1')).toEqual([1]);
  });
});

describe('_tokenizeQuery (internal tokenizer)', () => {
  it('tokenizes numbers, negatives, operators, parens', () => {
    expect(_tokenizeQuery('1')).toEqual([{ type: 'number', value: 1 }]);
    expect(_tokenizeQuery('-1')).toEqual([{ type: 'number', value: -1 }]);
    expect(_tokenizeQuery('!1')).toEqual([
      { type: 'op', value: '!' },
      { type: 'number', value: 1 },
    ]);
    expect(_tokenizeQuery('(1|2)')).toEqual([
      { type: 'paren', value: '(' },
      { type: 'number', value: 1 },
      { type: 'op', value: '|' },
      { type: 'number', value: 2 },
      { type: 'paren', value: ')' },
    ]);
  });

  it('drops a standalone dash (invalid number)', () => {
    expect(_tokenizeQuery('-')).toEqual([]);
  });

  it('skips unknown characters', () => {
    expect(_tokenizeQuery('a & 1')).toEqual([
      { type: 'op', value: '&' },
      { type: 'number', value: 1 },
    ]);
  });

  it('returns empty for blank input', () => {
    expect(_tokenizeQuery('')).toEqual([]);
    expect(_tokenizeQuery('   ')).toEqual([]);
  });
});

describe('_parseQueryExpression (internal parser)', () => {
  it('returns null for no tokens', () => {
    expect(_parseQueryExpression('')).toBeNull();
    expect(_parseQueryExpression('   ')).toBeNull();
  });

  it('parses a bare NOT with no operand into a leaf 0', () => {
    expect(_parseQueryExpression('!')).toEqual({
      type: 'unary',
      op: '!',
      operand: { type: 'leaf', value: 0 },
    });
  });

  it('parses parenthesised grouping', () => {
    expect(_parseQueryExpression('(1|2)')).toEqual({
      type: 'binop',
      op: '|',
      left: { type: 'leaf', value: 1 },
      right: { type: 'leaf', value: 2 },
    });
  });

  it('tolerates an unterminated close paren', () => {
    expect(_parseQueryExpression('(1|2')).toEqual({
      type: 'binop',
      op: '|',
      left: { type: 'leaf', value: 1 },
      right: { type: 'leaf', value: 2 },
    });
  });
});
