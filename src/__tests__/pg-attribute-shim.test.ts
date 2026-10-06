import { describe, it, expect } from 'vitest';
import {
  getPgAttributes,
  getPgAttributesForAllTables,
  formatPgAttributeResult,
  type PragmaTableInfoColumn,
  type PgAttributeRow,
} from '../query/PgAttributeShim';

const baseColumn: PragmaTableInfoColumn = {
  cid: 0,
  name: 'id',
  type: 'INTEGER',
  notnull: 1,
  dflt_value: null,
  pk: 1,
};

describe('getPgAttributes', () => {
  it('returns an empty array for an empty table name', () => {
    expect(getPgAttributes('', [baseColumn])).toEqual([]);
  });

  it('returns an empty array for a nullish table name', () => {
    expect(getPgAttributes(undefined as unknown as string, [baseColumn])).toEqual([]);
  });

  it('returns an empty array for null columns', () => {
    expect(getPgAttributes('users', null as unknown as PragmaTableInfoColumn[])).toEqual([]);
  });

  it('returns an empty array for an empty columns list', () => {
    expect(getPgAttributes('users', [])).toEqual([]);
  });

  it('maps a column to a pg_attribute row with correct defaults', () => {
    const rows = getPgAttributes('users', [baseColumn]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.attname).toBe('id');
    expect(row.attnum).toBe(1); // cid 0 → 1-based
    expect(row.atttypid).toBe(23); // INTEGER
    expect(row.attlen).toBe(4);
    expect(row.attbyval).toBe(true);
    expect(row.attstorage).toBe('p');
    expect(row.attalign).toBe('i');
    expect(row.attnotnull).toBe(true);
    expect(row.atthasdef).toBe(false);
    expect(row.atthasmissing).toBe(false);
    expect(row.attidentity).toBe('');
    expect(row.attgenerated).toBe('');
    expect(row.attisdropped).toBe(false);
    expect(row.attislocal).toBe(true);
    expect(row.attinhcount).toBe(0);
    expect(row.attcollation).toBe(0);
    expect(row.attacl).toBeNull();
    expect(row.attoptions).toBeNull();
    expect(row.attfdwoptions).toBeNull();
    expect(row.attmissingval).toBeNull();
    expect(row.attstattarget).toBe(-1);
    expect(row.attcacheoff).toBe(-1);
    expect(row.atttypmod).toBe(-1);
    expect(row.attndims).toBe(0);
  });

  it('computes a stable pseudo-OID from the table name', () => {
    const a = getPgAttributes('users', [baseColumn]);
    const b = getPgAttributes('users', [baseColumn]);
    expect(a[0].attrelid).toBe(b[0].attrelid);
    expect(a[0].attrelid).toBeGreaterThanOrEqual(100000);
  });

  it('produces distinct OIDs for distinct table names', () => {
    const a = getPgAttributes('users', [baseColumn])[0].attrelid;
    const b = getPgAttributes('orders', [baseColumn])[0].attrelid;
    expect(a).not.toBe(b);
  });

  it('honors an explicit tableOid override', () => {
    const rows = getPgAttributes('users', [baseColumn], { tableOid: 42 });
    expect(rows[0].attrelid).toBe(42);
  });

  it('sets atthasdef when the column has a DEFAULT value', () => {
    const col: PragmaTableInfoColumn = { ...baseColumn, dflt_value: '1' };
    const rows = getPgAttributes('users', [col]);
    expect(rows[0].atthasdef).toBe(true);
  });

  it('treats an empty-string DEFAULT as a present default', () => {
    const col: PragmaTableInfoColumn = { ...baseColumn, dflt_value: '' };
    const rows = getPgAttributes('users', [col]);
    expect(rows[0].atthasdef).toBe(true);
  });

  it('uses 1-based attnum matching cid order', () => {
    const cols: PragmaTableInfoColumn[] = [
      { ...baseColumn, cid: 0, name: 'a' },
      { ...baseColumn, cid: 1, name: 'b' },
      { ...baseColumn, cid: 2, name: 'c' },
    ];
    const rows = getPgAttributes('t', cols);
    expect(rows.map(r => r.attnum)).toEqual([1, 2, 3]);
    expect(rows.map(r => r.attname)).toEqual(['a', 'b', 'c']);
  });

  it('marks a nullable column as attnotnull=false', () => {
    const col: PragmaTableInfoColumn = { ...baseColumn, notnull: 0 };
    expect(getPgAttributes('users', [col])[0].attnotnull).toBe(false);
  });

  it('maps type modifiers to the base type OID', () => {
    const col: PragmaTableInfoColumn = { ...baseColumn, type: 'VARCHAR(255)' };
    expect(getPgAttributes('users', [col])[0].atttypid).toBe(1043);
  });

  it('maps a type in a different case', () => {
    const col: PragmaTableInfoColumn = { ...baseColumn, type: 'bigint' };
    expect(getPgAttributes('users', [col])[0].atttypid).toBe(20);
  });

  it('falls back to text OID for an unknown type', () => {
    const col: PragmaTableInfoColumn = { ...baseColumn, type: 'MONEYBOX' };
    expect(getPgAttributes('users', [col])[0].atttypid).toBe(25);
  });

  it('falls back to text info for a nullish type name', () => {
    const col: PragmaTableInfoColumn = { ...baseColumn, type: undefined as unknown as string };
    const row = getPgAttributes('users', [col])[0];
    expect(row.atttypid).toBe(25);
    expect(row.attlen).toBe(-1);
  });

  it('honors a customTypeMap override for a known built-in type', () => {
    const rows = getPgAttributes('users', [baseColumn], {
      customTypeMap: { INTEGER: { oid: 999, len: 7, byval: false, storage: 'e', align: 'x' } },
    });
    expect(rows[0].atttypid).toBe(999);
    expect(rows[0].attlen).toBe(7);
    expect(rows[0].attbyval).toBe(false);
    expect(rows[0].attstorage).toBe('e');
    expect(rows[0].attalign).toBe('x');
  });

  it('resolves a custom type via customTypeMap even if not built-in', () => {
    const cols: PragmaTableInfoColumn[] = [{ ...baseColumn, type: 'UUID' }];
    const rows = getPgAttributes('users', cols, {
      customTypeMap: { UUID: { oid: 2950, len: 16, byval: false, storage: 'p', align: 'i' } },
    });
    expect(rows[0].atttypid).toBe(2950);
  });

  it('falls back to the built-in map when customTypeMap lacks a type', () => {
    const rows = getPgAttributes('users', [baseColumn], {
      customTypeMap: { TEXT: { oid: 1111, len: -1, byval: false, storage: 'x', align: 'i' } },
    });
    // INTEGER not in customTypeMap → built-in oid 23
    expect(rows[0].atttypid).toBe(23);
  });

  it('strips modifiers before a customTypeMap lookup', () => {
    const cols: PragmaTableInfoColumn[] = [{ ...baseColumn, type: 'VARCHAR(50)' }];
    const rows = getPgAttributes('users', cols, {
      customTypeMap: { VARCHAR: { oid: 222, len: -1, byval: false, storage: 'x', align: 'i' } },
    });
    expect(rows[0].atttypid).toBe(222);
  });
});

