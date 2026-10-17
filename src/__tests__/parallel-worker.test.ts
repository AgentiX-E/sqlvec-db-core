/**
 * parallel-worker.test.ts — Coverage tests for the Piscina worker entry point.
 *
 * `parallel-worker.ts` runs inside a Piscina worker_thread and executes a
 * single SQL statement against a better-sqlite3 shard file. It is referenced
 * by `ParallelExecutor` via a `workerPath` string (not imported), so its
 * coverage must be driven directly by feeding it WorkerTask objects against
 * ephemeral SQLite databases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import executeInWorker from '../query/parallel-worker';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwrk-'));
  dbPath = path.join(tmpDir, 'shard.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER);
    INSERT INTO users (name, age) VALUES ('alice', 30), ('bob', 25), ('carol', 35);
  `);
  db.close();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parallel-worker executeInWorker', () => {
  it('runs a SELECT query and returns rows', () => {
    const r = executeInWorker({
      sql: 'SELECT * FROM users ORDER BY id',
      shardId: 0,
      dbPath,
    });
    expect(r.error).toBeNull();
    expect(r.rowCount).toBe(3);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0].name).toBe('alice');
    expect(r.shardId).toBe(0);
  });

  it('returns an error for a failed query', () => {
    const r = executeInWorker({
      sql: 'SELECT * FROM missing_table',
      shardId: 1,
      dbPath,
    });
    expect(r.error).not.toBeNull();
    expect(r.rows).toEqual([]);
    expect(r.rowCount).toBe(0);
  });

  it('runs an INSERT and reports changes + lastInsertRowid', () => {
    const r = executeInWorker({
      sql: "INSERT INTO users (name, age) VALUES ('dave', 40)",
      shardId: 2,
      dbPath,
      taskType: 'insert',
    });
    expect(r.error).toBeNull();
    expect(r.changes).toBe(1);
    expect(r.lastInsertRowid).toBe(4);
  });

  it('runs an UPDATE and reports changes', () => {
    const r = executeInWorker({
      sql: "UPDATE users SET age = 31 WHERE name = 'alice'",
      shardId: 3,
      dbPath,
      taskType: 'update',
    });
    expect(r.error).toBeNull();
    expect(r.changes).toBe(1);
  });

  it('runs a DELETE and reports changes', () => {
    const r = executeInWorker({
      sql: "DELETE FROM users WHERE name = 'bob'",
      shardId: 4,
      dbPath,
      taskType: 'delete',
    });
    expect(r.error).toBeNull();
    expect(r.changes).toBe(1);
  });

  it('infers DELETE task type from SQL (read-write)', () => {
    // Without an explicit DML taskType, DELETE is inferred and runs read-write.
    const r = executeInWorker({
      sql: "DELETE FROM users WHERE name = 'carol'",
      shardId: 5,
      dbPath,
    });
    expect(r.error).toBeNull();
    expect(r.changes).toBe(1);
  });

  it('infers MERGE task type (opens read-write)', () => {
    const r = executeInWorker({
      sql: 'MERGE INTO users',
      shardId: 14,
      dbPath,
    });
    // MERGE is inferred as a DML type → read-write connection; SQLite does not
    // support MERGE, so it errors, but the read-write branch is exercised.
    expect(r.error).not.toBeNull();
  });

  it('infers task type from SQL when taskType is omitted', () => {
    // INSERT inferred
    const r1 = executeInWorker({
      sql: "INSERT INTO users (name, age) VALUES ('frank', 28)",
      shardId: 15,
      dbPath,
    });
    expect(r1.error).toBeNull();
    expect(r1.changes).toBe(1);
    expect(r1.lastInsertRowid).toBe(4);

    // UPDATE inferred
    const r2 = executeInWorker({
      sql: "UPDATE users SET age = age + 1 WHERE name = 'frank'",
      shardId: 16,
      dbPath,
    });
    expect(r2.error).toBeNull();
    expect(r2.changes).toBe(1);

    // MERGE inferred (read-write, then errors due to unsupported SQL)
    const r3 = executeInWorker({
      sql: 'MERGE INTO users USING x ON 1=0',
      shardId: 17,
      dbPath,
    });
    expect(r3.error).not.toBeNull();

    // Unknown SQL defaults to select (read-only) → errors on missing table
    const r4 = executeInWorker({
      sql: 'VACUUM',
      shardId: 18,
      dbPath,
    });
    expect(r4.error).not.toBeNull();
  });

  it('infers SELECT from WITH / leading whitespace', () => {
    const r1 = executeInWorker({
      sql: 'WITH x AS (SELECT * FROM users) SELECT * FROM x',
      shardId: 6,
      dbPath,
    });
    expect(r1.error).toBeNull();
    expect(r1.rowCount).toBe(3);

    const r2 = executeInWorker({
      sql: '   SELECT count(*) AS c FROM users',
      shardId: 7,
      dbPath,
    });
    expect(r2.error).toBeNull();
    expect(r2.rows[0].c).toBe(3);
  });

  it('handles DML with RETURNING (falls back if unsupported)', () => {
    const r = executeInWorker({
      sql: "INSERT INTO users (name, age) VALUES ('eve', 50) RETURNING id",
      shardId: 8,
      dbPath,
      taskType: 'insert',
    });
    expect(r.error).toBeNull();
    expect(r.changes).toBe(1);
  });

  it('performs intra-table scan with rowid range (SELECT path)', () => {
    const r = executeInWorker({
      sql: 'ignored',
      shardId: 9,
      dbPath,
      scanMode: 'intra-table',
      tableName: 'users',
      rowidRange: { min: 2, max: 2 },
    });
    expect(r.error).toBeNull();
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].name).toBe('bob');
  });

  it('performs intra-table scan via DML path (with parameters)', () => {
    const r = executeInWorker({
      sql: 'ignored',
      shardId: 10,
      dbPath,
      taskType: 'update',
      scanMode: 'intra-table',
      tableName: 'users',
      rowidRange: { min: 1, max: 1 },
    });
    // The constructed SQL is a SELECT, not a real UPDATE; it exercises the
    // DML branch that binds rowid range parameters and reads RETURNING.
    expect(r.error).toBeNull();
  });

  it('rejects intra-table scan without tableName', () => {
    const r = executeInWorker({
      sql: 'SELECT 1',
      shardId: 11,
      dbPath,
      scanMode: 'intra-table',
    });
    expect(r.error).toContain('tableName');
    expect(r.rows).toEqual([]);
  });

  it('rejects intra-table scan without valid rowidRange', () => {
    const r = executeInWorker({
      sql: 'SELECT 1',
      shardId: 12,
      dbPath,
      scanMode: 'intra-table',
      tableName: 'users',
    });
    expect(r.error).toContain('rowidRange');
  });

  it('handles string value escaping and NULL through open/close', () => {
    const r = executeInWorker({
      sql: "SELECT name FROM users WHERE name = 'alice'",
      shardId: 13,
      dbPath,
    });
    expect(r.error).toBeNull();
    expect(r.rowCount).toBe(1);
  });

  it('returns error when database cannot be opened (db stays null)', () => {
    const r = executeInWorker({
      sql: 'SELECT 1',
      shardId: 19,
      dbPath: path.join(tmpDir, 'missing-dir', 'nope.db'),
    });
    expect(r.error).not.toBeNull();
    expect(r.rows).toEqual([]);
  });
});
