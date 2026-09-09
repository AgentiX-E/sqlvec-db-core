import { describe, it, expect } from 'vitest';
import { parseStatement, extractWindowFunctions } from '../query/SqlParser';

// Target the remaining deep-traversal guards in extractSelectTables /
// extractTablesFromExpr / extractSubqueryTablesFromExpr: FROM subqueries
// (fromItem.type === 'statement'), subqueries with JOINs (fi.joins), subquery
// in JOIN position (join.table.type === 'statement'), WITH (expr.type ===
// 'with'), CASE else (expr.result / expr.def).

describe('SqlParser FROM-subquery and nested JOIN table extraction', () => {
  it('extracts table from bare subquery in FROM (no alias)', () => {
    const r = parseStatement('SELECT * FROM (SELECT * FROM inner_t)');
    expect((r as any).tables).toEqual(expect.arrayContaining(['inner_t']));
  });

  it('extracts nested JOIN inside a subquery (fi.joins)', () => {
    const r = parseStatement('SELECT * FROM (SELECT * FROM a JOIN b ON a.id = b.id) x');
    expect((r as any).tables).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('extracts table from subquery in JOIN position', () => {
    const r = parseStatement('SELECT * FROM a JOIN (SELECT * FROM b) s ON a.id = s.id');
    expect((r as any).tables).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('extracts tables from WITH subquery in FROM', () => {
    const r = parseStatement('SELECT * FROM (WITH w AS (SELECT * FROM t1) SELECT * FROM w)');
    expect((r as any).tables).toEqual(expect.arrayContaining(['t1']));
  });

  it('extracts table from subquery in WHERE with JOIN', () => {
    const r = parseStatement('SELECT * FROM t WHERE id IN (SELECT id FROM x JOIN y ON x.id = y.id)');
    expect((r as any).tables).toEqual(expect.arrayContaining(['x', 'y']));
  });
});

describe('SqlParser CASE else / function result traversal', () => {
  it('extracts table from CASE else branch subquery', () => {
    const r = parseStatement('SELECT * FROM t WHERE CASE WHEN a > 0 THEN 1 ELSE (SELECT id FROM other) END > 0');
    expect((r as any).tables).toEqual(expect.arrayContaining(['t', 'other']));
  });

  it('finds window function in function args (expr.arguments)', () => {
    const wfs = extractWindowFunctions('SELECT COALESCE((SELECT 1), SUM(x) OVER ()) FROM t');
    expect(wfs.length).toBeGreaterThan(0);
  });
});
