/**
 * PgFunctions unit tests — set-returning, JSON, and utility functions.
 *
 * Covers generate_series/generate_subscripts, JSON builders, advisory/xact
 * helpers, and size/wal/backup stubs registered by `buildPgFunctions`.
 */
import { describe, it, expect } from 'vitest';
import { buildPgFunctions } from '../system/PgFunctions';

const map = buildPgFunctions();
const call = (name: string, ...args: any[]) => map.get(name)!.fn(...args);

describe('generate_series', () => {
  it('generates an ascending integer series', () => {
    expect(call('generate_series', 1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('honors a positive step', () => {
    expect(call('generate_series', 1, 10, 3)).toEqual([1, 4, 7, 10]);
  });

  it('honors a negative step (descending)', () => {
    expect(call('generate_series', 5, 1, -2)).toEqual([5, 3, 1]);
  });

  it('returns an empty array for a zero step', () => {
    expect(call('generate_series', 1, 5, 0)).toEqual([]);
  });

  it('returns an empty array when start > stop (positive step)', () => {
    expect(call('generate_series', 5, 1)).toEqual([]);
  });

  it('returns an empty array for null bounds', () => {
    expect(call('generate_series', null, 5)).toEqual([]);
  });
});

describe('generate_subscripts', () => {
  it('generates 1-based subscripts', () => {
    expect(call('generate_subscripts', ['a', 'b', 'c'], 1)).toEqual([1, 2, 3]);
  });

  it('generates descending subscripts when reverse=true', () => {
    expect(call('generate_subscripts', ['a', 'b', 'c'], 1, true)).toEqual([3, 2, 1]);
  });

  it('returns empty for invalid dim or non-array input', () => {
    expect(call('generate_subscripts', [], 1)).toEqual([]);
    expect(call('generate_subscripts', 'not-array', 1)).toEqual([]);
    expect(call('generate_subscripts', ['a'], 0)).toEqual([]);
  });
});

describe('json — json_build_object', () => {
  it('builds an object from alternating key/value args', () => {
    expect(call('json_build_object', 'a', 1, 'b', 'two')).toBe('{"a":1,"b":"two"}');
  });

  it('skips null keys', () => {
    expect(call('json_build_object', null, 'x', 'a', 1)).toBe('{"a":1}');
  });

  it('returns an empty object for no args', () => {
    expect(call('json_build_object')).toBe('{}');
  });
});

describe('json — to_json / row_to_json / json_agg', () => {
  it('to_json returns "null" for null', () => {
    expect(call('to_json', null)).toBe('null');
  });

  it('to_json quotes plain strings', () => {
    expect(call('to_json', 'hello')).toBe('"hello"');
  });

  it('to_json stringifies objects', () => {
    expect(call('to_json', { a: 1 })).toBe('{"a":1}');
  });

  it('row_to_json stringifies objects and wraps scalars', () => {
    expect(call('row_to_json', { a: 1 })).toBe('{"a":1}');
    expect(call('row_to_json', 42)).toBe('{"value":42}');
  });

  it('json_agg wraps scalars in an array and passes arrays through', () => {
    expect(call('json_agg', 1)).toBe('[1]');
    expect(call('json_agg', [1, 2])).toBe('[1,2]');
    expect(call('json_agg', null)).toBe('[]');
  });
});

describe('advisory lock helpers', () => {
  it('pg_advisory_unlock_all returns true', () => {
    expect(call('pg_advisory_unlock_all')).toBe(true);
  });

  it('pg_backend_pid returns the process id', () => {
    expect(call('pg_backend_pid')).toBe(process.pid);
  });

  it('pg_is_in_recovery returns false', () => {
    expect(call('pg_is_in_recovery')).toBe(false);
  });

  it('pg_cancel_backend / pg_terminate_backend return true', () => {
    expect(call('pg_cancel_backend', 123)).toBe(true);
    expect(call('pg_terminate_backend', 123)).toBe(true);
  });
});

describe('size / wal / backup stubs', () => {
  it('pg_size_pretty formats bytes', () => {
    expect(call('pg_size_pretty', 1024)).toBe('1 kB');
  });

  it('pg_switch_wal returns a WAL location string', () => {
    const v = call('pg_switch_wal');
    expect(typeof v).toBe('string');
  });

  it('pg_current_wal_lsn returns a WAL LSN string', () => {
    expect(typeof call('pg_current_wal_lsn')).toBe('string');
  });
});
