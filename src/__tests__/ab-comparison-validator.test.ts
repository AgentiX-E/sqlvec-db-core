import { describe, it, expect } from 'vitest';
import { ABComparisonValidator, ABQueryResult } from '../analytics/ABComparisonValidator';

function make(columns: string[], rows: Record<string, unknown>[]): ABQueryResult {
  return {
    columns: columns.map((name) => ({ name })),
    rows,
    rowCount: rows.length,
  };
}

describe('ABComparisonValidator.compare — schema', () => {
  it('passes when column names match case-insensitively', () => {
    const v = new ABComparisonValidator();
    const r = v.compare(make(['ID'], [{ ID: 1 }]), make(['id'], [{ id: 1 }]), 'x');
    expect(r.passed).toBe(true);
    expect(r.diffs).toEqual([]);
  });

  it('reports a column count mismatch', () => {
    const v = new ABComparisonValidator();
    const r = v.compare(make(['a', 'b'], []), make(['a'], []), 'x');
    expect(r.passed).toBe(false);
    expect(r.diffs.some((d) => d.path === 'schema' && /count mismatch/.test(d.description))).toBe(true);
  });

  it('reports a column name mismatch', () => {
    const v = new ABComparisonValidator();
    const r = v.compare(make(['a', 'b'], []), make(['a', 'c'], []), 'x');
    expect(r.passed).toBe(false);
    expect(r.diffs.some((d) => d.path === 'schema' && /name mismatch/.test(d.description))).toBe(true);
  });

  it('compares values by original column name regardless of case', () => {
    const v = new ABComparisonValidator();
    // A returns uppercase column names; B returns lowercase — cross-reference
    // must fetch each engine's row by its own original name.
    const r = v.compare(make(['ID'], [{ ID: 42 }]), make(['id'], [{ id: 42 }]), 'x');
    expect(r.passed).toBe(true);
    expect(r.summary.columnsCompared).toBe(1);
  });

  it('reports a difference when column order differs', () => {
    const v = new ABComparisonValidator();
    // Same names, different order — the schema-level positional check flags it.
    const r = v.compare(make(['a', 'b'], []), make(['b', 'a'], []), 'x');
    expect(r.passed).toBe(false);
    expect(r.diffs.some((d) => d.path === 'schema')).toBe(true);
  });
});

describe('ABComparisonValidator.compare — row count', () => {
  it('reports a row count mismatch', () => {
    const v = new ABComparisonValidator();
    const r = v.compare(make(['a'], [{ a: 1 }, { a: 2 }]), make(['a'], [{ a: 1 }]), 'x');
    expect(r.passed).toBe(false);
    expect(r.diffs.some((d) => d.path === 'rowCount')).toBe(true);
  });

  it('falls back to rows.length when rowCount is undefined', () => {
    const v = new ABComparisonValidator();
    const a: ABQueryResult = { columns: [{ name: 'a' }], rows: [{ a: 1 }], rowCount: undefined as any };
    const b: ABQueryResult = { columns: [{ name: 'a' }], rows: [{ a: 1 }], rowCount: undefined as any };
    expect(v.compare(a, b, 'x').passed).toBe(true);
  });

  it('uses explicit rowCount even when it disagrees with rows.length', () => {
    const v = new ABComparisonValidator();
    const a: ABQueryResult = { columns: [{ name: 'a' }], rows: [{ a: 1 }], rowCount: 5 };
    const b: ABQueryResult = { columns: [{ name: 'a' }], rows: [{ a: 1 }], rowCount: 3 };
    const r = v.compare(a, b, 'x');
    expect(r.passed).toBe(false);
    expect(r.diffs.some((d) => d.path === 'rowCount')).toBe(true);
  });
});

describe('ABComparisonValidator.compare — row values', () => {
  it('passes for identical rows', () => {
    const v = new ABComparisonValidator();
    const r = v.compare(make(['a', 'b'], [{ a: 1, b: 'x' }]), make(['a', 'b'], [{ a: 1, b: 'x' }]), 'x');
    expect(r.passed).toBe(true);
  });

  it('reports a row value mismatch', () => {
    const v = new ABComparisonValidator();
    const r = v.compare(make(['a'], [{ a: 1 }]), make(['a'], [{ a: 2 }]), 'x');
    expect(r.passed).toBe(false);
    const diff = r.diffs.find((d) => d.path === 'rowValue');
    expect(diff).toBeDefined();
    expect(diff?.rowIndex).toBe(0);
    expect(diff?.column).toBe('a');
  });

  it('treats NULL as equal to NULL', () => {
    const v = new ABComparisonValidator();
    const r = v.compare(make(['a'], [{ a: null }]), make(['a'], [{ a: null }]), 'x');
    expect(r.passed).toBe(true);
  });

  it('distinguishes NULL from a value', () => {
    const v = new ABComparisonValidator();
    const r = v.compare(make(['a'], [{ a: null }]), make(['a'], [{ a: 0 }]), 'x');
    expect(r.passed).toBe(false);
  });
});

