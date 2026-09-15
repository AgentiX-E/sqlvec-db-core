import { describe, it, expect, beforeEach } from 'vitest';
import { GucSystem } from '../core/GucSystem';
import {
  storeComment,
  getComment,
  getAllComments,
  clearAllComments,
  parseSetConfigArgs,
  parseCommentOnArgs,
  detectPgDumpSyntax,
  rewritePgDumpSql,
  extractPgDumpTables,
  _isAlterTableOnly,
  _isCommentOn,
  _isAlterFunctionDependsOnExtension,
} from '../query/PgDumpCompatibilityShim';

describe('comment store', () => {
  beforeEach(() => clearAllComments());

  it('stores and retrieves a comment', () => {
    storeComment('TABLE', 't', 'hello world');
    expect(getComment('TABLE', 't')).toBe('hello world');
    expect(getComment('table', 'T')).toBe('hello world'); // case-insensitive key
  });

  it('returns null for a missing comment', () => {
    expect(getComment('TABLE', 'missing')).toBeNull();
  });

  it('deletes a comment when storing an empty string', () => {
    storeComment('TABLE', 't', 'hello');
    storeComment('TABLE', 't', '');
    expect(getComment('TABLE', 't')).toBeNull();
  });

  it('deletes a comment when storing a literal empty quote', () => {
    storeComment('TABLE', 't', 'hello');
    storeComment('TABLE', 't', "''");
    expect(getComment('TABLE', 't')).toBeNull();
  });

  it('returns all stored comments', () => {
    storeComment('TABLE', 'a', 'c1');
    storeComment('COLUMN', 'b', 'c2');
    const all = getAllComments();
    expect(all.length).toBe(2);
  });

  it('clears all comments', () => {
    storeComment('TABLE', 'a', 'c1');
    clearAllComments();
    expect(getAllComments()).toEqual([]);
  });
});

describe('parseSetConfigArgs', () => {
  it('parses a standard set_config call with schema prefix', () => {
    expect(parseSetConfigArgs("SELECT pg_catalog.set_config('search_path', 'public', false)")).toEqual(
      ['search_path', 'public', false],
    );
  });

  it('parses without schema prefix and true isLocal', () => {
    expect(parseSetConfigArgs("SELECT set_config('a', 'b', true)")).toEqual(['a', 'b', true]);
    expect(parseSetConfigArgs("SELECT set_config('a', 'b', 1)")).toEqual(['a', 'b', true]);
  });

  it('unescapes doubled single quotes in the value', () => {
    expect(parseSetConfigArgs("SELECT set_config('k', 'it''s', false)")).toEqual([
      'k',
      "it's",
      false,
    ]);
  });

  it('parses isLocal as false for falsy tokens', () => {
    expect(parseSetConfigArgs("SELECT set_config('k', 'v', 0)")).toEqual(['k', 'v', false]);
    expect(parseSetConfigArgs("SELECT set_config('k', 'v', false)")).toEqual(['k', 'v', false]);
  });

  it('returns null for non-set_config input', () => {
    expect(parseSetConfigArgs("SELECT other('a','b',true)")).toBeNull();
    expect(parseSetConfigArgs('SELECT 1')).toBeNull();
  });
});

describe('parseCommentOnArgs', () => {
  it('parses a COMMENT ON TABLE', () => {
    expect(parseCommentOnArgs("COMMENT ON TABLE t IS 'hello'")).toEqual(['TABLE', 't', 'hello']);
  });

  it('parses a COMMENT ON COLUMN with dotted name', () => {
    expect(parseCommentOnArgs("COMMENT ON COLUMN t.c IS 'it''s here'")).toEqual([
      'COLUMN',
      't.c',
      "it's here",
    ]);
  });

  it('parses a two-word object type (e.g. MATERIALIZED VIEW)', () => {
    expect(parseCommentOnArgs("COMMENT ON MATERIALIZED VIEW m IS 'x'")).toEqual([
      'MATERIALIZED VIEW',
      'm',
      'x',
    ]);
  });

  it('parses an empty comment', () => {
    expect(parseCommentOnArgs("COMMENT ON COLUMN t.c IS ''")).toEqual(['COLUMN', 't.c', '']);
  });

  it('returns null for non-comment input', () => {
    expect(parseCommentOnArgs('SELECT 1')).toBeNull();
  });
});

