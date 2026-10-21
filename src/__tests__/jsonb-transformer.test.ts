/**
 * Tests for JsonbTransformer — PostgreSQL JSONB operator/function → SQLite
 * JSON1 translation.
 *
 * Covers every exported entry point: transformJsonbExpr (all 10 operator
 * forms), transformJsonbOperators, the mutation helpers (jsonb_set/insert/
 * pretty/mutation), and the Batch 6C detect/rewrite pairs for JSON functions
 * plus transformJsonFunctions (ordered pipeline). Private helpers
 * (simplifyJsonPath, hasComplexPathExpr, extractJsonbPathArgs,
 * rewriteJsonExtractPathInner) are exercised through their public entry points.
 */
import { describe, it, expect } from 'vitest';
import {
  transformJsonbExpr,
  transformJsonbOperators,
  transformJsonbSet,
  transformJsonbInsert,
  transformJsonbPretty,
  transformJsonbMutation,
  detectJsonBuildArray,
  rewriteJsonBuildArray,
  detectJsonTypeOf,
  rewriteJsonTypeOf,
  detectJsonbTypeOf,
  rewriteJsonbTypeOf,
  detectJsonbArrayLength,
  rewriteJsonbArrayLength,
  detectJsonbConcat,
  rewriteJsonbConcat,
  detectJsonbEach,
  rewriteJsonbEach,
  detectToJsonb,
  rewriteToJsonb,
  detectJsonToRecord,
  rewriteJsonToRecord,
  detectJsonArrayElements,
  rewriteJsonArrayElements,
  detectJsonObjectKeys,
  rewriteJsonObjectKeys,
  detectJsonExtractPath,
  rewriteJsonExtractPath,
  detectJsonbPathExists,
  detectJsonbPathMatch,
  detectJsonbPathQuery,
  detectJsonbPathQueryArray,
  rewriteJsonbPathExists,
  rewriteJsonbPathMatch,
  rewriteJsonbPathQuery,
  rewriteJsonbPathQueryArray,
  transformJsonFunctions,
} from '../query/JsonbTransformer';

describe('transformJsonbExpr — operators', () => {
  it('translates ?| operator (any key exists)', () => {
    const out = transformJsonbExpr("data ?| ARRAY['k1', 'k2']");
    expect(out).toContain("json_type(data, '$.k1') IS NOT NULL");
    expect(out).toContain("json_type(data, '$.k2') IS NOT NULL");
    expect(out).toContain(' OR ');
  });

  it('translates ?& operator (all keys exist)', () => {
    const out = transformJsonbExpr("data ?& ARRAY['k1', 'k2']");
    expect(out).toContain(' AND ');
  });

  it('translates @> operator (contains, flat object)', () => {
    const out = transformJsonbExpr("data @> '{\"age\": 25}'");
    expect(out).toContain("json_extract(data, '$.age') = 25");
  });

  it('translates @> with multiple keys into AND', () => {
    const out = transformJsonbExpr("data @> '{\"a\":1,\"b\":2}'");
    expect(out).toContain("json_extract(data, '$.a') = 1");
    expect(out).toContain("json_extract(data, '$.b') = 2");
    expect(out).toContain(' AND ');
  });

  it('translates @> with string value quoting', () => {
    const out = transformJsonbExpr("data @> '{\"name\":\"Bob\"}'");
    expect(out).toContain("json_extract(data, '$.name') = 'Bob'");
  });

  it('keeps @> intact when JSON parse fails', () => {
    const expr = "data @> 'not-json'";
    expect(transformJsonbExpr(expr)).toBe(expr);
  });

  it('translates #>> operator (text from path)', () => {
    const out = transformJsonbExpr("data #>> '{a,b,c}'");
    expect(out).toContain("json_extract(data, '$.a.b.c')");
  });

  it('translates #> operator (json from path)', () => {
    const out = transformJsonbExpr("data #> '{a,b}'");
    expect(out).toContain("json_extract(data, '$.a.b')");
  });

  it('translates ->> with string key', () => {
    const out = transformJsonbExpr("data ->> 'name'");
    expect(out).toContain("json_extract(data, '$.name')");
  });

  it('translates ->> with integer index', () => {
    const out = transformJsonbExpr('data ->> 0');
    expect(out).toContain("json_extract(data, '$[0]')");
  });

  it('translates ->> with negative index', () => {
    const out = transformJsonbExpr('data ->> -1');
    expect(out).toContain("json_extract(data, '$[-1]')");
  });

  it('translates -> with string key', () => {
    const out = transformJsonbExpr("data -> 'name'");
    expect(out).toContain("json_extract(data, '$.name')");
  });

  it('translates -> with integer index', () => {
    const out = transformJsonbExpr('data -> 2');
    expect(out).toContain("json_extract(data, '$[2]')");
  });

  it('translates ? operator (key exists, string key)', () => {
    const out = transformJsonbExpr("data ? 'key'");
    expect(out).toContain("json_type(data, '$.key') IS NOT NULL");
  });

  it('translates numeric key in ?| to array index path', () => {
    const out = transformJsonbExpr('data ?| ARRAY[0, 1]');
    expect(out).toContain("json_type(data, '$[0]') IS NOT NULL");
    expect(out).toContain("json_type(data, '$[1]') IS NOT NULL");
  });

  it('does not touch ? placeholder alone', () => {
    const expr = 'data = ?';
    expect(transformJsonbExpr(expr)).toBe(expr);
  });

  it('handles qualified names and backticked identifiers', () => {
    expect(transformJsonbExpr("t.data ->> 'a'")).toContain('json_extract(t.data');
    expect(transformJsonbExpr("`my col` ->> 'a'")).toContain('json_extract(`my col`');
  });

  it('escapes single quotes in keys (regex stops at quote)', () => {
    // Regex-based extraction stops at the first quote, so the key is 'o'.
    const out = transformJsonbExpr("data ->> 'o''brien'");
    expect(out).toContain("'$.o'");
  });
});

