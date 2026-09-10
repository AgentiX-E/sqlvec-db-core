import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Two heuristic table-extraction bugs in the fallback path (reached when
// pgsql-ast-parser v12 rejects valid PostgreSQL):
//   1. `FROM ONLY t` captured "ONLY" as the table instead of "t".
//   2. `IS [NOT] DISTINCT FROM y` matched "FROM y" and polluted the table list
//      with the column name "y" as a fake table.
describe('SqlParser fallback FROM precision', () => {
  it('skips the ONLY modifier in SELECT ... FROM ONLY t', () => {
    expect((parseStatement('SELECT * FROM ONLY t') as any).tables).toEqual(['t']);
    expect((parseStatement('SELECT * FROM ONLY t WHERE id = 1') as any).tables).toEqual(['t']);
  });

  it('does not treat IS DISTINCT FROM column as a table', () => {
    expect((parseStatement('SELECT * FROM t WHERE x IS DISTINCT FROM y') as any).tables).toEqual(['t']);
  });

  it('does not treat IS NOT DISTINCT FROM column as a table', () => {
    expect((parseStatement('SELECT * FROM t WHERE x IS NOT DISTINCT FROM y') as any).tables).toEqual(['t']);
  });

  it('still extracts natural join and lateral tables correctly', () => {
    expect((parseStatement('SELECT * FROM a NATURAL JOIN b') as any).tables).toEqual(['a', 'b']);
    expect((parseStatement('SELECT * FROM a LATERAL (SELECT * FROM b WHERE b.x = a.x) x') as any).tables).toEqual(['a', 'b']);
  });
});
