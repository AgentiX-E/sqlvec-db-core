import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DataBridge, DEFAULT_DATA_BRIDGE_CONFIG } from '../analytics/DataBridge';
import type { DataBridgeConfig } from '../analytics/DataBridge';
import { OLAPSchemaManager } from '../analytics/OLAPSchemaManager';
import { DuckDBAnalyticsManager } from '../analytics/DuckDBAnalyticsManager';
import type { ShardHandle } from '../storage/ShardManager';

/**
 * Tests for DataBridge. We use a real in-memory SQLite shard (so CDC triggers
 * actually fire) together with a mocked DuckDBAnalyticsManager and
 * OLAPSchemaManager that record the columnar writes. This exercises the real
 * tick() end-to-end (trigger → changelog → classify → apply to DuckDB) without
 * a real DuckDB instance.
 */

function makeConfig(overrides: Partial<DataBridgeConfig> = {}): DataBridgeConfig {
  return { ...DEFAULT_DATA_BRIDGE_CONFIG, fullSyncOnStart: false, ...overrides };
}

interface RecordedDuckDB {
  inserts: any[][];
  updates: { table: string; setClauses: string[]; rowIds: number[] }[];
  updatesByPk: { table: string; setClauses: string[]; pkCols: string[]; pkVals: number[][] }[];
  deletes: { table: string; rowIds: number[] }[];
  deletesByPk: { table: string; pkCols: string[]; pkVals: number[][] }[];
  raw: string[];
}

function makeDuckDB(available = true): any {
  const rec: RecordedDuckDB = {
    inserts: [],
    updates: [],
    updatesByPk: [],
    deletes: [],
    deletesByPk: [],
    raw: [],
  };
  const duck = Object.create(DuckDBAnalyticsManager.prototype) as any;
  Object.defineProperty(duck, 'isAvailable', { get: () => available, configurable: true });
  duck.appendToOLAPTable = vi.fn(async (table: string, rows: any[]) => {
    rec.inserts.push(rows);
  });
  duck.updateOLAPTable = vi.fn(async (table: string, setClauses: string[], rowIds: number[]) => {
    rec.updates.push({ table, setClauses, rowIds });
  });
  duck.updateOLAPTableByPK = vi.fn(async (table: string, setClauses: string[], pkCols: string[], pkVals: number[][]) => {
    rec.updatesByPk.push({ table, setClauses, pkCols, pkVals });
  });
  duck.deleteFromOLAPTable = vi.fn(async (table: string, rowIds: number[]) => {
    rec.deletes.push({ table, rowIds });
  });
  duck.deleteFromOLAPTableByPK = vi.fn(async (table: string, pkCols: string[], pkVals: number[][]) => {
    rec.deletesByPk.push({ table, pkCols, pkVals });
  });
  duck.execRaw = vi.fn(async (sql: string) => {
    rec.raw.push(sql);
  });
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
  mgr.fullSyncTable = vi.fn(async () => 0);
  mgr.computeTableChecksum = vi.fn(async () => null);
  return mgr;
}

function makeShardManager(shard: ShardHandle): any {
  return {
    getShardIds: () => [shard.shardId],
    getShard: (id: number) => (id === shard.shardId ? shard : undefined),
  };
}

describe('DataBridge — lifecycle & state', () => {
  it('starts, transitions through awaiting_deps, and stops', async () => {
    vi.useFakeTimers();
    const duck = makeDuckDB(false); // unavailable → waitForDuckDB times out fast under fake timers
    const schema = makeSchemaManager({});
    const db = new Database(':memory:');
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    const startP = bridge.start();
    // Fast-forward past BOTH 10s dependency waits (DuckDB + SchemaManager)
    await vi.advanceTimersByTimeAsync(20_500);
    // No fullSyncOnStart → transitions straight to 'syncing'
    expect(bridge.getStatus().state).toBe('syncing');

    await bridge.stop();
    expect(bridge.getStatus().state).toBe('stopped');
    await startP;
    vi.useRealTimers();
    db.close();
  });

  it('start is idempotent (second start is a no-op)', async () => {
    vi.useFakeTimers();
    const duck = makeDuckDB(false);
    const schema = makeSchemaManager({});
    const db = new Database(':memory:');
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    const firstStart = bridge.start();
    await vi.advanceTimersByTimeAsync(20_500);
    await firstStart;
    const stateAfterFirst = bridge.getStatus().state;

    const secondStart = bridge.start(); // should return immediately (already running)
    await secondStart;
    expect(bridge.getStatus().state).toBe(stateAfterFirst);

    await bridge.stop();
    vi.useRealTimers();
    db.close();
  });

  it('scheduleRetryOLAPRegistration dedupes identical (shardId, table)', () => {
    vi.useFakeTimers();
    const duck = makeDuckDB(false);
    const schema = makeSchemaManager({});
    const db = new Database(':memory:');
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    bridge.scheduleRetryOLAPRegistration(0, 'users', '/tmp/x.db');
    bridge.scheduleRetryOLAPRegistration(0, 'users', '/tmp/x.db'); // duplicate
    bridge.scheduleRetryOLAPRegistration(0, 'orders', '/tmp/x.db'); // different table
    bridge.scheduleRetryOLAPRegistration(1, 'users', '/tmp/y.db'); // different shard

    // 3 unique registrations (one duplicate dropped)
    expect((bridge as any).pendingRegistrations).toHaveLength(3);
    vi.useRealTimers();
    db.close();
  });

  it('getMetrics returns checkpoint write failures from the manager', () => {
    vi.useFakeTimers();
    const duck = makeDuckDB(false);
    const schema = makeSchemaManager({});
    const db = new Database(':memory:');
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    const metrics = bridge.getMetrics();
    expect(metrics).toHaveProperty('totalTicks');
    expect(metrics).toHaveProperty('checkpointWriteFailures');
    expect(metrics).toHaveProperty('tablesSynced');
    vi.useRealTimers();
    db.close();
  });
});

