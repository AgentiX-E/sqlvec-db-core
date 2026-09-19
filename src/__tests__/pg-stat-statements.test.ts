/**
 * Unit tests for PgStatStatements.
 *
 * Verifies the pg_stat_statements-equivalent aggregation: stable queryid
 * hashing, per-query call/runtime/row accumulation, min/max/mean tracking,
 * defensive snapshots, negative-value clamping, and the singleton/isolated
 * factory split.  The previous stub was a 1-line class with no `recordQuery`
 * or `getAll`, so query statistics were entirely non-functional (BUG #163).
 */
import { describe, it, expect } from 'vitest';
import { PgStatStatements } from '../pg_stats/PgStatStatements';

describe('PgStatStatements — factory & singleton', () => {
  it('getInstance returns the same singleton', () => {
    expect(PgStatStatements.getInstance()).toBe(PgStatStatements.getInstance());
  });

  it('create returns an isolated instance', () => {
    expect(PgStatStatements.create()).not.toBe(PgStatStatements.getInstance());
  });

  it('a new instance starts empty', () => {
    const pss = PgStatStatements.create();
    expect(pss.size).toBe(0);
    expect(pss.getAll()).toEqual([]);
  });
});

describe('PgStatStatements — queryid stability', () => {
  it('produces the same queryid for identical query text', () => {
    const pss = PgStatStatements.create();
    pss.recordQuery('SELECT 1', 10, 1);
    pss.recordQuery('SELECT 1', 20, 1);
    expect(pss.getAll()).toHaveLength(1); // aggregated, not two entries
  });

  it('produces distinct queryids for distinct query text', () => {
    const pss = PgStatStatements.create();
    pss.recordQuery('SELECT 1', 1, 1);
    pss.recordQuery('SELECT 2', 1, 1);
    expect(pss.getAll()).toHaveLength(2);
  });

  it('queryid is deterministic across instances', () => {
    const a = PgStatStatements.create();
    const b = PgStatStatements.create();
    a.recordQuery('SELECT 1', 1, 1);
    b.recordQuery('SELECT 1', 1, 1);
    expect(a.getAll()[0].queryid).toBe(b.getAll()[0].queryid);
  });
});

describe('PgStatStatements — aggregation', () => {
  it('accumulates calls and total_time', () => {
    const pss = PgStatStatements.create();
    pss.recordQuery('SELECT 1', 10, 5);
    pss.recordQuery('SELECT 1', 30, 5);
    const s = pss.getAll()[0];
    expect(s.calls).toBe(2);
    expect(s.total_time).toBe(40);
  });

  it('tracks min/max/mean time', () => {
    const pss = PgStatStatements.create();
    pss.recordQuery('SELECT 1', 10, 0);
    pss.recordQuery('SELECT 1', 30, 0);
    pss.recordQuery('SELECT 1', 20, 0);
    const s = pss.getAll()[0];
    expect(s.min_time).toBe(10);
    expect(s.max_time).toBe(30);
    expect(s.mean_time).toBeCloseTo(20);
  });

  it('updates min_time when a later call is faster', () => {
    const pss = PgStatStatements.create();
    pss.recordQuery('SELECT 1', 30, 0);
    pss.recordQuery('SELECT 1', 10, 0);
    const s = pss.getAll()[0];
    expect(s.min_time).toBe(10);
    expect(s.max_time).toBe(30);
  });

  it('accumulates rows', () => {
    const pss = PgStatStatements.create();
    pss.recordQuery('SELECT 1', 1, 4);
    pss.recordQuery('SELECT 1', 1, 6);
    expect(pss.getAll()[0].rows).toBe(10);
  });

  it('clamps negative duration and row count to zero', () => {
    const pss = PgStatStatements.create();
    pss.recordQuery('SELECT 1', -5, -3);
    const s = pss.getAll()[0];
    expect(s.total_time).toBe(0);
    expect(s.rows).toBe(0);
  });
});

describe('PgStatStatements — accessors & defensive copies', () => {
  it('get returns a single entry by queryid', () => {
    const pss = PgStatStatements.create();
    pss.recordQuery('SELECT 1', 1, 1);
    const id = pss.getAll()[0].queryid;
    expect(pss.get(id)?.calls).toBe(1);
    expect(pss.get(999999)).toBeUndefined();
  });

  it('getAll returns detached copies', () => {
    const pss = PgStatStatements.create();
    pss.recordQuery('SELECT 1', 1, 1);
    const all = pss.getAll();
    all[0].calls = 999;
    expect(pss.getAll()[0].calls).toBe(1);
  });

  it('get returns a detached copy', () => {
    const pss = PgStatStatements.create();
    pss.recordQuery('SELECT 1', 1, 1);
    const id = pss.getAll()[0].queryid;
    const snapshot = pss.get(id)!;
    snapshot.calls = 999;
    expect(pss.get(id)?.calls).toBe(1);
  });

  it('reset clears all statistics', () => {
    const pss = PgStatStatements.create();
    pss.recordQuery('SELECT 1', 1, 1);
    pss.reset();
    expect(pss.size).toBe(0);
    expect(pss.getAll()).toEqual([]);
  });
});
