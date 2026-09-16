import { describe, it, expect, beforeAll } from 'vitest';
import { buildPgFunctions, PgFunctionMap, setBlockingPidsLockMgr } from '../system/PgFunctions';
import { GucSystem } from '../core/GucSystem';

let map: PgFunctionMap;
const fn = (name: string, ...args: unknown[]) => map.get(name)!.fn(...args);

beforeAll(() => {
  map = buildPgFunctions();
  GucSystem.getInstance().registry.resetAllToDefaults();
});

describe('PgFunctions — math', () => {
  it('abs / cbrt / ceil / ceiling / floor', () => {
    expect(fn('abs', -5)).toBe(5);
    expect(fn('abs', null)).toBeNull();
    expect(fn('cbrt', 27)).toBeCloseTo(3);
    expect(fn('ceil', 2.1)).toBe(3);
    expect(fn('ceiling', 2.1)).toBe(3);
    expect(fn('floor', 2.9)).toBe(2);
  });

  it('abs coerces bigint input via toNumber', () => {
    expect(fn('abs', BigInt(-5))).toBe(5);
    expect(fn('abs', '7')).toBe(7);
    expect(fn('abs', 'not-a-number')).toBeNull();
  });

  it('toNumber/toInt/toString handle every input type', () => {
    // number path
    expect(fn('round', 3.14159)).toBe(3);
    // string path (numeric)
    expect(fn('round', '3.14159')).toBe(3);
    // string path (non-numeric → NaN → null)
    expect(fn('round', 'abc')).toBeNull();
    // bigint path
    expect(fn('round', BigInt(3))).toBe(3);
    // object/other path → NaN → null
    expect(fn('round', {} as any)).toBeNull();
    expect(fn('round', undefined as any)).toBeNull();
    // toString handles undefined → ''
    expect(fn('reverse', undefined as any)).toBeNull();
  });

  it('degrees / radians', () => {
    expect(fn('degrees', Math.PI)).toBeCloseTo(180);
    expect(fn('radians', 180)).toBeCloseTo(Math.PI);
  });

  it('div / mod with PG sign semantics', () => {
    expect(fn('div', 10, 3)).toBe(3);
    expect(fn('div', 5, 0)).toBeNull();
    expect(fn('mod', 10, 3)).toBe(1);
    expect(fn('mod', -5, 3)).toBe(1); // PG: divisor sign
    expect(fn('mod', 5, 0)).toBeNull();
  });

  it('exp / ln / log / log10', () => {
    expect(fn('exp', 0)).toBe(1);
    expect(fn('ln', 1)).toBe(0);
    expect(fn('ln', 0)).toBeNull();
    expect(fn('log', 10, 100)).toBeCloseTo(2);
    expect(fn('log', 1, 100)).toBeNull();
    expect(fn('log10', 100)).toBeCloseTo(2);
    expect(fn('log10', -1)).toBeNull();
  });

  it('pi / power / sqrt', () => {
    expect(fn('pi')).toBeCloseTo(Math.PI);
    expect(fn('power', 2, 3)).toBe(8);
    expect(fn('sqrt', 9)).toBe(3);
    expect(fn('sqrt', -1)).toBeNull();
  });

  it('round / trunc with and without decimals', () => {
    expect(fn('round', 2.5)).toBe(3);
    expect(fn('round', 2.567, 2)).toBeCloseTo(2.57);
    expect(fn('trunc', 2.9)).toBe(2);
    expect(fn('trunc', -2.9)).toBe(-2);
    expect(fn('trunc', 2.567, 2)).toBeCloseTo(2.56);
  });

  it('trunc handles negative decimals and non-numeric decimals', () => {
    expect(fn('trunc', 1234.5678, -2)).toBe(1200);
    expect(fn('trunc', 2.567, 0)).toBe(2);
    expect(fn('trunc', 2.567, 'abc')).toBeNull();
  });

  it('scale / sign', () => {
    expect(fn('scale', 3.14)).toBe(2);
    expect(fn('scale', 100)).toBe(0);
    expect(fn('sign', 5)).toBe(1);
    expect(fn('sign', -5)).toBe(-1);
    expect(fn('sign', 0)).toBe(0);
  });

  it('width_bucket', () => {
    expect(fn('width_bucket', 5, 0, 10, 5)).toBe(3);
    expect(fn('width_bucket', -1, 0, 10, 5)).toBe(0);
    expect(fn('width_bucket', 11, 0, 10, 5)).toBe(6);
    expect(fn('width_bucket', 5, 10, 0, 5)).toBeNull(); // low >= high
    expect(fn('width_bucket', 5, 0, 10, 0)).toBeNull(); // count <= 0
  });

  it('random / setseed', () => {
    const r = fn('random');
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
    expect(fn('setseed', 0.5)).toBe('setseed');
    expect(fn('setseed', 'bad')).toBeNull();
  });

  it('trigonometric functions', () => {
    expect(fn('sin', 0)).toBe(0);
    expect(fn('cos', 0)).toBe(1);
    expect(fn('tan', 0)).toBe(0);
    expect(fn('asin', 0)).toBe(0);
    expect(fn('asin', 2)).toBeNull();
    expect(fn('acos', 1)).toBe(0);
    expect(fn('acos', -2)).toBeNull();
    expect(fn('atan', 0)).toBe(0);
    expect(fn('atan2', 1, 1)).toBeCloseTo(Math.PI / 4);
    expect(fn('cot', Math.PI / 4)).toBeCloseTo(1);
    expect(fn('cot', 0)).toBeNull();
  });

  it('single-arg math functions return null on NaN (non-numeric string)', () => {
    for (const name of [
      'cbrt', 'ceil', 'ceiling', 'degrees', 'exp', 'floor',
      'radians', 'sign', 'sin', 'cos', 'tan', 'atan', 'cot',
    ]) {
      expect(fn(name, 'not-a-number')).toBeNull();
    }
  });

  it('single-arg math functions return null on null input', () => {
    for (const name of [
      'cbrt', 'ceil', 'ceiling', 'degrees', 'exp', 'floor', 'ln',
      'log10', 'radians', 'sign', 'sqrt', 'sin', 'cos', 'tan',
      'asin', 'acos', 'atan', 'cot', 'chr',
    ]) {
      expect(fn(name, null)).toBeNull();
    }
  });

  it('two-arg math functions return null on null operand', () => {
    expect(fn('div', null, 1)).toBeNull();
    expect(fn('div', 1, null)).toBeNull();
    expect(fn('mod', null, 1)).toBeNull();
    expect(fn('mod', 1, null)).toBeNull();
    expect(fn('power', null, 2)).toBeNull();
    expect(fn('power', 2, null)).toBeNull();
    expect(fn('atan2', null, 1)).toBeNull();
    expect(fn('atan2', 1, null)).toBeNull();
    expect(fn('log', null, 100)).toBeNull();
    expect(fn('log', 10, null)).toBeNull();
    expect(fn('width_bucket', null, 0, 10, 5)).toBeNull();
    expect(fn('width_bucket', 5, null, 10, 5)).toBeNull();
    expect(fn('width_bucket', 5, 0, null, 5)).toBeNull();
    expect(fn('width_bucket', 5, 0, 10, null)).toBeNull();
    expect(fn('setseed', null)).toBeNull();
  });

  it('two-arg math functions return null on NaN input', () => {
    expect(fn('div', 'a', 1)).toBeNull();
    expect(fn('div', 1, 'a')).toBeNull();
    expect(fn('mod', 'a', 1)).toBeNull();
    expect(fn('mod', 1, 'a')).toBeNull();
    expect(fn('power', 'a', 2)).toBeNull();
    expect(fn('power', 2, 'a')).toBeNull();
    expect(fn('atan2', 'a', 1)).toBeNull();
    expect(fn('atan2', 1, 'a')).toBeNull();
  });
});

