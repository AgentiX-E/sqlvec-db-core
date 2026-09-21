/**
 * PgTypeRegistry — PostgreSQL type system registry.
 *
 * Tests exercise the OID↔name lookup, type classification, every input/output
 * function (real round-trips), implicit-cast compatibility, and regression
 * coverage for a real defect:
 *   #191 pathOutput dropped the `closed` flag (open/closed paths serialized
 *        identically).
 */
import { describe, it, expect } from 'vitest';
import {
  PgTypeRegistry,
  PgTypeCategory,
  PG_OID,
} from '../query/PgTypeRegistry';

const R = new PgTypeRegistry();

describe('lookup — byOid / byName / allTypes / size', () => {
  it('resolves builtin types by OID', () => {
    expect(R.byOid(PG_OID.INT4)?.name).toBe('int4');
    expect(R.byOid(PG_OID.TEXT)?.name).toBe('text');
    expect(R.byOid(PG_OID.BOOL)?.name).toBe('bool');
    expect(R.byOid(PG_OID.JSONB)?.name).toBe('jsonb');
    expect(R.byOid(PG_OID.TIMESTAMPTZ)?.name).toBe('timestamptz');
  });

  it('resolves builtin types by name', () => {
    expect(R.byName('int4')?.oid).toBe(PG_OID.INT4);
    expect(R.byName('pg_lsn')?.oid).toBe(PG_OID.PG_LSN);
    expect(R.byName('money')?.category).toBe(PgTypeCategory.Numeric);
  });

  it('returns undefined for unknown OID / name', () => {
    expect(R.byOid(999999)).toBeUndefined();
    expect(R.byName('not_a_type')).toBeUndefined();
  });

  it('exposes all types and a consistent size', () => {
    const all = R.allTypes();
    expect(all.length).toBeGreaterThan(40);
    expect(R.size).toBe(all.length);
  });
});

describe('type categories', () => {
  it('assigns correct categories', () => {
    expect(R.byName('int4')?.category).toBe(PgTypeCategory.Numeric);
    expect(R.byName('bool')?.category).toBe(PgTypeCategory.Boolean);
    expect(R.byName('text')?.category).toBe(PgTypeCategory.String);
    expect(R.byName('timestamp')?.category).toBe(PgTypeCategory.DateTime);
    expect(R.byName('bytea')?.category).toBe(PgTypeCategory.Binary);
    expect(R.byName('jsonb')?.category).toBe(PgTypeCategory.JSON);
    expect(R.byName('uuid')?.category).toBe(PgTypeCategory.UUID);
    expect(R.byName('point')?.category).toBe(PgTypeCategory.Geometric);
    expect(R.byName('tsvector')?.category).toBe(PgTypeCategory.TextSearch);
  });
});

describe('compatibility — isCompatible', () => {
  it('always allows same OID', () => {
    expect(R.isCompatible(PG_OID.INT4, PG_OID.INT4)).toBe(true);
  });

  it('allows numeric widening (int2→int4→int8→float8→numeric)', () => {
    expect(R.isCompatible(PG_OID.INT4, PG_OID.INT2)).toBe(true);
    expect(R.isCompatible(PG_OID.INT8, PG_OID.INT4)).toBe(true);
    expect(R.isCompatible(PG_OID.FLOAT8, PG_OID.FLOAT4)).toBe(true);
    expect(R.isCompatible(PG_OID.NUMERIC, PG_OID.FLOAT8)).toBe(true);
  });

  it('rejects numeric narrowing (int4→int2)', () => {
    expect(R.isCompatible(PG_OID.INT2, PG_OID.INT4)).toBe(false);
  });

  it('allows string widening to text', () => {
    expect(R.isCompatible(PG_OID.TEXT, PG_OID.VARCHAR)).toBe(true);
    expect(R.isCompatible(PG_OID.TEXT, PG_OID.BPCHAR)).toBe(true);
    expect(R.isCompatible(PG_OID.TEXT, PG_OID.NAME)).toBe(true);
    expect(R.isCompatible(PG_OID.TEXT, PG_OID.CHAR)).toBe(true);
  });

  it('allows json→jsonb and bit→varbit', () => {
    expect(R.isCompatible(PG_OID.JSONB, PG_OID.JSON)).toBe(true);
    expect(R.isCompatible(PG_OID.VARBIT, PG_OID.BIT)).toBe(true);
  });

  it('rejects unrelated cross-category casts', () => {
    expect(R.isCompatible(PG_OID.INT4, PG_OID.TEXT)).toBe(false);
    expect(R.isCompatible(PG_OID.BOOL, PG_OID.INT4)).toBe(false);
    expect(R.isCompatible(PG_OID.TEXT, PG_OID.BYTEA)).toBe(false);
  });
});

