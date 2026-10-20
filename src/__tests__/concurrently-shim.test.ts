/**
 * concurrently-shim.test.ts — Coverage tests for ConcurrentlyShim
 * (PostgreSQL CREATE/DROP INDEX CONCURRENTLY simulation).
 */

import { describe, it, expect } from 'vitest';
import {
  detectConcurrentDDL,
  rewriteCreateIndexConcurrently,
  rewriteDropIndexConcurrently,
  executeCreateIndexConcurrently,
  executeDropIndexConcurrently,
  validateConcurrentIndex,
} from '../query/ConcurrentlyShim';

// A minimal fake better-sqlite3-like database for execution/validation tests.
function fakeDb(overrides: {
  exec?: (sql: string) => void;
  row?: unknown;
  indexInfo?: unknown[];
} = {}) {
  const calls: string[] = [];
  return {
    calls,
    exec(sql: string) {
      calls.push(sql);
      if (overrides.exec) overrides.exec(sql);
    },
    prepare(query: string) {
      calls.push(query);
      return {
        get(_p?: string) {
          return overrides.row;
        },
        all() {
          return overrides.indexInfo ?? [];
        },
      };
    },
  };
}

describe('detectConcurrentDDL', () => {
  it('detects CREATE INDEX CONCURRENTLY', () => {
    const r = detectConcurrentDDL('CREATE INDEX CONCURRENTLY ix ON t (col)');
    expect(r).toEqual({ type: 'CREATE', concurrent: true, indexName: 'ix', tableName: 't' });
  });

  it('detects CREATE UNIQUE INDEX CONCURRENTLY', () => {
    const r = detectConcurrentDDL('CREATE UNIQUE INDEX CONCURRENTLY ix ON t (col)');
    expect(r.type).toBe('CREATE');
    expect(r.concurrent).toBe(true);
    expect(r.indexName).toBe('ix');
  });

  it('detects CREATE INDEX CONCURRENTLY IF NOT EXISTS', () => {
    const r = detectConcurrentDDL('CREATE INDEX CONCURRENTLY IF NOT EXISTS ix ON t (col)');
    expect(r.concurrent).toBe(true);
    expect(r.indexName).toBe('ix');
  });

  it('detects DROP INDEX CONCURRENTLY', () => {
    const r = detectConcurrentDDL('DROP INDEX CONCURRENTLY ix');
    expect(r).toEqual({ type: 'DROP', concurrent: true, indexName: 'ix' });
  });

  it('detects DROP INDEX CONCURRENTLY IF EXISTS', () => {
    const r = detectConcurrentDDL('DROP INDEX CONCURRENTLY IF EXISTS ix');
    expect(r.concurrent).toBe(true);
    expect(r.indexName).toBe('ix');
  });

  it('detects plain CREATE INDEX (not concurrent)', () => {
    const r = detectConcurrentDDL('CREATE INDEX ix ON t (col)');
    expect(r).toEqual({ type: 'CREATE', concurrent: false });
  });

  it('detects plain DROP INDEX (not concurrent)', () => {
    const r = detectConcurrentDDL('DROP INDEX ix');
    expect(r).toEqual({ type: 'DROP', concurrent: false });
  });

  it('returns default for unrelated SQL', () => {
    const r = detectConcurrentDDL('SELECT 1');
    expect(r).toEqual({ type: 'CREATE', concurrent: false });
  });
});

describe('rewriteCreateIndexConcurrently', () => {
  it('strips CONCURRENTLY keyword', () => {
    const r = rewriteCreateIndexConcurrently('CREATE INDEX CONCURRENTLY ix ON t (col)');
    expect(r).toContain('/* CONCURRENTLY */');
    expect(r).not.toContain(/\bCONCURRENTLY\b/);
  });

  it('returns unchanged when no CONCURRENTLY keyword', () => {
    const input = 'CREATE INDEX ix ON t (col)';
    expect(rewriteCreateIndexConcurrently(input)).toBe(input);
  });
});

