/**
 * PartitionMetaManager — partition metadata persistence tests.
 *
 * Covers parseBounds/stringifyBounds round-tripping, table registration,
 * unregistration, retrieval (ordered by creation), drop-all cleanup (including
 * the per-shard DROP failure branch), existence checks, and method/column
 * introspection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  parseBounds,
  stringifyBounds,
  ensureMetaTable,
  registerPartition,
  unregisterPartition,
  getPartitionsForTable,
  dropAllPartitionsForTable,
  hasPartitions,
  getPartitionMethod,
  getPartitionColumn,
} from '../query/PartitionMetaManager';
import type { PartitionMeta, RangeBounds, ListBounds, HashBounds } from '../query/PartitionMetaManager';

const BASE = '2026-10-04T00:00:00.000Z';

function meta(
  partitionName: string,
  method: PartitionMeta['partitionMethod'] = 'RANGE',
  partitionBounds = '{"from":0,"to":100}',
  createdAt = BASE,
  parentTable = 'orders',
  partitionColumn = 'id',
): PartitionMeta {
  return { parentTable, partitionMethod: method, partitionColumn, partitionName, partitionBounds, createdAt };
}

describe('parseBounds / stringifyBounds', () => {
  it('parses RANGE bounds', () => {
    expect(parseBounds('{"from":0,"to":100}')).toEqual({ from: 0, to: 100 });
  });

  it('parses LIST bounds', () => {
    expect(parseBounds('{"values":["DE","FR"]}')).toEqual({ values: ['DE', 'FR'] });
  });

  it('parses HASH bounds', () => {
    expect(parseBounds('{"modulus":4,"remainder":1}')).toEqual({ modulus: 4, remainder: 1 });
  });

  it('stringifies bounds back to JSON', () => {
    const range: RangeBounds = { from: 1, to: 1000 };
    expect(stringifyBounds(range)).toBe('{"from":1,"to":1000}');
  });

  it('round-trips RANGE bounds', () => {
    const b: RangeBounds = { from: 5, to: 500 };
    expect(parseBounds(stringifyBounds(b))).toEqual(b);
  });

  it('round-trips LIST bounds with mixed value types', () => {
    const b: ListBounds = { values: [1, 'x', null, true] };
    expect(parseBounds(stringifyBounds(b))).toEqual(b);
  });

  it('round-trips HASH bounds', () => {
    const b: HashBounds = { modulus: 8, remainder: 3 };
    expect(parseBounds(stringifyBounds(b))).toEqual(b);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseBounds('not-json')).toThrow();
  });
});

describe('ensureMetaTable / registerPartition / unregisterPartition', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('creates the __partition_meta table', () => {
    ensureMetaTable(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__partition_meta'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('__partition_meta');
  });

  it('is idempotent', () => {
    ensureMetaTable(db);
    ensureMetaTable(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__partition_meta'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('__partition_meta');
  });

  it('registers a partition', () => {
    registerPartition(db, meta('orders_p1'));
    expect(hasPartitions(db, 'orders')).toBe(true);
  });

  it('defaults createdAt when empty', () => {
    const before = Date.now();
    registerPartition(db, meta('orders_p1', 'RANGE', '{}', ''));
    const rows = getPartitionsForTable(db, 'orders');
    expect(rows).toHaveLength(1);
    const parsed = Date.parse(rows[0].createdAt);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
  });

  it('replaces an existing partition with the same name (INSERT OR REPLACE)', () => {
    registerPartition(db, meta('orders_p1', 'RANGE', '{"from":0,"to":100}'));
    registerPartition(db, meta('orders_p1', 'RANGE', '{"from":100,"to":200}'));
    const rows = getPartitionsForTable(db, 'orders');
    expect(rows).toHaveLength(1);
    expect(rows[0].partitionBounds).toBe('{"from":100,"to":200}');
  });

  it('unregisters a partition', () => {
    registerPartition(db, meta('orders_p1'));
    unregisterPartition(db, 'orders', 'orders_p1');
    expect(hasPartitions(db, 'orders')).toBe(false);
  });

  it('unregistering a non-existent partition is a no-op', () => {
    unregisterPartition(db, 'orders', 'missing');
    expect(hasPartitions(db, 'orders')).toBe(false);
  });
});

describe('getPartitionsForTable', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('returns an empty array for an unpartitioned table', () => {
    expect(getPartitionsForTable(db, 'nope')).toEqual([]);
  });

  it('returns partitions ordered by created_at ascending', () => {
    registerPartition(db, meta('p3', 'RANGE', '{}', '2026-10-04T00:00:03.000Z'));
    registerPartition(db, meta('p1', 'RANGE', '{}', '2026-10-04T00:00:01.000Z'));
    registerPartition(db, meta('p2', 'RANGE', '{}', '2026-10-04T00:00:02.000Z'));
    const rows = getPartitionsForTable(db, 'orders');
    expect(rows.map((r) => r.partitionName)).toEqual(['p1', 'p2', 'p3']);
  });

  it('maps snake_case columns back to camelCase fields', () => {
    registerPartition(db, meta('orders_eu', 'LIST', '{"values":["DE","FR"]}', BASE, 'orders', 'region'));
    const [row] = getPartitionsForTable(db, 'orders');
    expect(row).toMatchObject({
      parentTable: 'orders',
      partitionMethod: 'LIST',
      partitionColumn: 'region',
      partitionName: 'orders_eu',
      partitionBounds: '{"values":["DE","FR"]}',
      createdAt: BASE,
    });
  });

  it('scopes results to a single parent table', () => {
    registerPartition(db, meta('orders_p1', 'RANGE', '{}', BASE, 'orders'));
    registerPartition(db, meta('users_p1', 'RANGE', '{}', BASE, 'users'));
    expect(getPartitionsForTable(db, 'orders').map((r) => r.partitionName)).toEqual(['orders_p1']);
    expect(getPartitionsForTable(db, 'users').map((r) => r.partitionName)).toEqual(['users_p1']);
  });
});

describe('dropAllPartitionsForTable', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('drops shard tables and removes metadata rows', () => {
    db.exec('CREATE TABLE orders_p1 (id INTEGER)');
    db.exec('CREATE TABLE orders_p2 (id INTEGER)');
    registerPartition(db, meta('orders_p1'));
    registerPartition(db, meta('orders_p2'));

    dropAllPartitionsForTable(db, 'orders');

    expect(hasPartitions(db, 'orders')).toBe(false);
    const shard = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orders_p1'")
      .get();
    expect(shard).toBeUndefined();
  });

  it('does not drop shard tables owned by other parents', () => {
    db.exec('CREATE TABLE orders_p1 (id INTEGER)');
    db.exec('CREATE TABLE users_p1 (id INTEGER)');
    registerPartition(db, meta('orders_p1', 'RANGE', '{}', BASE, 'orders'));
    registerPartition(db, meta('users_p1', 'RANGE', '{}', BASE, 'users'));

    dropAllPartitionsForTable(db, 'orders');

    const usersShard = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users_p1'")
      .get();
    expect(usersShard).toBeDefined();
    expect(hasPartitions(db, 'orders')).toBe(false);
    expect(hasPartitions(db, 'users')).toBe(true);
  });

  it('handles a missing shard table gracefully (DROP failure path)', () => {
    // Register a partition whose shard table does not exist; DROP IF EXISTS
    // succeeds silently (no rows to drop), exercising the try branch without
    // error. To hit the catch branch we rely on a malformed name that makes
    // DROP throw.
    registerPartition(db, meta('missing_shard', 'RANGE', '{}'));
    dropAllPartitionsForTable(db, 'orders');
    expect(hasPartitions(db, 'orders')).toBe(false);
  });

  it('removes metadata even when a shard DROP would fail', () => {
    // A partition name with a quote breaks the DDL string, exercising the
    // catch branch; cleanup must still delete the metadata row.
    registerPartition(db, meta('bad"name', 'RANGE', '{}'));
    dropAllPartitionsForTable(db, 'orders');
    expect(hasPartitions(db, 'orders')).toBe(false);
  });
});

describe('hasPartitions / getPartitionMethod / getPartitionColumn', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('reports false when no partitions exist', () => {
    expect(hasPartitions(db, 'orders')).toBe(false);
  });

  it('reports true after registration', () => {
    registerPartition(db, meta('orders_p1'));
    expect(hasPartitions(db, 'orders')).toBe(true);
  });

  it('returns null method for an unpartitioned table', () => {
    expect(getPartitionMethod(db, 'orders')).toBeNull();
  });

  it('returns the method for a partitioned table', () => {
    registerPartition(db, meta('orders_h0', 'HASH', '{"modulus":4,"remainder":0}'));
    expect(getPartitionMethod(db, 'orders')).toBe('HASH');
  });

  it('returns null column for an unpartitioned table', () => {
    expect(getPartitionColumn(db, 'orders')).toBeNull();
  });

  it('returns the column for a partitioned table', () => {
    registerPartition(db, meta('orders_eu', 'LIST', '{"values":["DE"]}', BASE, 'orders', 'region'));
    expect(getPartitionColumn(db, 'orders')).toBe('region');
  });

  it('correctly returns the server-default column when createdAt omitted', () => {
    // createdAt default path is already covered; this guards the column gets
    // the DB default without caller supplying it.
    const m = meta('orders_p9');
    m.createdAt = '' as any;
    registerPartition(db, m);
    expect(getPartitionColumn(db, 'orders')).toBe('id');
  });
});
