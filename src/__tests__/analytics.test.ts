import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBAnalyticsManager } from '../analytics/DuckDBAnalyticsManager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `sqlvec-anal-${Date.now()}`);

describe('DuckDBAnalyticsManager', () => {
  let a: DuckDBAnalyticsManager;

  beforeAll(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    a = new DuckDBAnalyticsManager(path.join(TEST_DIR, 'test.db'));
    await a.init();
  });

  afterAll(async () => {
    await a.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('initializes', () => { expect(a.isAvailable).toBe(true); });
  it('executes SQL', async () => {
    const r = await a.execute('SELECT 42 AS n');
    expect(r.rows[0].n).toBe(42);
  });
  it('DDL + INSERT', async () => {
    await a.execRaw('CREATE TABLE x (id INT)');
    await a.execRaw('INSERT INTO x VALUES (1)');
    expect((await a.execute('SELECT count(*) as cnt FROM x')).rowCount).toBe(1);
  });
  it('setMemoryLimit', async () => { await a.setMemoryLimit(512); });
});
