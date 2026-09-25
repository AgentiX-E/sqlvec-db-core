import { describe, it, expect } from 'vitest';
import { detectDistinctOn, rewriteDistinctOn } from '../query/DistinctOnRewriter';

// DistinctOnRewriter translates SELECT DISTINCT ON (...) to a ROW_NUMBER()
// window-function subquery. Tests lock literal/comment detection and the full
// rewrite pipeline (WITH, ORDER BY, LIMIT/OFFSET, multi-column partition).
describe('DistinctOnRewriter', () => {
  describe('detectDistinctOn', () => {
    it('detects a real DISTINCT ON clause', () => {
      expect(detectDistinctOn('SELECT DISTINCT ON (id) * FROM t')).toBe(true);
    });

    it('does not detect a plain DISTINCT', () => {
      expect(detectDistinctOn('SELECT DISTINCT name FROM t')).toBe(false);
    });

    // BUG #105 regression: DISTINCT ON inside a string is not a real clause.
    it('does not detect DISTINCT ON inside a string literal', () => {
      expect(detectDistinctOn("SELECT 'DISTINCT ON (id)'")).toBe(false);
    });

    // BUG #106 regression: DISTINCT ON inside a comment is not a real clause.
    it('does not detect DISTINCT ON inside a comment', () => {
      expect(detectDistinctOn('SELECT 1 -- DISTINCT ON (id)')).toBe(false);
    });
  });

  describe('rewriteDistinctOn', () => {
    it('rewrites a basic DISTINCT ON query', () => {
      expect(rewriteDistinctOn('SELECT DISTINCT ON (cat_id) id, name FROM products ORDER BY cat_id, price DESC'))
        .toEqual({
          sql: 'SELECT * FROM (SELECT id, name, ROW_NUMBER() OVER (PARTITION BY cat_id ORDER BY cat_id, price DESC) AS _rn FROM products) WHERE _rn = 1',
          rewritten: true,
        });
    });

    it('preserves LIMIT on the outer query', () => {
      expect(rewriteDistinctOn('SELECT DISTINCT ON (cat_id) id, name FROM products ORDER BY cat_id, price DESC LIMIT 5'))
        .toEqual({
          sql: 'SELECT * FROM (SELECT id, name, ROW_NUMBER() OVER (PARTITION BY cat_id ORDER BY cat_id, price DESC) AS _rn FROM products) WHERE _rn = 1 LIMIT 5',
          rewritten: true,
        });
    });

    it('preserves LIMIT ... OFFSET on the outer query', () => {
      expect(rewriteDistinctOn('SELECT DISTINCT ON (id) a FROM t LIMIT 10 OFFSET 5'))
        .toEqual({
          sql: 'SELECT * FROM (SELECT a, ROW_NUMBER() OVER (PARTITION BY id ORDER BY id) AS _rn FROM t) WHERE _rn = 1 LIMIT 10 OFFSET 5',
          rewritten: true,
        });
    });

    it('rewrites a multi-column DISTINCT ON', () => {
      expect(rewriteDistinctOn('SELECT DISTINCT ON (a, b) x, y FROM t ORDER BY a, b, x'))
        .toEqual({
          sql: 'SELECT * FROM (SELECT x, y, ROW_NUMBER() OVER (PARTITION BY a, b ORDER BY a, b, x) AS _rn FROM t) WHERE _rn = 1',
          rewritten: true,
        });
    });

    it('preserves a WITH clause prefix', () => {
      expect(rewriteDistinctOn('WITH c AS (SELECT 1) SELECT DISTINCT ON (id) a FROM t ORDER BY id'))
        .toEqual({
          sql: 'WITH c AS (SELECT 1) SELECT * FROM (SELECT a, ROW_NUMBER() OVER (PARTITION BY id ORDER BY id) AS _rn FROM t) WHERE _rn = 1',
          rewritten: true,
        });
    });

    it('falls back to partition columns when ORDER BY is absent', () => {
      expect(rewriteDistinctOn('SELECT DISTINCT ON (id) a FROM t'))
        .toEqual({
          sql: 'SELECT * FROM (SELECT a, ROW_NUMBER() OVER (PARTITION BY id ORDER BY id) AS _rn FROM t) WHERE _rn = 1',
          rewritten: true,
        });
    });

    it('keeps a WHERE clause in the inner body', () => {
      expect(rewriteDistinctOn('SELECT DISTINCT ON (id) a FROM t WHERE x = 1 ORDER BY id'))
        .toEqual({
          sql: 'SELECT * FROM (SELECT a, ROW_NUMBER() OVER (PARTITION BY id ORDER BY id) AS _rn FROM t WHERE x = 1) WHERE _rn = 1',
          rewritten: true,
        });
    });

    it('returns unchanged (rewritten:false) when no DISTINCT ON', () => {
      expect(rewriteDistinctOn('SELECT DISTINCT name FROM t'))
        .toEqual({ sql: 'SELECT DISTINCT name FROM t', rewritten: false });
    });

    // BUG #107 regression: a DISTINCT ON token inside a string is not rewritten.
    it('leaves a DISTINCT ON token inside a string intact', () => {
      expect(rewriteDistinctOn("SELECT 'DISTINCT ON (id)'"))
        .toEqual({ sql: "SELECT 'DISTINCT ON (id)'", rewritten: false });
    });

    it('leaves a DISTINCT ON token inside a comment intact', () => {
      expect(rewriteDistinctOn('SELECT 1 -- DISTINCT ON (id)'))
        .toEqual({ sql: 'SELECT 1 -- DISTINCT ON (id)', rewritten: false });
    });

    // Cover splitTopLevelCommas string/identifier handling inside DISTINCT ON ().
    it('rewrites DISTINCT ON with quoted identifiers and string in expressions', () => {
      expect(rewriteDistinctOn("SELECT DISTINCT ON (\"a,b\", 'x') c FROM t ORDER BY \"a,b\"").rewritten)
        .toBe(true);
    });

    // Cover extractWithClause string/comment handling inside a CTE body.
    it('preserves a WITH clause whose CTE body contains a string and a comment', () => {
      const result = rewriteDistinctOn(
        "WITH c AS (SELECT ')' /* ) */ AS x) SELECT DISTINCT ON (id) a FROM t ORDER BY id",
      );
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain('WITH c AS (SELECT ');
    });

    // Cover extractSelectColumns string handling (a string literal in the select list).
    it('handles a string literal in the select column list', () => {
      const result = rewriteDistinctOn("SELECT DISTINCT ON (id) 'k', name FROM t ORDER BY id");
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain("'k', name");
    });

    // Cover extractOrderBy string handling (a string literal inside ORDER BY).
    it('handles a string literal inside ORDER BY', () => {
      const result = rewriteDistinctOn("SELECT DISTINCT ON (id) a FROM t ORDER BY 'const', id");
      expect(result.rewritten).toBe(true);
    });

    // Cover extractLimitOffset string handling (a string literal in the body).
    it('handles a string literal before LIMIT', () => {
      const result = rewriteDistinctOn("SELECT DISTINCT ON (id) a FROM t WHERE note = 'x' ORDER BY id LIMIT 3");
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain("note = 'x'");
    });

    // Cover quoted identifiers in ORDER BY (extractOrderByColumns string char).
    it('handles a quoted identifier in ORDER BY', () => {
      const result = rewriteDistinctOn('SELECT DISTINCT ON (id) a FROM t ORDER BY "full name"');
      expect(result.rewritten).toBe(true);
    });

    // Cover splitTopLevelCommas + findMatchingClose nested-paren handling.
    it('handles a function-call expression inside DISTINCT ON', () => {
      expect(rewriteDistinctOn('SELECT DISTINCT ON (substr(a, 1, 2)) b FROM t ORDER BY a').rewritten)
        .toBe(true);
    });

    // Cover extractWithClause multiple-CTE branch (commas between CTEs).
    it('preserves multiple CTEs joined by commas', () => {
      const result = rewriteDistinctOn(
        'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT DISTINCT ON (id) x FROM t ORDER BY id',
      );
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain('WITH a AS (SELECT 1), b AS (SELECT 2)');
    });

    // Cover extractSelectColumns nested-paren handling.
    it('handles a parenthesized expression in the select list', () => {
      const result = rewriteDistinctOn('SELECT DISTINCT ON (id) (a + b), name FROM t ORDER BY id');
      expect(result.rewritten).toBe(true);
    });

    // Cover extractOrderBy / extractOrderByColumns nested-paren handling.
    it('handles a parenthesized expression inside ORDER BY', () => {
      const result = rewriteDistinctOn('SELECT DISTINCT ON (id) a FROM t ORDER BY (a + 1)');
      expect(result.rewritten).toBe(true);
    });

    // Cover extractLimitOffset paren handling (a parenthesized expr before LIMIT).
    it('handles a parenthesized expression before LIMIT', () => {
      const result = rewriteDistinctOn('SELECT DISTINCT ON (id) a FROM t WHERE (x = 1) ORDER BY id LIMIT 2');
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain('LIMIT 2');
    });

    // Cover extractWithClause nested-paren handling inside a CTE body.
    it('preserves a CTE whose body contains a nested subquery', () => {
      const result = rewriteDistinctOn(
        'WITH a AS (SELECT (SELECT 1)) SELECT DISTINCT ON (id) x FROM t ORDER BY id',
      );
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain('WITH a AS (SELECT (SELECT 1))');
    });

    // Cover extractLimitOffset string + paren handling (string/paren before LIMIT).
    it('handles a string literal and parentheses before LIMIT in the body', () => {
      const result = rewriteDistinctOn(
        "SELECT DISTINCT ON (id) a FROM t WHERE (note = 'x') ORDER BY id LIMIT 2",
      );
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain("(note = 'x')");
    });

    // Cover extractLimitOffset string/paren/quote handling via the no-ORDER-BY
    // fallback path (rest contains WHERE string / paren / quoted identifier).
    it('separates LIMIT when no ORDER BY and WHERE has a string', () => {
      const result = rewriteDistinctOn("SELECT DISTINCT ON (id) a FROM t WHERE note = 'x' LIMIT 2");
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain("note = 'x'");
      expect(result.sql).toContain('LIMIT 2');
    });

    it('separates OFFSET when no ORDER BY and WHERE has a quoted identifier', () => {
      const result = rewriteDistinctOn('SELECT DISTINCT ON (id) a FROM t WHERE note = "y" OFFSET 3');
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain('OFFSET 3');
    });

    it('separates LIMIT when no ORDER BY and WHERE has parentheses', () => {
      const result = rewriteDistinctOn('SELECT DISTINCT ON (id) a FROM t WHERE (x = 1) LIMIT 2');
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain('WHERE (x = 1)');
      expect(result.sql).toContain('LIMIT 2');
    });

    // Cover extractSelectColumns no-clause fallback and empty inner body.
    it('handles a DISTINCT ON with no FROM/ORDER BY (empty inner body)', () => {
      const result = rewriteDistinctOn('SELECT DISTINCT ON (id) name');
      expect(result.rewritten).toBe(true);
    });

    it('leaves a DISTINCT ON nested inside a subquery unchanged (#228)', () => {
      const result = rewriteDistinctOn(
        'SELECT * FROM (SELECT DISTINCT ON (a) b FROM t) AS sub',
      );
      expect(result.rewritten).toBe(false);
      expect(result.sql).toBe('SELECT * FROM (SELECT DISTINCT ON (a) b FROM t) AS sub');
    });

    it('leaves a DISTINCT ON nested in a subquery with an outer WHERE unchanged (#228)', () => {
      const result = rewriteDistinctOn(
        'SELECT x FROM (SELECT DISTINCT ON (a) b FROM t) AS sub WHERE x > 0',
      );
      expect(result.rewritten).toBe(false);
    });

    it('preserves a string containing a closing paren inside DISTINCT ON (#229)', () => {
      const result = rewriteDistinctOn(
        "SELECT DISTINCT ON (CASE WHEN a=')' THEN 1 ELSE 0 END) b FROM t",
      );
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain("PARTITION BY CASE WHEN a=')' THEN 1 ELSE 0 END");
    });

    it('preserves a function call with a string containing parens inside DISTINCT ON (#229)', () => {
      const result = rewriteDistinctOn(
        "SELECT DISTINCT ON (f(a, ')', b)) col FROM t",
      );
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain("PARTITION BY f(a, ')', b)");
    });

    it('does not split a top-level comma list on a comma inside a string (#230)', () => {
      const result = rewriteDistinctOn(
        "SELECT DISTINCT ON (a, b) c FROM t",
      );
      expect(result.rewritten).toBe(true);
      expect(result.sql).toContain('PARTITION BY a, b ORDER BY a, b');
    });

    it('leaves a subquery DISTINCT ON unchanged when a string precedes it (#228)', () => {
      const result = rewriteDistinctOn(
        "SELECT ')' FROM (SELECT DISTINCT ON (a) b FROM t) sub",
      );
      expect(result.rewritten).toBe(false);
    });

    it('leaves a subquery DISTINCT ON unchanged when a balanced paren precedes it (#228)', () => {
      const result = rewriteDistinctOn(
        'SELECT (1) FROM (SELECT DISTINCT ON (a) b FROM t) sub',
      );
      expect(result.rewritten).toBe(false);
    });

    it('leaves a subquery DISTINCT ON unchanged when a comment precedes it (#228)', () => {
      const result = rewriteDistinctOn(
        'SELECT /* c */ * FROM (SELECT DISTINCT ON (a) b FROM t) sub',
      );
      expect(result.rewritten).toBe(false);
    });

    it('leaves an empty DISTINCT ON expression list unchanged', () => {
      const result = rewriteDistinctOn('SELECT DISTINCT ON () b FROM t');
      expect(result.rewritten).toBe(false);
    });
  });
});
