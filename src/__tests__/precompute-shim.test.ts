/**
 * precompute-shim.test.ts — Coverage tests for PrecomputeShim
 * (PostgreSQL precompute / auto-materialization compatibility shim).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectPrecompute, rewritePrecompute } from '../query/PrecomputeShim';
import { SecurityNoticeCollector } from '../query/SecurityNoticeCollector';

beforeEach(() => {
  SecurityNoticeCollector.clear();
});

describe('detectPrecompute', () => {
  it('returns false for empty string', () => {
    expect(detectPrecompute('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(detectPrecompute('   ')).toBe(false);
  });

  it('detects SET enable_precompute (on)', () => {
    expect(detectPrecompute('SET enable_precompute = on')).toBe(true);
  });

  it('detects SET enable_precompute (off)', () => {
    expect(detectPrecompute('SET enable_precompute = off')).toBe(true);
  });

  it('detects SET precompute_threshold', () => {
    expect(detectPrecompute('SET precompute_threshold = 5000')).toBe(true);
  });

  it('detects SET precompute_max_tables', () => {
    expect(detectPrecompute('SET precompute_max_tables = 10')).toBe(true);
  });

  it('detects ALTER TABLE precompute_agg (true)', () => {
    expect(detectPrecompute('ALTER TABLE t SET (precompute_agg = true)')).toBe(true);
  });

  it('detects ALTER TABLE precompute_agg (false, IF EXISTS)', () => {
    expect(detectPrecompute('ALTER TABLE IF EXISTS t SET (precompute_agg = false)')).toBe(true);
  });

  it('detects ALTER TABLE precompute_columns', () => {
    expect(detectPrecompute("ALTER TABLE t SET (precompute_columns = 'a,b')")).toBe(true);
  });

  it('detects SHOW enable_precompute', () => {
    expect(detectPrecompute('SHOW enable_precompute')).toBe(true);
  });

  it('detects SHOW precompute_threshold', () => {
    expect(detectPrecompute('SHOW precompute_threshold')).toBe(true);
  });

  it('detects SHOW precompute_max_tables', () => {
    expect(detectPrecompute('SHOW precompute_max_tables')).toBe(true);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectPrecompute('SELECT * FROM t')).toBe(false);
    expect(detectPrecompute('CREATE TABLE x (id INT)')).toBe(false);
  });
});

describe('rewritePrecompute', () => {
  it('returns passthrough for empty string', () => {
    expect(rewritePrecompute('')).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for whitespace-only string', () => {
    expect(rewritePrecompute('   ')).toEqual({ sql: '   ', rewritten: false });
  });

  it('rewrites SHOW enable_precompute → SELECT off', () => {
    expect(rewritePrecompute('SHOW enable_precompute')).toEqual({ sql: "SELECT 'off'", rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites SHOW precompute_threshold → SELECT 1000', () => {
    expect(rewritePrecompute('SHOW precompute_threshold')).toEqual({ sql: "SELECT '1000'", rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites SHOW precompute_max_tables → SELECT 10', () => {
    expect(rewritePrecompute('SHOW precompute_max_tables')).toEqual({ sql: "SELECT '10'", rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites SET enable_precompute → SELECT 1', () => {
    expect(rewritePrecompute('SET enable_precompute = on')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites SET enable_precompute (off) → SELECT 1', () => {
    expect(rewritePrecompute('SET enable_precompute = off')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SET precompute_threshold → SELECT 1', () => {
    expect(rewritePrecompute('SET precompute_threshold = 5000')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SET precompute_max_tables → SELECT 1', () => {
    expect(rewritePrecompute('SET precompute_max_tables = 10')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites ALTER TABLE precompute_agg → SELECT 1', () => {
    expect(rewritePrecompute('ALTER TABLE t SET (precompute_agg = true)')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites ALTER TABLE precompute_columns → SELECT 1', () => {
    expect(rewritePrecompute("ALTER TABLE t SET (precompute_columns = 'a,b')")).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('verifies notice payload format', () => {
    rewritePrecompute('SET enable_precompute = on');
    const notices = SecurityNoticeCollector.drain();
    expect(notices).toHaveLength(1);
    expect(notices[0].severity).toBe('WARNING');
    expect(notices[0].message).toBe('[PRECOMPUTE] Precompute is not implemented by this database vendor');
  });

  it('passes through unrelated SQL unchanged', () => {
    expect(rewritePrecompute('SELECT * FROM t')).toEqual({ sql: 'SELECT * FROM t', rewritten: false });
    expect(SecurityNoticeCollector.count).toBe(0);
  });
});
