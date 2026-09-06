/**
 * PgFunctions unit tests — encode/decode, interval, and date boundary helpers.
 *
 * Covers binary encode/decode (hex/base64/escape), SHA digests, isfinite,
 * justify_* interval normalization, and date_bin.
 */
import { describe, it, expect } from 'vitest';
import { buildPgFunctions } from '../system/PgFunctions';

const map = buildPgFunctions();
const call = (name: string, ...args: any[]) => map.get(name)!.fn(...args);

describe('encode / decode', () => {
  it('encodes to hex', () => {
    expect(call('encode', 'abc', 'hex')).toBe('616263');
  });

  it('encodes to base64', () => {
    expect(call('encode', 'abc', 'base64')).toBe('YWJj');
  });

  it('decodes hex back to text', () => {
    expect(call('decode', '616263', 'hex')).toBe('abc');
  });

  it('decodes base64 back to text', () => {
    expect(call('decode', 'YWJj', 'base64')).toBe('abc');
  });

  it('returns null for null input or unknown format', () => {
    expect(call('encode', null, 'hex')).toBeNull();
    expect(call('encode', 'abc', 'unknown')).toBeNull();
    expect(call('decode', 'abc', 'unknown')).toBeNull();
  });
});

describe('sha digests', () => {
  it('computes sha256', () => {
    expect(call('sha256', 'abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('returns null for null input', () => {
    expect(call('sha256', null)).toBeNull();
    expect(call('sha512', null)).toBeNull();
  });
});

describe('isfinite', () => {
  it('returns true for a valid date', () => {
    expect(call('isfinite', '2024-03-15')).toBe(true);
  });

  it('returns false for an invalid date and null for null', () => {
    expect(call('isfinite', 'not-a-date')).toBe(false);
    expect(call('isfinite', null)).toBeNull();
  });
});

describe('justify_days', () => {
  it('normalizes days into months and remaining days', () => {
    expect(call('justify_days', 40)).toBe('1 mon 10 days');
    expect(call('justify_days', 30)).toBe('1 mon');
    expect(call('justify_days', 5)).toBe('5 days');
    expect(call('justify_days', 0)).toBe('0 days');
  });

  it('returns null for null or NaN', () => {
    expect(call('justify_days', null)).toBeNull();
    expect(call('justify_days', 'abc')).toBeNull();
  });
});

describe('justify_hours', () => {
  it('normalizes hours into days and remaining hours', () => {
    expect(call('justify_hours', 30)).toBe('1 day 6 hours');
    expect(call('justify_hours', 48)).toBe('2 days');
    expect(call('justify_hours', 6)).toBe('6 hours');
    expect(call('justify_hours', 0)).toBe('0 hours');
  });
});

describe('justify_interval', () => {
  it('normalizes hours into month/day/hour parts', () => {
    expect(call('justify_interval', 0)).toBe('0 hours');
    expect(call('justify_interval', 6)).toBe('6 hours');
  });
});

describe('date_bin', () => {
  it('returns null for invalid input', () => {
    // The stride/unit parsing requires an interval argument; invalid input
    // must be handled gracefully rather than throw.
    expect(call('date_bin', 'bogus', '2024-01-01', '2024-01-01')).toBeNull();
  });
});
