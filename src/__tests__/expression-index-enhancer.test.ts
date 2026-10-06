import { describe, it, expect } from 'vitest';
import {
  detectExpressionType,
  detectEnhancedExpressionIndex,
  rewriteTypeCast,
  rewriteJsonAccess,
  validateExpressionIndexCompatibility,
  enhanceExpressionIndex,
  processExpressionIndex,
} from '../index/ExpressionIndexEnhancer';

describe('detectExpressionType', () => {
  it('returns unknown when no parenthesized expression exists', () => {
    expect(detectExpressionType('SELECT * FROM t')).toBe('unknown');
    expect(detectExpressionType('')).toBe('unknown');
  });

  it('detects subquery', () => {
    expect(detectExpressionType('CREATE INDEX ON t (((SELECT max(x) FROM u)))')).toBe('subquery');
  });

  it('detects CASE', () => {
    expect(detectExpressionType('CREATE INDEX ON t ((CASE WHEN x > 0 THEN 1 ELSE 0 END))')).toBe('case');
  });

  it('detects COALESCE', () => {
    expect(detectExpressionType('CREATE INDEX ON t ((COALESCE(a, b)))')).toBe('coalesce');
  });

  it('detects NULLIF alone (not degraded to function)', () => {
    expect(detectExpressionType('CREATE INDEX ON t ((NULLIF(a, b)))')).toBe('coalesce');
  });

  it('detects type cast', () => {
    expect(detectExpressionType('CREATE INDEX ON t ((col::text))')).toBe('cast');
  });

  it('detects JSON access', () => {
    expect(detectExpressionType("CREATE INDEX ON t ((data->>'key'))")).toBe('json');
    expect(detectExpressionType('CREATE INDEX ON t ((data->\'key\'))')).toBe('json');
  });

  it('detects concatenation', () => {
    expect(detectExpressionType("CREATE INDEX ON t ((first_name || ' ' || last_name))")).toBe('concat');
  });

  it('detects function call', () => {
    expect(detectExpressionType('CREATE INDEX ON t ((lower(name)))')).toBe('function');
  });

  it('detects arithmetic', () => {
    expect(detectExpressionType('CREATE INDEX ON t ((price * qty))')).toBe('arithmetic');
    expect(detectExpressionType('CREATE INDEX ON t ((price + qty))')).toBe('arithmetic');
    expect(detectExpressionType('CREATE INDEX ON t ((price - qty))')).toBe('arithmetic');
  });
});

describe('detectEnhancedExpressionIndex', () => {
  it('returns true for any recognized expression type', () => {
    expect(detectEnhancedExpressionIndex('CREATE INDEX ON t ((lower(name)))')).toBe(true);
  });

  it('returns false for unknown expressions', () => {
    expect(detectEnhancedExpressionIndex('CREATE INDEX ON t')).toBe(false);
    expect(detectEnhancedExpressionIndex('SELECT * FROM t')).toBe(false);
  });
});

describe('rewriteTypeCast', () => {
  it('strips TEXT casts (column passed through)', () => {
    expect(rewriteTypeCast('(col::text)')).toBe('(col)');
    expect(rewriteTypeCast('(col::varchar)')).toBe('(col)');
  });

  it('casts numeric types to SQLite equivalents', () => {
    expect(rewriteTypeCast('(amount::numeric(10,2))')).toBe('(CAST(amount AS NUMERIC))');
    expect(rewriteTypeCast('(x::integer)')).toBe('(CAST(x AS INTEGER))');
    expect(rewriteTypeCast('(x::bigint)')).toBe('(CAST(x AS INTEGER))');
    expect(rewriteTypeCast('(x::float)')).toBe('(CAST(x AS REAL))');
    expect(rewriteTypeCast('(x::double)')).toBe('(CAST(x AS REAL))');
    expect(rewriteTypeCast('(x::real)')).toBe('(CAST(x AS REAL))');
  });

  it('preserves table-qualified column names', () => {
    expect(rewriteTypeCast('(t.col::text)')).toBe('(t.col)');
    expect(rewriteTypeCast('(t.col::integer)')).toBe('(CAST(t.col AS INTEGER))');
  });

  it('passes through unknown types as the bare column', () => {
    expect(rewriteTypeCast('(col::someweirdtype)')).toBe('(col)');
  });
});

