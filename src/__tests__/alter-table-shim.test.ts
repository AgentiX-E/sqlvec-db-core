/**
 * alter-table-shim.test.ts — Coverage tests for AlterTableShim
 * (PostgreSQL-specific ALTER TABLE detection and handling for SQLite).
 */

import { describe, it, expect } from 'vitest';
import {
  detectAlterTable,
  handleAlterTable,
  _isPgSpecificAlterAction,
} from '../query/AlterTableShim';

// ──────────────────────────────────────────────
//  detectAlterTable
// ──────────────────────────────────────────────

describe('detectAlterTable', () => {
  it('returns false for non-string and empty input', () => {
    expect(detectAlterTable(undefined as any)).toBe(false);
    expect(detectAlterTable(null as any)).toBe(false);
    expect(detectAlterTable(123 as any)).toBe(false);
    expect(detectAlterTable('')).toBe(false);
    expect(detectAlterTable('   ')).toBe(false);
  });

  it('returns false for non-ALTER TABLE SQL', () => {
    expect(detectAlterTable('SELECT * FROM t')).toBe(false);
    expect(detectAlterTable('INSERT INTO t VALUES (1)')).toBe(false);
    expect(detectAlterTable('CREATE TABLE t (id int)')).toBe(false);
    expect(detectAlterTable('ALTERTABLE t rename to u')).toBe(false);
  });

  it('returns true for ALTER TABLE (space prefix)', () => {
    expect(detectAlterTable('ALTER TABLE t RENAME TO u')).toBe(true);
    expect(detectAlterTable('  ALTER TABLE t ADD COLUMN c int')).toBe(true);
  });

  it('returns true for ALTER TAB (tab-separated)', () => {
    expect(detectAlterTable('ALTER\tTABLE t RENAME TO u')).toBe(true);
  });

  it('returns false for ALTER\tTABLE with trailing non-space mismatch', () => {
    // lowercases/mixed casing still detected via case-insensitive regex
    expect(detectAlterTable('alter table t rename to u')).toBe(true);
  });
});

// ──────────────────────────────────────────────
//  handleAlterTable — non-ALTER / invalid input
// ──────────────────────────────────────────────

describe('handleAlterTable — basic', () => {
  it('returns {sql:\'\', rewritten:false} for empty string', () => {
    expect(handleAlterTable('')).toEqual({ sql: '', rewritten: false });
  });

  it('returns original sql for non-string', () => {
    expect(handleAlterTable(null as any)).toEqual({ sql: '', rewritten: false });
    expect(handleAlterTable(123 as any)).toEqual({
      sql: 123 as any,
      rewritten: false,
    });
  });

  it('passes through non-ALTER SQL', () => {
    expect(handleAlterTable('SELECT 1')).toEqual({
      sql: 'SELECT 1',
      rewritten: false,
    });
  });
});

// ──────────────────────────────────────────────
//  handleAlterTable — SQLite-compatible (pass-through)
// ──────────────────────────────────────────────

describe('handleAlterTable — SQLite pass-through', () => {
  it.each([
    ['ALTER TABLE t RENAME TO u', 'ALTER TABLE t RENAME TO u'],
    ['ALTER TABLE t ADD COLUMN c int', 'ALTER TABLE t ADD COLUMN c int'],
    ['ALTER TABLE t ADD c int', 'ALTER TABLE t ADD c int'],
    ['ALTER TABLE t RENAME COLUMN old TO new', 'ALTER TABLE t RENAME COLUMN old TO new'],
    ['ALTER TABLE t DROP COLUMN c', 'ALTER TABLE t DROP COLUMN c'],
  ])('passes through %s', (sql, expected) => {
    expect(handleAlterTable(sql)).toEqual({ sql: expected, rewritten: false });
  });
});

// ──────────────────────────────────────────────
//  handleAlterTable — PG-specific no-ops
// ──────────────────────────────────────────────

