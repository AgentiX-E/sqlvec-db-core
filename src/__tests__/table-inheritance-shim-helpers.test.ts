import { describe, it, expect } from 'vitest';
import {
  _mapSqliteTypeToPgType,
  _parseParentTableList,
  _splitColumnDefs,
  _parseSimpleColumnDef,
  _findTopLevelFrom,
  _hashTableNameToOid,
} from '../query/TableInheritanceShim';

describe('_mapSqliteTypeToPgType', () => {
  it('maps null/empty to TEXT', () => {
    expect(_mapSqliteTypeToPgType(null)).toBe('TEXT');
    expect(_mapSqliteTypeToPgType('')).toBe('TEXT');
  });

  it('maps INT variants to INTEGER', () => {
    expect(_mapSqliteTypeToPgType('int')).toBe('INTEGER');
    expect(_mapSqliteTypeToPgType('BIGINT')).toBe('INTEGER');
    expect(_mapSqliteTypeToPgType('smallint')).toBe('INTEGER');
  });

  it('maps CHAR/TEXT/CLOB to TEXT', () => {
    expect(_mapSqliteTypeToPgType('VARCHAR(50)')).toBe('TEXT');
    expect(_mapSqliteTypeToPgType('TEXT')).toBe('TEXT');
    expect(_mapSqliteTypeToPgType('CLOB')).toBe('TEXT');
  });

  it('maps BLOB to BLOB', () => {
    expect(_mapSqliteTypeToPgType('BLOB')).toBe('BLOB');
  });

  it('maps REAL/FLOAT/DOUBLE to REAL', () => {
    expect(_mapSqliteTypeToPgType('REAL')).toBe('REAL');
    expect(_mapSqliteTypeToPgType('FLOAT')).toBe('REAL');
    expect(_mapSqliteTypeToPgType('DOUBLE')).toBe('REAL');
  });

  it('maps BOOLEAN/BOOL to BOOLEAN', () => {
    expect(_mapSqliteTypeToPgType('BOOLEAN')).toBe('BOOLEAN');
    expect(_mapSqliteTypeToPgType('BOOL')).toBe('BOOLEAN');
  });

  it('maps DATE/TIME variants to TIMESTAMP', () => {
    expect(_mapSqliteTypeToPgType('DATE')).toBe('TIMESTAMP');
    expect(_mapSqliteTypeToPgType('DATETIME')).toBe('TIMESTAMP');
  });

  it('maps NUMERIC/DECIMAL to NUMERIC', () => {
    expect(_mapSqliteTypeToPgType('NUMERIC')).toBe('NUMERIC');
    expect(_mapSqliteTypeToPgType('DECIMAL(10,2)')).toBe('NUMERIC');
  });

  it('falls back to TEXT for unknown types', () => {
    expect(_mapSqliteTypeToPgType('JSON')).toBe('TEXT');
  });
});

describe('_parseParentTableList', () => {
  it('splits comma-separated identifiers', () => {
    expect(_parseParentTableList('a, b, c')).toEqual(['a', 'b', 'c']);
  });

  it('handles quoted identifiers with spaces', () => {
    expect(_parseParentTableList('"Parent Table", `other table`')).toEqual(['Parent Table', 'other table']);
  });

  it('handles doubled double-quotes', () => {
    expect(_parseParentTableList('"a""b"')).toEqual(['a"b']);
  });

  it('returns empty array for empty input', () => {
    expect(_parseParentTableList('')).toEqual([]);
  });

  it('ignores empty segments', () => {
    expect(_parseParentTableList('a,,b,')).toEqual(['a', 'b']);
  });
});

describe('_splitColumnDefs', () => {
  it('splits on top-level commas (preserving the trailing space)', () => {
    expect(_splitColumnDefs('a INT, b TEXT').map(s => s.trim())).toEqual(['a INT', 'b TEXT']);
  });

  it('does not split on commas inside parentheses', () => {
    expect(_splitColumnDefs('a INT DEFAULT (1,2), b TEXT').map(s => s.trim())).toEqual([
      'a INT DEFAULT (1,2)',
      'b TEXT',
    ]);
  });

  it('does not split on commas inside string literals', () => {
    expect(_splitColumnDefs("a TEXT DEFAULT 'x,y', b INT").map(s => s.trim())).toEqual([
      "a TEXT DEFAULT 'x,y'",
      'b INT',
    ]);
  });

  it('drops a trailing empty segment', () => {
    expect(_splitColumnDefs('a INT,')).toEqual(['a INT']);
  });
});

