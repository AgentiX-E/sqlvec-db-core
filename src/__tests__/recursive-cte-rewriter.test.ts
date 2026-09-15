import { describe, it, expect } from 'vitest';
import {
  detectCte,
  detectRecursiveCte,
  extractCteMaterialization,
  rewriteCte,
} from '../query/RecursiveCteRewriter';

// RecursiveCteRewriter strips PostgreSQL CTE extensions (MATERIALIZED / SEARCH
// / CYCLE) for SQLite. Tests lock the literal/comment protection and the
// extraction/detection/rewrite contracts.
describe('RecursiveCteRewriter', () => {
  describe('extractCteMaterialization', () => {
    it('extracts CTE names and materialization hints', () => {
      expect(
        extractCteMaterialization(
          'WITH x AS MATERIALIZED (SELECT 1), y AS NOT MATERIALIZED (SELECT 2) SELECT * FROM x, y',
        ),
      ).toEqual([
        { name: 'x', materialized: true },
        { name: 'y', materialized: false },
      ]);
    });

    it('returns materialized null when no hint is present', () => {
      expect(extractCteMaterialization('WITH x AS (SELECT 1) SELECT * FROM x'))
        .toEqual([{ name: 'x', materialized: null }]);
    });

    it('handles a quoted CTE name', () => {
      expect(extractCteMaterialization('WITH "my cte" AS (SELECT 1) SELECT * FROM "my cte"'))
        .toEqual([{ name: 'my cte', materialized: null }]);
    });

    it('returns an empty list when there is no WITH clause', () => {
      expect(extractCteMaterialization('SELECT * FROM t')).toEqual([]);
    });

    it('handles a CTE body with a nested parenthesized expression', () => {
      expect(extractCteMaterialization('WITH x AS (SELECT (a + b)) SELECT * FROM x'))
        .toEqual([{ name: 'x', materialized: null }]);
    });

    it('handles a compact form without AS and surrounding whitespace', () => {
      expect(extractCteMaterialization('WITH x(SELECT 1) SELECT * FROM x'))
        .toEqual([{ name: 'x', materialized: null }]);
    });

    it('returns an empty list for a WITH clause with no CTE definitions', () => {
      expect(extractCteMaterialization('WITH ')).toEqual([]);
    });

    it('returns an empty list for an invalid CTE name', () => {
      expect(extractCteMaterialization('WITH 123 AS (SELECT 1) SELECT * FROM x')).toEqual([]);
    });

    it('records the name before stopping at a malformed CTE with no body', () => {
      // The name is pushed before the body-paren scan, so a missing `(` still
      // yields the extracted name (with its materialization hint) but no body.
      expect(extractCteMaterialization('WITH x AS MATERIALIZED'))
        .toEqual([{ name: 'x', materialized: true }]);
    });
  });

  describe('detectCte', () => {
    it('detects a WITH clause', () => {
      expect(detectCte('WITH t AS (SELECT 1) SELECT * FROM t')).toBe(true);
    });

    it('detects WITH RECURSIVE', () => {
      expect(detectCte('WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t')).toBe(true);
    });

    it('returns false without a WITH clause', () => {
      expect(detectCte('SELECT * FROM t')).toBe(false);
    });

    // BUG #101 regression: WITH inside a string is not a real clause.
    it('does not report WITH inside a string literal', () => {
      expect(detectCte("SELECT 'WITH t AS (SELECT 1)'")).toBe(false);
    });
  });

  describe('detectRecursiveCte', () => {
    it('detects WITH RECURSIVE', () => {
      expect(detectRecursiveCte('WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t')).toBe(true);
    });

    it('returns false for a non-recursive WITH', () => {
      expect(detectRecursiveCte('WITH t AS (SELECT 1) SELECT * FROM t')).toBe(false);
    });

    it('returns false without WITH', () => {
      expect(detectRecursiveCte('SELECT * FROM t')).toBe(false);
    });
  });

  describe('rewriteCte', () => {
    it('strips AS MATERIALIZED', () => {
      expect(rewriteCte('WITH cte AS MATERIALIZED (SELECT 1) SELECT * FROM cte'))
        .toEqual({ sql: 'WITH cte AS (SELECT 1) SELECT * FROM cte', rewritten: true });
    });

    it('strips AS NOT MATERIALIZED', () => {
      expect(rewriteCte('WITH cte AS NOT MATERIALIZED (SELECT 1) SELECT * FROM cte'))
        .toEqual({ sql: 'WITH cte AS (SELECT 1) SELECT * FROM cte', rewritten: true });
    });

    it('removes a SEARCH clause', () => {
      expect(
        rewriteCte(
          'WITH RECURSIVE cte AS (SELECT 1) SEARCH DEPTH FIRST BY n SET ordering SELECT * FROM cte',
        ),
      ).toEqual({
        sql: 'WITH RECURSIVE cte AS (SELECT 1) SELECT * FROM cte',
        rewritten: true,
      });
    });

    it('removes a SEARCH BREADTH clause', () => {
      expect(
        rewriteCte(
          'WITH RECURSIVE cte AS (SELECT 1) SEARCH BREADTH FIRST BY n SET ordering SELECT * FROM cte',
        ),
      ).toEqual({
        sql: 'WITH RECURSIVE cte AS (SELECT 1) SELECT * FROM cte',
        rewritten: true,
      });
    });

    it('removes a CYCLE clause', () => {
      expect(
        rewriteCte(
          "WITH RECURSIVE cte AS (SELECT 1) CYCLE n SET is_cycle TO '1' DEFAULT '0' SELECT * FROM cte",
        ),
      ).toEqual({
        sql: 'WITH RECURSIVE cte AS (SELECT 1) SELECT * FROM cte',
        rewritten: true,
      });
    });

    it('removes SEARCH and CYCLE in sequence', () => {
      expect(
        rewriteCte(
          "WITH RECURSIVE cte AS (SELECT 1) SEARCH DEPTH FIRST BY n SET ord CYCLE n SET cyc TO '1' DEFAULT '0' SELECT * FROM cte",
        ),
      ).toEqual({
        sql: 'WITH RECURSIVE cte AS (SELECT 1) SELECT * FROM cte',
        rewritten: true,
      });
    });

    it('returns rewritten:false when no PG extension is present', () => {
      expect(rewriteCte('WITH cte AS (SELECT 1) SELECT * FROM cte'))
        .toEqual({ sql: 'WITH cte AS (SELECT 1) SELECT * FROM cte', rewritten: false });
    });

    it('returns rewritten:false for SQL without a WITH clause', () => {
      expect(rewriteCte('SELECT * FROM t'))
        .toEqual({ sql: 'SELECT * FROM t', rewritten: false });
    });

    // BUG #102 regression: AS MATERIALIZED inside a string is not rewritten.
    it('leaves AS MATERIALIZED inside a string intact', () => {
      expect(rewriteCte("SELECT 'AS MATERIALIZED (' FROM t"))
        .toEqual({ sql: "SELECT 'AS MATERIALIZED (' FROM t", rewritten: false });
    });

    // BUG #103 regression: a SEARCH-like token inside a string is not rewritten.
    it('leaves a SEARCH-like token inside a string intact', () => {
      expect(rewriteCte("SELECT ') SEARCH DEPTH FIRST BY x SET y'"))
        .toEqual({ sql: "SELECT ') SEARCH DEPTH FIRST BY x SET y'", rewritten: false });
    });

    // BUG #104 regression: a CYCLE-like token inside a comment is not rewritten.
    it('leaves a CYCLE-like token inside a comment intact', () => {
      expect(rewriteCte("SELECT 1 -- ) CYCLE n SET m TO '1'"))
        .toEqual({ sql: "SELECT 1 -- ) CYCLE n SET m TO '1'", rewritten: false });
    });
  });
});
