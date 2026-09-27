import { describe, it, expect, vi } from 'vitest';
import {
  detectEnumStmt,
  handleEnumStmt,
  detectEnumTypeRef,
  extractEnumValues,
  ensureMetaTable,
  create,
  validate,
  addValue,
  drop,
  list,
  get,
  loadFromDB,
  handleAlterTypeRenameValue,
  detectAlterType,
  parseCreateEnum,
  parseAlterRenameValue,
} from '../query/EnumShim';

describe('parseCreateEnum', () => {
  it('parses a simple enum', () => {
    expect(parseCreateEnum("CREATE TYPE mood AS ENUM ('a','b')")).toEqual({
      typeName: 'mood',
      values: ['a', 'b'],
    });
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseCreateEnum("  create   type   mood   as   enum  ( 'a' )  ")).toEqual({
      typeName: 'mood',
      values: ['a'],
    });
  });

  it('supports a trailing semicolon', () => {
    expect(parseCreateEnum("CREATE TYPE mood AS ENUM ('a') ;")).toEqual({
      typeName: 'mood',
      values: ['a'],
    });
  });

  it('supports a trailing comma (PostgreSQL allows it)', () => {
    expect(parseCreateEnum("CREATE TYPE mood AS ENUM ('a','b',)")).toEqual({
      typeName: 'mood',
      values: ['a', 'b'],
    });
  });

  it('supports quoted type names (regression #E2)', () => {
    expect(parseCreateEnum('CREATE TYPE "my type" AS ENUM (\'a\')')).toEqual({
      typeName: 'my type',
      values: ['a'],
    });
  });

  it('supports a value containing a right paren (regression #E7)', () => {
    expect(parseCreateEnum("CREATE TYPE mood AS ENUM ('a)', 'b')")).toEqual({
      typeName: 'mood',
      values: ['a)', 'b'],
    });
  });

  it('supports a value containing a comma and paren', () => {
    expect(parseCreateEnum("CREATE TYPE mood AS ENUM ('(x)', 'y')")).toEqual({
      typeName: 'mood',
      values: ['(x)', 'y'],
    });
  });

  it('supports a value containing an escaped quote', () => {
    expect(parseCreateEnum("CREATE TYPE mood AS ENUM ('it''s', 'ok')")).toEqual({
      typeName: 'mood',
      values: ["it's", 'ok'],
    });
  });

  it('preserves leading/trailing spaces in values', () => {
    expect(parseCreateEnum("CREATE TYPE mood AS ENUM (' a ', 'b')")).toEqual({
      typeName: 'mood',
      values: [' a ', 'b'],
    });
  });

  it('returns null for non-ENUM statements', () => {
    expect(parseCreateEnum('SELECT 1')).toBeNull();
    expect(parseCreateEnum('CREATE TABLE t (x int)')).toBeNull();
    expect(parseCreateEnum('CREATE TYPE mood AS RANGE (subtype=int4)')).toBeNull();
  });

  it('returns null for bare word that is only a prefix of CREATE', () => {
    expect(parseCreateEnum('CRETE TYPE x AS ENUM (1)')).toBeNull();
  });

  it('returns null for unterminated quoted type name', () => {
    expect(parseCreateEnum('CREATE TYPE "my type AS ENUM (\'a\')')).toBeNull();
  });

  it('returns null for non-identifier type name', () => {
    expect(parseCreateEnum("CREATE TYPE 123 AS ENUM ('a')")).toBeNull();
  });

  it('returns null for empty quoted type name', () => {
    expect(parseCreateEnum('CREATE TYPE "" AS ENUM (\'a\')')).toBeNull();
  });

  it('returns null when AS is missing', () => {
    expect(parseCreateEnum("CREATE TYPE mood ENUM ('a')")).toBeNull();
  });

  it('returns null when the paren is missing', () => {
    expect(parseCreateEnum("CREATE TYPE mood AS ENUM 'a'")).toBeNull();
  });

  it('returns null when a value is not a string literal', () => {
    expect(parseCreateEnum('CREATE TYPE mood AS ENUM (123)')).toBeNull();
  });

  it('returns null for an unterminated value literal', () => {
    expect(parseCreateEnum("CREATE TYPE mood AS ENUM ('a")).toBeNull();
  });

  it('returns null for trailing garbage after the value list', () => {
    expect(parseCreateEnum("CREATE TYPE mood AS ENUM ('a') garbage")).toBeNull();
  });

  it('returns null for a value list missing the closing paren', () => {
    expect(parseCreateEnum("CREATE TYPE mood AS ENUM ('a', 'b'")).toBeNull();
  });
});

