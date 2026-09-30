import { describe, it, expect } from 'vitest';
import { detectAggFunc, rewriteAggFunc } from '../query/AggFuncShim';

describe('detectAggFunc', () => {
  it('returns false for empty / non-string / blank', () => {
    expect(detectAggFunc('')).toBe(false);
    expect(detectAggFunc('   ')).toBe(false);
    expect(detectAggFunc(null as unknown as string)).toBe(false);
  });

  it('detects each supported function', () => {
    const fns = [
      'bool_and(x)', 'bool_or(x)', 'every(x)',
      'stddev(x)', 'stddev_pop(x)', 'stddev_samp(x)',
      'var_pop(x)', 'var_samp(x)',
      'covar_pop(y,x)', 'covar_samp(y,x)', 'corr(y,x)',
      'regr_avgx(y,x)', 'regr_avgy(y,x)', 'regr_count(y,x)',
      'regr_intercept(y,x)', 'regr_r2(y,x)', 'regr_slope(y,x)',
      'regr_sxx(y,x)', 'regr_sxy(y,x)', 'regr_syy(y,x)',
      "string_agg(x, ',')", 'array_agg(x)', 'array_agg(DISTINCT x)',
    ];
    for (const fn of fns) {
      expect(detectAggFunc(`SELECT ${fn} FROM t`), fn).toBe(true);
    }
  });

  it('detects WITHIN GROUP functions', () => {
    expect(detectAggFunc('SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) FROM t')).toBe(true);
    expect(detectAggFunc('SELECT PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY x) FROM t')).toBe(true);
    expect(detectAggFunc('SELECT MODE() WITHIN GROUP (ORDER BY x) FROM t')).toBe(true);
  });

  it('ignores occurrences inside string literals', () => {
    expect(detectAggFunc("SELECT 'bool_and(x)' FROM t")).toBe(false);
  });

  it('ignores occurrences inside comments', () => {
    expect(detectAggFunc('-- array_agg(x)\nSELECT 1')).toBe(false);
    expect(detectAggFunc('/* corr(a,b) */ SELECT 1')).toBe(false);
  });

  it('does not match a longer identifier with the same prefix', () => {
    expect(detectAggFunc('SELECT every_thing FROM t')).toBe(false);
  });
});

describe('rewriteAggFunc — boolean aggregates', () => {
  it('rewrites bool_and', () => {
    expect(rewriteAggFunc('SELECT bool_and(active) FROM t')).toEqual({
      sql: 'SELECT MIN(CASE WHEN (active) THEN 1 ELSE 0 END) = 1 FROM t',
      rewritten: true,
    });
  });
  it('rewrites bool_or', () => {
    expect(rewriteAggFunc('SELECT bool_or(active) FROM t')).toEqual({
      sql: 'SELECT MAX(CASE WHEN (active) THEN 1 ELSE 0 END) = 1 FROM t',
      rewritten: true,
    });
  });
  it('rewrites every', () => {
    expect(rewriteAggFunc('SELECT every(active) FROM t')).toEqual({
      sql: 'SELECT MIN(CASE WHEN (active) THEN 1 ELSE 0 END) = 1 FROM t',
      rewritten: true,
    });
  });
  it('handles a nested boolean expression', () => {
    expect(rewriteAggFunc('SELECT bool_and((a AND b) OR c) FROM t')).toEqual({
      sql: 'SELECT MIN(CASE WHEN ((a AND b) OR c) THEN 1 ELSE 0 END) = 1 FROM t',
      rewritten: true,
    });
  });
});

describe('rewriteAggFunc — scalar statistical aggregates', () => {
  it('rewrites stddev as stddev_samp', () => {
    const out = rewriteAggFunc('SELECT stddev(x) FROM t').sql;
    expect(out).toContain('SQRT((SUM((x)*(x))');
  });
  it('rewrites stddev_pop', () => {
    expect(rewriteAggFunc('SELECT stddev_pop(x) FROM t').sql).toContain('SQRT(AVG((x)*(x))');
  });
  it('rewrites var_pop', () => {
    expect(rewriteAggFunc('SELECT var_pop(x) FROM t').sql).toContain('(AVG((x)*(x)) - AVG(x)*AVG(x))');
  });
  it('rewrites var_samp', () => {
    expect(rewriteAggFunc('SELECT var_samp(x) FROM t').sql).toContain('SUM((x)*(x))');
  });
});

