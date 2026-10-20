/**
 * parallel-query-shim.test.ts — Coverage tests for ParallelQueryShim
 * (PG parallel query SET/SHOW/hint shim + session context).
 */

import { describe, it, expect } from 'vitest';
import {
  ParallelSessionContext,
  detectParallelQuery,
  rewriteParallelQuery,
} from '../query/ParallelQueryShim';

describe('ParallelSessionContext', () => {
  it('has default values', () => {
    const ctx = new ParallelSessionContext();
    expect(ctx.parallelWorkers).toBe(0);
    expect(ctx.pgParallelWorkers).toBe(0);
    expect(ctx.maxParallelWorkersPerGather).toBe(0);
    expect(ctx.maxParallelWorkers).toBe(0);
    expect(ctx.enableParallelHash).toBe(false);
    expect(ctx.forceParallelMode).toBe(false);
    expect(ctx.parallelLeaderParticipation).toBe(true);
    expect(ctx.minParallelTableScanSize).toBe(0);
    expect(ctx.minParallelIndexScanSize).toBe(0);
    expect(ctx.isParallelEnabled).toBe(false);
    expect(ctx.effectiveWorkers).toBe(0);
  });

  it('isParallelEnabled is true when any worker count > 0', () => {
    const ctx = new ParallelSessionContext();
    ctx.parallelWorkers = 4;
    expect(ctx.isParallelEnabled).toBe(true);

    const ctx2 = new ParallelSessionContext();
    ctx2.maxParallelWorkers = 3;
    expect(ctx2.isParallelEnabled).toBe(true);

    const ctx3 = new ParallelSessionContext();
    ctx3.pgParallelWorkers = 2;
    expect(ctx3.isParallelEnabled).toBe(true);

    const ctx4 = new ParallelSessionContext();
    ctx4.maxParallelWorkersPerGather = 1;
    expect(ctx4.isParallelEnabled).toBe(true);
  });

  it('effectiveWorkers returns max across all worker fields', () => {
    const ctx = new ParallelSessionContext();
    ctx.parallelWorkers = 2;
    ctx.pgParallelWorkers = 5;
    ctx.maxParallelWorkersPerGather = 1;
    ctx.maxParallelWorkers = 3;
    expect(ctx.effectiveWorkers).toBe(5);
  });

  it('reset clears all fields to defaults', () => {
    const ctx = new ParallelSessionContext();
    ctx.parallelWorkers = 4;
    ctx.pgParallelWorkers = 4;
    ctx.maxParallelWorkersPerGather = 4;
    ctx.maxParallelWorkers = 4;
    ctx.enableParallelHash = true;
    ctx.forceParallelMode = true;
    ctx.parallelLeaderParticipation = false;
    ctx.minParallelTableScanSize = 10;
    ctx.minParallelIndexScanSize = 11;
    ctx.reset();
    expect(ctx.parallelWorkers).toBe(0);
    expect(ctx.pgParallelWorkers).toBe(0);
    expect(ctx.maxParallelWorkersPerGather).toBe(0);
    expect(ctx.maxParallelWorkers).toBe(0);
    expect(ctx.enableParallelHash).toBe(false);
    expect(ctx.forceParallelMode).toBe(false);
    expect(ctx.parallelLeaderParticipation).toBe(true);
    expect(ctx.minParallelTableScanSize).toBe(0);
    expect(ctx.minParallelIndexScanSize).toBe(0);
  });
});

describe('detectParallelQuery', () => {
  it('returns false for non-string / empty', () => {
    expect(detectParallelQuery(undefined as unknown as string)).toBe(false);
    expect(detectParallelQuery('')).toBe(false);
    expect(detectParallelQuery('   ')).toBe(false);
  });

  it('detects optimizer hint comment', () => {
    expect(detectParallelQuery('/*+ PARALLEL(workers 4) */ SELECT * FROM t')).toBe(true);
  });

  it('detects SET parallel query params', () => {
    expect(detectParallelQuery('SET parallel_workers = 4')).toBe(true);
    expect(detectParallelQuery('SET enable_parallel_hash = on')).toBe(true);
    expect(detectParallelQuery('SET min_parallel_table_scan_size = 8MB')).toBe(true);
  });

  it('detects SET parallel sort params', () => {
    expect(detectParallelQuery('SET max_parallel_workers_per_gather = 4')).toBe(true);
    expect(detectParallelQuery('SET max_parallel_workers = 4')).toBe(true);
  });

  it('detects SHOW parallel params', () => {
    expect(detectParallelQuery('SHOW parallel_workers')).toBe(true);
    expect(detectParallelQuery('SHOW enable_parallel_hash')).toBe(true);
  });

  it('returns false for non-parallel SQL', () => {
    expect(detectParallelQuery('SELECT 1')).toBe(false);
    expect(detectParallelQuery('SET enable_plan_cache = on')).toBe(false);
  });
});