describe('ABComparisonValidator — numeric tolerance', () => {
  it('treats numeric string equal to number', () => {
    const v = new ABComparisonValidator();
    expect(v.compare(make(['a'], [{ a: '123' }]), make(['a'], [{ a: 123 }]), 'x').passed).toBe(true);
  });

  it('treats near-equal floats as equal (float32 vs float64)', () => {
    const v = new ABComparisonValidator();
    const a = 0.1 + 0.2;
    const b = 0.3;
    expect(v.compare(make(['a'], [{ a }]), make(['a'], [{ a: b }]), 'x').passed).toBe(true);
  });

  it('treats distinct numbers as different', () => {
    const v = new ABComparisonValidator();
    expect(v.compare(make(['a'], [{ a: 1 }]), make(['a'], [{ a: 2 }]), 'x').passed).toBe(false);
  });

  it('does NOT collapse empty string onto 0', () => {
    const v = new ABComparisonValidator();
    expect(v.compare(make(['a'], [{ a: '' }]), make(['a'], [{ a: 0 }]), 'x').passed).toBe(false);
  });

  it('does NOT collapse blank string onto 0', () => {
    const v = new ABComparisonValidator();
    expect(v.compare(make(['a'], [{ a: '   ' }]), make(['a'], [{ a: 0 }]), 'x').passed).toBe(false);
  });

  it('does NOT collapse boolean false onto 0', () => {
    const v = new ABComparisonValidator();
    expect(v.compare(make(['a'], [{ a: false }]), make(['a'], [{ a: 0 }]), 'x').passed).toBe(false);
  });

  it('does NOT collapse boolean true onto 1', () => {
    const v = new ABComparisonValidator();
    expect(v.compare(make(['a'], [{ a: true }]), make(['a'], [{ a: 1 }]), 'x').passed).toBe(false);
  });

  it('does NOT treat the string "true" as boolean true', () => {
    const v = new ABComparisonValidator();
    expect(v.compare(make(['a'], [{ a: 'true' }]), make(['a'], [{ a: true }]), 'x').passed).toBe(false);
  });

  it('does NOT treat empty string as boolean false', () => {
    const v = new ABComparisonValidator();
    expect(v.compare(make(['a'], [{ a: '' }]), make(['a'], [{ a: false }]), 'x').passed).toBe(false);
  });
});

describe('ABComparisonValidator — type normalization', () => {
  it('compares booleans strictly', () => {
    const v = new ABComparisonValidator();
    expect(v.compare(make(['a'], [{ a: true }]), make(['a'], [{ a: true }]), 'x').passed).toBe(true);
    expect(v.compare(make(['a'], [{ a: true }]), make(['a'], [{ a: false }]), 'x').passed).toBe(false);
  });

  it('compares same Date values via ISO string', () => {
    const v = new ABComparisonValidator();
    const d1 = new Date('2020-01-01T00:00:00Z');
    const d2 = new Date('2020-01-01T00:00:00Z');
    expect(v.compare(make(['a'], [{ a: d1 }]), make(['a'], [{ a: d2 }]), 'x').passed).toBe(true);
  });

  it('compares Buffer values via hex', () => {
    const v = new ABComparisonValidator();
    expect(
      v.compare(make(['a'], [{ a: Buffer.from('abc') }]), make(['a'], [{ a: Buffer.from('abc') }]), 'x').passed,
    ).toBe(true);
    expect(
      v.compare(make(['a'], [{ a: Buffer.from('abc') }]), make(['a'], [{ a: Buffer.from('abd') }]), 'x').passed,
    ).toBe(false);
  });
});

