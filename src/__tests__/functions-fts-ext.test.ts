/**
 * functions-fts-ext.test.ts — Coverage tests for FunctionsFTSExt (FTS config
 * function compatibility shim).
 *
 * Verifies detection and rewriting of PostgreSQL FTS configuration functions
 * (ts_token_type / ts_parse) into SQLite-compatible expressions.
 */

import { describe, it, expect } from 'vitest';
import { detectFtsExtFunc, rewriteFtsExtFunc } from '../query/FunctionsFTSExt';

describe('detectFtsExtFunc', () => {
  it('returns false for non-string input', () => {
    expect(detectFtsExtFunc(undefined as unknown as string)).toBe(false);
    expect(detectFtsExtFunc(null as unknown as string)).toBe(false);
    expect(detectFtsExtFunc(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectFtsExtFunc('')).toBe(false);
    expect(detectFtsExtFunc('   ')).toBe(false);
  });

  it('returns true for ts_token_type', () => {
    expect(detectFtsExtFunc('SELECT * FROM ts_token_type(3722)')).toBe(true);
  });

  it('returns true for ts_parse', () => {
    expect(detectFtsExtFunc("SELECT * FROM ts_parse('default', 'hello world')")).toBe(true);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectFtsExtFunc('SELECT 1')).toBe(false);
    expect(detectFtsExtFunc('SELECT * FROM users')).toBe(false);
  });
});

describe('rewriteFtsExtFunc', () => {
  it('returns pass-through for non-string input', () => {
    expect(rewriteFtsExtFunc(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteFtsExtFunc(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns pass-through for empty string', () => {
    expect(rewriteFtsExtFunc('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through SQL without FTS functions', () => {
    expect(rewriteFtsExtFunc('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites ts_token_type into a static VALUES subquery', () => {
    const { sql, rewritten } = rewriteFtsExtFunc('SELECT * FROM ts_token_type(3722)');
    expect(rewritten).toBe(true);
    expect(sql).toContain('(VALUES');
    expect(sql).toContain('asciiword');
    expect(sql).not.toContain('ts_token_type(');
  });

  it('rewrites ts_parse into a token subquery', () => {
    const { sql, rewritten } = rewriteFtsExtFunc("SELECT * FROM ts_parse('default', 'hello world')");
    expect(rewritten).toBe(true);
    expect(sql).toContain('SELECT 1 AS tokid');
    expect(sql).toContain('hello world');
  });

  it('rewrites multiple FTS functions in one statement', () => {
    const { sql, rewritten } = rewriteFtsExtFunc(
      "SELECT * FROM ts_token_type(1) UNION ALL SELECT * FROM ts_parse('d', 'x y')",
    );
    expect(rewritten).toBe(true);
    expect(sql).toContain('asciiword');
    expect(sql).toContain('SELECT 1 AS tokid');
  });

  it('handles ts_token_type with no argument', () => {
    const { sql, rewritten } = rewriteFtsExtFunc('SELECT * FROM ts_token_type()');
    expect(rewritten).toBe(true);
    expect(sql).toContain('asciiword');
  });

  it('passes through when FTS function is detected but malformed', () => {
    // `ts_token_type(` without a closing paren: ANY_FTS_EXT_RE matches,
    // but TS_TOKEN_TYPE_RE requires a balanced `)`, so no rewrite occurs.
    const { sql, rewritten } = rewriteFtsExtFunc('SELECT * FROM ts_token_type(3722');
    expect(rewritten).toBe(false);
    expect(sql).toBe('SELECT * FROM ts_token_type(3722');
  });

  it('passes through ts_parse with a single argument', () => {
    // ts_parse requires two args; a single-arg call is detected but not rewritten.
    const { sql, rewritten } = rewriteFtsExtFunc("SELECT * FROM ts_parse('default')");
    expect(rewritten).toBe(false);
    expect(sql).toBe("SELECT * FROM ts_parse('default')");
  });
});
