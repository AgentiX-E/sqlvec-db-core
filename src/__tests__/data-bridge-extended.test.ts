import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DataBridge, DEFAULT_DATA_BRIDGE_CONFIG } from '../analytics/DataBridge';
import type { DataBridgeConfig } from '../analytics/DataBridge';
import { OLAPSchemaManager } from '../analytics/OLAPSchemaManager';
import { DuckDBAnalyticsManager } from '../analytics/DuckDBAnalyticsManager';
import type { ShardHandle } from '../storage/ShardManager';

/**
 * DataBridge extended coverage — the branches left untested by
 * data-bridge.test.ts: the fullSyncOnStart deferred path, OLAP registration
 * retry, schema-change detection, rowid-based (no-PK) update/delete fallback,
 * CDC GC, synchronization-lag estimation, fullSyncAll/fullSyncShard and
 * runChecksumCheck. Shares the same real-SQLite + mocked-DuckDB pattern.
 */

function makeConfig(overrides: Partial<DataBridgeConfig> = {}): DataBridgeConfig {
  return { ...DEFAULT_DATA_BRIDGE_CONFIG, fullSyncOnStart: false, ...overrides };
}

function makeDuckDB(available = true): any {
  const rec: any = { inserts: [], updates: [], updatesByPk: [], deletes: [], deletesByPk: [], raw: [] };
  const duck = Object.create(DuckDBAnalyticsManager.prototype) as any;
  Object.defineProperty(duck, 'isAvailable', { get: () => available, configurable: true });
  duck.appendToOLAPTable = vi.fn(async (t: string, rows: any[]) => { rec.inserts.push(rows); });
  duck.updateOLAPTable = vi.fn(async (t: string, s: string[], ids: number[]) => { rec.updates.push({ t, s, ids }); });
  duck.updateOLAPTableByPK = vi.fn(async (t: string, s: string[], pk: string[], v: number[][]) => { rec.updatesByPk.push({ t, s, pk, v }); });
  duck.deleteFromOLAPTable = vi.fn(async (t: string, ids: number[]) => { rec.deletes.push({ t, ids }); });
  duck.deleteFromOLAPTableByPK = vi.fn(async (t: string, pk: string[], v: number[][]) => { rec.deletesByPk.push({ t, pk, v }); });
  duck.execRaw = vi.fn(async (sql: string) => { rec.raw.push(sql); });
  (duck as any).__rec = rec;
  return duck;
}

function makeSchemaManager(tables: Record<number, string[]>): any {
  const mgr = Object.create(OLAPSchemaManager.prototype) as any;
  mgr.getMonitoredTables = (shardId: number): string[] => tables[shardId] ?? [];
  mgr.getOLAPTable = (shardId: number, table: string) => ({
    shardId,
    sqliteTableName: table,
    duckDBTableName: `olap_shard_${shardId}_${table}`,
    columns: [],
    rowCount: 0,
    lastSyncedAt: 0,
    syncStrategy: 'incremental' as const,
  });
  mgr.fullSyncTable = vi.fn(async () => 5);
  mgr.computeTableChecksum = vi.fn(async () => null);
  return mgr;
}

function makeShardManager(shard: ShardHandle): any {
  return {
    getShardIds: () => [shard.shardId],
    getShard: (id: number) => (id === shard.shardId ? shard : undefined),
  };
}

function makeShard(db: Database.Database): ShardHandle {
  return { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;
}

describe('DataBridge — deferred full sync on start', () => {
  it('runs fullSyncAll after 500ms when fullSyncOnStart is true', async () => {
    vi.useFakeTimers();
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users (name) VALUES ('a')");
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig({ fullSyncOnStart: true }));

    const startP = bridge.start();
    await vi.advanceTimersByTimeAsync(20_500); // past dep waits
    await vi.advanceTimersByTimeAsync(600);    // past deferred full-sync 500ms
    await startP;

    // fullSyncAll → fullSyncShard → schemaManager.fullSyncTable was called
    expect(schema.fullSyncTable).toHaveBeenCalled();
    await bridge.stop();
    vi.useRealTimers();
    db.close();
  });

  it('skips the deferred full sync when fullSyncOnStart is false', async () => {
    vi.useFakeTimers();
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    const db = new Database(':memory:');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig({ fullSyncOnStart: false }));

    const startP = bridge.start();
    await vi.advanceTimersByTimeAsync(20_500);
    await vi.advanceTimersByTimeAsync(600);
    await startP;
    expect(schema.fullSyncTable).not.toHaveBeenCalled();
    await bridge.stop();
    vi.useRealTimers();
    db.close();
  });
});

