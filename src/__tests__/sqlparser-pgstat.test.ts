import { describe, it, expect } from 'vitest';
import { detectPgStatArchiver, rewritePgStatArchiver } from '../query/PgStatArchiverShim';
import { detectPgStatCheckpointer, rewritePgStatCheckpointer } from '../query/PgStatCheckpointerShim';
import { detectPgStatGssapi, rewritePgStatGssapi } from '../query/PgStatGssapiShim';
import { detectPgStatSlru, rewritePgStatSlru } from '../query/PgStatSlruShim';
import { detectPgStatBackend, rewritePgStatBackend } from '../query/PgStatBackendShim';
import { detectPgStatIo, rewritePgStatIo } from '../query/PgStatIoShim';
import { detectPgStatIoUser, rewritePgStatIoUser } from '../query/PgStatIoUserShim';

// These shims rewrite PG-only system views (pg_stat_archiver, etc.) into SQLite
// equivalents returning zero/empty statistics. The critical invariant is that a
// view name appearing inside a string literal or a comment is NEVER rewritten —
// only a real table reference is.
describe('PgStat system-view shims', () => {
  describe('detect functions', () => {
    it('reject non-string / empty input', () => {
      expect(detectPgStatArchiver('' as any)).toBe(false);
      expect(detectPgStatCheckpointer(null as any)).toBe(false);
      expect(detectPgStatGssapi(undefined as any)).toBe(false);
      expect(detectPgStatSlru(42 as any)).toBe(false);
      expect(detectPgStatBackend('' as any)).toBe(false);
      expect(detectPgStatIo('   ' as any)).toBe(false);
      expect(detectPgStatIoUser(null as any)).toBe(false);
    });

    it('detect the view name case-insensitively', () => {
      expect(detectPgStatArchiver('SELECT * FROM PG_STAT_ARCHIVER')).toBe(true);
      expect(detectPgStatCheckpointer('SELECT * FROM pg_stat_checkpointer')).toBe(true);
      expect(detectPgStatGssapi('select * from pg_stat_gssapi')).toBe(true);
      expect(detectPgStatSlru('SELECT * FROM pg_stat_slru')).toBe(true);
      expect(detectPgStatBackend('SELECT pg_stat_get_backend_idset()')).toBe(true);
      expect(detectPgStatIo('SELECT * FROM pg_stat_io')).toBe(true);
      expect(detectPgStatIoUser('SELECT * FROM pg_statio_user_tables')).toBe(true);
      expect(detectPgStatIoUser('SELECT * FROM pg_statio_user_indexes')).toBe(true);
    });

    it('return false for unrelated SQL', () => {
      expect(detectPgStatArchiver('SELECT 1')).toBe(false);
      expect(detectPgStatIo('SELECT * FROM some_table')).toBe(false);
      expect(detectPgStatIoUser('SELECT * FROM pg_stat_io_user')).toBe(false);
    });
  });

  describe('rewrite — table reference substitution', () => {
    it('rewrites pg_stat_archiver into the VALUES subquery', () => {
      const out = rewritePgStatArchiver('SELECT * FROM pg_stat_archiver');
      expect(out).toContain('archived_count');
      expect(out).toContain('stats_reset');
      expect(out).not.toContain('FROM pg_stat_archiver');
    });

    it('rewrites a column-specific reference', () => {
      const out = rewritePgStatArchiver('SELECT archived_count FROM pg_stat_archiver');
      expect(out).toContain('archived_count');
      expect(out).toContain('FROM (SELECT');
    });

    it('rewrites pg_stat_io and pg_stat_slru', () => {
      expect(rewritePgStatIo('SELECT * FROM pg_stat_io')).toContain('backend_type');
      expect(rewritePgStatSlru('SELECT * FROM pg_stat_slru')).toContain('blks_hit');
    });

    it('rewrites pg_stat_io referenced in a JOIN (non-FROM position)', () => {
      const out = rewritePgStatIo('SELECT * FROM a JOIN pg_stat_io ON true');
      expect(out).toContain('backend_type');
      expect(out).not.toContain('pg_stat_io');
    });

    it('rewrites pg_stat_checkpointer and pg_stat_gssapi', () => {
      expect(rewritePgStatCheckpointer('SELECT * FROM pg_stat_checkpointer')).toContain(
        'num_timed',
      );
      expect(rewritePgStatGssapi('SELECT * FROM pg_stat_gssapi')).toContain('gss_authenticated');
    });

    it('rewrites pg_stat_get_backend_idset() to an empty set', () => {
      expect(rewritePgStatBackend('SELECT * FROM pg_stat_get_backend_idset()')).toBe(
        'SELECT * FROM (SELECT 0 WHERE 1=0)',
      );
    });

    it('rewrites both pg_statio_user_tables and pg_statio_user_indexes', () => {
      expect(rewritePgStatIoUser('SELECT * FROM pg_statio_user_tables')).toContain(
        'heap_blks_read',
      );
      expect(rewritePgStatIoUser('SELECT * FROM pg_statio_user_indexes')).toContain(
        'indexrelname',
      );
    });

    it('rewrites both views when referenced together in one query', () => {
      const out = rewritePgStatIoUser(
        'SELECT * FROM pg_statio_user_tables, pg_statio_user_indexes',
      );
      expect(out).toContain('heap_blks_read');
      expect(out).toContain('indexrelname');
      expect(out).not.toContain('pg_statio_user_tables,');
      expect(out).not.toContain('pg_statio_user_indexes');
    });
  });

  describe('rewrite — literal/comment protection (regression guard)', () => {
    it('does NOT rewrite a view name inside a string literal', () => {
      expect(rewritePgStatArchiver("SELECT 'pg_stat_archiver' AS label")).toBe(
        "SELECT 'pg_stat_archiver' AS label",
      );
      expect(rewritePgStatCheckpointer("SELECT 'pg_stat_checkpointer' AS label")).toBe(
        "SELECT 'pg_stat_checkpointer' AS label",
      );
      expect(rewritePgStatGssapi("SELECT 'pg_stat_gssapi' AS label")).toBe(
        "SELECT 'pg_stat_gssapi' AS label",
      );
      expect(rewritePgStatSlru("SELECT 'pg_stat_slru' AS label")).toBe(
        "SELECT 'pg_stat_slru' AS label",
      );
      expect(rewritePgStatIo("SELECT 'pg_stat_io' AS label")).toBe(
        "SELECT 'pg_stat_io' AS label",
      );
      expect(rewritePgStatIoUser("SELECT 'pg_statio_user_tables' AS label")).toBe(
        "SELECT 'pg_statio_user_tables' AS label",
      );
      expect(rewritePgStatBackend("SELECT 'pg_stat_get_backend_idset()' AS label")).toBe(
        "SELECT 'pg_stat_get_backend_idset()' AS label",
      );
      expect(rewritePgStatIo("SELECT 'FROM pg_stat_io' AS label")).toBe(
        "SELECT 'FROM pg_stat_io' AS label",
      );
    });

    it('does NOT rewrite a view name inside a single-line comment', () => {
      expect(rewritePgStatGssapi('SELECT 1 -- pg_stat_gssapi')).toBe(
        'SELECT 1 -- pg_stat_gssapi',
      );
    });
  });

  describe('rewrite — passthrough', () => {
    it('returns unrelated SQL unchanged for every shim', () => {
      expect(rewritePgStatArchiver('SELECT 1')).toBe('SELECT 1');
      expect(rewritePgStatCheckpointer('SELECT * FROM users')).toBe('SELECT * FROM users');
      expect(rewritePgStatGssapi('SELECT 42')).toBe('SELECT 42');
      expect(rewritePgStatSlru('SELECT * FROM t')).toBe('SELECT * FROM t');
      expect(rewritePgStatBackend('SELECT 1')).toBe('SELECT 1');
      expect(rewritePgStatIo('SELECT * FROM other')).toBe('SELECT * FROM other');
      expect(rewritePgStatIoUser('SELECT * FROM other')).toBe('SELECT * FROM other');
    });
  });
});
