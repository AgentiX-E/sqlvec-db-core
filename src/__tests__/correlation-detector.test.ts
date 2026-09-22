/**
 * CorrelationDetector — LATERAL subquery correlation detection tests.
 *
 * Covers top-level alias.column detection, deduplication, placeholder
 * generation, and the lexical scanner's handling of nested subqueries, string
 * literals (single/double/backtick with escapes), and both `--` and `/* *\/`
 * comments. Regression coverage for the defects where `alias.column` inside a
 * string literal or comment was falsely reported as a correlation reference.
 */
import { describe, it, expect } from 'vitest';
import {
  detectCorrelation,
  CorrelationResult,
} from '../query/CorrelationDetector';

function detect(sql: string, aliases: string[]): CorrelationResult {
  return detectCorrelation(sql, aliases);
}

describe('CorrelationDetector', () => {
  describe('basic detection', () => {
    it('detects a single top-level correlation reference', () => {
      const r = detect('SELECT * FROM orders o WHERE o.user_id = u.id', ['u']);
      expect(r.hasCorrelation).toBe(true);
      expect(r.refs).toEqual([
        { alias: 'u', column: 'id', fullRef: 'u.id' },
      ]);
    });

    it('detects multiple references for the same alias', () => {
      const r = detect(
        'SELECT * FROM t WHERE x = u.id AND y = u.name',
        ['u'],
      );
      expect(r.refs).toEqual([
        { alias: 'u', column: 'id', fullRef: 'u.id' },
        { alias: 'u', column: 'name', fullRef: 'u.name' },
      ]);
    });

    it('detects alias.* references', () => {
      const r = detect('SELECT * FROM t WHERE x = u.*', ['u']);
      expect(r.refs).toEqual([{ alias: 'u', column: '*', fullRef: 'u.*' }]);
    });

    it('matches aliases case-insensitively', () => {
      const r = detect('SELECT * FROM t WHERE x = U.ID', ['u']);
      expect(r.refs).toEqual([{ alias: 'U', column: 'ID', fullRef: 'U.ID' }]);
    });

    it('detects references for multiple aliases', () => {
      const r = detect('SELECT a.id, b.name FROM t WHERE a.x = b.y', ['a', 'b']);
      const full = r.refs.map(x => x.fullRef).sort();
      expect(full).toEqual(['a.id', 'a.x', 'b.name', 'b.y']);
    });
  });

  describe('placeholder generation', () => {
    it('replaces references with CORR placeholders', () => {
      const r = detect('SELECT * FROM orders o WHERE o.user_id = u.id', ['u']);
      expect(r.sqlWithoutCorrelation).toBe(
        'SELECT * FROM orders o WHERE o.user_id = /* CORR(u.id) */',
      );
    });

    it('replaces multiple references preserving order', () => {
      const r = detect('WHERE u.id = 1 AND u.name = 2', ['u']);
      expect(r.sqlWithoutCorrelation).toBe(
        'WHERE /* CORR(u.id) */ = 1 AND /* CORR(u.name) */ = 2',
      );
    });

    it('deduplicates identical references', () => {
      const r = detect('WHERE u.id = u.id', ['u']);
      expect(r.refs).toHaveLength(1);
      expect(r.sqlWithoutCorrelation).toBe('WHERE /* CORR(u.id) */ = /* CORR(u.id) */');
    });
  });

  describe('string literals (must NOT detect)', () => {
    it('ignores single-quoted strings', () => {
      const r = detect("SELECT * FROM t WHERE x = 'u.id'", ['u']);
      expect(r.hasCorrelation).toBe(false);
      expect(r.sqlWithoutCorrelation).toBe("SELECT * FROM t WHERE x = 'u.id'");
    });

    it('ignores double-quoted identifiers/strings', () => {
      const r = detect('SELECT * FROM t WHERE x = "u.id"', ['u']);
      expect(r.hasCorrelation).toBe(false);
    });

    it('ignores backtick-quoted strings', () => {
      const r = detect('SELECT * FROM t WHERE x = `u.id`', ['u']);
      expect(r.hasCorrelation).toBe(false);
    });

    it('handles backslash-escaped quotes inside strings', () => {
      const r = detect("SELECT * FROM t WHERE x = 'a\\'u.id' AND y = u.id", ['u']);
      // Only the real u.id (after the string) is detected.
      expect(r.refs).toEqual([{ alias: 'u', column: 'id', fullRef: 'u.id' }]);
    });

    it('does not confuse parentheses inside strings', () => {
      const r = detect("SELECT * FROM t WHERE x = ')' AND y = u.id", ['u']);
      expect(r.refs).toEqual([{ alias: 'u', column: 'id', fullRef: 'u.id' }]);
    });
  });

  describe('comments (must NOT detect)', () => {
    it('ignores single-line comments', () => {
      const r = detect('-- comment u.id\nSELECT * FROM t WHERE y = 1', ['u']);
      expect(r.hasCorrelation).toBe(false);
    });

    it('ignores multi-line comments', () => {
      const r = detect('SELECT * FROM t /* u.id */ WHERE y = 1', ['u']);
      expect(r.hasCorrelation).toBe(false);
    });

    it('ignores trailing comments but detects real references', () => {
      const r = detect('SELECT * FROM t WHERE x = u.id /* inner u.id */', ['u']);
      expect(r.refs).toEqual([{ alias: 'u', column: 'id', fullRef: 'u.id' }]);
      expect(r.sqlWithoutCorrelation).toBe(
        'SELECT * FROM t WHERE x = /* CORR(u.id) */ /* inner u.id */',
      );
    });

    it('detects a reference after a fully-closed multi-line comment', () => {
      // The `/* abc *\/` comment closes BEFORE the reference, so the scanner
      // must exit the comment skip loop via the terminator and then still
      // detect the subsequent top-level u.id.
      const r = detect('SELECT * FROM t /* abc */ WHERE x = u.id', ['u']);
      expect(r.refs).toEqual([{ alias: 'u', column: 'id', fullRef: 'u.id' }]);
    });

    it('ignores references inside an unterminated multi-line comment', () => {
      // The comment is never closed; a reference inside it must be skipped and
      // the in-comment scan must terminate at the string boundary.
      expect(detect('/* u.id', ['u']).hasCorrelation).toBe(false);
      expect(detect('/* abc u.id', ['u']).hasCorrelation).toBe(false);
      expect(detect('x /* u.id', ['u']).hasCorrelation).toBe(false);
      // Comment bodies of varying length drive the multi-line skip loop through
      // multiple iterations before hitting the string boundary.
      expect(detect('/* x u.id', ['u']).hasCorrelation).toBe(false);
      expect(detect('/* xx u.id', ['u']).hasCorrelation).toBe(false);
    });
  });

  describe('nested subqueries', () => {
    it('skips references inside parenthesized subqueries (depth > 0)', () => {
      const r = detect('SELECT * FROM t WHERE (x = u.id)', ['u']);
      expect(r.hasCorrelation).toBe(false);
    });

    it('still detects top-level references around nested groups', () => {
      const r = detect('SELECT * FROM t WHERE (x = 1) AND y = u.id', ['u']);
      expect(r.refs).toEqual([{ alias: 'u', column: 'id', fullRef: 'u.id' }]);
    });

    it('tolerates unbalanced closing parentheses (depth clamps at 0)', () => {
      const r = detect('WHERE ) AND u.id = 1', ['u']);
      expect(r.refs).toEqual([{ alias: 'u', column: 'id', fullRef: 'u.id' }]);
    });
  });

  describe('word boundaries', () => {
    it('does not match a longer identifier that merely contains the alias', () => {
      expect(detect('SELECT * FROM t WHERE x = you.id', ['u']).hasCorrelation).toBe(false);
      expect(detect('SELECT * FROM t WHERE x = tu.id', ['u']).hasCorrelation).toBe(false);
      expect(detect('SELECT * FROM t WHERE x = u_1.id', ['u']).hasCorrelation).toBe(false);
    });
  });

  describe('empty / degenerate inputs', () => {
    it('returns empty result for empty SQL', () => {
      const r = detect('', ['u']);
      expect(r).toEqual({ hasCorrelation: false, refs: [], sqlWithoutCorrelation: '' });
    });

    it('returns empty result for empty alias list', () => {
      const r = detect('SELECT 1', []);
      expect(r).toEqual({ hasCorrelation: false, refs: [], sqlWithoutCorrelation: 'SELECT 1' });
    });

    it('skips empty string aliases', () => {
      const r = detect('SELECT * FROM t WHERE x = u.id', ['']);
      expect(r.hasCorrelation).toBe(false);
    });
  });

  describe('regex-special characters in aliases', () => {
    it('escapes regex metacharacters in the alias', () => {
      // Alias containing regex metacharacters must be treated literally.
      const r = detect('SELECT * FROM t WHERE x = u+v', ['u+v']);
      expect(r.hasCorrelation).toBe(false);
    });

    it('detects an alias ending with a letter followed by dot', () => {
      const r = detect('SELECT * FROM t WHERE x = ab.id', ['ab']);
      expect(r.refs).toEqual([{ alias: 'ab', column: 'id', fullRef: 'ab.id' }]);
    });
  });
});
