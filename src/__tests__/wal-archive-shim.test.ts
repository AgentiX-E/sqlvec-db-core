/**
 * wal-archive-shim.test.ts — Coverage tests for WALArchiveShim
 * (PostgreSQL WAL archiving configuration compatibility shim).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectWALArchive, rewriteWALArchive } from '../query/WALArchiveShim';
import { WALStateManager } from '../storage/WALStateManager';

describe('WALArchiveShim', () => {
  beforeEach(() => {
    WALStateManager.resetInstance();
  });

  describe('detectWALArchive', () => {
    it('returns false for non-string or empty', () => {
      expect(detectWALArchive(undefined as unknown as string)).toBe(false);
      expect(detectWALArchive('')).toBe(false);
      expect(detectWALArchive('   ')).toBe(false);
    });

    it('detects SET archive_mode', () => {
      expect(detectWALArchive('SET archive_mode = on')).toBe(true);
      expect(detectWALArchive('SET archive_mode = off')).toBe(true);
      expect(detectWALArchive('SET archive_mode TO on')).toBe(true);
    });

    it('detects SET archive_command', () => {
      expect(detectWALArchive("SET archive_command = 'cp %p /archive/%f'")).toBe(true);
    });

    it('detects SET archive_timeout', () => {
      expect(detectWALArchive('SET archive_timeout = 60')).toBe(true);
    });

    it('detects SELECT pg_walfile_name', () => {
      expect(detectWALArchive("SELECT pg_walfile_name('0/ABCDEF')")).toBe(true);
    });

    it('detects SELECT pg_walfile_name_offset', () => {
      expect(detectWALArchive("SELECT pg_walfile_name_offset('0/ABCDEF')")).toBe(true);
    });

    it('detects SHOW archive_mode/command/timeout', () => {
      expect(detectWALArchive('SHOW archive_mode')).toBe(true);
      expect(detectWALArchive('SHOW archive_command')).toBe(true);
      expect(detectWALArchive('SHOW archive_timeout')).toBe(true);
    });

    it('returns false for unrelated SQL', () => {
      expect(detectWALArchive('SELECT 1')).toBe(false);
      expect(detectWALArchive('CREATE TABLE t (id INT)')).toBe(false);
    });
  });

  describe('rewriteWALArchive', () => {
    it('returns rewritten:false for non-string/empty', () => {
      expect(rewriteWALArchive(undefined as unknown as string)).toEqual({
        sql: '',
        rewritten: false,
      });
      expect(rewriteWALArchive('')).toEqual({ sql: '', rewritten: false });
    });

    it('rewrites SET archive_mode = on', () => {
      const r = rewriteWALArchive('SET archive_mode = on;');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe('SELECT 1');
      expect(WALStateManager.getInstance().getArchiveMode()).toBe('on');
    });

    it('rewrites SET archive_mode = off', () => {
      rewriteWALArchive('SET archive_mode = off');
      expect(WALStateManager.getInstance().getArchiveMode()).toBe('off');
    });

    it('normalizes SET archive_mode = 1 / true as on', () => {
      rewriteWALArchive('SET archive_mode = 1');
      expect(WALStateManager.getInstance().getArchiveMode()).toBe('on');
      rewriteWALArchive('SET archive_mode = true');
      expect(WALStateManager.getInstance().getArchiveMode()).toBe('on');
    });

    it('normalizes SET archive_mode = 0 / false as off', () => {
      rewriteWALArchive('SET archive_mode = 0');
      expect(WALStateManager.getInstance().getArchiveMode()).toBe('off');
      rewriteWALArchive('SET archive_mode = false');
      expect(WALStateManager.getInstance().getArchiveMode()).toBe('off');
    });

    it('rewrites SET archive_command', () => {
      const r = rewriteWALArchive("SET archive_command = 'cp %p /archive/%f';");
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe('SELECT 1');
      expect(WALStateManager.getInstance().getArchiveCommand()).toBe('cp %p /archive/%f');
    });

    it('rewrites SET archive_timeout', () => {
      const r = rewriteWALArchive('SET archive_timeout = 60;');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe('SELECT 1');
      expect(WALStateManager.getInstance().getArchiveTimeout()).toBe(60);
    });

    it('rewrites SELECT pg_walfile_name with real file name', () => {
      const r = rewriteWALArchive("SELECT pg_walfile_name('0/1000000');");
      expect(r.rewritten).toBe(true);
      expect(r.sql).toMatch(/^SELECT '000000010000000000000001' as file_name$/);
    });

    it('rewrites SELECT pg_walfile_name with unquoted arg using default', () => {
      const r = rewriteWALArchive('SELECT pg_walfile_name(pg_current_wal_lsn());');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe("SELECT '000000010000000000000000' as file_name");
    });

    it('rewrites SELECT pg_walfile_name_offset with real name + offset', () => {
      const r = rewriteWALArchive("SELECT pg_walfile_name_offset('0/1000000');");
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe(
        "SELECT '000000010000000000000001' as file_name, 0 as file_offset",
      );
    });

    it('rewrites SELECT pg_walfile_name_offset with unquoted arg using defaults', () => {
      const r = rewriteWALArchive('SELECT pg_walfile_name_offset(pg_current_wal_lsn());');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe(
        "SELECT '000000010000000000000000' as file_name, 0 as file_offset",
      );
    });

    it('rewrites SHOW archive_mode returning actual state', () => {
      rewriteWALArchive('SET archive_mode = on');
      const r = rewriteWALArchive('SHOW archive_mode;');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe("SELECT 'on' as archive_mode");
    });

    it('rewrites SHOW archive_command returning actual state', () => {
      rewriteWALArchive("SET archive_command = 'cp %p /a/%f'");
      const r = rewriteWALArchive('SHOW archive_command;');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe("SELECT 'cp %p /a/%f' as archive_command");
    });

    it('rewrites SHOW archive_timeout returning actual state', () => {
      rewriteWALArchive('SET archive_timeout = 120');
      const r = rewriteWALArchive('SHOW archive_timeout;');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe("SELECT '120' as archive_timeout");
    });

    it('passes through unrelated SQL unchanged', () => {
      const r = rewriteWALArchive('SELECT 1;');
      expect(r).toEqual({ sql: 'SELECT 1;', rewritten: false });
    });
  });
});
