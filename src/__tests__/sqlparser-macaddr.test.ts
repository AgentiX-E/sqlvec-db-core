import { describe, it, expect } from 'vitest';
import { detectNetType, rewriteNetType, simplifyNetExpr } from '../query/MacAddrShim';

// MacAddrShim rewrites PostgreSQL network types (MACADDR/MACADDR8/INET/CIDR)
// to TEXT for SQLite. It must not touch a network type name that appears inside
// a string literal, quoted identifier, or comment.
describe('MacAddrShim', () => {
  describe('detectNetType', () => {
    it('detects each supported network type (case-insensitive)', () => {
      expect(detectNetType('CREATE TABLE t (ip INET)')).toBe(true);
      expect(detectNetType('CREATE TABLE t (ip inet)')).toBe(true);
      expect(detectNetType('CREATE TABLE t (mac MACADDR)')).toBe(true);
      expect(detectNetType('CREATE TABLE t (mac MACADDR8)')).toBe(true);
      expect(detectNetType('CREATE TABLE t (c CIDR)')).toBe(true);
    });

    it('does not report a network type inside a string literal', () => {
      expect(detectNetType("SELECT 'inet'")).toBe(false);
    });

    it('does not report a network type inside a comment', () => {
      expect(detectNetType('-- cidr\nSELECT 1')).toBe(false);
    });

    it('returns false for unrelated SQL', () => {
      expect(detectNetType('SELECT 1')).toBe(false);
    });

    it('returns false for non-string input', () => {
      expect(detectNetType(null as any)).toBe(false);
      expect(detectNetType(undefined as any)).toBe(false);
    });
  });

  describe('rewriteNetType', () => {
    it('rewrites network types to TEXT', () => {
      expect(rewriteNetType('CREATE TABLE t (ip INET, mac MACADDR)')).toEqual({
        sql: 'CREATE TABLE t (ip TEXT, mac TEXT)', rewritten: true,
      });
    });

    it('rewrites MACADDR8 and CIDR', () => {
      expect(rewriteNetType('CREATE TABLE t (m MACADDR8, c CIDR)')).toEqual({
        sql: 'CREATE TABLE t (m TEXT, c TEXT)', rewritten: true,
      });
    });

    it('does NOT rewrite a network type inside a string literal', () => {
      expect(rewriteNetType("SELECT 'inet' AS t")).toEqual({
        sql: "SELECT 'inet' AS t", rewritten: false,
      });
    });

    it('does NOT rewrite a network type inside a comment', () => {
      expect(rewriteNetType('-- cidr\nSELECT 1')).toEqual({
        sql: '-- cidr\nSELECT 1', rewritten: false,
      });
    });

    it('does NOT rewrite a network type inside a quoted identifier', () => {
      expect(rewriteNetType('SELECT "inet" FROM t')).toEqual({
        sql: 'SELECT "inet" FROM t', rewritten: false,
      });
    });

    it('returns unchanged for SQL without network types', () => {
      expect(rewriteNetType('CREATE TABLE t (id INT)')).toEqual({
        sql: 'CREATE TABLE t (id INT)', rewritten: false,
      });
    });

    it('returns passthrough for non-string input', () => {
      expect(rewriteNetType(null as any)).toEqual({ sql: null, rewritten: false });
      expect(rewriteNetType(undefined as any)).toEqual({ sql: undefined, rewritten: false });
    });
  });

  describe('simplifyNetExpr', () => {
    it('passes network expressions through unchanged', () => {
      expect(simplifyNetExpr("inet '1.2.3.4' <<= inet '1.2.0.0/16'")).toEqual({
        sql: "inet '1.2.3.4' <<= inet '1.2.0.0/16'", rewritten: false,
      });
    });

    it('returns passthrough for non-string input', () => {
      expect(simplifyNetExpr(null as any)).toEqual({ sql: null, rewritten: false });
    });
  });
});