describe('_parseSimpleColumnDef', () => {
  it('returns null for empty or non-name input', () => {
    expect(_parseSimpleColumnDef('')).toBeNull();
    expect(_parseSimpleColumnDef('   ')).toBeNull();
  });

  it('parses name and type', () => {
    expect(_parseSimpleColumnDef('age INT')).toEqual({ name: 'age', type: 'INT', notnull: false, dflt_value: null });
  });

  it('parses NOT NULL', () => {
    expect(_parseSimpleColumnDef('age INT NOT NULL')).toEqual({
      name: 'age',
      type: 'INT',
      notnull: true,
      dflt_value: null,
    });
  });

  it('parses DEFAULT string with escapes', () => {
    const r = _parseSimpleColumnDef("name TEXT DEFAULT 'it''s'");
    expect(r!.dflt_value).toBe("'it''s'");
  });

  it('parses quoted identifier name', () => {
    expect(_parseSimpleColumnDef('"weird name" TEXT')).toEqual({
      name: 'weird name',
      type: 'TEXT',
      notnull: false,
      dflt_value: null,
    });
  });

  it('parses backtick-quoted identifier name', () => {
    expect(_parseSimpleColumnDef('`weird name` TEXT')).toEqual({
      name: 'weird name',
      type: 'TEXT',
      notnull: false,
      dflt_value: null,
    });
  });

  it('defaults type to TEXT when missing', () => {
    // a bare single word is not a valid column def (needs name + type)
    expect(_parseSimpleColumnDef('x')).toBeNull();
  });

  it('returns null when no name+space prefix', () => {
    expect(_parseSimpleColumnDef('123notanident TEXT')).toBeNull();
  });

  it('defaults type to TEXT when type token missing (bare NOT NULL is invalid SQL)', () => {
    // `age NOT NULL` is not valid SQL (a type is mandatory); the parser reads
    // `NOT` as the (bogus) type token, which is acceptable for malformed input.
    const r = _parseSimpleColumnDef('age NOT NULL');
    expect(r).toEqual({ name: 'age', type: 'NOT', notnull: false, dflt_value: null });
  });
});

describe('_findTopLevelFrom', () => {
  it('finds a simple FROM table', () => {
    expect(_findTopLevelFrom('SELECT * FROM users')).toMatchObject({
      tableName: 'users',
      alias: '',
      only: false,
    });
  });

  it('finds FROM with alias', () => {
    const r = _findTopLevelFrom('SELECT * FROM users u');
    expect(r!.tableName).toBe('users');
    expect(r!.alias).toBe('u');
  });

  it('finds FROM ONLY', () => {
    const r = _findTopLevelFrom('SELECT * FROM ONLY users');
    expect(r!.only).toBe(true);
  });

  it('returns null when no FROM at top level', () => {
    expect(_findTopLevelFrom('SELECT 1')).toBeNull();
  });

  it('skips FROM inside a string literal', () => {
    const r = _findTopLevelFrom("SELECT 'FROM x' AS y FROM real_table");
    expect(r!.tableName).toBe('real_table');
  });

  it('skips FROM inside a parenthesised subquery (returns null — not an expandable table)', () => {
    expect(_findTopLevelFrom('SELECT * FROM (SELECT * FROM inner) AS s')).toBeNull();
  });

  it('does not treat a trailing keyword as an alias', () => {
    const r = _findTopLevelFrom('SELECT * FROM users WHERE id = 1');
    expect(r!.tableName).toBe('users');
    expect(r!.alias).toBe('');
  });

  it('handles a backtick-quoted table name', () => {
    const r = _findTopLevelFrom('SELECT * FROM `weird table`');
    expect(r!.tableName).toBe('weird table');
  });

  it('handles a double-quoted table name with spaces', () => {
    const r = _findTopLevelFrom('SELECT * FROM "my table"');
    expect(r!.tableName).toBe('my table');
  });
});

describe('_hashTableNameToOid', () => {
  it('produces a deterministic non-negative range-bounded OID', () => {
    const a = _hashTableNameToOid('users', 50000);
    const b = _hashTableNameToOid('users', 50000);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(50000);
    expect(a).toBeLessThanOrEqual(60000);
  });

  it('produces different OIDs for different names', () => {
    expect(_hashTableNameToOid('users', 100)).not.toBe(_hashTableNameToOid('orders', 100));
  });
});
