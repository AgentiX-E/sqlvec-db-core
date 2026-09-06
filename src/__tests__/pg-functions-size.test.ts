/**
 * PgFunctions unit tests — size, transaction, and identifier helpers.
 *
 * Covers the pg_*_size estimation functions and xid helpers registered by
 * `buildPgFunctions`. These degrade gracefully (return 0/null) when no active
 * DB reference is registered, which is the path exercised here.
 */
import { describe, it, expect } from 'vitest';
import { buildPgFunctions } from '../system/PgFunctions';

const map = buildPgFunctions();
const call = (name: string, ...args: any[]) => map.get(name)!.fn(...args);

describe('pg_size_pretty', () => {
  it('formats bytes in power-of-2 units', () => {
    expect(call('pg_size_pretty', 0)).toBe('0 bytes');
    expect(call('pg_size_pretty', 1023)).toBe('1023 bytes');
    expect(call('pg_size_pretty', 1024)).toBe('1 kB');
    expect(call('pg_size_pretty', 1048576)).toBe('1 MB');
    expect(call('pg_size_pretty', 1073741824)).toBe('1 GB');
  });

  it('returns null for null, NaN, and negative input', () => {
    expect(call('pg_size_pretty', null)).toBeNull();
    expect(call('pg_size_pretty', -1)).toBeNull();
    expect(call('pg_size_pretty', 'abc')).toBeNull();
  });
});

describe('relation size functions (no DB ref)', () => {
  it('pg_relation_size returns null for null and 0 without a DB', () => {
    expect(call('pg_relation_size', null)).toBeNull();
    expect(call('pg_relation_size', 'some_table')).toBe(0);
  });

  it('pg_total_relation_size proportions for indexes', () => {
    expect(call('pg_total_relation_size', null)).toBeNull();
    expect(typeof call('pg_total_relation_size', 't')).toBe('number');
  });

  it('pg_table_size and pg_indexes_size degrade to numbers', () => {
    expect(call('pg_table_size', null)).toBeNull();
    expect(typeof call('pg_table_size', 't')).toBe('number');
    expect(typeof call('pg_indexes_size', 't')).toBe('number');
  });
});

describe('transaction / XID functions (no MVCC ref)', () => {
  it('pg_current_xact_id returns 0 without an MVCC executor', () => {
    expect(call('pg_current_xact_id')).toBe(0);
  });

  it('pg_last_committed_xact returns 0 without an MVCC executor', () => {
    expect(call('pg_last_committed_xact')).toBe(0);
  });
});
