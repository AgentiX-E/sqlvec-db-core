import { describe, it, expect } from 'vitest';
import {
  detectJsonStdFunc,
  rewriteJsonStdFunc,
} from '../query/JsonStandardFuncShim';

describe('detectJsonStdFunc', () => {
  it('returns false for empty / non-string / blank', () => {
    expect(detectJsonStdFunc('')).toBe(false);
    expect(detectJsonStdFunc('   ')).toBe(false);
    expect(detectJsonStdFunc(null as unknown as string)).toBe(false);
  });

  it('detects the scalar/tuple functions', () => {
    expect(detectJsonStdFunc("SELECT JSON_EXISTS(doc, '$.a') FROM t")).toBe(true);
    expect(detectJsonStdFunc("SELECT JSON_VALUE(doc, '$.a') FROM t")).toBe(true);
    expect(detectJsonStdFunc("SELECT JSON_QUERY(doc, '$.a') FROM t")).toBe(true);
    expect(detectJsonStdFunc('SELECT JSON_SCALAR(doc) FROM t')).toBe(true);
    expect(detectJsonStdFunc('SELECT JSON_SERIALIZE(doc) FROM t')).toBe(true);
  });

  it('detects the JSON_OBJECT / JSON_ARRAY constructors', () => {
    expect(detectJsonStdFunc("SELECT JSON_OBJECT(KEY 'a' VALUE 1) FROM t")).toBe(true);
    expect(detectJsonStdFunc('SELECT JSON_ARRAY(1, 2) FROM t')).toBe(true);
  });

  it('ignores occurrences inside string literals', () => {
    expect(detectJsonStdFunc("SELECT 'JSON_EXISTS(doc, \"$.a\")' FROM t")).toBe(false);
  });

  it('ignores occurrences inside comments', () => {
    expect(detectJsonStdFunc('-- JSON_VALUE(x, y)\nSELECT 1')).toBe(false);
    expect(detectJsonStdFunc('/* JSON_QUERY(a, b) */ SELECT 1')).toBe(false);
  });

  it('ignores occurrences inside dollar-quoted strings', () => {
    expect(detectJsonStdFunc('SELECT $$ JSON_EXISTS(a, b) $$ FROM t')).toBe(false);
    expect(detectJsonStdFunc('SELECT $t$ JSON_VALUE(a, b) $t$ FROM t')).toBe(false);
  });

  it('does not match a longer identifier with the same prefix', () => {
    expect(detectJsonStdFunc('SELECT JSON_EXISTS_foo(x) FROM t')).toBe(false);
  });
});

describe('rewriteJsonStdFunc — scalar/tuple functions', () => {
  it('returns input unchanged for empty / non-string', () => {
    expect(rewriteJsonStdFunc('')).toBe('');
    expect(rewriteJsonStdFunc('   ')).toBe('   ');
  });

  it('rewrites JSON_EXISTS', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_EXISTS(doc, '$.a') FROM t")).toBe(
      "SELECT (json_extract(doc, '$.a') IS NOT NULL) FROM t",
    );
  });

  it('rewrites JSON_VALUE', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_VALUE(doc, '$.name') FROM t")).toBe(
      "SELECT json_extract(doc, '$.name') FROM t",
    );
  });

  it('rewrites JSON_QUERY', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_QUERY(doc, '$.arr') FROM t")).toBe(
      "SELECT json_extract(doc, '$.arr') FROM t",
    );
  });

  it('rewrites JSON_SCALAR', () => {
    expect(rewriteJsonStdFunc('SELECT JSON_SCALAR(doc) FROM t')).toBe(
      "SELECT (CASE WHEN json_type(doc) IN ('array','object') THEN doc ELSE json_extract('{\"val\":'||doc||'}','$.val') END) FROM t",
    );
  });

  it('rewrites JSON_SERIALIZE', () => {
    expect(rewriteJsonStdFunc('SELECT JSON_SERIALIZE(doc) FROM t')).toBe(
      'SELECT CAST(doc AS TEXT) FROM t',
    );
  });

  it('rewrites a lowercase function name', () => {
    expect(rewriteJsonStdFunc("select json_exists(doc, '$.a') FROM t")).toBe(
      "select (json_extract(doc, '$.a') IS NOT NULL) FROM t",
    );
  });

  it('rewrites multiple functions in one statement', () => {
    expect(
      rewriteJsonStdFunc("SELECT JSON_VALUE(doc, '$.a'), JSON_SERIALIZE(x) FROM t"),
    ).toBe("SELECT json_extract(doc, '$.a'), CAST(x AS TEXT) FROM t");
  });
});