describe('DataBridge — end-to-end CDC tick', () => {
  let db: Database.Database;
  let duck: any;

  beforeEach(() => {
    db = new Database(':memory:');
    duck = makeDuckDB(true);
  });

  afterEach(() => {
    db.close();
  });

  it('propagates INSERT from SQLite changelog to DuckDB', async () => {
    const schema = makeSchemaManager({ 0: ['users'] });
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    const cdc = bridge.getCDCEngine();
    (cdc as any).ensureCDCTables(shard);

    db.exec("INSERT INTO users (name) VALUES ('alice')");
    db.exec("INSERT INTO users (name) VALUES ('bob')");

    const result = await bridge.tick();

    const allInserts = duck.__rec.inserts.flat();
    expect(allInserts).toHaveLength(2);
    expect(result.rowsInserted).toBe(2);
    expect(result.rowsUpdated).toBe(0);
    expect(result.rowsDeleted).toBe(0);
    expect(result.shardsProcessed).toBe(1);
  });

  it('propagates UPDATE and DELETE to DuckDB', async () => {
    const schema = makeSchemaManager({ 0: ['users'] });
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    const cdc = bridge.getCDCEngine();
    (cdc as any).ensureCDCTables(shard);

    db.exec("INSERT INTO users (name) VALUES ('alice')");
    db.exec("INSERT INTO users (name) VALUES ('bob')");

    // First tick syncs the inserts (advances checkpoint)
    await bridge.tick();
    duck.__rec.inserts.length = 0; // reset recorder for the next phase

    db.exec("UPDATE users SET name = 'alice2' WHERE id = 1");
    db.exec('DELETE FROM users WHERE id = 2');

    const result = await bridge.tick();

    // INTEGER PRIMARY KEY table → PK-based update and delete paths
    expect(duck.__rec.updatesByPk).toHaveLength(1);
    expect(duck.__rec.updatesByPk[0].pkVals).toEqual([[1]]);
    expect(duck.__rec.deletesByPk).toHaveLength(1);
    expect(duck.__rec.deletesByPk[0].pkVals).toEqual([[2]]);
    expect(result.rowsUpdated).toBe(1);
    expect(result.rowsDeleted).toBe(1);
  });

  it('tick returns early (all zeros) when DuckDB is unavailable', async () => {
    const duckOff = makeDuckDB(false);
    const schema = makeSchemaManager({ 0: ['users'] });
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;
    const bridge = new DataBridge(duckOff, schema, makeShardManager(shard) as any, makeConfig());

    const result = await bridge.tick();
    expect(result).toEqual({
      shardsProcessed: 0,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsDeleted: 0,
      durationMs: 0,
      synchronizationLagMs: 0,
    });
  });

  it('marks a full resync by zeroing the checkpoint and writing DuckDB state', async () => {
    const schema = makeSchemaManager({});
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;
    const bridge = new DataBridge(duck, schema, makeShardManager(shard) as any, makeConfig());

    await bridge.markFullResyncNeeded(0, 'users');
    // checkpoint zeroed
    expect(bridge.getCheckpointManager().getCheckpoint(0, 'users')).toBe(0);
    // DuckDB received the full_resync marker
    expect(duck.__rec.raw.some((s: string) => s.includes('full_resync_needed'))).toBe(true);
  });
});
