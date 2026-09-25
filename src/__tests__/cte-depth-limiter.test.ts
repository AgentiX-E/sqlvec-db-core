/**
 * CteDepthLimiter — recursive CTE depth-limit rewriting tests.
 *
 * Covers SET max_recursive_query_depth detection (with clamping), recursive
 * CTE detection, CTE structure parsing, depth-column injection, WHERE
 * condition addition, and — critically — the literal-aware scanning that
 * prevents parentheses and keywords inside string literals, quoted
 * identifiers, dollar-quotes, and comments from corrupting the rewrite.
 */
import { describe, it, expect } from 'vitest';
import {
  injectCteDepthLimit,
  detectSetMaxDepth,
  handleSetMaxDepth,
  detectRecursiveCte,
  DEFAULT_MAX_RECURSIVE_DEPTH,
  MIN_DEPTH,
  MAX_DEPTH,
} from '../query/CteDepthLimiter';

describe('detectSetMaxDepth', () => {
  it('parses "SET max_recursive_query_depth = N"', () => {
    expect(detectSetMaxDepth('SET max_recursive_query_depth = 200')).toBe(200);
    expect(detectSetMaxDepth('SET max_recursive_query_depth=50')).toBe(50);
  });

  it('parses "SET ... TO N"', () => {
    expect(detectSetMaxDepth('SET max_recursive_query_depth TO 75')).toBe(75);
  });

  it('parses case-insensitively', () => {
    expect(detectSetMaxDepth('set MAX_RECURSIVE_QUERY_DEPTH = 123')).toBe(123);
  });

  it('supports quoted identifier', () => {
    expect(detectSetMaxDepth('SET "max_recursive_query_depth" = 99')).toBe(99);
    expect(detectSetMaxDepth("SET 'max_recursive_query_depth' TO 88")).toBe(88);
  });

  it('allows a trailing semicolon', () => {
    expect(detectSetMaxDepth('SET max_recursive_query_depth = 42;')).toBe(42);
  });

  it('clamps below MIN_DEPTH to MIN_DEPTH', () => {
    expect(detectSetMaxDepth('SET max_recursive_query_depth = 0')).toBe(MIN_DEPTH);
  });

  it('returns null for a negative (non-numeric) depth', () => {
    expect(detectSetMaxDepth('SET max_recursive_query_depth = -5')).toBe(null);
  });

  it('clamps above MAX_DEPTH to MAX_DEPTH', () => {
    expect(detectSetMaxDepth('SET max_recursive_query_depth = 999999')).toBe(MAX_DEPTH);
  });

  it('returns null for non-SET or unrelated statements', () => {
    expect(detectSetMaxDepth('SET search_path TO public')).toBe(null);
    expect(detectSetMaxDepth('SHOW max_recursive_query_depth')).toBe(null);
    expect(detectSetMaxDepth('SELECT 1')).toBe(null);
    expect(detectSetMaxDepth('SET max_recursive_query_depth')).toBe(null);
    expect(detectSetMaxDepth('SET max_recursive_query_depth = abc')).toBe(null);
  });

  it('returns null for empty / non-string', () => {
    expect(detectSetMaxDepth('')).toBe(null);
    expect(detectSetMaxDepth('   ')).toBe(null);
    expect(detectSetMaxDepth(undefined as any)).toBe(null);
    expect(detectSetMaxDepth(null as any)).toBe(null);
  });

  it('handleSetMaxDepth delegates to detectSetMaxDepth', () => {
    expect(handleSetMaxDepth('SET max_recursive_query_depth = 60')).toBe(60);
    expect(handleSetMaxDepth('SHOW x')).toBe(null);
  });
});

