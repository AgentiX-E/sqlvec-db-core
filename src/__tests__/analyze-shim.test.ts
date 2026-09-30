import { describe, it, expect } from 'vitest';
import {
  detectPgAnalyze,
  rewriteAnalyze,
  _isAnalyzeStart,
  setAnalyzeMutationHook,
} from '../query/AnalyzeShim';

describe('detectPgAnalyze', () => {
  it('returns false for bare ANALYZE', () => {
    expect(detectPgAnalyze('ANALYZE;')).toBe(false);
    expect(detectPgAnalyze('ANALYZE')).toBe(false);
  });
  it('returns false for ANALYZE table_name', () => {
    expect(detectPgAnalyze('ANALYZE users;')).toBe(false);
  });
  it('returns true for ANALYZE VERBOSE', () => {
    expect(detectPgAnalyze('ANALYZE VERBOSE;')).toBe(true);
    expect(detectPgAnalyze('ANALYZE VERBOSE')).toBe(true);
  });
  it('returns true for a column list', () => {
    expect(detectPgAnalyze('ANALYZE users (id, name);')).toBe(true);
    expect(detectPgAnalyze('ANALYZE (col1, col2);')).toBe(true);
  });
  it('returns true for VERBOSE + column list', () => {
    expect(detectPgAnalyze('ANALYZE VERBOSE users (id, name);')).toBe(true);
  });
  it('returns false for non-ANALYZE SQL', () => {
    expect(detectPgAnalyze('SELECT * FROM users;')).toBe(false);
  });
  it('returns false for a string literal containing ANALYZE VERBOSE', () => {
    expect(detectPgAnalyze("SELECT 'ANALYZE VERBOSE';")).toBe(false);
  });
  it('returns false for a comment line', () => {
    expect(detectPgAnalyze('-- ANALYZE VERBOSE users\nSELECT 1')).toBe(false);
  });
  it('returns false for a table name merely containing verbose', () => {
    expect(detectPgAnalyze('ANALYZE my_verbose_table;')).toBe(false);
  });
  it('returns true for a quoted-identifier table with a column list', () => {
    expect(detectPgAnalyze('ANALYZE "my table" (a);')).toBe(true);
  });
  it('returns false for null / undefined / blank', () => {
    expect(detectPgAnalyze(null as unknown as string)).toBe(false);
    expect(detectPgAnalyze(undefined as unknown as string)).toBe(false);
    expect(detectPgAnalyze('   ')).toBe(false);
  });
  it('returns false for an unterminated quoted identifier', () => {
    expect(detectPgAnalyze('ANALYZE "unclosed (a)')).toBe(false);
  });
  it('returns false for an unterminated column list', () => {
    expect(detectPgAnalyze('ANALYZE users (a')).toBe(false);
  });
  it('handles a string literal inside a column list', () => {
    expect(detectPgAnalyze('ANALYZE (a, "x,y")')).toBe(true);
  });
  it('handles nested parentheses inside a column list', () => {
    expect(detectPgAnalyze('ANALYZE (f(x), y)')).toBe(true);
  });
  it('handles a comment between ANALYZE and the table name', () => {
    expect(detectPgAnalyze('ANALYZE -- c\nusers (a)')).toBe(true);
  });
  it('returns false for a non-identifier token after ANALYZE', () => {
    expect(detectPgAnalyze('ANALYZE 123')).toBe(false);
  });
});

