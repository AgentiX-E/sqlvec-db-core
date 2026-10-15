import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import buildSubIndexWorker, {
  type IndexWorkerTask,
} from '../index/parallel-index-worker';

describe('parallel-index-worker', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `piw-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE t (a INTEGER, b TEXT, r REAL);
      INSERT INTO t (rowid, a, b, r) VALUES (1, 10, 'x', 1.5);
      INSERT INTO t (rowid, a, b, r) VALUES (2, 20, 'y', 2.5);
      INSERT INTO t (rowid, a, b, r) VALUES (3, 30, 'z', 3.5);
    `);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
    // also clean any part-table side files
    for (const f of [dbPath + '-wal', dbPath + '-shm']) {
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  });

  function build(overrides: Partial<IndexWorkerTask> = {}) {
    return buildSubIndexWorker({
      taskType: 'build-sub-index',
      dbPath,
      tableName: 't',
      indexName: 'ix',
      columns: ['a', 'b'],
      range: { min: 1, max: 3 },
      workerId: 0,
      ...overrides,
    });
  }

  it('builds a sub-index successfully', () => {
    const r = build();
    expect(r.success).toBe(true);
    expect(r.workerId).toBe(0);
    expect(r.rowCount).toBe(3);
    expect(r.error).toBeNull();
    expect(r.timeMs).toBeGreaterThanOrEqual(0);
  });

  it('respects the rowid range (subset of rows)', () => {
    const r = build({ range: { min: 1, max: 2 } });
    expect(r.success).toBe(true);
    expect(r.rowCount).toBe(2);
  });

  it('applies a WHERE filter for partial indexes', () => {
    const r = build({ where: 'a > 10', range: { min: 1, max: 3 } });
    expect(r.success).toBe(true);
    expect(r.rowCount).toBe(2); // rows with a=20,30
  });

  it('creates a UNIQUE index when unique=true', () => {
    const r = build({ unique: true });
    expect(r.success).toBe(true);
    expect(r.rowCount).toBe(3);
  });

  it('dedupes explicit rowid aliases from the indexed columns', () => {
    const r = build({ columns: ['rowid', 'a', '_rowid_', 'oid', 'b'] });
    expect(r.success).toBe(true);
    expect(r.rowCount).toBe(3);
  });

  it('dedupes repeated columns (Set)', () => {
    const r = build({ columns: ['a', 'a', 'b', 'a'] });
    expect(r.success).toBe(true);
    expect(r.rowCount).toBe(3);
  });

  it('reports schema-free columns as TEXT type without error', () => {
    const r = build({ columns: ['b'] });
    expect(r.success).toBe(true);
    expect(r.rowCount).toBe(3);
  });

  it('returns failure with error message for a missing table', () => {
    const r = build({ tableName: 'nope' });
    expect(r.success).toBe(false);
    expect(r.workerId).toBe(0);
    expect(r.rowCount).toBe(0);
    expect(r.error).toContain('no such table');
  });

  it('returns failure for an invalid database path', () => {
    const r = buildSubIndexWorker({
      taskType: 'build-sub-index',
      dbPath: path.join(os.tmpdir(), 'definitely-missing-dir', 'x.db'),
      tableName: 't',
      indexName: 'ix',
      columns: ['a'],
      range: { min: 1, max: 3 },
      workerId: 7,
    });
    expect(r.success).toBe(false);
    expect(r.workerId).toBe(7);
    expect(r.error).toBeTruthy();
  });

  it('returns failure when a column does not exist in the source table', () => {
    const r = build({ columns: ['nonexistent_col'] });
    expect(r.success).toBe(false);
    expect(r.error).toContain('no such column');
  });

  it('handles an empty row count range (min > max)', () => {
    const r = build({ range: { min: 5, max: 1 } });
    expect(r.success).toBe(true);
    expect(r.rowCount).toBe(0);
  });
});
