import { describe, it, expect } from 'vitest';
import {
  detectWindowExt,
  rewriteWindowExt,
  detectDenseRank,
  rewriteDenseRank,
} from '../query/WindowFuncShim';

describe('detectWindowExt', () => {
  it('detects GROUPS frame unit', () => {
    expect(
      detectWindowExt('SELECT SUM(x) OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t'),
    ).toBe(true);
    expect(
      detectWindowExt('SELECT SUM(x) OVER (ORDER BY y GROUPS UNBOUNDED PRECEDING) FROM t'),
    ).toBe(true);
    expect(detectWindowExt('SELECT SUM(x) OVER (ORDER BY y GROUPS 3 PRECEDING) FROM t')).toBe(
      true,
    );
    expect(detectWindowExt('SELECT SUM(x) OVER (ORDER BY y GROUPS 2 FOLLOWING) FROM t')).toBe(
      true,
    );
    expect(detectWindowExt('SELECT SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW) FROM t')).toBe(
      true,
    );
  });
  it('detects EXCLUDE clauses', () => {
    expect(
      detectWindowExt('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE CURRENT ROW) FROM t'),
    ).toBe(true);
    expect(
      detectWindowExt('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE GROUP) FROM t'),
    ).toBe(true);
    expect(
      detectWindowExt('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE TIES) FROM t'),
    ).toBe(true);
  });
  it('does not detect plain ROWS frame', () => {
    expect(
      detectWindowExt('SELECT SUM(x) OVER (ORDER BY y ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t'),
    ).toBe(false);
  });
  it('does not detect GROUPS in a string literal', () => {
    expect(detectWindowExt("SELECT 'GROUPS BETWEEN 1 AND 2' FROM t")).toBe(false);
  });
  it('does not detect EXCLUDE in a comment', () => {
    expect(detectWindowExt('-- EXCLUDE CURRENT ROW\nSELECT 1')).toBe(false);
  });
  it('does not detect GROUPS in a double-quoted identifier', () => {
    expect(detectWindowExt('SELECT x FROM t WHERE a = "GROUPS UNBOUNDED PRECEDING"')).toBe(false);
  });
  it('does not detect EXCLUDE in a string literal', () => {
    expect(detectWindowExt("SELECT 'EXCLUDE GROUP' FROM t")).toBe(false);
  });
  it('does not detect EXCLUDE NO OTHERS (not in detect scope)', () => {
    expect(detectWindowExt('SELECT 1 EXCLUDE NO OTHERS')).toBe(false);
  });
  it('does not detect GROUPS as a plain identifier', () => {
    expect(detectWindowExt('SELECT * FROM groups_table')).toBe(false);
  });
  it('rejects null / undefined / blank', () => {
    expect(detectWindowExt(null as unknown as string)).toBe(false);
    expect(detectWindowExt(undefined as unknown as string)).toBe(false);
    expect(detectWindowExt('   ')).toBe(false);
  });
});