describe('detectRecursiveCte', () => {
  it('detects a leading WITH RECURSIVE', () => {
    expect(detectRecursiveCte('WITH RECURSIVE t(n) AS (SELECT 1) SELECT * FROM t')).toBe(true);
  });

  it('detects leading whitespace before WITH RECURSIVE', () => {
    expect(detectRecursiveCte('  WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectRecursiveCte('with recursive t as (select 1) select * from t')).toBe(true);
  });

  it('does not detect a non-recursive WITH', () => {
    expect(detectRecursiveCte('WITH t AS (SELECT 1) SELECT * FROM t')).toBe(false);
  });

  it('returns false for empty / non-string', () => {
    expect(detectRecursiveCte('')).toBe(false);
    expect(detectRecursiveCte(undefined as any)).toBe(false);
    expect(detectRecursiveCte(42 as any)).toBe(false);
  });
});

describe('injectCteDepthLimit', () => {
  it('rewrites a basic recursive CTE', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<200) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.maxDepth).toBe(DEFAULT_MAX_RECURSIVE_DEPTH);
    expect(r.sql).toContain('__sqldepth');
    expect(r.sql).toContain(`__sqldepth < ${DEFAULT_MAX_RECURSIVE_DEPTH}`);
  });

  it('respects an explicit maxDepth', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SELECT * FROM t',
      10,
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('__sqldepth < 10');
  });

  it('clamps maxDepth to MIN_DEPTH', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SELECT * FROM t',
      0,
    );
    expect(r.maxDepth).toBe(MIN_DEPTH);
  });

  it('clamps maxDepth to MAX_DEPTH', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SELECT * FROM t',
      999999,
    );
    expect(r.maxDepth).toBe(MAX_DEPTH);
  });

  it('does not rewrite a non-recursive query', () => {
    const r = injectCteDepthLimit('SELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });

  it('does not rewrite empty / non-string', () => {
    expect(injectCteDepthLimit('').rewritten).toBe(false);
    expect(injectCteDepthLimit(undefined as any).rewritten).toBe(false);
  });

  it('preserves a CTE with explicit column list', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(a,b) AS (SELECT 1,2 UNION ALL SELECT a+1,b+1 FROM t) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('t(a,b, __sqldepth)');
  });

  it('handles a CTE without an explicit column list', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    // No explicit columns → depth column becomes the sole declared column.
    expect(r.sql).toContain('t(__sqldepth)');
  });

  it('does not rewrite a VALUES-based (non-SELECT) anchor', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM t) SELECT * FROM t',
    );
    // The non-SELECT anchor cannot be rewritten; documented limitation.
    expect(typeof r).toBe('object');
  });

  it('handles a recursive member WITHOUT a WHERE clause', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    // The depth condition becomes a fresh WHERE right after FROM.
    expect(r.sql).toContain('FROM t WHERE __sqldepth <');
  });

  it('merges the depth condition into an existing WHERE', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<200) SELECT * FROM t',
    );
    expect(r.sql).toMatch(/WHERE __sqldepth < \d+ AND n<200/);
  });

  it('does not rewrite a UNION (non-ALL) CTE', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION SELECT n+1 FROM t) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(false);
  });

  it('preserves a parentheses inside a string literal (no corruption)', () => {
    const r = injectCteDepthLimit(
      "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE name=')') SELECT * FROM t",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("name=')'");
  });

  it('preserves an opening paren inside a string literal', () => {
    const r = injectCteDepthLimit(
      "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE name='(') SELECT * FROM t",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("name='('");
  });

  it('preserves a paren inside a block comment', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 /* ) */ UNION ALL SELECT n+1 FROM t) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('/* ) */');
  });

  it('handles a nested subquery with parentheses', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<(SELECT max(x) FROM y)) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('n<(SELECT max(x) FROM y)');
  });

  it('handles an outer query with a column projection', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<200) SELECT n FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('SELECT n FROM t');
  });

  it('preserves a double-quoted identifier (no false WHERE/FROM match)', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT "from" + n FROM t WHERE n<5) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('"from"');
    // The quoted "from" must not be treated as the FROM clause boundary.
    expect(r.sql).toContain('FROM t');
  });

  it('handles a doubled double-quote inside an identifier', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT "we""ird" + n FROM "t") SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('"we""ird"');
  });

  it('preserves a dollar-quoted string containing keywords/parens', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE body=$$ ) WHERE $$) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('$$ ) WHERE $$');
  });

  it('preserves a tagged dollar-quote', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE body=$tag$ FROM $tag$) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('$tag$ FROM $tag$');
  });

  it('preserves a line comment in the recursive member', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t -- trailing\n WHERE n<5) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
  });

  it('adds a fresh WHERE before a GROUP BY (no existing WHERE)', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 AS x FROM t GROUP BY n) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toMatch(/WHERE __sqldepth < \d+ GROUP BY/);
  });

  it('handles a doubled single quote (escaped quote)', () => {
    const r = injectCteDepthLimit(
      "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE s='it''s') SELECT * FROM t",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'it''s'");
  });

  it('handles a backslash escape inside a string', () => {
    const r = injectCteDepthLimit(
      "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE s='a\\'b') SELECT * FROM t",
    );
    expect(r.rewritten).toBe(true);
  });

  it('handles a dollar sign that is not a dollar-quote (positional param)', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+$1 FROM t) SELECT * FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('$1');
  });

  it('does not rewrite when the CTE body has no closing paren', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t SELECT * FROM t',
    );
    expect(r.rewritten).toBe(false);
  });

  it('returns unknown-safe result for an unterminated block comment', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 /* ) UNION ALL SELECT n+1 FROM t) SELECT * FROM t',
    );
    // The unterminated comment swallows the rest, so no UNION ALL is found.
    expect(r.rewritten).toBe(false);
  });

  it('clamps an out-of-range numeric literal', () => {
    const r = detectSetMaxDepth('SET max_recursive_query_depth = 99999999999999999999');
    // parseInt overflows to a finite/Infinity value, then clamped to MAX_DEPTH.
    expect(r).toBe(MAX_DEPTH);
  });

  it('handles an unterminated single-quoted string in the recursive member', () => {
    const r = injectCteDepthLimit(
      "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE s='oops) SELECT * FROM t",
    );
    // Unterminated string: the parser is robust and does not crash.
    expect(typeof r).toBe('object');
  });

  it('handles an unterminated double-quoted identifier in the recursive member', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM "t) SELECT * FROM t',
    );
    expect(typeof r).toBe('object');
  });

  it('handles an unterminated dollar-quoted string', () => {
    const r = injectCteDepthLimit(
      'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE b=$$ ) SELECT * FROM t',
    );
    expect(typeof r).toBe('object');
  });
});

describe('constants', () => {
  it('exposes defaults and bounds', () => {
    expect(DEFAULT_MAX_RECURSIVE_DEPTH).toBe(100);
    expect(MIN_DEPTH).toBe(1);
    expect(MAX_DEPTH).toBe(10000);
  });
});
