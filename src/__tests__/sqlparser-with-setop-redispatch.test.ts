import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// A WITH whose CTE body uses a v12-rejected construct (INTERSECT/EXCEPT) now
// re-dispatches the trailing main query through the fallback parser, so a
// data-modifying CTE (UPDATE/DELETE/INSERT) routes by its true type instead of
// being mislabeled SELECT (the CTE body's own SELECT fooled the old keyword test).
describe('SqlParser WITH set-op CTE re-dispatch', () => {
  it('routes a WITH INTERSECT CTE + UPDATE as UPDATE', () => {
    const r = parseStatement('WITH c AS (SELECT 1 INTERSECT SELECT 2) UPDATE t SET x = 1') as any;
    expect(r.type).toBe('UPDATE');
    expect(r.table).toBe('t');
  });

  it('routes a WITH INTERSECT CTE + DELETE as DELETE', () => {
    const r = parseStatement('WITH c AS (SELECT 1 INTERSECT SELECT 2) DELETE FROM t WHERE id = 1') as any;
    expect(r.type).toBe('DELETE');
    expect(r.table).toBe('t');
  });

  it('routes a WITH INTERSECT CTE + INSERT as INSERT', () => {
    const r = parseStatement('WITH c AS (SELECT 1 INTERSECT SELECT 2) INSERT INTO t VALUES (1)') as any;
    expect(r.type).toBe('INSERT');
    expect(r.table).toBe('t');
  });

  it('merges CTE-body tables into a WITH set-op SELECT', () => {
    expect(
      (parseStatement('WITH c AS (SELECT * FROM a INTERSECT SELECT * FROM b) SELECT * FROM c') as any).tables,
    ).toEqual(['a', 'b', 'c']);
  });

  it('routes a multi-CTE WITH (second CTE uses a set-op) correctly', () => {
    const r = parseStatement('WITH a AS (SELECT 1), b AS (SELECT 2 INTERSECT SELECT 3) SELECT * FROM b') as any;
    expect(r.type).toBe('SELECT');
    expect(r.tables).toEqual(['b']);
  });
});