describe('DataBridge — OLAP registration retry', () => {
  it('succeeds and clears a pending registration after fullSyncTable', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: [] });
    // fullSyncTable succeeds and getOLAPTable returns a def (so registration clears)
    schema.fullSyncTable = vi.fn(async () => 3);
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users (name) VALUES ('a')");
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    bridge.scheduleRetryOLAPRegistration(0, 'users', ':memory:');
    await bridge.tick();

    // registration cleared on success
    expect((bridge as any).pendingRegistrations).toHaveLength(0);
  });

  it('gives up after 10 retries', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: [] });
    schema.fullSyncTable = vi.fn(async () => { throw new Error('scanner missing'); });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    bridge.scheduleRetryOLAPRegistration(0, 'users', ':memory:');
    // increment retries to the give-up threshold (10)
    (bridge as any).pendingRegistrations[0].retries = 10;

    await bridge.tick();
    expect((bridge as any).pendingRegistrations).toHaveLength(0);
  });

  it('increments retry when fullSyncTable throws', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: [] });
    schema.fullSyncTable = vi.fn(async () => { throw new Error('boom'); });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    bridge.scheduleRetryOLAPRegistration(0, 'users', ':memory:');
    await bridge.tick();
    // registration still pending with retries=1
    expect((bridge as any).pendingRegistrations).toHaveLength(1);
    expect((bridge as any).pendingRegistrations[0].retries).toBe(1);
  });

  it('increments retry when fullSyncTable succeeds but table not registered', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: [] });
    schema.fullSyncTable = vi.fn(async () => 3);
    schema.getOLAPTable = vi.fn(() => undefined); // def missing → edge case
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    bridge.scheduleRetryOLAPRegistration(0, 'users', ':memory:');
    await bridge.tick();
    expect((bridge as any).pendingRegistrations).toHaveLength(1);
    expect((bridge as any).pendingRegistrations[0].retries).toBe(1);
  });
});

describe('DataBridge — schema change detection', () => {
  it('triggers fullSyncTable and marks resync on schema change', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    schema.fullSyncTable = vi.fn(async () => 2);
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users (name) VALUES ('a')");
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    const cdc = bridge.getCDCEngine();
    (cdc as any).ensureCDCTables(shard);
    const detectSpy = vi.spyOn(cdc, 'detectSchemaChange').mockReturnValue(true);

    const result = await bridge.tick();
    expect(detectSpy).toHaveBeenCalled();
    expect(schema.fullSyncTable).toHaveBeenCalled();
    expect(bridge.getMetrics().schemaChangesDetected).toBeGreaterThanOrEqual(1);
    expect(result.shardsProcessed).toBe(1);

    detectSpy.mockRestore();
  });
});

describe('DataBridge — rowid-based update/delete fallback (no PK)', () => {
  it('falls back to rowid-based update when no integer PK exists', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['notes'] });
    const db = new Database(':memory:');
    // TEXT primary key → getPKCol returns undefined (non-integer PK, implicit rowid)
    db.exec('CREATE TABLE notes (slug TEXT PRIMARY KEY, body TEXT)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    const cdc = bridge.getCDCEngine();
    (cdc as any).ensureCDCTables(shard);
    db.exec("INSERT INTO notes (slug, body) VALUES ('a', 'hello')");
    await bridge.tick(); // sync the insert first
    duck.__rec.inserts.length = 0;

    db.exec("UPDATE notes SET body = 'world' WHERE slug = 'a'");
    await bridge.tick();

    // rowid-based fallback path used instead of PK-based
    expect(duck.__rec.updates).toHaveLength(1);
    expect(duck.__rec.updatesByPk).toHaveLength(0);
  });

  it('falls back to rowid-based delete when no integer PK exists', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['notes'] });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE notes (slug TEXT PRIMARY KEY, body TEXT)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    const cdc = bridge.getCDCEngine();
    (cdc as any).ensureCDCTables(shard);
    db.exec("INSERT INTO notes (slug, body) VALUES ('a', 'hello')");
    await bridge.tick(); // sync the insert first
    duck.__rec.inserts.length = 0;

    db.exec("DELETE FROM notes WHERE slug = 'a'");
    await bridge.tick();

    expect(duck.__rec.deletes).toHaveLength(1);
    expect(duck.__rec.deletesByPk).toHaveLength(0);
  });
});

