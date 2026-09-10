import { describe, it, expect } from 'vitest';
import { rewriteWindowSql } from '../query/SqlParser';

// rewriteWindowSql returns non-SELECT statements unchanged (no `columns`), and
// only strips OVER from aggregate window functions, leaving ranking functions
// intact for shard-local execution.
describe('SqlParser rewriteWindowSql', () => {
  it('returns non-SELECT statements unchanged', () => {
    expect(rewriteWindowSql('INSERT INTO t VALUES (1)')).toBe('INSERT INTO t VALUES (1)');
    expect(rewriteWindowSql('UPDATE t SET x=1')).toBe('UPDATE t SET x=1');
  });

  it('returns a SELECT with no window function unchanged', () => {
    expect(rewriteWindowSql('SELECT * FROM t')).toBe('SELECT * FROM t');
  });

  it('strips OVER from an aggregate window function', () => {
    const out = rewriteWindowSql('SELECT SUM(x) OVER (ORDER BY y) FROM t');
    expect(out).toMatch(/sum\s*\(\s*x\s*\)/i);
    expect(out).not.toMatch(/OVER/i);
  });

  it('preserves OVER for a ranking window function', () => {
    expect(rewriteWindowSql('SELECT row_number() OVER (ORDER BY y) FROM t')).toMatch(/OVER/i);
  });
});
