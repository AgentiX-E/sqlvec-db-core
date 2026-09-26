import { describe, it, expect } from 'vitest';
import {
  parseHstoreToObject,
  objectToHstoreJson,
  HstoreShim,
  detectHstoreOperator,
  rewriteHstoreOperator,
  detectHstoreKeyOperators,
  rewriteHstoreKeyOperators,
  processHstoreSql,
} from '../query/HstoreShim';

describe('parseHstoreToObject', () => {
  it('parses PG hstore format', () => {
    expect(parseHstoreToObject('"a"=>"1","b"=>"2"')).toEqual({ a: '1', b: '2' });
  });

  it('parses NULL values', () => {
    expect(parseHstoreToObject('"a"=>NULL')).toEqual({ a: null });
    expect(parseHstoreToObject('"a"=>"1","b"=>NULL')).toEqual({ a: '1', b: null });
  });

  it('returns empty object for empty/null input', () => {
    expect(parseHstoreToObject('')).toEqual({});
    expect(parseHstoreToObject(null)).toEqual({});
    expect(parseHstoreToObject(undefined as any)).toEqual({});
    expect(parseHstoreToObject('""=>""')).toEqual({});
  });

  it('parses JSON format', () => {
    expect(parseHstoreToObject('{"a":"1","b":"2"}')).toEqual({ a: '1', b: '2' });
  });

  it('falls back to PG parser on invalid JSON', () => {
    // `{not-json` is not valid JSON, so it is parsed as a bare unquoted
    // PG hstore key (with an empty value).
    expect(parseHstoreToObject('{not-json')).toEqual({ '{not-json': '' });
  });

  it('parses keys and values with escaped quotes', () => {
    expect(parseHstoreToObject('"a\\"b"=>"c\\"d"')).toEqual({ 'a"b': 'c"d' });
  });

  it('parses unquoted keys and values', () => {
    expect(parseHstoreToObject('a=>1,b=>2')).toEqual({ a: '1', b: '2' });
  });

  it('parses quoted values containing => and commas', () => {
    expect(parseHstoreToObject('"a"=>"x=>y,z","b"=>"1"')).toEqual({ a: 'x=>y,z', b: '1' });
  });

  it('handles trailing comma', () => {
    expect(parseHstoreToObject('"a"=>"1",')).toEqual({ a: '1' });
  });

  it('handles unterminated quoted value', () => {
    expect(parseHstoreToObject('"a"=>"unterminated')).toEqual({ a: 'unterminated' });
  });

  it('parses unquoted NULL value', () => {
    expect(parseHstoreToObject('a=>NULL')).toEqual({ a: null });
    expect(parseHstoreToObject('a=>null')).toEqual({ a: null });
  });

  it('handles an unterminated quoted key', () => {
    expect(parseHstoreToObject('"a')).toEqual({ a: '' });
  });

  it('preserves a value that merely looks like NULL but is not', () => {
    expect(parseHstoreToObject('a=>Nil')).toEqual({ a: 'Nil' });
    expect(parseHstoreToObject('a=>nulll')).toEqual({ a: 'nulll' });
  });
});

describe('objectToHstoreJson', () => {
  it('serializes an object', () => {
    expect(objectToHstoreJson({ a: '1', b: null })).toBe('{"a":"1","b":null}');
  });

  it('drops undefined values to null', () => {
    expect(objectToHstoreJson({ a: undefined as any })).toBe('{"a":null}');
  });

  it('skips inherited (non-own) properties', () => {
    const proto = { inherited: 'x' } as Record<string, unknown>;
    const obj = Object.create(proto) as Record<string, string | null>;
    obj.own = 'y';
    expect(objectToHstoreJson(obj)).toBe('{"own":"y"}');
  });
});

