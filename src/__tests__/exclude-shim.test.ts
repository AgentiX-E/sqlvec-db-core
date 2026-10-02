import { describe, it, expect } from 'vitest';
import { detectExclude, rewriteExclude } from '../query/ExcludeShim';

describe('detectExclude', () => {
  it('detects EXCLUDE CURRENT ROW', () => {
    expect(detectExclude('SELECT SUM(x) OVER (ROWS 5 PRECEDING EXCLUDE CURRENT ROW) FROM t')).toBe(true);
  });
  it('detects EXCLUDE GROUP', () => {
    expect(detectExclude('SELECT SUM(x) OVER (ORDER BY y EXCLUDE GROUP) FROM t')).toBe(true);
  });
  it('detects EXCLUDE TIES', () => {
    expect(detectExclude('SELECT SUM(x) OVER (ORDER BY y EXCLUDE TIES) FROM t')).toBe(true);
  });
  it('detects EXCLUDE NO OTHERS', () => {
    expect(detectExclude('SELECT SUM(x) OVER (ORDER BY y EXCLUDE NO OTHERS) FROM t')).toBe(true);
  });
  it('does not detect inside a string literal', () => {
    expect(detectExclude("SELECT 'EXCLUDE CURRENT ROW' FROM t")).toBe(false);
  });
  it('does not detect inside a comment', () => {
    expect(detectExclude('-- EXCLUDE GROUP\nSELECT 1')).toBe(false);
    expect(detectExclude('/* EXCLUDE TIES */ SELECT 1')).toBe(false);
  });
  it('returns false for unrelated SQL', () => {
    expect(detectExclude('SELECT 1 FROM t')).toBe(false);
  });
  it('rejects null / undefined / blank', () => {
    expect(detectExclude('')).toBe(false);
    expect(detectExclude('   ')).toBe(false);
    expect(detectExclude(null as unknown as string)).toBe(false);
    expect(detectExclude(undefined as unknown as string)).toBe(false);
  });
});

describe('rewriteExclude — EXCLUDE CURRENT ROW (arithmetic)', () => {
  it('rewrites SUM with arithmetic adjustment', () => {
    const r = rewriteExclude('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE CURRENT ROW) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT COALESCE(SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING), 0) - COALESCE(x, 0) FROM t');
  });
  it('rewrites COUNT(*)', () => {
    const r = rewriteExclude('SELECT COUNT(*) OVER (RANGE UNBOUNDED PRECEDING EXCLUDE CURRENT ROW) FROM t');
    expect(r.sql).toBe('SELECT COUNT(*) OVER (RANGE UNBOUNDED PRECEDING) - 1 FROM t');
  });
  it('rewrites COUNT(col) with NULL guard', () => {
    const r = rewriteExclude('SELECT COUNT(c) OVER (ROWS 3 PRECEDING EXCLUDE CURRENT ROW) FROM t');
    expect(r.sql).toContain('COUNT(c) OVER (ROWS 3 PRECEDING) - CASE WHEN c IS NOT NULL THEN 1 ELSE 0 END');
  });
  it('rewrites AVG', () => {
    const r = rewriteExclude('SELECT AVG(x) OVER (ROWS 3 PRECEDING EXCLUDE CURRENT ROW) FROM t');
    expect(r.sql).toContain('CAST(COALESCE(SUM(x) OVER (ROWS 3 PRECEDING), 0) - COALESCE(x, 0) AS REAL)');
  });
  it('rewrites a nested aggregate argument', () => {
    const r = rewriteExclude('SELECT SUM(f(a,b)) OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT COALESCE(SUM(f(a,b)) OVER (ORDER BY y), 0) - COALESCE(f(a,b), 0) FROM t');
  });
  it('rewrites SUM(COALESCE(x, 0))', () => {
    const r = rewriteExclude('SELECT SUM(COALESCE(x, 0)) OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t');
    expect(r.sql).toBe('SELECT COALESCE(SUM(COALESCE(x, 0)) OVER (ORDER BY y), 0) - COALESCE(COALESCE(x, 0), 0) FROM t');
  });
  it('rewrites SUM(price * qty)', () => {
    const r = rewriteExclude('SELECT SUM(price * qty) OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t');
    expect(r.sql).toBe('SELECT COALESCE(SUM(price * qty) OVER (ORDER BY y), 0) - COALESCE(price * qty, 0) FROM t');
  });
  it('rewrites multiple window functions', () => {
    const r = rewriteExclude('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE CURRENT ROW), SUM(y) OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t');
    expect(r.sql).toBe('SELECT COALESCE(SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING), 0) - COALESCE(x, 0), COALESCE(SUM(y) OVER (ORDER BY y), 0) - COALESCE(y, 0) FROM t');
  });
});

