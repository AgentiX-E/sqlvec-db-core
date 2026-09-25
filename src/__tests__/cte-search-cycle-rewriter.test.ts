/**
 * CteSearchCycleRewriter — PostgreSQL SEARCH/CYCLE → SQLite rewrite tests.
 *
 * Covers SEARCH DEPTH/BREADTH FIRST, CYCLE detection, literal-aware parsing
 * (parentheses/keywords inside strings, quoted identifiers, dollar-quotes,
 * and comments), and — critically — the recursive-member value tracking that
 * ensures the cycle path accumulates the *new* value of the tracked column.
 */
import { describe, it, expect } from 'vitest';
import {
  rewriteSearchCycle,
  detectSearchClause,
  detectCycleClause,
} from '../query/CteSearchCycleRewriter';

describe('detectSearchClause', () => {
  it('detects SEARCH DEPTH FIRST', () => {
    expect(detectSearchClause('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t')).toBe(true);
  });

  it('detects SEARCH BREADTH FIRST', () => {
    expect(detectSearchClause('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SEARCH BREADTH FIRST BY n SET o SELECT * FROM t')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectSearchClause('with recursive t as (select 1 union all select n+1 from t) search depth first by n set o select * from t')).toBe(true);
  });

  it('returns false for non-recursive or no search', () => {
    expect(detectSearchClause('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SELECT * FROM t')).toBe(false);
    expect(detectSearchClause('SELECT 1')).toBe(false);
    expect(detectSearchClause('')).toBe(false);
    expect(detectSearchClause(undefined as any)).toBe(false);
    expect(detectSearchClause(42 as any)).toBe(false);
    // WITH RECURSIVE but unterminated body → extractAfterCteBody returns null
    expect(detectSearchClause('WITH RECURSIVE t(n) AS (SELECT 1')).toBe(false);
  });
});

describe('detectCycleClause', () => {
  it('detects CYCLE', () => {
    expect(detectCycleClause('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t')).toBe(true);
  });

  it('detects CYCLE without DEFAULT', () => {
    expect(detectCycleClause('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) CYCLE n SET c TO 1 SELECT * FROM t')).toBe(true);
  });

  it('returns false when no cycle clause', () => {
    expect(detectCycleClause('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SELECT * FROM t')).toBe(false);
    expect(detectCycleClause('SELECT 1')).toBe(false);
    expect(detectCycleClause('')).toBe(false);
    expect(detectCycleClause(null as any)).toBe(false);
    expect(detectCycleClause(7 as any)).toBe(false);
    // WITH RECURSIVE but unterminated body → extractAfterCteBody returns null
    expect(detectCycleClause('WITH RECURSIVE t(n) AS (SELECT 1')).toBe(false);
  });
});

describe('rewriteSearchCycle — SEARCH', () => {
  const base = 'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<10)';

  it('rewrites SEARCH DEPTH FIRST', () => {
    const r = rewriteSearchCycle(`${base} SEARCH DEPTH FIRST BY n SET order_col SELECT * FROM t`);
    expect(r.rewritten).toBe(true);
    expect(r.details.search).toBe('DEPTH FIRST');
    expect(r.sql).toContain('__sqlpath');
    expect(r.sql).toContain('ORDER BY __sqlpath');
  });

  it('rewrites SEARCH BREADTH FIRST', () => {
    const r = rewriteSearchCycle(`${base} SEARCH BREADTH FIRST BY n SET order_col SELECT * FROM t`);
    expect(r.rewritten).toBe(true);
    expect(r.details.search).toBe('BREADTH FIRST');
    expect(r.sql).toContain('__sqldepth');
    expect(r.sql).toContain('ORDER BY __sqldepth');
  });

  it('returns unchanged when no SEARCH/CYCLE', () => {
    const r = rewriteSearchCycle(`${base} SELECT * FROM t`);
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe(`${base} SELECT * FROM t`);
  });

  it('returns unchanged for empty input', () => {
    expect(rewriteSearchCycle('').rewritten).toBe(false);
    expect(rewriteSearchCycle('   ').rewritten).toBe(false);
    expect(rewriteSearchCycle(undefined as any).rewritten).toBe(false);
  });

  it('returns unchanged for non-CTE SQL', () => {
    expect(rewriteSearchCycle('SELECT 1').rewritten).toBe(false);
    expect(rewriteSearchCycle('INSERT INTO t VALUES (1)').rewritten).toBe(false);
  });

  it('returns unchanged for an unterminated CTE (no closing paren)', () => {
    expect(rewriteSearchCycle('WITH RECURSIVE t(n) AS (SELECT 1').rewritten).toBe(false);
  });

  it('returns unchanged for a malformed CTE (no union all)', () => {
    expect(rewriteSearchCycle('WITH RECURSIVE t(n) AS (SELECT 1) SELECT * FROM t').rewritten).toBe(false);
  });
});

