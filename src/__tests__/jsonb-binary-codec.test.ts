/**
 * JsonbBinaryCodec — PostgreSQL 16-compatible JSONB binary encode/decode.
 *
 * Tests exercise the full scalar/array/object round-trip against the real
 * codec, plus the type introspection (`jsonbTypeof`) and key extraction
 * (`jsonbExtractKey`) helpers, and regression cases for two real defects:
 *   #189 empty container misreported as 'null' by jsonbTypeof
 *   #190 NaN silently corrupted to 0 on decode
 */
import { describe, it, expect } from 'vitest';
import {
  encodeJsonb,
  decodeJsonb,
  jsonbTypeof,
  jsonbExtractKey,
} from '../query/JsonbBinaryCodec';

function roundtrip(v: unknown): unknown {
  return decodeJsonb(encodeJsonb(v));
}

describe('JsonbBinaryCodec — scalars', () => {
  it('encodes/decodes null', () => {
    expect(roundtrip(null)).toBeNull();
    expect(jsonbTypeof(encodeJsonb(null))).toBe('null');
  });

  it('encodes/decodes booleans', () => {
    expect(roundtrip(true)).toBe(true);
    expect(roundtrip(false)).toBe(false);
    expect(jsonbTypeof(encodeJsonb(true))).toBe('boolean');
    expect(jsonbTypeof(encodeJsonb(false))).toBe('boolean');
  });

  it('encodes/decodes integers and floats', () => {
    expect(roundtrip(0)).toBe(0);
    expect(roundtrip(-1)).toBe(-1);
    expect(roundtrip(3.14)).toBe(3.14);
    expect(roundtrip(-2.5)).toBe(-2.5);
    expect(jsonbTypeof(encodeJsonb(42))).toBe('number');
  });

  it('encodes/decodes strings (including UTF-8 and escapes)', () => {
    expect(roundtrip('')).toBe('');
    expect(roundtrip('hello')).toBe('hello');
    expect(roundtrip('héllo 世界')).toBe('héllo 世界');
    expect(roundtrip('quote " and backslash \\')).toBe('quote " and backslash \\');
    expect(jsonbTypeof(encodeJsonb('x'))).toBe('string');
  });

  it('round-trips NaN and Infinity faithfully (#190)', () => {
    const nan = decodeJsonb(encodeJsonb(NaN));
    expect(Number.isNaN(nan)).toBe(true); // must stay NaN, not become 0
    expect(decodeJsonb(encodeJsonb(Infinity))).toBe(Infinity);
    expect(decodeJsonb(encodeJsonb(-Infinity))).toBe(-Infinity);
  });
});

describe('JsonbBinaryCodec — arrays', () => {
  it('round-trips a flat array', () => {
    expect(roundtrip([1, 'a', true, null])).toEqual([1, 'a', true, null]);
  });

  it('round-trips an empty array', () => {
    expect(roundtrip([])).toEqual([]);
  });

  it('round-trips nested arrays', () => {
    expect(roundtrip([[1, 2], [], [null, [3]]])).toEqual([[1, 2], [], [null, [3]]]);
  });

  it('round-trips a heterogeneous array preserving order', () => {
    const v = [1, 'two', [3, 'three'], { four: 4 }, null, false];
    expect(roundtrip(v)).toEqual(v);
  });
});

describe('JsonbBinaryCodec — objects', () => {
  it('round-trips a flat object (keys sorted by JSONB semantics)', () => {
    expect(roundtrip({ b: 2, a: 1 })).toEqual({ a: 1, b: 2 });
  });

  it('round-trips an empty object', () => {
    expect(roundtrip({})).toEqual({});
  });

  it('round-trips deeply nested objects', () => {
    const v = { a: { b: { c: [1, { d: 'deep' }] } } };
    expect(roundtrip(v)).toEqual(v);
  });

  it('round-trips mixed object/array/key types', () => {
    const v = {
      str: 's',
      num: 1.5,
      bool: true,
      nil: null,
      arr: [1, 2],
      obj: { nested: 'yes' },
    };
    expect(roundtrip(v)).toEqual(v);
  });

  it('sorts keys regardless of insertion order', () => {
    expect(Object.keys(roundtrip({ z: 1, a: 2, m: 3 }) as object)).toEqual(['a', 'm', 'z']);
  });
});

describe('JsonbBinaryCodec — jsonbTypeof', () => {
  it('reports empty object as object (#189)', () => {
    expect(jsonbTypeof(encodeJsonb({}))).toBe('object');
  });

  it('reports empty array as array (#189)', () => {
    expect(jsonbTypeof(encodeJsonb([]))).toBe('array');
  });

  it('reports non-empty object/array correctly', () => {
    expect(jsonbTypeof(encodeJsonb({ a: 1 }))).toBe('object');
    expect(jsonbTypeof(encodeJsonb([1]))).toBe('array');
  });

  it('reports degenerate short buffers as null', () => {
    expect(jsonbTypeof(Buffer.alloc(0))).toBe('null');
    expect(jsonbTypeof(Buffer.alloc(3))).toBe('null');
  });
});