describe('rewriteAggFunc — two-variable aggregates', () => {
  it('rewrites covar_pop', () => {
    expect(rewriteAggFunc('SELECT covar_pop(y, x) FROM t').sql).toBe(
      'SELECT (AVG(y*x) - AVG(y)*AVG(x)) FROM t',
    );
  });
  it('rewrites corr with nested arguments', () => {
    const out = rewriteAggFunc('SELECT corr(g(a), h(b)) FROM t').sql;
    expect(out).toContain('SUM(g(a)*h(b))');
    expect(out).toContain('SUM(h(b))');
  });
  it('rewrites regr_count', () => {
    expect(rewriteAggFunc('SELECT regr_count(y, x) FROM t').sql).toBe(
      'SELECT COUNT(CASE WHEN y IS NOT NULL AND x IS NOT NULL THEN 1 END) FROM t',
    );
  });
  it('rewrites regr_avgx / regr_avgy / regr_sxx / regr_sxy / regr_syy', () => {
    expect(rewriteAggFunc('SELECT regr_avgx(y, x) FROM t').sql).toBe('SELECT AVG(x) FROM t');
    expect(rewriteAggFunc('SELECT regr_avgy(y, x) FROM t').sql).toBe('SELECT AVG(y) FROM t');
    expect(rewriteAggFunc('SELECT regr_sxx(y, x) FROM t').sql).toContain('SUM(x*x)');
    expect(rewriteAggFunc('SELECT regr_sxy(y, x) FROM t').sql).toContain('SUM(x*y)');
    expect(rewriteAggFunc('SELECT regr_syy(y, x) FROM t').sql).toContain('SUM(y*y)');
  });
});

describe('rewriteAggFunc — string_agg', () => {
  it('rewrites two-arg string_agg', () => {
    expect(rewriteAggFunc("SELECT string_agg(name, ',') FROM t").sql).toBe(
      "SELECT GROUP_CONCAT(name, ',') FROM t",
    );
  });
  it('rewrites single-arg string_agg', () => {
    expect(rewriteAggFunc('SELECT string_agg(x) FROM t').sql).toBe(
      'SELECT GROUP_CONCAT(x) FROM t',
    );
  });
  it('rewrites string_agg with ORDER BY', () => {
    const out = rewriteAggFunc("SELECT string_agg(a, ',' ORDER BY b) FROM t").sql;
    expect(out).toContain('json_group_array(a ORDER BY b)');
  });
  it('rewrites two string_agg calls in one statement', () => {
    expect(
      rewriteAggFunc("SELECT string_agg(x, ',') FROM t WHERE string_agg(y, ';') IS NOT NULL").sql,
    ).toBe("SELECT GROUP_CONCAT(x, ',') FROM t WHERE GROUP_CONCAT(y, ';') IS NOT NULL");
  });
  it('leaves an empty string_agg call untouched', () => {
    expect(rewriteAggFunc('SELECT string_agg() FROM t').rewritten).toBe(false);
  });
});

describe('rewriteAggFunc — array_agg', () => {
  it('rewrites plain array_agg', () => {
    expect(rewriteAggFunc('SELECT array_agg(x) FROM t').sql).toBe(
      'SELECT json_group_array(x) FROM t',
    );
  });
  it('rewrites array_agg(DISTINCT ...)', () => {
    expect(rewriteAggFunc('SELECT array_agg(DISTINCT x) FROM t').sql).toBe(
      'SELECT json_group_array(DISTINCT x) FROM t',
    );
  });
  it('preserves nested arguments with nested parens', () => {
    expect(rewriteAggFunc('SELECT array_agg(f(x, y)) FROM t').sql).toBe(
      'SELECT json_group_array(f(x, y)) FROM t',
    );
    expect(rewriteAggFunc('SELECT array_agg(DISTINCT g(h(i))) FROM t').sql).toBe(
      'SELECT json_group_array(DISTINCT g(h(i))) FROM t',
    );
  });
});

