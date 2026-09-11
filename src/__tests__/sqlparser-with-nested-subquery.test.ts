import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// extractMainQueryAfterWith must track parenthesis depth to skip nested
// subqueries inside CTE bodies before locating the main query. Lock that a CTE
// body containing a nested subquery (with its own parentheses) is parsed
// correctly, extracting the nested table too.
describe('SqlParser WITH CTE nested subquery', () => {
  it('tracks nested parentheses when locating the main query', () => {
    expect(
      (
        parseStatement(
          'WITH c AS (SELECT * FROM (SELECT * FROM a) s INTERSECT SELECT * FROM b) SELECT * FROM c',
        ) as any
      ).tables,
    ).toEqual(['a', 'b', 'c']);
  });

  it('handles a column-aliased CTE with a set-op body', () => {
    const r = parseStatement('WITH c(a) AS (SELECT 1 INTERSECT SELECT 2) SELECT 3') as any;
    expect(r.type).toBe('SELECT');
    expect(r.tables).toEqual([]);
  });
});
