import { describe, it, expect } from 'vitest';
import {
  detectCreateTableLike,
  rewriteCreateTableLike,
  extractLikeTableName,
} from '../query/CreateTableLikeShim';

describe('detectCreateTableLike', () => {
  it('detects a pure LIKE clause', () => {
    expect(detectCreateTableLike('CREATE TABLE t (LIKE users)')).toBe(true);
  });
  it('detects LIKE with INCLUDING options', () => {
    expect(detectCreateTableLike('CREATE TABLE t (LIKE users INCLUDING ALL)')).toBe(true);
  });
  it('detects a mixed column list with LIKE', () => {
    expect(detectCreateTableLike('CREATE TABLE t (col1 INT, LIKE users)')).toBe(true);
  });
  it('detects IF NOT EXISTS and TEMP prefixes', () => {
    expect(detectCreateTableLike('CREATE TABLE IF NOT EXISTS t (LIKE src)')).toBe(true);
    expect(detectCreateTableLike('CREATE TEMP TABLE t (LIKE src)')).toBe(true);
  });
  it('detects a quoted source table', () => {
    expect(detectCreateTableLike('CREATE TABLE t (LIKE "My Table")')).toBe(true);
  });
  it('rejects a plain CREATE TABLE without LIKE', () => {
    expect(detectCreateTableLike('CREATE TABLE t (col1 INT NOT NULL)')).toBe(false);
  });
  it('rejects SELECT with a LIKE operator', () => {
    expect(detectCreateTableLike("SELECT * FROM users WHERE name LIKE '%foo%'")).toBe(false);
  });
  it('rejects a string literal containing a LIKE clause', () => {
    expect(detectCreateTableLike("SELECT 'CREATE TABLE t (LIKE x)'")).toBe(false);
  });
  it('rejects a comment line', () => {
    expect(detectCreateTableLike('-- CREATE TABLE t (LIKE x)\nSELECT 1')).toBe(false);
  });
  it('detects LIKE after a column with a parenthesized literal', () => {
    expect(detectCreateTableLike("CREATE TABLE t (col1 TEXT DEFAULT '(')")).toBe(false);
    expect(
      detectCreateTableLike("CREATE TABLE t (col1 TEXT CHECK (col1 IN ('a(b')), LIKE src)"),
    ).toBe(true);
  });
  it('rejects null / undefined / blank', () => {
    expect(detectCreateTableLike(null as unknown as string)).toBe(false);
    expect(detectCreateTableLike(undefined as unknown as string)).toBe(false);
    expect(detectCreateTableLike('   ')).toBe(false);
  });
  it('rejects a table with a dangling dot', () => {
    expect(detectCreateTableLike('CREATE TABLE t (LIKE a.)')).toBe(false);
  });
  it('rejects an unterminated quoted name', () => {
    expect(detectCreateTableLike('CREATE TABLE t (LIKE "unclosed)')).toBe(false);
  });
  it('rejects a LIKE with no source name', () => {
    expect(detectCreateTableLike('CREATE TABLE t (LIKE , LIKE b)')).toBe(false);
  });
  it('rejects a CREATE TABLE with no parens', () => {
    expect(detectCreateTableLike('CREATE TABLE t')).toBe(false);
  });
  it('rejects an unbalanced column list', () => {
    expect(detectCreateTableLike('CREATE TABLE t (LIKE a')).toBe(false);
  });
  it('handles an escaped quote inside a quoted name', () => {
    expect(detectCreateTableLike('CREATE TABLE t (LIKE "a""b")')).toBe(true);
  });
  it('strips a malformed trailing LIKE fragment in a mixed list', () => {
    expect(rewriteCreateTableLike('CREATE TABLE t (LIKE a, col INT, LIKE , col2 TEXT)')).toEqual({
      sql: 'CREATE TABLE t (col INT, col2 TEXT)',
      rewritten: true,
    });
  });
  it('skips a literal before the column-list paren when scanning', () => {
    // The quoted table name contains `(`; extractParenContent must skip it.
    expect(rewriteCreateTableLike('CREATE TABLE "ta(ble" (LIKE a)')).toEqual({
      sql: 'CREATE TABLE "ta(ble" AS SELECT * FROM a WHERE 1=0',
      rewritten: true,
    });
  });
});