describe('rewriteParallelQuery', () => {
  it('passes through non-string / empty', () => {
    expect(rewriteParallelQuery(undefined as unknown as string)).toEqual({
      sql: '',
      rewritten: false,
    });
    expect(rewriteParallelQuery('')).toEqual({ sql: '', rewritten: false });
  });

  it('handles optimizer hint with ctx (stores workers, strips comment)', () => {
    const ctx = new ParallelSessionContext();
    const r = rewriteParallelQuery('/*+ PARALLEL(workers 4) */ SELECT * FROM t', ctx);
    expect(r).toEqual({ sql: 'SELECT * FROM t', rewritten: true });
    expect(ctx.parallelWorkers).toBe(4);
  });

  it('handles hint without ctx or workers <= 0', () => {
    const r1 = rewriteParallelQuery('/*+ PARALLEL(workers 0) */ SELECT 1');
    expect(r1).toEqual({ sql: 'SELECT 1', rewritten: true });

    const ctx = new ParallelSessionContext();
    const r2 = rewriteParallelQuery('/*+ PARALLEL(workers 0) */ SELECT 1', ctx);
    expect(ctx.parallelWorkers).toBe(0);
    expect(r2.rewritten).toBe(true);
  });

  it('passes through non SET/SHOW/hint SQL', () => {
    expect(rewriteParallelQuery('SELECT * FROM users')).toEqual({
      sql: 'SELECT * FROM users',
      rewritten: false,
    });
  });

  it('SET pgParallelWorkers (numeric)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET pgParallelWorkers = 4', ctx);
    expect(ctx.pgParallelWorkers).toBe(4);
  });

  it('SET pgParallelWorkers (on → 2)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET pgParallelWorkers = on', ctx);
    expect(ctx.pgParallelWorkers).toBe(2);
  });

  it('SET pgParallelWorkers (off → 0)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET pgParallelWorkers = off', ctx);
    expect(ctx.pgParallelWorkers).toBe(0);
  });

  it('SET parallel_workers (numeric/off/on)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET parallel_workers = 4', ctx);
    expect(ctx.parallelWorkers).toBe(4);

    const ctx2 = new ParallelSessionContext();
    rewriteParallelQuery('SET parallel_workers = off', ctx2);
    expect(ctx2.parallelWorkers).toBe(0);

    const ctx3 = new ParallelSessionContext();
    rewriteParallelQuery('SET parallel_workers = on', ctx3);
    expect(ctx3.parallelWorkers).toBe(2);
  });

  it('SET enable_parallel_hash (on/off)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET enable_parallel_hash = on', ctx);
    expect(ctx.enableParallelHash).toBe(true);

    const ctx2 = new ParallelSessionContext();
    rewriteParallelQuery('SET enable_parallel_hash = off', ctx2);
    expect(ctx2.enableParallelHash).toBe(false);
  });

  it('SET force_parallel_mode', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET force_parallel_mode = on', ctx);
    expect(ctx.forceParallelMode).toBe(true);

    const ctx2 = new ParallelSessionContext();
    rewriteParallelQuery('SET force_parallel_mode = off', ctx2);
    expect(ctx2.forceParallelMode).toBe(false);
  });

  it('SET parallel_leader_participation (off → false, on → true)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET parallel_leader_participation = off', ctx);
    expect(ctx.parallelLeaderParticipation).toBe(false);

    const ctx2 = new ParallelSessionContext();
    rewriteParallelQuery('SET parallel_leader_participation = on', ctx2);
    expect(ctx2.parallelLeaderParticipation).toBe(true);
  });

  it('SET min_parallel_table_scan_size (numeric/on)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET min_parallel_table_scan_size = 8', ctx);
    expect(ctx.minParallelTableScanSize).toBe(8);

    const ctx2 = new ParallelSessionContext();
    rewriteParallelQuery('SET min_parallel_table_scan_size = on', ctx2);
    expect(ctx2.minParallelTableScanSize).toBe(0); // boolean → 0 for size params
  });

  it('SET min_parallel_index_scan_size', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET min_parallel_index_scan_size = 64', ctx);
    expect(ctx.minParallelIndexScanSize).toBe(64);
  });

  it('SET without ctx still returns SELECT 1', () => {
    const r = rewriteParallelQuery('SET parallel_workers = 4');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('parseSetValue handles true/false strings', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET enable_parallel_hash = true', ctx);
    expect(ctx.enableParallelHash).toBe(true);

    const ctx2 = new ParallelSessionContext();
    rewriteParallelQuery('SET enable_parallel_hash = false', ctx2);
    expect(ctx2.enableParallelHash).toBe(false);
  });

  it('parseSetValue invalid value falls back to 0', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET parallel_workers = abc', ctx);
    expect(ctx.parallelWorkers).toBe(0);
  });

  it('SET sort param without ctx returns SELECT 1', () => {
    const r = rewriteParallelQuery('SET max_parallel_workers_per_gather = 4');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('SET max_parallel_workers = on → 2', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET max_parallel_workers = on', ctx);
    expect(ctx.maxParallelWorkers).toBe(2);
  });

  it('SET min_parallel_index_scan_size = on → 0 (boolean size fallback)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET min_parallel_index_scan_size = on', ctx);
    expect(ctx.minParallelIndexScanSize).toBe(0);
  });

  it('passes through non-parallel SQL (SHOW/SET not matching)', () => {
    expect(rewriteParallelQuery('SHOW work_mem')).toEqual({
      sql: 'SHOW work_mem',
      rewritten: false,
    });
    expect(rewriteParallelQuery('SET work_mem = 4MB')).toEqual({
      sql: 'SET work_mem = 4MB',
      rewritten: false,
    });
  });

  it('SHOW optional booleans return off in default state', () => {
    const ctx = new ParallelSessionContext();
    expect(rewriteParallelQuery('SHOW enable_parallel_hash', ctx).sql).toBe(
      "SELECT 'off' as enable_parallel_hash",
    );
    expect(rewriteParallelQuery('SHOW force_parallel_mode', ctx).sql).toBe(
      "SELECT 'off' as force_parallel_mode",
    );
    // leader participation defaults true
    expect(rewriteParallelQuery('SHOW parallel_leader_participation', ctx).sql).toBe(
      "SELECT 'on' as parallel_leader_participation",
    );
  });

  it('SET max_parallel_workers_per_gather', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET max_parallel_workers_per_gather = 4', ctx);
    expect(ctx.maxParallelWorkersPerGather).toBe(4);

    const ctx2 = new ParallelSessionContext();
    rewriteParallelQuery('SET max_parallel_workers_per_gather = on', ctx2);
    expect(ctx2.maxParallelWorkersPerGather).toBe(2);

    const ctx3 = new ParallelSessionContext();
    rewriteParallelQuery('SET max_parallel_workers_per_gather = off', ctx3);
    expect(ctx3.maxParallelWorkersPerGather).toBe(0);
  });

  it('SET max_parallel_workers (numeric/off)', () => {
    const ctx = new ParallelSessionContext();
    rewriteParallelQuery('SET max_parallel_workers = 4', ctx);
    expect(ctx.maxParallelWorkers).toBe(4);

    const ctx2 = new ParallelSessionContext();
    rewriteParallelQuery('SET max_parallel_workers = off', ctx2);
    expect(ctx2.maxParallelWorkers).toBe(0);
  });

  it('SET parallel_setup_cost (informational only, no-op)', () => {
    const ctx = new ParallelSessionContext();
    const r = rewriteParallelQuery('SET parallel_setup_cost = 1000', ctx);
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('SHOW returns stored value for each param', () => {
    const ctx = new ParallelSessionContext();
    ctx.parallelWorkers = 4;
    ctx.pgParallelWorkers = 5;
    ctx.maxParallelWorkersPerGather = 2;
    ctx.maxParallelWorkers = 3;
    ctx.enableParallelHash = true;
    ctx.forceParallelMode = true;
    ctx.parallelLeaderParticipation = false;
    ctx.minParallelTableScanSize = 8;
    ctx.minParallelIndexScanSize = 64;

    expect(rewriteParallelQuery('SHOW pgParallelWorkers', ctx).sql).toBe(
      "SELECT '5' as pgparallelworkers",
    );
    expect(rewriteParallelQuery('SHOW parallel_workers', ctx).sql).toBe(
      "SELECT '4' as parallel_workers",
    );
    expect(rewriteParallelQuery('SHOW max_parallel_workers_per_gather', ctx).sql).toBe(
      "SELECT '2' as max_parallel_workers_per_gather",
    );
    expect(rewriteParallelQuery('SHOW max_parallel_workers', ctx).sql).toBe(
      "SELECT '3' as max_parallel_workers",
    );
    expect(rewriteParallelQuery('SHOW enable_parallel_hash', ctx).sql).toBe(
      "SELECT 'on' as enable_parallel_hash",
    );
    expect(rewriteParallelQuery('SHOW force_parallel_mode', ctx).sql).toBe(
      "SELECT 'on' as force_parallel_mode",
    );
    expect(rewriteParallelQuery('SHOW parallel_leader_participation', ctx).sql).toBe(
      "SELECT 'off' as parallel_leader_participation",
    );
    expect(rewriteParallelQuery('SHOW min_parallel_table_scan_size', ctx).sql).toBe(
      "SELECT '8' as min_parallel_table_scan_size",
    );
    expect(rewriteParallelQuery('SHOW min_parallel_index_scan_size', ctx).sql).toBe(
      "SELECT '64' as min_parallel_index_scan_size",
    );
  });

  it('SHOW without ctx returns 0 default', () => {
    expect(rewriteParallelQuery('SHOW parallel_workers').sql).toBe(
      "SELECT '0' as parallel_workers",
    );
  });
});
