/**
 * ToastCompression — TOAST oversized-attribute compression tests.
 *
 * Covers eligibility detection, compression/decompression marker encoding and
 * decoding (including the raw-marker disambiguation that prevents a leading
 * 0x01 payload byte from being mistaken for the LZ4 marker), small-value
 * passthrough, null/undefined handling, ratio computation, and the
 * Lz4Compressor wrapper both with a real compression implementation injected
 * and in its no-op fallback.
 */
import { describe, it, expect } from 'vitest';
import {
  isToastEligible,
  compressColumn,
  decompressColumn,
  isToastCompressed,
  getCompressionRatio,
  getToastThreshold,
  isLz4Available,
  TOAST_TUPLE_THRESHOLD,
  TOAST_ELIGIBLE_TYPES,
  Lz4Compressor,
} from '../storage/ToastCompression';

describe('ToastCompression', () => {
  describe('eligibility', () => {
    it('accepts eligible types case-insensitively', () => {
      expect(isToastEligible('text')).toBe(true);
      expect(isToastEligible('TEXT')).toBe(true);
      expect(isToastEligible('bytea')).toBe(true);
      expect(isToastEligible('JSON')).toBe(true);
      expect(isToastEligible('jsonb')).toBe(true);
      expect(isToastEligible('varchar')).toBe(true);
    });

    it('strips type modifiers like VARCHAR(255)', () => {
      expect(isToastEligible('VARCHAR(255)')).toBe(true);
      expect(isToastEligible('character varying(50)')).toBe(true);
      expect(isToastEligible('NUMERIC(10,2)')).toBe(false);
      expect(isToastEligible('TEXT(100)')).toBe(true);
    });

    it('rejects non-eligible types', () => {
      expect(isToastEligible('integer')).toBe(false);
      expect(isToastEligible('int4')).toBe(false);
      expect(isToastEligible('boolean')).toBe(false);
      expect(isToastEligible('')).toBe(false);
    });
  });

  describe('compressColumn', () => {
    it('returns an empty buffer for null', () => {
      const r = compressColumn(null, 'TEXT');
      expect(r.compressed).toBe(false);
      expect(r.buffer.length).toBe(0);
    });

    it('returns an empty buffer for undefined', () => {
      const r = compressColumn(undefined, 'TEXT');
      expect(r.compressed).toBe(false);
      expect(r.buffer.length).toBe(0);
    });

    it('converts a string value to a utf8 buffer', () => {
      const r = compressColumn('hello', 'TEXT');
      expect(r.compressed).toBe(false);
      expect(r.buffer.toString('utf8')).toBe('hello');
    });

    it('passes through non-eligible types unchanged', () => {
      const buf = Buffer.from('12345');
      const r = compressColumn(buf, 'INTEGER');
      expect(r.compressed).toBe(false);
      expect(r.buffer.equals(buf)).toBe(true);
    });

    it('passes through small eligible values without a marker', () => {
      const buf = Buffer.alloc(100, 0x41);
      const r = compressColumn(buf, 'TEXT');
      expect(r.compressed).toBe(false);
      expect(r.buffer.equals(buf)).toBe(true);
    });

    it('marks an incompressible large value as raw (0x00) to disambiguate', () => {
      // LZ4 is unavailable in this environment, so the compressor is a no-op:
      // a large value is never smaller, and must carry the raw marker.
      const payload = Buffer.alloc(3000, 0xAB);
      const r = compressColumn(payload, 'TEXT');
      expect(r.compressed).toBe(false);
      expect(r.buffer[0]).toBe(0x00);
      expect(r.buffer.length).toBe(3001); // marker + payload
      const back = decompressColumn(r.buffer);
      expect(back.equals(payload)).toBe(true);
    });

    it('does not lose a leading 0x01 payload byte (raw-marker disambiguation)', () => {
      const payload = Buffer.alloc(3000, 0xAB);
      payload[0] = 0x01;
      const r = compressColumn(payload, 'TEXT');
      expect(r.compressed).toBe(false);
      expect(r.buffer[0]).toBe(0x00);
      const back = decompressColumn(r.buffer);
      expect(back.equals(payload)).toBe(true);
      expect(isToastCompressed(r.buffer)).toBe(false);
    });

    it('compresses (marks LZ4) when a shrinking compressor is injected', () => {
      // Inject a compressor that actually shrinks the payload so the code
      // takes the "compressed" branch and prepends the 0x01 marker.
      const comp = new Lz4Compressor({
        compress: (b: Buffer) => Buffer.from([0x42]), // tiny result
        decompress: (b: Buffer) => Buffer.alloc(3000, 0x41),
      });
      const payload = Buffer.alloc(3000, 0x41);
      const r = compressColumn(payload, 'TEXT', comp);
      expect(r.compressed).toBe(true);
      expect(r.buffer[0]).toBe(0x01);
      expect(r.buffer.length).toBe(2); // marker + 1-byte compressed payload
    });

    it('round-trips a genuinely compressed value end-to-end', () => {
      // Use Node's built-in deflate as a real, reversible compressor so the
      // full mark → shrink → unmark round-trip is exercised with real data.
      const zlib = require('zlib');
      const comp = new Lz4Compressor({
        compress: (b: Buffer) => zlib.deflateSync(b),
        decompress: (b: Buffer) => zlib.inflateSync(b),
      });
      // Highly compressible payload: compresses far below the 2KB threshold.
      const payload = Buffer.from('A'.repeat(3000), 'utf8');
      const r = compressColumn(payload, 'TEXT', comp);
      expect(r.compressed).toBe(true);
      expect(r.buffer[0]).toBe(0x01);
      // decompressColumn with the same compressor reconstructs the payload.
      const back = decompressColumn(r.buffer, comp);
      expect(back.equals(payload)).toBe(true);
      expect(isToastCompressed(r.buffer)).toBe(true);
    });
  });

  describe('decompressColumn', () => {
    it('returns empty for null', () => {
      expect(decompressColumn(null).length).toBe(0);
    });

    it('returns empty for undefined', () => {
      expect(decompressColumn(undefined).length).toBe(0);
    });

    it('returns empty for a zero-length buffer', () => {
      expect(decompressColumn(Buffer.alloc(0)).length).toBe(0);
    });

    it('returns unmarked data as-is', () => {
      const buf = Buffer.from('plain');
      expect(decompressColumn(buf).equals(buf)).toBe(true);
    });

    it('strips the raw marker (0x00) and returns the payload', () => {
      const payload = Buffer.from('raw data');
      const marked = Buffer.concat([Buffer.from([0x00]), payload]);
      expect(decompressColumn(marked).equals(payload)).toBe(true);
    });
  });

  describe('isToastCompressed', () => {
    it('detects only the LZ4 marker', () => {
      expect(isToastCompressed(Buffer.from([0x01, 1]))).toBe(true);
      expect(isToastCompressed(Buffer.from([0x00, 1]))).toBe(false);
      expect(isToastCompressed(Buffer.from([0x02, 1]))).toBe(false);
      expect(isToastCompressed(Buffer.alloc(0))).toBe(false);
    });
  });

  describe('getCompressionRatio', () => {
    it('returns 1.0 for an empty value', () => {
      expect(getCompressionRatio('', 'TEXT')).toBe(1.0);
      expect(getCompressionRatio(Buffer.alloc(0), 'TEXT')).toBe(1.0);
    });

    it('computes a ratio of 1.0 for a small passthrough value', () => {
      expect(getCompressionRatio('hello', 'TEXT')).toBe(1.0);
      expect(getCompressionRatio(Buffer.alloc(10, 0x41), 'TEXT')).toBe(1.0);
    });
  });

  describe('constants', () => {
    it('exposes the threshold and eligible types', () => {
      expect(getToastThreshold()).toBe(2048);
      expect(TOAST_TUPLE_THRESHOLD).toBe(2048);
      expect(TOAST_ELIGIBLE_TYPES.has('TEXT')).toBe(true);
      expect(isLz4Available()).toBe(false); // lz4-asm is not a declared dependency
    });
  });

  describe('Lz4Compressor (injected)', () => {
    it('reports available when an implementation is provided', () => {
      const c = new Lz4Compressor({
        compress: (b) => Buffer.from('X'),
        decompress: (b) => Buffer.from('Y'),
      });
      expect(c.isAvailable()).toBe(true);
    });

    it('compresses via the injected implementation', () => {
      const impl = {
        compress: (b: Buffer) => Buffer.from(`c${b.length}`),
        decompress: (b: Buffer) => Buffer.from(`d${b.length}`),
      };
      const c = new Lz4Compressor(impl);
      // >= 32 bytes passes the minimum-length guard.
      const out = c.compress(Buffer.alloc(64));
      expect(out.toString()).toBe('c64');
    });

    it('passes through inputs shorter than 32 bytes', () => {
      const impl = {
        compress: (b: Buffer) => Buffer.from(`c${b.length}`),
        decompress: (b: Buffer) => Buffer.from(`d${b.length}`),
      };
      const c = new Lz4Compressor(impl);
      const small = Buffer.alloc(10);
      expect(c.compress(small).equals(small)).toBe(true);
    });

    it('decompresses via the injected implementation', () => {
      const impl = {
        compress: (b: Buffer) => Buffer.from('z'),
        decompress: (b: Buffer) => Buffer.from(`d${b.length}`),
      };
      const c = new Lz4Compressor(impl);
      expect(c.decompress(Buffer.alloc(5)).toString()).toBe('d5');
    });

    it('falls back to raw when compress throws', () => {
      const impl = {
        compress: () => { throw new Error('boom'); },
        decompress: (b: Buffer) => b,
      };
      const c = new Lz4Compressor(impl);
      const buf = Buffer.alloc(100, 0x42);
      expect(c.compress(buf).equals(buf)).toBe(true);
    });

    it('falls back to raw when decompress throws', () => {
      const impl = {
        compress: (b: Buffer) => b,
        decompress: () => { throw new Error('boom'); },
      };
      const c = new Lz4Compressor(impl);
      const buf = Buffer.alloc(100, 0x43);
      expect(c.decompress(buf).equals(buf)).toBe(true);
    });
  });

  describe('Lz4Compressor (no impl, unavailable)', () => {
    it('reports unavailable and no-ops when lz4-asm is absent', () => {
      const c = new Lz4Compressor();
      expect(c.isAvailable()).toBe(false);
      const buf = Buffer.alloc(100, 0x44);
      expect(c.compress(buf).equals(buf)).toBe(true);
      expect(c.decompress(buf).equals(buf)).toBe(true);
    });
  });
});
