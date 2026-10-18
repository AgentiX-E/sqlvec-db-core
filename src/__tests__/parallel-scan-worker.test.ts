/**
 * parallel-scan-worker.test.ts — Coverage tests for parallel-scan-worker
 * (Piscina worker for intra-table parallel scanning).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import scanChunk, { ScanWorkerResult } from '../query/parallel-scan-worker';

let dbPath: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'parallel-scan-worker-'));
  dbPath = join(tmpDir, 'test.db');

  const db = new Database(dbPath);
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  const insert = db.prepare('INSERT INTO items (name) VALUES (?)');
  for (let i = 1; i <= 10; i++) {
    insert.run(`item-${i}`);
  }
  db.close();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('scanChunk (via appendRowIdFilter)', () => {
  it('scans a rowid range with no WHERE and no trailing clause', () => {
    const res = scanChunk({
      dbPath,
      baseSql: 'SELECT * FROM items',
      params: [],
      startRowId: 3,
      endRowId: 5,
    });
    expect(res.success).toBe(true);
    expect(res.error).toBeNull();
    expect(res.rowCount).toBe(3);
    const names = res.rows.map((r) => r.name);
    expect(names).toEqual(['item-3', 'item-4', 'item-5']);
  });

  it('folds the rowid predicate into an existing WHERE clause', () => {
    const res = scanChunk({
      dbPath,
      baseSql: "SELECT * FROM items WHERE name != 'item-2'",
      params: [],
      startRowId: 1,
      endRowId: 3,
    });
    expect(res.success).toBe(true);
    const ids = res.rows.map((r) => r.id);
    expect(ids).toEqual([1, 3]);
  });

  it('inserts the predicate before a trailing ORDER BY', () => {
    const res = scanChunk({
      dbPath,
      baseSql: 'SELECT * FROM items ORDER BY id DESC',
      params: [],
      startRowId: 4,
      endRowId: 6,
    });
    expect(res.success).toBe(true);
    const ids = res.rows.map((r) => r.id);
    expect(ids).toEqual([6, 5, 4]);
  });

  it('handles WHERE plus trailing GROUP BY', () => {
    const res = scanChunk({
      dbPath,
      baseSql: 'SELECT name, count(*) AS c FROM items WHERE id > 0 GROUP BY name',
      params: [],
      startRowId: 1,
      endRowId: 2,
    });
    expect(res.success).toBe(true);
    expect(res.rowCount).toBe(2);
  });

  it('binds base params plus rowid bounds in order', () => {
    const res = scanChunk({
      dbPath,
      baseSql: 'SELECT * FROM items WHERE id >= ?',
      params: [1],
      startRowId: 2,
      endRowId: 4,
    });
    expect(res.success).toBe(true);
    const ids = res.rows.map((r) => r.id);
    expect(ids).toEqual([2, 3, 4]);
  });

  it('returns failure when the database cannot be opened', () => {
    const res: ScanWorkerResult = scanChunk({
      dbPath: join(tmpDir, 'does-not-exist.db'),
      baseSql: 'SELECT * FROM items',
      params: [],
      startRowId: 1,
      endRowId: 2,
    });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    expect(res.rows).toEqual([]);
    expect(res.rowCount).toBe(0);
  });
});
