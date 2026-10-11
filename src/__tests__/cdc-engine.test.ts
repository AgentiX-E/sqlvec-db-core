import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CDCEngine } from '../analytics/CDCEngine';
import { OLAPSchemaManager } from '../analytics/OLAPSchemaManager';
import type { DataBridgeConfig, TableChanges } from '../analytics/DataBridge';
import type { ShardHandle } from '../storage/ShardManager';

function makeConfig(overrides: Partial<DataBridgeConfig> = {}): DataBridgeConfig {
  return {
    enabled: true,
    mode: 'incremental',
    tickIntervalMs: 100,
    batchSize: 500,
    fullSyncOnStart: true,
    fullSyncIfStaleMs: 3_600_000,
    localColumnar: { enabled: true },
    ...overrides,
  };
}

function makeSchemaManager(tablesByShard: Record<number, string[]>): OLAPSchemaManager {
  const mgr = Object.create(OLAPSchemaManager.prototype);
  mgr.getMonitoredTables = (shardId: number): string[] => tablesByShard[shardId] ?? [];
  return mgr as OLAPSchemaManager;
}

function makeShard(shardId: number, db: Database.Database): ShardHandle {
  return { shardId, db } as unknown as ShardHandle;
}

describe('CDCEngine — trigger & table infrastructure', () => {
  let db: Database.Database;
  let shard: ShardHandle;
  let engine: CDCEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    shard = makeShard(0, db);
    engine = new CDCEngine({} as any, makeSchemaManager({ 0: ['users'] }), makeConfig());
  });

  afterEach(() => {
    db.close();
  });

  it('ensureCDCTable creates the changelog table idempotently', () => {
    engine.ensureCDCTable(shard);
    engine.ensureCDCTable(shard); // idempotent
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(CDCEngine.CDC_TABLE) as any;
    expect(row.name).toBe(CDCEngine.CDC_TABLE);
  });

  it('ensureTableTriggers creates INSERT/UPDATE/DELETE triggers', () => {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    engine.ensureTableTriggers(shard, 'users');
    const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as any[];
    expect(triggers.map((t: any) => t.name)).toEqual([
      '_cdc_trig_I_users',
      '_cdc_trig_U_users',
      '_cdc_trig_D_users',
    ]);
  });

  it('ensureTableTriggers escapes quotes in table names', () => {
    db.exec(`CREATE TABLE "we""ird" (id INTEGER PRIMARY KEY, name TEXT)`);
    engine.ensureTableTriggers(shard, 'we"ird');
    const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as any[];
    expect(triggers.length).toBe(3);
  });

  it('ensureCDCTables skips internal tables and is resilient to errors', () => {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE _cdc_internal (id INTEGER PRIMARY KEY)');
    engine.ensureCDCTables(shard);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as any[];
    expect(tables.map((t: any) => t.name)).toContain(CDCEngine.CDC_TABLE);
    // _cdc_internal should NOT have triggers
    const trig = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%_cdc_internal'`).all() as any[];
    expect(trig.length).toBe(0);
  });

  it('ensureCDCTables falls back gracefully on failure', () => {
    // A shard whose db.exec throws should not propagate
    const brokenShard = makeShard(1, { exec: () => { throw new Error('boom'); } } as any);
    expect(() => engine.ensureCDCTables(brokenShard)).not.toThrow();
  });

  it('hasCDCTable returns true when table exists, false otherwise', () => {
    expect(engine.hasCDCTable(shard)).toBe(false);
    engine.ensureCDCTable(shard);
    expect(engine.hasCDCTable(shard)).toBe(true);
  });

  it('hasCDCTable returns false on query error', () => {
    const brokenShard = makeShard(2, { prepare: () => { throw new Error('x'); } } as any);
    expect(engine.hasCDCTable(brokenShard)).toBe(false);
  });
});

