import { describe, it, expect } from 'vitest';
import { detectAggFunc, rewriteAggFunc } from '../query/AggregateFuncShim';

describe('detectAggFunc', () => {
  it('returns false for empty / non-string / blank', () => {
    expect(detectAggFunc('')).toBe(false);
    expect(detectAggFunc('   ')).toBe(false);
    expect(detectAggFunc(null as unknown as string)).toBe(false);
    expect(detectAggFunc(undefined as unknown as string)).toBe(false);
  });

  it('detects every supported function', () => {
    const fns = [
      'bool_and', 'bool_or', 'every', 'stddev_pop', 'stddev_samp', 'var_pop',
      'var_samp', 'covar_pop', 'covar_samp', 'corr', 'regr_avgx', 'regr_avgy',
      'regr_count', 'regr_intercept', 'regr_r2', 'regr_slope', 'regr_sxx',
      'regr_sxy', 'regr_syy',
    ];
    for (const fn of fns) {
      const arity = fn.includes('bool') || fn === 'every' || fn.startsWith('stddev') || fn.startsWith('var_')
        ? `(x)`
        : `(y, x)`;
      expect(detectAggFunc(`SELECT ${fn}${arity} FROM t`), fn).toBe(true);
    }
  });

  it('does not detect inside a string literal', () => {
    expect(detectAggFunc("SELECT 'bool_and(x)' FROM t")).toBe(false);
  });

  it('does not detect inside a comment', () => {
    expect(detectAggFunc('-- corr(a,b)\nSELECT 1')).toBe(false);
    expect(detectAggFunc('/* every(x) */ SELECT 1')).toBe(false);
  });

  it('does not detect a longer identifier sharing a prefix', () => {
    expect(detectAggFunc('SELECT bool_and_x(col) FROM t')).toBe(false);
    expect(detectAggFunc('SELECT correlation(a,b) FROM t')).toBe(false);
  });

  it('detects case-insensitively', () => {
    expect(detectAggFunc('SELECT BOOL_AND(x) FROM t')).toBe(true);
    expect(detectAggFunc('SELECT Corr(a, b) FROM t')).toBe(true);
  });
});

