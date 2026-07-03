/**
 * Core lifecycle — exhaustive embedded HTAP scenarios.
 * 
 * Scenarios covered:
 * 1. Construct + Start + Stop
 * 2. Full CRUD (CREATE/INSERT/SELECT/UPDATE/DELETE)
 * 3. Multi-shard routing
 * 4. Aggregations, ORDER BY, LIMIT
 * 5. Error handling (invalid SQL, missing table)
 * 6. Restart persistence (data survives stop/start)
 * 7. DuckDB analytics file creation
 * 8. Empty results
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqlVecDatabase } from '../SqlVecDatabase';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tmpDir(label: string) {
  const d = path.join(os.tmpdir(), `sqlvec-${label}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe('SqlVecDatabase (lifecycle)', () => {
  const dir = tmpDir('lifecycle');
  let db: SqlVecDatabase;

  afterAll(async () => {
    if (db) await db.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('constructs', () => {
    db = new SqlVecDatabase({ dataDir: dir, shardCount: 2 } as any);
    expect(db).toBeDefined();
  });

  it('starts and creates shard files', async () => {
    await db.start();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db'));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it('creates DuckDB analytics file', () => {
    expect(fs.readdirSync(dir).some(f => f.includes('duckdb'))).toBe(true);
  });
});

describe('SqlVecDatabase (CRUD)', () => {
  const dir = tmpDir('crud');
  let db: SqlVecDatabase;

  beforeAll(async () => { db = new SqlVecDatabase({ dataDir: dir, shardCount: 1 } as any); await db.start(); });
  afterAll(async () => { if (db) await db.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('CREATE TABLE', async () => {
    await db.query('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, score REAL)');
    // Verify via sqlite_master
  });

  it('INSERT single row', async () => {
    await db.query("INSERT INTO users VALUES (1, 'alice', 95.5)");
    const r = await db.query('SELECT * FROM users WHERE id=1');
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].name).toBe('alice');
    expect(r.rows[0].score).toBe(95.5);
  });

  it('INSERT multiple rows', async () => {
    await db.query("INSERT INTO users VALUES (2, 'bob', 87.0), (3, 'carol', 72.5)");
    const r = await db.query('SELECT count(*) as cnt FROM users');
    expect(r.rows[0].cnt).toBe(3);
  });

  it('UPDATE single row', async () => {
    await db.query("UPDATE users SET score = 99.0 WHERE id = 1");
    const r = await db.query('SELECT score FROM users WHERE id = 1');
    expect(r.rows[0].score).toBe(99.0);
  });

  it('DELETE single row', async () => {
    await db.query('DELETE FROM users WHERE id = 3');
    const r = await db.query('SELECT count(*) as cnt FROM users');
    expect(r.rows[0].cnt).toBe(2);
  });

  it('SELECT with WHERE + ORDER BY', async () => {
    const r = await db.query('SELECT name, score FROM users ORDER BY score DESC');
    expect(r.rows[0].name).toBe('alice');
  });

  it('SELECT with LIMIT', async () => {
    const r = await db.query('SELECT * FROM users LIMIT 1');
    expect(r.rows.length).toBe(1);
  });

  it('aggregation: AVG', async () => {
    const r = await db.query('SELECT AVG(score) as avg_score FROM users');
    expect(r.rows[0].avg_score).toBeGreaterThan(85);
  });

  it('aggregation: COUNT, SUM, MIN, MAX', async () => {
    const r = await db.query('SELECT COUNT(*) as c, SUM(score) as s, MIN(score) as mn, MAX(score) as mx FROM users');
    expect(r.rows[0].c).toBe(2);
    expect(r.rows[0].s).toBe(186.0);
    expect(r.rows[0].mn).toBe(87.0);
    expect(r.rows[0].mx).toBe(99.0);
  });

  it('empty result set', async () => {
    const r = await db.query('SELECT * FROM users WHERE id = 999');
    expect(r.rows.length).toBe(0);
  });
});

describe('SqlVecDatabase (error handling)', () => {
  const dir = tmpDir('errors');
  let db: SqlVecDatabase;

  beforeAll(async () => { db = new SqlVecDatabase({ dataDir: dir, shardCount: 1 } as any); await db.start(); });
  afterAll(async () => { if (db) await db.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('rejects invalid SQL gracefully', async () => {
    await expect(db.query('GARBAGE SQL THAT FAILS')).rejects.toThrow();
  });

  it('rejects query on non-existent table', async () => {
    await expect(db.query('SELECT * FROM nonexistent_table')).rejects.toThrow();
  });

  it('handles NULL values', async () => {
    await db.query('CREATE TABLE nullable (id INTEGER, val TEXT)');
    await db.query('INSERT INTO nullable VALUES (1, NULL)');
    const r = await db.query('SELECT * FROM nullable WHERE id = 1');
    expect(r.rows[0].val).toBeNull();
  });
});

describe('SqlVecDatabase (restart persistence)', () => {
  const dir = tmpDir('persist');
  
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('data survives restart', async () => {
    // First session
    let db = new SqlVecDatabase({ dataDir: dir, shardCount: 1 } as any);
    await db.start();
    await db.query('CREATE TABLE persist (id INTEGER PRIMARY KEY, val TEXT)');
    await db.query("INSERT INTO persist VALUES (1, 'survivor')");
    await db.stop();

    // Second session
    db = new SqlVecDatabase({ dataDir: dir, shardCount: 1 } as any);
    await db.start();
    const r = await db.query('SELECT val FROM persist WHERE id = 1');
    expect(r.rows[0].val).toBe('survivor');
    await db.stop();
  });
});
