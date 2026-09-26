import { describe, it, expect } from 'vitest';
import { rewriteLateralEnhanced } from '../query/EnhancedLateralRewriter';

describe('rewriteLateralEnhanced — passthrough', () => {
  it('passes through when no LATERAL is present', () => {
    const r = rewriteLateralEnhanced('SELECT * FROM users');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT * FROM users');
    expect(r.hasCorrelation).toBe(false);
    expect(r.correlationRefs).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('passes through by default even when LATERAL is present (SQLite 3.33+)', () => {
    const r = rewriteLateralEnhanced('SELECT * FROM users u, LATERAL (SELECT 1) sub');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toContain('LATERAL');
  });

  it('does not flag LATERAL inside a string literal', () => {
    const r = rewriteLateralEnhanced("SELECT 'LATERAL' AS x FROM t");
    expect(r.rewritten).toBe(false);
  });
});

describe('rewriteLateralEnhanced — force rewrite, non-correlated', () => {
  it('strips a bare comma LATERAL', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT 1 AS one) sub',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('LATERAL');
    expect(r.hasCorrelation).toBe(false);
  });

  it('strips a FROM LATERAL', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM LATERAL (SELECT 1 AS one) sub',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('LATERAL');
  });
});

describe('rewriteLateralEnhanced — correlated LATERAL', () => {
  it('detects WHERE-clause correlation and emits a semantic-gap warning', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT * FROM orders o WHERE o.uid = u.id) sub',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.correlationRefs.length).toBeGreaterThan(0);
    expect(r.correlationRefs[0].fullRef).toBe('u.id');
    // A correlated CROSS JOIN cannot be expressed in SQLite without LATERAL,
    // so even a WHERE-clause reference requires the semantic-gap warning.
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.sql).not.toContain('LATERAL');
    // The correlation reference is replaced by an explicit placeholder comment.
    expect(r.sql).toContain('/* CORR(u.id) */');
  });

  it('rewrites a single-column no-FROM SELECT-list correlation as a scalar subquery', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT u.name AS n) sub',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT *, (SELECT name) AS sub FROM users u');
    // fully-resolved no-FROM scalar subquery → no warning
    expect(r.warnings).toEqual([]);
  });

  it('emits a semantic-gap warning for FROM-clause SELECT-list correlation', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT o.total FROM orders o WHERE o.uid = u.id) sub',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('replaces every correlation reference, including multiple distinct ones', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT o.total FROM orders o WHERE o.uid = u.id AND o.tag = u.name) sub',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    // Both u.id and u.name must be replaced (no index-drift leaving one behind).
    expect(r.sql).toContain('/* CORR(u.id) */');
    expect(r.sql).toContain('/* CORR(u.name) */');
    expect(r.sql).not.toContain('o.tag = u.name');
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('rewriteLateralEnhanced — literal-aware extraction (dollar-quote / escapes / comments)', () => {
  it('does not treat a ( inside a dollar-quoted string as a nested paren', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT $$a(b$$ FROM orders o WHERE o.uid = u.id) sub',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.correlationRefs[0]?.fullRef).toBe('u.id');
    expect(r.sql).toContain('/* CORR(u.id) */');
  });

  it('does not treat a ( inside a single-quoted string with doubled quote escape as a nested paren', () => {
    const r = rewriteLateralEnhanced(
      "SELECT * FROM users u, LATERAL (SELECT 'it''s (x)' FROM orders o WHERE o.uid = u.id) sub",
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.sql).toContain('/* CORR(u.id) */');
  });

  it('does not treat a ( inside a backtick identifier as a nested paren', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT `a)b` FROM orders o WHERE o.uid = u.id) sub',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
  });

  it('does not treat a ) inside a line comment as a closing paren', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT 1 -- )\n FROM orders o WHERE o.uid = u.id) sub',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
  });
});

describe('rewriteLateralEnhanced — scalar subquery rewrite variants', () => {
  it('rewrites a no-FROM single-column SELECT with an inline AS alias', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT u.id + 1 AS next_id) sub',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    // Inner column alias (`next_id`) is discarded; the outer alias is the
    // subquery alias (`sub`), as in PostgreSQL semantics.
    expect(r.sql).toContain('(SELECT id + 1) AS sub');
    expect(r.warnings).toEqual([]);
  });

  it('derives a bare alias when the SELECT expression has no explicit AS', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT u.age) sub',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('(SELECT age) AS sub');
  });

  it('rewrites a FROM-prefixed LATERAL (not comma-prefixed)', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM LATERAL (SELECT 1 AS one) sub',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('LATERAL');
  });

  it('derives the alias from the SELECT expression when the LATERAL has no subquery alias', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT u.age + 1 AS calc)',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    // No subquery alias → fall back to the inner column alias.
    expect(r.sql).toContain('(SELECT age + 1) AS calc');
  });

  it('derives a scalar alias for a bare expression with no subquery alias', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT u.age)',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('(SELECT age) AS age');
  });
});