describe('detectPgDumpSyntax', () => {
  it('detects ALTER TABLE ONLY', () => {
    expect(detectPgDumpSyntax('ALTER TABLE ONLY t ADD x INT')).toBe(true);
  });

  it('detects ALTER TABLE IF EXISTS', () => {
    expect(detectPgDumpSyntax('ALTER TABLE IF EXISTS t ADD x INT')).toBe(true);
  });

  it('detects SET TABLESPACE variants', () => {
    expect(detectPgDumpSyntax('ALTER TABLE t SET TABLESPACE fast')).toBe(true);
    expect(detectPgDumpSyntax('SET TABLESPACE fast')).toBe(true);
  });

  it('detects set_config', () => {
    expect(detectPgDumpSyntax("SELECT pg_catalog.set_config('a','b',false)")).toBe(true);
  });

  it('detects RESET ALL', () => {
    expect(detectPgDumpSyntax('RESET ALL')).toBe(true);
  });

  it('detects COMMENT ON', () => {
    expect(detectPgDumpSyntax("COMMENT ON TABLE t IS 'x'")).toBe(true);
  });

  it('detects ALTER FUNCTION DEPENDS ON EXTENSION', () => {
    expect(detectPgDumpSyntax('ALTER FUNCTION f() DEPENDS ON EXTENSION citext')).toBe(true);
  });

  it('returns false for plain SQL', () => {
    expect(detectPgDumpSyntax('SELECT 1')).toBe(false);
    expect(detectPgDumpSyntax('CREATE TABLE t (id int)')).toBe(false);
  });

  it('returns false for empty and non-string input', () => {
    expect(detectPgDumpSyntax('')).toBe(false);
    expect(detectPgDumpSyntax(undefined as unknown as string)).toBe(false);
  });

  it('does NOT detect ALTER FUNCTION pattern inside string/comment (BUG #117)', () => {
    expect(detectPgDumpSyntax("SELECT 'ALTER FUNCTION foo DEPENDS ON EXTENSION bar'")).toBe(false);
    expect(detectPgDumpSyntax('-- ALTER FUNCTION foo DEPENDS ON EXTENSION bar\nSELECT 1')).toBe(false);
  });
});

describe('rewritePgDumpSql', () => {
  let guc: GucSystem;

  beforeEach(() => {
    guc = GucSystem.getInstance();
    guc.registry.resetAllToDefaults();
    clearAllComments();
  });

  it('strips ONLY from ALTER TABLE ONLY', () => {
    expect(rewritePgDumpSql('ALTER TABLE ONLY t ADD x INT')).toEqual({
      sql: 'ALTER TABLE t ADD x INT',
      rewritten: true,
      foundTypes: ['ALTER TABLE ONLY'],
    });
  });

  it('passes through ALTER TABLE IF EXISTS but flags it', () => {
    const r = rewritePgDumpSql('ALTER TABLE IF EXISTS t ADD x INT');
    expect(r.rewritten).toBe(false);
    expect(r.foundTypes).toEqual(['ALTER TABLE IF EXISTS']);
  });

  it('no-ops SET TABLESPACE to SELECT 1', () => {
    expect(rewritePgDumpSql('ALTER TABLE t SET TABLESPACE fast')).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
      foundTypes: ['SET TABLESPACE'],
    });
    expect(rewritePgDumpSql('SET TABLESPACE fast').foundTypes).toEqual(['SET TABLESPACE (standalone)']);
    expect(rewritePgDumpSql('SET DEFAULT TABLESPACE fast').foundTypes).toEqual([
      'SET TABLESPACE (standalone)',
    ]);
  });

  it('rewrites set_config to SELECT 1 and stores the GUC', () => {
    const r = rewritePgDumpSql("SELECT pg_catalog.set_config('search_path', 'public', false)");
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true, foundTypes: ['SELECT set_config'] });
    expect(guc.registry.get('search_path')?.value).toBe('public');
  });

  it('logs a warning for unparseable set_config but still returns SELECT 1', () => {
    const r = rewritePgDumpSql('SELECT set_config(broken)');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true, foundTypes: ['SELECT set_config'] });
  });

  it('rewrites RESET ALL and clears GUCs', () => {
    guc.set('search_path', 'custom');
    const r = rewritePgDumpSql('RESET ALL');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true, foundTypes: ['RESET ALL'] });
    expect(guc.registry.get('search_path')).toBeUndefined();
  });

  it('stores COMMENT ON and returns SELECT 1', () => {
    const r = rewritePgDumpSql("COMMENT ON TABLE t IS 'hello'");
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true, foundTypes: ['COMMENT ON'] });
    expect(getComment('TABLE', 't')).toBe('hello');
  });

  it('stores a raw fallback for unparseable COMMENT ON', () => {
    const r = rewritePgDumpSql('COMMENT ON weird');
    expect(r.rewritten).toBe(true);
    expect(r.foundTypes).toEqual(['COMMENT ON']);
  });

  it('no-ops ALTER FUNCTION DEPENDS ON EXTENSION', () => {
    expect(rewritePgDumpSql('ALTER FUNCTION f() DEPENDS ON EXTENSION citext')).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
      foundTypes: ['ALTER FUNCTION DEPENDS ON EXTENSION'],
    });
  });

  it('passes through plain SQL unchanged', () => {
    expect(rewritePgDumpSql('SELECT * FROM users')).toEqual({
      sql: 'SELECT * FROM users',
      rewritten: false,
    });
  });

  it('does NOT rewrite SELECT containing the ALTER FUNCTION pattern in a string (BUG #117)', () => {
    const r = rewritePgDumpSql("SELECT f FROM t WHERE x = 'ALTER FUNCTION a() DEPENDS ON EXTENSION e'");
    expect(r).toEqual({
      sql: "SELECT f FROM t WHERE x = 'ALTER FUNCTION a() DEPENDS ON EXTENSION e'",
      rewritten: false,
    });
  });

  it('returns empty for empty/non-string input', () => {
    expect(rewritePgDumpSql('')).toEqual({ sql: '', rewritten: false });
    expect(rewritePgDumpSql(undefined as unknown as string)).toEqual({
      sql: '',
      rewritten: false,
    });
  });
});

