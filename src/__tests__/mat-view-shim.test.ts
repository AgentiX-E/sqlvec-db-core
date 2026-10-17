/**
 * mat-view-shim.test.ts — Coverage tests for MatViewShim.
 *
 * Covers SQL classification/rewriting (create/refresh/drop/none), concurrent
 * refresh detection/rewrite, and the async lifecycle operations (ensureMetaTable,
 * create/refresh/refreshConcurrently/drop/isStale) driven by a mock queryFn.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectMatView,
  handleMatView,
  ensureMetaTable,
  create,
  refresh,
  refreshConcurrently,
  detectRefreshConcurrently,
  rewriteRefreshConcurrently,
  drop,
  isStale,
} from '../query/MatViewShim';

function makeQueryFn() {
  return vi.fn(async () => undefined);
}

describe('detectMatView', () => {
  it('returns false for non-string', () => {
    expect(detectMatView(undefined as any)).toBe(false);
    expect(detectMatView(null as any)).toBe(false);
    expect(detectMatView('')).toBe(false);
  });

  it('detects CREATE MATERIALIZED VIEW', () => {
    expect(detectMatView('CREATE MATERIALIZED VIEW mv AS SELECT 1')).toBe(true);
  });

  it('detects REFRESH MATERIALIZED VIEW', () => {
    expect(detectMatView('REFRESH MATERIALIZED VIEW mv')).toBe(true);
  });

  it('detects DROP MATERIALIZED VIEW', () => {
    expect(detectMatView('DROP MATERIALIZED VIEW mv')).toBe(true);
  });

  it('returns false for plain SQL', () => {
    expect(detectMatView('SELECT 1')).toBe(false);
  });
});

describe('handleMatView', () => {
  it('returns none for non-string', () => {
    expect(handleMatView('')).toEqual({ sql: '', rewritten: false, stmtType: 'none' });
    expect(handleMatView(undefined as any).stmtType).toBe('none');
  });

  it('rewrites CREATE MATERIALIZED VIEW (strips WITH DATA)', () => {
    const r = handleMatView('CREATE MATERIALIZED VIEW mv AS SELECT 1 WITH DATA');
    expect(r.stmtType).toBe('create');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('CREATE VIEW mv AS SELECT 1');
  });

  it('rewrites CREATE without WITH DATA', () => {
    const r = handleMatView('CREATE MATERIALIZED VIEW mv AS SELECT 1');
    expect(r.sql).toBe('CREATE VIEW mv AS SELECT 1');
  });

  it('rewrites CREATE with WITH NO DATA', () => {
    const r = handleMatView('CREATE MATERIALIZED VIEW mv AS SELECT 1 WITH NO DATA;');
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('WITH NO DATA');
  });

  it('suppresses REFRESH MATERIALIZED VIEW', () => {
    const r = handleMatView('REFRESH MATERIALIZED VIEW mv');
    expect(r.stmtType).toBe('refresh');
    expect(r.sql).toBeNull();
    expect(r.rewritten).toBe(false);
  });

  it('rewrites DROP MATERIALIZED VIEW', () => {
    const r = handleMatView('DROP MATERIALIZED VIEW mv');
    expect(r.stmtType).toBe('drop');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('DROP VIEW mv');
  });

  it('passes through unknown SQL', () => {
    const r = handleMatView('SELECT 1');
    expect(r.stmtType).toBe('none');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });
});

describe('ensureMetaTable', () => {
  it('executes DDL', async () => {
    const q = makeQueryFn();
    await ensureMetaTable(q);
    expect(q).toHaveBeenCalledTimes(1);
    expect(q.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS __materialized_views');
  });

  it('rethrows on error', async () => {
    const q = vi.fn(async () => { throw new Error('ddl fail'); });
    await expect(ensureMetaTable(q)).rejects.toThrow('ddl fail');
  });
});

describe('create', () => {
  it('creates table and stores metadata', async () => {
    const q = makeQueryFn();
    const meta = await create('my_view', 'SELECT * FROM t', q);
    expect(meta.viewName).toBe('my_view');
    expect(meta.querySql).toBe('SELECT * FROM t');
    // ensureMetaTable + create table + insert metadata
    expect(q).toHaveBeenCalledTimes(3);
    expect(q.mock.calls[1][0]).toBe('CREATE TABLE "my_view" AS SELECT * FROM t');
    expect(q.mock.calls[2][0]).toContain('INSERT OR REPLACE INTO __materialized_views');
  });

  it('escapes single quotes in view name and query', async () => {
    const q = makeQueryFn();
    await create("we'll", "SELECT 'x'", q);
    const insert = q.mock.calls[2][0];
    expect(insert).toContain("VALUES ('we''ll'");
    expect(insert).toContain("'SELECT ''x'''");
  });
});

describe('refresh', () => {
  it('throws when view not found (array result empty)', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT query_sql')) return [];
      return undefined;
    });
    await expect(refresh('missing', q)).rejects.toThrow('not found');
  });

  it('throws when view not found (rows format empty)', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT query_sql')) return { rows: [] };
      return undefined;
    });
    await expect(refresh('missing', q)).rejects.toThrow('not found');
  });

  it('throws when array element lacks query_sql', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT query_sql')) return [{}];
      return undefined;
    });
    await expect(refresh('missing', q)).rejects.toThrow('not found');
  });

  it('refreshes from array-format metadata', async () => {
    const calls: string[] = [];
    const q = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT query_sql')) return [{ query_sql: 'SELECT * FROM base' }];
      return undefined;
    });
    await refresh('mv', q);
    expect(calls.some(c => c.includes('DROP TABLE IF EXISTS "mv"'))).toBe(true);
    expect(calls.some(c => c.includes('CREATE TABLE "mv" AS SELECT * FROM base'))).toBe(true);
    expect(calls.some(c => c.includes('UPDATE __materialized_views SET refreshed_at'))).toBe(true);
  });

  it('refreshes from rows-format metadata', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT query_sql')) return { rows: [['SELECT * FROM base']] };
      return undefined;
    });
    await refresh('mv', q);
    expect(q).toHaveBeenCalled();
  });
});

describe('refreshConcurrently', () => {
  it('performs temp-table swap', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT query_sql')) return [{ query_sql: 'SELECT * FROM base' }];
      return undefined;
    });
    await refreshConcurrently('mv', q);
    const all = q.mock.calls.map(c => c[0]).join('\n');
    expect(all).toContain('__mv_temp_mv');
    expect(all).toContain('ALTER TABLE "__mv_temp_mv" RENAME TO "mv"');
  });

  it('performs temp-table swap (rows-format metadata)', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT query_sql')) return { rows: [['SELECT * FROM base']] };
      return undefined;
    });
    await refreshConcurrently('mv', q);
    const all = q.mock.calls.map(c => c[0]).join('\n');
    expect(all).toContain('__mv_temp_mv');
  });

  it('cleans up temp table on error', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT query_sql')) return [{ query_sql: 'SELECT * FROM base' }];
      if (sql.includes('DROP TABLE "mv"')) throw new Error('drop failed');
      return undefined;
    });
    await expect(refreshConcurrently('mv', q)).rejects.toThrow('drop failed');
    expect(q.mock.calls.some(c => c[0].includes('DROP TABLE IF EXISTS "__mv_temp_mv"'))).toBe(true);
  });

  it('throws when view not found', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT query_sql')) return { rows: [] };
      return undefined;
    });
    await expect(refreshConcurrently('missing', q)).rejects.toThrow('not found');
  });

  it('throws when array element lacks query_sql', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT query_sql')) return [{}];
      return undefined;
    });
    await expect(refreshConcurrently('missing', q)).rejects.toThrow('not found');
  });
});

describe('detectRefreshConcurrently / rewriteRefreshConcurrently', () => {
  it('detects concurrent refresh', () => {
    expect(detectRefreshConcurrently('REFRESH MATERIALIZED VIEW CONCURRENTLY mv')).toBe(true);
    expect(detectRefreshConcurrently('REFRESH MATERIALIZED VIEW mv')).toBe(false);
  });

  it('rewrites concurrent refresh (strips CONCURRENTLY)', () => {
    const r = rewriteRefreshConcurrently('REFRESH MATERIALIZED VIEW CONCURRENTLY mv');
    expect(r.isConcurrent).toBe(true);
    expect(r.viewName).toBe('mv');
    expect(r.sql).not.toContain('CONCURRENTLY');
  });

  it('rewrites non-concurrent refresh', () => {
    const r = rewriteRefreshConcurrently('REFRESH MATERIALIZED VIEW mv');
    expect(r.isConcurrent).toBe(false);
    expect(r.viewName).toBe('mv');
  });

  it('handles quoted view name', () => {
    const r = rewriteRefreshConcurrently('REFRESH MATERIALIZED VIEW "mv"');
    expect(r.viewName).toBe('mv');
  });

  it('returns empty viewName when no match', () => {
    const r = rewriteRefreshConcurrently('random');
    expect(r.viewName).toBe('');
    expect(r.isConcurrent).toBe(false);
  });
});

describe('drop', () => {
  it('drops table and metadata', async () => {
    const q = makeQueryFn();
    await drop('mv', q);
    const all = q.mock.calls.map(c => c[0]).join('\n');
    expect(all).toContain('DROP TABLE IF EXISTS "mv"');
    expect(all).toContain("DELETE FROM __materialized_views WHERE view_name = 'mv'");
  });
});

describe('isStale', () => {
  it('returns true when no metadata (array empty)', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT created_at')) return [];
      return undefined;
    });
    expect(await isStale('mv', q)).toBe(true);
  });

  it('returns true when refreshed_at is missing', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT created_at')) return [{ created_at: 1, refreshed_at: null }];
      return undefined;
    });
    expect(await isStale('mv', q)).toBe(true);
  });

  it('returns true when created_at is missing', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT created_at')) return [{ created_at: null, refreshed_at: 2 }];
      return undefined;
    });
    expect(await isStale('mv', q)).toBe(true);
  });

  it('returns false when both timestamps present', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT created_at')) return [{ created_at: 1, refreshed_at: 2 }];
      return undefined;
    });
    expect(await isStale('mv', q)).toBe(false);
  });

  it('returns true for rows-format empty', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT created_at')) return { rows: [] };
      return undefined;
    });
    expect(await isStale('mv', q)).toBe(true);
  });

  it('returns false for rows-format with timestamps', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT created_at')) return { rows: [[1, 2]] };
      return undefined;
    });
    expect(await isStale('mv', q)).toBe(false);
  });
});
