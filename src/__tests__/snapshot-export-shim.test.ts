/**
 * snapshot-export-shim.test.ts — Coverage tests for SnapshotExportShim
 * (pg_export_snapshot / SET TRANSACTION SNAPSHOT / BEGIN REPEATABLE READ).
 */

import { describe, it, expect } from 'vitest';
import { detectSnapshot, rewriteSnapshot } from '../query/SnapshotExportShim';

describe('detectSnapshot', () => {
  it('returns false for non-string input', () => {
    expect(detectSnapshot(undefined as unknown as string)).toBe(false);
    expect(detectSnapshot(null as unknown as string)).toBe(false);
    expect(detectSnapshot(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectSnapshot('')).toBe(false);
    expect(detectSnapshot('   ')).toBe(false);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectSnapshot('SELECT * FROM users')).toBe(false);
    expect(detectSnapshot('-- snapshot comment')).toBe(false);
    expect(detectSnapshot('SELECT snapshot FROM t')).toBe(false);
  });

  it('detects pg_export_snapshot', () => {
    expect(detectSnapshot('SELECT pg_export_snapshot()')).toBe(true);
    expect(detectSnapshot('select pg_export_snapshot()')).toBe(true);
    expect(detectSnapshot('SELECT PG_EXPORT_SNAPSHOT()')).toBe(true);
    expect(detectSnapshot('  SELECT pg_export_snapshot()  ;')).toBe(true);
    expect(detectSnapshot('SELECT pg_export_snapshot ( )')).toBe(true);
  });

  it('detects SET TRANSACTION SNAPSHOT', () => {
    expect(detectSnapshot("SET TRANSACTION SNAPSHOT 'abc'")).toBe(true);
    expect(detectSnapshot("set transaction snapshot '010ABCD-1.0'")).toBe(true);
    expect(detectSnapshot("SET TRANSACTION SNAPSHOT ''")).toBe(true);
    expect(detectSnapshot("SET TRANSACTION SNAPSHOT 'x';")).toBe(true);
  });

  it('detects BEGIN ISOLATION LEVEL REPEATABLE READ', () => {
    expect(detectSnapshot('BEGIN ISOLATION LEVEL REPEATABLE READ')).toBe(true);
    expect(detectSnapshot('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ')).toBe(true);
    expect(detectSnapshot('BEGIN WORK ISOLATION LEVEL REPEATABLE READ')).toBe(true);
    expect(detectSnapshot('begin isolation level repeatable read')).toBe(true);
  });

  it('does not detect BEGIN SERIALIZABLE', () => {
    expect(detectSnapshot('BEGIN ISOLATION LEVEL SERIALIZABLE')).toBe(false);
  });
});

describe('rewriteSnapshot', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteSnapshot(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteSnapshot(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteSnapshot('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through unrelated SQL', () => {
    expect(rewriteSnapshot('SELECT * FROM users')).toEqual({ sql: 'SELECT * FROM users', rewritten: false });
  });

  it('rewrites pg_export_snapshot to a UUID SELECT', () => {
    const { sql, rewritten } = rewriteSnapshot('SELECT pg_export_snapshot()');
    expect(rewritten).toBe(true);
    expect(sql).toMatch(/^SELECT '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' as snapshot$/i);
  });

  it('rewrites SET TRANSACTION SNAPSHOT to SELECT 1', () => {
    expect(rewriteSnapshot("SET TRANSACTION SNAPSHOT 'abc'")).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewriteSnapshot("SET TRANSACTION SNAPSHOT '010ABCD-1.0'")).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('passes through BEGIN REPEATABLE READ verbatim', () => {
    const input = 'BEGIN ISOLATION LEVEL REPEATABLE READ';
    expect(rewriteSnapshot(input)).toEqual({ sql: input, rewritten: false });
  });
});
