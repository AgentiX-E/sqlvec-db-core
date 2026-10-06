import { describe, it, expect } from 'vitest';
import {
  detectSelectInto,
  detectUnloggedCreateTableAs,
  rewriteCreateTableAs,
  needsRewrite,
} from '../query/CreateTableAsShim';

describe('detectSelectInto', () => {
  it('returns false for non-string input', () => {
    expect(detectSelectInto(undefined as unknown as string)).toBe(false);
    expect(detectSelectInto(null as unknown as string)).toBe(false);
    expect(detectSelectInto(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty or whitespace-only input', () => {
    expect(detectSelectInto('')).toBe(false);
    expect(detectSelectInto('   ')).toBe(false);
  });

  it('returns false when the statement does not start with SELECT', () => {
    expect(detectSelectInto('CREATE TABLE t AS SELECT * FROM s')).toBe(false);
    expect(detectSelectInto('  UPDATE t SET a = 1')).toBe(false);
  });

  it('detects a plain SELECT INTO', () => {
    expect(detectSelectInto('SELECT * INTO t FROM users')).toBe(true);
    expect(detectSelectInto('select * into t from users')).toBe(true);
  });

  it('detects SELECT INTO TEMP / TEMPORARY / UNLOGGED', () => {
    expect(detectSelectInto('SELECT * INTO TEMP t FROM users')).toBe(true);
    expect(detectSelectInto('SELECT * INTO TEMPORARY t FROM users')).toBe(true);
    expect(detectSelectInto('SELECT * INTO UNLOGGED t FROM users')).toBe(true);
  });

  it('rejects a SELECT without INTO', () => {
    expect(detectSelectInto('SELECT * FROM t')).toBe(false);
  });

  it('rejects SELECT INTO without a FROM clause', () => {
    expect(detectSelectInto('SELECT * INTO t')).toBe(false);
  });

  it('ignores a leading whitespace', () => {
    expect(detectSelectInto('   SELECT * INTO t FROM users')).toBe(true);
  });
});

describe('detectUnloggedCreateTableAs', () => {
  it('returns false for non-string input', () => {
    expect(detectUnloggedCreateTableAs(undefined as unknown as string)).toBe(false);
    expect(detectUnloggedCreateTableAs(null as unknown as string)).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(detectUnloggedCreateTableAs('')).toBe(false);
    expect(detectUnloggedCreateTableAs('   ')).toBe(false);
  });

  it('detects CREATE UNLOGGED TABLE ... AS', () => {
    expect(detectUnloggedCreateTableAs('CREATE UNLOGGED TABLE t AS SELECT * FROM s')).toBe(true);
    expect(detectUnloggedCreateTableAs('create unlogged table t as select 1')).toBe(true);
  });

  it('detects CREATE UNLOGGED TABLE IF NOT EXISTS ... AS', () => {
    expect(detectUnloggedCreateTableAs('CREATE UNLOGGED TABLE IF NOT EXISTS t AS SELECT 1')).toBe(true);
  });

  it('rejects plain CREATE TABLE ... AS', () => {
    expect(detectUnloggedCreateTableAs('CREATE TABLE t AS SELECT * FROM s')).toBe(false);
  });

  it('rejects CREATE TEMP TABLE ... AS', () => {
    expect(detectUnloggedCreateTableAs('CREATE TEMP TABLE t AS SELECT * FROM s')).toBe(false);
  });

  it('rejects non-CREATE statements', () => {
    expect(detectUnloggedCreateTableAs('SELECT * FROM t')).toBe(false);
  });
});

describe('rewriteCreateTableAs', () => {
  it('returns a none result for non-string input', () => {
    expect(rewriteCreateTableAs(undefined as unknown as string)).toEqual({
      sql: '', rewritten: false, type: 'none', isTemp: false,
    });
  });

  it('returns a none result for empty input', () => {
    expect(rewriteCreateTableAs('')).toEqual({
      sql: '', rewritten: false, type: 'none', isTemp: false,
    });
    expect(rewriteCreateTableAs('   ')).toEqual({
      sql: '', rewritten: false, type: 'none', isTemp: false,
    });
  });

  it('rewrites SELECT INTO to CREATE TABLE AS', () => {
    const r = rewriteCreateTableAs('SELECT * INTO t FROM users');
    expect(r).toEqual({
      sql: 'CREATE TABLE t AS SELECT * FROM users',
      rewritten: true,
      type: 'select-into',
      tableName: 't',
      isTemp: false,
    });
  });

  it('rewrites SELECT INTO TEMP with a TEMP prefix', () => {
    const r = rewriteCreateTableAs('SELECT * INTO TEMP t FROM users');
    expect(r.sql).toBe('CREATE TEMP TABLE t AS SELECT * FROM users');
    expect(r.type).toBe('select-into');
    expect(r.tableName).toBe('t');
    expect(r.isTemp).toBe(true);
  });

  it('rewrites SELECT INTO TEMPORARY with a TEMP prefix', () => {
    const r = rewriteCreateTableAs('SELECT * INTO TEMPORARY t FROM users');
    expect(r.sql).toBe('CREATE TEMP TABLE t AS SELECT * FROM users');
    expect(r.isTemp).toBe(true);
  });

  it('rewrites SELECT INTO UNLOGGED by dropping the modifier', () => {
    const r = rewriteCreateTableAs('SELECT * INTO UNLOGGED t FROM users');
    expect(r.sql).toBe('CREATE TABLE t AS SELECT * FROM users');
    expect(r.isTemp).toBe(false);
    expect(r.type).toBe('select-into');
  });

  it('preserves a multi-column select list and WHERE clause', () => {
    const r = rewriteCreateTableAs('SELECT a, b INTO t FROM x WHERE y = 2');
    expect(r.sql).toBe('CREATE TABLE t AS SELECT a, b FROM x WHERE y = 2');
  });

  it('preserves a string literal containing INTO in the select list', () => {
    const r = rewriteCreateTableAs("SELECT 'INTO' INTO t FROM users");
    expect(r.sql).toBe("CREATE TABLE t AS SELECT 'INTO' FROM users");
    expect(r.tableName).toBe('t');
  });

  it('rewrites CREATE UNLOGGED TABLE AS to plain CREATE TABLE AS', () => {
    const r = rewriteCreateTableAs('CREATE UNLOGGED TABLE t AS SELECT * FROM s');
    expect(r).toEqual({
      sql: 'CREATE TABLE t AS SELECT * FROM s',
      rewritten: true,
      type: 'create-table-as-unlogged',
      tableName: 't',
      isTemp: false,
    });
  });

  it('preserves IF NOT EXISTS when rewriting CREATE UNLOGGED TABLE AS', () => {
    const r = rewriteCreateTableAs('CREATE UNLOGGED TABLE IF NOT EXISTS t AS SELECT 1');
    expect(r.sql).toBe('CREATE TABLE IF NOT EXISTS t AS SELECT 1');
    expect(r.type).toBe('create-table-as-unlogged');
  });

  it('passes through CREATE UNLOGGED TABLE with an empty AS tail', () => {
    // `AS` is present but carries no select body; it no longer matches the
    // UNLOGGED rewrite pattern and falls through unchanged.
    const r = rewriteCreateTableAs('CREATE UNLOGGED TABLE t AS');
    expect(r.rewritten).toBe(false);
    expect(r.type).toBe('none');
  });

  it('passes through a plain CREATE TABLE AS', () => {
    const r = rewriteCreateTableAs('CREATE TABLE t AS SELECT * FROM s');
    expect(r).toEqual({
      sql: 'CREATE TABLE t AS SELECT * FROM s',
      rewritten: false,
      type: 'none',
      isTemp: false,
    });
  });

  it('passes through CREATE TEMP TABLE AS (already valid)', () => {
    const r = rewriteCreateTableAs('CREATE TEMP TABLE t AS SELECT * FROM s');
    expect(r).toEqual({
      sql: 'CREATE TEMP TABLE t AS SELECT * FROM s',
      rewritten: false,
      type: 'none',
      isTemp: true,
    });
  });

  it('passes through CREATE TEMPORARY TABLE AS as temp', () => {
    const r = rewriteCreateTableAs('CREATE TEMPORARY TABLE t AS SELECT 1');
    expect(r.isTemp).toBe(true);
    expect(r.rewritten).toBe(false);
  });

  it('passes through a non-AS CREATE TABLE unchanged', () => {
    const r = rewriteCreateTableAs('CREATE TABLE t (id int)');
    expect(r).toEqual({
      sql: 'CREATE TABLE t (id int)',
      rewritten: false,
      type: 'none',
      isTemp: false,
    });
  });

  it('passes through an unrelated statement unchanged', () => {
    const r = rewriteCreateTableAs('SELECT * FROM existing');
    expect(r).toEqual({
      sql: 'SELECT * FROM existing',
      rewritten: false,
      type: 'none',
      isTemp: false,
    });
  });
});

describe('needsRewrite', () => {
  it('returns false for non-string input', () => {
    expect(needsRewrite(undefined as unknown as string)).toBe(false);
    expect(needsRewrite(null as unknown as string)).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(needsRewrite('')).toBe(false);
    expect(needsRewrite('   ')).toBe(false);
  });

  it('returns true for SELECT INTO', () => {
    expect(needsRewrite('SELECT * INTO t FROM users')).toBe(true);
  });

  it('returns true for SELECT INTO UNLOGGED', () => {
    expect(needsRewrite('SELECT * INTO UNLOGGED t FROM users')).toBe(true);
  });

  it('returns true for CREATE UNLOGGED TABLE AS', () => {
    expect(needsRewrite('CREATE UNLOGGED TABLE t AS SELECT * FROM s')).toBe(true);
  });

  it('returns false for plain CREATE TABLE AS', () => {
    expect(needsRewrite('CREATE TABLE t AS SELECT * FROM s')).toBe(false);
  });

  it('returns false for CREATE TEMP TABLE AS', () => {
    expect(needsRewrite('CREATE TEMP TABLE t AS SELECT * FROM s')).toBe(false);
  });

  it('returns false for an unrelated statement', () => {
    expect(needsRewrite('SELECT * FROM t')).toBe(false);
  });
});