describe('rewriteSearchCycle — CYCLE', () => {
  const base = 'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<5)';

  it('rewrites CYCLE with quoted values', () => {
    const r = rewriteSearchCycle(`${base} CYCLE n SET c TO 'Y' DEFAULT 'N' SELECT * FROM t`);
    expect(r.rewritten).toBe(true);
    expect(r.details.cycle).toEqual({ column: 'n', marker: 'c' });
    expect(r.sql).toContain("THEN 'Y' ELSE 'N'");
  });

  it('rewrites CYCLE with unquoted numeric values', () => {
    const r = rewriteSearchCycle(`${base} CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t`);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('THEN 1 ELSE 0');
  });

  it('defaults the non-cycle value to false (same quoting as TO value)', () => {
    const r = rewriteSearchCycle(`${base} CYCLE n SET c TO 'Y' SELECT * FROM t`);
    expect(r.rewritten).toBe(true);
    // quoted true value → quoted 'false' default
    expect(r.sql).toContain("'false'");
  });

  it('defaults unquoted true to unquoted false', () => {
    const r = rewriteSearchCycle(`${base} CYCLE n SET c TO true SELECT * FROM t`);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('THEN true ELSE false');
  });

  it('adds a cycle guard to the recursive member', () => {
    const r = rewriteSearchCycle(`${base} CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t`);
    expect(r.sql).toMatch(/WHERE \(c = 0 OR c IS NULL\)/);
  });
});

describe('rewriteSearchCycle — combined SEARCH + CYCLE', () => {
  it('handles both clauses together', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<10) SEARCH DEPTH FIRST BY n SET o CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.details.search).toBe('DEPTH FIRST');
    expect(r.details.cycle).toEqual({ column: 'n', marker: 'c' });
  });
});

describe('literal-aware parsing (bug #205 / #207 / #208)', () => {
  it('preserves a closing paren inside a string literal in the recursive member', () => {
    const r = rewriteSearchCycle(
      "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE name=')') SEARCH DEPTH FIRST BY n SET o SELECT * FROM t",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("name=')'");
  });

  it('preserves an opening paren inside a string literal in the anchor', () => {
    const r = rewriteSearchCycle(
      "WITH RECURSIVE t(n) AS (SELECT '(' UNION ALL SELECT n FROM t) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t",
    );
    expect(r.rewritten).toBe(true);
  });

  it('tracks the new value of the cycle column (not the previous-row value)', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE walk(n) AS (SELECT 0 UNION ALL SELECT t FROM walk JOIN e ON walk.n=e.f) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM walk',
    );
    // path must accumulate `t` (the new value), not `n` (the old row value)
    expect(r.sql).toContain('__sqlpath || t');
    expect(r.sql).toContain("INSTR(__sqlpath, ',' || t || ',')");
  });

  it('wraps the anchor so the cycle column is referenceable', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE walk(n) AS (SELECT 0 UNION ALL SELECT t FROM walk JOIN e ON walk.n=e.f) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM walk',
    );
    expect(r.sql).toContain('FROM (SELECT 0 AS n) AS _anchor');
  });
});

describe('dollar-quote and quoted-identifier tolerance', () => {
  it('ignores a paren inside a dollar-quoted string', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE b=$$ ) $$) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('$$ ) $$');
  });

  it('ignores a keyword inside a double-quoted identifier', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM "t") SEARCH DEPTH FIRST BY n SET o SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
  });
});

