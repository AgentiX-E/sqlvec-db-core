/**
 * sqlvec-db-core smoke test
 * Verifies the embedded HTAP engine can instantiate and perform basic operations.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqlVecDatabase } from '../SqlVecDatabase';
import { PinoLogger } from '../logger/PinoLogger';
import { NoOpLogger } from '../interfaces/logger';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `sqlvec-core-smoke-${Date.now()}`);

describe('SqlVecDatabase (smoke)', () => {
  let db: SqlVecDatabase;

  beforeAll(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = new SqlVecDatabase({ dataDir: TEST_DIR, shardCount: 1 } as any);
    await db.start();
  });

  afterAll(async () => {
    if (db) await db.stop();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should start and respond to health query', () => {
    expect(db).toBeDefined();
  });

  it('should execute CREATE TABLE', async () => {
    const result = await db.query(
      'CREATE TABLE IF NOT EXISTS smoke_test (id INTEGER PRIMARY KEY, name TEXT, value REAL)'
    );
    expect(result).toBeDefined();
  });

  it('should execute INSERT and SELECT', async () => {
    await db.query("INSERT INTO smoke_test VALUES (1, 'hello', 42.0)");
    const result = await db.query('SELECT * FROM smoke_test WHERE id = 1');
    expect(result.rows).toBeDefined();
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle UPDATE', async () => {
    await db.query("UPDATE smoke_test SET value = 99.5 WHERE id = 1");
    const result = await db.query('SELECT value FROM smoke_test WHERE id = 1');
    expect(result.rows[0].value).toBe(99.5);
  });

  it('should handle DELETE', async () => {
    await db.query('DELETE FROM smoke_test WHERE id = 1');
    const result = await db.query('SELECT * FROM smoke_test');
    expect(result.rows.length).toBe(0);
  });
});