describe('rewriteAggFunc — WITHIN GROUP (ordered-set)', () => {
  it('rewrites PERCENTILE_CONT', () => {
    const out = rewriteAggFunc('SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) FROM t').sql;
    expect(out).toContain('ROW_NUMBER() OVER (ORDER BY x)');
  });
  it('rewrites PERCENTILE_DISC', () => {
    const out = rewriteAggFunc('SELECT PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY x) FROM t').sql;
    expect(out).toContain('CEIL(CAST(cnt AS REAL) * 0.5)');
  });
  it('rewrites MODE with empty argument list', () => {
    expect(rewriteAggFunc('SELECT MODE() WITHIN GROUP (ORDER BY x) FROM t').sql).toBe(
      'SELECT (SELECT x FROM ___subq___ GROUP BY x ORDER BY COUNT(*) DESC LIMIT 1) FROM t',
    );
  });
  it('handles a nested ORDER BY expression', () => {
    const out = rewriteAggFunc('SELECT PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY f(x)) FROM t').sql;
    expect(out).toContain('ROW_NUMBER() OVER (ORDER BY f(x))');
  });
});

describe('rewriteAggFunc — literal/comment protection', () => {
  it('does not rewrite a function inside a string literal', () => {
    expect(rewriteAggFunc("SELECT 'bool_and(active)' FROM t").sql).toBe(
      "SELECT 'bool_and(active)' FROM t",
    );
    expect(rewriteAggFunc("SELECT 'bool_and(active)' FROM t").rewritten).toBe(false);
  });
  it('does not rewrite a function inside a line comment', () => {
    expect(rewriteAggFunc('-- array_agg(x)\nSELECT 1').sql).toBe('-- array_agg(x)\nSELECT 1');
  });
  it('does not rewrite a function inside a block comment', () => {
    expect(rewriteAggFunc('/* corr(a,b) */ SELECT 1').sql).toBe('/* corr(a,b) */ SELECT 1');
  });
  it('does not rewrite string_agg inside a literal', () => {
    expect(rewriteAggFunc("SELECT 'string_agg(a, b)' FROM t").sql).toBe(
      "SELECT 'string_agg(a, b)' FROM t",
    );
  });
});

describe('rewriteAggFunc — defensive branches', () => {
  it('leaves an unbalanced call untouched', () => {
    expect(rewriteAggFunc('SELECT bool_and(x FROM t').sql).toBe('SELECT bool_and(x FROM t');
  });
  it('leaves a call with the wrong arity untouched', () => {
    expect(rewriteAggFunc('SELECT corr(a, b, c) FROM t').sql).toBe('SELECT corr(a, b, c) FROM t');
  });
  it('leaves a call with an empty argument untouched', () => {
    expect(rewriteAggFunc('SELECT bool_and() FROM t').sql).toBe('SELECT bool_and() FROM t');
  });
  it('leaves a lone function name (no paren) unchanged', () => {
    expect(rewriteAggFunc('SELECT bool_and FROM t').sql).toBe('SELECT bool_and FROM t');
  });
  it('leaves a WITHIN GROUP call missing ORDER BY untouched', () => {
    expect(rewriteAggFunc('SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (x) FROM t').sql).toBe(
      'SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (x) FROM t',
    );
  });

  it('returns an empty result for null / undefined', () => {
    expect(rewriteAggFunc(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteAggFunc(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('leaves MODE with a non-empty argument list untouched', () => {
    expect(rewriteAggFunc('SELECT MODE(1) WITHIN GROUP (ORDER BY x) FROM t').rewritten).toBe(false);
  });

  it('leaves PERCENTILE_CONT with no argument untouched', () => {
    expect(
      rewriteAggFunc('SELECT PERCENTILE_CONT() WITHIN GROUP (ORDER BY x) FROM t').rewritten,
    ).toBe(false);
  });
});

describe('rewriteAggFunc — WITHIN GROUP malformed variants', () => {
  const untouched = (sql: string) => {
    expect(rewriteAggFunc(sql).rewritten, sql).toBe(false);
  };

  it('missing GROUP keyword', () => {
    untouched('SELECT PERCENTILE_CONT(0.5) WITHIN (ORDER BY x) FROM t');
  });
  it('missing opening paren', () => {
    untouched('SELECT PERCENTILE_CONT(0.5) WITHIN GROUP x FROM t');
  });
  it('empty GROUP clause', () => {
    untouched('SELECT PERCENTILE_CONT(0.5) WITHIN GROUP () FROM t');
  });
  it('empty ORDER BY expression', () => {
    untouched('SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY) FROM t');
  });
  it('missing WITHIN GROUP entirely', () => {
    untouched('SELECT PERCENTILE_CONT(0.5) FROM t');
  });
  it('unbalanced WITHIN GROUP parens', () => {
    untouched('SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x FROM t');
  });
  it('blank ORDER BY expression', () => {
    untouched('SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ) FROM t');
  });
});

