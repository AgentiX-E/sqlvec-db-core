import { describe, it, expect } from 'vitest';
import { extractWindowFunctions, rewriteWindowSql } from '../query/SqlParser';

// findWindowFunctionsInExpr and stripOver (inside rewriteWindowSql) walked CASE
// `whens` but only recursed into `w.value` (the THEN result), skipping `w.when`
// (the condition). A window function inside the CASE condition — e.g.
// `CASE WHEN SUM(y) OVER () > 0 ...` — was therefore neither detected nor
// stripped. Lock the fix: both branches of a CASE when-arm are traversed.
describe('SqlParser window functions inside CASE WHEN condition', () => {
  it('detects a window function in a CASE WHEN condition', () => {
    const wfs = extractWindowFunctions(
      'SELECT CASE WHEN SUM(y) OVER () > 0 THEN 1 ELSE 0 END FROM t',
    );
    expect(wfs).toEqual([{ fn: 'SUM', args: ['y'] }]);
  });

  it('still detects window functions in the THEN arm and ELSE arm', () => {
    expect(
      extractWindowFunctions(
        'SELECT CASE WHEN x > 0 THEN SUM(y) OVER () ELSE 0 END FROM t',
      ),
    ).toEqual([{ fn: 'SUM', args: ['y'] }]);
    expect(
      extractWindowFunctions(
        'SELECT CASE WHEN x > 0 THEN 1 ELSE SUM(y) OVER () END FROM t',
      ),
    ).toEqual([{ fn: 'SUM', args: ['y'] }]);
  });

  it('strips the OVER clause from a window function in a CASE WHEN condition', () => {
    const out = rewriteWindowSql(
      'SELECT CASE WHEN SUM(y) OVER () > 0 THEN 1 ELSE 0 END FROM t',
    );
    expect(out).not.toMatch(/\bOVER\s*\(/);
    expect(out).toMatch(/\bsum\s*\(y\)/i);
  });

  it('strips the OVER clause when the window function is a CASE WHEN operand', () => {
    const out = rewriteWindowSql(
      'SELECT CASE WHEN x > SUM(y) OVER () THEN 1 ELSE 0 END FROM t',
    );
    expect(out).not.toMatch(/\bOVER\s*\(/);
    expect(out).toMatch(/\bsum\s*\(y\)/i);
  });
});
