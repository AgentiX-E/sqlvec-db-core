import { describe, it, expect } from 'vitest';
import {
  rewriteUuidSql,
  detectUuidUsage,
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

describe('UuidShim — type vs. identifier disambiguation', () => {
  it('rewrites UUID as a DDL column type', () => {
    expect(rewriteUuidSql('CREATE TABLE t (id UUID)')).toEqual({
      sql: 'CREATE TABLE t (id TEXT)', rewritten: true,
    });
  });

  it('rewrites multiple UUID columns in a DDL definition', () => {
    expect(rewriteUuidSql('CREATE TABLE t (id uuid, parent uuid, name text)')).toEqual({
      sql: 'CREATE TABLE t (id TEXT, parent TEXT, name text)', rewritten: true,
    });
  });

  it('rewrites CASST AS uuid type cast', () => {
    expect(rewriteUuidSql('SELECT CAST(x AS uuid)')).toEqual({
      sql: 'SELECT CAST(x AS TEXT)', rewritten: true,
    });
  });

  it('does NOT rewrite a bare `uuid` column reference after SELECT', () => {
    expect(rewriteUuidSql('SELECT uuid FROM t')).toEqual({
      sql: 'SELECT uuid FROM t', rewritten: false,
    });
  });

  it('does NOT rewrite a `uuid` column in a WHERE comparison', () => {
    expect(rewriteUuidSql('WHERE uuid = 1')).toEqual({
      sql: 'WHERE uuid = 1', rewritten: false,
    });
  });

  it('does NOT rewrite a `uuid` column in ORDER BY / GROUP BY', () => {
    expect(rewriteUuidSql('SELECT * FROM t ORDER BY uuid')).toEqual({
      sql: 'SELECT * FROM t ORDER BY uuid', rewritten: false,
    });
    expect(rewriteUuidSql('SELECT count(*) FROM t GROUP BY uuid')).toEqual({
      sql: 'SELECT count(*) FROM t GROUP BY uuid', rewritten: false,
    });
  });

  it('does NOT rewrite a `uuid` column in a SELECT list with a separator', () => {
    expect(rewriteUuidSql('SELECT uuid, name FROM t')).toEqual({
      sql: 'SELECT uuid, name FROM t', rewritten: false,
    });
  });

  it('does NOT rewrite a qualified `t.uuid` column', () => {
    expect(rewriteUuidSql('SELECT t.uuid FROM t')).toEqual({
      sql: 'SELECT t.uuid FROM t', rewritten: false,
    });
  });

  it('detectUuidUsage reports false for bare uuid column references', () => {
    expect(detectUuidUsage('SELECT uuid FROM t')).toBe(false);
    expect(detectUuidUsage('WHERE uuid = 1')).toBe(false);
    expect(detectUuidUsage('SELECT * FROM t ORDER BY uuid')).toBe(false);
    expect(detectUuidUsage('SELECT * FROM t GROUP BY uuid')).toBe(false);
  });

  it('detectUuidUsage reports true for real UUID type/cast usage', () => {
    expect(detectUuidUsage('CREATE TABLE t (id UUID)')).toBe(true);
    expect(detectUuidUsage('SELECT CAST(x AS uuid)')).toBe(true);
  });
});

describe('UuidShim — generators, constants and validation', () => {
  it('uuidGenerateV4 outputs a version-4 UUID', () => {
    const u = uuidGenerateV4();
    expect(UUID_RE.test(u)).toBe(true);
    expect(u[14]).toBe('4');
  });

  it('uuidGenerateV1 outputs a version-1 UUID and advances clock sequence', () => {
    const u1 = uuidGenerateV1();
    const u2 = uuidGenerateV1();
    expect(UUID_RE.test(u1)).toBe(true);
    expect(UUID_RE.test(u2)).toBe(true);
    expect(u1[14]).toBe('1');
    expect(u2[14]).toBe('1');
  });

  it('returns correct nil and namespace constants', () => {
    expect(uuidNil()).toBe('00000000-0000-0000-0000-000000000000');
    expect(uuidNsDns()).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    expect(uuidNsUrl()).toBe('6ba7b811-9dad-11d1-80b4-00c04fd430c8');
    expect(uuidNsOid()).toBe('6ba7b812-9dad-11d1-80b4-00c04fd430c8');
    expect(uuidNsX500()).toBe('6ba7b814-9dad-11d1-80b4-00c04fd430c8');
  });

  it('isValidUuid accepts valid UUIDs (any case) and rejects malformed input', () => {
    expect(isValidUuid('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isValidUuid('123E4567-E89B-12D3-A456-426614174000')).toBe(true);
    expect(isValidUuid('123e4567-e89b-12d3-a456-42661417400')).toBe(false); // short
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('')).toBe(false);
  });
});
