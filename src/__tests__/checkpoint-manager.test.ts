import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CheckpointManager } from '../analytics/CheckpointManager';
import type { DuckDBAnalyticsManager } from '../analytics/DuckDBAnalyticsManager';
import type { OLAPSchemaManager } from '../analytics/OLAPSchemaManager';
import type { ShardHandle } from '../storage/ShardManager';

/**
 * Lightweight stand-ins for the heavy runtime dependencies.
 *
 * CheckpointManager only touches three members of DuckDBAnalyticsManager
 * (`isAvailable`, `execRaw`, `execute`), and stores (but never reads) the
 * OLAPSchemaManager. ShardHandle is a real better-sqlite3 in-memory DB.
 */
function makeDuckStub(overrides: Partial<{
  isAvailable: boolean;
  execRaw: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    isAvailable: overrides.isAvailable ?? true,
    execRaw: overrides.execRaw ?? vi.fn().mockResolvedValue(undefined),
    execute: overrides.execute ?? vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as DuckDBAnalyticsManager;
}

function makeSchemaStub(): OLAPSchemaManager {
  return {} as unknown as OLAPSchemaManager;
}

function makeShard(shardId: number): ShardHandle {
  const db = new Database(':memory:');
  return { shardId, db } as unknown as ShardHandle;
}

function makeShardManager(shards: ShardHandle[]): {
  getShardIds: () => number[];
  getShard: (id: number) => ShardHandle | undefined;
} {
  return {
    getShardIds: () => shards.map((s) => s.shardId),
    getShard: (id: number) => shards.find((s) => s.shardId === id),
  };
}

describe('CheckpointManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('ensureCheckpointTable (DuckDB)', () => {
    it('no-ops when DuckDB is unavailable', async () => {
      const duck = makeDuckStub({ isAvailable: false });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.ensureCheckpointTable();
      expect(duck.execRaw).not.toHaveBeenCalled();
    });

    it('creates the table and marks ready on success', async () => {
      const duck = makeDuckStub();
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.ensureCheckpointTable();
      expect(duck.execRaw).toHaveBeenCalledTimes(1);
      expect(duck.execRaw.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS');
      // idempotent — second call is a no-op
      await cm.ensureCheckpointTable();
      expect(duck.execRaw).toHaveBeenCalledTimes(1);
    });

    it('keeps table not-ready when creation throws', async () => {
      const duck = makeDuckStub({
        execRaw: vi.fn().mockRejectedValue(new Error('boom')),
      });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.ensureCheckpointTable();
      // not ready — a subsequent saveCheckpoint must not attempt writes
      await cm.saveCheckpoint('k', 1, 2);
      expect(duck.execRaw).toHaveBeenCalledTimes(1); // only the failed CREATE
    });
  });

  describe('drawCheckpoints', () => {
    it('no-ops when unavailable or table not ready', async () => {
      const duck = makeDuckStub({ isAvailable: false });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.drawCheckpoints();
      expect(duck.execute).not.toHaveBeenCalled();
    });

    it('loads positive max_rowid checkpoints into memory', async () => {
      const duck = makeDuckStub({
        execute: vi.fn().mockResolvedValue({
          rows: [
            { table_key: '0:users', max_rowid: 42 },
            { table_key: '1:users', max_rowid: 0 },
            { table_key: '2:orders', max_rowid: 7 },
          ],
        }),
      });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.ensureCheckpointTable();
      await cm.drawCheckpoints();
      expect(cm.getCheckpoint(0, 'users')).toBe(42);
      expect(cm.getCheckpoint(1, 'users')).toBe(0); // zero skipped
      expect(cm.getCheckpoint(2, 'orders')).toBe(7);
    });

    it('handles "no such table" quietly', async () => {
      const duck = makeDuckStub({
        execute: vi.fn().mockRejectedValue(new Error('no such table foo')),
      });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.ensureCheckpointTable();
      await cm.drawCheckpoints();
      expect(cm.getWriteFailures()).toBe(0); // "no such table" is not a write failure
    });

    it('loads nothing from an empty result set', async () => {
      const duck = makeDuckStub({
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      cm.setCheckpoint(0, 'users', 5);
      await cm.ensureCheckpointTable();
      await cm.drawCheckpoints(); // empty -> loaded stays 0, existing kept
      expect(cm.getCheckpoint(0, 'users')).toBe(5);
    });

    it('increments failure counter on unexpected load error', async () => {
      const duck = makeDuckStub({
        execute: vi.fn().mockRejectedValue(new Error('unexpected')),
      });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.ensureCheckpointTable();
      await cm.drawCheckpoints();
      expect(cm.getWriteFailures()).toBe(1);
    });
  });

  describe('saveCheckpoint (DuckDB)', () => {
    it('no-ops when unavailable or table not ready', async () => {
      const duck = makeDuckStub({ isAvailable: false });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.saveCheckpoint('k', 1, 2);
      expect(duck.execRaw).not.toHaveBeenCalled();
    });

    it('escapes single quotes in the table key', async () => {
      const duck = makeDuckStub();
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.ensureCheckpointTable();
      await cm.saveCheckpoint("a'b", 1, 2);
      const sqls = duck.execRaw.mock.calls.map((c: any) => c[0]).join('\n');
      expect(sqls).toContain("'a''b'");
      expect(duck.execRaw).toHaveBeenCalledTimes(3); // create + delete + insert
    });

    it('resets the failure counter after a successful write', async () => {
      const duck = makeDuckStub();
      const cm = new CheckpointManager(duck, makeSchemaStub());
      // Prime failures by forcing a load error, then succeed a save.
      await cm.ensureCheckpointTable();
      duck.execute = vi.fn().mockRejectedValue(new Error('x')) as any;
      await cm.drawCheckpoints();
      expect(cm.getWriteFailures()).toBe(1);
      await cm.saveCheckpoint('k', 1, 2);
      expect(cm.getWriteFailures()).toBe(0);
    });

    it('aborts persistence after more than 5 failures', async () => {
      const duck = makeDuckStub({
        execRaw: vi.fn((sql: string) => {
          // CREATE succeeds (table becomes ready), but DELETE/INSERT fail.
          if (sql.includes('CREATE TABLE')) return Promise.resolve();
          return Promise.reject(new Error('write fails'));
        }),
      });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.ensureCheckpointTable();
      for (let i = 0; i < 7; i++) {
        await cm.saveCheckpoint('k', i, i);
      }
      // Once failures exceed 5, saveCheckpoint bails early without a write.
      expect(cm.getWriteFailures()).toBe(6);
      // 6 attempts each issued a DELETE (which threw before the INSERT ran).
      const writeCalls = duck.execRaw.mock.calls.filter((c: any) =>
        c[0].includes('DELETE') || c[0].includes('INSERT'),
      );
      expect(writeCalls.length).toBe(6);
    });
  });

  describe('getDuckMaxCheckpoint', () => {
    it('returns 0 when unavailable', async () => {
      const duck = makeDuckStub({ isAvailable: false });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await expect(cm.getDuckMaxCheckpoint(0)).resolves.toBe(0);
    });

    it('returns the max rowid for a shard', async () => {
      const duck = makeDuckStub({
        execute: vi.fn().mockResolvedValue({ rows: [{ max_id: 99 }] }),
      });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.ensureCheckpointTable();
      await expect(cm.getDuckMaxCheckpoint(3)).resolves.toBe(99);
      expect(duck.execute.mock.calls[0][0]).toContain("LIKE '3:%'");
    });

    it('returns 0 when the query returns no rows', async () => {
      const duck = makeDuckStub({ execute: vi.fn().mockResolvedValue({ rows: [] }) });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.ensureCheckpointTable();
      await expect(cm.getDuckMaxCheckpoint(0)).resolves.toBe(0);
    });

    it('returns 0 on query error', async () => {
      const duck = makeDuckStub({
        execute: vi.fn().mockRejectedValue(new Error('bad')),
      });
      const cm = new CheckpointManager(duck, makeSchemaStub());
      await cm.ensureCheckpointTable();
      await expect(cm.getDuckMaxCheckpoint(0)).resolves.toBe(0);
    });
  });

  describe('in-memory checkpoints', () => {
    it('formats composite keys and defaults missing entries to 0', () => {
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      expect(cm.checkpointKey(5, 'tbl')).toBe('5:tbl');
      expect(cm.getCheckpoint(5, 'tbl')).toBe(0);
      cm.setCheckpoint(5, 'tbl', 123);
      expect(cm.getCheckpoint(5, 'tbl')).toBe(123);
    });

    it('returns default counters for an unknown shard', () => {
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      expect(cm.shardCounters(9)).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    });

    it('returns existing counters and exposes a mutable checkpoint ref', () => {
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      const cp = cm.ensureCheckpoint();
      cp.counters.set('shard_9', { inserted: 1, updated: 2, deleted: 3 });
      expect(cm.shardCounters(9)).toEqual({ inserted: 1, updated: 2, deleted: 3 });
      expect(cm.getWriteFailures()).toBe(0);
    });
  });

  describe('SQLite shard checkpoint redundancy', () => {
    it('creates the checkpoint table in a shard (idempotent)', () => {
      const shard = makeShard(1);
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      cm.ensureCheckpointTableInShard(shard);
      cm.ensureCheckpointTableInShard(shard); // no throw on second call
      const cnt = shard.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?", )
        .get('_sqlvec_checkpoints') as any;
      expect(cnt).toBeTruthy();
    });

    it('creates the table across all registered shards', () => {
      const s0 = makeShard(0);
      const s1 = makeShard(1);
      const sm = makeShardManager([s0, s1]);
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      cm.ensureCheckpointTableInAllShards(sm as any);
      for (const s of [s0, s1]) {
        const row = s.db
          .prepare("SELECT name FROM sqlite_master WHERE name='_sqlvec_checkpoints'")
          .get() as any;
        expect(row).toBeTruthy();
      }
    });

    it('upserts and reads back a checkpoint via saveCheckpointToShard', () => {
      const shard = makeShard(2);
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      cm.ensureCheckpointTableInShard(shard);
      cm.saveCheckpointToShard(shard, '2:users', 100, 5);
      cm.saveCheckpointToShard(shard, '2:users', 200, 6); // update path
      const row = shard.db
        .prepare('SELECT max_rowid, row_count FROM _sqlvec_checkpoints WHERE table_key=?')
        .get('2:users') as any;
      expect(row.max_rowid).toBe(200);
      expect(row.row_count).toBe(6);
    });

    it('drawCheckpointsFromShards loads active positive checkpoints', () => {
      const s0 = makeShard(0);
      const s1 = makeShard(1);
      const sm = makeShardManager([s0, s1]);
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      cm.ensureCheckpointTableInShard(s0);
      cm.ensureCheckpointTableInShard(s1);
      cm.saveCheckpointToShard(s0, '0:a', 10, 1);
      cm.saveCheckpointToShard(s1, '1:b', 20, 2);
      const loaded = cm.drawCheckpointsFromShards(sm as any);
      expect(loaded.get('0:a')).toBe(10);
      expect(loaded.get('1:b')).toBe(20);
    });

    it('skips shards whose checkpoint table does not exist', () => {
      const s0 = makeShard(0); // table NOT created -> SELECT throws
      const sm = makeShardManager([s0]);
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      const loaded = cm.drawCheckpointsFromShards(sm as any);
      expect(loaded.size).toBe(0);
    });

    it('skips shards that are missing from the manager', () => {
      const sm = {
        getShardIds: () => [42],
        getShard: () => undefined as any,
      };
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      expect(cm.drawCheckpointsFromShards(sm as any).size).toBe(0);
    });

    it('ensureCheckpointTableInAllShards skips missing shards', () => {
      const sm = {
        getShardIds: () => [1, 2],
        getShard: (id: number) => (id === 1 ? makeShard(1) : undefined),
      };
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      expect(() =>
        cm.ensureCheckpointTableInAllShards(sm as any),
      ).not.toThrow();
    });

    it('drawCheckpointsFromShards skips non-positive max_rowid rows', () => {
      const s0 = makeShard(0);
      const sm = makeShardManager([s0]);
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      cm.ensureCheckpointTableInShard(s0);
      // Insert a zero max_rowid row directly; it must be skipped.
      s0.db
        .prepare(
          'INSERT INTO _sqlvec_checkpoints (table_key, max_rowid, row_count, status, updated_at) VALUES (?,?,?,?,?)',
        )
        .run('0:zero', 0, 1, 'active', Date.now());
      const loaded = cm.drawCheckpointsFromShards(sm as any);
      expect(loaded.size).toBe(0);
    });

    it('swallows a shard exec error during table creation', () => {
      const badShard = {
        shardId: 7,
        db: { exec: () => { throw new Error('exec boom'); } },
      } as unknown as ShardHandle;
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      expect(() => cm.ensureCheckpointTableInShard(badShard)).not.toThrow();
    });

    it('swallows a shard prepare error during save', () => {
      const badShard = {
        shardId: 8,
        db: { prepare: () => { throw new Error('prepare boom'); } },
      } as unknown as ShardHandle;
      const cm = new CheckpointManager(makeDuckStub(), makeSchemaStub());
      expect(() => cm.saveCheckpointToShard(badShard, '8:k', 1, 1)).not.toThrow();
    });
  });
});