describe('parseAlterRenameValue', () => {
  it('parses a simple rename', () => {
    expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'sad' TO 'depressed'")).toEqual({
      typeName: 'mood',
      oldValue: 'sad',
      newValue: 'depressed',
    });
  });

  it('supports quoted type names', () => {
    expect(parseAlterRenameValue('ALTER TYPE "my type" RENAME VALUE \'a\' TO \'b\'')).toEqual({
      typeName: 'my type',
      oldValue: 'a',
      newValue: 'b',
    });
  });

  it('supports escaped quotes in values (regression #E6)', () => {
    expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'it''s' TO 'x'")).toEqual({
      typeName: 'mood',
      oldValue: "it's",
      newValue: 'x',
    });
  });

  it('tolerates trailing semicolon/whitespace', () => {
    expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'a' TO 'b' ;")).toEqual({
      typeName: 'mood',
      oldValue: 'a',
      newValue: 'b',
    });
  });

  it('returns null for malformed / non-rename', () => {
    expect(parseAlterRenameValue('SELECT 1')).toBeNull();
    expect(parseAlterRenameValue('ALTER TYPE mood RENAME TO foo')).toBeNull();
    expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'a'")).toBeNull();
  });

  it('returns null for missing TYPE keyword', () => {
    expect(parseAlterRenameValue("ALTER mood RENAME VALUE 'a' TO 'b'")).toBeNull();
  });

  it('returns null for unterminated quoted type name', () => {
    expect(parseAlterRenameValue('ALTER TYPE "my RENAME VALUE \'a\' TO \'b\'')).toBeNull();
  });

  it('returns null for non-identifier type name', () => {
    expect(parseAlterRenameValue("ALTER TYPE 123 RENAME VALUE 'a' TO 'b'")).toBeNull();
  });

  it('returns null for empty quoted type name', () => {
    expect(parseAlterRenameValue('ALTER TYPE "" RENAME VALUE \'a\' TO \'b\'')).toBeNull();
  });

  it('returns null when old value is missing', () => {
    expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE TO 'b'")).toBeNull();
  });

  it('returns null for unterminated old value', () => {
    expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'a TO 'b'")).toBeNull();
  });

  it('returns null when old value hits end of input', () => {
    expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'a")).toBeNull();
  });

  it('returns null when new value is missing', () => {
    expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'a' TO")).toBeNull();
  });

  it('returns null for unterminated new value', () => {
    expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'a' TO 'b")).toBeNull();
  });

  it('returns null for trailing garbage', () => {
    expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'a' TO 'b' x")).toBeNull();
  });
});

describe('detectEnumStmt', () => {
  it('detects enum DDL', () => {
    expect(detectEnumStmt("CREATE TYPE mood AS ENUM ('a')")).toBe(true);
    expect(detectEnumStmt("ALTER TYPE mood ADD VALUE 'x'")).toBe(true);
    expect(detectEnumStmt("ALTER TYPE mood RENAME VALUE 'a' TO 'b'")).toBe(true);
    expect(detectEnumStmt('DROP TYPE mood')).toBe(true);
  });

  it('returns false for non-input / non-enum', () => {
    expect(detectEnumStmt('')).toBe(false);
    expect(detectEnumStmt(null as any)).toBe(false);
    expect(detectEnumStmt(123 as any)).toBe(false);
    expect(detectEnumStmt('SELECT 1')).toBe(false);
  });
});

