/**
 * pitr-shim.test.ts — Coverage tests for PITRShim (point-in-time recovery /
 * WAL replay compatibility shim).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectPITR, rewritePITR } from '../query/PITRShim';
import { WALStateManager } from '../storage/WALStateManager';

describe('detectPITR', () => {
  it('returns false for non-string input', () => {
    expect(detectPITR(undefined as unknown as string)).toBe(false);
    expect(detectPITR(null as unknown as string)).toBe(false);
    expect(detectPITR(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectPITR('')).toBe(false);
    expect(detectPITR('   ')).toBe(false);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectPITR('SELECT 1')).toBe(false);
    expect(detectPITR('CREATE TABLE t (id INT)')).toBe(false);
  });

  it('returns false for a bare column reference (not a call)', () => {
    expect(detectPITR('SELECT pg_create_restore_point FROM dual')).toBe(false);
  });

  it('detects pg_create_restore_point', () => {
    expect(detectPITR("SELECT pg_create_restore_point('my_point')")).toBe(true);
    expect(detectPITR("select pg_create_restore_point('x')")).toBe(true);
    expect(detectPITR("SELECT PG_CREATE_RESTORE_POINT('x')")).toBe(true);
  });

  it('detects pg_wal_replay_pause and resume', () => {
    expect(detectPITR('SELECT pg_wal_replay_pause()')).toBe(true);
    expect(detectPITR('SELECT pg_wal_replay_resume()')).toBe(true);
  });

  it('detects pg_backup_label queries', () => {
    expect(detectPITR('SELECT * FROM pg_backup_label')).toBe(true);
    expect(detectPITR('SELECT label, start_time FROM pg_backup_label')).toBe(true);
    expect(detectPITR('SELECT * FROM pg_catalog.pg_backup_label')).toBe(true);
    expect(detectPITR("SELECT * FROM pg_backup_label WHERE label = 'x'")).toBe(true);
  });
});

describe('rewritePITR', () => {
  beforeEach(() => {
    WALStateManager.resetInstance();
  });

  it('returns passthrough for non-string input', () => {
    expect(rewritePITR(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewritePITR(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewritePITR('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through unrelated SQL', () => {
    expect(rewritePITR('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites pg_create_restore_point with a real LSN', () => {
    const { sql, rewritten } = rewritePITR("SELECT pg_create_restore_point('my_point')");
    expect(rewritten).toBe(true);
    expect(sql).toMatch(/^SELECT '[0-9A-F]+\/[0-9A-F]+' as lsn$/);
    // The restore point is recorded in WAL state with the given name.
    const points = WALStateManager.getInstance().getRestorePoints();
    expect(points).toHaveLength(1);
    expect(points[0].name).toBe('my_point');
  });

  it('rewrites pg_wal_replay_pause and updates state', () => {
    const { sql, rewritten } = rewritePITR('SELECT pg_wal_replay_pause()');
    expect(rewritten).toBe(true);
    expect(sql).toBe('SELECT 1');
    expect(WALStateManager.getInstance().isReplayPaused()).toBe(true);
  });

  it('rewrites pg_wal_replay_resume and updates state', () => {
    WALStateManager.getInstance().setReplayPaused(true);
    const { sql, rewritten } = rewritePITR('SELECT pg_wal_replay_resume()');
    expect(rewritten).toBe(true);
    expect(sql).toBe('SELECT 1');
    expect(WALStateManager.getInstance().isReplayPaused()).toBe(false);
  });

  it('rewrites pg_backup_label query to placeholder row', () => {
    expect(rewritePITR('SELECT * FROM pg_backup_label')).toEqual({
      sql: "SELECT 'label' as label",
      rewritten: true,
    });
  });
});
