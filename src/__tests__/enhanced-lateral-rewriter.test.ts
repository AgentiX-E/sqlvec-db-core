import { describe, it, expect } from 'vitest';
import {
  rewriteLateralEnhanced,
  _extractParenthesizedContent,
  _extractOuterAliases,
  _findClauseEnd,
  _splitTopLevel,
  _isRefInWhereClause,
  _refIsInWhereClause,
  _tryScalarSubqueryRewrite,
  _extractColumnAlias,
  _checkSingleColumnSelect,
  _extractSubqueryAlias,
  _extractContextBeforeLateral,
  _rewriteOneLateralContext,
} from '../query/EnhancedLateralRewriter';

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

// ── Direct unit tests for the re-exported lexing/parsing primitives ─────
// These exercise defensive branches that are unreachable through the public
// `rewriteLateralEnhanced` entry point (which pre-validates its inputs).
describe('_extractParenthesizedContent — defensive branches', () => {
  it('returns null when the open index is not a paren', () => {
    expect(_extractParenthesizedContent('abc', 1)).toBeNull();
  });

  it('returns null for unmatched parentheses', () => {
    expect(_extractParenthesizedContent('(abc', 0)).toBeNull();
  });

  it('returns the full content including parens for a balanced group', () => {
    const r = _extractParenthesizedContent('(a (b) c)', 0);
    expect(r).not.toBeNull();
    expect(r!.innerSql).toBe('a (b) c');
    expect(r!.fullContent).toBe('(a (b) c)');
    expect(r!.endIndex).toBe(8);
  });
});

describe('_extractOuterAliases — edge cases', () => {
  it('skips an empty table-reference part', () => {
    // The FROM list has a dangling comma, producing an empty part.
    expect(_extractOuterAliases('SELECT * FROM , LATERAL (SELECT 1)', 30)).toEqual([]);
  });

  it('does not re-add a duplicate alias', () => {
    // `u` appears twice across join segments — it must be listed once.
    const aliases = _extractOuterAliases(
      'SELECT * FROM users u JOIN users u2 ON u.id = u2.id, LATERAL (SELECT 1)',
      48,
    );
    const count = aliases.filter((a) => a === 'u').length;
    expect(count).toBe(1);
  });
});

describe('_findClauseEnd — literal-aware boundary', () => {
  it('does not treat a clause keyword inside a string literal as a boundary', () => {
    // `(') AND '` keeps scanning past the literal; `WHERE` later is the real ender.
    expect(_findClauseEnd("FROM t WHERE x = ')' AND y", 0)).toBe(7);
  });

  it('skips over a string literal when scanning for a clause ender', () => {
    expect(_findClauseEnd("x = 'abc' ORDER", 0)).toBe(15);
  });
});

describe('_isRefInWhereClause / _refIsInWhereClause — defensive branches', () => {
  it('returns false for a ref at position 0', () => {
    expect(_isRefInWhereClause('x = u.id', 0)).toBe(false);
  });

  it('returns false when a FROM appears between WHERE and the ref (nested subquery)', () => {
    expect(_isRefInWhereClause('SELECT * FROM t WHERE x IN (SELECT 1 FROM y) AND z = u.id', 50)).toBe(false);
  });

  it('returns false when the ref string is absent', () => {
    expect(_refIsInWhereClause('SELECT 1', 'u.id')).toBe(false);
  });

  it('returns true when a FROM appears after WHERE and before the ref', () => {
    const s = 'SELECT x WHERE a=1 FROM t WHERE b=u.id';
    expect(_isRefInWhereClause(s, s.length - 1)).toBe(true);
  });

  it('returns false (defensive) when a FROM appears after WHERE', () => {
    expect(_isRefInWhereClause('x where 1 from u.id', 18)).toBe(false);
  });
});