describe('rewriteJsonStdFunc — JSON_OBJECT constructor', () => {
  it('rewrites KEY/VALUE pairs', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_OBJECT(KEY 'a' VALUE 1, 'b' VALUE 2) FROM t")).toBe(
      "SELECT json_object('a', 1, 'b', 2) FROM t",
    );
  });

  it('rewrites colon syntax (PG 16)', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_OBJECT('a': 1, 'b': 2) FROM t")).toBe(
      "SELECT json_object('a', 1, 'b', 2) FROM t",
    );
  });

  it('skips a NULL key pair', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_OBJECT(KEY NULL VALUE 1, 'a' VALUE 2) FROM t")).toBe(
      "SELECT json_object('a', 2) FROM t",
    );
  });

  it('ignores an unparseable pair', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_OBJECT(1 + 2) FROM t")).toBe(
      'SELECT json_object() FROM t',
    );
  });

  it('preserves nested JSON_ARRAY in a value', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_OBJECT(KEY 'a' VALUE JSON_ARRAY(1,2)) FROM t")).toBe(
      "SELECT json_object('a', json_array(1,2)) FROM t",
    );
  });
});

describe('rewriteJsonStdFunc — JSON_ARRAY constructor', () => {
  it('rewrites JSON_ARRAY with multiple values', () => {
    expect(rewriteJsonStdFunc('SELECT JSON_ARRAY(1, 2, 3) FROM t')).toBe(
      'SELECT json_array(1, 2, 3) FROM t',
    );
  });

  it('rewrites an empty JSON_ARRAY', () => {
    expect(rewriteJsonStdFunc('SELECT JSON_ARRAY() FROM t')).toBe('SELECT json_array() FROM t');
  });
});

describe('rewriteJsonStdFunc — literal/comment protection (regressions)', () => {
  it('does not rewrite JSON_EXISTS inside a string literal', () => {
    expect(rewriteJsonStdFunc("SELECT 'JSON_EXISTS(doc, \"$.a\")' FROM t")).toBe(
      "SELECT 'JSON_EXISTS(doc, \"$.a\")' FROM t",
    );
  });

  it('does not rewrite JSON_VALUE inside a line comment', () => {
    expect(rewriteJsonStdFunc('-- JSON_VALUE(x, y)\nSELECT 1')).toBe('-- JSON_VALUE(x, y)\nSELECT 1');
  });

  it('does not rewrite JSON_QUERY inside a block comment', () => {
    expect(rewriteJsonStdFunc('/* JSON_QUERY(a, b) */ SELECT 1')).toBe('/* JSON_QUERY(a, b) */ SELECT 1');
  });

  it('does not rewrite JSON_OBJECT inside a string literal', () => {
    expect(rewriteJsonStdFunc("SELECT 'JSON_OBJECT(KEY ''x'' VALUE 1)' FROM t")).toBe(
      "SELECT 'JSON_OBJECT(KEY ''x'' VALUE 1)' FROM t",
    );
  });

  it('does not rewrite JSON_ARRAY inside a dollar-quoted string', () => {
    expect(rewriteJsonStdFunc('SELECT $$ JSON_ARRAY(1,2) $$ FROM t')).toBe(
      'SELECT $$ JSON_ARRAY(1,2) $$ FROM t',
    );
  });

  it('does not rewrite JSON_VALUE inside a tagged dollar-quoted string', () => {
    expect(rewriteJsonStdFunc('SELECT $t$ JSON_VALUE(a, b) $t$ FROM t')).toBe(
      'SELECT $t$ JSON_VALUE(a, b) $t$ FROM t',
    );
  });
});

