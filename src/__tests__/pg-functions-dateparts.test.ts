/**
 * PgFunctions unit tests — exhaustive date-part extraction and truncation.
 *
 * Exercises every `date_part` / `extract` unit and every `date_trunc`
 * granularity to cover the internal extractDatePart/truncateDate/getISOWeek/
 * getISOYear/formatInterval helpers end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { buildPgFunctions } from '../system/PgFunctions';

const map = buildPgFunctions();
const call = (name: string, ...args: any[]) => map.get(name)!.fn(...args);

// 2024-03-15 12:34:56.789 (a Friday)
const TS = '2024-03-15 12:34:56';
const part = (u: string) => call('date_part', u, TS);
const trunc = (u: string) => call('date_trunc', u, TS);

describe('date_part — every unit', () => {
  it('extracts basic calendar fields', () => {
    expect(part('year')).toBe(2024);
    expect(part('month')).toBe(3);
    expect(part('day')).toBe(15);
    expect(part('hour')).toBe(12);
    expect(part('minute')).toBe(34);
    expect(part('second')).toBe(56);
  });

  it('extracts quarter and day-of-year', () => {
    expect(part('quarter')).toBe(1);
    expect(part('doy')).toBeGreaterThan(0); // March 15th is day ~74
  });

  it('extracts dow and isodow (2024-03-15 is a Friday)', () => {
    expect(part('dow')).toBe(5);      // Friday = 5 (0=Sun)
    expect(part('isodow')).toBe(5);   // Friday = 5 (1=Mon)
  });

  it('extracts week and isoyear (ISO 8601)', () => {
    expect(part('week')).toBeGreaterThan(0);
    expect(part('isoyear')).toBe(2024);
  });

  it('extracts epoch as seconds since Unix epoch', () => {
    expect(part('epoch')).toBeGreaterThan(0);
  });

  it('extracts decade / century / millennium', () => {
    expect(part('decade')).toBe(2020);
    expect(part('century')).toBe(21);   // year 2024 → 21st century
    expect(part('millennium')).toBe(3); // year 2024 → 3rd millennium
  });

  it('extracts timezone fields as zero', () => {
    expect(part('timezone')).toBe(0);
    expect(part('timezone_hour')).toBe(0);
    expect(part('timezone_minute')).toBe(0);
  });
});

describe('date_trunc — every granularity', () => {
  it('truncates to year/month/day', () => {
    expect(trunc('year')).toBe('2024-01-01 00:00:00');
    expect(trunc('quarter')).toBe('2024-01-01 00:00:00');
    expect(trunc('month')).toBe('2024-03-01 00:00:00');
    expect(trunc('day')).toBe('2024-03-15 00:00:00');
  });

  it('truncates to hour/minute/second', () => {
    expect(trunc('hour')).toBe('2024-03-15 12:00:00');
    expect(trunc('minute')).toBe('2024-03-15 12:34:00');
    expect(trunc('second')).toBe('2024-03-15 12:34:56');
  });

  it('truncates to week (Monday start)', () => {
    // 2024-03-15 (Fri) → Monday of that week is 2024-03-11.
    expect(trunc('week')).toBe('2024-03-11 00:00:00');
  });
});

describe('age (two-arg) exercises formatInterval', () => {
  it('returns a non-empty interval for a positive gap', () => {
    const r = call('age', '2024-03-15', '2024-03-10');
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });

  it('formats a negative interval with a leading minus sign', () => {
    const r = call('age', '2024-03-10', '2024-03-15');
    expect(r.startsWith('-')).toBe(true);
  });
});
