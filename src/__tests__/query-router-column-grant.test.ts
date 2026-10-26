/**
 * Column-level privilege enforcement tests for QueryRouter.
 *
 * `enforceDmlColumnPrivileges` is the fail-closed gate that consults a
 * `ColumnGrantChecker` before INSERT/UPDATE/SELECT statements are routed. It is
 * reachable from the real `execute()` pipeline (invoked inside executeInternal
 * after statement post-processing), but the ordinary fast paths bypass it for
 * simple DML. Both the public-pipeline reachability and the full branch matrix
 * are exercised below — the former through a real `execute('... RETURNING')`
 * call, the latter by driving the checker through the public API with prepared
 * grants.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { ColumnGrantChecker } from '../security/ColumnGrantChecker';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

const cleanups: string[] = [];

function makeRouter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-cg-'));
  cleanups.push(dir);
  const p = path.join(dir, 's0.db');
  const db = new Database(p);
  const shards = [{ db, vectorIndex: null, readers: [], path: p }];
  const sm: any = {
    getAllShards: () => new Map([[0, shards[0]]]),
    getShard: (n: number) => shards[n],
    execShard: async (n: number, sql: string) => shards[n].db.exec(sql),
    queryShard: (n: number, sql: string, params?: any[]) => shards[n].db.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => { shards[0].db.exec(sql); },
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => { shards[0].db.exec(sqls.join(';')); },
    execBatchOnShard: async (n: number, sqls: string[]) => shards[0].db.exec(sqls.join(';')),
    rotateAllKeys: () => [{ success: true }],
  };
  const config: any = {
    enabled: true, dimension: 768, metric: VectorMetric.COSINE, mode: VectorMode.AUTO,
    bruteForceThreshold: 1000, indexType: VectorIndexType.FLAT, indexParams: {},
  };
  const qr: any = new QueryRouter(sm, {} as any, config);
  return { qr, db };
}

afterEach(() => {
  while (cleanups.length) {
    try { fs.rmSync(cleanups.pop()!, { recursive: true, force: true }); } catch {}
  }
});

describe('enforceDmlColumnPrivileges — public pipeline', () => {
  it('denies INSERT on an ungranted column via execute() RETURNING', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (id INT, secret TEXT)');
    const checker = new ColumnGrantChecker();
    qr.scope.columnGrantChecker = checker;
    qr.scope.setUser('alice');
    // No grants recorded → fail-closed for every column.
    await expect(
      qr.execute("INSERT INTO t (id, secret) VALUES (1, 'x') RETURNING id"),
    ).rejects.toThrow(/COLUMN_GRANT_DENIED/);
  });
});

describe('enforceDmlColumnPrivileges — branch matrix', () => {
  let qr: any;
  beforeEach(async () => {
    ({ qr } = makeRouter());
    await qr.execute('CREATE TABLE t (id INT, name TEXT, secret TEXT)');
    const checker = new ColumnGrantChecker();
    qr.scope.columnGrantChecker = checker;
    qr.scope.setUser('alice');
  });

  it('INSERT: grants on a subset allow only those columns', () => {
    const checker = qr.scope.columnGrantChecker as ColumnGrantChecker;
    checker.grantColumnPrivilege('alice', 't', 'INSERT', ['id', 'name']);
    // id + name granted, secret not granted → throw names secret.
    expect(() =>
      qr.enforceDmlColumnPrivileges(parseStmt("INSERT INTO t (id, name, secret) VALUES (1, 'a', 'b')")),
    ).toThrow(/secret/);
    // All granted columns pass.
    expect(() =>
      qr.enforceDmlColumnPrivileges(parseStmt("INSERT INTO t (id, name) VALUES (1, 'a')")),
    ).not.toThrow();
  });

  it('UPDATE: ungranted SET column is denied', () => {
    const checker = qr.scope.columnGrantChecker as ColumnGrantChecker;
    checker.grantColumnPrivilege('alice', 't', 'UPDATE', ['name']);
    expect(() =>
      qr.enforceDmlColumnPrivileges(parseStmt("UPDATE t SET secret = 'x' WHERE id = 1")),
    ).toThrow(/secret/);
    expect(() =>
      qr.enforceDmlColumnPrivileges(parseStmt("UPDATE t SET name = 'x' WHERE id = 1")),
    ).not.toThrow();
  });

  it('SELECT: ungranted selected column is denied', () => {
    const checker = qr.scope.columnGrantChecker as ColumnGrantChecker;
    checker.grantColumnPrivilege('alice', 't', 'SELECT', ['id', 'name']);
    expect(() =>
      qr.enforceDmlColumnPrivileges(parseStmt('SELECT id, secret FROM t')),
    ).toThrow(/secret/);
    expect(() =>
      qr.enforceDmlColumnPrivileges(parseStmt('SELECT id, name FROM t')),
    ).not.toThrow();
  });

  it('no-op when no checker is configured', () => {
    qr.scope.columnGrantChecker = null;
    expect(() =>
      qr.enforceDmlColumnPrivileges(parseStmt("INSERT INTO t (id) VALUES (1)")),
    ).not.toThrow();
  });
});

// Minimal inline import of the parser, kept local to avoid a module-level
// import cycle in the test's top (parseStatement is already exported).
import { parseStatement as parseStmt } from '../query/SqlParser';