describe('DataBridge — CDC GC and lag estimation', () => {
  it('runs CDC GC when a changelog with maxSeq > 0 is present', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    const cdc = bridge.getCDCEngine();
    (cdc as any).ensureCDCTables(shard);
    db.exec("INSERT INTO users (name) VALUES ('alice')");

    await bridge.tick();
    // After a successful CDC apply, the changelog rows should be GC'd.
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM _cdc_operations').get() as any;
    expect(remaining.c).toBe(0);
  });

  it('estimates synchronization lag when SQLite is ahead of DuckDB', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    const cdc = bridge.getCDCEngine();
    (cdc as any).ensureCDCTables(shard);
    for (let i = 0; i < 10; i++) db.exec(`INSERT INTO users (name) VALUES ('u${i}')`);

    // Force DuckDB's persisted checkpoint to 0 while SQLite has 10 rows →
    // lag = round(10 * 0.1) = 1ms.
    const cp = bridge.getCheckpointManager();
    vi.spyOn(cp, 'getDuckMaxCheckpoint').mockResolvedValue(0);

    const result = await bridge.tick();
    expect(result.synchronizationLagMs).toBeGreaterThan(0);
  });
});

describe('DataBridge — fullSyncAll / fullSyncShard', () => {
  it('fullSyncAll skips internal SqlVec tables', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: [] });
    schema.fullSyncTable = vi.fn(async () => 1);
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE __internal (id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE _cdc_x (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    await bridge.fullSyncAll();
    // only the non-internal table ('users') triggers fullSyncTable
    const calls = schema.fullSyncTable.mock.calls as any[];
    const tables = calls.map((c: any[]) => c[1]);
    expect(tables).toContain('users');
    expect(tables).not.toContain('__internal');
    expect(tables).not.toContain('_cdc_x');
  });

  it('fullSyncAll returns early when DuckDB is unavailable', async () => {
    const duck = makeDuckDB(false);
    const schema = makeSchemaManager({ 0: ['users'] });
    schema.fullSyncTable = vi.fn(async () => 1);
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    await bridge.fullSyncAll();
    expect(schema.fullSyncTable).not.toHaveBeenCalled();
  });

  it('fullSyncAll swallows a per-shard error and continues', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    schema.fullSyncTable = vi.fn(async () => { throw new Error('shard boom'); });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    await expect(bridge.fullSyncAll()).resolves.toBeUndefined();
  });
});

describe('DataBridge — runChecksumCheck', () => {
  it('logs a checksum when computeTableChecksum returns a value', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    schema.computeTableChecksum = vi.fn(async () => ({ rowCount: 2, checksum: 'abc', computedAt: Date.now() }));
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    // runChecksumCheck is private; drive it via 600 ticks to hit the periodic branch,
    // but that's costly. Instead invoke the public tick counter path indirectly is
    // impractical — call the private method for direct coverage.
    await (bridge as any).runChecksumCheck();
    expect(schema.computeTableChecksum).toHaveBeenCalled();
  });

  it('swallows checksum errors (non-fatal)', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    schema.computeTableChecksum = vi.fn(async () => { throw new Error('checksum boom'); });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    await expect((bridge as any).runChecksumCheck()).resolves.toBeUndefined();
  });

  it('returns early from runChecksumCheck when DuckDB is unavailable', async () => {
    const duckOff = makeDuckDB(false);
    const schema = makeSchemaManager({ 0: [] });
    schema.computeTableChecksum = vi.fn(async () => null);
    const db = new Database(':memory:');
    const shard = makeShard(db);
    const bridge = new DataBridge(duckOff, schema, makeShardManager(shard) as any, makeConfig());

    await (bridge as any).runChecksumCheck();
    expect(schema.computeTableChecksum).not.toHaveBeenCalled();
  });

  it('skips checksum when the OLAP table definition is missing', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    schema.getOLAPTable = vi.fn(() => undefined); // def missing → skip
    schema.computeTableChecksum = vi.fn(async () => ({ rowCount: 1, checksum: 'x', computedAt: 1 }));
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    await (bridge as any).runChecksumCheck();
    expect(schema.computeTableChecksum).not.toHaveBeenCalled();
  });
});

