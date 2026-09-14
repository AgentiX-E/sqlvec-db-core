import { describe, it, expect } from 'vitest';
import { detectExtension, rewriteExtension } from '../query/ExtensionShim';

// ExtensionShim elides PG extension DDL to SELECT 1 and rewrites queries against
// pg_available_extensions / pg_extension to a fixed 13-row result set.
describe('ExtensionShim', () => {
  describe('detectExtension', () => {
    it('detects CREATE/ALTER/DROP EXTENSION', () => {
      expect(detectExtension('CREATE EXTENSION pg_trgm')).toBe(true);
      expect(detectExtension('CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA ext')).toBe(true);
      expect(detectExtension('ALTER EXTENSION pg_trgm UPDATE TO \'1.1\'')).toBe(true);
      expect(detectExtension('DROP EXTENSION pg_trgm')).toBe(true);
      expect(detectExtension('DROP EXTENSION IF EXISTS pg_trgm CASCADE')).toBe(true);
    });

    it('detects system-catalog queries', () => {
      expect(detectExtension('SELECT * FROM pg_available_extensions')).toBe(true);
      expect(detectExtension('SELECT name, default_version FROM pg_available_extensions')).toBe(true);
      expect(detectExtension('SELECT * FROM pg_extension')).toBe(true);
      expect(detectExtension('SELECT extname FROM pg_extension')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(detectExtension('create extension pg_trgm')).toBe(true);
      expect(detectExtension('select * from pg_available_extensions')).toBe(true);
    });

    it('returns false for empty/non-string input', () => {
      expect(detectExtension('')).toBe(false);
      expect(detectExtension('   ')).toBe(false);
      expect(detectExtension(undefined as unknown as string)).toBe(false);
    });

    it('returns false for non-extension SQL', () => {
      expect(detectExtension('SELECT 1')).toBe(false);
      expect(detectExtension('CREATE TABLE t (id INT)')).toBe(false);
    });

    // BUG #89/#90/#91 regression: a token inside a string literal or comment
    // must not be reported (the old `[\s\S]*?` crossed literal/comment bounds).
    it('does not report a system-catalog token inside a string literal or comment', () => {
      expect(detectExtension("SELECT 'FROM pg_available_extensions'")).toBe(false);
      expect(detectExtension("SELECT 'FROM pg_extension'")).toBe(false);
      expect(detectExtension('SELECT 1 -- FROM pg_available_extensions')).toBe(false);
    });
  });

  describe('rewriteExtension', () => {
    it('rewrites CREATE/ALTER/DROP EXTENSION to SELECT 1', () => {
      expect(rewriteExtension('CREATE EXTENSION pg_trgm')).toEqual({ sql: 'SELECT 1', rewritten: true });
      expect(rewriteExtension('ALTER EXTENSION pg_trgm UPDATE')).toEqual({ sql: 'SELECT 1', rewritten: true });
      expect(rewriteExtension('DROP EXTENSION pg_trgm')).toEqual({ sql: 'SELECT 1', rewritten: true });
      expect(rewriteExtension('DROP EXTENSION IF EXISTS pg_trgm')).toEqual({ sql: 'SELECT 1', rewritten: true });
    });

    it('rewrites pg_available_extensions queries to the fixed 13-row set', () => {
      const r = rewriteExtension('SELECT * FROM pg_available_extensions');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain("'citext' as name");
      expect(r.sql).toContain("'postgis', '3.0'");
    });

    it('rewrites pg_extension queries to the fixed 13-row set', () => {
      const r = rewriteExtension('SELECT * FROM pg_extension');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain("'citext' as extname");
      expect(r.sql).toContain("'postgis', '3.0'");
    });

    it('passes through non-extension SQL unchanged', () => {
      expect(rewriteExtension('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
      expect(rewriteExtension('CREATE TABLE t (id INT)'))
        .toEqual({ sql: 'CREATE TABLE t (id INT)', rewritten: false });
    });

    // BUG #89/#90/#91 regression: string/comment content must survive intact.
    it('passes through a catalog token inside a string literal or comment', () => {
      expect(rewriteExtension("SELECT 'FROM pg_available_extensions'"))
        .toEqual({ sql: "SELECT 'FROM pg_available_extensions'", rewritten: false });
      expect(rewriteExtension("SELECT 'FROM pg_extension'"))
        .toEqual({ sql: "SELECT 'FROM pg_extension'", rewritten: false });
      expect(rewriteExtension('SELECT 1 -- FROM pg_available_extensions'))
        .toEqual({ sql: 'SELECT 1 -- FROM pg_available_extensions', rewritten: false });
    });

    it('returns blank passthrough for empty/non-string input', () => {
      expect(rewriteExtension('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteExtension(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    });
  });
});