describe('rewriteJsonStdFunc — nested/edge cases (regressions)', () => {
  it('rewrites JSON_EXISTS with a nested call as the json argument', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_EXISTS(f(a,b), '$.c') FROM t")).toBe(
      "SELECT (json_extract(f(a,b), '$.c') IS NOT NULL) FROM t",
    );
  });

  it('keeps a close paren inside the path literal', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_EXISTS(doc, '$.a)') FROM t")).toBe(
      "SELECT (json_extract(doc, '$.a)') IS NOT NULL) FROM t",
    );
  });

  it('keeps a comma inside the path literal', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_VALUE(json, 'a,b') FROM t")).toBe(
      "SELECT json_extract(json, 'a,b') FROM t",
    );
  });

  it('keeps a doubled quote inside the path literal', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_EXISTS(doc, 'it''s') FROM t")).toBe(
      "SELECT (json_extract(doc, 'it''s') IS NOT NULL) FROM t",
    );
  });
});

describe('rewriteJsonStdFunc — defensive branches', () => {
  it('leaves an unbalanced JSON_EXISTS call untouched', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_EXISTS(doc, '$.a' FROM t")).toBe(
      "SELECT JSON_EXISTS(doc, '$.a' FROM t",
    );
  });

  it('leaves a call with the wrong number of arguments untouched', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_EXISTS(doc, '$.a', 'extra') FROM t")).toBe(
      "SELECT JSON_EXISTS(doc, '$.a', 'extra') FROM t",
    );
  });

  it('leaves a call with an empty argument untouched', () => {
    expect(rewriteJsonStdFunc('SELECT JSON_VALUE( , x) FROM t')).toBe('SELECT JSON_VALUE( , x) FROM t');
  });

  it('leaves an unbalanced JSON_ARRAY untouched', () => {
    expect(rewriteJsonStdFunc('SELECT JSON_ARRAY(1,2 FROM t')).toBe('SELECT JSON_ARRAY(1,2 FROM t');
  });

  it('leaves an unbalanced JSON_OBJECT untouched', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_OBJECT(KEY 'a' VALUE 1 FROM t")).toBe(
      "SELECT JSON_OBJECT(KEY 'a' VALUE 1 FROM t",
    );
  });

  it('leaves a bare function name (no call) unchanged', () => {
    expect(rewriteJsonStdFunc('SELECT JSON_EXISTS FROM t')).toBe('SELECT JSON_EXISTS FROM t');
  });

  it('does not match a longer identifier sharing the prefix', () => {
    expect(rewriteJsonStdFunc('SELECT myJSON_VALUE(x, y) FROM t')).toBe('SELECT myJSON_VALUE(x, y) FROM t');
    expect(rewriteJsonStdFunc('SELECT xJSON_OBJECT(1) FROM t')).toBe('SELECT xJSON_OBJECT(1) FROM t');
  });

  it('skips a literal NULL key in JSON_OBJECT', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_OBJECT(KEY 'null' VALUE 1) FROM t")).toBe(
      'SELECT json_object() FROM t',
    );
  });

  it('drops a trailing comma in JSON_OBJECT', () => {
    expect(rewriteJsonStdFunc("SELECT JSON_OBJECT(KEY 'a' VALUE 1,) FROM t")).toBe(
      "SELECT json_object('a', 1) FROM t",
    );
  });

  it('rewrites nested JSON_OBJECT calls iteratively', () => {
    expect(
      rewriteJsonStdFunc("SELECT JSON_OBJECT(KEY 'a' VALUE JSON_OBJECT(KEY 'b' VALUE 2)) FROM t"),
    ).toBe("SELECT json_object('a', json_object('b', 2)) FROM t");
  });
});