describe('HstoreShim class', () => {
  describe('hstoreToJson', () => {
    it('converts PG hstore to JSON', () => {
      expect(HstoreShim.hstoreToJson('"a"=>"1"')).toBe('{"a":"1"}');
    });
    it('passes through JSON', () => {
      expect(HstoreShim.hstoreToJson('{"a":"1"}')).toBe('{"a":"1"}');
    });
  });

  describe('akeys / avals', () => {
    it('returns keys', () => {
      expect(HstoreShim.akeys('"a"=>"1","b"=>"2"')).toEqual(['a', 'b']);
      expect(HstoreShim.akeys('')).toEqual([]);
    });
    it('returns values', () => {
      expect(HstoreShim.avals('"a"=>"1","b"=>NULL')).toEqual(['1', null]);
      expect(HstoreShim.avals('')).toEqual([]);
    });
  });

  describe('each', () => {
    it('returns key-value pairs', () => {
      expect(HstoreShim.each('"a"=>"1","b"=>"2"')).toEqual([
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
      ]);
    });
  });

  describe('exist / defined', () => {
    it('exist returns true even for null values', () => {
      expect(HstoreShim.exist('"a"=>"1"', 'a')).toBe(true);
      expect(HstoreShim.exist('"a"=>"1"', 'b')).toBe(false);
      expect(HstoreShim.exist('"a"=>NULL', 'a')).toBe(true);
    });
    it('defined returns false for null values', () => {
      expect(HstoreShim.defined('"a"=>"1"', 'a')).toBe(true);
      expect(HstoreShim.defined('"a"=>NULL', 'a')).toBe(false);
      expect(HstoreShim.defined('"a"=>"1"', 'b')).toBe(false);
    });
  });

  describe('delete', () => {
    it('removes a key', () => {
      expect(HstoreShim.delete('"a"=>"1","b"=>"2"', 'a')).toBe('{"b":"2"}');
      expect(HstoreShim.delete('"a"=>"1"', 'a')).toBe('{}');
    });
  });

  describe('concat', () => {
    it('merges two hstore values', () => {
      expect(HstoreShim.concat('"a"=>"1"', '"b"=>"2"')).toBe('{"a":"1","b":"2"}');
    });
    it('b overrides a', () => {
      expect(HstoreShim.concat('"a"=>"1"', '"a"=>"new"')).toBe('{"a":"new"}');
    });
  });

  describe('hstoreToMatrix', () => {
    it('returns [key, value] pairs', () => {
      expect(HstoreShim.hstoreToMatrix('"a"=>"1","b"=>"2"')).toEqual([
        ['a', '1'],
        ['b', '2'],
      ]);
    });
  });

  describe('tconvert', () => {
    it('converts JSON to PG hstore literal', () => {
      expect(HstoreShim.tconvert('{"a":"1","b":"2"}')).toBe('"a"=>"1", "b"=>"2"');
    });
    it('handles NULL values', () => {
      expect(HstoreShim.tconvert('{"a":null}')).toBe('"a"=>NULL');
    });
  });

  describe('hstoreExists / hstoreExistsAny / hstoreExistsAll', () => {
    it('hstoreExists works', () => {
      expect(HstoreShim.hstoreExists('"a"=>"1"', 'a')).toBe(true);
      expect(HstoreShim.hstoreExists('"a"=>"1"', 'b')).toBe(false);
    });
    it('hstoreExistsAny accepts array and comma string', () => {
      expect(HstoreShim.hstoreExistsAny('"a"=>"1","b"=>"2"', ['a', 'c'])).toBe(true);
      expect(HstoreShim.hstoreExistsAny('"a"=>"1"', ['x', 'y'])).toBe(false);
      expect(HstoreShim.hstoreExistsAny('"a"=>"1"', 'a,c')).toBe(true);
    });
    it('hstoreExistsAll accepts array and comma string', () => {
      expect(HstoreShim.hstoreExistsAll('"a"=>"1","b"=>"2"', ['a', 'b'])).toBe(true);
      expect(HstoreShim.hstoreExistsAll('"a"=>"1"', ['a', 'b'])).toBe(false);
      expect(HstoreShim.hstoreExistsAll('"a"=>"1"', 'a,b')).toBe(false);
    });
  });

  describe('populateRecord', () => {
    it('returns hstore data as JSON', () => {
      expect(HstoreShim.populateRecord('{"a":"1","b":"2"}')).toBe('{"a":"1","b":"2"}');
    });
    it('merges with a base record', () => {
      expect(HstoreShim.populateRecord('{"b":"2"}', '{"a":"1"}')).toBe('{"a":"1","b":"2"}');
    });
    it('falls back when base is not JSON', () => {
      expect(HstoreShim.populateRecord('{"b":"2"}', 'not-json')).toBe('{"b":"2"}');
    });
    it('returns hstore data when no base record', () => {
      expect(HstoreShim.populateRecord('"a"=>"1"')).toBe('{"a":"1"}');
    });
  });
});

