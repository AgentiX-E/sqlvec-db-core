import { describe, it, expect } from 'vitest';
import { extractWindowFunctions } from '../query/SqlParser';

// findWindowFunctionsInExpr recurses through unary operators (`operand`),
// CASE ELSE branches (`else`), and zero-argument window calls. Lock each node
// type so the recursion reaches window functions in non-trivial positions.
describe('SqlParser window-function recursion across expression nodes', () => {
  it('finds a window function under a unary minus (operand)', () => {
    const wf = extractWindowFunctions('SELECT -SUM(x) OVER (ORDER BY y) FROM t');
    expect(wf).toEqual([{ fn: 'SUM', args: ['x'], orderBy: [{ key: 'y', dir: 'ASC' }] }]);
  });

  it('finds a window function in a CASE ELSE branch', () => {
    const wf = extractWindowFunctions(
      'SELECT CASE WHEN a > 1 THEN 1 ELSE SUM(x) OVER (PARTITION BY y) END FROM t',
    );
    expect(wf).toEqual([{ fn: 'SUM', args: ['x'], partitionBy: ['y'] }]);
  });

  it('returns no window function for a unary NOT over a non-window call', () => {
    expect(extractWindowFunctions('SELECT NOT EXISTS(SELECT 1 FROM u) FROM t')).toEqual([]);
  });

  it('handles a zero-argument window function (empty args)', () => {
    expect(extractWindowFunctions('SELECT ROW_NUMBER() OVER () FROM t')).toEqual([
      { fn: 'ROW_NUMBER', args: [] },
    ]);
  });
});