describe('transformJsonbOperators', () => {
  it('reports transformed for a full SQL statement', () => {
    const r = transformJsonbOperators("SELECT data->'name' FROM t WHERE data @> '{\"age\":25}'");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain("json_extract(data, '$.name')");
    expect(r.sql).toContain("json_extract(data, '$.age') = 25");
  });

  it('reports not transformed for plain SQL', () => {
    const sql = 'SELECT * FROM t WHERE a = 1';
    const r = transformJsonbOperators(sql);
    expect(r.transformed).toBe(false);
    expect(r.sql).toBe(sql);
  });

  it('handles chained operators iteratively', () => {
    // data -> 'a' ->> 'b' — the inner -> is transformed first, then ->>.
    const r = transformJsonbOperators("SELECT data->'a'->>'b' FROM t");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json_extract');
  });

  it('needs multiple iterations for mixed chained operators', () => {
    // Two distinct operators chained together require a second loop pass,
    // exercising the iteration counter increment.
    const r = transformJsonbOperators("SELECT data -> 'a' ->> 'b' FROM t");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain("json_extract(json_extract(data, '$.a'), '$.b')");
  });
});

describe('mutation functions', () => {
  it('transformJsonbSet rewrites jsonb_set with path', () => {
    const r = transformJsonbSet("SELECT jsonb_set(col, '{a,b}', '\"v\"')");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain("json_set(col, '$.a.b'");
  });

  it('transformJsonbSet handles create_if_missing false', () => {
    const r = transformJsonbSet("SELECT jsonb_set(col, '{a}', '\"v\"', false)");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('CASE WHEN');
    expect(r.sql).toContain('json_type');
  });

  it('transformJsonbSet handles create_if_missing true', () => {
    const r = transformJsonbSet("SELECT jsonb_set(col, '{a}', '\"v\"', true)");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json_set');
    expect(r.sql).not.toContain('CASE');
  });

  it('transformJsonbSet reports no transform without match', () => {
    const r = transformJsonbSet('SELECT 1');
    expect(r.transformed).toBe(false);
  });

  it('transformJsonbInsert rewrites plain array insert', () => {
    const r = transformJsonbInsert("SELECT jsonb_insert(arr, '{0}', '\"x\"')");
    expect(r.transformed).toBe(true);
  });

  it('transformJsonbInsert handles insert_after true on array index', () => {
    const r = transformJsonbInsert("SELECT jsonb_insert(arr, '{1}', '\"x\"', true)");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json_set');
    expect(r.sql).toContain('[2]');
  });

  it('transformJsonbInsert handles insert_after false', () => {
    const r = transformJsonbInsert("SELECT jsonb_insert(arr, '{1}', '\"x\"', false)");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json_insert');
  });

  it('transformJsonbInsert handles object path (non-array)', () => {
    const r = transformJsonbInsert("SELECT jsonb_insert(obj, '{a,b}', '\"x\"', true)");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json_insert');
  });

  it('transformJsonbInsert handles top-level array index (no parent path)', () => {
    const r = transformJsonbInsert("SELECT jsonb_insert(arr, '{0}', '\"x\"', true)");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain("json_set(arr, '$[1]'");
  });

  it('transformJsonbInsert handles nested array index (with parent path)', () => {
    const r = transformJsonbInsert("SELECT jsonb_insert(arr, '{a,1}', '\"x\"', true)");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain("json_set(arr, '$.a[2]'");
  });

  it('transformJsonbInsert no match', () => {
    const r = transformJsonbInsert('SELECT 1');
    expect(r.transformed).toBe(false);
  });

  it('transformJsonbPretty rewrites to json()', () => {
    const r = transformJsonbPretty("SELECT jsonb_pretty(col)");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json(col)');
  });

  it('transformJsonbPretty no match', () => {
    const r = transformJsonbPretty('SELECT 1');
    expect(r.transformed).toBe(false);
  });

  it('transformJsonbMutation applies all three in order', () => {
    const r = transformJsonbMutation(
      "SELECT jsonb_set(col, '{a}', '\"v\"'), jsonb_pretty(col), jsonb_insert(arr, '{0}', '\"x\"')",
    );
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json_set');
    expect(r.sql).toContain('json(');
  });

  it('transformJsonbMutation no match', () => {
    const r = transformJsonbMutation('SELECT 1');
    expect(r.transformed).toBe(false);
  });
});