describe('rewriteAnalyze', () => {
  it('passes through bare ANALYZE unchanged', () => {
    expect(rewriteAnalyze('ANALYZE;')).toEqual({ sql: 'ANALYZE;', rewritten: false });
    expect(rewriteAnalyze('ANALYZE users;')).toEqual({ sql: 'ANALYZE users;', rewritten: false });
  });
  it('strips VERBOSE only', () => {
    expect(rewriteAnalyze('ANALYZE VERBOSE;')).toEqual({ sql: 'ANALYZE;', rewritten: true });
    expect(rewriteAnalyze('ANALYZE VERBOSE')).toEqual({ sql: 'ANALYZE', rewritten: true });
    expect(rewriteAnalyze('ANALYZE VERBOSE ; ')).toEqual({ sql: 'ANALYZE;', rewritten: true });
  });
  it('strips VERBOSE + keeps table name', () => {
    expect(rewriteAnalyze('ANALYZE VERBOSE users;')).toEqual({
      sql: 'ANALYZE users;',
      rewritten: true,
    });
  });
  it('strips a column list', () => {
    expect(rewriteAnalyze('ANALYZE users (id, name);')).toEqual({
      sql: 'ANALYZE users;',
      rewritten: true,
    });
    expect(rewriteAnalyze('ANALYZE (col1, col2);')).toEqual({ sql: 'ANALYZE;', rewritten: true });
  });
  it('strips VERBOSE + column list', () => {
    expect(rewriteAnalyze('ANALYZE VERBOSE users (id, name);')).toEqual({
      sql: 'ANALYZE users;',
      rewritten: true,
    });
  });
  it('handles VERBOSE directly before a column list', () => {
    expect(rewriteAnalyze('ANALYZE VERBOSE (a)')).toEqual({ sql: 'ANALYZE', rewritten: true });
    expect(rewriteAnalyze('ANALYZE VERBOSE(c1, c2);')).toEqual({
      sql: 'ANALYZE;',
      rewritten: true,
    });
  });
  it('preserves a quoted-identifier table name', () => {
    expect(rewriteAnalyze('ANALYZE "my table" (a);')).toEqual({
      sql: 'ANALYZE "my table";',
      rewritten: true,
    });
    expect(rewriteAnalyze('ANALYZE VERBOSE "my table" (a);')).toEqual({
      sql: 'ANALYZE "my table";',
      rewritten: true,
    });
  });
  it('preserves doubled double-quotes inside an identifier', () => {
    expect(rewriteAnalyze('ANALYZE "weird""name" (a);')).toEqual({
      sql: 'ANALYZE "weird""name";',
      rewritten: true,
    });
  });
  it('passes through non-ANALYZE SQL', () => {
    expect(rewriteAnalyze('SELECT * FROM users;')).toEqual({
      sql: 'SELECT * FROM users;',
      rewritten: false,
    });
  });
  it('preserves leading/trailing whitespace trimming', () => {
    expect(rewriteAnalyze('  ANALYZE VERBOSE users (x, y)  ;  ')).toEqual({
      sql: 'ANALYZE users;',
      rewritten: true,
    });
  });
  it('handles a column list without trailing semicolon', () => {
    expect(rewriteAnalyze('ANALYZE t (a)')).toEqual({ sql: 'ANALYZE t', rewritten: true });
    expect(rewriteAnalyze('ANALYZE t(col_a, col_b)')).toEqual({
      sql: 'ANALYZE t',
      rewritten: true,
    });
  });
  it('handles null / undefined / blank', () => {
    expect(rewriteAnalyze(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteAnalyze(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteAnalyze('   ')).toEqual({ sql: '   ', rewritten: false });
  });
  it('passes through an unterminated quoted identifier', () => {
    expect(rewriteAnalyze('ANALYZE "unclosed (a)')).toEqual({
      sql: 'ANALYZE "unclosed (a)',
      rewritten: false,
    });
  });
  it('keeps the first token as the table name when extra tokens follow', () => {
    expect(rewriteAnalyze('ANALYZE t t2 (a)')).toEqual({ sql: 'ANALYZE t', rewritten: true });
  });
  it('drops a column list containing a nested/string expression', () => {
    expect(rewriteAnalyze('ANALYZE (a, "x,y")')).toEqual({ sql: 'ANALYZE', rewritten: true });
    expect(rewriteAnalyze('ANALYZE (f(x), y)')).toEqual({ sql: 'ANALYZE', rewritten: true });
  });
  it('handles a comment between ANALYZE and the table', () => {
    expect(rewriteAnalyze('ANALYZE -- c\nusers (a)')).toEqual({
      sql: 'ANALYZE users',
      rewritten: true,
    });
  });
});

describe('setAnalyzeMutationHook', () => {
  it('invokes the hook with the extracted table name on rewrite', () => {
    const seen: Array<string | undefined> = [];
    setAnalyzeMutationHook((t) => seen.push(t));
    try {
      rewriteAnalyze('ANALYZE VERBOSE users (id, name);');
      expect(seen).toEqual(['users']);
    } finally {
      setAnalyzeMutationHook(null);
    }
  });
  it('invokes the hook with undefined when no table name', () => {
    const seen: Array<string | undefined> = [];
    setAnalyzeMutationHook((t) => seen.push(t));
    try {
      rewriteAnalyze('ANALYZE VERBOSE;');
      expect(seen).toEqual([undefined]);
    } finally {
      setAnalyzeMutationHook(null);
    }
  });
  it('does not invoke the hook for non-rewrite statements', () => {
    const seen: Array<string | undefined> = [];
    setAnalyzeMutationHook((t) => seen.push(t));
    try {
      rewriteAnalyze('ANALYZE users;');
      rewriteAnalyze('SELECT 1;');
      expect(seen).toEqual([]);
    } finally {
      setAnalyzeMutationHook(null);
    }
  });
});

describe('_isAnalyzeStart', () => {
  it('detects an ANALYZE prefix', () => {
    expect(_isAnalyzeStart('ANALYZE x')).toBe(true);
    expect(_isAnalyzeStart('  ANALYZE')).toBe(true);
  });
  it('rejects non-ANALYZE', () => {
    expect(_isAnalyzeStart('SELECT 1')).toBe(false);
    expect(_isAnalyzeStart('ANALYZED')).toBe(false);
  });
});