describe('getPgAttributesForAllTables', () => {
  it('returns an empty array for an empty map', () => {
    expect(getPgAttributesForAllTables(new Map())).toEqual([]);
  });

  it('aggregates rows across multiple tables', () => {
    const tables = new Map<string, PragmaTableInfoColumn[]>([
      ['users', [baseColumn]],
      ['orders', [{ ...baseColumn, name: 'oid' }]],
    ]);
    const rows = getPgAttributesForAllTables(tables);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.attname)).toEqual(['id', 'oid']);
  });

  it('skips tables with empty column lists', () => {
    const tables = new Map<string, PragmaTableInfoColumn[]>([
      ['users', [baseColumn]],
      ['empty', []],
    ]);
    const rows = getPgAttributesForAllTables(tables);
    expect(rows).toHaveLength(1);
    expect(rows[0].attname).toBe('id');
  });

  it('assigns distinct per-table OIDs by default', () => {
    const tables = new Map<string, PragmaTableInfoColumn[]>([
      ['users', [baseColumn]],
      ['orders', [baseColumn]],
    ]);
    const rows = getPgAttributesForAllTables(tables);
    expect(rows[0].attrelid).not.toBe(rows[1].attrelid);
  });

  it('applies a tableOid override to every table', () => {
    const tables = new Map<string, PragmaTableInfoColumn[]>([
      ['users', [baseColumn]],
      ['orders', [baseColumn]],
    ]);
    const rows = getPgAttributesForAllTables(tables, { tableOid: 777 });
    expect(rows[0].attrelid).toBe(777);
    expect(rows[1].attrelid).toBe(777);
  });

  it('propagates customTypeMap to all tables', () => {
    const tables = new Map<string, PragmaTableInfoColumn[]>([
      ['users', [baseColumn]],
    ]);
    const rows = getPgAttributesForAllTables(tables, {
      customTypeMap: { INTEGER: { oid: 888, len: 4, byval: true, storage: 'p', align: 'i' } },
    });
    expect(rows[0].atttypid).toBe(888);
  });
});

describe('formatPgAttributeResult', () => {
  it('returns an empty array for empty input', () => {
    expect(formatPgAttributeResult([])).toEqual([]);
  });

  it('formats a row into a flat result object', () => {
    const rows: PgAttributeRow[] = getPgAttributes('users', [baseColumn]);
    const result = formatPgAttributeResult(rows);
    expect(result).toHaveLength(1);
    expect(result[0].attrelid).toBe(rows[0].attrelid);
    expect(result[0].attname).toBe('id');
    expect(result[0].atttypid).toBe(23);
    expect(result[0].attnum).toBe(1);
  });

  it('preserves all 25 attribute columns in order', () => {
    const rows: PgAttributeRow[] = getPgAttributes('users', [baseColumn]);
    const keys = Object.keys(formatPgAttributeResult(rows)[0]);
    expect(keys).toEqual([
      'attrelid', 'attname', 'atttypid', 'attstattarget', 'attlen', 'attnum',
      'attndims', 'attcacheoff', 'atttypmod', 'attbyval', 'attstorage', 'attalign',
      'attnotnull', 'atthasdef', 'atthasmissing', 'attidentity', 'attgenerated',
      'attisdropped', 'attislocal', 'attinhcount', 'attcollation', 'attacl',
      'attoptions', 'attfdwoptions', 'attmissingval',
    ]);
  });
});