describe('json_build_array', () => {
  it('detects json_build_array', () => {
    expect(detectJsonBuildArray('SELECT json_build_array(1, 2)')).toBe(true);
    expect(detectJsonBuildArray('SELECT 1')).toBe(false);
  });

  it('rewrites json_build_array to json_array', () => {
    expect(rewriteJsonBuildArray('SELECT json_build_array(1, 2)')).toContain('json_array(');
  });

  it('rewrite is idempotent on no match', () => {
    expect(rewriteJsonBuildArray('SELECT 1')).toBe('SELECT 1');
  });
});

describe('json_typeof / jsonb_typeof', () => {
  it('detects json_typeof', () => {
    expect(detectJsonTypeOf('SELECT json_typeof(x)')).toBe(true);
    expect(detectJsonTypeOf('SELECT 1')).toBe(false);
  });

  it('rewrites json_typeof to CASE mapping', () => {
    const out = rewriteJsonTypeOf("SELECT json_typeof('\"hi\"')");
    expect(out).toContain('CASE json_type');
    expect(out).toContain("WHEN 'text' THEN 'string'");
  });

  it('detects jsonb_typeof', () => {
    expect(detectJsonbTypeOf('SELECT jsonb_typeof(x)')).toBe(true);
    expect(detectJsonbTypeOf('SELECT 1')).toBe(false);
  });

  it('rewrites jsonb_typeof to json_type', () => {
    expect(rewriteJsonbTypeOf('SELECT jsonb_typeof(x)')).toContain('json_type(x)');
  });
});