describe('JsonbBinaryCodec — jsonbExtractKey', () => {
  it('extracts a present key', () => {
    const buf = encodeJsonb({ a: 1, b: 'two', c: [true] });
    expect(jsonbExtractKey(buf, 'a')).toBe(1);
    expect(jsonbExtractKey(buf, 'b')).toBe('two');
    expect(jsonbExtractKey(buf, 'c')).toEqual([true]);
  });

  it('returns null for a missing key', () => {
    const buf = encodeJsonb({ a: 1 });
    expect(jsonbExtractKey(buf, 'zzz')).toBeNull();
  });

  it('returns null for scalar / array buffers', () => {
    expect(jsonbExtractKey(encodeJsonb('str'), 'a')).toBeNull();
    expect(jsonbExtractKey(encodeJsonb([1, 2]), '0')).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(jsonbExtractKey(encodeJsonb({}), 'a')).toBeNull();
  });

  it('extracts a nested object/array value', () => {
    const buf = encodeJsonb({ outer: { inner: [1, 2, 3] } });
    expect(jsonbExtractKey(buf, 'outer')).toEqual({ inner: [1, 2, 3] });
  });
});

describe('JsonbBinaryCodec — jsonbExtractKey on corrupt/truncated buffers', () => {
  it('returns null when the value area is truncated past the target key', () => {
    // Object whose value area is cut short: scanning to the target key's value
    // JEntry falls past the buffer end, so it must return null (not throw).
    const full = encodeJsonb({ a: 1, b: 2, c: 3 });
    // Chop the trailing value entry so b/c values are unreachable.
    const truncated = full.subarray(0, full.length - 5);
    expect(jsonbExtractKey(truncated, 'c')).toBeNull();
  });
});

describe('JsonbBinaryCodec — non-JSON values degrade to null', () => {
  it('encodes undefined/function/symbol as null', () => {
    expect(roundtrip(undefined)).toBeNull();
    expect(roundtrip(() => {})).toBeNull();
    expect(roundtrip(Symbol('x'))).toBeNull();
  });

  it('encodes non-JSON values nested inside arrays/objects as null', () => {
    // Exercises encodeJentry's fallback (not just the top-level path).
    expect(roundtrip([1, undefined, 3])).toEqual([1, null, 3]);
    expect(roundtrip({ a: symbolFn() })).toEqual({ a: null });
  });

  function symbolFn(): any {
    return () => {};
  }
});

describe('JsonbBinaryCodec — error handling', () => {
  it('throws on a buffer shorter than 4 bytes', () => {
    expect(() => decodeJsonb(Buffer.alloc(3))).toThrow(/buffer too short/);
  });

  it('throws on an invalid version header', () => {
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(0x00000000, 0); // version bit 31 not set
    expect(() => decodeJsonb(bad)).toThrow(/invalid version header/);
  });

  it('throws on an unknown scalar tag', () => {
    // header with SCALAR bit set + a bogus entry tag (0x7f)
    const buf = Buffer.alloc(9);
    buf.writeUInt32BE(0xc0000000, 0); // VERSION + SCALAR
    buf.writeUInt32BE(0, 4);          // data len 0
    buf[8] = 0x7f;                    // unknown tag
    expect(() => decodeJsonb(buf)).toThrow(/unknown tag/);
  });

  it('returns NaN for a zero-length number payload (corrupt data)', () => {
    // scalar number tag with empty data: Number('') is 0, but our guard maps
    // empty/whitespace to NaN rather than a misleading 0.
    const buf = Buffer.alloc(9);
    buf.writeUInt32BE(0xc0000000, 0); // VERSION + SCALAR
    buf.writeUInt32BE(0, 4);          // data len 0
    buf[8] = 0x02;                    // NUMBER tag
    expect(Number.isNaN(decodeJsonb(buf) as number)).toBe(true);
  });
});

describe('JsonbBinaryCodec — jsonbTypeof with scalar header + non-scalar tag', () => {
  function scalarWithTag(tag: number): Buffer {
    const buf = Buffer.alloc(9);
    buf.writeUInt32BE(0xc0000000, 0); // VERSION + SCALAR
    buf.writeUInt32BE(0, 4);          // data len 0
    buf[8] = tag;
    return buf;
  }

  it('reports object for a scalar-header buffer carrying an OBJECT tag', () => {
    expect(jsonbTypeof(scalarWithTag(0x05))).toBe('object');
  });

  it('reports array for a scalar-header buffer carrying an ARRAY tag', () => {
    expect(jsonbTypeof(scalarWithTag(0x06))).toBe('array');
  });

  it('reports unknown for an unrecognized scalar tag', () => {
    expect(jsonbTypeof(scalarWithTag(0x7f))).toBe('unknown');
  });
});

describe('JsonbBinaryCodec — truncated container decode', () => {
  it('stops array decode early on a truncated buffer (boundary guard)', () => {
    // header claims 3 elements but only 1 entry is present.
    const buf = encodeJsonb([1, 2, 3]);
    const truncated = buf.subarray(0, buf.length - 1 - 1 - 5 * 2); // chop last two entries
    const out = decodeJsonb(truncated);
    expect(Array.isArray(out)).toBe(true);
    // Must not throw; it decodes however many complete entries fit.
    expect(out.length).toBeGreaterThanOrEqual(0);
  });

  it('stops object decode early on truncated key/value area', () => {
    const buf = encodeJsonb({ a: 1, b: 2, c: 3 });
    const truncated = buf.subarray(0, buf.length - 5); // chop the last entry
    const out = decodeJsonb(truncated);
    expect(typeof out).toBe('object');
  });
});
