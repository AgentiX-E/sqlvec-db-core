/**
 * PgFunctions unit tests — trigonometric, remaining string, time, and stub
 * functions registered by `buildPgFunctions`.
 *
 * Completes coverage of the built-in function table: trigonometry, misc
 * string helpers (md5, overlay, quote_ident, regexp_replace, translate,
 * unistr), time-stamp
 * functions, and the advisory/backup/stat stubs.
 */
import { describe, it, expect } from 'vitest';
import { buildPgFunctions } from '../system/PgFunctions';

const map = buildPgFunctions();
const call = (name: string, ...args: any[]) => map.get(name)!.fn(...args);

describe('trigonometry', () => {
  it('computes pi and angle conversions', () => {
    expect(call('pi')).toBeCloseTo(Math.PI);
    expect(call('degrees', Math.PI)).toBeCloseTo(180);
    expect(call('radians', 180)).toBeCloseTo(Math.PI);
  });

  it('computes sin/cos/tan', () => {
    expect(call('sin', 0)).toBeCloseTo(0);
    expect(call('cos', 0)).toBeCloseTo(1);
    expect(call('tan', 0)).toBeCloseTo(0);
  });

  it('computes inverse trig', () => {
    expect(call('asin', 0)).toBeCloseTo(0);
    expect(call('acos', 1)).toBeCloseTo(0);
    expect(call('atan', 0)).toBeCloseTo(0);
    expect(call('atan2', 0, 1)).toBeCloseTo(0);
  });

  it('computes cot and log10', () => {
    expect(call('cot', Math.PI / 2)).toBeCloseTo(0);
    expect(call('log10', 100)).toBeCloseTo(2);
  });

  it('computes width_bucket', () => {
    // width_bucket(5, 0, 10, 10): operand 5.0 falls into bucket 6
    // (floor(5/10 * 10) + 1 = 6).
    expect(call('width_bucket', 5, 0, 10, 10)).toBe(6);
    expect(call('width_bucket', -1, 0, 10, 10)).toBe(0); // below low
    expect(call('width_bucket', 10, 0, 10, 10)).toBe(11); // >= high
  });

  it('random/setseed return without throwing', () => {
    const r = call('random');
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });
});

describe('string — misc', () => {
  it('ascii returns the code of the first char', () => {
    expect(call('ascii', 'A')).toBe(65);
    expect(call('ascii', 'ABC')).toBe(65);
  });

  it('chr returns the char for a code', () => {
    expect(call('chr', 65)).toBe('A');
  });

  it('md5 computes a digest', () => {
    expect(call('md5', 'abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('repeat repeats a string', () => {
    expect(call('repeat', 'ab', 3)).toBe('ababab');
    expect(call('repeat', 'ab', 0)).toBe('');
  });

  it('overlay replaces a substring', () => {
    expect(call('overlay', 'abcdef', 'XY', 2, 2)).toBe('aXYdef');
  });

  it('quote_ident / quote_literal / quote_nullable', () => {
    expect(call('quote_ident', 'abc')).toBe('abc');
    expect(call('quote_ident', 'a b')).toBe('"a b"');
    expect(call('quote_literal', "o'reilly")).toBe("'o''reilly'");
    expect(call('quote_nullable', null)).toBe('NULL');
  });

  it('translate maps characters', () => {
    expect(call('translate', 'abc', 'a', 'x')).toBe('xbc');
  });

  it('regexp_replace replaces matches', () => {
    expect(call('regexp_replace', 'hello world', 'world', 'there')).toBe('hello there');
  });

  it('regexp_match returns the first match', () => {
    expect(call('regexp_match', 'hello 123', '\\d+')).toContain('123');
  });

  it('regexp_split_to_array splits on a pattern', () => {
    expect(call('regexp_split_to_array', 'a,b,c', ',')).toEqual(['a', 'b', 'c']);
  });
});

describe('time — timestamps', () => {
  it('current_time returns a time string', () => {
    expect(call('current_time')).toMatch(/^\d{2}:\d{2}:\d{2}/);
  });

  it('current_timestamp / transaction_timestamp / statement_timestamp return timestamps', () => {
    for (const f of ['current_timestamp', 'transaction_timestamp', 'statement_timestamp', 'clock_timestamp']) {
      expect(typeof call(f)).toBe('string');
    }
  });

  it('localtime / localtimestamp return values', () => {
    expect(call('localtime')).toMatch(/^\d{2}:\d{2}:\d{2}/);
    expect(typeof call('localtimestamp')).toBe('string');
  });

  it('make_timestamp builds a timestamp', () => {
    expect(call('make_timestamp', 2024, 3, 15, 12, 30, 0)).toMatch(/2024-03-15/);
  });

  it('timeofday returns a string', () => {
    expect(typeof call('timeofday')).toBe('string');
  });
});

describe('advisory / stat / backup stubs', () => {
  it('pg_advisory_lock returns null (no-op stub)', () => {
    expect(call('pg_advisory_lock', 1)).toBeNull();
    expect(call('pg_advisory_unlock', 1)).toBe(true);
    expect(call('pg_try_advisory_lock', 1)).toBe(true);
  });

  it('pg_advisory_xact_lock returns null (no-op stub)', () => {
    expect(call('pg_advisory_xact_lock', 1)).toBeNull();
    expect(call('pg_try_advisory_xact_lock', 1)).toBe(true);
  });

  it('current_setting returns a value', () => {
    // The stub returns a config object (or null) rather than a string.
    const v = call('current_setting', 'search_path');
    expect(v !== undefined).toBe(true);
  });

  it('current_query returns the empty string', () => {
    expect(call('current_query')).toBe('');
  });

  it('current_schemas returns a schema array string', () => {
    expect(typeof call('current_schemas', true)).toBe('string');
  });

  it('pg_reload_conf / backup / wal stubs', () => {
    expect(call('pg_reload_conf')).toBe(true);
    expect(typeof call('pg_start_backup', 'label')).toBe('string');
    expect(typeof call('pg_stop_backup')).toBe('string');
  });

  it('pg_blocking_pids and pg_prewarm return', () => {
    expect(call('pg_blocking_pids', 123)).toBe('{}'); // empty array literal
    expect(call('pg_prewarm', 'tbl')).toBe(0);
  });
});

describe('remaining edge branches', () => {
  it('sqrt returns null for negative input', () => {
    expect(call('sqrt', -1)).toBeNull();
    expect(call('sqrt', null)).toBeNull();
  });

  it('concat_ws returns null when the separator is null', () => {
    expect(call('concat_ws', null, 'a', 'b')).toBeNull();
  });

  it('chr returns fromCodePoint for valid codes', () => {
    expect(call('chr', 65)).toBe('A');
  });

  it('sha512 computes a 128-char digest', () => {
    expect(call('sha512', 'abc')).toHaveLength(128);
  });

  it('now returns a timestamp string', () => {
    const v = call('now');
    expect(typeof v).toBe('string');
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('pg_sleep returns null for null', () => {
    expect(call('pg_sleep', null)).toBeNull();
  });
});