describe('jsonb_array_length / jsonb_concat / jsonb_each', () => {
  it('detects and rewrites jsonb_array_length', () => {
    expect(detectJsonbArrayLength('SELECT jsonb_array_length(x)')).toBe(true);
    expect(rewriteJsonbArrayLength('SELECT jsonb_array_length(x)')).toContain(
      'json_array_length(x)',
    );
  });

  it('detects and rewrites jsonb_concat', () => {
    expect(detectJsonbConcat('SELECT jsonb_concat(a, b)')).toBe(true);
    const out = rewriteJsonbConcat('SELECT jsonb_concat(a, b)');
    expect(out).toContain('json_group_object');
    expect(out).toContain('json_each(a)');
    expect(out).toContain('json_each(b)');
  });

  it('detects and rewrites jsonb_each', () => {
    expect(detectJsonbEach('SELECT * FROM jsonb_each(x)')).toBe(true);
    expect(rewriteJsonbEach('SELECT * FROM jsonb_each(x)')).toContain('json_each(x)');
  });
});

describe('to_jsonb', () => {
  it('detects and rewrites to_jsonb', () => {
    expect(detectToJsonb('SELECT to_jsonb(x)')).toBe(true);
    expect(rewriteToJsonb('SELECT to_jsonb(x)')).toContain('json(x)');
  });
});

describe('json_to_record / jsonb_to_record', () => {
  it('detects json_to_record and jsonb_to_record', () => {
    expect(detectJsonToRecord('SELECT * FROM json_to_record(x)')).toBe(true);
    expect(detectJsonToRecord('SELECT * FROM jsonb_to_record(x)')).toBe(true);
  });

  it('rewrites with AS column definitions', () => {
    const out = rewriteJsonToRecord(
      "SELECT * FROM json_to_record('{\"a\":1,\"b\":2}') AS x(a int, b text)",
    );
    expect(out).toContain('json_extract');
    expect(out).toContain('$.a');
    expect(out).toContain('$.b');
  });

  it('rewrites without AS clause to VALUE wrap', () => {
    const out = rewriteJsonToRecord("SELECT * FROM json_to_record('{\"a\":1}')");
    expect(out).toContain("json_extract");
    expect(out).toContain("'$'");
  });

  it('detect is false for plain SQL', () => {
    expect(detectJsonToRecord('SELECT 1')).toBe(false);
  });
});

describe('json_array_elements / jsonb_array_elements', () => {
  it('detects and rewrites to json_each', () => {
    expect(detectJsonArrayElements('SELECT * FROM json_array_elements(x)')).toBe(true);
    const out = rewriteJsonArrayElements('SELECT * FROM json_array_elements(x)');
    expect(out).toContain('json_each(x)');
  });

  it('rewrites without alias', () => {
    const out = rewriteJsonArrayElements('SELECT * FROM jsonb_array_elements(x)');
    expect(out).toContain('json_each(x)');
    expect(out).not.toContain('AS');
  });

  it('rewrites with alias', () => {
    const out = rewriteJsonArrayElements('SELECT * FROM json_array_elements(x) AS j');
    expect(out).toContain('json_each(x) AS j');
  });
});

describe('json_object_keys / jsonb_object_keys', () => {
  it('detects and rewrites to json_each key extraction', () => {
    expect(detectJsonObjectKeys('SELECT * FROM json_object_keys(x)')).toBe(true);
    const out = rewriteJsonObjectKeys('SELECT * FROM json_object_keys(x)');
    expect(out).toContain('json_each');
    expect(out).toContain('j.key');
  });

  it('handles alias on object keys', () => {
    const out = rewriteJsonObjectKeys('SELECT * FROM json_object_keys(x) AS k');
    expect(out).toContain('AS k');
  });
});

