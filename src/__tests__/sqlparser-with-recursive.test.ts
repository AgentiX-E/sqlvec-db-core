import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// pgsql-ast-parser v12 rejects the RECURSIVE keyword, so `WITH RECURSIVE c AS
// (...) SELECT ...` fell through fallbackParse to UNKNOWN and lost its type and
// tables. Lock the fix: RECURSIVE is stripped before parsing so recursive CTEs
// extract their tables exactly like a plain WITH.
describe('SqlParser WITH RECURSIVE CTE', () => {
  it('routes WITH RECURSIVE SELECT to the CTE table', () => {
    const r = parseStatement('WITH RECURSIVE c AS (SELECT 1) SELECT * FROM c') as any;
    expect(r.type).toBe('SELECT');
    expect(r.tables).toEqual(['c']);
  });

  it('extracts the underlying table from a recursive CTE definition', () => {
    const r = parseStatement(
      'WITH RECURSIVE c AS (SELECT * FROM u) SELECT * FROM c',
    ) as any;
    expect(r.tables).toEqual(['c', 'u']);
  });

  it('extracts CTE and joined tables for a multi-table recursive CTE', () => {
    const r = parseStatement(
      'WITH RECURSIVE c AS (SELECT * FROM u) SELECT * FROM c JOIN c2 ON c.id = c2.id',
    ) as any;
    expect(r.tables).toEqual(['c', 'c2', 'u']);
  });
});