describe('CDCEngine — readChangelog (trigger-based, no GC)', () => {
  let db: Database.Database;
  let shard: ShardHandle;
  let engine: CDCEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    shard = makeShard(0, db);
    engine = new CDCEngine({} as any, makeSchemaManager({ 0: ['users'] }), makeConfig());
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    engine.ensureCDCTable(shard);
    engine.ensureTableTriggers(shard, 'users');
  });

  afterEach(() => db.close());

  it('returns empty when no CDC table exists', () => {
    const noTableShard = makeShard(7, new Database(':memory:'));
    const r = engine.readChangelog(noTableShard);
    expect(r.changes).toEqual([]);
    expect(r.maxSeq).toBe(0);
    (noTableShard.db as any).close();
  });

  it('returns empty when no tables are monitored', () => {
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: [] }), makeConfig());
    const r = e2.readChangelog(shard);
    expect(r.changes).toEqual([]);
  });

  it('captures INSERT, UPDATE, DELETE events and reads row data', () => {
    db.prepare('INSERT INTO users (name) VALUES (?)').run('alice');
    db.prepare('INSERT INTO users (name) VALUES (?)').run('bob');
    db.prepare('UPDATE users SET name = ? WHERE id = 1').run('alice2');
    db.prepare('DELETE FROM users WHERE id = 2').run();

    const r = engine.readChangelog(shard);
    // 1 insert (id=1 updated so still visible as insert), 1 update, 1 delete
    expect(r.maxSeq).toBeGreaterThan(0);
    const users = r.changes.find((c) => c.tableName === 'users');
    expect(users).toBeDefined();
    expect(users!.inserts.length).toBe(1);
    expect(users!.updates.length).toBe(1);
    expect(users!.deletes.length).toBe(1);
    expect(users!.inserts[0].name).toBe('alice2');
    expect(users!.updates[0].row.name).toBe('alice2');
  });

  it('skips tables not monitored and internal CDC tables', () => {
    db.exec('CREATE TABLE other (id INTEGER PRIMARY KEY)');
    engine.ensureTableTriggers(shard, 'other');
    db.prepare('INSERT INTO users (name) VALUES (?)').run('a');
    db.prepare('INSERT INTO other (id) VALUES (?)').run(1);

    const r = engine.readChangelog(shard);
    // only 'users' is monitored, 'other' is skipped
    expect(r.changes.map((c) => c.tableName)).toEqual(['users']);
  });

  it('reclassifies MVCC soft-deletes (UPDATE with _xmax) as deletes', () => {
    db.exec('DROP TABLE users');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, _xmax INTEGER)');
    engine.ensureTableTriggers(shard, 'users');
    db.prepare('INSERT INTO users (id, name, _xmax) VALUES (?, ?, ?)').run(1, 'a', 0);
    // Simulate MVCC tombstones: UPDATE sets _xmax to a non-zero XID
    db.prepare('UPDATE users SET _xmax = ? WHERE id = 1').run(99);

    const r = engine.readChangelog(shard);
    const users = r.changes.find((c) => c.tableName === 'users');
    expect(users!.deletes).toContain(1);
  });

  it('captures DELETE-only events (no row data)', () => {
    db.prepare('INSERT INTO users (name) VALUES (?)').run('x');
    db.prepare('DELETE FROM users WHERE id = 1').run();

    const r = engine.readChangelog(shard);
    const users = r.changes.find((c) => c.tableName === 'users');
    expect(users!.deletes).toContain(1);
    expect(users!.inserts.length).toBe(0);
    expect(users!.updates.length).toBe(0);
  });

  it('returns empty when the changelog has no rows', () => {
    const r = engine.readChangelog(shard);
    expect(r.changes).toEqual([]);
    expect(r.maxSeq).toBe(0);
  });

  it('handles a DELETE-only changelog entry (no inserts/updates)', () => {
    engine.ensureCDCTable(shard);
    // Inject a bare DELETE op WITHOUT a source INSERT, so the entry has only
    // deletes (inserts and updates both empty) — exercises "no inserts/updates".
    db.prepare(`INSERT INTO ${CDCEngine.CDC_TABLE}(table_name, op_type, row_id) VALUES (?, 'D', ?)`).run('users', 1);

    const r = engine.readChangelog(shard);
    const users = r.changes.find((c) => c.tableName === 'users');
    expect(users!.deletes).toContain(1);
    expect(users!.inserts.length).toBe(0);
    expect(users!.updates.length).toBe(0);
  });

  it('skips CDC-internal table ops (monitored _cdc_ table) and out-of-order seq', () => {
    // Register a _cdc_-prefixed table as monitored so the startsWith guard fires.
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: ['users', '_cdc_internal'] }), makeConfig());
    e2.ensureCDCTable(shard);
    db.prepare(`INSERT INTO ${CDCEngine.CDC_TABLE}(table_name, op_type, row_id) VALUES ('_cdc_internal', 'I', 1)`).run();
    db.prepare(`INSERT INTO ${CDCEngine.CDC_TABLE}(table_name, op_type, row_id) VALUES ('users', 'I', 1)`).run();
    db.prepare('INSERT INTO users (name) VALUES (?)').run('z');

    const r = e2.readChangelog(shard);
    // _cdc_internal op is skipped via startsWith; only 'users' appears
    expect(r.changes.map((c) => c.tableName)).toEqual(['users']);
  });

  it('reads a non-IPK table (explicit rowid column)', () => {
    // A table WITHOUT an INTEGER PRIMARY KEY keeps a real rowid column.
    db.exec('CREATE TABLE plain (name TEXT)');
    db.exec('CREATE TABLE plain2 (id TEXT PRIMARY KEY, name TEXT)');
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: ['plain', 'plain2'] }), makeConfig());
    e2.ensureCDCTable(shard);
    e2.ensureTableTriggers(shard, 'plain');
    e2.ensureTableTriggers(shard, 'plain2');
    db.prepare('INSERT INTO plain (name) VALUES (?)').run('r1');
    db.prepare('INSERT INTO plain2 (id, name) VALUES (?, ?)').run('k1', 'r2');

    const r = e2.readChangelog(shard);
    const plain = r.changes.find((c) => c.tableName === 'plain');
    expect(plain!.inserts.length).toBe(1);
    expect(plain!.inserts[0].name).toBe('r1');
    const plain2 = r.changes.find((c) => c.tableName === 'plain2');
    expect(plain2!.inserts.length).toBe(1);
    expect(plain2!.inserts[0].name).toBe('r2');
  });

  it('handles changelog entries referencing already-deleted rows', () => {
    db.prepare('INSERT INTO users (name) VALUES (?)').run('gone');
    db.prepare('DELETE FROM users WHERE id = 1').run();
    // changelog now has I(1) and D(1); row 1 no longer exists in source

    const r = engine.readChangelog(shard);
    const users = r.changes.find((c) => c.tableName === 'users');
    // insert row is gone -> inserts empty; delete is recorded
    expect(users!.inserts.length).toBe(0);
    expect(users!.deletes).toContain(1);
  });

  it('skips monitored tables that have no changelog entries', () => {
    db.exec('CREATE TABLE empty_table (id INTEGER PRIMARY KEY)');
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: ['users', 'empty_table'] }), makeConfig());
    e2.ensureCDCTable(shard);
    e2.ensureTableTriggers(shard, 'users');
    // Only 'users' has ops; 'empty_table' has none -> entry undefined -> skip.
    db.prepare('INSERT INTO users (name) VALUES (?)').run('a');

    const r = e2.readChangelog(shard);
    expect(r.changes.map((c) => c.tableName)).toEqual(['users']);
  });

  it('drops an update whose source row has since been deleted', () => {
    // INSERT -> UPDATE (records U) -> DELETE the same row, so when reading the
    // update the row no longer exists (if(row) is false and it is dropped).
    db.prepare('INSERT INTO users (name) VALUES (?)').run('x');
    db.prepare('UPDATE users SET name = ? WHERE id = 1').run('y');
    db.prepare('DELETE FROM users WHERE id = 1').run();

    const r = engine.readChangelog(shard);
    const users = r.changes.find((c) => c.tableName === 'users');
    // update row is gone -> updates empty; delete is present
    expect(users!.updates.length).toBe(0);
    expect(users!.deletes).toContain(1);
  });
});