describe('rewriteHstoreOperator (`->`)', () => {
  it('rewrites col -> key', () => {
    expect(rewriteHstoreOperator("SELECT col -> 'a' FROM t")).toEqual({
      sql: "SELECT hstore_get(col, 'a') FROM t",
      rewritten: true,
    });
  });

  it('rewrites qualified name', () => {
    expect(rewriteHstoreOperator("SELECT a.b.c -> 'k' FROM t").sql).toBe(
      "SELECT hstore_get(a.b.c, 'k') FROM t",
    );
  });

  it('rewrites function call lhs', () => {
    expect(rewriteHstoreOperator("SELECT func(x) -> 'k' FROM t").sql).toBe(
      "SELECT hstore_get(func(x), 'k') FROM t",
    );
  });

  it('rewrites quoted identifier lhs', () => {
    expect(rewriteHstoreOperator("SELECT \"col\" -> 'k' FROM t").sql).toBe(
      "SELECT hstore_get(\"col\", 'k') FROM t",
    );
  });

  it('rewrites backtick identifier lhs', () => {
    expect(rewriteHstoreOperator("SELECT `col` -> 'k' FROM t").sql).toBe(
      'SELECT hstore_get(`col`, \'k\') FROM t',
    );
  });

  it('does NOT rewrite ->> JSON text accessor', () => {
    expect(rewriteHstoreOperator("SELECT col ->> 'a' FROM t")).toEqual({
      sql: "SELECT col ->> 'a' FROM t",
      rewritten: false,
    });
  });

  it('does NOT rewrite inside a string literal', () => {
    expect(rewriteHstoreOperator("SELECT 'x -> y' AS s FROM t")).toEqual({
      sql: "SELECT 'x -> y' AS s FROM t",
      rewritten: false,
    });
  });

  it('does NOT rewrite inside line/block comments', () => {
    expect(rewriteHstoreOperator("SELECT 1 -- col -> 'a'\n FROM t").sql).toBe(
      "SELECT 1 -- col -> 'a'\n FROM t",
    );
    expect(rewriteHstoreOperator("SELECT 1 /* col -> 'a' */ FROM t").sql).toBe(
      "SELECT 1 /* col -> 'a' */ FROM t",
    );
  });

  it('preserves escaped quotes in the key', () => {
    expect(rewriteHstoreOperator("SELECT col -> 'a''b' FROM t").sql).toBe(
      "SELECT hstore_get(col, 'a''b') FROM t",
    );
  });

  it('preserves escaped quotes inside a key', () => {
    expect(rewriteHstoreOperator("SELECT col -> 'has '' quote' FROM t").sql).toBe(
      "SELECT hstore_get(col, 'has '' quote') FROM t",
    );
  });

  it('handles a parenthesised expression with a literal closing paren', () => {
    expect(rewriteHstoreOperator("SELECT func(a, ')') -> 'k' FROM t").sql).toBe(
      "SELECT hstore_get(func(a, ')'), 'k') FROM t",
    );
  });

  it('returns rewritten:false for empty input', () => {
    expect(rewriteHstoreOperator('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteHstoreOperator(undefined as any)).toEqual({ sql: '', rewritten: false });
  });

  it('does not rewrite an arrow not followed by a string literal', () => {
    expect(rewriteHstoreOperator('SELECT a -> b FROM t')).toEqual({
      sql: 'SELECT a -> b FROM t',
      rewritten: false,
    });
  });

  it('does not rewrite when the lhs is a string literal', () => {
    // `'x' -> 'k'` is not a valid hstore column reference.
    expect(rewriteHstoreOperator("SELECT 'x' -> 'k' FROM t").rewritten).toBe(false);
  });

  it('does not rewrite an arrow at the start of the input', () => {
    expect(rewriteHstoreOperator("-> 'k'")).toEqual({ sql: "-> 'k'", rewritten: false });
  });

  it('rewrites a deeply nested function-call lhs', () => {
    expect(rewriteHstoreOperator("SELECT f(g(x)) -> 'k' FROM t").sql).toBe(
      "SELECT hstore_get(f(g(x)), 'k') FROM t",
    );
  });

  it('rewrites an identifier with a doubled-quote escape', () => {
    expect(rewriteHstoreOperator("SELECT \"a\"\"b\" -> 'k' FROM t").sql).toBe(
      "SELECT hstore_get(\"a\"\"b\", 'k') FROM t",
    );
    expect(rewriteHstoreOperator("SELECT `a``b` -> 'k' FROM t").sql).toBe(
      "SELECT hstore_get(`a``b`, 'k') FROM t",
    );
  });

  it('rewrites multiple -> operators (triggers the right-to-left sort)', () => {
    expect(rewriteHstoreOperator("SELECT a -> 'x', b -> 'y' FROM t").sql).toBe(
      "SELECT hstore_get(a, 'x'), hstore_get(b, 'y') FROM t",
    );
  });
});

describe('rewriteHstoreKeyOperators (`?`/`?|`/`?&`)', () => {
  it('rewrites ? operator', () => {
    expect(rewriteHstoreKeyOperators("SELECT col ? 'a' FROM t")).toEqual({
      sql: "SELECT hstore_exists(col, 'a') FROM t",
      rewritten: true,
    });
  });

  it('rewrites ?| operator', () => {
    expect(rewriteHstoreKeyOperators("SELECT col ?| ARRAY['a','b'] FROM t").sql).toBe(
      "SELECT hstore_exists_any(col, 'a,b') FROM t",
    );
  });

  it('rewrites ?& operator', () => {
    expect(rewriteHstoreKeyOperators("SELECT col ?& ARRAY['a','b'] FROM t").sql).toBe(
      "SELECT hstore_exists_all(col, 'a,b') FROM t",
    );
  });

  it('does NOT rewrite inside a string literal', () => {
    expect(rewriteHstoreKeyOperators("SELECT 'col ? x' FROM t")).toEqual({
      sql: "SELECT 'col ? x' FROM t",
      rewritten: false,
    });
  });

  it('does NOT rewrite inside comments', () => {
    expect(rewriteHstoreKeyOperators("SELECT 1 -- col ? 'a'\n FROM t").sql).toBe(
      "SELECT 1 -- col ? 'a'\n FROM t",
    );
    expect(rewriteHstoreKeyOperators("SELECT 1 /* col ? 'a' */ FROM t").sql).toBe(
      "SELECT 1 /* col ? 'a' */ FROM t",
    );
  });

  it('preserves escaped quotes', () => {
    expect(rewriteHstoreKeyOperators("SELECT col ? 'it''s' FROM t").sql).toBe(
      "SELECT hstore_exists(col, 'it''s') FROM t",
    );
  });

  it('rewrites qualified name and function-call lhs', () => {
    expect(rewriteHstoreKeyOperators("SELECT a.b ? 'k' FROM t").sql).toBe(
      "SELECT hstore_exists(a.b, 'k') FROM t",
    );
    expect(rewriteHstoreKeyOperators("SELECT func(x) ? 'k' FROM t").sql).toBe(
      "SELECT hstore_exists(func(x), 'k') FROM t",
    );
  });

  it('rewrites multiple operators in one statement', () => {
    expect(rewriteHstoreKeyOperators("SELECT data ? 'a' AND data ? 'b' FROM t").sql).toBe(
      "SELECT hstore_exists(data, 'a') AND hstore_exists(data, 'b') FROM t",
    );
  });

  it('returns rewritten:false for empty input', () => {
    expect(rewriteHstoreKeyOperators('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteHstoreKeyOperators(undefined as any)).toEqual({
      sql: '',
      rewritten: false,
    });
  });

  it('does not rewrite a bare ? placeholder without a string rhs', () => {
    expect(rewriteHstoreKeyOperators('SELECT a ? b FROM t')).toEqual({
      sql: 'SELECT a ? b FROM t',
      rewritten: false,
    });
  });

  it('does not rewrite ?| without an ARRAY rhs', () => {
    expect(rewriteHstoreKeyOperators("SELECT a ?| 'x' FROM t")).toEqual({
      sql: "SELECT a ?| 'x' FROM t",
      rewritten: false,
    });
  });

  it('does not rewrite ?& ARRAY with no closing bracket (malformed)', () => {
    expect(rewriteHstoreKeyOperators("SELECT a ?& ARRAY['x' FROM t").rewritten).toBe(false);
  });

  it('does not rewrite ? ARRAY[...] (only ? uses a plain string)', () => {
    expect(rewriteHstoreKeyOperators("SELECT a ? ARRAY['x'] FROM t").rewritten).toBe(false);
  });

  it('does not rewrite ? at the start of input', () => {
    expect(rewriteHstoreKeyOperators("? 'k'").rewritten).toBe(false);
  });

  it('does not rewrite ?| ARRAY without an opening bracket', () => {
    expect(rewriteHstoreKeyOperators('SELECT a ?| ARRAY FROM t').rewritten).toBe(false);
  });

  it('rewrites a deeply nested function-call lhs', () => {
    expect(rewriteHstoreKeyOperators("SELECT f(g(x), ')') ? 'k' FROM t").sql).toBe(
      "SELECT hstore_exists(f(g(x), ')'), 'k') FROM t",
    );
  });

  it('rewrites a quoted identifier lhs', () => {
    expect(rewriteHstoreKeyOperators("SELECT \"col\" ? 'k' FROM t").sql).toBe(
      "SELECT hstore_exists(\"col\", 'k') FROM t",
    );
  });
});

describe('detectHstoreOperator / detectHstoreKeyOperators', () => {
  it('detects -> operator', () => {
    expect(detectHstoreOperator("SELECT col -> 'k' FROM t")).toBe(true);
    expect(detectHstoreOperator('SELECT 1')).toBe(false);
    expect(detectHstoreOperator('')).toBe(false);
    expect(detectHstoreOperator("SELECT 'a -> b' FROM t")).toBe(false);
    expect(detectHstoreOperator("SELECT col ->> 'k' FROM t")).toBe(false);
    expect(detectHstoreOperator("-> 'k'")).toBe(false);
    expect(detectHstoreOperator('SELECT a -> b FROM t')).toBe(false);
  });

  it('detects key operators', () => {
    expect(detectHstoreKeyOperators("SELECT col ? 'a' FROM t")).toBe(true);
    expect(detectHstoreKeyOperators("SELECT col ?| ARRAY['a'] FROM t")).toBe(true);
    expect(detectHstoreKeyOperators("SELECT col ?& ARRAY['a'] FROM t")).toBe(true);
    expect(detectHstoreKeyOperators("SELECT 'col ? x' FROM t")).toBe(false);
    expect(detectHstoreKeyOperators('SELECT 1')).toBe(false);
    expect(detectHstoreKeyOperators('')).toBe(false);
  });
});

describe('processHstoreSql', () => {
  it('applies both operator rewrites in one pass', () => {
    expect(processHstoreSql("SELECT col -> 'a', col ? 'b', col ?| ARRAY['c','d'] FROM t")).toBe(
      "SELECT hstore_get(col, 'a'), hstore_exists(col, 'b'), hstore_exists_any(col, 'c,d') FROM t",
    );
  });
});