describe('input functions', () => {
  it('parses integers (with int2 range check)', () => {
    expect(R.input('int2', '32767')).toBe(32767);
    expect(R.input('int4', '-456')).toBe(-456);
    expect(R.input('int8', '9007199254740993')).toBe(9007199254740993n);
  });

  it('throws on int2 out-of-range', () => {
    expect(() => R.input('int2', '32768')).toThrow(/out of range/);
    expect(() => R.input('int2', '-32769')).toThrow(/out of range/);
  });

  it('parses floats and numeric', () => {
    expect(R.input('float4', '3.14')).toBeCloseTo(3.14);
    expect(R.input('float8', '-2.5')).toBe(-2.5);
    expect(R.input('numeric', '123.456')).toBe('123.456');
  });

  it('parses booleans from many spellings', () => {
    for (const t of ['t', 'true', 'yes', '1', 'on']) expect(R.input('bool', t)).toBe(true);
    for (const f of ['f', 'false', 'no', '0', 'off']) expect(R.input('bool', f)).toBe(false);
    expect(R.input('bool', ' TRUE ')).toBe(true);
  });

  it('throws on invalid boolean', () => {
    expect(() => R.input('bool', 'maybe')).toThrow(/invalid boolean/);
  });

  it('parses bytea hex (\\x prefix, bare hex, and utf-8 fallback)', () => {
    expect(R.input('bytea', '\\x48656c6c6f').toString('hex')).toBe('48656c6c6f');
    expect(R.input('bytea', '48656c6c6f').toString('hex')).toBe('48656c6c6f');
    expect(R.input('bytea', 'hello').toString()).toBe('hello');
  });

  it('parses char as first character only', () => {
    expect(R.input('char', 'ab')).toBe('a');
    expect(R.input('char', '')).toBe('');
  });

  it('parses timestamps and dates', () => {
    expect(R.input('timestamp', '2023-01-01 12:00:00')).toBeInstanceOf(Date);
    expect(R.input('date', '2023-01-01')).toBeInstanceOf(Date);
    expect(R.input('time', '12:30:45.000')).toBeInstanceOf(Date);
    expect(R.input('timestamptz', '2023-01-01 12:00:00+08:00')).toBeInstanceOf(Date);
  });

  it('throws on invalid date/time', () => {
    expect(() => R.input('timestamp', 'not-a-date')).toThrow(/invalid timestamp/);
    expect(() => R.input('timestamptz', 'garbage')).toThrow(/invalid timestamptz/);
    expect(() => R.input('date', 'nope')).toThrow(/invalid date/);
    expect(() => R.input('time', 'xyz')).toThrow(/invalid time/);
    expect(() => R.input('timetz', '')).toThrow(/invalid timetz/);
  });

  it('validates UUID format', () => {
    expect(R.input('uuid', '123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(R.input('uuid', '123e4567e89b12d3a456426614174000')).toBe('123e4567e89b12d3a456426614174000');
    expect(() => R.input('uuid', 'not-a-uuid')).toThrow(/invalid uuid/);
  });

  it('validates JSON', () => {
    expect(R.input('json', '{"a":1}')).toBe('{"a":1}');
    expect(R.input('jsonb', '[1,2]')).toBe('[1,2]');
    expect(() => R.input('json', '{bad}')).toThrow();
    expect(() => R.input('jsonb', 'nope')).toThrow();
  });

  it('parses pg_lsn hex', () => {
    expect(R.input('pg_lsn', '0/0')).toBe(0n);
    expect(R.input('pg_lsn', '1/0')).toBe(1n << 32n);
    expect(R.input('pg_lsn', '0/16')).toBe(0x16n);
    expect(() => R.input('pg_lsn', 'nope')).toThrow(/invalid pg_lsn/);
  });

  it('parses money', () => {
    expect(R.input('money', '$1,234.50')).toBeCloseTo(1234.5);
    expect(R.input('money', '1234.50')).toBeCloseTo(1234.5);
    expect(() => R.input('money', 'abc')).toThrow(/invalid money/);
  });

  it('parses interval and tid as passthrough strings', () => {
    expect(R.input('interval', '1 day')).toBe('1 day');
    expect(R.input('tid', '(0,1)')).toBe('(0,1)');
  });

  it('parses time and timetz', () => {
    expect(R.input('time', '12:30:45.000')).toBeInstanceOf(Date);
    expect(R.input('timetz', '12:30:45+08:00')).toBeInstanceOf(Date);
  });

  it('parses remaining string-passthrough types', () => {
    expect(R.input('inet', '192.168.1.1')).toBe('192.168.1.1');
    expect(R.input('cidr', '10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(R.input('macaddr', '08:00:2b:01:02:03')).toBe('08:00:2b:01:02:03');
    expect(R.input('macaddr8', '08:00:2b:01:02:03:04:05')).toBe('08:00:2b:01:02:03:04:05');
    expect(R.input('tsvector', 'a:1')).toBe('a:1');
    expect(R.input('tsquery', 'a & b')).toBe('a & b');
    expect(R.input('xml', '<x/>')).toBe('<x/>');
    expect(R.input('bit', '1010')).toBe('1010');
    expect(R.input('varbit', '101')).toBe('101');
    expect(R.input('point', '(1,2)')).toBe('(1,2)');
    expect(R.input('line', '{1,2,3}')).toBe('{1,2,3}');
    expect(R.input('lseg', '[(0,0),(1,1)]')).toBe('[(0,0),(1,1)]');
    expect(R.input('box', '(0,0),(1,1)')).toBe('(0,0),(1,1)');
    expect(R.input('path', '[(0,0)]')).toBe('[(0,0)]');
    expect(R.input('polygon', '((0,0),(1,1))')).toBe('((0,0),(1,1))');
    expect(R.input('circle', '<(0,0),5>')).toBe('<(0,0),5>');
  });

  it('falls back to passthrough for unknown types', () => {
    expect(R.input('no_such_type', 'raw')).toBe('raw');
  });
});

describe('output functions', () => {
  it('outputs integers and floats', () => {
    expect(R.output('int2', 42)).toBe('42');
    expect(R.output('int4', -99)).toBe('-99');
    expect(R.output('int8', 9007199254740993n)).toBe('9007199254740993');
    expect(R.output('int8', 42)).toBe('42');
    expect(R.output('float8', 0.1)).toBe('0.1');
    expect(R.output('numeric', 1.5)).toBe('1.5');
    expect(R.output('numeric', '1.5')).toBe('1.5');
  });

  it('outputs booleans as t/f', () => {
    expect(R.output('bool', true)).toBe('t');
    expect(R.output('bool', false)).toBe('f');
  });

  it('outputs bytea as \\x hex', () => {
    expect(R.output('bytea', Buffer.from('Hello'))).toBe('\\x48656c6c6f');
    expect(R.output('bytea', new Uint8Array([1, 2, 255]))).toBe('\\x0102ff');
  });

  it('outputs dates/times', () => {
    expect(R.output('date', new Date(2023, 0, 1))).toBe('2023-01-01');
    expect(R.output('timestamp', new Date(2023, 0, 1, 12, 0, 0, 0))).toBe('2023-01-01 12:00:00.000');
    expect(R.output('time', new Date(2023, 0, 1, 12, 30, 45, 123))).toBe('12:30:45.123');
  });

  it('outputs timestamptz with timezone offset', () => {
    const d = new Date(2023, 0, 1, 12, 0, 0, 0);
    expect(R.output('timestamptz', d)).toMatch(/^2023-01-01 12:00:00\.000[+-]\d{2}:\d{2}$/);
  });

  it('outputs interval from object or string', () => {
    expect(R.output('interval', '1 day')).toBe('1 day');
    expect(R.output('interval', { months: 3, days: 2 })).toBe('3 mon 2 day');
    expect(R.output('interval', { hours: 1, minutes: 30, seconds: 15 })).toBe('1:30:15');
  });

  it('outputs interval with only some time fields (nullish coalescing)', () => {
    // Exercise the `?? 0` fallback paths for hours/minutes/seconds.
    expect(R.output('interval', { hours: 2 })).toBe('2:0:0');
    expect(R.output('interval', { minutes: 5 })).toBe('0:5:0');
    expect(R.output('interval', { seconds: 7 })).toBe('0:0:7');
  });

  it('outputs JSON (string passthrough or stringify)', () => {
    expect(R.output('json', '{"a":1}')).toBe('{"a":1}');
    expect(R.output('jsonb', { a: 1 })).toBe('{"a":1}');
  });

  it('outputs geometric types', () => {
    expect(R.output('point', { x: 1, y: 2 })).toBe('(1,2)');
    expect(R.output('line', { a: 1, b: 2, c: 3 })).toBe('{1,2,3}');
    expect(R.output('lseg', { x1: 0, y1: 0, x2: 1, y2: 1 })).toBe('[(0,0),(1,1)]');
    expect(R.output('box', { x1: 0, y1: 0, x2: 1, y2: 1 })).toBe('(0,0),(1,1)');
    expect(R.output('polygon', { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBe('((0,0),(1,1))');
    expect(R.output('circle', { x: 0, y: 0, r: 5 })).toBe('<(0,0),5>');
  });

  it('distinguishes open vs closed path (#191)', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(R.output('path', { points: pts, closed: false })).toBe('[(0,0),(1,1)]');
    expect(R.output('path', { points: pts, closed: true })).toBe('((0,0),(1,1))');
  });

  it('outputs pg_lsn in X/Y hex (bigint and number inputs)', () => {
    expect(R.output('pg_lsn', 0n)).toBe('00000000/00000000');
    expect(R.output('pg_lsn', 1n << 32n)).toBe('00000001/00000000');
    expect(R.output('pg_lsn', 0x16n)).toBe('00000000/00000016');
    // number input exercises the `typeof === 'bigint' ? ... : BigInt(value)` branch
    expect(R.output('pg_lsn', 16)).toBe('00000000/00000010');
  });

  it('outputs money with $ and thousands separators', () => {
    expect(R.output('money', 1234.5)).toBe('$1,234.50');
    expect(R.output('money', -9876.543)).toBe('-$9,876.54');
  });

  it('falls back to String() for unknown types', () => {
    expect(R.output('no_such_type', 123)).toBe('123');
    expect(R.output('no_such_type', null)).toBe('');
    expect(R.output('no_such_type', undefined)).toBe('');
  });

  it('outputs oid/xid/cid/tid as strings', () => {
    expect(R.output('oid', 123)).toBe('123');
    expect(R.output('xid', 456)).toBe('456');
    expect(R.output('cid', 789)).toBe('789');
    expect(R.output('tid', '(0,1)')).toBe('(0,1)');
  });

  it('outputs timetz with offset', () => {
    const d = new Date(2023, 0, 1, 12, 30, 45, 123);
    expect(R.output('timetz', d)).toMatch(/^12:30:45\.123[+-]\d{2}:\d{2}$/);
  });

  it('outputs remaining string-passthrough types', () => {
    expect(R.output('inet', '192.168.1.1')).toBe('192.168.1.1');
    expect(R.output('cidr', '10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(R.output('macaddr', '08:00:2b:01:02:03')).toBe('08:00:2b:01:02:03');
    expect(R.output('macaddr8', '08:00:2b:01:02:03:04:05')).toBe('08:00:2b:01:02:03:04:05');
    expect(R.output('tsvector', 'a:1 b:2')).toBe('a:1 b:2');
    expect(R.output('tsquery', 'a & b')).toBe('a & b');
    expect(R.output('xml', '<x/>')).toBe('<x/>');
    expect(R.output('bit', '1010')).toBe('1010');
    expect(R.output('varbit', '101')).toBe('101');
    expect(R.output('char', 'a')).toBe('a');
    expect(R.output('name', 'n')).toBe('n');
  });

  it('outputs json/jsonb by stringifying objects', () => {
    expect(R.output('json', { a: 1 })).toBe('{"a":1}');
    expect(R.output('jsonb', [1, 2])).toBe('[1,2]');
  });

  it('outputs geometric string passthrough', () => {
    expect(R.output('point', '(1,2)')).toBe('(1,2)');
    expect(R.output('line', '{1,2,3}')).toBe('{1,2,3}');
    expect(R.output('lseg', '[(0,0),(1,1)]')).toBe('[(0,0),(1,1)]');
    expect(R.output('box', '(0,0),(1,1)')).toBe('(0,0),(1,1)');
    expect(R.output('path', '[(0,0)]')).toBe('[(0,0)]');
    expect(R.output('polygon', '((0,0),(1,1))')).toBe('((0,0),(1,1))');
    expect(R.output('circle', '<(0,0),5>')).toBe('<(0,0),5>');
  });
});

describe('timezone offset formatting — negative offset', () => {
  it('formats a negative UTC offset with a minus sign (via subprocess TZ)', () => {
    // formatTZ's `-` branch requires a negative local UTC offset. Node caches
    // the timezone at startup, so we spawn a fresh tsx process with TZ set to a
    // negative-offset zone and assert the emitted suffix is `-05:00`.
    const { execSync } = require('child_process') as typeof import('child_process');
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    const scriptPath = path.join(os.tmpdir(), `tz-${process.pid}.ts`);
    const modPath = path.join(process.cwd(), 'src/query/PgTypeRegistry').replace(/\\/g, '/');
    fs.writeFileSync(
      scriptPath,
      `import { defaultTypeRegistry } from '${modPath}';\n` +
        'const d = new Date(2023, 0, 1, 12, 0, 0, 0);\n' +
        "process.stdout.write(defaultTypeRegistry.output('timestamptz', d));\n",
    );
    try {
      const out = execSync(`npx tsx ${scriptPath}`, {
        env: { ...process.env, TZ: 'America/New_York' },
        cwd: process.cwd(),
      }).toString();
      expect(out).toBe('2023-01-01 12:00:00.000-05:00');
    } finally {
      fs.rmSync(scriptPath, { force: true });
    }
  });
});

describe('round-trip integrity', () => {
  const pairs: Array<[string, string]> = [
    ['int2', '100'],
    ['int4', '-456'],
    ['int8', '9007199254740993'],
    ['float4', '3.14'],
    ['float8', '-2.5'],
    ['numeric', '12345.678'],
    ['bool', 't'],
    ['text', 'hello world'],
    ['varchar', 'hi'],
    ['bpchar', 'x'],
    ['name', 'n'],
    ['bytea', '\\x48656c6c6f'],
    ['uuid', '123e4567-e89b-12d3-a456-426614174000'],
    ['json', '{"a":1}'],
    ['jsonb', '[1,2,3]'],
    ['inet', '192.168.1.1'],
    ['cidr', '10.0.0.0/8'],
    ['macaddr', '08:00:2b:01:02:03'],
    ['money', '$1,234.50'],
    ['oid', '123'],
    ['xid', '456'],
    ['cid', '789'],
  ];
  for (const [t, txt] of pairs) {
    it(`${t} round-trips`, () => {
      const v = R.input(t, txt);
      expect(R.output(t, v)).toBe(txt);
    });
  }
});