describe('rewriteLateralEnhanced — JOIN contexts (non-correlated)', () => {
  it('rewrites JOIN LATERAL to INNER JOIN', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM a JOIN LATERAL (SELECT 1 AS x) s ON true',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('LATERAL');
    expect(r.sql).toContain('INNER JOIN');
  });

  it('rewrites LEFT JOIN LATERAL to INNER JOIN', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM a LEFT JOIN LATERAL (SELECT 1 AS x) s ON true',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('LATERAL');
  });

  it('rewrites CROSS JOIN LATERAL to INNER JOIN', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM a CROSS JOIN LATERAL (SELECT 1 AS x) s ON true',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('LATERAL');
  });

  it('rewrites INNER JOIN LATERAL to INNER JOIN without a leftover prefix', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM a INNER JOIN LATERAL (SELECT 1 AS x) s ON true',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('LATERAL');
    expect(r.sql).not.toContain('IINNER');
    expect(r.sql).toContain('INNER JOIN');
  });

  it('rewrites a comma LATERAL to CROSS JOIN without fusing the previous alias', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT 1 AS x) sub',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('users u CROSS JOIN');
    expect(r.sql).not.toContain('uCROSS');
  });
});

describe('rewriteLateralEnhanced — explicit outer aliases + edge cases', () => {
  it('honours explicit outer aliases', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users, LATERAL (SELECT x FROM t WHERE x = u.id) s',
      { forceRewrite: true, outerAliases: ['u'] },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.correlationRefs[0]?.fullRef).toBe('u.id');
  });

  it('does not crash on an unterminated-paren subquery', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT 1 AS x',
      { forceRewrite: true },
    );
    // Malformed input (unmatched paren) — must not throw. The trailing
    // LATERAL keyword may still be stripped by the final pass, but no
    // correlated rewrite can occur.
    expect(r.hasCorrelation).toBe(false);
  });

  it('strips a trailing-semicolon statement cleanly', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT o.t FROM orders o WHERE o.uid = u.id) sub;',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('rewriteLateralEnhanced — non-SELECT / non-single-column subqueries', () => {
  it('does not scalar-rewrite a subquery that is not a SELECT', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (VALUES (1)) sub',
      { forceRewrite: true },
    );
    // VALUES is not a SELECT → falls through to keyword strip (no correlation)
    expect(r.rewritten).toBe(true);
  });

  it('does not scalar-rewrite a multi-column SELECT list', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT u.id, u.name) sub',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    // multi-column → not a single-column scalar rewrite → warning path
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('rewriteLateralEnhanced — outer alias extraction edge cases', () => {
  it('extracts several outer aliases', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, orders o, LATERAL (SELECT x FROM t WHERE x = u.id) s',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.correlationRefs[0]?.fullRef).toBe('u.id');
  });

  it('skips a parenthesized subquery in the FROM list', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM (SELECT 1) x, users u, LATERAL (SELECT x FROM t WHERE x = u.id) s',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.correlationRefs[0]?.fullRef).toBe('u.id');
  });

  it('does not treat a reserved keyword as an alias', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users ORDER, LATERAL (SELECT 1) s',
      { forceRewrite: true },
    );
    // `ORDER` is a keyword, so it must not be picked up as an alias for a
    // spurious `ORDER.id` correlation.
    expect(r.hasCorrelation).toBe(false);
  });

  it('detects correlation in a subquery with FROM after WHERE', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT x FROM t WHERE x = u.id) s',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.correlationRefs[0]?.fullRef).toBe('u.id');
    expect(r.sql).toContain('/* CORR(u.id) */');
  });

  it('extracts aliases from both sides of an outer JOIN', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u JOIN orders o ON u.id = o.uid, LATERAL (SELECT x FROM t WHERE x = u.id) s',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.correlationRefs[0]?.fullRef).toBe('u.id');
  });

  it('extracts the right-side alias of an outer LEFT JOIN', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u LEFT JOIN orders o ON u.id = o.uid, LATERAL (SELECT x FROM t WHERE x = o.uid) s',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.correlationRefs[0]?.fullRef).toBe('o.uid');
  });
});

describe('rewriteLateralEnhanced — scalar rewrite structural edges', () => {
  it('handles a bare column alias with no subquery alias and no AS keyword', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT u.age age2)',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    // `age2` is a bare (space-separated) alias.
    expect(r.sql).toContain('(SELECT age age2) AS age2');
  });

  it('keeps the outer SELECT prefix comma when the select list ends with a comma', () => {
    const r = rewriteLateralEnhanced(
      'SELECT u.id, FROM users u, LATERAL (SELECT u.age) sub',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
  });

  it('handles a SELECT-list correlation with an inner FROM (ref at position 0)', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT u.id FROM orders o) s',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.sql).toContain('/* CORR(u.id) */');
  });

  it('injects the gap-warning comment once even for multiple correlated LATERAL entries', () => {
    const r = rewriteLateralEnhanced(
      'SELECT * FROM users u, LATERAL (SELECT x FROM t WHERE x = u.id) a, LATERAL (SELECT y FROM t2 WHERE y = u.name) b',
      { forceRewrite: true },
    );
    expect(r.hasCorrelation).toBe(true);
    // Two correlated occurrences → two structured warnings, but the comment
    // marker is injected only once.
    expect(r.warnings.length).toBe(2);
    const markerCount = (r.sql.match(/CORRELATION-SEMANTIC-GAP/g) || []).length;
    expect(markerCount).toBe(1);
  });

  it('strips LATERAL when there is no recognizable preceding context', () => {
    const r = rewriteLateralEnhanced(
      'SELECT 1 LATERAL (SELECT 2) s',
      { forceRewrite: true },
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('LATERAL');
  });
});
