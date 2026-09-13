import { describe, it, expect } from 'vitest';
import { detectLargeObjectFunc, rewriteLargeObjectFunc } from '../query/LargeObjectShim';

// LargeObjectShim rewrites PostgreSQL lo_write/lo_read/lo_tell calls to no-op
// stubs, while never touching such mentions inside literals or comments.
describe('LargeObjectShim', () => {
  describe('detectLargeObjectFunc', () => {
    it('detects lo_write, lo_read and lo_tell', () => {
      expect(detectLargeObjectFunc('SELECT lo_write(1, x)')).toBe(true);
      expect(detectLargeObjectFunc('SELECT lo_read(1, 100)')).toBe(true);
      expect(detectLargeObjectFunc('SELECT lo_tell(1)')).toBe(true);
    });

    it('returns false for non-string or blank input', () => {
      expect(detectLargeObjectFunc(123 as unknown as string)).toBe(false);
      expect(detectLargeObjectFunc('')).toBe(false);
      expect(detectLargeObjectFunc('   ')).toBe(false);
    });

    // BUG #86 regression: mention inside a literal/comment is not a keyword.
    it('does not report lo_write inside a string literal', () => {
      expect(detectLargeObjectFunc("SELECT 'lo_write(1, x)'")).toBe(false);
    });

    it('does not report lo_read inside a comment', () => {
      expect(detectLargeObjectFunc('-- lo_read(1, 2)\nSELECT 1')).toBe(false);
    });
  });

  describe('rewriteLargeObjectFunc', () => {
    it('returns blank passthrough for non-string input', () => {
      expect(rewriteLargeObjectFunc(null as unknown as string))
        .toEqual({ sql: '', rewritten: false });
      expect(rewriteLargeObjectFunc(''))
        .toEqual({ sql: '', rewritten: false });
    });

    it('passes through when no large object function is present', () => {
      expect(rewriteLargeObjectFunc('SELECT 1'))
        .toEqual({ sql: 'SELECT 1', rewritten: false });
    });

    it('rewrites lo_write to 0', () => {
      expect(rewriteLargeObjectFunc("SELECT lo_write(1, 'data')"))
        .toEqual({ sql: 'SELECT 0', rewritten: true });
    });

    it('rewrites lo_read to an empty bytea', () => {
      expect(rewriteLargeObjectFunc('SELECT lo_read(1, 100)'))
        .toEqual({ sql: "SELECT X''", rewritten: true });
    });

    it('rewrites lo_tell to 0', () => {
      expect(rewriteLargeObjectFunc('SELECT lo_tell(1)'))
        .toEqual({ sql: 'SELECT 0', rewritten: true });
    });

    it('rewrites multiple large object calls independently', () => {
      expect(rewriteLargeObjectFunc('SELECT lo_write(1, x), lo_tell(2)'))
        .toEqual({ sql: 'SELECT 0, 0', rewritten: true });
    });

    // BUG #84 regression: a string literal must not lose its content.
    it('preserves lo_write inside a string literal', () => {
      expect(rewriteLargeObjectFunc("SELECT 'lo_write(1, x)'"))
        .toEqual({ sql: "SELECT 'lo_write(1, x)'", rewritten: false });
    });

    // BUG #85 regression: a comment must not be corrupted.
    it('preserves lo_read inside a comment', () => {
      expect(rewriteLargeObjectFunc('-- lo_read(1, 2)\nSELECT 1'))
        .toEqual({ sql: '-- lo_read(1, 2)\nSELECT 1', rewritten: false });
    });

    it('detects an empty-arg call but leaves it unreachable (invalid SQL)', () => {
      // detect uses `(` while the rewrite regexes need a non-empty argument
      // list, so an empty call is reported but not rewritten.
      expect(detectLargeObjectFunc('SELECT lo_write()')).toBe(true);
      expect(rewriteLargeObjectFunc('SELECT lo_write()'))
        .toEqual({ sql: 'SELECT lo_write()', rewritten: false });
    });
  });
});