describe('rewriteJsonAccess', () => {
  it('rewrites ->> to json_extract', () => {
    expect(rewriteJsonAccess("data->>'key'")).toBe("json_extract(data, '$.key')");
  });

  it('rewrites -> to json_extract', () => {
    expect(rewriteJsonAccess("data->'key'")).toBe("json_extract(data, '$.key')");
  });

  it('rewrites #>> path access to a single json path', () => {
    expect(rewriteJsonAccess("data#>>'{path,to,val}'")).toBe("json_extract(data, '$.path.to.val')");
  });

  it('rewrites #> path access to a single json path', () => {
    expect(rewriteJsonAccess("data#>'{a,b}'")).toBe("json_extract(data, '$.a.b')");
  });

  it('handles multiple JSON accesses in one expression', () => {
    expect(rewriteJsonAccess("data->>'a' || data->>'b'")).toBe(
      "json_extract(data, '$.a') || json_extract(data, '$.b')",
    );
  });
});

describe('validateExpressionIndexCompatibility', () => {
  it('marks simple expressions as compatible', () => {
    const r = validateExpressionIndexCompatibility('lower(name)');
    expect(r.compatible).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('flags subqueries as incompatible', () => {
    const r = validateExpressionIndexCompatibility('(SELECT max(x) FROM u)');
    expect(r.compatible).toBe(false);
    expect(r.warnings.some((w) => w.includes('Subqueries'))).toBe(true);
  });

  it('flags PostgreSQL-specific functions', () => {
    const r = validateExpressionIndexCompatibility('to_tsvector(\'english\', body)');
    expect(r.compatible).toBe(false);
    expect(r.warnings.some((w) => w.includes('to_tsvector'))).toBe(true);
  });

  it('flags github-specific operators but stays compatible', () => {
    const r = validateExpressionIndexCompatibility('body @@ \'search\'');
    // operators add warnings but do NOT set compatible=false in the current impl
    expect(r.warnings.some((w) => w.includes('@@'))).toBe(true);
  });
});

describe('enhanceExpressionIndex', () => {
  it('passes through non-CREATE-INDEX SQL unchanged', () => {
    const r = enhanceExpressionIndex('SELECT * FROM t');
    expect(r).toEqual({ sql: 'SELECT * FROM t', enhanced: false, expressionType: 'unknown' });
  });

  it('passes through unknown index expressions unchanged', () => {
    const r = enhanceExpressionIndex('CREATE INDEX ON t (foo)');
    expect(r.enhanced).toBe(false);
    expect(r.expressionType).toBe('unknown');
  });

  it('rewrites JSON access in CREATE INDEX', () => {
    const r = enhanceExpressionIndex("CREATE INDEX ON t ((data->>'key'))");
    expect(r.enhanced).toBe(true);
    expect(r.expressionType).toBe('json');
    expect(r.sql).toContain("json_extract(data, '$.key')");
  });

  it('rewrites type casts in CREATE INDEX', () => {
    const r = enhanceExpressionIndex('CREATE INDEX ON t ((col::text))');
    expect(r.enhanced).toBe(true);
    expect(r.expressionType).toBe('cast');
  });

  it('unwraps PG double parentheses', () => {
    const r = enhanceExpressionIndex('CREATE INDEX ON t ((lower(name)))');
    expect(r.enhanced).toBe(true);
    expect(r.expressionType).toBe('function');
  });

  it('reports incompatible expressions with warnings in the log target', () => {
    const r = enhanceExpressionIndex('CREATE INDEX ON t (((SELECT max(x) FROM u)))');
    expect(r.enhanced).toBe(true);
    expect(r.expressionType).toBe('subquery');
  });

  it('preserves the index wrapper for a single-parenthesized cast', () => {
    const r = enhanceExpressionIndex('CREATE INDEX ON t (col::text)');
    expect(r.sql).toBe('CREATE INDEX ON t (col)');
    expect(r.enhanced).toBe(true);
  });
});

describe('processExpressionIndex', () => {
  it('returns the rewritten SQL', () => {
    expect(processExpressionIndex("CREATE INDEX ON t ((data->>'key'))")).toContain('json_extract');
  });

  it('returns original SQL for non-index statements', () => {
    expect(processExpressionIndex('SELECT 1')).toBe('SELECT 1');
  });
});
