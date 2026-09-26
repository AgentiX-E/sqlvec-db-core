import { describe, it, expect } from 'vitest';
import {
  _getSqliteCastType,
  _applyOnClause,
  _buildColumnExtract,
  _escapeJsonPath,
  _hasWildcardIteration,
  _extractIterationBase,
  _parseIterationPath,
  _buildIterationFromClause,
  _hasMultiLevelIteration,
  _readQuotedLiteral,
  _parseColumns,
  _rewriteSingleJsonTable,
} from '../query/JsonTableShim';
describe('_getSqliteCastType', () => {
  it('returns empty for blank type', () => {
    expect(_getSqliteCastType('')).toBe('');
  });

  it('maps integer family', () => {
    for (const t of ['int', 'integer', 'int4', 'int8', 'bigint', 'smallint', 'serial', 'bigserial']) {
      expect(_getSqliteCastType(t)).toBe('INTEGER');
    }
  });

  it('maps real family', () => {
    for (const t of ['real', 'float', 'float4', 'float8', 'double', 'numeric', 'decimal']) {
      expect(_getSqliteCastType(t)).toBe('REAL');
    }
  });

  it('maps boolean to INTEGER', () => {
    expect(_getSqliteCastType('boolean')).toBe('INTEGER');
    expect(_getSqliteCastType('bool')).toBe('INTEGER');
  });

  it('maps text family', () => {
    for (const t of ['text', 'varchar', 'char', 'character varying', 'name', 'json', 'jsonb']) {
      expect(_getSqliteCastType(t)).toBe('TEXT');
    }
  });

  it('strips parenthesised size and lowercases', () => {
    expect(_getSqliteCastType('varchar(100)')).toBe('TEXT');
  });

  it('returns empty for unknown type', () => {
    expect(_getSqliteCastType('uuid')).toBe('');
  });
});

describe('_applyOnClause', () => {
  it('returns extract unchanged for empty clause', () => {
    expect(_applyOnClause('', 'E')).toBe('E');
  });

  it('returns unchanged for NULL ON *', () => {
    for (const c of ['NULL ON ERROR', 'NULL ON EMPTY', 'NULL ON NULL']) {
      expect(_applyOnClause(c, 'E')).toBe('E');
    }
  });

  it('returns unchanged for ERROR ON * (best effort fallback)', () => {
    for (const c of ['ERROR ON ERROR', 'ERROR ON EMPTY', 'ERROR ON NULL']) {
      expect(_applyOnClause(c, 'E')).toBe('E');
    }
  });

  it('wraps DEFAULT ... ON * in COALESCE', () => {
    expect(_applyOnClause('DEFAULT 0 ON EMPTY', 'E')).toBe('COALESCE(E, 0)');
    expect(_applyOnClause("DEFAULT 'x' ON EMPTY", 'E')).toBe("COALESCE(E, 'x')");
  });

  it('keeps extraction for unknown clause', () => {
    expect(_applyOnClause('FOO BAR', 'E')).toBe('E');
  });
});

describe('_escapeJsonPath', () => {
  it('returns root paths unchanged', () => {
    expect(_escapeJsonPath('')).toBe('');
    expect(_escapeJsonPath('$')).toBe('$');
    expect(_escapeJsonPath('$[*]')).toBe('$[*]');
  });

  it('returns standard dotted paths unchanged', () => {
    expect(_escapeJsonPath('$.a')).toBe('$.a');
    expect(_escapeJsonPath('$.a.b.c')).toBe('$.a.b.c');
    expect(_escapeJsonPath('$.items[0].name')).toBe('$.items[0].name');
  });

  it('returns already-quoted property names unchanged', () => {
    expect(_escapeJsonPath('$."n"')).toBe('$."n"');
    expect(_escapeJsonPath('$."a b"')).toBe('$."a b"');
  });

  it('quotes segments with special characters', () => {
    expect(_escapeJsonPath('$.a b')).toBe('$."a b"');
  });
});

describe('_buildColumnExtract', () => {
  it('builds ordinality column', () => {
    expect(_buildColumnExtract({ name: 'n', type: '', path: '', kind: 'ordinality', onClause: '' }))
      .toBe('ROW_NUMBER() OVER ()');
  });

  it('builds exists column', () => {
    expect(_buildColumnExtract({ name: 'x', type: '', path: '$.a', kind: 'exists', onClause: '' }))
      .toContain('CASE WHEN json_extract(value,');
  });

  it('builds regular column with cast', () => {
    expect(_buildColumnExtract({ name: 'a', type: 'int', path: '$.a', kind: 'regular', onClause: '' }))
      .toContain('CAST(json_extract(value, \'$.a\') AS INTEGER)');
  });

  it('falls back to a default path for a regular column with no path', () => {
    expect(_buildColumnExtract({ name: 'r', type: '', path: '', kind: 'regular', onClause: '' }))
      .toBe('json_extract(value, \'$."r"\')');
  });

  it('falls back to a default path for a nested column with no path', () => {
    expect(_buildColumnExtract({ name: 'n', type: '', path: '', kind: 'nested', onClause: '' }))
      .toBe('json_extract(value, \'$."n"\')');
  });

  it('falls back to $.dummy for an exists column with no path', () => {
    expect(_buildColumnExtract({ name: 'x', type: '', path: '', kind: 'exists', onClause: '' }))
      .toContain("$.dummy");
  });

  it('returns plain extraction for a regular column with unknown type', () => {
    expect(_buildColumnExtract({ name: 'u', type: 'uuid', path: '$.u', kind: 'regular', onClause: '' }))
      .toBe("json_extract(value, '$.u')");
  });
});

