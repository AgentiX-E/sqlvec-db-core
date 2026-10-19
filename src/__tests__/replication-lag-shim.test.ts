/**
 * replication-lag-shim.test.ts — Coverage tests for ReplicationLagShim
 * (PostgreSQL replication lag monitoring compatibility shim).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectReplLag, rewriteReplLag } from '../query/ReplicationLagShim';
import { WALStateManager } from '../storage/WALStateManager';

beforeEach(() => {
  WALStateManager.resetInstance();
});

describe('detectReplLag', () => {
  it('returns false for non-string input', () => {
    expect(detectReplLag(undefined as unknown as string)).toBe(false);
    expect(detectReplLag(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectReplLag('')).toBe(false);
    expect(detectReplLag('   ')).toBe(false);
  });

  it('detects pg_stat_replication query', () => {
    expect(detectReplLag('SELECT * FROM pg_stat_replication')).toBe(true);
    expect(detectReplLag('SELECT * FROM pg_catalog.pg_stat_replication')).toBe(true);
  });

  it('detects pg_wal_lsn_diff', () => {
    expect(detectReplLag("SELECT pg_wal_lsn_diff('0/0', '0/0')")).toBe(true);
  });

  it('detects pg_current_wal_lsn', () => {
    expect(detectReplLag('SELECT pg_current_wal_lsn()')).toBe(true);
  });

  it('detects pg_last_wal_receive_lsn', () => {
    expect(detectReplLag('SELECT pg_last_wal_receive_lsn()')).toBe(true);
  });

  it('detects pg_last_wal_replay_lsn', () => {
    expect(detectReplLag('SELECT pg_last_wal_replay_lsn()')).toBe(true);
  });

  it('detects pg_is_in_recovery', () => {
    expect(detectReplLag('SELECT pg_is_in_recovery()')).toBe(true);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectReplLag('SELECT 1')).toBe(false);
    expect(detectReplLag('CREATE TABLE t (id INT)')).toBe(false);
  });
});

describe('rewriteReplLag', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteReplLag(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteReplLag('')).toEqual({ sql: '', rewritten: false });
  });

  it('rewrites pg_stat_replication to placeholder row', () => {
    expect(rewriteReplLag('SELECT * FROM pg_stat_replication')).toEqual({
      sql: "SELECT 1 AS pid, '' AS application_name, 'streaming' AS state, '' AS client_addr, 0 AS replay_lag",
      rewritten: true,
    });
  });

  it('rewrites pg_stat_replication with schema qualifier', () => {
    const r = rewriteReplLag('SELECT * FROM pg_catalog.pg_stat_replication');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('SELECT 1 AS pid');
  });

  it('rewrites pg_wal_lsn_diff computing actual difference', () => {
    const r = rewriteReplLag("SELECT pg_wal_lsn_diff('0/1000000', '0/0')");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 16777216');
  });

  it('rewrites pg_wal_lsn_diff fallback to 0 when LSNs cannot be extracted', () => {
    const r = rewriteReplLag('SELECT pg_wal_lsn_diff()');
    expect(r).toEqual({ sql: 'SELECT 0', rewritten: true });
  });

  it('rewrites pg_current_wal_lsn using current LSN', () => {
    WALStateManager.getInstance().switchWAL(); // advance current LSN to 16MB
    const r = rewriteReplLag('SELECT pg_current_wal_lsn()');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe("SELECT '0/1000000'");
  });

  it('rewrites pg_last_wal_receive_lsn using real LSN (default 0/0)', () => {
    const r = rewriteReplLag('SELECT pg_last_wal_receive_lsn()');
    expect(r).toEqual({ sql: "SELECT '0/0'", rewritten: true });
  });

  it('rewrites pg_last_wal_replay_lsn using real LSN', () => {
    WALStateManager.getInstance().setReplayedLSN('0/2000000');
    const r = rewriteReplLag('SELECT pg_last_wal_replay_lsn()');
    expect(r).toEqual({ sql: "SELECT '0/2000000'", rewritten: true });
  });

  it('rewrites pg_last_wal_replay_lsn default 0/0', () => {
    const r = rewriteReplLag('SELECT pg_last_wal_replay_lsn()');
    expect(r).toEqual({ sql: "SELECT '0/0'", rewritten: true });
  });

  it('rewrites pg_is_in_recovery to SELECT false', () => {
    expect(rewriteReplLag('SELECT pg_is_in_recovery()')).toEqual({ sql: 'SELECT false', rewritten: true });
  });

  it('passes through unrelated SQL unchanged', () => {
    expect(rewriteReplLag('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });
});