describe('extractPgDumpTables', () => {
  it('extracts and deduplicates table names across statements', () => {
    expect(
      extractPgDumpTables('CREATE TABLE users (id int); INSERT INTO users VALUES (1)'),
    ).toEqual(['users']);
  });

  it('extracts ALTER TABLE name', () => {
    expect(extractPgDumpTables('ALTER TABLE ONLY t ADD x INT')).toEqual(['t']);
  });

  it('extracts COMMENT ON COLUMN table name', () => {
    expect(extractPgDumpTables("COMMENT ON COLUMN t.c IS 'x'")).toEqual(['t']);
  });

  it('extracts COMMENT ON TABLE name', () => {
    expect(extractPgDumpTables("COMMENT ON TABLE tbl IS 'x'")).toEqual(['tbl']);
  });

  it('normalizes quoted identifiers', () => {
    expect(extractPgDumpTables('CREATE TABLE "MyTable" (id int)')).toEqual(['MyTable']);
  });

  it('returns empty for no table references', () => {
    expect(extractPgDumpTables('SELECT 1')).toEqual([]);
  });

  it('ignores empty statements from trailing semicolons', () => {
    expect(extractPgDumpTables('CREATE TABLE t (id int);; ')).toEqual(['t']);
  });

  it('returns empty for empty/non-string input', () => {
    expect(extractPgDumpTables('')).toEqual([]);
    expect(extractPgDumpTables(undefined as unknown as string)).toEqual([]);
  });
});

describe('internal helpers', () => {
  it('_isAlterTableOnly', () => {
    expect(_isAlterTableOnly('ALTER TABLE ONLY t ADD x')).toBe(true);
    expect(_isAlterTableOnly('ALTER TABLE t ADD x')).toBe(false);
  });

  it('_isCommentOn', () => {
    expect(_isCommentOn("COMMENT ON TABLE t IS 'x'")).toBe(true);
    expect(_isCommentOn('SELECT 1')).toBe(false);
  });

  it('_isAlterFunctionDependsOnExtension', () => {
    expect(_isAlterFunctionDependsOnExtension('ALTER FUNCTION f() DEPENDS ON EXTENSION e')).toBe(true);
    expect(_isAlterFunctionDependsOnExtension("SELECT 'ALTER FUNCTION f() DEPENDS ON EXTENSION e'")).toBe(
      false,
    );
  });
});