describe('CDCEngine — readChangesFromCDC (with GC)', () => {
  let db: Database.Database;
  let shard: ShardHandle;
  let engine: CDCEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    shard = makeShard(0, db);
    engine = new CDCEngine({} as any, makeSchemaManager({ 0: ['users'] }), makeConfig());
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    engine.ensureCDCTable(shard);
    engine.ensureTableTriggers(shard, 'users');
  });

  afterEach(() => db.close());

  it('returns empty when no monitored tables', () => {
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: [] }), makeConfig());
    expect(e2.readChangesFromCDC(shard)).toEqual([]);
  });

  it('reads changes and deletes processed entries (GC)', () => {
    db.prepare('INSERT INTO users (name) VALUES (?)').run('a');
    db.prepare('INSERT INTO users (name) VALUES (?)').run('b');

    const changes = engine.readChangesFromCDC(shard);
    expect(changes.length).toBe(1);
    expect(changes[0].inserts.length).toBe(2);

    // After GC, the changelog should be empty
    const remaining = db.prepare(`SELECT COUNT(*) AS c FROM ${CDCEngine.CDC_TABLE}`).get() as any;
    expect(remaining.c).toBe(0);
  });

  it('returns empty when changelog has no rows', () => {
    expect(engine.readChangesFromCDC(shard)).toEqual([]);
  });

  it('captures INSERT, UPDATE and DELETE and reads row data', () => {
    db.prepare('INSERT INTO users (name) VALUES (?)').run('a');
    db.prepare('INSERT INTO users (name) VALUES (?)').run('b');
    db.prepare('UPDATE users SET name = ? WHERE id = 1').run('a2');
    db.prepare('DELETE FROM users WHERE id = 2').run();

    const changes = engine.readChangesFromCDC(shard);
    const users = changes.find((c) => c.tableName === 'users');
    expect(users!.inserts.length).toBe(1); // id=1 insert (then updated)
    expect(users!.updates.length).toBe(1); // id=1 update
    expect(users!.deletes.length).toBe(1); // id=2 delete
    expect(users!.updates[0].row.name).toBe('a2');

    // GC should have removed all processed entries
    const remaining = db.prepare(`SELECT COUNT(*) AS c FROM ${CDCEngine.CDC_TABLE}`).get() as any;
    expect(remaining.c).toBe(0);
  });

  it('reclassifies MVCC soft-delete updates as deletes', () => {
    db.exec('DROP TABLE users');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, _xmax INTEGER)');
    engine.ensureTableTriggers(shard, 'users');
    db.prepare('INSERT INTO users (id, name, _xmax) VALUES (?, ?, ?)').run(1, 'a', 0);
    db.prepare('UPDATE users SET _xmax = ? WHERE id = 1').run(42);

    const changes = engine.readChangesFromCDC(shard);
    const users = changes.find((c) => c.tableName === 'users');
    expect(users!.deletes).toContain(1);
  });

  it('skips non-monitored tables and CDC-internal tables', () => {
    db.exec('CREATE TABLE other (id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE _cdc_skip (id INTEGER PRIMARY KEY)');
    engine.ensureTableTriggers(shard, 'other');
    engine.ensureTableTriggers(shard, '_cdc_skip');
    db.prepare('INSERT INTO users (name) VALUES (?)').run('a');
    db.prepare('INSERT INTO other (id) VALUES (?)').run(1);
    db.prepare('INSERT INTO _cdc_skip (id) VALUES (?)').run(1);

    const changes = engine.readChangesFromCDC(shard);
    expect(changes.map((c) => c.tableName)).toEqual(['users']);
  });

  it('reads a non-IPK table (explicit rowid column)', () => {
    db.exec('CREATE TABLE plain (name TEXT)');
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: ['plain'] }), makeConfig());
    e2.ensureCDCTable(shard);
    e2.ensureTableTriggers(shard, 'plain');
    db.prepare('INSERT INTO plain (name) VALUES (?)').run('r1');

    const changes = e2.readChangesFromCDC(shard);
    const plain = changes.find((c) => c.tableName === 'plain');
    expect(plain!.inserts.length).toBe(1);
    expect(plain!.inserts[0].name).toBe('r1');
  });

  it('handles a DELETE-only changelog entry (no inserts/updates)', () => {
    db.prepare('INSERT INTO users (name) VALUES (?)').run('q');
    // Manually inject a bare DELETE op so the entry has only deletes.
    db.prepare(`INSERT INTO ${CDCEngine.CDC_TABLE}(table_name, op_type, row_id) VALUES ('users', 'D', 1)`).run();
    db.prepare('DELETE FROM users WHERE id = 1').run();

    const changes = engine.readChangesFromCDC(shard);
    const users = changes.find((c) => c.tableName === 'users');
    expect(users!.deletes.length).toBeGreaterThan(0);
  });

  it('skips ops for tables not monitored and CDC-internal tables', () => {
    db.exec('CREATE TABLE _cdc_internal (id INTEGER PRIMARY KEY)');
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: ['users', '_cdc_internal'] }), makeConfig());
    e2.ensureCDCTable(shard);
    // Inject ops: _cdc_internal (skipped via startsWith) and users (monitored).
    db.prepare(`INSERT INTO ${CDCEngine.CDC_TABLE}(table_name, op_type, row_id) VALUES ('_cdc_internal', 'I', 1)`).run();
    db.prepare(`INSERT INTO ${CDCEngine.CDC_TABLE}(table_name, op_type, row_id) VALUES ('users', 'I', 1)`).run();
    db.prepare('INSERT INTO users (name) VALUES (?)').run('a');

    const changes = e2.readChangesFromCDC(shard);
    expect(changes.map((c) => c.tableName)).toEqual(['users']);
  });

  it('returns empty when all changelog ops are skipped (maxSeq stays 0)', () => {
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: ['users'] }), makeConfig());
    e2.ensureCDCTable(shard);
    // Inject only a non-monitored table op so it is skipped -> no monitored results.
    db.prepare(`INSERT INTO ${CDCEngine.CDC_TABLE}(table_name, op_type, row_id) VALUES ('unmonitored', 'I', 1)`).run();

    const changes = e2.readChangesFromCDC(shard);
    expect(changes).toEqual([]);
  });

  it('reads an update on a non-IPK table (explicit rowid in update branch)', () => {
    db.exec('CREATE TABLE plain (name TEXT)');
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: ['plain'] }), makeConfig());
    e2.ensureCDCTable(shard);
    e2.ensureTableTriggers(shard, 'plain');
    db.prepare('INSERT INTO plain (name) VALUES (?)').run('before');
    db.prepare('UPDATE plain SET name = ? WHERE rowid = 1').run('after');

    const changes = e2.readChangesFromCDC(shard);
    const plain = changes.find((c) => c.tableName === 'plain');
    expect(plain!.updates.length).toBe(1);
    expect(plain!.updates[0].row.name).toBe('after');
  });

  it('handles a DELETE-only entry (no inserts/updates) in readChangesFromCDC', () => {
    engine.ensureCDCTable(shard);
    // Bare DELETE op without any source INSERT so inserts/updates are empty.
    db.prepare(`INSERT INTO ${CDCEngine.CDC_TABLE}(table_name, op_type, row_id) VALUES (?, 'D', ?)`).run('users', 1);

    const changes = engine.readChangesFromCDC(shard);
    const users = changes.find((c) => c.tableName === 'users');
    expect(users!.deletes).toContain(1);
    expect(users!.inserts.length).toBe(0);
    expect(users!.updates.length).toBe(0);
  });

  it('drops an update whose source row has since been deleted', () => {
    db.prepare('INSERT INTO users (name) VALUES (?)').run('x');
    db.prepare('UPDATE users SET name = ? WHERE id = 1').run('y');
    db.prepare('DELETE FROM users WHERE id = 1').run();

    const changes = engine.readChangesFromCDC(shard);
    const users = changes.find((c) => c.tableName === 'users');
    expect(users!.updates.length).toBe(0);
    expect(users!.deletes).toContain(1);
  });
});

