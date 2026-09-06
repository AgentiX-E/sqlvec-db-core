/**
 * sqlvec-db-core smoke test
 *
 * Verifies the embedded engine starts cleanly and creates SQLite shards.
 * DuckDB runs natively in 'no-scanner' mode (sqlite_scanner deferred to
 * avoid duckdb@1.4.4 crash on Node 22).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqlVecDatabase } from '../SqlVecDatabase';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `sqlvec-smoke-${Date.now()}`);

describe('SqlVecDatabase', () => {
  let db: SqlVecDatabase;

  beforeAll(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = new SqlVecDatabase({ dataDir: TEST_DIR, shardCount: 1 } as any);
    await db.start();
  }, 60000);

  afterAll(async () => {
    if (db) await db.stop();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('constructs successfully', () => {
    expect(db).toBeDefined();
  });

  it('creates SQLite shard file', () => {
    const shardFiles = fs.readdirSync(TEST_DIR).filter(f => f.endsWith('.db'));
    expect(shardFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('creates DuckDB analytics file', () => {
    const duckFiles = fs.readdirSync(TEST_DIR).filter(f => f.includes('duckdb'));
    expect(duckFiles.length).toBeGreaterThanOrEqual(1);
  });
});