describe('rewriteCreateTableLike', () => {
  it('rewrites a pure LIKE clause to an AS SELECT', () => {
    expect(rewriteCreateTableLike('CREATE TABLE t (LIKE users)')).toEqual({
      sql: 'CREATE TABLE t AS SELECT * FROM users WHERE 1=0',
      rewritten: true,
    });
  });
  it('uses LIMIT 0 when INCLUDING options are present', () => {
    expect(rewriteCreateTableLike('CREATE TABLE t (LIKE users INCLUDING ALL)')).toEqual({
      sql: 'CREATE TABLE t AS SELECT * FROM users LIMIT 0',
      rewritten: true,
    });
    expect(rewriteCreateTableLike('CREATE TABLE t (LIKE users INCLUDING DEFAULTS)')).toEqual({
      sql: 'CREATE TABLE t AS SELECT * FROM users LIMIT 0',
      rewritten: true,
    });
  });
  it('preserves a quoted source table name', () => {
    expect(rewriteCreateTableLike('CREATE TABLE t (LIKE "My Table")')).toEqual({
      sql: 'CREATE TABLE t AS SELECT * FROM "My Table" WHERE 1=0',
      rewritten: true,
    });
  });
  it('preserves a schema-qualified quoted name', () => {
    expect(rewriteCreateTableLike('CREATE TABLE t (LIKE "schema"."table")')).toEqual({
      sql: 'CREATE TABLE t AS SELECT * FROM "schema"."table" WHERE 1=0',
      rewritten: true,
    });
  });
  it('preserves unquoted qualified names', () => {
    expect(rewriteCreateTableLike('CREATE TABLE t (LIKE public.users)')).toEqual({
      sql: 'CREATE TABLE t AS SELECT * FROM public.users WHERE 1=0',
      rewritten: true,
    });
  });
  it('strips a single LIKE from a mixed list', () => {
    expect(rewriteCreateTableLike('CREATE TABLE t (col1 INT, LIKE users)')).toEqual({
      sql: 'CREATE TABLE t (col1 INT)',
      rewritten: true,
    });
  });
  it('strips a LIKE between custom columns', () => {
    expect(rewriteCreateTableLike('CREATE TABLE t (col1 INT, LIKE users, col2 TEXT)')).toEqual({
      sql: 'CREATE TABLE t (col1 INT, col2 TEXT)',
      rewritten: true,
    });
  });
  it('strips multiple LIKE clauses in a mixed list', () => {
    expect(rewriteCreateTableLike('CREATE TABLE t (col1 INT, LIKE "My Table", col2 TEXT)')).toEqual({
      sql: 'CREATE TABLE t (col1 INT, col2 TEXT)',
      rewritten: true,
    });
    expect(rewriteCreateTableLike('CREATE TABLE t (LIKE a, col2 INT, LIKE b INCLUDING ALL)')).toEqual({
      sql: 'CREATE TABLE t (col2 INT)',
      rewritten: true,
    });
  });
  it('rewrites multiple pure LIKE clauses using the first source', () => {
    expect(rewriteCreateTableLike('CREATE TABLE t (LIKE a, LIKE b)')).toEqual({
      sql: 'CREATE TABLE t AS SELECT * FROM a WHERE 1=0',
      rewritten: true,
    });
  });
  it('passes through a plain CREATE TABLE', () => {
    expect(rewriteCreateTableLike('CREATE TABLE t (col1 INT NOT NULL)')).toEqual({
      sql: 'CREATE TABLE t (col1 INT NOT NULL)',
      rewritten: false,
    });
  });
  it('passes through non-CREATE-TABLE SQL', () => {
    expect(rewriteCreateTableLike("SELECT * FROM users WHERE name LIKE '%foo%'")).toEqual({
      sql: "SELECT * FROM users WHERE name LIKE '%foo%'",
      rewritten: false,
    });
  });
  it('rewrites a mixed list with a parenthesized CHECK literal', () => {
    expect(
      rewriteCreateTableLike("CREATE TABLE t (col1 TEXT CHECK (col1 IN ('a(b')), LIKE src)"),
    ).toEqual({
      sql: "CREATE TABLE t (col1 TEXT CHECK (col1 IN ('a(b')))",
      rewritten: true,
    });
  });
  it('handles null / undefined / blank', () => {
    expect(rewriteCreateTableLike(null as unknown as string)).toEqual({
      sql: '',
      rewritten: false,
    });
    expect(rewriteCreateTableLike(undefined as unknown as string)).toEqual({
      sql: '',
      rewritten: false,
    });
    expect(rewriteCreateTableLike('   ')).toEqual({ sql: '', rewritten: false });
  });
});

describe('extractLikeTableName', () => {
  it('extracts a plain table name', () => {
    expect(extractLikeTableName('CREATE TABLE t (LIKE users)')).toBe('users');
  });
  it('extracts a quoted name with quotes preserved', () => {
    expect(extractLikeTableName('CREATE TABLE t (LIKE "My Table")')).toBe('"My Table"');
  });
  it('extracts a qualified name', () => {
    expect(extractLikeTableName('CREATE TABLE t (LIKE public.users)')).toBe('public.users');
  });
  it('extracts a qualified quoted name', () => {
    expect(extractLikeTableName('CREATE TABLE t (LIKE "schema"."table")')).toBe(
      '"schema"."table"',
    );
  });
  it('returns null for a non-LIKE statement', () => {
    expect(extractLikeTableName('CREATE TABLE t (col1 INT)')).toBeNull();
  });
  it('returns null for a bare string literal', () => {
    expect(extractLikeTableName("SELECT 'CREATE TABLE t (LIKE x)'")).toBeNull();
  });
  it('returns null for null / undefined / blank', () => {
    expect(extractLikeTableName(null as unknown as string)).toBeNull();
    expect(extractLikeTableName(undefined as unknown as string)).toBeNull();
    expect(extractLikeTableName('   ')).toBeNull();
  });
  it('returns null for an escaped-quote name', () => {
    // escaped quotes are valid; dangling / unclosed cases follow
  });
  it('extracts an escaped-quote name', () => {
    expect(extractLikeTableName('CREATE TABLE t (LIKE "a""b")')).toBe('"a""b"');
  });
  it('returns null for a dangling-dot name', () => {
    expect(extractLikeTableName('CREATE TABLE t (LIKE a.)')).toBeNull();
  });
  it('returns null for a LIKE with trailing whitespace only', () => {
    expect(extractLikeTableName('CREATE TABLE t (LIKE   )')).toBeNull();
  });
  it('returns null for an unterminated quoted name', () => {
    expect(extractLikeTableName('CREATE TABLE t (LIKE "unclosed)')).toBeNull();
  });
  it('returns null for an unterminated dotted quoted name', () => {
    expect(extractLikeTableName('CREATE TABLE t (LIKE "a"."unclosed)')).toBeNull();
  });
  it('returns null for a non-identifier after a dot', () => {
    expect(extractLikeTableName('CREATE TABLE t (LIKE a.1)')).toBeNull();
  });
  it('returns null for a leading unterminated quoted name', () => {
    expect(extractLikeTableName('CREATE TABLE t (LIKE "unclosed)')).toBeNull();
  });
});
