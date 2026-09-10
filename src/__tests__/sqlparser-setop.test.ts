import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Set operations (UNION/INTERSECT/EXCEPT, with optional ALL) parsed to a
// 'union'/'union all' etc. AST node that was neither a SELECT nor handled by the
// switch, so top-level set queries returned UNKNOWN and CTE bodies dropped all
// set-arm tables. Lock the fix: every arm's tables are extracted recursively.
describe('SqlParser set-operation table extraction', () => {
  it('extracts tables from a top-level UNION', () => {
    expect((parseStatement('SELECT * FROM a UNION SELECT * FROM b') as any).tables).toEqual(['a', 'b']);
  });

  it('extracts tables from a UNION ALL', () => {
    expect((parseStatement('SELECT * FROM a UNION ALL SELECT * FROM b') as any).tables).toEqual(['a', 'b']);
  });

  it('extracts tables from a chained UNION across three arms', () => {
    expect(
      (parseStatement('SELECT * FROM a UNION SELECT * FROM b UNION ALL SELECT * FROM c') as any).tables,
    ).toEqual(['a', 'b', 'c']);
  });

  it('extracts tables from INTERSECT and EXCEPT', () => {
    expect((parseStatement('SELECT * FROM a INTERSECT SELECT * FROM b') as any).tables).toEqual(['a', 'b']);
    expect((parseStatement('SELECT * FROM a EXCEPT SELECT * FROM b') as any).tables).toEqual(['a', 'b']);
  });

  it('extracts tables from a set operation nested in a CTE', () => {
    expect(
      (parseStatement('WITH c AS (SELECT * FROM a INTERSECT SELECT * FROM b) SELECT * FROM c') as any).tables,
    ).toEqual(['a', 'b', 'c']);
  });

  it('extracts tables from a set operation in a derived table', () => {
    expect(
      (parseStatement('SELECT * FROM (SELECT * FROM a UNION SELECT * FROM b) s') as any).tables,
    ).toEqual(['a', 'b']);
  });
});