describe('_tryScalarSubqueryRewrite — defensive branches', () => {
  const refs = [{ alias: 'u', column: 'name', fullRef: 'u.name' } as const];
  const refsTyped = refs as unknown as import('../query/CorrelationDetector').CorrelationRef[];

  it('returns null for a multi-column SELECT list', () => {
    expect(_tryScalarSubqueryRewrite('SELECT * FROM users u, LATERAL (SELECT u.name, u.age) sub', 0, ', ', 'SELECT u.name, u.age', 'sub', refsTyped)).toBeNull();
  });

  it('returns null when there is no FROM clause before LATERAL', () => {
    expect(_tryScalarSubqueryRewrite('LATERAL (SELECT u.name) sub', 0, '', 'SELECT u.name', 'sub', refsTyped)).toBeNull();
  });

  it('returns null when no closing paren follows LATERAL', () => {
    expect(_tryScalarSubqueryRewrite('SELECT * FROM u, LATERAL (SELECT u.name', 15, ', ', 'SELECT u.name', 'sub', refsTyped)).toBeNull();
  });

  it('returns null when the entry context has no FROM or comma terminator', () => {
    expect(_tryScalarSubqueryRewrite('SELECT * X LATERAL (SELECT u.name) sub', 0, '', 'SELECT u.name', 'sub', refsTyped)).toBeNull();
  });
});

describe('_extractColumnAlias — fallback paths', () => {
  it('falls back to "scalar" for an empty expression', () => {
    expect(_extractColumnAlias('')).toBe('scalar');
  });

  it('extracts a qualified column name', () => {
    expect(_extractColumnAlias('t.col')).toBe('col');
  });
});

describe('_checkSingleColumnSelect — defensive branches', () => {
  it('returns false for a bare SELECT keyword without a trailing space', () => {
    expect(_checkSingleColumnSelect('SELECT')).toBe(false);
  });

  it('returns null for a SELECT with no select list (trailing space only)', () => {
    expect(_checkSingleColumnSelect('SELECT  FROM t')).toBe(false);
  });

  it('returns false for a non-SELECT leading keyword', () => {
    expect(_checkSingleColumnSelect(' FROM t')).toBe(false);
  });
});

describe('_rewriteOneLateralContext — JOIN context variants', () => {
  it('rewrites a LEFT JOIN context to INNER JOIN', () => {
    expect(_rewriteOneLateralContext('FROM x LEFT JOIN LATERAL (SELECT 1) t', 18, 'LEFT JOIN ')).toBe(
      'FROM x LINNER JOIN (SELECT 1) t',
    );
  });

  it('rewrites a JOIN context (keyword ends with "join")', () => {
    expect(_rewriteOneLateralContext('LEFT JOIN LATERAL (x)', 10, 'LEFT JOIN ')).toBe(
      'INNER JOIN  (x)',
    );
  });

  it('rewrites an INNER JOIN context (multi-word, ends with "join")', () => {
    expect(_rewriteOneLateralContext('INNER JOIN LATERAL (x)', 11, 'INNER JOIN ')).toBe(
      'INNER JOIN  (x)',
    );
  });

  it('rewrites a CROSS JOIN context (multi-word, ends with "join")', () => {
    expect(_rewriteOneLateralContext('CROSS JOIN LATERAL (x)', 11, 'CROSS JOIN ')).toBe(
      'INNER JOIN  (x)',
    );
  });

  it('falls back to a bare space for an unrecognized context', () => {
    expect(_rewriteOneLateralContext('ON LATERAL (x)', 3, 'ON ')).toBe('  (x)');
  });
});

describe('_extractSubqueryAlias / _extractContextBeforeLateral — remaining paths', () => {
  it('extracts an alias after a closing paren', () => {
    expect(_extractSubqueryAlias('LATERAL (SELECT 1) AS sub', 18)).toBe('sub');
    expect(_extractSubqueryAlias('LATERAL (SELECT 1) sub', 18)).toBe('sub');
    expect(_extractSubqueryAlias('LATERAL (SELECT 1)', 18)).toBe('');
  });

  it('extracts the context keyword before LATERAL', () => {
    expect(_extractContextBeforeLateral('FROM users u, ')).toBe(', ');
    expect(_extractContextBeforeLateral('FROM users u')).toBe('');
  });
});

describe('_splitTopLevel — literal-aware split', () => {
  it('does not split on a delimiter inside a string literal', () => {
    expect(_splitTopLevel("x = 'a,b'", ',')).toEqual(["x = 'a,b'"]);
  });
});