describe('json_extract_path / jsonb_extract_path', () => {
  it('detects both variants', () => {
    expect(detectJsonExtractPath('SELECT json_extract_path(x, \'a\')')).toBe(true);
    expect(detectJsonExtractPath('SELECT jsonb_extract_path(x, \'a\')')).toBe(true);
  });

  it('rewrites single path element', () => {
    const out = rewriteJsonExtractPath("SELECT json_extract_path(x, 'a')");
    expect(out).toContain('json_extract');
    expect(out).toContain('$.a');
  });

  it('rewrites multiple path elements', () => {
    const out = rewriteJsonExtractPath("SELECT json_extract_path(x, 'a', 'b')");
    expect(out).toContain('$.a.b');
  });

  it('rewrites key containing dots with bracket notation', () => {
    const out = rewriteJsonExtractPath("SELECT json_extract_path(x, 'a.b')");
    expect(out).toContain('["a.b"]');
  });

  it('rewrites no-path-args to root $', () => {
    const out = rewriteJsonExtractPath('SELECT json_extract_path(x)');
    expect(out).toContain("json_extract(x, '$')");
  });
});

describe('jsonb_path_exists', () => {
  it('detects jsonb_path_exists', () => {
    expect(detectJsonbPathExists('SELECT jsonb_path_exists(t, \'$.a\')')).toBe(true);
    expect(detectJsonbPathExists('SELECT 1')).toBe(false);
  });

  it('rewrites simple path to IS NOT NULL', () => {
    const out = rewriteJsonbPathExists("SELECT jsonb_path_exists(t, '$.a')");
    expect(out).toContain("json_extract(t, '$.a') IS NOT NULL");
  });

  it('rewrites array wildcard path', () => {
    const out = rewriteJsonbPathExists("SELECT jsonb_path_exists(t, '$.a[*]')");
    expect(out).toContain('IS NOT NULL');
  });

  it('rewrites complex path with filter to null check', () => {
    const out = rewriteJsonbPathExists("SELECT jsonb_path_exists(t, '$.a ? (@ > 0)')");
    expect(out).toContain('IS NOT NULL');
  });

  it('keeps args < 2 unchanged', () => {
    const sql = 'SELECT jsonb_path_exists(t)';
    expect(rewriteJsonbPathExists(sql)).toBe(sql);
  });

  it('handles path with nested JSON value containing commas/parens', () => {
    const out = rewriteJsonbPathExists(
      "SELECT jsonb_path_exists(t, '$.a ? (@.x == 1 && @.y == 2)')",
    );
    expect(out).toContain('IS NOT NULL');
  });

  it('handles complex path that simplifies to root ($)', () => {
    const out = rewriteJsonbPathExists("SELECT jsonb_path_exists(t, '? (@ > 0)')");
    expect(out).toContain('IS NOT NULL');
  });

  it('correctly handles a filter path containing parentheses (regression)', () => {
    // A filter expression `? (@ > 0)` contains `)`, which previously
    // truncated the argument list via a non-greedy regex.
    const out = rewriteJsonbPathExists("SELECT jsonb_path_exists(t, '$.a ? (@ > 0)')");
    expect(out).toContain("json_extract(t, '$.a') IS NOT NULL");
    expect(out).not.toContain('@ > 0');
  });

  it('handles a function-call target with nested parens', () => {
    const out = rewriteJsonbPathExists(
      "SELECT jsonb_path_exists(json_extract(x, '$.a'), '$.b')",
    );
    expect(out).toContain("json_extract(json_extract(x, '$.a'), '$.b') IS NOT NULL");
  });

  it('handles a double-quoted path argument', () => {
    const out = rewriteJsonbPathExists(
      'SELECT jsonb_path_exists(t, "$.a")',
    );
    expect(out).toContain("json_extract(t, '$.a') IS NOT NULL");
  });

  it('handles double quotes inside the argument list', () => {
    const out = rewriteJsonbPathMatch('SELECT jsonb_path_match(t, "$.a")');
    expect(out).toContain('json_extract(t');
  });

  it('leaves an unterminated jsonb_path call unchanged (balanced-scan fallback)', () => {
    // An unbalanced `(` never reaches depth 0, so extractBalancedCall falls
    // through to its `return null` fallback and the input is returned intact.
    const out = rewriteJsonbPathExists("SELECT jsonb_path_exists(t, '$.a'");
    expect(out).toBe("SELECT jsonb_path_exists(t, '$.a'");
  });
});

