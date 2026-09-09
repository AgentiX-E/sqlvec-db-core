import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// extractSelectTables only walked stmt.from and stmt.where, so subqueries in
// the SELECT list (scalar subqueries, IN/ANY/ALL/EXISTS, and CASE branches)
// were silently dropped from the table set — breaking shard routing for
// correlated/scalar subqueries. Lock the fix: SELECT-list subqueries are now
// traversed too.
describe('SqlParser SELECT-list subquery table extraction', () => {
  it('extracts scalar subquery table from SELECT list', () => {
    const r = parseStatement('SELECT (SELECT MAX(y) FROM v) FROM t') as any;
    expect(r.tables).toEqual(['t', 'v']);
  });

  it('extracts IN-subquery table from SELECT list', () => {
    const r = parseStatement('SELECT x IN (SELECT id FROM u) FROM t') as any;
    expect(r.tables).toEqual(['t', 'u']);
  });

  it('extracts CASE-when IN-subquery table', () => {
    const r = parseStatement(
      'SELECT CASE WHEN x IN (SELECT id FROM u) THEN 1 END FROM t',
    ) as any;
    expect(r.tables).toEqual(['t', 'u']);
  });

  it('extracts CASE-then scalar subquery table', () => {
    const r = parseStatement(
      'SELECT CASE WHEN x > 0 THEN (SELECT MAX(y) FROM v) ELSE 0 END FROM t',
    ) as any;
    expect(r.tables).toEqual(['t', 'v']);
  });

  it('does not add phantom tables for plain column list', () => {
    const r = parseStatement('SELECT a, b FROM t') as any;
    expect(r.tables).toEqual(['t']);
  });
});