describe('rewriteWindowExt', () => {
  it('rewrites GROUPS → ROWS', () => {
    const r = rewriteWindowExt(
      'SELECT SUM(x) OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING');
    expect(r.sql).toContain('WARNING: GROUPS rewritten to ROWS');
  });
  it('strips EXCLUDE CURRENT ROW', () => {
    const r = rewriteWindowExt(
      'SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE CURRENT ROW) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING) FROM t');
  });
  it('strips EXCLUDE GROUP', () => {
    const r = rewriteWindowExt(
      'SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE GROUP) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING) FROM t');
  });
  it('strips EXCLUDE TIES', () => {
    const r = rewriteWindowExt(
      'SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE TIES) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING) FROM t');
  });
  it('strips EXCLUDE GROUP at the end of the string', () => {
    const r = rewriteWindowExt('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE GROUP');
    expect(r.sql).toBe('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING');
  });
  it('leaves plain ROWS frame unchanged', () => {
    const r = rewriteWindowExt(
      'SELECT SUM(x) OVER (ORDER BY y ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t',
    );
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT SUM(x) OVER (ORDER BY y ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t');
  });
  it('does not rewrite a string literal', () => {
    const r = rewriteWindowExt("SELECT 'GROUPS BETWEEN 1 AND 2' FROM t");
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe("SELECT 'GROUPS BETWEEN 1 AND 2' FROM t");
  });
  it('does not rewrite a comment', () => {
    const r = rewriteWindowExt('-- EXCLUDE CURRENT ROW\nSELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('-- EXCLUDE CURRENT ROW\nSELECT 1');
  });
  it('does not rewrite a double-quoted identifier', () => {
    const r = rewriteWindowExt('SELECT x FROM t WHERE a = "GROUPS UNBOUNDED PRECEDING"');
    expect(r.rewritten).toBe(false);
  });
  it('handles GROUPS plus EXCLUDE together', () => {
    const r = rewriteWindowExt(
      'SELECT SUM(x) OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE CURRENT ROW) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING');
    expect(r.sql).not.toContain('EXCLUDE');
  });
  it('strips EXCLUDE NO OTHERS', () => {
    const r = rewriteWindowExt(
      'SELECT SUM(x) OVER (ORDER BY y GROUPS UNBOUNDED PRECEDING EXCLUDE NO OTHERS) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('EXCLUDE');
  });
  it('does not strip an unknown EXCLUDE option', () => {
    const r = rewriteWindowExt(
      'SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE BOGUS) FROM t',
    );
    expect(r.sql).toContain('EXCLUDE BOGUS');
  });
  it('does not treat a bare GROUPS identifier as a frame unit', () => {
    const r = rewriteWindowExt('SELECT GROUPS FROM t');
    expect(r.sql).toBe('SELECT GROUPS FROM t');
  });
  it('does not treat GROUPS directly before a closing paren as a frame unit', () => {
    expect(detectWindowExt('SELECT SUM(x) OVER (GROUPS) FROM t')).toBe(false);
  });
  it('rewrites GROUPS when a literal precedes it', () => {
    const r = rewriteWindowExt(
      "SELECT SUM(x) OVER (PARTITION BY 'a b' ORDER BY y GROUPS 1 PRECEDING) FROM t",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'a b'");
    expect(r.sql).toContain('ROWS 1 PRECEDING');
  });
  it('passes through null / undefined / blank', () => {
    expect(rewriteWindowExt(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteWindowExt(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteWindowExt('   ')).toEqual({ sql: '   ', rewritten: false });
  });
});

describe('detectDenseRank', () => {
  it('detects DENSE_RANK() calls', () => {
    expect(detectDenseRank('SELECT DENSE_RANK() OVER (ORDER BY score) FROM t')).toBe(true);
  });
  it('does not detect a string literal', () => {
    expect(detectDenseRank("SELECT 'DENSE_RANK()' FROM t")).toBe(false);
  });
  it('does not detect a comment', () => {
    expect(detectDenseRank('-- DENSE_RANK()\nSELECT 1')).toBe(false);
  });
  it('rejects null / undefined / blank', () => {
    expect(detectDenseRank(null as unknown as string)).toBe(false);
    expect(detectDenseRank(undefined as unknown as string)).toBe(false);
    expect(detectDenseRank('   ')).toBe(false);
  });
});

describe('rewriteDenseRank', () => {
  it('rewrites simple single-column ORDER BY', () => {
    const r = rewriteDenseRank('SELECT DENSE_RANK() OVER (ORDER BY score) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe(
      'SELECT (SELECT COUNT(DISTINCT "score") FROM "t" AS "t_dr" WHERE "t_dr"."score" <= "t"."score") FROM t',
    );
  });
  it('handles DESC order', () => {
    const r = rewriteDenseRank('SELECT DENSE_RANK() OVER (ORDER BY score DESC) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('>=');
  });
  it('falls back to ROW_NUMBER for complex OVER clause', () => {
    const r = rewriteDenseRank('SELECT DENSE_RANK() OVER (PARTITION BY g ORDER BY score) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT ROW_NUMBER() OVER (PARTITION BY g ORDER BY score) FROM t');
  });
  it('falls back to ROW_NUMBER when no FROM clause', () => {
    const r = rewriteDenseRank('SELECT DENSE_RANK() OVER (ORDER BY score)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT ROW_NUMBER() OVER (ORDER BY score)');
  });
  it('leaves a non-empty DENSE_RANK arg list untouched', () => {
    // DENSE_RANK(x) is not a valid empty-arg call; overMatch and fallback both
    // fail to replace it, so it remains verbatim (rewritten flag reflects this).
    const r = rewriteDenseRank('SELECT DENSE_RANK(x) OVER (ORDER BY score) FROM t');
    expect(r.sql).toBe('SELECT DENSE_RANK(x) OVER (ORDER BY score) FROM t');
  });
  it('does not rewrite a string literal', () => {
    const r = rewriteDenseRank("SELECT 'DENSE_RANK()' FROM t");
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe("SELECT 'DENSE_RANK()' FROM t");
  });
  it('does not rewrite a comment', () => {
    const r = rewriteDenseRank('-- DENSE_RANK()\nSELECT 1');
    expect(r.rewritten).toBe(false);
  });
  it('passes through null / blank', () => {
    expect(rewriteDenseRank(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteDenseRank('   ')).toEqual({ sql: '   ', rewritten: false });
  });
});
