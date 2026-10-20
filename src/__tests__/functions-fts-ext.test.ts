/**
 * functions-fts-ext.test.ts — Coverage tests for FunctionsFTSExt
 * (PostgreSQL FTS configuration function → SQLite stub rewriting).
 */

import { describe, expect, it } from 'vitest';
import { detectFtsExtFunc, rewriteFtsExtFunc } from '../query/FunctionsFTSExt';

describe('detectFtsExtFunc', () => {
  it('returns false for empty / whitespace / non-string input', () => {
    expect(detectFtsExtFunc('')).toBe(false);
    expect(detectFtsExtFunc('   ')).toBe(false);
    expect(detectFtsExtFunc(undefined as unknown as string)).toBe(false);
    expect(detectFtsExtFunc(null as unknown as string)).toBe(false);
  });

  it('returns false for plain SQL without FTS functions', () => {
    expect(detectFtsExtFunc('SELECT 1')).toBe(false);
    expect(detectFtsExtFunc('SELECT * FROM users')).toBe(false);
    expect(detectFtsExtFunc('INSERT INTO t VALUES (1)')).toBe(false);
  });

  it('detects ts_token_type', () => {
    expect(detectFtsExtFunc('SELECT * FROM ts_token_type(3722)')).toBe(true);
    expect(detectFtsExtFunc('SELECT ts_token_type(0)')).toBe(true);
  });

  it('detects ts_parse', () => {
    expect(detectFtsExtFunc("SELECT * FROM ts_parse('default', 'hello world')")).toBe(true);
    expect(detectFtsExtFunc("SELECT ts_parse('default', 'x')")).toBe(true);
  });

  it('detects both functions together', () => {
    expect(detectFtsExtFunc("SELECT ts_token_type(1), ts_parse('d', 'x')")).toBe(true);
  });

  it('detects with surrounding whitespace and case-insensitivity', () => {
    expect(detectFtsExtFunc('  TS_TOKEN_TYPE(1)  ')).toBe(true);
    expect(detectFtsExtFunc('  ts_parse(\'d\', \'x\')  ')).toBe(true);
  });
});

describe('rewriteFtsExtFunc', () => {
  it('returns unchanged for empty / whitespace / non-string input', () => {
    expect(rewriteFtsExtFunc('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteFtsExtFunc('   ')).toEqual({ sql: '   ', rewritten: false });
    expect(rewriteFtsExtFunc(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteFtsExtFunc(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('passes through plain SQL', () => {
    expect(rewriteFtsExtFunc('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    expect(rewriteFtsExtFunc('SELECT * FROM users')).toEqual({ sql: 'SELECT * FROM users', rewritten: false });
  });

  it('rewrites ts_token_type into a static VALUES subquery', () => {
    const r = rewriteFtsExtFunc('SELECT * FROM ts_token_type(3722)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('SELECT * FROM (VALUES');
    expect(r.sql).toContain("(1, 'asciiword', 'Word, all ASCII')");
    expect(r.sql).toContain("(23, 'float', 'Decimal notation float')");
    expect(r.sql).toContain('AS t(tokid, alias, description)');
    // the original ts_token_type(...) call is gone
    expect(r.sql).not.toContain('ts_token_type');
  });

  it('rewrites ts_parse into a static token placeholder', () => {
    const r = rewriteFtsExtFunc("SELECT * FROM ts_parse('default', 'hello world')");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe("SELECT * FROM (SELECT 1 AS tokid, 'hello world' AS token WHERE 1=0)");
  });

  it('rewrites multiple occurrences in one statement', () => {
    const r = rewriteFtsExtFunc("SELECT ts_token_type(1), ts_parse('d', 'x')");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('tokid');
    expect(r.sql).toContain("'x'");
  });

  it('rewrites ts_parse with empty document (trimmed)', () => {
    const r = rewriteFtsExtFunc("SELECT ts_parse('d', '  ')");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("AS token WHERE 1=0");
  });

  it('detects ts_parse with a single argument but does not rewrite it', () => {
    // ANY_FTS_EXT_RE matches `ts_parse(`, but TS_PARSE_RE requires a comma
    // separating two arguments, so the malformed single-arg call is detected
    // yet left unchanged (rewritten stays false).
    expect(detectFtsExtFunc("SELECT ts_parse('default')")).toBe(true);
    expect(rewriteFtsExtFunc("SELECT ts_parse('default')")).toEqual({
      sql: "SELECT ts_parse('default')",
      rewritten: false,
    });
  });
});
