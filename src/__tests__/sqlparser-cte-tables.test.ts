import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Cover parseWith collecting tables referenced inside CTE definitions. A CTE
// like `WITH c AS (SELECT * FROM u) SELECT * FROM c` depends on real data table
// `u` transitively — that table must be included for shard routing, not just the
// CTE alias `c`. Previously only the main SELECT tables were returned.
describe('SqlParser CTE table extraction (parseWith)', () => {
  it('includes the CTE inner table alongside the alias', () => {
    const r = parseStatement('WITH c AS (SELECT * FROM u) SELECT * FROM c') as any;
    expect(r.type).toBe('SELECT');
    expect(r.tables).toEqual(['c', 'u']);
  });

  it('includes all CTE inner tables for multiple CTEs', () => {
    const r = parseStatement(
      'WITH c AS (SELECT * FROM u), d AS (SELECT * FROM v) SELECT * FROM c JOIN d ON c.id = d.id',
    ) as any;
    expect(r.tables).toEqual(['c', 'd', 'u', 'v']);
    expect(r.isMultiShard).toBe(true);
  });

  it('merges CTE inner tables with direct main-query tables', () => {
    const r = parseStatement(
      'WITH c AS (SELECT * FROM u) SELECT * FROM c, t',
    ) as any;
    expect(r.tables).toEqual(['c', 't', 'u']);
    expect(r.isMultiShard).toBe(true);
  });

  it('does not duplicate tables already present in the main query', () => {
    const r = parseStatement('WITH c AS (SELECT * FROM u) SELECT * FROM u, c') as any;
    expect(r.tables).toEqual(['u', 'c']);
  });
});