describe('rewriteDropIndexConcurrently', () => {
  it('strips CONCURRENTLY keyword', () => {
    const r = rewriteDropIndexConcurrently('DROP INDEX CONCURRENTLY ix');
    expect(r).toContain('/* CONCURRENTLY */');
  });

  it('returns unchanged when no CONCURRENTLY keyword', () => {
    const input = 'DROP INDEX ix';
    expect(rewriteDropIndexConcurrently(input)).toBe(input);
  });
});

describe('validateConcurrentIndex', () => {
  it('returns valid for existing index with column info', () => {
    const db = fakeDb({ row: { name: 'ix' }, indexInfo: [{ seqno: 0, name: 'col' }] });
    const r = validateConcurrentIndex(db, 'ix');
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('returns invalid when index not found', () => {
    const db = fakeDb({ row: undefined, indexInfo: [] });
    const r = validateConcurrentIndex(db, 'ix');
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('Index "ix" not found in sqlite_master');
  });

  it('returns invalid when index has no column info', () => {
    const db = fakeDb({ row: { name: 'ix' }, indexInfo: [] });
    const r = validateConcurrentIndex(db, 'ix');
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('Index "ix" has no column information');
  });

  it('returns invalid when prepare throws', () => {
    const db = fakeDb();
    db.prepare = () => {
      throw new Error('boom');
    };
    const r = validateConcurrentIndex(db, 'ix');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('Validation error');
  });
});

describe('executeCreateIndexConcurrently', () => {
  it('executes and validates successfully', async () => {
    const db = fakeDb({ row: { name: 'ix' }, indexInfo: [{ seqno: 0, name: 'col' }] });
    const r = await executeCreateIndexConcurrently(db, {
      indexName: 'ix',
      tableName: 't',
      columns: 'col',
      unique: false,
    });
    expect(r.success).toBe(true);
    expect(r.actualIndexName).toBe('ix');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(db.calls.some((c) => c.includes('CREATE INDEX'))).toBe(true);
  });

  it('includes UNIQUE and WHERE clauses when configured', async () => {
    const db = fakeDb({ row: { name: 'ix' }, indexInfo: [{ seqno: 0, name: 'col' }] });
    await executeCreateIndexConcurrently(db, {
      indexName: 'ix',
      tableName: 't',
      columns: 'col',
      unique: true,
      whereClause: 'col > 0',
    });
    const createSql = db.calls.find((c) => c.includes('CREATE'));
    expect(createSql).toContain('UNIQUE');
    expect(createSql).toContain('WHERE col > 0');
  });

  it('returns failure when exec throws', async () => {
    const db = fakeDb({ exec: () => { throw new Error('exec fail'); } });
    const r = await executeCreateIndexConcurrently(db, {
      indexName: 'ix',
      tableName: 't',
      columns: 'col',
      unique: false,
    });
    expect(r.success).toBe(false);
    expect(r.actualIndexName).toBe('ix');
  });

  it('still succeeds when validation reports issues (index missing)', async () => {
    // Validation returns invalid (index not found), but executeCreateIndex
    // only logs a warning and still reports success — covering the
    // `if (!validation.valid)` warning branch.
    const db = fakeDb({ row: undefined, indexInfo: [] });
    const r = await executeCreateIndexConcurrently(db, {
      indexName: 'ix',
      tableName: 't',
      columns: 'col',
      unique: false,
    });
    expect(r.success).toBe(true);
    expect(r.actualIndexName).toBe('ix');
  });
});

describe('executeDropIndexConcurrently', () => {
  it('executes and returns success', async () => {
    const db = fakeDb({ row: { name: 'ix' }, indexInfo: [{ seqno: 0, name: 'col' }] });
    const r = await executeDropIndexConcurrently(db, 'ix');
    expect(r.success).toBe(true);
    expect(db.calls.some((c) => c.includes('DROP INDEX'))).toBe(true);
  });

  it('returns failure when exec throws', async () => {
    const db = fakeDb({ exec: () => { throw new Error('drop fail'); } });
    const r = await executeDropIndexConcurrently(db, 'ix');
    expect(r.success).toBe(false);
  });
});