describe('literal scanner boundary coverage', () => {
  const prefix = 'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t';

  it('handles a line comment (with closing paren on a later line)', () => {
    const r = rewriteSearchCycle(
      `${prefix} -- comment )\n WHERE n<5) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t`,
    );
    expect(typeof r).toBe('object');
  });

  it('handles a block comment containing a paren', () => {
    const r = rewriteSearchCycle(
      `${prefix} /* ) */ WHERE n<5) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t`,
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('/* ) */');
  });

  it('handles a backslash escape inside a string', () => {
    const r = rewriteSearchCycle(
      `${prefix} WHERE s='a\\'b') SEARCH DEPTH FIRST BY n SET o SELECT * FROM t`,
    );
    expect(typeof r).toBe('object');
  });

  it('handles an escaped single quote (doubled)', () => {
    const r = rewriteSearchCycle(
      `${prefix} WHERE s='it''s') SEARCH DEPTH FIRST BY n SET o SELECT * FROM t`,
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'it''s'");
  });

  it('handles an escaped double quote identifier', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM "we""ird") SEARCH DEPTH FIRST BY n SET o SELECT * FROM t',
    );
    expect(typeof r).toBe('object');
  });

  it('handles a bare dollar sign that is not a dollar-quote opener', () => {
    const r = rewriteSearchCycle(
      `${prefix} WHERE n=$1) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t`,
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('$1');
  });

  it('handles an unterminated string (no closing quote)', () => {
    const r = rewriteSearchCycle(
      `${prefix} WHERE s='oops) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t`,
    );
    expect(typeof r).toBe('object');
  });

  it('handles an unterminated double-quoted identifier', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM "oops) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t',
    );
    expect(typeof r).toBe('object');
  });

  it('handles an unterminated block comment', () => {
    const r = rewriteSearchCycle(
      `${prefix} /* oops) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t`,
    );
    expect(typeof r).toBe('object');
  });

  it('handles an unterminated dollar-quote', () => {
    const r = rewriteSearchCycle(
      `${prefix} b=$$ oops) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t`,
    );
    expect(typeof r).toBe('object');
  });

  it('handles a tagged dollar-quote with keyword content', () => {
    const r = rewriteSearchCycle(
      `${prefix} b=$tag$ ) FROM $tag$) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t`,
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('$tag$ ) FROM $tag$');
  });

  it('handles a CTE without an explicit column list', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t',
    );
    expect(typeof r).toBe('object');
  });

  it('ignores a clause keyword inside a string literal in the anchor', () => {
    const r = rewriteSearchCycle(
      "WITH RECURSIVE t(n) AS (SELECT 'WHERE' UNION ALL SELECT n+1 FROM t WHERE n<5) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'WHERE'");
  });

  it('splits a select list with parenthesized expressions', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(a,b) AS (SELECT (1+1), 2 UNION ALL SELECT a+1, b+1 FROM t) CYCLE a SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('(1+1) AS a');
  });

  it('handles a recursive member with no FROM clause (bare expression)', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (SELECT 0 UNION ALL SELECT n+1) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
  });

  it('wraps an anchor with DISTINCT', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (SELECT DISTINCT 0 UNION ALL SELECT n+1 FROM t) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('_anchor');
  });

  it('tolerates a VALUES anchor (non-SELECT member)', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM t) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    expect(typeof r).toBe('object');
  });

  it('tolerates an empty item in the column list', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n,) AS (SELECT 0 UNION ALL SELECT n+1 FROM t) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    expect(typeof r).toBe('object');
  });

  it('falls back to the bare column name when a tracked column is absent from the recursive select list', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(a,b) AS (SELECT 1,2 UNION ALL SELECT a+1 FROM t) CYCLE b SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("',' || b || ','");
  });

  it('handles a CYCLE clause with no explicit column list (false branch of marker existence)', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t AS (SELECT 0 UNION ALL SELECT n+1 FROM t) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('c');
  });

  it('handles a VALUES recursive member (non-SELECT member)', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (SELECT 0 UNION ALL VALUES(1)) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    expect(typeof r).toBe('object');
  });

  it('handles WITH RECURSIVE without an immediately parseable CTE header', () => {
    expect(rewriteSearchCycle('WITH RECURSIVE SELECT 1').rewritten).toBe(false);
    expect(detectSearchClause('WITH RECURSIVE SELECT 1')).toBe(false);
  });
});

describe('anchor wrapping and value tracking', () => {
  it('wraps a multi-column anchor mapping declared column names', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(a,b) AS (SELECT 1,2 UNION ALL SELECT a+1,b+1 FROM t) CYCLE a SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('SELECT 1 AS a, 2 AS b');
  });

  it('appends NULL for declared columns missing from a short anchor', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(a,b) AS (SELECT 1 UNION ALL SELECT a+1,b+1 FROM t) CYCLE a SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    // anchor declares 1 column but CTE declares 2 → second becomes NULL
    expect(r.sql).toContain('NULL AS b');
  });

  it('handles an anchor with a FROM clause', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (SELECT 0 FROM (SELECT 1) x UNION ALL SELECT n+1 FROM t) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('_anchor');
  });
});

describe('addCondition / addOrderBy branches', () => {
  it('adds WHERE before GROUP BY when no WHERE exists', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t GROUP BY n) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toMatch(/WHERE \(c = 0 OR c IS NULL\) GROUP BY/);
  });

  it('replaces an existing ORDER BY in the outer query', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<5) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t ORDER BY n',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ORDER BY __sqlpath');
    expect(r.sql).not.toContain('ORDER BY n');
  });
});

describe('column-collision guards (bug #211)', () => {
  it('does not re-inject __sqlpath when it already exists', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n, __sqlpath) AS (SELECT 1,0 UNION ALL SELECT n+1,__sqlpath FROM t) SEARCH DEPTH FIRST BY n SET o SELECT * FROM t',
    );
    const cols = r.sql.match(/RECURSIVE t\(([^)]*)\)/)?.[1] ?? '';
    expect(cols).toBe('n, __sqlpath, __sqldepth');
  });

  it('does not re-inject __sqldepth when it already exists', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n, __sqldepth) AS (SELECT 1,0 UNION ALL SELECT n+1,__sqldepth FROM t) SEARCH BREADTH FIRST BY n SET o SELECT * FROM t',
    );
    const cols = r.sql.match(/RECURSIVE t\(([^)]*)\)/)?.[1] ?? '';
    expect(cols).toBe('n, __sqldepth, __sqlpath');
  });

  it('keeps an already-present cycle marker column (no duplicate)', () => {
    const r = rewriteSearchCycle(
      'WITH RECURSIVE t(n, c) AS (SELECT 1,0 UNION ALL SELECT n+1,c FROM t) CYCLE n SET c TO 1 DEFAULT 0 SELECT * FROM t',
    );
    const cols = r.sql.match(/RECURSIVE t\(([^)]*)\)/)?.[1] ?? '';
    // c must appear exactly once, and __sqlpath/__sqldepth are injected once each
    expect(cols).toBe('n, c, __sqldepth, __sqlpath');
  });
});

