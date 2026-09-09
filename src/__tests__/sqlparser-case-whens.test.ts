import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Cover extractSubqueryTablesFromExpr's CASE `whens` traversal: subqueries in a
// CASE THEN branch (w.value truthy) and in a CASE WHEN condition (w.when truthy).
describe('SqlParser CASE whens subquery extraction', () => {
  it('extracts subquery table from CASE THEN (w.value)', () => {
    const r = parseStatement(
      'SELECT * FROM t WHERE CASE WHEN a > 0 THEN (SELECT x FROM u) ELSE 0 END = 1',
    ) as any;
    expect(r.tables).toContain('u');
    expect(r.tables).toContain('t');
  });

  it('extracts subquery table from CASE WHEN condition (w.when)', () => {
    const r = parseStatement(
      'SELECT * FROM t WHERE CASE WHEN (SELECT x FROM u) > 0 THEN 1 ELSE 0 END = 1',
    ) as any;
    expect(r.tables).toContain('u');
  });
});
