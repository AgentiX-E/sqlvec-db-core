import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  detectEnumStmt,
  handleEnumStmt,
  parseCreateEnum,
  parseAlterRenameValue,
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
} from '../query/EnumShim';

describe('EnumShim', () => {
  describe('detectEnumStmt', () => {
    it('detects CREATE TYPE ... AS ENUM', () => {
      expect(detectEnumStmt("CREATE TYPE mood AS ENUM ('sad','ok','happy')")).toBe(true);
    });
    it('detects ALTER TYPE ... ADD VALUE', () => {
      expect(detectEnumStmt("ALTER TYPE mood ADD VALUE 'great'")).toBe(true);
    });
    it('detects ALTER TYPE ... RENAME VALUE', () => {
      expect(detectEnumStmt("ALTER TYPE mood RENAME VALUE 'sad' TO 'depressed'")).toBe(true);
    });
    it('detects DROP TYPE', () => {
      expect(detectEnumStmt('DROP TYPE mood')).toBe(true);
    });
    it('returns false for non-enum SQL', () => {
      expect(detectEnumStmt('SELECT 1')).toBe(false);
      expect(detectEnumStmt('CREATE TABLE t (id INT)')).toBe(false);
    });
    it('returns false for empty / non-string', () => {
      expect(detectEnumStmt('')).toBe(false);
      expect(detectEnumStmt('   ')).toBe(false);
      expect(detectEnumStmt(null as any)).toBe(false);
      expect(detectEnumStmt(42 as any)).toBe(false);
    });
  });

  describe('detectAlterType', () => {
    it('detects ALTER TYPE statements', () => {
      expect(detectAlterType("ALTER TYPE mood ADD VALUE 'great'")).toBe(true);
      expect(detectAlterType('ALTER TYPE mood RENAME TO emotion')).toBe(true);
    });
    it('returns false for non-ALTER TYPE', () => {
      expect(detectAlterType('SELECT 1')).toBe(false);
      expect(detectAlterType('CREATE TYPE x AS ENUM ()')).toBe(false);
      expect(detectAlterType('')).toBe(false);
      expect(detectAlterType(null as any)).toBe(false);
    });
  });

  describe('parseCreateEnum', () => {
    it('parses a simple enum', () => {
      expect(parseCreateEnum("CREATE TYPE mood AS ENUM ('sad','ok','happy')")).toEqual({
        typeName: 'mood', values: ['sad', 'ok', 'happy'],
      });
    });
    it('parses a quoted type name', () => {
      expect(parseCreateEnum('CREATE TYPE "my mood" AS ENUM (\'a\',\'b\')')).toEqual({
        typeName: 'my mood', values: ['a', 'b'],
      });
    });
    it('parses values with escaped quotes and commas/parens', () => {
      expect(parseCreateEnum("CREATE TYPE e AS ENUM ('it''s','a(b)c','x,y')")).toEqual({
        typeName: 'e', values: ["it's", 'a(b)c', 'x,y'],
      });
    });
    it('parses a trailing comma', () => {
      expect(parseCreateEnum("CREATE TYPE e AS ENUM ('a','b',)")).toEqual({
        typeName: 'e', values: ['a', 'b'],
      });
    });
    it('parses with trailing semicolon', () => {
      expect(parseCreateEnum("CREATE TYPE e AS ENUM ('a');")).toEqual({
        typeName: 'e', values: ['a'],
      });
    });
    it('returns null for malformed or non-enum input', () => {
      expect(parseCreateEnum('SELECT 1')).toBeNull();
      expect(parseCreateEnum('CREATE TABLE t (id INT)')).toBeNull();
      expect(parseCreateEnum("CREATE TYPE e AS ENUM ('a'")).toBeNull(); // unterminated
      expect(parseCreateEnum('')).toBeNull();
      expect(parseCreateEnum(null as any)).toBeNull();
    });
    it('parses an empty enum', () => {
      expect(parseCreateEnum('CREATE TYPE e AS ENUM ()')).toEqual({ typeName: 'e', values: [] });
    });

    it('rejects unterminated quoted identifiers', () => {
      expect(parseCreateEnum('CREATE TYPE "abc AS ENUM (\'a\')')).toBeNull();
    });
    it('rejects missing type name', () => {
      expect(parseCreateEnum("CREATE TYPE AS ENUM ('a')")).toBeNull();
    });
    it('rejects empty quoted type name', () => {
      expect(parseCreateEnum('CREATE TYPE "" AS ENUM (\'a\')')).toBeNull();
    });
    it('rejects missing AS', () => {
      expect(parseCreateEnum("CREATE TYPE e ENUM ('a')")).toBeNull();
    });
    it('rejects missing ENUM', () => {
      expect(parseCreateEnum("CREATE TYPE e AS ('a')")).toBeNull();
    });
    it('rejects missing opening paren', () => {
      expect(parseCreateEnum("CREATE TYPE e AS ENUM 'a'")).toBeNull();
    });
    it('rejects non-string enum values', () => {
      expect(parseCreateEnum('CREATE TYPE e AS ENUM (123)')).toBeNull();
    });
    it('rejects leading non-string enum value', () => {
      expect(parseCreateEnum('CREATE TYPE e AS ENUM (foo)')).toBeNull();
    });
    it('rejects trailing garbage after enum', () => {
      expect(parseCreateEnum("CREATE TYPE e AS ENUM ('a') garbage")).toBeNull();
    });
    it('rejects a non-identifier type name (starts with digit)', () => {
      expect(parseCreateEnum("CREATE TYPE 123 AS ENUM ('a')")).toBeNull();
    });
    it('rejects an unterminated enum value literal', () => {
      expect(parseCreateEnum("CREATE TYPE e AS ENUM ('abc")).toBeNull();
    });
  });

  describe('parseAlterRenameValue', () => {
    it('parses a simple rename', () => {
      expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'sad' TO 'depressed'")).toEqual({
        typeName: 'mood', oldValue: 'sad', newValue: 'depressed',
      });
    });
    it('parses quoted type name and escaped values', () => {
      expect(parseAlterRenameValue("ALTER TYPE \"my mood\" RENAME VALUE 'a''b' TO 'c''d'")).toEqual({
        typeName: 'my mood', oldValue: "a'b", newValue: "c'd",
      });
    });
    it('returns null for malformed input', () => {
      expect(parseAlterRenameValue('SELECT 1')).toBeNull();
      expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'sad' TO")).toBeNull();
      expect(parseAlterRenameValue('')).toBeNull();
      expect(parseAlterRenameValue(null as any)).toBeNull();
    });

    it('rejects missing TYPE keyword', () => {
      expect(parseAlterRenameValue("ALTER mood RENAME VALUE 'a' TO 'b'")).toBeNull();
    });
    it('rejects unterminated quoted type name', () => {
      expect(parseAlterRenameValue('ALTER TYPE "abc RENAME VALUE \'a\' TO \'b\'')).toBeNull();
    });
    it('rejects missing type name', () => {
      expect(parseAlterRenameValue("ALTER TYPE RENAME VALUE 'a' TO 'b'")).toBeNull();
    });
    it('rejects empty quoted type name', () => {
      expect(parseAlterRenameValue('ALTER TYPE "" RENAME VALUE \'a\' TO \'b\'')).toBeNull();
    });
    it('rejects missing RENAME VALUE', () => {
      expect(parseAlterRenameValue("ALTER TYPE mood 'a' TO 'b'")).toBeNull();
    });
    it('rejects non-string old value', () => {
      expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 123 TO 'b'")).toBeNull();
    });
    it('rejects unterminated old value', () => {
      expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'abc TO 'b'")).toBeNull();
    });
    it('rejects missing TO', () => {
      expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'a' 'b'")).toBeNull();
    });
    it('rejects unterminated new value', () => {
      expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'a' TO 'b")).toBeNull();
    });
    it('parses trailing semicolon', () => {
      expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'a' TO 'b';")).toEqual({
        typeName: 'mood', oldValue: 'a', newValue: 'b',
      });
    });
    it('rejects trailing garbage', () => {
      expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'a' TO 'b' extra")).toBeNull();
    });
    it('rejects a non-identifier type name (starts with digit)', () => {
      expect(parseAlterRenameValue("ALTER TYPE 123 RENAME VALUE 'a' TO 'b'")).toBeNull();
    });
    it('rejects missing VALUE keyword', () => {
      expect(parseAlterRenameValue("ALTER TYPE mood RENAME 'a' TO 'b'")).toBeNull();
    });
    it('rejects unterminated old value (starts with quote but no close)', () => {
      expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'abc TO 'b'")).toBeNull();
      // Truly unterminated old value (no closing quote anywhere).
      expect(parseAlterRenameValue("ALTER TYPE mood RENAME VALUE 'abc")).toBeNull();
    });
  });

  describe('handleEnumStmt', () => {
    it('handles CREATE TYPE ... AS ENUM', () => {
      expect(handleEnumStmt("CREATE TYPE mood AS ENUM ('sad','ok')")).toEqual({
        sql: null, rewritten: true, values: ['sad', 'ok'], typeName: 'mood',
      });
    });
    it('handles ALTER TYPE ... ADD VALUE', () => {
      expect(handleEnumStmt("ALTER TYPE mood ADD VALUE 'great'")).toEqual({
        sql: null, rewritten: true, typeName: 'mood',
      });
    });
    it('handles DROP TYPE', () => {
      expect(handleEnumStmt('DROP TYPE mood')).toEqual({
        sql: null, rewritten: true, typeName: 'mood',
      });
    });
    it('handles ALTER TYPE ... RENAME VALUE (rewrites to UPDATE)', () => {
      const r = handleEnumStmt("ALTER TYPE mood RENAME VALUE 'sad' TO 'depressed'");
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('UPDATE __enums');
    });
    it('passes through non-enum SQL', () => {
      expect(handleEnumStmt('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    });
    it('handles empty / non-string', () => {
      expect(handleEnumStmt('')).toEqual({ sql: '', rewritten: false });
      expect(handleEnumStmt(null as any)).toEqual({ sql: null, rewritten: false });
    });
  });

  describe('detectEnumTypeRef', () => {
    it('returns false for SQLite base types', () => {
      expect(detectEnumTypeRef('integer')).toBe(false);
      expect(detectEnumTypeRef('text')).toBe(false);
      expect(detectEnumTypeRef('int4')).toBe(false);
      expect(detectEnumTypeRef('jsonb')).toBe(false);
    });
    it('returns true for user-defined enum names (length > 2)', () => {
      expect(detectEnumTypeRef('mood')).toBe(true);
      expect(detectEnumTypeRef('status')).toBe(true);
      expect(detectEnumTypeRef('MyEnum')).toBe(true);
    });
    it('returns false for short names (<= 2 chars)', () => {
      expect(detectEnumTypeRef('ab')).toBe(false);
      expect(detectEnumTypeRef('a')).toBe(false);
    });
    it('returns false for invalid identifiers', () => {
      expect(detectEnumTypeRef('123abc')).toBe(false);
      expect(detectEnumTypeRef('has-dash')).toBe(false);
    });
    it('returns false for empty / non-string', () => {
      expect(detectEnumTypeRef('')).toBe(false);
      expect(detectEnumTypeRef('  ')).toBe(false);
      expect(detectEnumTypeRef(null as any)).toBe(false);
    });
  });

  describe('extractEnumValues', () => {
    it('extracts single-quoted values', () => {
      expect(extractEnumValues("('sad','ok','happy')")).toEqual(['sad', 'ok', 'happy']);
    });
    it('unescapes doubled quotes', () => {
      expect(extractEnumValues("('it''s','a')")).toEqual(["it's", 'a']);
    });
    it('skips empty strings', () => {
      expect(extractEnumValues("('','a','')")).toEqual(['a']);
    });
    it('returns [] for empty / non-string', () => {
      expect(extractEnumValues('')).toEqual([]);
      expect(extractEnumValues(null as any)).toEqual([]);
      expect(extractEnumValues('no quotes here')).toEqual([]);
    });
  });

  describe('registry (create/validate/addValue/drop/list/get)', () => {
    beforeEach(() => {
      for (const d of list()) drop(d.name);
    });
    it('creates and validates (case-insensitive)', async () => {
      const def = await create('Mood', ['sad', 'ok', 'happy']);
      expect(def).toEqual({ name: 'Mood', values: ['sad', 'ok', 'happy'] });
      expect(validate('sad', 'mood')).toBe(true);
      expect(validate('sad', 'MOOD')).toBe(true);
      expect(validate('angry', 'mood')).toBe(false);
    });
    it('throws when validating unknown enum', () => {
      expect(() => validate('x', 'nope')).toThrow(/not found/);
    });
    it('addValue adds and persists', async () => {
      await create('e', ['a']);
      await addValue('e', 'b');
      expect(get('e')?.values).toEqual(['a', 'b']);
      await addValue('e', 'b'); // duplicate is no-op
      expect(get('e')?.values).toEqual(['a', 'b']);
    });
    it('addValue throws for unknown enum', async () => {
      await expect(addValue('nope', 'x')).rejects.toThrow(/not found/);
    });
    it('drop removes and list reflects', async () => {
      await create('e1', ['a']);
      await create('e2', ['b']);
      expect(list()).toHaveLength(2);
      await drop('E1');
      expect(get('e1')).toBeUndefined();
      expect(list()).toHaveLength(1);
    });
    it('drop of unknown enum is a no-op', async () => {
      await drop('nope');
      expect(list()).toHaveLength(0);
    });

    describe('persistence via queryFn', () => {
      it('create persists INSERT with escaped name', async () => {
        const calls: string[] = [];
        const qf = vi.fn(async (s: string) => { calls.push(s); return undefined; });
        await create("o'brien", ['a'], qf);
        expect(calls.some((c) => c.includes('CREATE TABLE IF NOT EXISTS __enums'))).toBe(true);
        expect(calls.some((c) => c.includes('INSERT OR REPLACE'))).toBe(true);
        expect(calls.some((c) => c.includes("'o''brien'"))).toBe(true);
      });
      it('addValue persists UPDATE via queryFn', async () => {
        const calls: string[] = [];
        const qf = vi.fn(async (s: string) => { calls.push(s); return undefined; });
        await create('e', ['a'], qf);
        calls.length = 0;
        await addValue('e', 'b', qf);
        expect(calls.some((c) => c.includes('UPDATE __enums'))).toBe(true);
      });
      it('drop persists DELETE via queryFn', async () => {
        const calls: string[] = [];
        const qf = vi.fn(async (s: string) => { calls.push(s); return undefined; });
        await create('e', ['a'], qf);
        calls.length = 0;
        await drop('e', qf);
        expect(calls.some((c) => c.includes('DELETE FROM __enums'))).toBe(true);
      });
    });
  });

  describe('ensureMetaTable', () => {
    it('calls queryFn with DDL', async () => {
      const qf = vi.fn(async () => undefined);
      await ensureMetaTable(qf);
      expect(qf).toHaveBeenCalledTimes(1);
      expect(qf.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS __enums');
    });
    it('rethrows on failure', async () => {
      const qf = vi.fn(async () => { throw new Error('boom'); });
      await expect(ensureMetaTable(qf)).rejects.toThrow('boom');
    });
  });

  describe('loadFromDB', () => {
    beforeEach(() => {
      for (const d of list()) drop(d.name);
    });
    it('loads rows as array of objects', async () => {
      const qf = vi.fn(async (s: string) => {
        if (s.includes('SELECT name')) return [{ name: 'e1', values_json: '["a","b"]' }];
        return undefined;
      });
      await loadFromDB(qf);
      expect(get('e1')?.values).toEqual(['a', 'b']);
    });
    it('loads rows as { rows } object', async () => {
      const qf = vi.fn(async (s: string) => {
        if (s.includes('SELECT name')) return { rows: [{ name: 'e2', values_json: '[]' }] };
        return undefined;
      });
      await loadFromDB(qf);
      expect(get('e2')?.values).toEqual([]);
    });
    it('loads positional rows', async () => {
      const qf = vi.fn(async (s: string) => {
        if (s.includes('SELECT name')) return [['e3', '["x"]']];
        return undefined;
      });
      await loadFromDB(qf);
      expect(get('e3')?.values).toEqual(['x']);
    });
    it('defaults values to [] when values_json and row[1] absent', async () => {
      const qf = vi.fn(async (s: string) => {
        if (s.includes('SELECT name')) return [{ name: 'e4' }];
        return undefined;
      });
      await loadFromDB(qf);
      expect(get('e4')?.values).toEqual([]);
    });
    it('defaults values to [] when values_json is non-string', async () => {
      const qf = vi.fn(async (s: string) => {
        if (s.includes('SELECT name')) return [{ name: 'e5', values_json: ['x'] }];
        return undefined;
      });
      await loadFromDB(qf);
      expect(get('e5')?.values).toEqual([]);
    });
    it('handles result without rows', async () => {
      const qf = vi.fn(async (s: string) => (s.includes('SELECT name') ? 0 : undefined));
      await loadFromDB(qf); // no crash
    });
    it('swallows errors', async () => {
      const qf = vi.fn(async () => { throw new Error('no table'); });
      await expect(loadFromDB(qf)).resolves.toBeUndefined();
    });
  });

  describe('handleAlterTypeRenameValue', () => {
    beforeEach(() => {
      for (const d of list()) drop(d.name);
    });
    it('returns null for malformed / non-string', () => {
      expect(handleAlterTypeRenameValue('SELECT 1')).toBeNull();
      expect(handleAlterTypeRenameValue('')).toBeNull();
      expect(handleAlterTypeRenameValue(null as any)).toBeNull();
    });
    it('renames in-memory and produces UPDATE', async () => {
      await create('mood', ['sad', 'ok']);
      const sql = handleAlterTypeRenameValue("ALTER TYPE mood RENAME VALUE 'sad' TO 'depressed'");
      expect(sql).toContain('UPDATE __enums');
      expect(sql).toContain('depressed');
      expect(get('mood')?.values).toEqual(['depressed', 'ok']);
    });
    it('logs warning when old value not found (still produces SQL)', async () => {
      await create('mood', ['ok']);
      const sql = handleAlterTypeRenameValue("ALTER TYPE mood RENAME VALUE 'sad' TO 'depressed'");
      expect(sql).toContain('UPDATE __enums');
      expect(get('mood')?.values).toEqual(['ok']); // unchanged
    });
    it('produces SQL even when enum not in registry', () => {
      const sql = handleAlterTypeRenameValue("ALTER TYPE mood RENAME VALUE 'sad' TO 'depressed'");
      expect(sql).toContain('UPDATE __enums');
    });
  });
});
