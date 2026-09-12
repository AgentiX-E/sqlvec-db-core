import { describe, it, expect } from 'vitest';
import { detectPoolSql, rewritePoolSql } from '../query/ConnectionPoolShim';
import { detectTDE, rewriteTDE, detectTDESql, detectSetTDE } from '../query/TDEShim';

// These shims are intentional stubs: the corresponding PostgreSQL features are
// not yet implemented at the SQL-rewrite layer, so every detector reports "not
// present" and every rewriter returns the input unchanged. This test locks that
// contract so a future accidental partial implementation (or a detector that
// starts reporting false positives) is caught immediately.
describe('stub shims (contract lock)', () => {
  it('ConnectionPoolShim detectors always report no match', () => {
    expect(detectPoolSql()).toBe(false);
  });

  it('ConnectionPoolShim rewriter is a pass-through', () => {
    const sql = 'SELECT 1';
    expect(rewritePoolSql(sql)).toEqual({ sql, rewritten: false });
  });

  it('TDEShim detectors always report no match', () => {
    expect(detectTDE()).toBe(false);
    expect(detectTDESql()).toBe(false);
    expect(detectSetTDE()).toBe(false);
  });

  it('TDEShim rewriter is a pass-through', () => {
    const sql = 'SELECT 1';
    expect(rewriteTDE(sql)).toEqual({ sql, rewritten: false });
  });
});
