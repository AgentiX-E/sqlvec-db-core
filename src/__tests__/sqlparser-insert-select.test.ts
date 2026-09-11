import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// parseInsertHeuristic's table regex required VALUES/DEFAULT after the table,
// so `INSERT INTO t SELECT ...` (INSERT ... SELECT form) dropped the table to
// ''. Lock the fix: SELECT is also accepted as a table-name terminator.
describe('SqlParser INSERT ... SELECT table extraction', () => {
  it('extracts the table from a plain INSERT ... SELECT', () => {
    expect((parseStatement('INSERT INTO t SELECT * FROM u') as any).table).toBe('t');
  });

  it('extracts the table from INSERT ... SELECT with a column list', () => {
    expect((parseStatement('INSERT INTO t (a, b) SELECT x, y FROM u') as any).table).toBe('t');
  });

  it('extracts the table from a data-modifying CTE with INSERT ... SELECT', () => {
    expect(
      (parseStatement('WITH c AS (SELECT * FROM u) INSERT INTO t SELECT * FROM c') as any).table,
    ).toBe('t');
  });
});