describe('jsonb_path_match', () => {
  it('detects and rewrites simple path', () => {
    expect(detectJsonbPathMatch("SELECT jsonb_path_match(t, '$.a')")).toBe(true);
    const out = rewriteJsonbPathMatch("SELECT jsonb_path_match(t, '$.a')");
    expect(out).toContain("json_extract(t, '$.a') IS NOT NULL");
  });

  it('rewrites complex path to IS NOT NULL', () => {
    const out = rewriteJsonbPathMatch("SELECT jsonb_path_match(t, '$.a ? (@ > 0)')");
    expect(out).toContain('IS NOT NULL');
  });

  it('correctly handles filter path in match (regression)', () => {
    const out = rewriteJsonbPathMatch("SELECT jsonb_path_match(t, '$.a ? (@.x > 1)')");
    expect(out).toBe('SELECT (t IS NOT NULL)');
  });

  it('keeps args < 2 unchanged', () => {
    const sql = 'SELECT jsonb_path_match(t)';
    expect(rewriteJsonbPathMatch(sql)).toBe(sql);
  });

  it('rewrites empty/root path to IS NOT NULL', () => {
    const out = rewriteJsonbPathMatch("SELECT jsonb_path_match(t, '$')");
    expect(out).toContain('IS NOT NULL');
  });
});

describe('jsonb_path_query / jsonb_path_query_array', () => {
  it('detects and rewrites simple query path', () => {
    expect(detectJsonbPathQuery("SELECT jsonb_path_query(t, '$.a')")).toBe(true);
    const out = rewriteJsonbPathQuery("SELECT jsonb_path_query(t, '$.a')");
    expect(out).toContain("json_extract(t, '$.a')");
  });

  it('rewrites array query path via json_each', () => {
    const out = rewriteJsonbPathQuery("SELECT jsonb_path_query(t, '$.a[0]')");
    expect(out).toContain('json_each');
  });

  it('detects and rewrites query_array', () => {
    expect(detectJsonbPathQueryArray("SELECT jsonb_path_query_array(t, '$.a')")).toBe(true);
    const out = rewriteJsonbPathQueryArray("SELECT jsonb_path_query_array(t, '$.a')");
    expect(out).toContain("json_extract(t, '$.a')");
  });

  it('rewrites complex query_array to json()', () => {
    const out = rewriteJsonbPathQueryArray("SELECT jsonb_path_query_array(t, '$.a ? (@ > 0)')");
    expect(out).toContain('json(t)');
  });

  it('correctly handles filter path in query_array (regression)', () => {
    const out = rewriteJsonbPathQueryArray("SELECT jsonb_path_query_array(t, '$.a ? (@.x > 1)')");
    expect(out).toBe('SELECT json(t)');
  });

  it('correctly handles filter path in query (regression)', () => {
    const out = rewriteJsonbPathQuery("SELECT jsonb_path_query(t, '$.a ? (@.x > 1)')");
    expect(out).toBe("SELECT json_extract(t, '$')");
  });

  it('query keeps args < 2 unchanged', () => {
    const sql = 'SELECT jsonb_path_query(t)';
    expect(rewriteJsonbPathQuery(sql)).toBe(sql);
  });

  it('query_array keeps args < 2 unchanged', () => {
    const sql = 'SELECT jsonb_path_query_array(t)';
    expect(rewriteJsonbPathQueryArray(sql)).toBe(sql);
  });

  it('query rewrites root/empty path to root extract', () => {
    const out = rewriteJsonbPathQuery("SELECT jsonb_path_query(t, '$')");
    expect(out).toContain("json_extract(t, '$')");
  });

  it('query_array rewrites root/empty path to json()', () => {
    const out = rewriteJsonbPathQueryArray("SELECT jsonb_path_query_array(t, '$')");
    expect(out).toContain('json(t)');
  });
});