describe('handleAlterTable — PG-specific no-ops', () => {
  it.each([
    'ALTER TABLE t ALTER COLUMN c TYPE int',
    'ALTER TABLE t ALTER COLUMN c SET DATA TYPE bigint',
    'ALTER TABLE t ALTER c TYPE text',
  ])('TYPE no-op: %s', (sql) => {
    expect(handleAlterTable(sql)).toEqual({ sql: null, rewritten: true });
  });

  it.each([
    'ALTER TABLE t ALTER COLUMN c SET DEFAULT 42',
    'ALTER TABLE t ALTER c SET DEFAULT now()',
  ])('SET DEFAULT pass-through: %s', (sql) => {
    expect(handleAlterTable(sql)).toEqual({ sql, rewritten: false });
  });

  it.each([
    'ALTER TABLE t ALTER COLUMN c DROP DEFAULT',
    'ALTER TABLE t ALTER c DROP DEFAULT',
  ])('DROP DEFAULT pass-through: %s', (sql) => {
    expect(handleAlterTable(sql)).toEqual({ sql, rewritten: false });
  });

  it('SET NOT NULL → needsRecreate', () => {
    expect(handleAlterTable('ALTER TABLE t ALTER COLUMN c SET NOT NULL')).toEqual({
      sql: null,
      rewritten: true,
      needsRecreate: true,
      recreateTableName: 't',
      recreateColumnName: 'c',
      recreateChangeType: 'set-not-null',
    });
  });

  it('SET NOT NULL without COLUMN keyword → needsRecreate', () => {
    expect(handleAlterTable('ALTER TABLE t ALTER c SET NOT NULL')).toEqual({
      sql: null,
      rewritten: true,
      needsRecreate: true,
      recreateTableName: 't',
      recreateColumnName: 'c',
      recreateChangeType: 'set-not-null',
    });
  });

  it('DROP NOT NULL → needsRecreate', () => {
    expect(handleAlterTable('ALTER TABLE t ALTER COLUMN c DROP NOT NULL')).toEqual({
      sql: null,
      rewritten: true,
      needsRecreate: true,
      recreateTableName: 't',
      recreateColumnName: 'c',
      recreateChangeType: 'drop-not-null',
    });
  });

  it('SET NOT NULL with IF EXISTS + schema qualifier → extractTableName/ColumnName', () => {
    expect(
      handleAlterTable('ALTER TABLE IF EXISTS myschema.t ALTER COLUMN c SET NOT NULL'),
    ).toEqual({
      sql: null,
      rewritten: true,
      needsRecreate: true,
      recreateTableName: 'myschema',
      recreateColumnName: 'c',
      recreateChangeType: 'set-not-null',
    });
  });

  it('SET NOT NULL missing column name → extractColumnName falls back to unknown', () => {
    // With no table name (double space), the SET/DROP keyword is mistaken for
    // the table name, and extractColumnName returns null (body doesn't start
    // with ALTER), triggering the `?? 'unknown'` fallback.
    expect(handleAlterTable('ALTER TABLE  SET NOT NULL')).toEqual({
      sql: null,
      rewritten: true,
      needsRecreate: true,
      recreateTableName: 'SET',
      recreateColumnName: 'unknown',
      recreateChangeType: 'set-not-null',
    });
  });

  it('DROP NOT NULL missing column name → extractColumnName falls back to unknown', () => {
    expect(handleAlterTable('ALTER TABLE  DROP NOT NULL')).toEqual({
      sql: null,
      rewritten: true,
      needsRecreate: true,
      recreateTableName: 'DROP',
      recreateColumnName: 'unknown',
      recreateChangeType: 'drop-not-null',
    });
  });

  it('SET NOT NULL with non-word after ALTER TABLE → extractTableName falls back', () => {
    // `ALTER TABLE (` makes extractTableName's (\w+) fail → returns null → 'unknown'.
    expect(handleAlterTable('ALTER TABLE (ALTER c SET NOT NULL')).toEqual({
      sql: null,
      rewritten: true,
      needsRecreate: true,
      recreateTableName: 'unknown',
      recreateColumnName: 'TABLE',
      recreateChangeType: 'set-not-null',
    });
  });

  it('DROP NOT NULL with non-word after ALTER TABLE → extractTableName falls back', () => {
    expect(handleAlterTable('ALTER TABLE (ALTER c DROP NOT NULL')).toEqual({
      sql: null,
      rewritten: true,
      needsRecreate: true,
      recreateTableName: 'unknown',
      recreateColumnName: 'TABLE',
      recreateChangeType: 'drop-not-null',
    });
  });

  it.each([
    'ALTER TABLE t ALTER COLUMN c SET STATISTICS 100',
    'ALTER TABLE t ALTER COLUMN c SET STORAGE EXTERNAL',
    'ALTER TABLE t ALTER COLUMN c SET (n_distinct = 10)',
    'ALTER TABLE t ALTER COLUMN c RESET (n_distinct)',
  ])('ALTER COLUMN PG no-op: %s', (sql) => {
    expect(handleAlterTable(sql)).toEqual({ sql: null, rewritten: true });
  });

  it.each([
    'ALTER TABLE t RENAME CONSTRAINT old TO new',
    'ALTER TABLE t VALIDATE CONSTRAINT c',
    'ALTER TABLE t DROP CONSTRAINT c',
    'ALTER TABLE t DROP CONSTRAINT IF EXISTS c',
  ])('constraint no-op: %s', (sql) => {
    expect(handleAlterTable(sql)).toEqual({ sql: null, rewritten: true });
  });

  it.each([
    'ALTER TABLE t SET SCHEMA newschema',
    'ALTER TABLE t SET TABLESPACE ts',
  ])('schema/tablespace no-op: %s', (sql) => {
    expect(handleAlterTable(sql)).toEqual({ sql: null, rewritten: true });
  });

  it.each([
    'ALTER TABLE t ENABLE TRIGGER trg',
    'ALTER TABLE t ENABLE ALWAYS TRIGGER trg',
    'ALTER TABLE t ENABLE REPLICA TRIGGER trg',
    'ALTER TABLE t DISABLE TRIGGER trg',
    'ALTER TABLE t DISABLE ALWAYS TRIGGER ALL',
    'ALTER TABLE t DISABLE REPLICA TRIGGER USER',
  ])('trigger no-op: %s', (sql) => {
    expect(handleAlterTable(sql)).toEqual({ sql: null, rewritten: true });
  });

  it.each([
    'ALTER TABLE t CLUSTER ON idx',
    'ALTER TABLE t SET WITHOUT CLUSTER',
  ])('cluster no-op: %s', (sql) => {
    expect(handleAlterTable(sql)).toEqual({ sql: null, rewritten: true });
  });

  it.each([
    'ALTER TABLE t SET (fillfactor = 70)',
    'ALTER TABLE t RESET (fillfactor)',
  ])('storage parameter no-op: %s', (sql) => {
    expect(handleAlterTable(sql)).toEqual({ sql: null, rewritten: true });
  });

  it.each([
    'ALTER TABLE t OWNER TO new_owner',
    'ALTER TABLE t SET ACCESS METHOD heap',
    'ALTER TABLE t SET LOGGED',
    'ALTER TABLE t SET UNLOGGED',
  ])('other PG no-op: %s', (sql) => {
    expect(handleAlterTable(sql)).toEqual({ sql: null, rewritten: true });
  });

  it('unknown ALTER TABLE action → pass-through with rewritten:false', () => {
    expect(handleAlterTable('ALTER TABLE t FOO BAR')).toEqual({
      sql: 'ALTER TABLE t FOO BAR',
      rewritten: false,
    });
  });
});

