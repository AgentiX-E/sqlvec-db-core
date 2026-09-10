import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// UPDATE ONLY / DELETE FROM ONLY are valid PostgreSQL (ONLY excludes inherited
// child tables). The fallback heuristic matched `ONLY` as the table name, so
// UPDATE ONLY t set table to "ONLY" and mis-routed. Lock the fix: skip the ONLY
// modifier and also cover the fallback whereMatch truthy branch (col = number).
describe('SqlParser fallback UPDATE/DELETE ONLY modifier', () => {
  it('extracts the table name after ONLY', () => {
    const r = parseStatement('UPDATE ONLY t SET x = 1 WHERE id = 5') as any;
    expect(r.type).toBe('UPDATE');
    expect(r.table).toBe('t');
  });

  it('extracts the WHERE column for a parameterized predicate', () => {
    const r = parseStatement('UPDATE ONLY t SET x = 1 WHERE id = $1') as any;
    expect(r.table).toBe('t');
    expect(r.whereColumns).toEqual(['id']);
  });

  it('still extracts the table for a plain UPDATE', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE id = 5') as any;
    expect(r.table).toBe('t');
    expect(r.whereColumns).toEqual(['id']);
  });

  it('extracts the table after DELETE FROM ONLY', () => {
    const r = parseStatement('DELETE FROM ONLY t WHERE id = 5') as any;
    expect(r.type).toBe('DELETE');
    expect(r.table).toBe('t');
  });
});
