/**
 * parallel-sort-shim.test.ts — Coverage tests for ParallelSortShim
 * (PostgreSQL parallel sort compatibility shim).
 */

import { describe, it, expect } from 'vitest';
import { detectParallelSort, rewriteParallelSort } from '../query/ParallelSortShim';
import { ParallelSessionContext } from '../query/ParallelQueryShim';

describe('detectParallelSort', () => {
  it('returns false for non-string input', () => {
    expect(detectParallelSort(undefined as unknown as string)).toBe(false);
    expect(detectParallelSort(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectParallelSort('')).toBe(false);
    expect(detectParallelSort('   ')).toBe(false);
  });

  it('returns false for non-SET/SHOW SQL', () => {
    expect(detectParallelSort('SELECT 1')).toBe(false);
    expect(detectParallelSort('CREATE TABLE t (id INT)')).toBe(false);
    expect(detectParallelSort('COMMIT')).toBe(false);
  });

  it('detects SET parallel parameters', () => {
    expect(detectParallelSort('SET max_parallel_workers_per_gather = 4')).toBe(true);
    expect(detectParallelSort('SET parallel_setup_cost = 1000')).toBe(true);
    expect(detectParallelSort('SET parallel_tuple_cost = 0.1')).toBe(true);
    expect(detectParallelSort('SET max_parallel_workers = 2')).toBe(true);
  });

  it('detects SET with SESSION/LOCAL and TO variants', () => {
    expect(detectParallelSort('SET SESSION max_parallel_workers = 4')).toBe(true);
    expect(detectParallelSort('SET LOCAL parallel_tuple_cost TO 0.5')).toBe(true);
  });

  it('detects SHOW max_parallel_workers_per_gather', () => {
    expect(detectParallelSort('SHOW max_parallel_workers_per_gather')).toBe(true);
    expect(detectParallelSort('SHOW max_parallel_workers_per_gather;')).toBe(true);
  });

  it('returns false for SET that is not a parallel param', () => {
    expect(detectParallelSort('SET search_path = public')).toBe(false);
    expect(detectParallelSort('SHOW server_version')).toBe(false);
  });
});

describe('rewriteParallelSort', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteParallelSort(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteParallelSort('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through non-SET/SHOW SQL', () => {
    expect(rewriteParallelSort('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites SET max_parallel_workers_per_gather (numeric, with ctx)', () => {
    const ctx = new ParallelSessionContext();
    const r = rewriteParallelSort('SET max_parallel_workers_per_gather = 4', ctx);
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(ctx.maxParallelWorkersPerGather).toBe(4);
  });

  it('rewrites SET max_parallel_workers_per_gather (boolean on -> 2, with ctx)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelSort('SET max_parallel_workers_per_gather = on', ctx);
    expect(ctx.maxParallelWorkersPerGather).toBe(2);
  });

  it('rewrites SET max_parallel_workers_per_gather (boolean off -> 0, with ctx)', () => {
    const ctx = new ParallelSessionContext();
    ctx.maxParallelWorkersPerGather = 5;
    rewriteParallelSort('SET max_parallel_workers_per_gather = off', ctx);
    expect(ctx.maxParallelWorkersPerGather).toBe(0);
  });

  it('rewrites SET max_parallel_workers (numeric, with ctx)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelSort('SET max_parallel_workers = 3', ctx);
    expect(ctx.maxParallelWorkers).toBe(3);
  });

  it('rewrites SET max_parallel_workers (boolean true -> 2, with ctx)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelSort('SET max_parallel_workers = true', ctx);
    expect(ctx.maxParallelWorkers).toBe(2);
  });

  it('rewrites SET max_parallel_workers_per_gather (boolean false -> 0, with ctx)', () => {
    const ctx = new ParallelSessionContext();
    ctx.maxParallelWorkersPerGather = 9;
    rewriteParallelSort('SET max_parallel_workers_per_gather = false', ctx);
    expect(ctx.maxParallelWorkersPerGather).toBe(0);
  });

  it('rewrites SET max_parallel_workers (boolean false -> 0, with ctx)', () => {
    const ctx = new ParallelSessionContext();
    ctx.maxParallelWorkers = 5;
    rewriteParallelSort('SET max_parallel_workers = false', ctx);
    expect(ctx.maxParallelWorkers).toBe(0);
  });

  it('rewrites SET parallel_setup_cost (informational, no ctx change)', () => {
    const ctx = new ParallelSessionContext();
    const r = rewriteParallelSort('SET parallel_setup_cost = 1000', ctx);
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(ctx.maxParallelWorkersPerGather).toBe(0);
    expect(ctx.maxParallelWorkers).toBe(0);
  });

  it('rewrites SET parallel_tuple_cost (informational, no ctx change)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelSort('SET parallel_tuple_cost = 0.1', ctx);
    expect(ctx.maxParallelWorkersPerGather).toBe(0);
  });

  it('handles SET without ctx (no ctx to update)', () => {
    const r = rewriteParallelSort('SET max_parallel_workers_per_gather = 4');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('handles decimal value as number', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelSort('SET max_parallel_workers = 0.5', ctx);
    expect(ctx.maxParallelWorkers).toBe(0.5);
  });

  it('handles single-quoted numeric value', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelSort("SET max_parallel_workers = '4'", ctx);
    expect(ctx.maxParallelWorkers).toBe(4);
  });

  it('handles double-quoted numeric value', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelSort('SET max_parallel_workers = "7"', ctx);
    expect(ctx.maxParallelWorkers).toBe(7);
  });

  it('handles unparseable value -> 0', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelSort('SET max_parallel_workers = garbage', ctx);
    expect(ctx.maxParallelWorkers).toBe(0);
  });

  it('returns SHOW value from ctx', () => {
    const ctx = new ParallelSessionContext();
    ctx.maxParallelWorkersPerGather = 7;
    const r = rewriteParallelSort('SHOW max_parallel_workers_per_gather', ctx);
    expect(r).toEqual({ sql: 'SELECT 7 as max_parallel_workers_per_gather', rewritten: true });
  });

  it('returns SHOW value 0 when no ctx', () => {
    const r = rewriteParallelSort('SHOW max_parallel_workers_per_gather');
    expect(r).toEqual({ sql: 'SELECT 0 as max_parallel_workers_per_gather', rewritten: true });
  });

  it('passes through unrelated SET (not parallel param)', () => {
    expect(rewriteParallelSort('SET search_path = public')).toEqual({
      sql: 'SET search_path = public',
      rewritten: false,
    });
  });
});
