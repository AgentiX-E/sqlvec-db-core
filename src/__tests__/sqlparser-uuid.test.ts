import { describe, it, expect } from 'vitest';
import {
  detectUuidUsage,
  rewriteUuidSql,
  uuidGenerateV1,
  uuidGenerateV4,
  uuidNil,
  uuidNsDns,
  uuidNsUrl,
  uuidNsOid,
  uuidNsX500,
  isValidUuid,
} from '../query/UuidShim';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// UuidShim rewrites PG UUID constructs to SQLite equivalents. It must not touch
// a UUID function name or type keyword that appears inside a string literal,
// quoted identifier, or (single- or multi-line) comment.
describe('UuidShim', () => {
  describe('detectUuidUsage', () => {
    it('detects each UUID construct', () => {
      expect(detectUuidUsage('SELECT uuid_nil()')).toBe(true);
      expect(detectUuidUsage('SELECT uuid_generate_v4()')).toBe(true);
      expect(detectUuidUsage('SELECT uuid_generate_v1()')).toBe(true);
      expect(detectUuidUsage('SELECT gen_random_uuid()')).toBe(true);
      expect(detectUuidUsage('SELECT uuid_ns_dns()')).toBe(true);
      expect(detectUuidUsage('SELECT uuid_ns_url()')).toBe(true);
      expect(detectUuidUsage('SELECT uuid_ns_oid()')).toBe(true);
      expect(detectUuidUsage('SELECT uuid_ns_x500()')).toBe(true);
      expect(detectUuidUsage("SELECT 'abc'::uuid")).toBe(true);
      expect(detectUuidUsage('CREATE TABLE t (id UUID)')).toBe(true);
    });

    it('does not detect a UUID construct inside a string literal', () => {
      expect(detectUuidUsage("SELECT 'gen_random_uuid()'")).toBe(false);
    });

    it('does not detect a UUID construct inside a single-line comment', () => {
      expect(detectUuidUsage('-- uuid_nil()\nSELECT 1')).toBe(false);
    });

    it('does not detect a UUID construct inside a multi-line comment', () => {
      expect(detectUuidUsage('/* uuid_nil() */ SELECT 1')).toBe(false);
    });

    it('returns false for unrelated SQL and non-string input', () => {
      expect(detectUuidUsage('SELECT 1')).toBe(false);
      expect(detectUuidUsage(null as any)).toBe(false);
      expect(detectUuidUsage(undefined as any)).toBe(false);
    });
  });

  describe('rewriteUuidSql', () => {
    it('rewrites uuid_nil() to the nil constant', () => {
      expect(rewriteUuidSql('SELECT uuid_nil()')).toEqual({
        sql: "SELECT '00000000-0000-0000-0000-000000000000'", rewritten: true,
      });
    });

    it('rewrites namespace functions to their constants', () => {
      expect(rewriteUuidSql('SELECT uuid_ns_dns()').sql).toBe(
        "SELECT '6ba7b810-9dad-11d1-80b4-00c04fd430c8'",
      );
      expect(rewriteUuidSql('SELECT uuid_ns_url()').sql).toBe(
        "SELECT '6ba7b811-9dad-11d1-80b4-00c04fd430c8'",
      );
      expect(rewriteUuidSql('SELECT uuid_ns_oid()').sql).toBe(
        "SELECT '6ba7b812-9dad-11d1-80b4-00c04fd430c8'",
      );
      expect(rewriteUuidSql('SELECT uuid_ns_x500()').sql).toBe(
        "SELECT '6ba7b814-9dad-11d1-80b4-00c04fd430c8'",
      );
    });

    it('rewrites uuid_generate_v4() to a valid v4 literal', () => {
      const r = rewriteUuidSql('SELECT uuid_generate_v4()');
      expect(r.rewritten).toBe(true);
      const inner = r.sql.slice(8, -1); // strip SELECT ' ... '
      expect(UUID_RE.test(inner)).toBe(true);
    });

    it('rewrites uuid_generate_v1() to a valid v1 literal', () => {
      const r = rewriteUuidSql('SELECT uuid_generate_v1()');
      expect(r.rewritten).toBe(true);
      const inner = r.sql.slice(8, -1);
      expect(UUID_RE.test(inner)).toBe(true);
    });

    it('rewrites gen_random_uuid() to hex(randomblob(16))', () => {
      expect(rewriteUuidSql('SELECT gen_random_uuid()')).toEqual({
        sql: 'SELECT hex(randomblob(16))', rewritten: true,
      });
    });

    it('strips ::uuid casts', () => {
      expect(rewriteUuidSql("SELECT 'abc'::uuid")).toEqual({
        sql: "SELECT 'abc'", rewritten: true,
      });
    });

    it('rewrites the UUID type keyword to TEXT', () => {
      expect(rewriteUuidSql('CREATE TABLE t (id UUID)')).toEqual({
        sql: 'CREATE TABLE t (id TEXT)', rewritten: true,
      });
    });

    it('does NOT rewrite a UUID construct inside a string literal', () => {
      expect(rewriteUuidSql("SELECT 'gen_random_uuid()' AS t")).toEqual({
        sql: "SELECT 'gen_random_uuid()' AS t", rewritten: false,
      });
    });

    it('does NOT rewrite a UUID construct inside a comment', () => {
      expect(rewriteUuidSql('-- uuid_nil()\nSELECT 1')).toEqual({
        sql: '-- uuid_nil()\nSELECT 1', rewritten: false,
      });
    });

    it('does NOT rewrite a UUID keyword inside a quoted identifier', () => {
      expect(rewriteUuidSql('SELECT "uuid" FROM t')).toEqual({
        sql: 'SELECT "uuid" FROM t', rewritten: false,
      });
    });

    it('returns passthrough for non-string input', () => {
      expect(rewriteUuidSql(null as any)).toEqual({ sql: '', rewritten: false });
      expect(rewriteUuidSql(undefined as any)).toEqual({ sql: '', rewritten: false });
    });
  });

  describe('generators and constants', () => {
    it('uuidGenerateV4 returns a valid v4 UUID (version 4 nibble)', () => {
      const u = uuidGenerateV4();
      expect(UUID_RE.test(u)).toBe(true);
      expect(u[14]).toBe('4');
    });

    it('uuidGenerateV1 returns a valid v1 UUID (version 1 nibble)', () => {
      const u = uuidGenerateV1();
      expect(UUID_RE.test(u)).toBe(true);
      expect(u[14]).toBe('1');
      // Two successive calls in the same tick exercise the clock-sequence branch
      const u2 = uuidGenerateV1();
      expect(UUID_RE.test(u2)).toBe(true);
    });

    it('returns correct namespace/nil constants', () => {
      expect(uuidNil()).toBe('00000000-0000-0000-0000-000000000000');
      expect(uuidNsDns()).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
      expect(uuidNsUrl()).toBe('6ba7b811-9dad-11d1-80b4-00c04fd430c8');
      expect(uuidNsOid()).toBe('6ba7b812-9dad-11d1-80b4-00c04fd430c8');
      expect(uuidNsX500()).toBe('6ba7b814-9dad-11d1-80b4-00c04fd430c8');
    });

    it('isValidUuid validates correctly', () => {
      expect(isValidUuid('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
      expect(isValidUuid('123E4567-E89B-12D3-A456-426614174000')).toBe(true);
      expect(isValidUuid('not-a-uuid')).toBe(false);
      expect(isValidUuid('')).toBe(false);
    });
  });
});