describe('handleEnumStmt', () => {
  it('rewrites CREATE TYPE', () => {
    expect(handleEnumStmt("CREATE TYPE mood AS ENUM ('a','b')")).toEqual({
      sql: null,
      rewritten: true,
      values: ['a', 'b'],
      typeName: 'mood',
    });
  });

  it('rewrites quoted type names and paren-bearing values', () => {
    const r = handleEnumStmt('CREATE TYPE "my type" AS ENUM (\'a)\')');
    expect(r.rewritten).toBe(true);
    expect(r.typeName).toBe('my type');
    expect(r.values).toEqual(['a)']);
  });

  it('rewrites ALTER TYPE ADD VALUE', () => {
    expect(handleEnumStmt("ALTER TYPE mood ADD VALUE 'great'")).toEqual({
      sql: null,
      rewritten: true,
      typeName: 'mood',
    });
  });

  it('rewrites ALTER TYPE RENAME VALUE', () => {
    const r = handleEnumStmt("ALTER TYPE mood RENAME VALUE 'sad' TO 'depressed'");
    expect(r.rewritten).toBe(true);
    expect(typeof r.sql).toBe('string');
    expect((r.sql as string).includes('UPDATE __enums')).toBe(true);
  });

  it('rewrites DROP TYPE (with and without IF EXISTS)', () => {
    expect(handleEnumStmt('DROP TYPE mood')).toEqual({
      sql: null,
      rewritten: true,
      typeName: 'mood',
    });
    expect(handleEnumStmt('DROP TYPE IF EXISTS mood')).toEqual({
      sql: null,
      rewritten: true,
      typeName: 'mood',
    });
  });

  it('passes through non-enum / empty input', () => {
    expect(handleEnumStmt('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    expect(handleEnumStmt('')).toEqual({ sql: '', rewritten: false });
    expect(handleEnumStmt(null as any)).toEqual({ sql: null, rewritten: false });
    expect(handleEnumStmt(5 as any)).toEqual({ sql: 5, rewritten: false });
  });
});

describe('detectEnumTypeRef', () => {
  it('detects user-defined enum-looking type names', () => {
    expect(detectEnumTypeRef('mood')).toBe(true);
    expect(detectEnumTypeRef('OrderStatus')).toBe(true);
    expect(detectEnumTypeRef('color1')).toBe(true);
  });

  it('rejects SQLite/PG builtin types', () => {
    expect(detectEnumTypeRef('text')).toBe(false);
    expect(detectEnumTypeRef('integer')).toBe(false);
    expect(detectEnumTypeRef('varchar')).toBe(false);
    expect(detectEnumTypeRef('timestamp')).toBe(false);
    expect(detectEnumTypeRef('jsonb')).toBe(false);
    expect(detectEnumTypeRef('uuid')).toBe(false);
  });

  it('rejects short / empty / invalid names', () => {
    expect(detectEnumTypeRef('ab')).toBe(false);
    expect(detectEnumTypeRef('')).toBe(false);
    expect(detectEnumTypeRef('')).toBe(false);
    expect(detectEnumTypeRef(null as any)).toBe(false);
    expect(detectEnumTypeRef('a b')).toBe(false);
    expect(detectEnumTypeRef('')).toBe(false);
    expect(detectEnumTypeRef('   ')).toBe(false); // whitespace-only
    expect(detectEnumTypeRef(456 as any)).toBe(false);
  });
});

describe('extractEnumValues', () => {
  it('extracts values', () => {
    expect(extractEnumValues("'a','b','c'")).toEqual(['a', 'b', 'c']);
  });

  it('handles escaped quotes', () => {
    expect(extractEnumValues("'it''s','a'")).toEqual(["it's", 'a']);
  });

  it('preserves interior spaces (no trim)', () => {
    expect(extractEnumValues("' a ','b'")).toEqual([' a ', 'b']);
  });

  it('drops empty-string values (PostgreSQL disallows them)', () => {
    expect(extractEnumValues("'','a'")).toEqual(['a']);
  });

  it('returns empty for non-string / empty input', () => {
    expect(extractEnumValues('')).toEqual([]);
    expect(extractEnumValues(null as any)).toEqual([]);
    expect(extractEnumValues(5 as any)).toEqual([]);
  });
});

describe('ensureMetaTable', () => {
  it('runs the DDL query', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    await ensureMetaTable(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(String(fn.mock.calls[0][0])).toContain('CREATE TABLE IF NOT EXISTS __enums');
  });

  it('rethrows on error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(ensureMetaTable(fn)).rejects.toThrow('boom');
  });
});

describe('create / addValue / drop / validate', () => {
  it('create registers and persists', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const def = await create('mood_e2e', ['a', 'b'], fn);
    expect(def).toEqual({ name: 'mood_e2e', values: ['a', 'b'] });
    expect(get('mood_e2e')).toEqual({ name: 'mood_e2e', values: ['a', 'b'] });
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    await drop('mood_e2e', fn);
  });

  it('create without queryFn does not persist', async () => {
    await create('mood_nop', ['a']);
    expect(get('mood_nop')).toEqual({ name: 'mood_nop', values: ['a'] });
    await drop('mood_nop');
  });

  it('validate returns true for member, false for non-member', async () => {
    await create('mood_v', ['a', 'b']);
    expect(validate('a', 'mood_v')).toBe(true);
    expect(validate('z', 'mood_v')).toBe(false);
    await drop('mood_v');
  });

  it('validate throws for unknown enum', () => {
    expect(() => validate('a', 'nonexistent_enum_xyz')).toThrow(/not found/);
  });

  it('addValue appends a new value if absent', async () => {
    await create('mood_add', ['a']);
    await addValue('mood_add', 'b');
    expect(get('mood_add')!.values).toEqual(['a', 'b']);
    await addValue('mood_add', 'a'); // no duplicate
    expect(get('mood_add')!.values).toEqual(['a', 'b']);
    await drop('mood_add');
  });

  it('addValue throws for unknown enum', async () => {
    await expect(addValue('nonexistent_add', 'x')).rejects.toThrow(/not found/);
  });

  it('addValue with queryFn persists the update', async () => {
    await create('mood_addq', ['a']);
    const fn = vi.fn().mockResolvedValue(undefined);
    await addValue('mood_addq', 'b', fn);
    expect(get('mood_addq')!.values).toEqual(['a', 'b']);
    // ensureMetaTable + UPDATE both fire
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    const updateSql = fn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(updateSql).toContain('UPDATE __enums');
    await drop('mood_addq');
  });

  it('drop removes and reports existed', async () => {
    await create('mood_drop', ['a']);
    const fn = vi.fn().mockResolvedValue(undefined);
    await drop('mood_drop', fn);
    expect(get('mood_drop')).toBeUndefined();
  });

  it('drop of missing enum does not persist but still runs query', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    await drop('missing_enum_zzz', fn);
    // ensureMetaTable + DELETE both still fire
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('list / get', () => {
  it('lists sorted registry entries', async () => {
    await create('mood_l1', ['a']);
    await create('mood_l2', ['x']);
    const names = list().map((d) => d.name);
    expect(names).toContain('mood_l1');
    expect(names).toContain('mood_l2');
    await drop('mood_l1');
    await drop('mood_l2');
  });

  it('get returns undefined for unknown', () => {
    expect(get('definitely_not_an_enum')).toBeUndefined();
  });
});

describe('loadFromDB', () => {
  it('loads rows (array form)', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(undefined) // ensureMetaTable
      .mockResolvedValueOnce([
        { name: 'mood_db', values_json: '["a","b"]' },
        { name: 'mood_db2', values_json: '[]' },
      ]);
    await loadFromDB(fn);
    expect(get('mood_db')).toEqual({ name: 'mood_db', values: ['a', 'b'] });
    await drop('mood_db');
    await drop('mood_db2');
  });

  it('loads rows ({ rows } form) and index-form rows', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [['mood_idx', '["x"]']] });
    await loadFromDB(fn);
    expect(get('mood_idx')).toEqual({ name: 'mood_idx', values: ['x'] });
    await drop('mood_idx');
  });

  it('loads object rows using named fields', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ name: 'mood_obj', values_json: '["a","b"]' }] });
    await loadFromDB(fn);
    expect(get('mood_obj')).toEqual({ name: 'mood_obj', values: ['a', 'b'] });
    await drop('mood_obj');
  });

  it('tolerates non-string values_json via the empty fallback', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ name: 'mood_nonstr', values_json: null }]);
    await loadFromDB(fn);
    expect(get('mood_nonstr')).toEqual({ name: 'mood_nonstr', values: [] });
    await drop('mood_nonstr');
  });

  it('tolerates a truthy non-string values_json (falls back to empty array)', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ name: 'mood_num', values_json: 123 }]);
    await loadFromDB(fn);
    expect(get('mood_num')).toEqual({ name: 'mood_num', values: [] });
    await drop('mood_num');
  });

  it('swallows errors (table may not exist)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('no such table'));
    await expect(loadFromDB(fn)).resolves.toBeUndefined();
  });
});

