import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Cover the `expr.type === 'with'` branch of extractTablesFromExpr, reached
// when a WITH subquery appears inside a WHERE expression (EXISTS/IN). The with
// node is recursed via extractSubqueryTablesFromExpr and its CTE bind tables
// plus the inner SELECT tables must all be collected.
describe('SqlParser WITH subquery inside WHERE', () => {
  it('extracts CTE inner tables from EXISTS (WITH ...)', () => {
    const r = parseStatement(
      'SELECT * FROM t WHERE EXISTS (WITH c AS (SELECT * FROM u) SELECT * FROM c)',
    ) as any;
    expect(r.tables).toEqual(['t', 'c', 'u']);
  });

  it('extracts CTE inner tables from IN (WITH ...)', () => {
    const r = parseStatement(
      'SELECT * FROM t WHERE x IN (WITH c AS (SELECT id FROM u) SELECT id FROM c)',
    ) as any;
    expect(r.tables).toEqual(['t', 'c', 'u']);
  });
});
