/**
 * pg-buffer-cache-shim.test.ts — Coverage tests for PgBufferCacheShim
 * (PostgreSQL pg_buffercache extension shim).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  pgBuffercache,
  getPgBufferCacheRows,
  detectPgBufferCache,
  rewritePgBufferCache,
  PgBufferCacheRow,
} from '../query/PgBufferCacheShim';

function makeDb(pragmas: Record<string, number | boolean>) {
  return {
    pragma: vi.fn((stmt: string, opts?: { simple: boolean }) => {
      const key = stmt.trim();
      if (key in pragmas) return pragmas[key];
      throw new Error(`unexpected pragma: ${stmt}`);
    }),
  };
}

describe('pgBuffercache', () => {
  it('returns empty array for pageCount 0 (default 100 rows)', () => {
    // pageCount <= 0 → count = 100 (synthetic default)
    const rows = pgBuffercache(0);
    expect(rows).toHaveLength(100);
    expect(rows[0].bufferid).toBe(1);
    expect(rows[0].relfilenode).toBe(0);
    expect(rows[99].bufferid).toBe(100);
    expect(rows[99].relblocknumber).toBe(99);
  });

  it('returns empty array for negative pageCount (default 100 rows)', () => {
    expect(pgBuffercache(-5)).toHaveLength(100);
  });

  it('caps at MAX_BUFFER_CACHE_ROWS for large pageCount', () => {
    const rows = pgBuffercache(5000);
    expect(rows).toHaveLength(100);
    expect(rows[99].bufferid).toBe(100);
  });

  it('returns pageCount rows for small positive pageCount', () => {
    const rows = pgBuffercache(3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.bufferid)).toEqual([1, 2, 3]);
    expect(rows[0].isdirty).toBe(0);
    expect(rows[0].usagecount).toBe(1);
    expect(rows[0].pinning_backends).toBe(0);
  });
});

describe('getPgBufferCacheRows', () => {
  it('returns rows from real pragma data', () => {
    const db = makeDb({
      page_count: 50,
      page_size: 4096,
      cache_size: -2000,
    });
    const rows = getPgBufferCacheRows(db, 3);
    expect(rows.length).toBe(50);
    expect(rows[0].bufferid).toBe(1);
    expect(rows[0].relfilenode).toBe(1);
    expect(rows[0].relblocknumber).toBe(0);
    expect(rows[0].pinning_backends).toBe(3);
    // usagecount should be clamped within [1, 5]
    rows.forEach((r) => {
      expect(r.usagecount).toBeGreaterThanOrEqual(1);
      expect(r.usagecount).toBeLessThanOrEqual(5);
    });
  });

  it('caps rows at MAX_BUFFER_CACHE_ROWS', () => {
    const db = makeDb({
      page_count: 5000,
      page_size: 4096,
      cache_size: -2000,
    });
    const rows = getPgBufferCacheRows(db, 0);
    expect(rows).toHaveLength(100);
  });

  it('returns 1 row when pageCount is zero', () => {
    const db = makeDb({
      page_count: 0,
      page_size: 4096,
      cache_size: -2000,
    });
    const rows = getPgBufferCacheRows(db, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].bufferid).toBe(1);
  });

  it('falls back to synthetic when pragma throws', () => {
    const db = {
      pragma: vi.fn(() => {
        throw new Error('readonly');
      }),
    };
    const rows = getPgBufferCacheRows(db, 0);
    expect(rows).toHaveLength(10); // pgBuffercache(10)
    expect(rows[0].relfilenode).toBe(0);
  });

  it('clamps pinning_backends to 5', () => {
    const db = makeDb({
      page_count: 10,
      page_size: 4096,
      cache_size: -2000,
    });
    const rows = getPgBufferCacheRows(db, 99);
    expect(rows[0].pinning_backends).toBe(5);
  });
});

describe('detectPgBufferCache', () => {
  it('returns false for non-string input', () => {
    expect(detectPgBufferCache(undefined as unknown as string)).toBe(false);
    expect(detectPgBufferCache(null as unknown as string)).toBe(false);
    expect(detectPgBufferCache('')).toBe(false);
  });

  it('detects pg_buffercache reference', () => {
    expect(detectPgBufferCache('SELECT * FROM pg_buffercache')).toBe(true);
    expect(detectPgBufferCache('select count(*) from PG_BUFFERCACHE')).toBe(true);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectPgBufferCache('SELECT 1')).toBe(false);
  });
});

describe('rewritePgBufferCache', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewritePgBufferCache(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewritePgBufferCache(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewritePgBufferCache('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through unrelated SQL unchanged', () => {
    expect(rewritePgBufferCache('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('ignores pg_buffercache mentions inside comments/strings', () => {
    const r = rewritePgBufferCache("SELECT 'pg_buffercache' -- pg_buffercache");
    expect(r.rewritten).toBe(false);
  });

  it('rewrites with provided rows via VALUES', () => {
    const rows: PgBufferCacheRow[] = [
      { bufferid: 1, relfilenode: 1, relforknumber: 0, relblocknumber: 0, isdirty: 0, usagecount: 1, pinning_backends: 0 },
    ];
    const r = rewritePgBufferCache('SELECT * FROM pg_buffercache', rows);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('SELECT column1 AS bufferid');
    expect(r.sql).toContain('FROM (VALUES');
  });

  it('uses synthetic rows when no rows provided', () => {
    const r = rewritePgBufferCache('SELECT * FROM pg_buffercache');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('SELECT column1 AS bufferid');
  });

  it('falls back to subquery when rows array is empty', () => {
    const r = rewritePgBufferCache('SELECT * FROM pg_buffercache', []);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('(SELECT 1 AS bufferid, 0 AS relfilenode');
  });
});
