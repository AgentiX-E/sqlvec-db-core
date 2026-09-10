import { describe, it, expect } from 'vitest';
import { extractWindowFunctions, rewriteWindowSql } from '../query/SqlParser';

// A simple CASE (CASE <scrutinee> WHEN ...) stores the scrutinee in the
// top-level `value` field. findWindowFunctionsInExpr and stripOver recursed into
// left/right/operand/args/CASE-whens/else but skipped `value`, so a window
// function in the scrutinee — e.g. CASE SUM(y) OVER () WHEN 1 THEN 2 — was
// neither detected nor stripped. Lock the fix.
describe('SqlParser window functions in a simple CASE scrutinee', () => {
  it('detects a window function in the CASE scrutinee', () => {
    expect(
      extractWindowFunctions('SELECT CASE SUM(y) OVER () WHEN 1 THEN 2 END FROM t'),
    ).toEqual([{ fn: 'SUM', args: ['y'] }]);
  });

  it('strips the OVER clause from the CASE scrutinee', () => {
    const out = rewriteWindowSql('SELECT CASE SUM(y) OVER () WHEN 1 THEN 2 END FROM t');
    expect(out).not.toMatch(/\bOVER\s*\(/);
    expect(out).toMatch(/\bsum\s*\(y\)/i);
  });

  it('still handles a window function in a searched CASE when-arm', () => {
    expect(
      extractWindowFunctions('SELECT CASE x WHEN SUM(y) OVER () THEN 1 END FROM t'),
    ).toEqual([{ fn: 'SUM', args: ['y'] }]);
  });
});