describe('CDCEngine — readChangesFromShard (rowid fallback)', () => {
  let db: Database.Database;
  let shard: ShardHandle;
  let engine: CDCEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    shard = makeShard(0, db);
    engine = new CDCEngine({} as any, makeSchemaManager({ 0: ['users', 'ipk_table'] }), makeConfig());
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec('CREATE TABLE ipk_table (id INTEGER PRIMARY KEY, val TEXT)');
  });

  afterEach(() => db.close());

  it('returns empty when no tables are monitored', async () => {
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: [] }), makeConfig());
    expect(await e2.readChangesFromShard(shard)).toEqual([]);
  });

  it('reads rows via rowid checkpoint and tracks progress', async () => {
    db.prepare('INSERT INTO users (name) VALUES (?)').run('a');
    db.prepare('INSERT INTO users (name) VALUES (?)').run('b');

    const first = await engine.readChangesFromShard(shard);
    expect(first.length).toBe(1); // only 'users' has rows; 'ipk_table' is empty
    const users = first.find((c) => c.tableName === 'users');
    expect(users!.inserts.length).toBe(2);

    // Second read should return nothing new (checkpoint advanced)
    const second = await engine.readChangesFromShard(shard);
    const users2 = second.find((c) => c.tableName === 'users');
    expect(users2?.inserts.length ?? 0).toBe(0);
    expect(second.length).toBe(0);
  });

  it('reads INTEGER PRIMARY KEY tables using PK column as rowid proxy', async () => {
    db.prepare('INSERT INTO ipk_table (id, val) VALUES (?, ?)').run(5, 'x');
    const r = await engine.readChangesFromShard(shard);
    const ipk = r.find((c) => c.tableName === 'ipk_table');
    expect(ipk!.inserts.length).toBe(1);
    expect(ipk!.inserts[0].val).toBe('x');
  });

  it('honors an external checkpoint map', async () => {
    db.prepare('INSERT INTO users (name) VALUES (?)').run('a');
    const external = new Map<string, number>();
    const r = await engine.readChangesFromShard(shard, external);
    expect(r.length).toBeGreaterThan(0);
    // external checkpoint should now be set
    expect(external.get('0:users')).toBeGreaterThan(0);
  });

  it('reads a non-IPK table using the implicit rowid column', async () => {
    db.exec('CREATE TABLE plain (name TEXT)');
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: ['plain'] }), makeConfig());
    db.prepare('INSERT INTO plain (name) VALUES (?)').run('r1');

    const r = await e2.readChangesFromShard(shard);
    const plain = r.find((c) => c.tableName === 'plain');
    expect(plain!.inserts.length).toBe(1);
    expect(plain!.inserts[0].name).toBe('r1');
  });

  it('returns empty for a non-IPK table with no rows', async () => {
    db.exec('CREATE TABLE plain_empty (name TEXT)');
    const e2 = new CDCEngine({} as any, makeSchemaManager({ 0: ['plain_empty'] }), makeConfig());
    const r = await e2.readChangesFromShard(shard);
    expect(r).toEqual([]);
  });
});

