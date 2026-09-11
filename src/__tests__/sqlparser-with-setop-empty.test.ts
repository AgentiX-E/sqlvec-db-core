import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// A WITH whose CTE body uses a construct pgsql-ast-parser v12 rejects
// (INTERSECT/EXCEPT) fell through parseWith's catch and returned UNKNOWN when no
// table could be heuristically extracted (e.g. `SELECT 1`). A WITH ... SELECT is
// still a SELECT even with an empty table set. Lock the fix: route it as SELECT.
describe('SqlParser WITH set-op CTE body with no tables', () => {
  it('routes a WITH INTERSECT CTE (no tables) as SELECT, not UNKNOWN', () => {
    const r = parseStatement('WITH c AS (SELECT 1 INTERSECT SELECT 2) SELECT 3') as any;
    expect(r.type).toBe('SELECT');
    expect(r.tables).toEqual([]);
  });

  it('still extracts tables when the CTE set-op references tables', () => {
    expect(
      (parseStatement('WITH c AS (SELECT * FROM a INTERSECT SELECT * FROM b) SELECT * FROM c') as any).tables,
    ).toEqual(['a', 'b', 'c']);
  });

  it('routes a RECURSIVE CTE with no tables as SELECT', () => {
    const r = parseStatement('WITH RECURSIVE c AS (SELECT 1) SELECT 2') as any;
    expect(r.type).toBe('SELECT');
    expect(r.tables).toEqual([]);
  });
});
