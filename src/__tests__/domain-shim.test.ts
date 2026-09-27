import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  detectDomainStmt,
  handleDomainStmt,
  detectDomainTypeRef,
  ensureMetaTable,
  create,
  validate,
  parseDomainSQL,
  drop,
  list,
  get,
  loadFromDB,
} from '../query/DomainShim';

describe('DomainShim', () => {
  describe('detectDomainStmt', () => {
    it('detects CREATE/DROP/ALTER DOMAIN', () => {
      expect(detectDomainStmt('CREATE DOMAIN positive_int AS INTEGER')).toBe(true);
      expect(detectDomainStmt('DROP DOMAIN positive_int')).toBe(true);
      expect(detectDomainStmt('ALTER DOMAIN positive_int ADD CONSTRAINT c CHECK (VALUE > 0)')).toBe(true);
    });

    it('detects case-insensitively', () => {
      expect(detectDomainStmt('create domain d as text')).toBe(true);
    });

    it('returns false for non-domain SQL', () => {
      expect(detectDomainStmt('CREATE TABLE t (id INT)')).toBe(false);
      expect(detectDomainStmt('SELECT 1')).toBe(false);
    });

    it('returns false for empty / non-string', () => {
      expect(detectDomainStmt('')).toBe(false);
      expect(detectDomainStmt('   ')).toBe(false);
      expect(detectDomainStmt(null as any)).toBe(false);
      expect(detectDomainStmt(undefined as any)).toBe(false);
      expect(detectDomainStmt(42 as any)).toBe(false);
    });
  });

  describe('handleDomainStmt', () => {
    it('suppresses CREATE DOMAIN', () => {
      expect(handleDomainStmt('CREATE DOMAIN d AS INTEGER CHECK (VALUE > 0)')).toEqual({
        sql: null, rewritten: false, isDomainDDL: true,
      });
    });

    it('suppresses DROP DOMAIN', () => {
      expect(handleDomainStmt('DROP DOMAIN d')).toEqual({
        sql: null, rewritten: false, isDomainDDL: true,
      });
    });

    it('suppresses ALTER DOMAIN', () => {
      expect(handleDomainStmt('ALTER DOMAIN d ADD CONSTRAINT c CHECK (VALUE > 0)')).toEqual({
        sql: null, rewritten: false, isDomainDDL: true,
      });
    });

    it('passes through non-domain SQL', () => {
      expect(handleDomainStmt('SELECT 1')).toEqual({
        sql: 'SELECT 1', rewritten: false, isDomainDDL: false,
      });
    });

    it('handles empty / non-string', () => {
      expect(handleDomainStmt('')).toEqual({ sql: '', rewritten: false, isDomainDDL: false });
      expect(handleDomainStmt(null as any)).toEqual({ sql: null, rewritten: false, isDomainDDL: false });
    });
  });

  describe('detectDomainTypeRef', () => {
    it('returns false for base type names', () => {
      expect(detectDomainTypeRef('INTEGER')).toBe(false);
      expect(detectDomainTypeRef('int')).toBe(false);
      expect(detectDomainTypeRef('text')).toBe(false);
      expect(detectDomainTypeRef('varchar')).toBe(false);
      expect(detectDomainTypeRef('BOOLEAN')).toBe(false);
      expect(detectDomainTypeRef('jsonb')).toBe(false);
      expect(detectDomainTypeRef('bytea')).toBe(false);
    });

    it('returns true for user-defined domain names', () => {
      expect(detectDomainTypeRef('positive_int')).toBe(true);
      expect(detectDomainTypeRef('my_domain')).toBe(true);
      expect(detectDomainTypeRef('email_addr')).toBe(true);
    });

    it('returns false for invalid identifiers', () => {
      expect(detectDomainTypeRef('123abc')).toBe(false);
      expect(detectDomainTypeRef('with space')).toBe(false);
      expect(detectDomainTypeRef('has-dash')).toBe(false);
    });

    it('returns false for empty / non-string', () => {
      expect(detectDomainTypeRef('')).toBe(false);
      expect(detectDomainTypeRef('   ')).toBe(false);
      expect(detectDomainTypeRef(null as any)).toBe(false);
      expect(detectDomainTypeRef(undefined as any)).toBe(false);
      expect(detectDomainTypeRef(123 as any)).toBe(false);
    });
  });

  describe('create / validate / get / list / drop', () => {
    beforeEach(() => {
      // Reset registry state between tests
      for (const d of list()) {
        drop(d.name);
      }
    });

    it('creates a domain and validates values against it', async () => {
      const def = await create('positive_int', 'INTEGER', [
        { expression: 'VALUE > 0' },
      ]);
      expect(def.name).toBe('positive_int');
      expect(get('positive_int')).toBeDefined();
      expect(get('POSITIVE_INT')).toBeDefined(); // case-insensitive

      expect(validate(5, 'positive_int')).toBe(true);
      expect(validate(-1, 'positive_int')).toBe(false);
    });

    it('validates multiple constraints (all must pass)', async () => {
      await create('bounded', 'INTEGER', [
        { expression: 'VALUE >= 0' },
        { expression: 'VALUE <= 100' },
      ]);
      expect(validate(50, 'bounded')).toBe(true);
      expect(validate(-1, 'bounded')).toBe(false);
      expect(validate(101, 'bounded')).toBe(false);
    });

    it('throws when validating an unknown domain', () => {
      expect(() => validate(1, 'nope')).toThrow(/not found/);
    });

    it('drops a domain (case-insensitive) and lists correctly', async () => {
      await create('d1', 'TEXT', []);
      await create('d2', 'TEXT', []);
      expect(list()).toHaveLength(2);

      await drop('D1');
      expect(get('d1')).toBeUndefined();
      expect(list()).toHaveLength(1);
    });

    it('drop of unknown domain is a no-op', async () => {
      await drop('never_created');
      expect(list()).toHaveLength(0);
    });

    describe('with queryFn persistence', () => {
      it('persists create and drop via queryFn', async () => {
        const calls: string[] = [];
        const queryFn = vi.fn(async (sql: string) => {
          calls.push(sql);
          return undefined;
        });

        await create("o'brien", 'TEXT', [{ expression: 'VALUE <> \'\'' }], queryFn);
        // ensureMetaTable + INSERT
        expect(calls.some((c) => c.includes('CREATE TABLE IF NOT EXISTS __domains'))).toBe(true);
        expect(calls.some((c) => c.includes('INSERT OR REPLACE'))).toBe(true);
        // single quotes escaped
        expect(calls.some((c) => c.includes("'o''brien'"))).toBe(true);
      });

      it('drop persists DELETE via queryFn', async () => {
        const calls: string[] = [];
        const queryFn = vi.fn(async (sql: string) => {
          calls.push(sql);
          return undefined;
        });
        await create('d', 'TEXT', [], queryFn);
        calls.length = 0;
        await drop('d', queryFn);
        expect(calls.some((c) => c.includes("DELETE FROM __domains WHERE name = 'd'"))).toBe(true);
      });
    });
  });

  describe('parseDomainSQL', () => {
    it('parses a simple CREATE DOMAIN', () => {
      expect(parseDomainSQL('CREATE DOMAIN positive_int AS INTEGER CHECK (VALUE > 0)')).toEqual({
        name: 'positive_int',
        baseType: 'INTEGER',
        constraints: [{ expression: 'VALUE > 0' }],
      });
    });

    it('parses multiple CHECK constraints', () => {
      const r = parseDomainSQL('CREATE DOMAIN d AS INTEGER CHECK (VALUE > 0) CHECK (VALUE < 100)');
      expect(r?.name).toBe('d');
      expect(r?.baseType).toBe('INTEGER');
      expect(r?.constraints).toHaveLength(2);
      expect(r?.constraints.map((c) => c.expression)).toEqual(['VALUE > 0', 'VALUE < 100']);
    });

    it('uppercases the base type', () => {
      expect(parseDomainSQL('CREATE DOMAIN d AS text')?.baseType).toBe('TEXT');
    });

    it('returns null for non-CREATE DOMAIN SQL', () => {
      expect(parseDomainSQL('SELECT 1')).toBeNull();
      expect(parseDomainSQL('CREATE TABLE t (id INT)')).toBeNull();
      expect(parseDomainSQL('')).toBeNull();
      expect(parseDomainSQL(null as any)).toBeNull();
    });

    it('does NOT extract CHECK inside a string literal', () => {
      // Regression guard: a CHECK-looking fragment inside a string must not be parsed.
      const r = parseDomainSQL("CREATE DOMAIN d AS TEXT DEFAULT 'CHECK (VALUE > 0)'");
      // The top-level regex has no CHECK clause, so constraints must be empty
      expect(r?.constraints ?? []).toHaveLength(0);
    });

    it('extracts CHECK with nested parentheses in the expression', () => {
      const r = parseDomainSQL('CREATE DOMAIN d AS INT CHECK (VALUE IN (1,2,3))');
      expect(r?.constraints).toEqual([{ expression: 'VALUE IN (1,2,3)' }]);
    });

    it('skips CHECK inside dollar-quoted strings', () => {
      const r = parseDomainSQL("CREATE DOMAIN d AS TEXT DEFAULT $$ CHECK (x) $$ CHECK (VALUE <> '')");
      expect(r?.constraints).toEqual([{ expression: "VALUE <> ''" }]);
    });

    it('preserves escaped single quotes inside CHECK expressions', () => {
      const r = parseDomainSQL("CREATE DOMAIN d AS TEXT CHECK (VALUE <> 'it''s')");
      expect(r?.constraints).toEqual([{ expression: "VALUE <> 'it''s'" }]);
    });

    it('ignores an empty CHECK () clause', () => {
      const r = parseDomainSQL('CREATE DOMAIN d AS INT CHECK ()');
      expect(r?.constraints).toEqual([]);
    });

    it('skips CHECK inside double-quoted identifiers', () => {
      const r = parseDomainSQL('CREATE DOMAIN d AS INT CHECK (VALUE > 0)');
      expect(r?.constraints).toEqual([{ expression: 'VALUE > 0' }]);
      // A double-quoted identifier containing "CHECK (" must not be parsed.
      const r2 = parseDomainSQL('CREATE DOMAIN d AS TEXT DEFAULT "CHECK (x)" CHECK (VALUE > 0)');
      expect(r2?.constraints).toEqual([{ expression: 'VALUE > 0' }]);
    });

    it('skips CHECK inside line comments', () => {
      // `--` runs to end of the captured tail (the top-level regex stops at the
      // first newline), so a trailing comment consumes the rest of the clause.
      const r = parseDomainSQL('CREATE DOMAIN d AS INT CHECK (VALUE > 1) -- CHECK (VALUE > 0)');
      expect(r?.constraints).toEqual([{ expression: 'VALUE > 1' }]);
    });

    it('skips CHECK inside block comments', () => {
      const r = parseDomainSQL('CREATE DOMAIN d AS INT /* CHECK (VALUE > 0) */ CHECK (VALUE > 2)');
      expect(r?.constraints).toEqual([{ expression: 'VALUE > 2' }]);
    });

    it('handles an unclosed CHECK parenthesis gracefully', () => {
      const r = parseDomainSQL('CREATE DOMAIN d AS INT CHECK (VALUE > 0');
      expect(r?.name).toBe('d');
      expect(r?.constraints).toEqual([]);
    });

    it('handles an unclosed string literal in a CHECK expression', () => {
      const r = parseDomainSQL("CREATE DOMAIN d AS TEXT CHECK (VALUE <> 'unterminated");
      expect(r?.constraints).toEqual([]);
    });

    it('handles an unclosed dollar-quote gracefully', () => {
      const r = parseDomainSQL('CREATE DOMAIN d AS TEXT DEFAULT $$ CHECK (x) CHECK (VALUE > 0)');
      expect(r?.constraints).toEqual([]);
    });

    it('preserves double-quoted identifiers inside CHECK expressions', () => {
      const r = parseDomainSQL('CREATE DOMAIN d AS INT CHECK (VALUE = "other col")');
      expect(r?.constraints).toEqual([{ expression: 'VALUE = "other col"' }]);
    });

    it('handles escaped double quotes inside a quoted identifier', () => {
      // `""` is an escaped quote inside a quoted identifier.
      const r = parseDomainSQL('CREATE DOMAIN d AS TEXT DEFAULT "we""ird" CHECK (VALUE > 0)');
      expect(r?.constraints).toEqual([{ expression: 'VALUE > 0' }]);
    });

    it('handles an unclosed double-quoted identifier', () => {
      const r = parseDomainSQL('CREATE DOMAIN d AS TEXT DEFAULT "unterminated');
      expect(r?.constraints).toEqual([]);
    });

    it('handles an unclosed block comment', () => {
      const r = parseDomainSQL('CREATE DOMAIN d AS INT /* CHECK (VALUE > 0)');
      expect(r?.constraints).toEqual([]);
    });
  });

  describe('ensureMetaTable', () => {
    it('calls queryFn with the DDL', async () => {
      const queryFn = vi.fn(async () => undefined);
      await ensureMetaTable(queryFn);
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(queryFn.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS __domains');
    });

    it('rethrows on query failure', async () => {
      const queryFn = vi.fn(async () => {
        throw new Error('boom');
      });
      await expect(ensureMetaTable(queryFn)).rejects.toThrow('boom');
    });
  });

  describe('loadFromDB', () => {
    beforeEach(() => {
      for (const d of list()) drop(d.name);
    });

    it('loads rows given as an array of objects', async () => {
      const queryFn = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT name')) {
          return [
            { name: 'd1', base_type: 'INTEGER', constraints_json: '[{"expression":"VALUE > 0"}]' },
            { name: 'd2', base_type: 'TEXT', constraints_json: '[]' },
          ];
        }
        return undefined;
      });
      await loadFromDB(queryFn);
      expect(get('d1')).toEqual({
        name: 'd1', baseType: 'INTEGER',
        constraints: [{ expression: 'VALUE > 0' }],
      });
      expect(get('d2')).toBeDefined();
    });

    it('loads rows given as a { rows } object', async () => {
      const queryFn = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT name')) {
          return { rows: [{ name: 'dA', base_type: 'TEXT', constraints_json: '[]' }] };
        }
        return undefined;
      });
      await loadFromDB(queryFn);
      expect(get('da')).toBeDefined();
    });

    it('loads rows with positional (array) access fallback', async () => {
      const queryFn = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT name')) {
          return [['db', 'REAL', '[]']];
        }
        return undefined;
      });
      await loadFromDB(queryFn);
      expect(get('db')).toMatchObject({ name: 'db', baseType: 'REAL' });
    });

    it('loads rows with non-string constraints_json (defaults to [])', async () => {
      const queryFn = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT name')) {
          // row[2] is a non-string (e.g. an already-parsed array)
          return [{ name: 'dc', base_type: 'TEXT', constraints_json: ['not', 'a', 'string'] }];
        }
        return undefined;
      });
      await loadFromDB(queryFn);
      expect(get('dc')).toMatchObject({ name: 'dc', baseType: 'TEXT', constraints: [] });
    });

    it('defaults constraints to [] when constraints_json and row[2] are absent', async () => {
      const queryFn = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT name')) {
          // No constraints_json field and no third positional element at all.
          return [{ name: 'dd', base_type: 'INT' }];
        }
        return undefined;
      });
      await loadFromDB(queryFn);
      expect(get('dd')).toMatchObject({ name: 'dd', baseType: 'INT', constraints: [] });
    });

    it('treats a result without rows as empty', async () => {
      const queryFn = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT name')) return 0; // neither array nor {rows}
        return undefined;
      });
      await loadFromDB(queryFn);
      // no crash; registry unaffected
    });

    it('swallows errors (logs warning, does not throw)', async () => {
      const queryFn = vi.fn(async () => {
        throw new Error('no such table');
      });
      await expect(loadFromDB(queryFn)).resolves.toBeUndefined();
    });
  });
});
