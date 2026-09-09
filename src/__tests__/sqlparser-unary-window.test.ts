import { describe, it, expect } from 'vitest';
import { extractWindowFunctions, rewriteWindowSql } from '../query/SqlParser';

// findWindowFunctionsInExpr and stripOver recursed into left/right/args/CASE,
// but skipped the `operand` of unary expressions (NOT, unary minus). A window
// function nested under NOT — e.g. NOT (SUM(y) OVER () > 0) — was neither
// detected nor stripped. Lock the fix.
describe('SqlParser window functions under unary operators', () => {
  it('detects a window function under NOT', () => {
    expect(
      extractWindowFunctions('SELECT NOT (SUM(y) OVER () > 0) FROM t'),
    ).toEqual([{ fn: 'SUM', args: ['y'] }]);
  });

  it('detects a window function under unary minus', () => {
    expect(
      extractWindowFunctions('SELECT -SUM(x) OVER () FROM t'),
    ).toEqual([{ fn: 'SUM', args: ['x'] }]);
  });

  it('detects a window function under NOT inside a CASE WHEN', () => {
    expect(
      extractWindowFunctions(
        'SELECT CASE WHEN NOT (SUM(y) OVER () > 0) THEN 1 END FROM t',
      ),
    ).toEqual([{ fn: 'SUM', args: ['y'] }]);
  });

  it('strips the OVER clause from a window function under NOT', () => {
    const out = rewriteWindowSql('SELECT NOT (SUM(y) OVER () > 0) FROM t');
    expect(out).not.toMatch(/\bOVER\s*\(/);
    expect(out).toMatch(/\bsum\s*\(y\)/i);
  });

  it('strips the OVER clause from a window function under unary minus', () => {
    const out = rewriteWindowSql('SELECT -SUM(x) OVER () FROM t');
    expect(out).not.toMatch(/\bOVER\s*\(/);
    expect(out).toMatch(/\bsum\s*\(x\)/i);
  });
});
