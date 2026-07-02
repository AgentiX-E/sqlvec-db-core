/**
 * sqlvec-db-core smoke test
 *
 * OLTP-only verification. DuckDB is mocked to avoid native binary
 * compatibility issues in CI. OLAP testing is done in integration tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock DuckDB BEFORE any module imports it
vi.mock('duckdb', () => ({
  default: {
    Database: vi.fn(function() {
      return {
        connect() {
          return {
            all(_s: string, cb: Function) { cb?.(null, []); },
            exec(_s: string, cb: Function) { cb?.(null); },
            close() {},
          };
        },
        close() {},
      };
    }),
  },
}));

import { SqlVecDatabase } from '../SqlVecDatabase';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `sqlvec-core-smoke-${Date.now()}`);

describe('SqlVecDatabase', () => {
  let db: SqlVecDatabase;

  beforeAll(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = new SqlVecDatabase({ dataDir: TEST_DIR, shardCount: 1 } as any);
    await db.start();
  }, 15000);

  afterAll(async () => {
    if (db) await db.stop();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should construct', () => expect(db).toBeDefined());
  it('should create a SQLite shard file', () => {
    expect(fs.readdirSync(TEST_DIR).some(f => f.endsWith('.db'))).toBe(true);
  });
});
