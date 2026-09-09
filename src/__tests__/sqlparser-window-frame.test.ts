import { describe, it, expect } from 'vitest';
import { extractWindowFunctions, rewriteWindowSql } from '../query/SqlParser';

// pgsql-ast-parser throws on ROWS/RANGE window frame clauses, routing to
// fallbackExtractWindowFunctions. Its ORDER BY extraction was greedy and let
// the frame clause pollute the orderBy key (e.g. key "sal ROWS BETWEEN ...").
// These tests lock the fix: the key is clean and the ASC/DESC dir is preserved.
describe('SqlParser window frame clause does not pollute orderBy', () => {
  it('strips ROWS BETWEEN from orderBy key (ASC)', () => {
    const wfs = extractWindowFunctions(
      'SELECT SUM(x) OVER (PARTITION BY dept ORDER BY sal ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t',
    );
    expect(wfs[0].partitionBy).toEqual(['dept']);
    expect(wfs[0].orderBy).toEqual([{ key: 'sal', dir: 'ASC' }]);
  });

  it('strips ROWS UNBOUNDED PRECEDING from orderBy key', () => {
    const wfs = extractWindowFunctions(
      'SELECT SUM(x) OVER (ORDER BY sal ROWS UNBOUNDED PRECEDING) FROM t',
    );
    expect(wfs[0].orderBy).toEqual([{ key: 'sal', dir: 'ASC' }]);
  });

  it('preserves DESC while stripping RANGE frame', () => {
    const wfs = extractWindowFunctions(
      'SELECT SUM(x) OVER (PARTITION BY dept ORDER BY sal DESC RANGE BETWEEN 2 PRECEDING AND CURRENT ROW) FROM t',
    );
    expect(wfs[0].orderBy).toEqual([{ key: 'sal', dir: 'DESC' }]);
  });
});

describe('SqlParser rewriteWindowSql on frame-clause SQL (fallback)', () => {
  it('does not crash on ROWS BETWEEN and keeps original SQL', () => {
    const sql = 'SELECT SUM(x) OVER (ORDER BY sal ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t';
    expect(rewriteWindowSql(sql)).toBe(sql);
  });
});