describe('CDCEngine — schema introspection', () => {
  let db: Database.Database;
  let shard: ShardHandle;
  let engine: CDCEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    shard = makeShard(0, db);
    engine = new CDCEngine({} as any, makeSchemaManager({ 0: ['users'] }), makeConfig());
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
  });

  afterEach(() => db.close());

  it('getPKCol returns the INTEGER PRIMARY KEY column', () => {
    expect(engine.getPKCol(shard, 'users')).toBe('id');
  });

  it('getPKCol returns undefined for tables without an IPK', () => {
    db.exec('CREATE TABLE no_pk (name TEXT)');
    expect(engine.getPKCol(shard, 'no_pk')).toBe(undefined);
  });

  it('getPKCol returns undefined on pragma error', () => {
    expect(engine.getPKCol(shard, 'missing_table')).toBe(undefined);
  });

  it('getPKCol caches the result across calls', () => {
    expect(engine.getPKCol(shard, 'users')).toBe('id');
    // second call hits the cache (still returns 'id')
    expect(engine.getPKCol(shard, 'users')).toBe('id');
  });

  it('getPKCol caches a no-PK result (empty-string cache hit)', () => {
    db.exec('CREATE TABLE no_pk_cache (name TEXT)');
    // First call misses cache and stores '' for a table without an IPK.
    expect(engine.getPKCol(shard, 'no_pk_cache')).toBe(undefined);
    // Second call hits the '' cache entry (col === '' !== undefined) -> undefined.
    expect(engine.getPKCol(shard, 'no_pk_cache')).toBe(undefined);
  });

  it('getMaxRowId returns the max rowid, 0 for empty table', () => {
    expect(engine.getMaxRowId(shard, 'users')).toBe(0);
    db.prepare('INSERT INTO users (name) VALUES (?)').run('a');
    expect(engine.getMaxRowId(shard, 'users')).toBe(1);
  });

  it('getMaxRowId returns 0 on error', () => {
    expect(engine.getMaxRowId(shard, 'missing_table')).toBe(0);
  });

  it('listShardTables excludes sqlite internal tables', () => {
    db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY)');
    const tables = engine.listShardTables(shard);
    expect(tables).toContain('users');
    expect(tables).toContain('t1');
    expect(tables.some((t) => t.startsWith('sqlite_'))).toBe(false);
  });

  it('listShardTables returns empty on error', () => {
    const brokenShard = makeShard(9, { prepare: () => { throw new Error('x'); } } as any);
    expect(engine.listShardTables(brokenShard)).toEqual([]);
  });
});

