/**
 * sync-repl-shim.test.ts — Coverage tests for SyncReplShim
 * (PostgreSQL synchronous replication compatibility shim).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  detectSyncRepl,
  rewriteSyncRepl,
  setSyncReplicationManager,
  getSyncReplicationManager,
} from '../query/SyncReplShim';
import { SyncReplicationManager } from '../replication/SyncReplicationManager';

const ORIGINAL_ENV = process.env.SYNC_STANDBY_NAMES;

afterEach(() => {
  setSyncReplicationManager(null as unknown as SyncReplicationManager);
  if (ORIGINAL_ENV === undefined) {
    delete process.env.SYNC_STANDBY_NAMES;
  } else {
    process.env.SYNC_STANDBY_NAMES = ORIGINAL_ENV;
  }
});

describe('detectSyncRepl', () => {
  it('returns false for non-string input', () => {
    expect(detectSyncRepl(undefined as unknown as string)).toBe(false);
    expect(detectSyncRepl(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectSyncRepl('')).toBe(false);
    expect(detectSyncRepl('   ')).toBe(false);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectSyncRepl('SELECT 1')).toBe(false);
    expect(detectSyncRepl('CREATE TABLE t (id INT)')).toBe(false);
  });

  it('detects SET synchronous_standby_names', () => {
    expect(detectSyncRepl("SET synchronous_standby_names = 's1,s2'")).toBe(true);
    expect(detectSyncRepl("SET SESSION synchronous_standby_names = 's1'")).toBe(true);
    expect(detectSyncRepl("SET LOCAL synchronous_standby_names TO 's1'")).toBe(true);
  });

  it('detects SHOW synchronous_standby_names', () => {
    expect(detectSyncRepl('SHOW synchronous_standby_names')).toBe(true);
    expect(detectSyncRepl('SHOW synchronous_standby_names;')).toBe(true);
  });

  it('detects SELECT sync_state FROM pg_stat_replication', () => {
    expect(detectSyncRepl('SELECT sync_state FROM pg_stat_replication')).toBe(true);
    expect(detectSyncRepl('SELECT pid, sync_state FROM pg_catalog.pg_stat_replication')).toBe(true);
  });

  it('detects SELECT pg_sync_replication_status()', () => {
    expect(detectSyncRepl('SELECT pg_sync_replication_status()')).toBe(true);
  });
});

describe('rewriteSyncRepl', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteSyncRepl(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteSyncRepl('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through unrelated SQL', () => {
    expect(rewriteSyncRepl('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites SET to no-op SELECT 1', () => {
    expect(rewriteSyncRepl("SET synchronous_standby_names = 's1,s2'")).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });

  it('rewrites SHOW with env fallback (no manager)', () => {
    process.env.SYNC_STANDBY_NAMES = 's1, s2';
    expect(rewriteSyncRepl('SHOW synchronous_standby_names')).toEqual({
      sql: "SELECT 's1, s2' AS synchronous_standby_names",
      rewritten: true,
    });
  });

  it('rewrites SHOW with empty placeholder when no env and no manager', () => {
    delete process.env.SYNC_STANDBY_NAMES;
    expect(rewriteSyncRepl('SHOW synchronous_standby_names')).toEqual({
      sql: "SELECT '' AS synchronous_standby_names",
      rewritten: true,
    });
  });

  it('escapes single quotes in SHOW value', () => {
    process.env.SYNC_STANDBY_NAMES = "sneaky'name";
    expect(rewriteSyncRepl('SHOW synchronous_standby_names')).toEqual({
      sql: "SELECT 'sneaky''name' AS synchronous_standby_names",
      rewritten: true,
    });
  });

  it('rewrites SHOW using real manager getStandbyNamesString', () => {
    setSyncReplicationManager({
      getStandbyNamesString: () => 'standby-a, standby-b',
      getSyncState: () => 'sync' as const,
    } as unknown as SyncReplicationManager);
    expect(rewriteSyncRepl('SHOW synchronous_standby_names')).toEqual({
      sql: "SELECT 'standby-a, standby-b' AS synchronous_standby_names",
      rewritten: true,
    });
  });

  it('rewrites sync_state with empty placeholder (no manager)', () => {
    expect(rewriteSyncRepl('SELECT sync_state FROM pg_stat_replication')).toEqual({
      sql: "SELECT '' AS sync_state",
      rewritten: true,
    });
  });

  it('rewrites sync_state using real manager getSyncState', () => {
    setSyncReplicationManager({
      getStandbyNamesString: () => '',
      getSyncState: () => 'sync' as const,
    } as unknown as SyncReplicationManager);
    expect(rewriteSyncRepl('SELECT sync_state FROM pg_stat_replication')).toEqual({
      sql: "SELECT 'sync' AS sync_state",
      rewritten: true,
    });
  });

  it('rewrites pg_sync_replication_status to async (no manager)', () => {
    expect(rewriteSyncRepl('SELECT pg_sync_replication_status()')).toEqual({
      sql: "SELECT 'async'",
      rewritten: true,
    });
  });

  it('rewrites pg_sync_replication_status using real manager getSyncState', () => {
    setSyncReplicationManager({
      getStandbyNamesString: () => '',
      getSyncState: () => 'quorum' as const,
    } as unknown as SyncReplicationManager);
    expect(rewriteSyncRepl('SELECT pg_sync_replication_status()')).toEqual({
      sql: "SELECT 'quorum'",
      rewritten: true,
    });
  });
});

describe('getSyncReplicationManager / setSyncReplicationManager', () => {
  it('returns null before set', () => {
    expect(getSyncReplicationManager()).toBeNull();
  });

  it('returns the set manager', () => {
    const mgr = new SyncReplicationManager();
    setSyncReplicationManager(mgr);
    expect(getSyncReplicationManager()).toBe(mgr);
  });

  it('real SyncReplicationManager default returns async', () => {
    const mgr = new SyncReplicationManager();
    setSyncReplicationManager(mgr);
    expect(rewriteSyncRepl('SELECT pg_sync_replication_status()')).toEqual({
      sql: "SELECT 'async'",
      rewritten: true,
    });
  });
});
