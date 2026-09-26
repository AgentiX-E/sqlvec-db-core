import { describe, it, expect } from 'vitest';
import { detectJsonTable, rewriteJsonTable } from '../query/JsonTableShim';

describe('detectJsonTable', () => {
  it('returns false for non-string / empty input', () => {
    expect(detectJsonTable('')).toBe(false);
    expect(detectJsonTable('SELECT 1')).toBe(false);
    expect(detectJsonTable("SELECT * FROM t WHERE note = 'json_table(x)'")).toBe(false);
  });

  it('detects a JSON_TABLE call', () => {
    expect(detectJsonTable("SELECT * FROM json_table('[1]', '$[*]' COLUMNS (a int PATH '$')) AS jt")).toBe(true);
  });

  it('detects JSON_TABLE with a doubled single-quote escape in the JSON', () => {
    expect(
      detectJsonTable("SELECT * FROM json_table('[{\"a\":\"it''s\"}]', '$[*]' COLUMNS (a text PATH '$.a')) AS jt"),
    ).toBe(true);
  });
});

describe('rewriteJsonTable', () => {
  it('returns unchanged for non-JSON_TABLE input', () => {
    const r = rewriteJsonTable('SELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
    expect(r.count).toBe(0);
  });

  it('returns unchanged for empty input', () => {
    const r = rewriteJsonTable('');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('');
  });

  it('rewrites a simple flat JSON_TABLE', () => {
    const r = rewriteJsonTable(
      "SELECT jt.* FROM json_table('[{\"a\":1}]', '$[*]' COLUMNS (a int PATH '$.a')) AS jt",
    );
    expect(r.rewritten).toBe(true);
    expect(r.count).toBe(1);
    expect(r.sql).toContain("json_each('[{\"a\":1}]')");
    expect(r.sql).toContain("json_extract(value, '$.a')");
    expect(r.sql).toContain(' AS a');
  });

  it('rewrites multiple columns', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"a\":1,\"b\":2}]', '$[*]' COLUMNS (a int PATH '$.a', b int PATH '$.b')) AS jt",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("json_extract(value, '$.a')");
    expect(r.sql).toContain("json_extract(value, '$.b')");
  });

  it('rewrites multiple JSON_TABLE expressions', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"a\":1}]', '$[*]' COLUMNS (a int PATH '$.a')) x CROSS JOIN json_table('[{\"b\":2}]', '$[*]' COLUMNS (b int PATH '$.b')) y",
    );
    expect(r.count).toBe(2);
    expect(r.sql).toContain(') AS x');
    expect(r.sql).toContain(') AS y');
  });

  it('preserves JSON containing a doubled single-quote escape', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"a\":\"it''s\"}]', '$[*]' COLUMNS (a text PATH '$.a')) AS jt",
    );
    expect(r.sql).toContain("json_each('[{\"a\":\"it''s\"}]')");
  });

  it('handles a JSON string argument containing a closing paren', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"a\":\"x)\"}]', '$[*]' COLUMNS (a text PATH '$.a')) AS jt",
    );
    // The rewrite must not leave trailing fragments or truncated JSON.
    expect(r.sql).toContain("json_each('[{\"a\":\"x)\"}]')");
  });

  it('rewrites an EXISTS column', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"a\":1}]', '$[*]' COLUMNS (a int EXISTS PATH '$.a')) AS jt",
    );
    expect(r.sql).toContain('CASE WHEN json_extract(value');
  });

  it('rewrites an ORDINALITY column', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[1,2]', '$[*]' COLUMNS (n FOR ORDINALITY, v int PATH '$')) AS jt",
    );
    expect(r.sql).toContain('ROW_NUMBER() OVER ()');
  });

  it('applies a DEFAULT ON EMPTY clause', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"a\":null}]', '$[*]' COLUMNS (a int PATH '$.a' DEFAULT 5 ON EMPTY)) AS jt",
    );
    expect(r.sql).toContain('COALESCE');
  });

  it('rewrites a NESTED PATH', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"a\":1,\"items\":[{\"x\":2}]}]', '$[*]' COLUMNS (a int PATH '$.a', NESTED PATH '$.items[*]' COLUMNS (x int PATH '$.x'))) AS jt",
    );
    expect(r.sql).toContain('CROSS JOIN json_each');
  });

  it('rewrites a multi-level [*] iteration path', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"stores\":[{\"books\":[{\"title\":\"t\"}]}]}]', '$[*]' COLUMNS (title text PATH '$.stores[*].books[*].title')) AS jt",
    );
    expect(r.sql).toContain('_lv0');
    expect(r.sql).toContain('_lv1');
  });

  it('does not rewrite json_table inside a string literal', () => {
    const r = rewriteJsonTable("SELECT 'json_table(1,2)' AS lit");
    expect(r.rewritten).toBe(false);
  });

  it('returns an empty-row subquery for a COLUMNS block with no columns', () => {
    const r = rewriteJsonTable("SELECT * FROM json_table('[1]', '$[*]' COLUMNS ()) AS jt");
    expect(r.sql).toContain('(SELECT 1 WHERE 0)');
  });

  it('gracefully returns count 0 for a malformed call missing the comma', () => {
    const r = rewriteJsonTable("SELECT * FROM json_table('[1]' '$[*]' COLUMNS (a int PATH '$')) AS jt");
    expect(r.count).toBe(0);
    expect(r.rewritten).toBe(false);
  });

  it('supports a dollar-quoted JSON string argument', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table($$[{\"a\":1}]$$, '$[*]' COLUMNS (a int PATH '$.a')) AS jt",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('json_each($$[{"a":1}]$$)');
  });

  it('rewrites an EXISTS column with no explicit path to the default path', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"a\":1}]', '$[*]' COLUMNS (a int EXISTS PATH '$.a')) AS jt",
    );
    expect(r.sql).toContain('CASE WHEN');
  });

  it('handles multiple NESTED PATH blocks', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"a\":1,\"i\":[{\"x\":1}],\"j\":[{\"y\":2}]}]', '$[*]' COLUMNS (a int PATH '$.a', NESTED PATH '$.i[*]' COLUMNS (x int PATH '$.x'), NESTED PATH '$.j[*]' COLUMNS (y int PATH '$.y'))) AS jt",
    );
    expect(r.count).toBe(1);
    expect(r.sql).toContain('jt_n0');
    expect(r.sql).toContain('jt_n1');
  });

  it('adjusts a nested bare column path relative to the nested path prefix', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"a\":1,\"i\":[{\"x\":1}]}]', '$[*]' COLUMNS (a int PATH '$.a', NESTED PATH '$.i[*]' COLUMNS (x int PATH 'x'))) AS jt",
    );
    expect(r.sql).toContain("json_extract(value, 'x') AS x");
  });

  it('mix multi-level and single-level column paths', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"s\":[{\"b\":[{\"t\":1}]}]}]', '$[*]' COLUMNS (t text PATH '$.s[*].b[*].t', other text PATH '$.x')) AS jt",
    );
    expect(r.sql).toContain('_lv1');
    expect(r.sql).toContain("json_extract(value, '$.x')");
  });

  it('defaults the alias to jt when none is given', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"a\":1}]', '$[*]' COLUMNS (a int PATH '$.a'))",
    );
    expect(r.sql).toContain(') AS jt');
  });

  it('defaults the alias to jt even for an empty COLUMNS block', () => {
    const r = rewriteJsonTable("SELECT * FROM json_table('[1]', '$[*]' COLUMNS ())");
    expect(r.sql).toContain('(SELECT 1 WHERE 0) AS jt');
  });

  it('mixes a multi-level path with a plain single-level column', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"s\":[{\"b\":[{\"t\":1}]}]}]', '$[*]' COLUMNS (t text PATH '$.s[*].b[*].t', plain PATH '$.x')) AS jt",
    );
    expect(r.sql).toContain('_lv1');
    expect(r.sql).toContain("json_extract(value, '$.x') AS plain");
  });

  it('handles an ordinality column alongside a multi-level path', () => {
    const r = rewriteJsonTable(
      "SELECT * FROM json_table('[{\"s\":[{\"b\":[{\"t\":1}]}]}]', '$[*]' COLUMNS (n FOR ORDINALITY, t PATH '$.s[*].b[*].t')) AS jt",
    );
    expect(r.sql).toContain('ROW_NUMBER() OVER () AS n');
    expect(r.sql).toContain("json_extract(_lv1.value, '$.t') AS t");
  });

  it('gracefully reports count 0 for a call missing the path argument', () => {
    const r = rewriteJsonTable("SELECT * FROM json_table('[1]') AS jt");
    expect(r.count).toBe(0);
  });

  it('gracefully reports count 0 for a call missing COLUMNS', () => {
    const r = rewriteJsonTable("SELECT * FROM json_table('[1]', '$[*]') AS jt");
    expect(r.count).toBe(0);
  });

  it('gracefully reports count 0 for an unclosed COLUMNS block', () => {
    const r = rewriteJsonTable("SELECT * FROM json_table('[1]', '$[*]' COLUMNS (a int PATH '$.a') AS jt");
    expect(r.count).toBe(0);
  });
});
