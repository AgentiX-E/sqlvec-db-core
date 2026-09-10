import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// extractSelectTables walked `from` but only extracted the table name of each
// joined table, skipping the JOIN ... ON condition. A subquery inside ON (e.g.
// `ON t.id = (SELECT MAX(v.id) FROM v)`) was therefore dropped from the table
// set, breaking shard routing. Lock the fix.
describe('SqlParser JOIN ON subquery table extraction', () => {
  it('extracts a scalar subquery table from JOIN ON', () => {
    const r = parseStatement(
      'SELECT * FROM t JOIN u ON t.id = (SELECT MAX(v.id) FROM v)',
    ) as any;
    expect(r.tables).toEqual(['t', 'u', 'v']);
  });

  it('extracts an IN-subquery table from JOIN ON', () => {
    const r = parseStatement(
      'SELECT * FROM t JOIN u ON u.id IN (SELECT id FROM v)',
    ) as any;
    expect(r.tables).toEqual(['t', 'u', 'v']);
  });

  it('extracts a JOIN ON subquery table nested inside a derived table', () => {
    const r = parseStatement(
      'SELECT * FROM (SELECT * FROM a JOIN b ON a.id = (SELECT MAX(c.id) FROM c)) s',
    ) as any;
    expect(r.tables).toEqual(['a', 'b', 'c']);
  });
});
