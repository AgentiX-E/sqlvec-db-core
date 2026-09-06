/**
 * PgFunctions unit tests — date/time section.
 *
 * Covers interval parsing/formatting, date part extraction, date_trunc,
 * make_* constructors, and boundary validation. Asserts PostgreSQL-compatible
 * semantics rather than JavaScript defaults.
 */
import { describe, it, expect } from 'vitest';
import { buildPgFunctions } from '../system/PgFunctions';

const map = buildPgFunctions();
const call = (name: string, ...args: any[]) => map.get(name)!.fn(...args);

describe('date — make_date', () => {
  it('constructs a valid ISO date', () => {
    expect(call('make_date', 2024, 2, 29)).toBe('2024-02-29');
    expect(call('make_date', 1999, 12, 31)).toBe('1999-12-31');
  });

  it('rejects invalid dates (returns null)', () => {
    expect(call('make_date', 2023, 2, 29)).toBeNull(); // 2023 is not a leap year
    expect(call('make_date', 2024, 13, 1)).toBeNull(); // month 13 invalid
    expect(call('make_date', 2024, 0, 1)).toBeNull();
  });

  it('rejects null components', () => {
    expect(call('make_date', null, 1, 1)).toBeNull();
  });
});

describe('date — make_time', () => {
  it('constructs a valid time', () => {
    expect(call('make_time', 12, 30, 15)).toBe('12:30:15');
    expect(call('make_time', 0, 0, 0)).toBe('00:00:00');
  });

  it('rejects out-of-range components', () => {
    expect(call('make_time', 24, 0, 0)).toBeNull();
    expect(call('make_time', -1, 0, 0)).toBeNull();
    expect(call('make_time', 12, 60, 0)).toBeNull();
    expect(call('make_time', 12, 0, 60)).toBeNull();
  });
});

describe('date — make_interval', () => {
  it('builds an interval string from components', () => {
    expect(call('make_interval', 1, 2, 0, 3, 0, 0, 0)).toBe('1 year 2 mons 3 days');
    expect(call('make_interval', 0, 0, 2, 0, 0, 0, 0)).toBe('14 days'); // 2 weeks
    expect(call('make_interval', 0, 0, 0, 0, 1, 30, 0)).toBe('1 hour 30 mins');
  });

  it('returns a zero interval for no arguments', () => {
    expect(call('make_interval')).toBe('0 secs');
  });
});

describe('date — date_part / extract', () => {
  it('extracts the year', () => {
    expect(call('date_part', 'year', '2024-03-15')).toBe(2024);
    expect(call('extract', 'year', '2024-03-15')).toBe(2024);
  });

  it('extracts month and day', () => {
    expect(call('date_part', 'month', '2024-03-15')).toBe(3);
    expect(call('date_part', 'day', '2024-03-15')).toBe(15);
    expect(call('date_part', 'quarter', '2024-03-15')).toBe(1);
    expect(call('date_part', 'quarter', '2024-10-15')).toBe(4);
  });

  it('extracts dow/isodow (PG Sunday = 0)', () => {
    // 2024-01-01 was a Monday.
    expect(call('date_part', 'dow', '2024-01-01')).toBe(1);
    expect(call('date_part', 'isodow', '2024-01-01')).toBe(1);
    // 2024-01-07 was a Sunday.
    expect(call('date_part', 'dow', '2024-01-07')).toBe(0);
    expect(call('date_part', 'isodow', '2024-01-07')).toBe(7);
  });

  it('returns null for invalid date part units', () => {
    expect(call('date_part', 'bogus', '2024-03-15')).toBeNull();
  });
});

describe('date — date_trunc', () => {
  it('truncates to year/month/day', () => {
    expect(call('date_trunc', 'year', '2024-03-15 12:34:56')).toBe('2024-01-01 00:00:00');
    expect(call('date_trunc', 'month', '2024-03-15 12:34:56')).toBe('2024-03-01 00:00:00');
    expect(call('date_trunc', 'day', '2024-03-15 12:34:56')).toBe('2024-03-15 00:00:00');
  });

  it('truncates to hour/minute', () => {
    expect(call('date_trunc', 'hour', '2024-03-15 12:34:56')).toBe('2024-03-15 12:00:00');
    expect(call('date_trunc', 'minute', '2024-03-15 12:34:56')).toBe('2024-03-15 12:34:00');
  });
});

describe('date — age', () => {
  it('returns null for null input', () => {
    expect(call('age', null)).toBeNull();
  });
});

describe('date — current_* / now', () => {
  it('current_date returns a YYYY-MM-DD string', () => {
    expect(call('current_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('now returns a timestamp', () => {
    expect(typeof call('now')).toBe('string');
  });
});