describe('_hasWildcardIteration / _extractIterationBase', () => {
  it('detects wildcard iteration', () => {
    expect(_hasWildcardIteration('$.stores[*]')).toBe(true);
    expect(_hasWildcardIteration('$.a')).toBe(false);
  });

  it('extracts base before wildcard', () => {
    expect(_extractIterationBase('$.stores[*].books[*].title')).toBe('$.stores');
    expect(_extractIterationBase('$.a')).toBe('$.a');
  });
});

describe('_parseIterationPath', () => {
  it('parses single-level path', () => {
    const r = _parseIterationPath('$.items[*].name');
    expect(r.segments).toEqual(['items', 'name']);
    expect(r.finalKey).toBe('name');
  });

  it('parses multi-level path', () => {
    const r = _parseIterationPath('$.stores[*].books[*].title');
    expect(r.segments).toEqual(['stores', 'books', 'title']);
    expect(r.finalKey).toBe('title');
  });

  it('parses an array-index path with no dot segment', () => {
    const r = _parseIterationPath('$[0]');
    expect(r.finalKey).toBe('[0]');
  });

  it('handles an empty path with empty segments', () => {
    expect(_parseIterationPath('').segments).toEqual([]);
    expect(_parseIterationPath('$').segments).toEqual([]);
  });
});

describe('_buildIterationFromClause', () => {
  it('builds a single-level json_each for a non-iterative key', () => {
    const from = _buildIterationFromClause('[{"a":1}]', '$.a', 'base');
    expect(from).toContain('json_each');
  });

  it('builds a multi-level cross-join chain', () => {
    const from = _buildIterationFromClause('[{"s":[]}]', '$.stores[*].books[*].title', 'base');
    expect(from).toContain('CROSS JOIN json_each');
    expect(from).toContain('_lv0');
  });
});

describe('_hasMultiLevelIteration', () => {
  it('returns true for nested paths', () => {
    expect(_hasMultiLevelIteration({ hasNestedPaths: true, columns: [] } as any)).toBe(true);
  });

  it('returns true for a column with two wildcards', () => {
    const col = { name: 'x', type: '', path: '$.a[*].b[*]', kind: 'regular' as const, onClause: '' };
    expect(_hasMultiLevelIteration({ hasNestedPaths: false, columns: [col] } as any)).toBe(true);
  });

  it('returns false otherwise', () => {
    const col = { name: 'x', type: '', path: '$.a', kind: 'regular' as const, onClause: '' };
    expect(_hasMultiLevelIteration({ hasNestedPaths: false, columns: [col] } as any)).toBe(false);
  });
});

describe('_readQuotedLiteral', () => {
  it('reads a single-quoted literal', () => {
    const r = _readQuotedLiteral("'abc', path", 0);
    expect(r!.raw).toBe("'abc'");
  });

  it('reads a single-quoted literal with doubled-quote escape', () => {
    const r = _readQuotedLiteral("'it''s', path", 0);
    expect(r!.raw).toBe("'it''s'");
  });

  it('reads a single-quoted literal with backslash escape', () => {
    const r = _readQuotedLiteral("'a\\'b', path", 0);
    expect(r!.raw).toBe("'a\\'b'");
  });

  it('reads a dollar-quoted literal', () => {
    const r = _readQuotedLiteral("$$abc(def$$, path", 0);
    expect(r!.raw).toBe('$$abc(def$$');
  });

  it('returns null for a non-string opener', () => {
    expect(_readQuotedLiteral('123, path', 0)).toBeNull();
  });

  it('returns null for an unterminated single-quoted literal', () => {
    expect(_readQuotedLiteral("'abc", 0)).toBeNull();
  });

  it('treats an unterminated dollar-quoted literal as running to end of input', () => {
    // skipSqlLiteral returns len for an unterminated dollar-quote, so the
    // whole remaining text is captured as the literal.
    const r = _readQuotedLiteral('$$abc', 0);
    expect(r!.raw).toBe('$$abc');
  });
});

describe('_parseColumns', () => {
  it('parses a regular column', () => {
    const { columns } = _parseColumns("a int PATH '$.a'");
    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({ name: 'a', type: 'int', path: '$.a', kind: 'regular' });
  });

  it('parses a column with no explicit type', () => {
    const { columns } = _parseColumns("a PATH '$.a'");
    expect(columns[0]).toMatchObject({ name: 'a', type: '', path: '$.a' });
  });

  it('parses an ordinality column', () => {
    const { columns } = _parseColumns('n FOR ORDINALITY, a int PATH \'$.a\'');
    expect(columns.some(c => c.kind === 'ordinality')).toBe(true);
  });
});

describe('_rewriteSingleJsonTable', () => {
  const mk = (over: Partial<any> = {}) => ({
    jsonString: "'[{\"a\":1}]'",
    pathExpr: "'$[*]'",
    columns: [],
    nestedPaths: [],
    alias: 'jt',
    originalText: '',
    hasNestedPaths: false,
    ...over,
  });

  it('uses the given alias', () => {
    const parsed = mk({ columns: [{ name: 'a', type: 'int', path: '$.a', kind: 'regular', onClause: '' }] });
    expect(_rewriteSingleJsonTable(parsed)).toContain(') AS jt');
  });

  it('falls back to the default alias when alias is empty', () => {
    const parsed = mk({
      alias: '',
      columns: [{ name: 'a', type: '', path: '$.a', kind: 'regular', onClause: '' }],
    });
    const r = _rewriteSingleJsonTable(parsed);
    // substring replacement uses `originalText`; alias fallback shows in the `AS jt` suffix.
    expect(r).toContain('AS jt');
  });

  it('falls back to the default alias for an empty COLUMNS block', () => {
    const parsed = mk({ alias: '', columns: [], originalText: '' });
    expect(_rewriteSingleJsonTable(parsed)).toContain('(SELECT 1 WHERE 0) AS jt');
  });
});