describe('rewriteAggFunc', () => {
  it('returns unchanged for empty / non-string / blank', () => {
    expect(rewriteAggFunc('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteAggFunc(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteAggFunc(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteAggFunc('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites bool_and', () => {
    const r = rewriteAggFunc('SELECT bool_and(active) FROM users');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT MIN(CASE WHEN (active) THEN 1 ELSE 0 END) = 1 FROM users');
  });

  it('rewrites bool_or', () => {
    const r = rewriteAggFunc('SELECT bool_or(active) FROM users');
    expect(r.sql).toContain('MAX(CASE WHEN (active) THEN 1 ELSE 0 END) = 1');
  });

  it('rewrites every', () => {
    const r = rewriteAggFunc('SELECT every(active) FROM users');
    expect(r.sql).toContain('MIN(CASE WHEN (active) THEN 1 ELSE 0 END) = 1');
  });

  it('rewrites stddev_pop', () => {
    const r = rewriteAggFunc('SELECT stddev_pop(salary) FROM e');
    expect(r.sql).toContain('SQRT(AVG((salary)*(salary)) - AVG(salary)*AVG(salary))');
  });

  it('rewrites stddev_samp', () => {
    const r = rewriteAggFunc('SELECT stddev_samp(salary) FROM e');
    expect(r.sql).toContain('SQRT((SUM((salary)*(salary)) - SUM(salary)*SUM(salary)/CAST(COUNT(salary) AS REAL))');
  });

  it('rewrites var_pop', () => {
    const r = rewriteAggFunc('SELECT var_pop(salary) FROM e');
    expect(r.sql).toContain('(AVG((salary)*(salary)) - AVG(salary)*AVG(salary))');
  });

  it('rewrites var_samp', () => {
    const r = rewriteAggFunc('SELECT var_samp(salary) FROM e');
    expect(r.sql).toContain('(SUM((salary)*(salary)) - SUM(salary)*SUM(salary)/CAST(COUNT(salary) AS REAL))');
  });

  it('rewrites covar_pop with two args', () => {
    const r = rewriteAggFunc('SELECT covar_pop(y, x) FROM t');
    expect(r.sql).toContain('(AVG(y*x) - AVG(y)*AVG(x))');
  });

  it('rewrites covar_samp', () => {
    const r = rewriteAggFunc('SELECT covar_samp(y, x) FROM t');
    expect(r.sql).toContain('((AVG(y*x) - AVG(y)*AVG(x)) * CAST(COUNT(*) AS REAL)');
  });

  it('rewrites corr', () => {
    const r = rewriteAggFunc('SELECT corr(a, b) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('SQRT(MAX(');
    expect(r.sql).toContain('SUM(a*b)');
  });

  it('rewrites regr_avgx / regr_avgy', () => {
    expect(rewriteAggFunc('SELECT regr_avgx(y, x) FROM t').sql).toContain('AVG(x)');
    expect(rewriteAggFunc('SELECT regr_avgy(y, x) FROM t').sql).toContain('AVG(y)');
  });

  it('rewrites regr_count', () => {
    const r = rewriteAggFunc('SELECT regr_count(y, x) FROM t');
    expect(r.sql).toContain('COUNT(CASE WHEN y IS NOT NULL AND x IS NOT NULL THEN 1 END)');
  });

  it('rewrites regr_intercept', () => {
    const r = rewriteAggFunc('SELECT regr_intercept(y, x) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('AVG(y)');
    expect(r.sql).toContain('SUM(y*x)');
  });

  it('rewrites regr_r2', () => {
    const r = rewriteAggFunc('SELECT regr_r2(y, x) FROM t');
    expect(r.sql).toContain('POWER(');
    expect(r.sql).toContain('SUM(y*y)');
  });

  it('rewrites regr_slope', () => {
    const r = rewriteAggFunc('SELECT regr_slope(y, x) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('SUM(y*x)');
  });

  it('rewrites regr_sxx / regr_sxy / regr_syy', () => {
    expect(rewriteAggFunc('SELECT regr_sxx(y, x) FROM t').sql).toContain('SUM(x*x)');
    expect(rewriteAggFunc('SELECT regr_sxy(y, x) FROM t').sql).toContain('SUM(x*y)');
    expect(rewriteAggFunc('SELECT regr_syy(y, x) FROM t').sql).toContain('SUM(y*y)');
  });

  it('does not touch a string literal containing a function', () => {
    expect(rewriteAggFunc("SELECT 'bool_and(x)' FROM t")).toEqual({
      sql: "SELECT 'bool_and(x)' FROM t",
      rewritten: false,
    });
  });

  it('does not touch a comment containing a function', () => {
    expect(rewriteAggFunc('-- corr(a,b)\nSELECT 1')).toEqual({
      sql: '-- corr(a,b)\nSELECT 1',
      rewritten: false,
    });
  });

  it('handles nested parentheses in a single-arg function', () => {
    const r = rewriteAggFunc('SELECT bool_and((a AND b) OR c) FROM t');
    expect(r.sql).toBe('SELECT MIN(CASE WHEN ((a AND b) OR c) THEN 1 ELSE 0 END) = 1 FROM t');
  });

  it('handles nested parentheses in two-arg functions', () => {
    const r = rewriteAggFunc('SELECT covar_pop(y, f(x)) FROM t');
    expect(r.sql).toContain('AVG(y*f(x))');
    expect(r.sql).toContain('AVG(f(x))');
  });

  it('handles a multi-function query (multiple rewrites)', () => {
    const r = rewriteAggFunc('SELECT bool_and(a), stddev_pop(b) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('MIN(CASE WHEN (a) THEN 1 ELSE 0 END) = 1');
    expect(r.sql).toContain('SQRT(AVG((b)*(b)) - AVG(b)*AVG(b))');
  });

  it('does not rewrite a longer identifier sharing a prefix', () => {
    expect(rewriteAggFunc('SELECT bool_and_x(col) FROM t')).toEqual({
      sql: 'SELECT bool_and_x(col) FROM t',
      rewritten: false,
    });
    expect(rewriteAggFunc('SELECT correlation(a,b) FROM t')).toEqual({
      sql: 'SELECT correlation(a,b) FROM t',
      rewritten: false,
    });
  });

  it('trims whitespace around arguments', () => {
    const r = rewriteAggFunc('SELECT covar_pop( y , x ) FROM t');
    expect(r.sql).toContain('AVG(y*x)');
  });

  it('leaves unbalanced input untouched', () => {
    // `bool_and(col` — no closing parenthesis. Scanner bails without corrupting.
    const input = 'SELECT bool_and(col)';
    // balanced case is rewritten; unbalanced case leaves the tail intact.
    expect(rewriteAggFunc(input).rewritten).toBe(true);
  });

  it('leaves unbalanced function calls untouched', () => {
    const input = 'SELECT bool_and(a, b)';
    // balanced here; truly unbalanced is:
    expect(rewriteAggFunc('SELECT bool_and(col').sql).toBe('SELECT bool_and(col');
    expect(rewriteAggFunc('SELECT bool_and(col').rewritten).toBe(false);
  });

  it('skips a call with the wrong number of arguments', () => {
    // corr expects 2 args; a 3-arg call is not a valid match and is left alone.
    expect(rewriteAggFunc('SELECT corr(a, b, c) FROM t').rewritten).toBe(false);
    // bool_and expects 1 arg; an empty call is left alone.
    expect(rewriteAggFunc('SELECT bool_and() FROM t').rewritten).toBe(false);
  });

  it('honors parentheses inside string literals within arguments', () => {
    // A `)` inside a literal must not terminate an enclosing function early.
    const r = rewriteAggFunc("SELECT bool_and(x = ')') FROM t");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("CASE WHEN (x = ')')");
  });

  it('honors commas inside string literals within two-arg functions', () => {
    const r = rewriteAggFunc("SELECT covar_pop(y, 'a,b') FROM t");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'a,b'");
  });

  it('handles a trailing empty argument in split', () => {
    // covar_pop(y,) — trailing comma yields a short arg list and is skipped.
    expect(rewriteAggFunc('SELECT covar_pop(y,) FROM t').rewritten).toBe(false);
  });
});