// ──────────────────────────────────────────────
//  _isPgSpecificAlterAction
// ──────────────────────────────────────────────

describe('_isPgSpecificAlterAction', () => {
  it('returns false for non-string / empty', () => {
    expect(_isPgSpecificAlterAction(undefined as any)).toBe(false);
    expect(_isPgSpecificAlterAction('')).toBe(false);
    expect(_isPgSpecificAlterAction('   ')).toBe(false);
  });

  it('returns false for non-ALTER TABLE', () => {
    expect(_isPgSpecificAlterAction('SELECT 1')).toBe(false);
  });

  it('returns false for SQLite-compatible actions', () => {
    expect(_isPgSpecificAlterAction('ALTER TABLE t RENAME TO u')).toBe(false);
    expect(_isPgSpecificAlterAction('ALTER TABLE t ADD COLUMN c int')).toBe(false);
    expect(_isPgSpecificAlterAction('ALTER TABLE t RENAME COLUMN a TO b')).toBe(false);
    expect(_isPgSpecificAlterAction('ALTER TABLE t DROP COLUMN c')).toBe(false);
  });

  it('returns true for ALTER COLUMN TYPE (combined regex)', () => {
    expect(_isPgSpecificAlterAction('ALTER TABLE t ALTER COLUMN c TYPE int')).toBe(true);
  });

  it('returns true for SET NOT NULL / DROP NOT NULL (combined regex)', () => {
    expect(_isPgSpecificAlterAction('ALTER TABLE t ALTER COLUMN c SET NOT NULL')).toBe(
      true,
    );
    expect(_isPgSpecificAlterAction('ALTER TABLE t ALTER COLUMN c DROP NOT NULL')).toBe(
      true,
    );
  });

  it('returns true for SET STATISTICS / SET STORAGE (combined regex)', () => {
    expect(
      _isPgSpecificAlterAction('ALTER TABLE t ALTER COLUMN c SET STATISTICS 100'),
    ).toBe(true);
    expect(
      _isPgSpecificAlterAction('ALTER TABLE t ALTER COLUMN c SET STORAGE EXTERNAL'),
    ).toBe(true);
  });

  it('returns true for SET (options) / RESET (options) (combined regex)', () => {
    expect(_isPgSpecificAlterAction('ALTER TABLE t ALTER COLUMN c SET (a)')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t ALTER COLUMN c RESET (a)')).toBe(
      true,
    );
  });

  it('returns true for constraint variants (combined regex)', () => {
    expect(_isPgSpecificAlterAction('ALTER TABLE t RENAME CONSTRAINT a TO b')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t VALIDATE CONSTRAINT c')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t DROP CONSTRAINT c')).toBe(true);
  });

  it('returns true for SET SCHEMA / SET TABLESPACE (combined regex)', () => {
    expect(_isPgSpecificAlterAction('ALTER TABLE t SET SCHEMA s')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t SET TABLESPACE ts')).toBe(true);
  });

  it('returns true for trigger enable/disable (combined regex)', () => {
    expect(_isPgSpecificAlterAction('ALTER TABLE t ENABLE TRIGGER trg')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t DISABLE TRIGGER trg')).toBe(true);
  });

  it('returns true for cluster variants (combined regex)', () => {
    expect(_isPgSpecificAlterAction('ALTER TABLE t CLUSTER ON idx')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t SET WITHOUT CLUSTER')).toBe(true);
  });

  it('returns true for SET/RESET storage params (combined regex)', () => {
    expect(_isPgSpecificAlterAction('ALTER TABLE t SET (fillfactor = 70)')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t RESET (fillfactor)')).toBe(true);
  });

  it('returns true for OWNER TO / ACCESS METHOD / LOGGED / UNLOGGED', () => {
    expect(_isPgSpecificAlterAction('ALTER TABLE t OWNER TO o')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t SET ACCESS METHOD heap')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t SET LOGGED')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t SET UNLOGGED')).toBe(true);
  });

  it('returns true via keyword fallback (VALIDATE/CLUSTER/ENABLE/DISABLE/OWNER)', () => {
    // These are NOT matched by PG_ALTER_ACTION combined regex but should match
    // the keyword fallback PG_ALTER_ACTION_KEYWORD.
    expect(_isPgSpecificAlterAction('ALTER TABLE t VALIDATE CONSTRAINT c')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t CLUSTER ON idx')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t ENABLE TRIGGER trg')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t DISABLE TRIGGER trg')).toBe(true);
    expect(_isPgSpecificAlterAction('ALTER TABLE t OWNER TO o')).toBe(true);
  });

  it('returns true via keyword fallback for non-TRIGGER ENABLE/DISABLE', () => {
    // ENABLE/DISABLE not followed by TRIGGER does NOT match PG_ENABLE_TRIGGER/
    // PG_DISABLE_TRIGGER (combined regex), but DOES match the keyword fallback
    // (ENABLE\s+ | DISABLE\s+).
    expect(
      _isPgSpecificAlterAction('ALTER TABLE t ENABLE ROW LEVEL SECURITY'),
    ).toBe(true);
    expect(
      _isPgSpecificAlterAction('ALTER TABLE t DISABLE ROW LEVEL SECURITY'),
    ).toBe(true);
  });

  it('returns false for unknown action (assume pass-through)', () => {
    expect(_isPgSpecificAlterAction('ALTER TABLE t FOO BAR')).toBe(false);
  });

  it('returns false for ALTER COLUMN SET DEFAULT / DROP DEFAULT (SQLite-native)', () => {
    // SET DEFAULT / DROP DEFAULT are NOT in PG_ALTER_ACTION combined regex
    // and NOT a keyword fallback → pass-through (false).
    expect(_isPgSpecificAlterAction('ALTER TABLE t ALTER COLUMN c SET DEFAULT 1')).toBe(
      false,
    );
    expect(_isPgSpecificAlterAction('ALTER TABLE t ALTER COLUMN c DROP DEFAULT')).toBe(
      false,
    );
  });
});