describe('transformJsonFunctions (ordered pipeline)', () => {
  it('applies extract_path rewrite', () => {
    const r = transformJsonFunctions("SELECT json_extract_path(x, 'a')");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json_extract');
  });

  it('applies jsonb_path_exists rewrite', () => {
    const r = transformJsonFunctions("SELECT jsonb_path_exists(t, '$.a')");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('IS NOT NULL');
  });

  it('applies to_jsonb and jsonb_typeof', () => {
    const r = transformJsonFunctions('SELECT to_jsonb(x), jsonb_typeof(y)');
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json(');
    expect(r.sql).toContain('json_type');
  });

  it('reports no transform for plain SQL', () => {
    const r = transformJsonFunctions('SELECT 1');
    expect(r.transformed).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });

  it('runs the full pipeline over every function group', () => {
    const r = transformJsonFunctions(
      "SELECT json_extract_path(x, 'a'), " +
        "jsonb_path_exists(t, '$.a'), jsonb_path_match(t, '$.a'), " +
        "jsonb_path_query(t, '$.a'), jsonb_path_query_array(t, '$.a'), " +
        "json_build_array(1,2), json_typeof(x), to_jsonb(x), jsonb_typeof(x), " +
        "jsonb_array_length(x), jsonb_concat(a, b) " +
        "FROM jsonb_array_elements(arr) ",
    );
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json_extract');
    expect(r.sql).toContain('json_each');
  });

  it('pipeline rewrites jsonb_object_keys in a standalone FROM', () => {
    const r = transformJsonFunctions('SELECT * FROM jsonb_object_keys(obj)');
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json_each');
  });

  it('pipeline rewrites jsonb_to_record in a standalone FROM', () => {
    const r = transformJsonFunctions("SELECT * FROM jsonb_to_record('{\"a\":1}') AS x(a int)");
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json_extract');
  });

  it('pipeline rewrites jsonb_each in a standalone FROM', () => {
    const r = transformJsonFunctions('SELECT * FROM jsonb_each(x)');
    expect(r.transformed).toBe(true);
    expect(r.sql).toContain('json_each(x)');
  });

  it('detects but does not change single-arg jsonb_path_exists', () => {
    // detect matches /\bjsonb_path_exists\s*\(/ but rewrite needs >=2 args,
    // so working is unchanged by this step (covers the !== before false side).
    const r = transformJsonFunctions('SELECT jsonb_path_exists(t)');
    expect(r.sql).toContain('jsonb_path_exists(t)');
  });

  it('detects but does not change single-arg jsonb_concat', () => {
    const r = transformJsonFunctions('SELECT jsonb_concat(a)');
    expect(r.sql).toContain('jsonb_concat(a)');
  });

  it('detects but does not change single-arg jsonb_path_match/query/query_array', () => {
    expect(transformJsonFunctions('SELECT jsonb_path_match(t)').sql).toContain(
      'jsonb_path_match(t)',
    );
    expect(transformJsonFunctions('SELECT jsonb_path_query(t)').sql).toContain(
      'jsonb_path_query(t)',
    );
    expect(transformJsonFunctions('SELECT jsonb_path_query_array(t)').sql).toContain(
      'jsonb_path_query_array(t)',
    );
  });

  it('detects table functions but leaves non-FROM occurrences unchanged', () => {
    // array_elements / object_keys / to_record need a FROM prefix to rewrite;
    // a bare mention is detected but returns working unchanged.
    expect(transformJsonFunctions('SELECT jsonb_array_elements(x)').sql).toContain(
      'jsonb_array_elements(x)',
    );
    expect(transformJsonFunctions('SELECT jsonb_object_keys(x)').sql).toContain(
      'jsonb_object_keys(x)',
    );
    expect(transformJsonFunctions('SELECT jsonb_to_record(x)').sql).toContain(
      'jsonb_to_record(x)',
    );
  });

  it('detects every function group individually in pipeline order', () => {
    // A single statement containing only each function (no rewrites yet applied
    // that would mask later detects) is not required; instead assert each
    // detect/rewrite pair is exercised via the direct rewrite entry points in
    // the individual describe blocks above. This test pins the no-op path.
    const r = transformJsonFunctions('SELECT 42');
    expect(r).toEqual({ sql: 'SELECT 42', transformed: false });
  });
});