describe('CDCEngine — schema change detection', () => {
  let db: Database.Database;
  let shard: ShardHandle;
  let engine: CDCEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    shard = makeShard(0, db);
    engine = new CDCEngine({} as any, makeSchemaManager({ 0: ['users'] }), makeConfig());
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
  });

  afterEach(() => db.close());

  it('returns false on first check (no cached hash)', () => {
    expect(engine.detectSchemaChange(shard, 'users')).toBe(false);
  });

  it('returns false when schema is unchanged', () => {
    engine.detectSchemaChange(shard, 'users');
    expect(engine.detectSchemaChange(shard, 'users')).toBe(false);
  });

  it('returns true when schema changes (column added)', () => {
    engine.detectSchemaChange(shard, 'users');
    db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    expect(engine.detectSchemaChange(shard, 'users')).toBe(true);
  });

  it('returns true when column type changes', () => {
    engine.detectSchemaChange(shard, 'users');
    db.exec('CREATE TABLE users2 (id INTEGER PRIMARY KEY, name TEXT)');
    // Simulate a type change by recreating with a different type
    db.exec('DROP TABLE users');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name INTEGER)');
    expect(engine.detectSchemaChange(shard, 'users')).toBe(true);
  });

  it('returns false on schema detection error', () => {
    expect(engine.detectSchemaChange(shard, 'missing_table')).toBe(false);
  });
});