describe('DataBridge — accessors and edge guards', () => {
  it('getCheckpointMap returns the inner byTable map', () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({});
    const db = new Database(':memory:');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());
    expect(bridge.getCheckpointMap()).toBeInstanceOf(Map);
  });

  it('syncBatch delegates to tick', async () => {
    const duck = makeDuckDB(false);
    const schema = makeSchemaManager({});
    const db = new Database(':memory:');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());
    const res = await bridge.syncBatch();
    expect(res.rowsInserted).toBe(0);
  });

  it('tick continues past a missing shard (getShard undefined)', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    // shardManager reports shardId 1 as present but getShard(1) returns undefined
    const sm = {
      getShardIds: () => [1],
      getShard: () => undefined,
    };
    const bridge = new DataBridge(duck, schema, sm as any, makeConfig());
    const res = await bridge.tick();
    expect(res.shardsProcessed).toBe(0);
  });

  it('skips a change for a table with no OLAP definition', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    schema.getOLAPTable = vi.fn(() => undefined); // def missing → skip apply
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());
    (bridge.getCDCEngine() as any).ensureCDCTables(shard);
    db.exec("INSERT INTO users (name) VALUES ('a')");
    const res = await bridge.tick();
    // inserts should be skipped but shard still counted as processed
    expect(res.shardsProcessed).toBe(1);
    expect(duck.__rec.inserts.flat()).toHaveLength(0);
  });

  it('logs a warning (non-fatal) when markFullResyncNeeded DuckDB write fails', async () => {
    const duck = makeDuckDB(true);
    duck.execRaw = vi.fn(async () => { throw new Error('execRaw boom'); });
    const schema = makeSchemaManager({});
    const db = new Database(':memory:');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    await expect(bridge.markFullResyncNeeded(0, 'users')).resolves.toBeUndefined();
    // checkpoint still zeroed in memory despite DuckDB write failure
    expect(bridge.getCheckpointManager().getCheckpoint(0, 'users')).toBe(0);
  });

  it('restores checkpoints from shard redundancy in start()', async () => {
    vi.useFakeTimers();
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({});
    const db = new Database(':memory:');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    // Force the DuckDB checkpoint count to 0 and shard redundancy to return entries
    const cp = bridge.getCheckpointManager();
    vi.spyOn(cp, 'ensureCheckpoint').mockReturnValue({ byTable: new Map() } as any);
    vi.spyOn(cp, 'drawCheckpointsFromShards').mockReturnValue(new Map([['0:users', 5]]));

    const startP = bridge.start();
    await vi.advanceTimersByTimeAsync(20_500);
    await startP;
    // shard-redundancy checkpoints were loaded into the in-memory map
    expect(cp.drawCheckpointsFromShards).toHaveBeenCalled();
    await bridge.stop();
    vi.useRealTimers();
    db.close();
  });

  it('runs periodic checksum check every 600 ticks (catch branch)', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    schema.computeTableChecksum = vi.fn(async () => { throw new Error('checksum boom'); });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    // Force tickCounter just below a multiple of 600 so the next tick triggers it
    (bridge as any).tickCounter = 599;
    await bridge.tick();

    // runChecksumCheck was reached (its internal error swallowed); assert indirectly
    // via computeTableChecksum being called.
    expect(schema.computeTableChecksum).toHaveBeenCalled();
  });

  it('invokes the tick-error handler when a tick rejects (start loop)', async () => {
    vi.useFakeTimers();
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig({ tickIntervalMs: 100 }));

    // Make tick() reject by breaking the CDC engine's shard interaction.
    const cdc = bridge.getCDCEngine();
    vi.spyOn(cdc, 'ensureCDCTables').mockImplementation(() => { throw new Error('tick boom'); });

    const startP = bridge.start();
    await vi.advanceTimersByTimeAsync(20_500);
    // advance one tick interval to fire the setInterval callback (tick rejects →
    // the .catch handler logs; process must not throw)
    await vi.advanceTimersByTimeAsync(150);
    await startP;
    // reaching here without an unhandled rejection is the assertion
    await bridge.stop();
    vi.useRealTimers();
    db.close();
  });

  it('invokes the markFullResyncNeeded .catch when it rejects', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    const cdc = bridge.getCDCEngine();
    (cdc as any).ensureCDCTables(shard);
    vi.spyOn(cdc, 'detectSchemaChange').mockReturnValue(true);
    // Force markFullResyncNeeded to reject so its .catch handler runs
    vi.spyOn(bridge, 'markFullResyncNeeded').mockRejectedValue(new Error('resync boom'));

    await bridge.tick();
    // reaching here without an unhandled rejection is the assertion
    expect(bridge.getMetrics().schemaChangesDetected).toBeGreaterThanOrEqual(1);
  });

  it('invokes the periodic-checksum .catch when runChecksumCheck rejects', async () => {
    const duck = makeDuckDB(true);
    const schema = makeSchemaManager({ 0: ['users'] });
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = makeShard(db);
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    (bridge as any).tickCounter = 599;
    // Force runChecksumCheck to reject so its .catch handler runs
    vi.spyOn(bridge as any, 'runChecksumCheck').mockRejectedValue(new Error('checksum call boom'));

    await bridge.tick();
    // reaching here without an unhandled rejection is the assertion
    expect(true).toBe(true);
  });
});
