/**
 * Unit tests for the PgBouncer connection-pool command shim.
 *
 * Exercises command detection (case-insensitive, generic SHOW, SET, PAUSE/
 * RESUME/RELOAD), per-command rewrites, live stats injection, and the
 * pass-through / empty-input branches.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  detectPoolSql,
  rewritePoolSql,
  setPoolStatsSource,
} from '../query/ConnectionPoolShim';

describe('detectPoolSql', () => {
  it('detects SHOW POOLS / STATS / VERSION / CLIENTS / DATABASES / SERVERS', () => {
    for (const sql of [
      'SHOW POOLS',
      'SHOW STATS',
      'SHOW VERSION',
      'SHOW CLIENTS',
      'SHOW DATABASES',
      'SHOW SERVERS',
    ]) {
      expect(detectPoolSql(sql)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(detectPoolSql('show pools')).toBe(true);
    expect(detectPoolSql('Show Pools;')).toBe(true);
  });

  it('detects generic SHOW commands', () => {
    expect(detectPoolSql('SHOW FDS')).toBe(true);
    expect(detectPoolSql('SHOW SOCKETS')).toBe(true);
  });

  it('detects PAUSE / RESUME / RELOAD / SET', () => {
    expect(detectPoolSql('PAUSE')).toBe(true);
    expect(detectPoolSql('RESUME')).toBe(true);
    expect(detectPoolSql('RELOAD')).toBe(true);
    expect(detectPoolSql('SET client_encoding = UTF8')).toBe(true);
  });

  it('returns false for non-pool SQL', () => {
    expect(detectPoolSql('SELECT * FROM t')).toBe(false);
    expect(detectPoolSql('INSERT INTO t VALUES (1)')).toBe(false);
  });

  it('returns false for empty / non-string input', () => {
    expect(detectPoolSql('')).toBe(false);
    expect(detectPoolSql('   ')).toBe(false);
    // @ts-expect-error defensive branch
    expect(detectPoolSql(null)).toBe(false);
    // @ts-expect-error defensive branch
    expect(detectPoolSql(undefined)).toBe(false);
  });
});

describe('rewritePoolSql', () => {
  afterEach(() => setPoolStatsSource(null));

  it('passes through non-pool SQL unchanged', () => {
    const r = rewritePoolSql('SELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });

  it('returns empty input untouched with rewritten=false', () => {
    expect(rewritePoolSql('')).toEqual({ sql: '', rewritten: false });
    // @ts-expect-error defensive branch
    expect(rewritePoolSql(null)).toEqual({ sql: '', rewritten: false });
  });

  it('rewrites SHOW POOLS with injected live stats', () => {
    setPoolStatsSource({ getStats: () => ({ active: 2, idle: 3, waiting: 1, max: 10 }) });
    const r = rewritePoolSql('SHOW POOLS');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('pool_name');
    expect(r.sql).toContain('2 AS active');
    expect(r.sql).toContain('3 AS idle');
    expect(r.sql).toContain('5 AS total');
    expect(r.sql).toContain('1 AS waiting');
    expect(r.sql).toContain('10 AS max');
  });

  it('rewrites SHOW POOLS with zeroed stats when no source is set', () => {
    const r = rewritePoolSql('SHOW POOLS');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('0 AS active');
  });

  it('rewrites SHOW CLIENTS', () => {
    const r = rewritePoolSql('SHOW CLIENTS');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('AS pid');
  });

  it('rewrites SHOW STATS with live stats', () => {
    setPoolStatsSource({ getStats: () => ({ active: 5, idle: 0, waiting: 2, max: 8 }) });
    const r = rewritePoolSql('SHOW STATS');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('5 AS total_queries');
    expect(r.sql).toContain('2 AS waiting');
  });

  it('rewrites SHOW VERSION', () => {
    const r = rewritePoolSql('SHOW VERSION');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('PgBouncer');
  });

  it('rewrites SHOW DATABASES', () => {
    const r = rewritePoolSql('SHOW DATABASES');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'sqlvec'");
  });

  it('rewrites SHOW SERVERS with live stats', () => {
    setPoolStatsSource({ getStats: () => ({ active: 1, idle: 2, waiting: 0, max: 4 }) });
    const r = rewritePoolSql('SHOW SERVERS');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('3 AS total');
    expect(r.sql).toContain('1 AS active');
    expect(r.sql).toContain('2 AS idle');
  });

  it('rewrites generic SHOW commands to SELECT 1 AS stat', () => {
    const r = rewritePoolSql('SHOW SOCKETS');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1 AS stat');
  });

  it('rewrites PAUSE / RESUME / RELOAD to SELECT 1', () => {
    expect(rewritePoolSql('PAUSE').sql).toBe('SELECT 1');
    expect(rewritePoolSql('RESUME').sql).toBe('SELECT 1');
    expect(rewritePoolSql('RELOAD').sql).toBe('SELECT 1');
  });

  it('rewrites SET commands to SELECT 1', () => {
    const r = rewritePoolSql('SET application_name = psql');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
  });
});
