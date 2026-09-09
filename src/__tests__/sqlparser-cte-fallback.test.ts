import { describe, it, expect } from 'vitest';
import { extractCtes, inlineCtes } from '../query/SqlParser';

// Cover fallbackExtractCtes columns branches and inlineCtes column-alias
// handling. pgsql-ast-parser rejects "WITH c (a,b) AS ..." (column alias list)
// and "WITH RECURSIVE", routing both to fallbackExtractCtes.

describe('SqlParser fallbackExtractCtes columns branches', () => {
  it('CTE with column aliases → columns populated (fallback)', () => {
    const ctes = extractCtes('WITH c (a, b) AS (SELECT x, y FROM t) SELECT a FROM c');
    expect(ctes.length).toBe(1);
    expect(ctes[0].name).toBe('c');
    expect(ctes[0].columns).toEqual(['a', 'b']);
  });

  it('RECURSIVE CTE without column aliases → columns undefined', () => {
    const ctes = extractCtes('WITH RECURSIVE c AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT * FROM c');
    expect(ctes.length).toBe(1);
    expect(ctes[0].recursive).toBe(true);
    expect(ctes[0].columns).toBeUndefined();
  });
});

describe('SqlParser inlineCtes', () => {
  it('inlines CTE with column aliases', () => {
    const r = inlineCtes('WITH c (a, b) AS (SELECT x, y FROM t) SELECT a FROM c');
    expect(r).not.toMatch(/^\s*WITH\s+/i);
    expect(r).toContain('AS c');
  });

  it('throws on recursive CTE', () => {
    expect(() =>
      inlineCtes('WITH RECURSIVE c AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT * FROM c'),
    ).toThrow(/[Rr]ecursive/);
  });
});
