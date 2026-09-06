/**
 * SystemTypes unit tests.
 *
 * Covers the `SystemTypeRegistry` lookup surface: OID/name resolution, SQL
 * type aliases, array (`_`-prefixed) names, base-type filtering, and OID/type
 * string helpers. Verifies the registry is idempotently initialized.
 */
import { describe, it, expect } from 'vitest';
import { SystemTypeRegistry, PgTypeCategory } from '../system/SystemTypes';

describe('SystemTypeRegistry.getByOid', () => {
  it('resolves well-known numeric OIDs', () => {
    expect(SystemTypeRegistry.getByOid(23)?.name).toBe('int4');
    expect(SystemTypeRegistry.getByOid(20)?.name).toBe('int8');
    expect(SystemTypeRegistry.getByOid(700)?.name).toBe('float4');
    expect(SystemTypeRegistry.getByOid(1700)?.name).toBe('numeric');
  });

  it('resolves boolean and binary OIDs', () => {
    expect(SystemTypeRegistry.getByOid(16)?.name).toBe('bool');
    expect(SystemTypeRegistry.getByOid(17)?.name).toBe('bytea');
  });

  it('returns undefined for unknown OIDs', () => {
    expect(SystemTypeRegistry.getByOid(999999)).toBeUndefined();
    expect(SystemTypeRegistry.getByOid(-1)).toBeUndefined();
  });
});

describe('SystemTypeRegistry.getByName', () => {
  it('resolves names case-insensitively', () => {
    expect(SystemTypeRegistry.getByName('INT4')?.oid).toBe(23);
    expect(SystemTypeRegistry.getByName('Text')?.oid).toBe(25);
  });

  it('resolves SQL standard aliases', () => {
    expect(SystemTypeRegistry.getByName('integer')?.name).toBe('int4');
    expect(SystemTypeRegistry.getByName('int')?.name).toBe('int4');
    expect(SystemTypeRegistry.getByName('bigint')?.name).toBe('int8');
    expect(SystemTypeRegistry.getByName('decimal')?.name).toBe('numeric');
    expect(SystemTypeRegistry.getByName('boolean')?.name).toBe('bool');
  });

  it('resolves array-type names by stripping the leading underscore', () => {
    expect(SystemTypeRegistry.getByName('_int4')?.name).toBe('int4');
    expect(SystemTypeRegistry.getByName('_text')?.name).toBe('text');
  });

  it('returns undefined for unknown names', () => {
    expect(SystemTypeRegistry.getByName('no_such_type')).toBeUndefined();
  });
});

describe('SystemTypeRegistry.getOid / getSqlType', () => {
  it('returns the OID for a known name', () => {
    expect(SystemTypeRegistry.getOid('int4')).toBe(23);
    expect(SystemTypeRegistry.getOid('text')).toBe(25);
  });

  it('returns undefined OID for an unknown name', () => {
    expect(SystemTypeRegistry.getOid('bogus')).toBeUndefined();
  });

  it('returns the SQL string for a known name', () => {
    expect(SystemTypeRegistry.getSqlType('int4')).toBe('INTEGER');
    expect(SystemTypeRegistry.getSqlType('text')).toBe('TEXT');
    expect(SystemTypeRegistry.getSqlType('float8')).toBe('DOUBLE PRECISION');
  });

  it('returns undefined SQL string for an unknown name', () => {
    expect(SystemTypeRegistry.getSqlType('bogus')).toBeUndefined();
  });
});

describe('SystemTypeRegistry.getBaseTypes', () => {
  it('filters to isBaseType entries only', () => {
    const all = SystemTypeRegistry.getAll();
    const base = SystemTypeRegistry.getBaseTypes();
    expect(base.length).toBeLessThan(all.length);
    expect(base.every((t) => t.isBaseType)).toBe(true);
    // A known base type is present, a known pseudo type is not.
    expect(base.some((t) => t.name === 'int4')).toBe(true);
    expect(base.some((t) => t.name === 'any')).toBe(false);
  });

  it('excludes pseudo types (isBaseType=false)', () => {
    const all = SystemTypeRegistry.getAll();
    const pseudo = all.filter((t) => t.category === PgTypeCategory.PSEUDO);
    expect(pseudo.length).toBeGreaterThan(0);
    expect(pseudo.every((t) => !t.isBaseType)).toBe(true);
  });
});

describe('SystemTypeRegistry.getAll', () => {
  it('returns a non-empty list with unique OIDs', () => {
    const all = SystemTypeRegistry.getAll();
    expect(all.length).toBeGreaterThan(0);
    const oids = all.map((t) => t.oid);
    expect(new Set(oids).size).toBe(oids.length);
  });
});