describe('rewriteExclude — EXCLUDE GROUP / TIES (CTE)', () => {
  it('rewrites EXCLUDE GROUP with DENSE_RANK + peer exclusion', () => {
    const r = rewriteExclude('SELECT SUM(x) OVER (ORDER BY y EXCLUDE GROUP) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('sub.__exc_grp_0 <> __exc_cte_0.__exc_grp_0');
    expect(r.sql).toContain('DENSE_RANK() OVER ( ORDER BY y)');
  });
  it('rewrites EXCLUDE TIES keeping the current row', () => {
    const r = rewriteExclude('SELECT SUM(x) OVER (ORDER BY y EXCLUDE TIES) FROM t');
    expect(r.sql).toContain('sub.__exc_grp_0 <> __exc_cte_0.__exc_grp_0 OR sub.rowid = __exc_cte_0.rowid');
  });
  it('rewrites EXCLUDE GROUP with a nested argument', () => {
    const r = rewriteExclude('SELECT SUM(f(a,b)) OVER (ORDER BY y EXCLUDE GROUP) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('SUM(sub.f(a,b))');
  });
  it('rewrites with PARTITION BY filter', () => {
    const r = rewriteExclude('SELECT MAX(COALESCE(x,0)) OVER (PARTITION BY p ORDER BY y EXCLUDE GROUP) FROM t');
    expect(r.sql).toContain('sub.p = __exc_cte_0.p AND sub.__exc_grp_0 <> __exc_cte_0.__exc_grp_0');
  });
  it('rewrites MIN / COUNT / AVG', () => {
    expect(rewriteExclude('SELECT MIN(x) OVER (ORDER BY y EXCLUDE TIES) FROM t').sql).toContain('MIN(sub.x)');
    expect(rewriteExclude('SELECT COUNT(c) OVER (ORDER BY y EXCLUDE GROUP) FROM t').sql).toContain('COUNT(sub.c)');
    expect(rewriteExclude('SELECT AVG(x) OVER (ORDER BY y EXCLUDE TIES) FROM t').sql).toContain('SUM(sub.x)');
  });
  it('strips EXCLUDE GROUP when there is no ORDER BY', () => {
    const r = rewriteExclude('SELECT SUM(x) OVER (EXCLUDE GROUP) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT SUM(x) OVER () FROM t');
  });
  it('strips EXCLUDE TIES with PARTITION only', () => {
    const r = rewriteExclude('SELECT MIN(x) OVER (PARTITION BY p EXCLUDE TIES) FROM t');
    expect(r.sql).toBe('SELECT MIN(x) OVER (PARTITION BY p) FROM t');
  });
});

describe('rewriteExclude — EXCLUDE NO OTHERS / fallback', () => {
  it('strips EXCLUDE NO OTHERS', () => {
    const r = rewriteExclude('SELECT SUM(x) OVER (ORDER BY y EXCLUDE NO OTHERS) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT SUM(x) OVER (ORDER BY y) FROM t');
  });
  it('falls back to stripping for a non-simple aggregate with GROUPS frame', () => {
    // GROUPS frame is handled upstream; the arithmetic path skips it, so it falls
    // through to the warning-strip fallback.
    const r = rewriteExclude('SELECT SUM(x) OVER (ORDER BY y GROUPS 2 PRECEDING EXCLUDE CURRENT ROW) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WARNING');
  });
  it('leaves a string literal untouched', () => {
    const r = rewriteExclude("SELECT 'EXCLUDE CURRENT ROW' FROM t");
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe("SELECT 'EXCLUDE CURRENT ROW' FROM t");
  });
  it('leaves a comment untouched', () => {
    const r = rewriteExclude('-- EXCLUDE GROUP\nSELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('-- EXCLUDE GROUP\nSELECT 1');
  });
  it('returns unchanged for non-string / blank', () => {
    expect(rewriteExclude('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteExclude(null as unknown as string)).toEqual({ sql: null as unknown as string, rewritten: false });
  });
  it('does not rewrite when there is no EXCLUDE clause', () => {
    expect(rewriteExclude('SELECT 1 FROM t')).toEqual({ sql: 'SELECT 1 FROM t', rewritten: false });
  });
});

describe('rewriteExclude — malformed / defensive branches', () => {
  it('handles a comment inside the OVER clause scanning', () => {
    // Trigger skipSqlLiteral in rewriteExcludeCurrentRow scanning.
    const r = rewriteExclude("SELECT SUM('x') OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("COALESCE(SUM('x')");
  });
  it('skips a non-aggregate function call', () => {
    const r = rewriteExclude('SELECT foo(x) OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t');
    expect(r.sql).toContain('WARNING');
  });
  it('handles SUM without following OVER', () => {
    const r = rewriteExclude('SELECT SUM(x) EXCLUDE CURRENT ROW FROM t');
    expect(r.sql).toContain('WARNING');
  });
  it('handles an OVER clause without EXCLUDE', () => {
    const r = rewriteExclude('SELECT SUM(x) OVER (ROWS 1 PRECEDING) FROM t');
    expect(r.rewritten).toBe(false);
  });
  it('handles a GROUP/TIES scan encountering CURRENT ROW', () => {
    // EXCLUDE CURRENT ROW is skipped in the GroupTies scanner.
    const r = rewriteExclude('SELECT SUM(x) OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('COALESCE(SUM(x)');
  });
  it('handles COUNT with * and 1 arguments in CTE path', () => {
    expect(rewriteExclude('SELECT COUNT(*) OVER (ORDER BY y EXCLUDE GROUP) FROM t').sql).toContain('COUNT(*)');
    expect(rewriteExclude('SELECT COUNT(1) OVER (ORDER BY y EXCLUDE GROUP) FROM t').sql).toContain('COUNT(*)');
  });
  it('handles a literal inside the aggregate argument of a GROUP scan', () => {
    const r = rewriteExclude("SELECT SUM(trim(' x ')) OVER (ORDER BY y EXCLUDE GROUP) FROM t");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("SUM(sub.trim(' x '))");
  });
  it('handles SUM with no opening paren', () => {
    expect(rewriteExclude('SELECT SUM x OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t').sql).toContain('WARNING');
  });
  it('handles SUM with unbalanced arg paren', () => {
    expect(rewriteExclude('SELECT SUM(x OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t').sql).toContain('WARNING');
  });
  it('handles OVER not followed by paren', () => {
    expect(rewriteExclude('SELECT SUM(x) OVER x EXCLUDE CURRENT ROW FROM t').sql).toContain('WARNING');
  });
  it('handles OVER with unbalanced paren', () => {
    expect(rewriteExclude('SELECT SUM(x) OVER (ORDER BY y EXCLUDE CURRENT ROW FROM t').sql).toContain('WARNING');
  });
  it('handles SELECT with no FROM in GROUP path', () => {
    const r = rewriteExclude('SELECT SUM(x) OVER (ORDER BY y EXCLUDE GROUP)');
    expect(r.sql).toContain('WARNING');
  });
  it('handles a literal before a window function in the SELECT list', () => {
    const r = rewriteExclude("SELECT 'lit', SUM(y) OVER (ORDER BY y EXCLUDE GROUP) FROM t");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'lit'");
  });
  it('handles a paren inside a literal in the argument', () => {
    const r = rewriteExclude("SELECT SUM(a || ')') OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("a || ')'");
  });
  it('skips a window function without EXCLUDE while another has it', () => {
    const r = rewriteExclude('SELECT AVG(x) OVER (ROWS 1 PRECEDING), SUM(y) OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('AVG(x) OVER (ROWS 1 PRECEDING)');
    expect(r.sql).toContain('COALESCE(SUM(y)');
  });
  it('handles GROUP scan hitting a non-paren after function name', () => {
    expect(rewriteExclude('SELECT SUM x OVER (ORDER BY y EXCLUDE GROUP) FROM t').sql).toContain('WARNING');
  });
  it('handles GROUP scan with OVER not followed by paren', () => {
    expect(rewriteExclude('SELECT SUM(x) OVER x EXCLUDE GROUP FROM t').sql).toContain('WARNING');
  });
  it('handles a non-paren after function name in GROUP scan', () => {
    expect(rewriteExclude('SELECT MIN x OVER (ORDER BY y EXCLUDE GROUP) FROM t').sql).toContain('WARNING');
  });
  it('handles GROUP scan missing OVER keyword', () => {
    expect(rewriteExclude('SELECT MIN(x) EXCLUDE GROUP FROM t').sql).toContain('WARNING');
  });
  it('handles GROUP scan with unbalanced over paren', () => {
    expect(rewriteExclude('SELECT MIN(x) OVER (ORDER BY y EXCLUDE GROUP FROM t').sql).toContain('WARNING');
  });
  it('handles a window fn in GROUP scan lacking EXCLUDE', () => {
    const r = rewriteExclude('SELECT MIN(x) OVER (ORDER BY y), SUM(y) OVER (ORDER BY y EXCLUDE GROUP) FROM t');
    expect(r.rewritten).toBe(true);
  });
  it('skips CURRENT ROW when scanning for GROUP in a mixed list', () => {
    // MIN with EXCLUDE CURRENT ROW is untouched by the arithmetic path (MIN is
    // not SUM/AVG/COUNT), so the GROUP scanner encounters and skips it.
    const r = rewriteExclude('SELECT MIN(x) OVER (ORDER BY y EXCLUDE CURRENT ROW), SUM(y) OVER (ORDER BY y EXCLUDE GROUP) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('SUM(sub.y)');
  });
  it('strips EXCLUDE GROUP with an outer ORDER BY tail and no window ORDER BY', () => {
    const r = rewriteExclude('SELECT SUM(x) OVER (EXCLUDE GROUP) FROM t ORDER BY z');
    expect(r.sql).toBe('SELECT SUM(x) OVER () FROM t ORDER BY z');
  });
});

describe('rewriteExclude — non-simple / edge inputs', () => {
  it('does not rewrite a non-SELECT statement', () => {
    const r = rewriteExclude('UPDATE t SET x = SUM(x) OVER (ORDER BY y EXCLUDE GROUP)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WARNING');
  });
  it('handles EXCLUDE GROUP with an outer ORDER BY tail', () => {
    const r = rewriteExclude('SELECT SUM(x) OVER (ORDER BY y EXCLUDE GROUP) FROM t ORDER BY z');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ORDER BY z');
  });
  it('handles EXCLUDE GROUP with LIMIT tail', () => {
    const r = rewriteExclude('SELECT SUM(x) OVER (ORDER BY y EXCLUDE GROUP) FROM t LIMIT 10');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('LIMIT 10');
  });
  it('handles a dollar-quoted literal containing EXCLUDE', () => {
    const r = rewriteExclude("SELECT $$ EXCLUDE CURRENT ROW $$ FROM t");
    expect(r.rewritten).toBe(false);
  });
  it('handles unbalanced paren gracefully', () => {
    const r = rewriteExclude('SELECT SUM(x OVER (ORDER BY y EXCLUDE GROUP FROM t');
    expect(r.sql).toBeDefined();
  });
});