describe('handleAlterTypeRenameValue', () => {
  it('returns UPDATE sql', () => {
    const r = handleAlterTypeRenameValue("ALTER TYPE mood RENAME VALUE 'sad' TO 'depressed'");
    expect(r).toContain('UPDATE __enums');
    expect(r).toContain("'sad'");
    expect(r).toContain("'depressed'");
  });

  it('handles escaped quotes and quoted type', () => {
    expect(handleAlterTypeRenameValue("ALTER TYPE mood RENAME VALUE 'it''s' TO 'x'")).toContain('UPDATE');
    expect(handleAlterTypeRenameValue('ALTER TYPE "my type" RENAME VALUE \'a\' TO \'b\'')).toContain("name = 'my type'");
  });

  it('returns null for non-input / non-rename', () => {
    expect(handleAlterTypeRenameValue('')).toBeNull();
    expect(handleAlterTypeRenameValue(null as any)).toBeNull();
    expect(handleAlterTypeRenameValue('SELECT 1')).toBeNull();
  });

  it('renames in-memory value when registry entry exists', async () => {
    await create('mood_rename', ['sad', 'happy']);
    handleAlterTypeRenameValue("ALTER TYPE mood_rename RENAME VALUE 'sad' TO 'depressed'");
    expect(get('mood_rename')!.values).toEqual(['depressed', 'happy']);
    await drop('mood_rename');
  });

  it('warns (no rename) when old value is absent from the registry', async () => {
    await create('mood_rename_miss', ['sad']);
    handleAlterTypeRenameValue("ALTER TYPE mood_rename_miss RENAME VALUE 'nope' TO 'yep'");
    expect(get('mood_rename_miss')!.values).toEqual(['sad']);
    await drop('mood_rename_miss');
  });
});

describe('detectAlterType', () => {
  it('detects ALTER TYPE statements', () => {
    expect(detectAlterType("ALTER TYPE mood ADD VALUE 'x'")).toBe(true);
    expect(detectAlterType('ALTER TYPE mood RENAME TO foo')).toBe(true);
    expect(detectAlterType('ALTER TYPE mood SET SCHEMA s')).toBe(true);
  });

  it('returns false for non-input / non-alter', () => {
    expect(detectAlterType('')).toBe(false);
    expect(detectAlterType(null as any)).toBe(false);
    expect(detectAlterType('SELECT 1')).toBe(false);
    expect(detectAlterType('CREATE TYPE mood')).toBe(false);
  });
});
