/**
 * SqlVecDatabase lifecycle test — real embedded engine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqlVecDatabase } from '../SqlVecDatabase';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `sqlvec-lifecycle-${Date.now()}`);

describe('SqlVecDatabase lifecycle', () => {
  let db: SqlVecDatabase;

  beforeAll(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = new SqlVecDatabase({ dataDir: TEST_DIR, shardCount: 2 } as any);
    await db.start();
  });

  afterAll(async () => {
    if (db) await db.stop();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('starts and creates shard files', () => {
    expect(db).toBeDefined();
    expect(fs.readdirSync(TEST_DIR).filter(f => f.endsWith('.db')).length).toBeGreaterThanOrEqual(2);
  });

  it('executes CREATE TABLE via query', async () => {
    const result = await db.query(
      'CREATE TABLE IF NOT EXISTS lifecycle (id INTEGER PRIMARY KEY, name TEXT, score REAL)'
    );
    expect(result).toBeDefined();
  });

  it('executes INSERT', async () => {
    await db.query("INSERT INTO lifecycle VALUES (1, 'alice', 95.5)");
    await db.query("INSERT INTO lifecycle VALUES (2, 'bob', 87.0)");
    const result = await db.query('SELECT count(*) as cnt FROM lifecycle');
    expect(result.rows[0].cnt).toBe(2);
  });

  it('executes UPDATE', async () => {
    await db.query("UPDATE lifecycle SET score = 99.0 WHERE id = 1");
    const result = await db.query('SELECT score FROM lifecycle WHERE id = 1');
    expect(result.rows[0].score).toBe(99.0);
  });

  it('executes DELETE', async () => {
    await db.query('DELETE FROM lifecycle WHERE id = 2');
    const result = await db.query('SELECT count(*) as cnt FROM lifecycle');
    expect(result.rows[0].cnt).toBe(1);
  });

  it('executes SELECT with aggregate', async () => {
    await db.query("INSERT INTO lifecycle VALUES (3, 'carol', 72.0)");
    const result = await db.query('SELECT AVG(score) as avg_score FROM lifecycle');
    expect(result.rows[0].avg_score).toBeGreaterThan(70);
  });

  it('executes ORDER BY and LIMIT', async () => {
    const result = await db.query('SELECT name FROM lifecycle ORDER BY score DESC LIMIT 1');
    expect(result.rows.length).toBe(1);
  });

  it('handles empty result set', async () => {
    const result = await db.query('SELECT * FROM lifecycle WHERE id = 999');
    expect(result.rows.length).toBe(0);
  });

  it('creates DuckDB analytics file', () => {
    const hasDuck = fs.readdirSync(TEST_DIR).some(f => f.includes('duckdb'));
    expect(hasDuck).toBe(true);
  });
});