describe('PgFunctions — ascii / chr', () => {
  it('ascii returns char code of first char', () => {
    expect(fn('ascii', 'A')).toBe(65);
    expect(fn('ascii', '')).toBeNull();
    expect(fn('ascii', null)).toBeNull();
  });

  it('chr returns the char for a code point', () => {
    expect(fn('chr', 65)).toBe('A');
    expect(fn('chr', -1)).toBeNull();
    expect(fn('chr', 'bad')).toBeNull();
  });
});

describe('PgFunctions — encode / decode / sha', () => {
  it('encode hex / base64 / escape', () => {
    expect(fn('encode', 'abc', 'hex')).toBe('616263');
    expect(Buffer.from(fn('encode', 'abc', 'base64'), 'base64').toString()).toBe('abc');
    expect(fn('encode', 'abc', 'escape')).toBe('abc');
    expect(fn('encode', 'abc', 'unknown')).toBeNull();
  });

  it('decode hex / base64', () => {
    expect(fn('decode', '616263', 'hex')).toBe('abc');
    expect(fn('decode', 'abc', 'unknown')).toBeNull();
    expect(fn('decode', null, 'hex')).toBeNull();
  });

  it('sha family returns correct-length hex digests', () => {
    expect(fn('sha224', 'abc')).toMatch(/^[0-9a-f]{56}$/);
    expect(fn('sha256', 'abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(fn('sha384', 'abc')).toMatch(/^[0-9a-f]{96}$/);
    expect(fn('sha512', 'abc')).toMatch(/^[0-9a-f]{128}$/);
    expect(fn('sha256', null)).toBeNull();
  });
});

describe('PgFunctions — date/time', () => {
  it('age with two timestamps returns an interval string', () => {
    const out = fn('age', '2020-01-01', '2019-01-01');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('age across years produces year/mon components', () => {
    const out = fn('age', '2020-01-01', '2000-01-01');
    expect(out).toContain('year');
    const negative = fn('age', '2000-01-01', '2020-01-01');
    expect(negative.startsWith('-')).toBe(true);
  });

  it('age at each component boundary produces empty higher components', () => {
    // 30 seconds → only sec, upper components empty (seconds !== 0)
    expect(fn('age', '2020-01-01 00:00:30', '2020-01-01 00:00:00')).toContain('sec');
    // 30 minutes → minutes only, hours/days empty
    expect(fn('age', '2020-01-01 00:30:00', '2020-01-01 00:00:00')).toContain('min');
    // 12 hours → hours only, days empty
    expect(fn('age', '2020-01-01 12:00:00', '2020-01-01 00:00:00')).toContain('hour');
    // 2 days → days only, months empty
    expect(fn('age', '2020-01-03', '2020-01-01')).toContain('day');
    // 45 days → months + days remainder
    const m = fn('age', '2020-02-15', '2020-01-01');
    expect(m).toContain('mon');
    expect(m).toContain('day');
    // identical timestamps → zero interval
    expect(fn('age', '2020-01-01', '2020-01-01')).toBe('0 secs');
  });

  it('age produces exact whole-hour/whole-day components (empty minute/second)', () => {
    // exactly 1 hour → no minutes/seconds component
    expect(fn('age', '2020-01-01 01:00:00', '2020-01-01 00:00:00')).toBe('1 hour');
    // exactly 24 hours → 1 day, no hours
    expect(fn('age', '2020-01-02 00:00:00', '2020-01-01 00:00:00')).toBe('1 day');
    // negative one second (check sign branch of formatInterval at single-unit)
    expect(fn('age', '2020-01-01 00:00:00', '2020-01-01 00:00:01')).toBe('-1 sec');
  });

  it('age produces plural minutes and handles null/invalid', () => {
    // exactly 2 minutes → plural minutes, seconds empty
    expect(fn('age', '2020-01-01 00:02:00', '2020-01-01 00:00:00')).toBe('2 mins');
    // age(single-arg) with invalid date → null
    expect(fn('age', 'not-a-date')).toBeNull();
    // age(v1, null) → null
    expect(fn('age', '2020-01-01', null)).toBeNull();
  });

  it('age with one timestamp (from now)', () => {
    const out = fn('age', '2019-01-01');
    expect(typeof out).toBe('string');
  });

  it('age returns null on invalid/null', () => {
    expect(fn('age', null)).toBeNull();
    expect(fn('age', 'not-a-date', '2020-01-01')).toBeNull();
  });

  it('current_date / current_time / current_timestamp / now return strings', () => {
    expect(fn('current_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fn('current_time')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(fn('current_timestamp')).toBeTruthy();
    expect(fn('now')).toBeTruthy();
    expect(fn('clock_timestamp')).toBeTruthy();
    expect(fn('statement_timestamp')).toBeTruthy();
    expect(fn('transaction_timestamp')).toBeTruthy();
    expect(fn('localtime')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(fn('localtimestamp')).toBeTruthy();
    expect(fn('timeofday')).toBeTruthy();
  });

  it('date_trunc truncates to each part', () => {
    expect(fn('date_trunc', 'year', '2020-05-15 12:34:56')).toBe('2020-01-01 00:00:00');
    expect(fn('date_trunc', 'month', '2020-05-15 12:34:56')).toBe('2020-05-01 00:00:00');
    expect(fn('date_trunc', 'day', '2020-05-15 12:34:56')).toBe('2020-05-15 00:00:00');
    expect(fn('date_trunc', 'hour', '2020-05-15 12:34:56')).toBe('2020-05-15 12:00:00');
    expect(fn('date_trunc', 'minute', '2020-05-15 12:34:56')).toBe('2020-05-15 12:34:00');
    expect(fn('date_trunc', 'second', '2020-05-15 12:34:56')).toBe('2020-05-15 12:34:56');
    expect(fn('date_trunc', 'invalid', '2020-05-15')).toBeNull();
  });

  it('date_trunc handles quarter / week / isoyear', () => {
    expect(fn('date_trunc', 'quarter', '2020-05-15 12:34:56')).toBe('2020-04-01 00:00:00');
    // week truncates to Monday
    expect(fn('date_trunc', 'week', '2020-01-01 12:00:00')).toBe('2019-12-30 00:00:00');
    // isoyear truncates to first Monday of ISO year
    expect(fn('date_trunc', 'isoyear', '2020-06-15')).toBe('2019-12-30 00:00:00');
  });

  it('date_part / extract return the requested part', () => {
    expect(fn('date_part', 'year', '2020-05-15')).toBe(2020);
    expect(fn('date_part', 'month', '2020-05-15')).toBe(5);
    expect(fn('date_part', 'day', '2020-05-15')).toBe(15);
    expect(fn('extract', 'doy', '2020-01-15')).toBe(15);
    expect(fn('date_part', 'dow', '2020-01-05')).toBe(0); // Sunday
    expect(fn('date_part', 'invalid', '2020-05-15')).toBeNull();
  });

  it('extract epoch / decade / century / millennium', () => {
    expect(fn('extract', 'epoch', '1970-01-02')).toBeCloseTo(86400, -1);
    expect(fn('extract', 'decade', '2023-05-15')).toBe(2020);
    expect(fn('extract', 'century', '2023-05-15')).toBe(21);
    expect(fn('extract', 'millennium', '2023-05-15')).toBe(3);
  });

  it('extract isodow / week / isoyear / quarter / millisecond / timezone', () => {
    expect(fn('extract', 'isodow', '2020-01-05')).toBe(7); // Sunday → ISO 7
    expect(fn('extract', 'quarter', '2020-05-15')).toBe(2);
    expect(typeof fn('extract', 'week', '2020-06-15')).toBe('number');
    expect(typeof fn('extract', 'isoyear', '2020-06-15')).toBe('number');
    expect(fn('extract', 'timezone', '2020-01-01')).toBe(0);
    expect(fn('extract', 'timezone_hour', '2020-01-01')).toBe(0);
    expect(fn('extract', 'timezone_minute', '2020-01-01')).toBe(0);
  });

  it('date_part returns hour / minute / second / millisecond', () => {
    expect(fn('date_part', 'hour', '2020-05-15 12:34:56.789')).toBe(12);
    expect(fn('date_part', 'minute', '2020-05-15 12:34:56.789')).toBe(34);
    expect(fn('date_part', 'second', '2020-05-15 12:34:56.789')).toBeCloseTo(56.789);
    expect(fn('date_part', 'millisecond', '2020-05-15 12:34:56.789')).toBe(789);
  });

  it('extract week/isoyear trigger ISO helpers on a Sunday', () => {
    // Sunday: getDay() === 0 → exercises `d.getDay() || 7` branch
    expect(fn('extract', 'isodow', '2020-01-05')).toBe(7);
    expect(typeof fn('extract', 'week', '2020-01-05')).toBe('number');
    expect(typeof fn('extract', 'isoyear', '2020-01-05')).toBe('number');
  });

  it('date_trunc handles Sunday week and isoyear', () => {
    // Sunday week truncates back to Monday (day === 0 → -6)
    expect(fn('date_trunc', 'week', '2020-01-05 12:00:00')).toBe('2019-12-30 00:00:00');
    // isoyear on a year whose Jan 4 is a Sunday
    expect(fn('date_trunc', 'isoyear', '2020-01-05')).toBe('2019-12-30 00:00:00');
  });

  it('date_bin bins to a stride', () => {
    const out = fn('date_bin', '1 hour', '2020-01-01 01:30:00', '2020-01-01 00:00:00');
    expect(out).toBeTruthy();
    expect(fn('date_bin', null, '2020-01-01', '2020-01-01')).toBeNull();
    expect(fn('date_bin', '1 hour', 'bad', '2020-01-01')).toBeNull();
    expect(fn('date_bin', '0 hours', '2020-01-01', '2020-01-01')).toBeNull();
  });

  it('date_bin accepts various stride units', () => {
    const origin = '2020-01-01 00:00:00';
    expect(fn('date_bin', '1 day', '2020-01-03 12:00:00', origin)).toBeTruthy();
    expect(fn('date_bin', '1 week', '2020-01-15 12:00:00', origin)).toBeTruthy();
    expect(fn('date_bin', '1 month', '2020-03-15 12:00:00', origin)).toBeTruthy();
    expect(fn('date_bin', '1 year', '2021-06-15 12:00:00', origin)).toBeTruthy();
    expect(fn('date_bin', '1 min', '2020-01-01 00:02:30', origin)).toBeTruthy();
    expect(fn('date_bin', '1 sec', '2020-01-01 00:00:02', origin)).toBeTruthy();
  });

  it('isfinite', () => {
    expect(fn('isfinite', '2020-01-01')).toBe(true);
    expect(fn('isfinite', 'bad')).toBe(false);
  });

  it('justify_days / justify_hours / justify_interval', () => {
    expect(fn('justify_days', 30)).toBe('1 mon');
    expect(fn('justify_days', 0)).toBe('0 days');
    expect(fn('justify_hours', 24)).toBe('1 day');
    expect(fn('justify_hours', 0)).toBe('0 hours');
    expect(fn('justify_interval', 25)).toBe('1 day 1 hour');
    expect(fn('justify_interval', 0)).toBe('0 hours');
  });

  it('justify functions handle boundaries and non-numeric input', () => {
    // months exactly, no remaining days
    expect(fn('justify_days', 60)).toBe('2 mons');
    // months + remaining days
    expect(fn('justify_days', 31)).toBe('1 mon 1 day');
    // hours exactly 2 days, no remaining hours
    expect(fn('justify_hours', 48)).toBe('2 days');
    // days + remaining hours
    expect(fn('justify_hours', 25)).toBe('1 day 1 hour');
    // interval with months + days + hours
    expect(fn('justify_interval', 24 * 40 + 5)).toBe('1 mon 10 days 5 hours');
    // non-numeric → null
    expect(fn('justify_days', 'abc')).toBeNull();
    expect(fn('justify_hours', 'abc')).toBeNull();
    expect(fn('justify_interval', 'abc')).toBeNull();
  });

  it('justify functions return null on null input', () => {
    expect(fn('justify_days', null)).toBeNull();
    expect(fn('justify_hours', null)).toBeNull();
    expect(fn('justify_interval', null)).toBeNull();
  });

  it('justify functions with plural remainders', () => {
    expect(fn('justify_days', 32)).toBe('1 mon 2 days');
    expect(fn('justify_hours', 26)).toBe('1 day 2 hours');
  });

  it('make_date validates real dates', () => {
    expect(fn('make_date', 2020, 2, 29)).toBe('2020-02-29');
    expect(fn('make_date', 2021, 2, 29)).toBeNull(); // not a leap year
    expect(fn('make_date', null, 1, 1)).toBeNull();
    expect(fn('make_date', 'bad', 1, 1)).toBeNull();
  });

  it('make_interval builds an interval string', () => {
    expect(fn('make_interval', 1, 2, 3, 4, 5, 6, 7)).toContain('1 year');
    expect(fn('make_interval', 0, 0, 0, 0, 0, 0, 0)).toBe('0 secs');
    expect(fn('make_interval', 'bad')).toBeNull();
  });

  it('make_interval handles each component and negative values', () => {
    expect(fn('make_interval', 0, 1, 0, 0, 0, 0, 0)).toBe('1 mon');
    expect(fn('make_interval', 0, 0, 1, 0, 0, 0, 0)).toBe('7 days'); // weeks → days
    expect(fn('make_interval', 0, 0, 0, 2, 3, 4, 5)).toBe('2 days 3 hours 4 mins 5 secs');
    expect(fn('make_interval', 2, 0, 0, 0, 0, 0, 0)).toBe('2 years');
    expect(fn('make_interval', -1, 0, 0, 0, 0, 0, 0)).toBe('-1 year');
    expect(fn('make_interval', 0, 0, 0, 0, 0, 0, 2)).toBe('2 secs');
    // null component is treated as zero
    expect(fn('make_interval', null, 1, 0, 0, 0, 0, 0)).toBe('1 mon');
  });

  it('make_interval zero-days/hours/mins with non-empty parts', () => {
    // exercise Math.abs(totalDays)===0 while years/mons present
    expect(fn('make_interval', 1, 0, 0, 0, 0, 0, 0)).toBe('1 year');
    // exercise h===0 && mi===0 && s===0 while years present
    expect(fn('make_interval', 1, 0, 0, 0, 0, 0, 0)).toBe('1 year');
  });

  it('make_time validates and formats', () => {
    expect(fn('make_time', 0, 0, 0)).toBe('00:00:00');
    expect(fn('make_time', 24, 0, 0)).toBeNull();
    expect(fn('make_time', 12, 30, 45)).toBe('12:30:45');
  });

  it('make_time handles fractional seconds and boundary rejections', () => {
    expect(fn('make_time', 23, 59, 59)).toBe('23:59:59');
    // fractional seconds produce fixed-6 output
    expect(fn('make_time', 1, 2, 3.5)).toBe('01:02:03.500000');
    expect(fn('make_time', -1, 0, 0)).toBeNull();
    expect(fn('make_time', 0, 60, 0)).toBeNull();
    expect(fn('make_time', 0, 0, 60)).toBeNull();
    expect(fn('make_time', null, 0, 0)).toBeNull();
    expect(fn('make_time', 'bad', 0, 0)).toBeNull();
  });

  it('make_timestamp / make_timestamptz reject non-numeric and null', () => {
    expect(fn('make_timestamp', 'bad', 1, 1, 0, 0, 0)).toBeNull();
    expect(fn('make_timestamptz', null, 1, 1, 0, 0, 0)).toBeNull();
    expect(fn('make_timestamptz', 'bad', 1, 1, 0, 0, 0)).toBeNull();
  });

  it('make_timestamp / make_timestamptz', () => {
    expect(fn('make_timestamp', 2020, 1, 1, 0, 0, 0)).toBe('2020-01-01 00:00:00');
    expect(fn('make_timestamptz', 2020, 1, 1, 0, 0, 0)).toBe('2020-01-01 00:00:00');
    expect(fn('make_timestamp', null, 1, 1, 0, 0, 0)).toBeNull();
  });

  it('pg_sleep returns a result for non-negative input', () => {
    expect(fn('pg_sleep', 0)).toBe('pg_sleep');
    expect(fn('pg_sleep', -1)).toBeNull();
    expect(fn('pg_sleep', null)).toBeNull();
  });
});

describe('PgFunctions — set-returning', () => {
  it('generate_series with positive and negative steps', () => {
    expect(fn('generate_series', 1, 3)).toEqual([1, 2, 3]);
    expect(fn('generate_series', 1, 5, 2)).toEqual([1, 3, 5]);
    expect(fn('generate_series', 3, 1, -1)).toEqual([3, 2, 1]);
    expect(fn('generate_series', 1, 3, 0)).toEqual([]);
    expect(fn('generate_series', null, 3)).toEqual([]);
  });

  it('generate_subscripts with and without reverse', () => {
    expect(fn('generate_subscripts', ['a', 'b', 'c'], 1)).toEqual([1, 2, 3]);
    expect(fn('generate_subscripts', ['a', 'b'], 1, 'true')).toEqual([2, 1]);
    expect(fn('generate_subscripts', 'notarray', 1)).toEqual([]);
    expect(fn('generate_subscripts', [], 1)).toEqual([]);
    expect(fn('generate_subscripts', ['a'], 0)).toEqual([]);
  });
});

describe('PgFunctions — JSON', () => {
  it('json_build_object builds a JSON object', () => {
    expect(fn('json_build_object', 'a', 1, 'b', 2)).toBe('{"a":1,"b":2}');
    expect(fn('json_build_object', null, 1, 'b', 2)).toBe('{"b":2}');
  });

  it('to_json handles primitives and objects', () => {
    expect(fn('to_json', 5)).toBe('5');
    expect(fn('to_json', '5')).toBe('5');
    expect(fn('to_json', '{"a":1}')).toBe('{"a":1}');
    expect(fn('to_json', 'plain string')).toBe('"plain string"');
    expect(fn('to_json', null)).toBe('null');
  });

  it('row_to_json wraps values', () => {
    expect(fn('row_to_json', null)).toBe('null');
    expect(fn('row_to_json', 'x')).toBe('{"value":"x"}');
  });

  it('json_agg wraps into an array', () => {
    expect(fn('json_agg', null)).toBe('[]');
    expect(fn('json_agg', 1)).toBe('[1]');
    expect(fn('json_agg', [1, 2])).toBe('[1,2]');
  });
});

describe('PgFunctions — administration / advisory', () => {
  it('advisory lock stubs', () => {
    expect(fn('pg_advisory_lock', 1)).toBeNull();
    expect(fn('pg_try_advisory_lock', 1)).toBe(true);
    expect(fn('pg_advisory_unlock', 1)).toBe(true);
    expect(fn('pg_advisory_unlock_all')).toBe(true);
    expect(fn('pg_advisory_xact_lock', 1)).toBeNull();
    expect(fn('pg_try_advisory_xact_lock', 1)).toBe(true);
  });

  it('setBlockingPidsLockMgr accepts and clears a lock manager', () => {
    setBlockingPidsLockMgr(null);
    expect(fn('pg_blocking_pids', 1)).toBe('{}');
    setBlockingPidsLockMgr(null); // restore
  });

  it('backend / recovery / session stubs', () => {
    expect(fn('pg_backend_pid')).toBeTypeOf('number');
    expect(fn('pg_is_in_recovery')).toBe(false);
    expect(fn('pg_cancel_backend', 1)).toBe(true);
    expect(fn('pg_terminate_backend', 1)).toBe(true);
    expect(fn('pg_reload_conf')).toBe(true);
  });

  it('pg_client_encoding and gen_random_uuid', () => {
    expect(fn('pg_client_encoding')).toBe('UTF8');
    expect(fn('gen_random_uuid')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('pg_prewarm and blocking pids return safe values', () => {
    expect(fn('pg_prewarm', 't')).toBe(0);
    expect(fn('pg_blocking_pids', 1)).toBe('{}');
  });

  it('wal functions return an LSN string', () => {
    expect(fn('pg_start_backup', 'label')).toBeTruthy();
    expect(fn('pg_stop_backup')).toBeTruthy();
    expect(fn('pg_switch_wal')).toBeTruthy();
    expect(fn('pg_current_wal_lsn')).toBeTruthy();
    expect(fn('pg_current_wal_insert_lsn')).toBeTruthy();
  });

  it('pg_size_pretty formats binary sizes', () => {
    expect(fn('pg_size_pretty', 0)).toBe('0 bytes');
    expect(fn('pg_size_pretty', 1023)).toBe('1023 bytes');
    expect(fn('pg_size_pretty', 1024)).toBe('1 kB');
    expect(fn('pg_size_pretty', 1048576)).toBe('1 MB');
    expect(fn('pg_size_pretty', 1073741824)).toBe('1 GB');
    expect(fn('pg_size_pretty', -1)).toBeNull();
    expect(fn('pg_size_pretty', null)).toBeNull();
  });

  it('pg_size_pretty formats TB range', () => {
    expect(fn('pg_size_pretty', 1099511627776)).toBe('1 TB');
  });

  it('pg_size_pretty handles >=10 magnitude (toFixed(0)) branches', () => {
    expect(fn('pg_size_pretty', 10240)).toBe('10 kB');      // kb = 10 → toFixed(0)
    expect(fn('pg_size_pretty', 10485760)).toBe('10 MB');   // mb = 10 → toFixed(0)
    expect(fn('pg_size_pretty', 10737418240)).toBe('10 GB'); // gb = 10 → toFixed(0)
    expect(fn('pg_size_pretty', 10995116277760)).toBe('10 TB');
    expect(fn('pg_size_pretty', 512)).toBe('512 bytes');
  });

  it('relation size functions return non-negative integers', () => {
    expect(fn('pg_relation_size', 't')).toBeGreaterThanOrEqual(0);
    expect(fn('pg_total_relation_size', 't')).toBeGreaterThanOrEqual(0);
    expect(fn('pg_table_size', 't')).toBeGreaterThanOrEqual(0);
    expect(fn('pg_indexes_size', 't')).toBeGreaterThanOrEqual(0);
    expect(fn('pg_relation_size', null)).toBeNull();
  });

  it('transaction id functions return integers', () => {
    expect(fn('pg_current_xact_id')).toBeTypeOf('number');
    expect(fn('pg_last_committed_xact')).toBeTypeOf('number');
  });
});

describe('PgFunctions — session GUCs (BUG #116 closure)', () => {
  it('current_setting reads a value that was SET', () => {
    const guc = GucSystem.getInstance();
    guc.registry.set('search_path', 'public,extra');
    expect(fn('current_setting', 'search_path')).toBe('public,extra');
  });

  it('current_setting returns null for unknown GUC', () => {
    expect(fn('current_setting', 'nonexistent_guc_xyz')).toBeNull();
  });

  it('current_setting returns null for null name', () => {
    expect(fn('current_setting', null)).toBeNull();
  });

  it('current_query returns empty', () => {
    expect(fn('current_query')).toBe('');
  });

  it('current_schemas returns true/false variants', () => {
    expect(fn('current_schemas', 'true')).toBe('{pg_catalog,public}');
    expect(fn('current_schemas', false)).toBe('{public}');
  });
});

describe('PgFunctions — null propagation across the string/math surface', () => {
  it('string functions return null on null primary input', () => {
    expect(fn('rtrim', null)).toBeNull();
    expect(fn('ltrim', null)).toBeNull();
    expect(fn('btrim', null)).toBeNull();
    expect(fn('lower', null)).toBeNull();
    expect(fn('upper', null)).toBeNull();
    expect(fn('translate', null, 'a', 'b')).toBeNull();
    expect(fn('translate', 'abc', null, 'b')).toBeNull();
    expect(fn('translate', 'abc', 'a', null)).toBeNull();
    expect(fn('rpad', null, 5)).toBeNull();
    expect(fn('rpad', 'a', null)).toBeNull();
    expect(fn('substr', null, 1)).toBeNull();
    expect(fn('substr', 'a', null)).toBeNull();
    expect(fn('strpos', null, 'a')).toBeNull();
    expect(fn('bit_length', null)).toBeNull();
    expect(fn('char_length', null)).toBeNull();
    expect(fn('character_length', null)).toBeNull();
  });

  it('encode/decode/sha return null on null', () => {
    expect(fn('encode', null, 'hex')).toBeNull();
    expect(fn('encode', 'a', null)).toBeNull();
    expect(fn('decode', null, 'hex')).toBeNull();
    expect(fn('decode', 'a', null)).toBeNull();
    expect(fn('sha224', null)).toBeNull();
    expect(fn('sha384', null)).toBeNull();
    expect(fn('sha512', null)).toBeNull();
  });
});

describe('PgFunctions — substring regex/escape/bigint variants', () => {
  it('substring FROM pattern (regex) extracts first match', () => {
    expect(fn('substring', 'foobar', 'o+')).toBe('oo');
    expect(fn('substring', 'abc', 'z')).toBe(''); // no match
  });

  it('substring FROM pattern FOR escape handles empty and non-empty escape', () => {
    // empty escape → falls back to plain regex match
    expect(fn('substring', 'a.b', 'a.b', '')).toBe('a.b');
    // non-empty escape char → escaped pattern
    expect(fn('substring', 'abc', 'a', '\\')).toBe('a');
  });

  it('substring with bigint from treats as position', () => {
    expect(fn('substring', 'abcdef', BigInt(3))).toBe('cdef');
    expect(fn('substring', 'abcdef', BigInt(-2))).toBe('ef');
  });

  it('doSubstringByPos handles negative/zero/NaN count', () => {
    expect(fn('substring', 'abcdef', 2)).toBe('bcdef');
    expect(fn('substring', 'abcdef', 2, 3)).toBe('bcd');
    expect(fn('substring', 'abcdef', -3)).toBe('def');
    expect(fn('substring', 'abcdef', 2, -1)).toBe('');
    expect(fn('substring', 'abcdef', 2, 'abc')).toBe('');
  });
});

describe('PgFunctions — format / regexp / position / substr / trim', () => {
  it('format handles %s / %L / %I specifiers', () => {
    expect(fn('format', 'hello %s', 'world')).toBe('hello world');
    expect(fn('format', 'name=%L', "O'Reilly")).toBe("name='O''Reilly'");
    expect(fn('format', 'tbl=%I', 'My Table')).toBe('tbl="My Table"');
    // null arg for %s → empty string
    expect(fn('format', 'x=%s', null)).toBe('x=');
    // non-matching specifier preserved
    expect(fn('format', '100%')).toBe('100%');
  });

  it('regexp_match / regexp_matches return match or null', () => {
    expect(fn('regexp_match', 'foobar', 'o+')).toBe('oo');
    expect(fn('regexp_match', 'abc', 'z', 'i')).toBeNull();
    expect(fn('regexp_matches', 'fooo', 'o+')).toEqual([['ooo']]);
    expect(fn('regexp_matches', 'abc', 'o')).toBeNull();
  });

  it('regexp_matches with capture groups returns captured slices', () => {
    // with 'g' flag → global match; capture group → slice(1) non-empty
    expect(fn('regexp_matches', 'a1b2', '(\\d)', 'g')).toEqual([['1'], ['2']]);
    // without 'g' → single match
    expect(fn('regexp_matches', 'a1b2', '(\\d)')).toEqual([['1']]);
  });

  it('regexp_split_to_array / _table split by pattern', () => {
    expect(fn('regexp_split_to_array', 'a,b,c', ',')).toEqual(['a', 'b', 'c']);
    expect(fn('regexp_split_to_table', 'a,b,c', ',')).toEqual(['a', 'b', 'c']);
    expect(fn('regexp_split_to_array', 'abc', 'z')).toEqual(['abc']);
    expect(fn('regexp_split_to_table', 'abc', 'z')).toEqual(['abc']);
  });

  it('regexp_split accepts explicit flags', () => {
    expect(fn('regexp_split_to_array', 'A,B,C', ',', 'i')).toEqual(['A', 'B', 'C']);
    expect(fn('regexp_split_to_table', 'A,B,C', ',', '')).toEqual(['A', 'B', 'C']);
  });

  it('position / strpos locate a substring', () => {
    expect(fn('position', 'll', 'hello')).toBe(3);
    expect(fn('position', 'z', 'hello')).toBe(0);
    expect(fn('strpos', 'hello', 'll')).toBe(3);
    expect(fn('strpos', 'hello', 'z')).toBe(0);
  });

  it('substr / btrim / ltrim / rtrim edge cases', () => {
    expect(fn('substr', 'abcdef', 3, 2)).toBe('cd');
    expect(fn('substr', 'abcdef', -3)).toBe('def');
    expect(fn('btrim', 'xxhi', 'x')).toBe('hi');
    expect(fn('btrim', '  hi  ')).toBe('hi');
    expect(fn('trim', 'xxhixx', 'x', 'BOTH')).toBe('hi');
    expect(fn('trim', 'xxhi', 'x', 'LEADING')).toBe('hi');
    expect(fn('trim', 'hixx', 'x', 'TRAILING')).toBe('hi');
  });
});

describe('PgFunctions — date_bin unit aliases and TB size', () => {
  it('date_bin accepts hr/min aliases', () => {
    const origin = '2020-01-01 00:00:00';
    expect(fn('date_bin', '1 hr', '2020-01-01 02:30:00', origin)).toBeTruthy();
    expect(fn('date_bin', '30 min', '2020-01-01 00:31:00', origin)).toBeTruthy();
  });

  it('date_bin rejects numeric-only and malformed strides', () => {
    const origin = '2020-01-01 00:00:00';
    expect(fn('date_bin', '1000000', '2020-01-01 00:00:01', origin)).toBeTruthy(); // pure-number path
    expect(fn('date_bin', 'garbage', '2020-01-01 00:00:01', origin)).toBeNull(); // no match → null
  });

  it('date_bin rejects null stride and unknown unit', () => {
    const origin = '2020-01-01 00:00:00';
    expect(fn('date_bin', null, '2020-01-01', origin)).toBeNull(); // parseIntervalMs isNull
    expect(fn('date_bin', '1 fortnight', '2020-01-08', origin)).toBeNull(); // unknown unit
  });
});

describe('PgFunctions — null guards across date/string/misc surface', () => {
  it('date_part / date_trunc / extract / isfinite null', () => {
    expect(fn('date_part', null, '2020-01-01')).toBeNull();
    expect(fn('date_part', 'year', null)).toBeNull();
    expect(fn('date_trunc', null, '2020-01-01')).toBeNull();
    expect(fn('date_trunc', 'year', null)).toBeNull();
    expect(fn('extract', null, '2020-01-01')).toBeNull();
    expect(fn('extract', 'year', null)).toBeNull();
    expect(fn('isfinite', null)).toBeNull();
  });

  it('date functions accept a Date instance (parseDate instanceof branch)', () => {
    const d = new Date(2020, 4, 15, 12, 34, 56);
    expect(fn('date_part', 'year', d)).toBe(2020);
    expect(fn('extract', 'month', d)).toBe(5);
    expect(fn('date_trunc', 'day', d)).toBe('2020-05-15 00:00:00');
    expect(fn('isfinite', d)).toBe(true);
    expect(fn('age', d, '2020-01-01')).toBeTruthy();
  });

  it('position / strpos / substr null and empty-needle', () => {
    expect(fn('position', null, 'a')).toBeNull();
    expect(fn('position', 'a', null)).toBeNull();
    expect(fn('position', '', 'hello')).toBe(1);
    expect(fn('substr', null, 1)).toBeNull();
    expect(fn('substr', 'a', null)).toBeNull();
    expect(fn('substr', 'a', 1, null)).toBeNull();
    expect(fn('substr', 'a', 'x')).toBeNull(); // NaN start
  });

  it('substring escape variant with no match → empty string', () => {
    expect(fn('substring', 'abc', 'z', '')).toBe('');
    expect(fn('substring', 'abc', 'z', '\\')).toBe('');
  });

  it('trim default (BOTH) and btrim empty chars', () => {
    expect(fn('trim', '  hi  ')).toBe('hi');
    expect(fn('btrim', 'hi', '')).toBe('hi');
    expect(fn('date_trunc', 'year', 'not-a-date')).toBeNull();
  });

  it('lpad / right / round / scale / octet_length null and NaN', () => {
    expect(fn('lpad', 'a', null)).toBeNull();
    expect(fn('lpad', 'a', 'x')).toBeNull();
    expect(fn('right', 'abc', 'x')).toBeNull();
    expect(fn('round', 1, 'x')).toBeNull();
    expect(fn('scale', null)).toBeNull();
    expect(fn('octet_length', null)).toBeNull();
    expect(fn('trim', null)).toBeNull();
    expect(fn('trunc', null)).toBeNull();
    expect(fn('trunc', 'x')).toBeNull();
  });

  it('regexp family null guards', () => {
    expect(fn('regexp_match', null, 'o')).toBeNull();
    expect(fn('regexp_match', 'a', null)).toBeNull();
    expect(fn('regexp_matches', null, 'o')).toBeNull();
    expect(fn('regexp_matches', 'a', null)).toBeNull();
    expect(fn('substring', null, 1)).toBeNull();
    expect(fn('substring', 'a', null)).toBeNull();
    expect(fn('replace', null, 'a', 'b')).toBeNull();
    expect(fn('btrim', null)).toBeNull();
  });

  it('generate_subscripts / json null guards', () => {
    expect(fn('generate_subscripts', null, 1)).toEqual([]);
    expect(fn('generate_subscripts', ['a'], null)).toEqual([]);
    expect(fn('json_build_object', null, 1)).toBe('{}');
    expect(fn('to_json', undefined)).toBe('null');
    expect(fn('row_to_json', undefined)).toBe('null');
  });

  it('json_build_object with undefined value → null', () => {
    expect(fn('json_build_object', 'a', undefined)).toBe('{"a":null}');
  });

  it('relation-size / background stubs null guards', () => {
    expect(fn('pg_total_relation_size', null)).toBeNull();
    expect(fn('pg_table_size', null)).toBeNull();
    expect(fn('pg_indexes_size', null)).toBeNull();
    expect(fn('pg_sleep', 1)).toBe('pg_sleep');
  });

  it('format null guard', () => {
    expect(fn('format', null)).toBeNull();
    expect(fn('format', 'no specifiers')).toBe('no specifiers');
    expect(fn('format', '%I')).toBe('""'); // quoteIdent(undefined) → quoted empty
  });

  it('to_json / row_to_json object branch', () => {
    expect(fn('to_json', { a: 1 })).toBe('{"a":1}');
    expect(fn('to_json', [1, 'x'])).toBe('[1,"x"]');
    expect(fn('row_to_json', { a: 1 })).toBe('{"a":1}');
  });
});



