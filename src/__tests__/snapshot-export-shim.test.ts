/**
 * snapshot-export-shim.test.ts — Coverage tests for SnapshotExportShim
 * (PostgreSQL pg_export_snapshot / SET TRANSACTION SNAPSHOT → no-op rewrite).
 */

import { describe, expect, it } from 'vitest';
import { detectSnapshot, rewriteSnapshot } from '../query/SnapshotExportShim';

const UUID_RE = /^SELECT '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' as snapshot$/;

describe('detectSnapshot', () => {
  it('returns false for empty / whitespace / non-string input', () => {
    expect(detectSnapshot('')).toBe(false);
    expect(detectSnapshot('   ')).toBe(false);
    expect(detectSnapshot(undefined as unknown as string)).toBe(false);
    expect(detectSnapshot(null as unknown as string)).toBe(false);
  });

  it('returns false for plain SQL', () => {
    expect(detectSnapshot('SELECT * FROM users')).toBe(false);
    expect(detectSnapshot('SELECT 1')).toBe(false);
  });

  it('returns false for snapshot as a column/comment (no false positive)', () => {
    expect(detectSnapshot('SELECT snapshot FROM t')).toBe(false);
    expect(detectSnapshot('-- pg_export_snapshot comment')).toBe(false);
  });

  it('detects SELECT pg_export_snapshot()', () => {
    expect(detectSnapshot('SELECT pg_export_snapshot()')).toBe(true);
    expect(detectSnapshot('SELECT pg_export_snapshot() ;')).toBe(true);
    expect(detectSnapshot('  select pg_export_snapshot( )  ')).toBe(true);
  });

  it('detects SET TRANSACTION SNAPSHOT', () => {
    expect(detectSnapshot("SET TRANSACTION SNAPSHOT 'abc'")).toBe(true);
    expect(detectSnapshot("SET TRANSACTION SNAPSHOT '010ABCD-1.0';")).toBe(true);
    expect(detectSnapshot("set transaction snapshot 'x'")).toBe(true);
  });

  it('detects BEGIN ISOLATION LEVEL REPEATABLE READ', () => {
    expect(detectSnapshot('BEGIN ISOLATION LEVEL REPEATABLE READ')).toBe(true);
    expect(detectSnapshot('BEGIN WORK ISOLATION LEVEL REPEATABLE READ')).toBe(true);
    expect(detectSnapshot('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;')).toBe(true);
  });

  it('does not detect BEGIN ISOLATION LEVEL SERIALIZABLE', () => {
    expect(detectSnapshot('BEGIN ISOLATION LEVEL SERIALIZABLE')).toBe(false);
  });
});

describe('rewriteSnapshot', () => {
  it('returns unchanged for empty / whitespace / non-string input', () => {
    expect(rewriteSnapshot('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteSnapshot('   ')).toEqual({ sql: '   ', rewritten: false });
    expect(rewriteSnapshot(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteSnapshot(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('passes through plain SQL', () => {
    expect(rewriteSnapshot('SELECT * FROM users')).toEqual({ sql: 'SELECT * FROM users', rewritten: false });
  });

  it('rewrites SELECT pg_export_snapshot() to a UUID', () => {
    const r = rewriteSnapshot('SELECT pg_export_snapshot()');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toMatch(UUID_RE);
  });

  it('rewrites SET TRANSACTION SNAPSHOT to SELECT 1', () => {
    expect(rewriteSnapshot("SET TRANSACTION SNAPSHOT '010ABCD-1.0'")).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });

  it('preserves BEGIN ISOLATION LEVEL REPEATABLE READ verbatim (rewritten=false)', () => {
    expect(rewriteSnapshot('BEGIN ISOLATION LEVEL REPEATABLE READ')).toEqual({
      sql: 'BEGIN ISOLATION LEVEL REPEATABLE READ',
      rewritten: false,
    });
    expect(rewriteSnapshot('BEGIN WORK ISOLATION LEVEL REPEATABLE READ')).toEqual({
      sql: 'BEGIN WORK ISOLATION LEVEL REPEATABLE READ',
      rewritten: false,
    });
    expect(rewriteSnapshot('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;')).toEqual({
      sql: 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;',
      rewritten: false,
    });
  });

  it('trims surrounding whitespace', () => {
    const r = rewriteSnapshot('  SELECT pg_export_snapshot()  ');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toMatch(UUID_RE);
  });
});
