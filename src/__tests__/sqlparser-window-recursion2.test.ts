import { describe, it, expect } from 'vitest';
import { extractWindowFunctions, rewriteWindowSql } from '../query/SqlParser';

// Cover findWindowFunctionsInExpr / stripOver recursive-guard truthy branches:
// window in the LEFT subtree (binary left), RIGHT subtree, and CASE else.
describe('SqlParser window function recursion truthy branches', () => {
  it('finds window in LEFT subtree of binary', () => {
    const wfs = extractWindowFunctions('SELECT (SUM(x) OVER ()) + 1 FROM t');
    expect(wfs.length).toBe(1);
    expect(wfs[0].fn).toBe('SUM');
  });

  it('finds window in RIGHT subtree of binary', () => {
    const wfs = extractWindowFunctions('SELECT 1 + (COUNT(y) OVER ()) FROM t');
    expect(wfs.length).toBe(1);
    expect(wfs[0].fn).toBe('COUNT');
  });

  it('finds window in CASE else branch', () => {
    const wfs = extractWindowFunctions(
      'SELECT CASE WHEN a > 0 THEN 1 ELSE (SUM(x) OVER ()) END FROM t',
    );
    expect(wfs.length).toBe(1);
    expect(wfs[0].fn).toBe('SUM');
  });

  it('strips aggregate window in CASE else via rewriteWindowSql', () => {
    const r = rewriteWindowSql(
      'SELECT CASE WHEN a > 0 THEN 1 ELSE SUM(x) OVER () END FROM t',
    );
    expect(r).not.toMatch(/\bOVER\b/i);
  });
});