describe('ABComparisonValidator.compare — summary and sql truncation', () => {
  it('truncates long SQL to 200 characters', () => {
    const v = new ABComparisonValidator();
    const longSql = 'S'.repeat(500);
    const r = v.compare(make(['a'], []), make(['a'], []), longSql);
    expect(r.sql).toHaveLength(200);
    expect(r.sql.endsWith('...')).toBe(true);
  });

  it('reports accurate rowsCompared and columnsCompared', () => {
    const v = new ABComparisonValidator();
    const r = v.compare(
      make(['a', 'b'], [{ a: 1, b: 2 }, { a: 3, b: 4 }]),
      make(['a', 'b'], [{ a: 1, b: 2 }]),
      'x',
    );
    expect(r.summary.rowsCompared).toBe(1);
    expect(r.summary.columnsCompared).toBe(2);
  });

  it('counts only cross-referenced columns when names mismatch', () => {
    const v = new ABComparisonValidator();
    // A has (a,b), B has (a,c); only 'a' cross-references (b and c differ)
    const r = v.compare(make(['a', 'b'], []), make(['a', 'c'], []), 'x');
    expect(r.summary.columnsCompared).toBe(1);
  });
});

describe('ABComparisonValidator — defensive fallbacks and edge types', () => {
  it('falls back to empty columns when columns is undefined', () => {
    const v = new ABComparisonValidator();
    const a: ABQueryResult = { columns: undefined as any, rows: [], rowCount: 0 };
    const b: ABQueryResult = { columns: [{ name: 'x' }], rows: [], rowCount: 0 };
    const r = v.compare(a, b, 'x');
    // schema length 0 vs 1 → column count mismatch, but must not throw
    expect(r.diffs.some((d) => d.path === 'schema')).toBe(true);
  });

  it('falls back to empty columns when columns is undefined on resultB', () => {
    const v = new ABComparisonValidator();
    const a: ABQueryResult = { columns: [{ name: 'x' }], rows: [], rowCount: 0 };
    const b: ABQueryResult = { columns: undefined as any, rows: [], rowCount: 0 };
    const r = v.compare(a, b, 'x');
    expect(r.diffs.some((d) => d.path === 'schema')).toBe(true);
  });

  it('falls back to empty rows when rows is undefined', () => {
    const v = new ABComparisonValidator();
    const a: ABQueryResult = { columns: [{ name: 'x' }], rows: undefined as any, rowCount: 0 };
    const b: ABQueryResult = { columns: [{ name: 'x' }], rows: undefined as any, rowCount: 0 };
    expect(v.compare(a, b, 'x').passed).toBe(true);
  });

  it('normalizes bigint to number', () => {
    const v = new ABComparisonValidator();
    const r = v.compare(make(['a'], [{ a: 42n }]), make(['a'], [{ a: 42 }]), 'x');
    expect(r.passed).toBe(true);
  });

  it('normalizes a plain object to its string form', () => {
    const v = new ABComparisonValidator();
    // Both {} stringify to '[object Object]' via the String() fallback
    const r = v.compare(make(['a'], [{ a: { x: 1 } }]), make(['a'], [{ a: { x: 2 } }]), 'x');
    expect(r.passed).toBe(true);
  });

  it('treats objects differing from primitives as different', () => {
    const v = new ABComparisonValidator();
    expect(v.compare(make(['a'], [{ a: { x: 1 } }]), make(['a'], [{ a: 'x' }]), 'x').passed).toBe(false);
  });

  it('applies relative tolerance for large-magnitude float32 vs float64 values', () => {
    const v = new ABComparisonValidator();
    // 16777216 (2^24) vs 16777217: float32 rounds the latter to the former.
    // Absolute difference 1 is well above 1e-10, but the relative difference
    // (~6e-8) is below 1e-6.
    const r = v.compare(make(['a'], [{ a: 16777216 }]), make(['a'], [{ a: 16777217 }]), 'x');
    expect(r.passed).toBe(true);
  });
});

describe('ABComparisonValidator.compareBatch', () => {
  it('returns allPassed=false when any query fails', () => {
    const v = new ABComparisonValidator();
    const batch = [
      { sql: 'q1', resultA: make(['a'], [{ a: 1 }]), resultB: make(['a'], [{ a: 1 }]) },
      { sql: 'q2', resultA: make(['a'], [{ a: 1 }]), resultB: make(['a'], [{ a: 2 }]) },
    ];
    const r = v.compareBatch(batch);
    expect(r.allPassed).toBe(false);
    expect(r.results).toHaveLength(2);
    expect(r.results[0].passed).toBe(true);
    expect(r.results[1].passed).toBe(false);
  });

  it('returns allPassed=true when every query passes', () => {
    const v = new ABComparisonValidator();
    const batch = [
      { sql: 'q1', resultA: make(['a'], [{ a: 1 }]), resultB: make(['a'], [{ a: 1 }]) },
      { sql: 'q2', resultA: make(['a'], [{ a: 2 }]), resultB: make(['a'], [{ a: 2 }]) },
    ];
    expect(v.compareBatch(batch).allPassed).toBe(true);
  });
});
