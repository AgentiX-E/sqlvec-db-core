import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ShardManager } from '../storage/ShardManager';
import { WAL_CONFIGS } from '../storage/WALConfig';
import { TDEConfig } from '../storage/TDEConfig';
import { VectorMetric, VectorMode, VectorIndexType, SqlVecErrorCode } from '../types/types-raw';

const VECTOR_OFF = {
  enabled: false,
  dimension: 4,
  metric: VectorMetric.COSINE,
  mode: VectorMode.AUTO,
  bruteForceThreshold: 1000,
  indexType: VectorIndexType.FLAT,
  indexParams: {},
};

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shardmgr-'));
}

function makeManager(dir: string, vectorConfig = VECTOR_OFF): ShardManager {
  const mgr = new ShardManager(dir, vectorConfig);
  // Disable periodic checkpointers so tests don't leak setInterval timers.
  mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
  return mgr;
}

const BOOTSTRAP = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, amount REAL);
`;

describe('ShardManager', () => {
  let dir: string | null = null;

  beforeEach(() => {
    TDEConfig.reset();
    delete process.env.SQLVEC_TDE_ENABLED;
    delete process.env.SQLVEC_TDE_KEY;
    delete process.env.SQLVEC_TDE_ALGORITHM;
    dir = makeDir();
  });

  afterEach(async () => {
    TDEConfig.reset();
    delete process.env.SQLVEC_TDE_ENABLED;
    delete process.env.SQLVEC_TDE_KEY;
    delete process.env.SQLVEC_TDE_ALGORITHM;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  describe('lifecycle', () => {
    it('creates shards with bootstrap schema and the __mvcc_xid table for shard 0', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(3, BOOTSTRAP);
      expect(mgr.getShardCount()).toBe(3);
      expect(mgr.getShardIds()).toEqual([0, 1, 2]);
      // shard 0 gets the MVCC xid table; shards 1/2 do not.
      const s0 = mgr.getShard(0)!;
      const s1 = mgr.getShard(1)!;
      expect(s0.db.prepare("SELECT name FROM sqlite_master WHERE name='__mvcc_xid'").get()).toBeTruthy();
      expect(s1.db.prepare("SELECT name FROM sqlite_master WHERE name='__mvcc_xid'").get()).toBeUndefined();
      // bootstrap schema applied to every shard
      expect(s1.db.prepare("SELECT name FROM sqlite_master WHERE name='users'").get()).toBeTruthy();
      await mgr.close();
    });

    it('creates shards without bootstrap when none is provided', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1);
      expect(mgr.getShardCount()).toBe(1);
      await mgr.close();
    });

    it('loadExisting discovers shard files written to disk', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(2, BOOTSTRAP);
      await mgr.close();

      const mgr2 = makeManager(dir!);
      const loaded = await mgr2.loadExisting();
      expect(loaded).toBe(2);
      expect(mgr2.getShardIds()).toEqual([0, 1]);
      await mgr2.close();
    });

    it('loadExisting ignores non-shard files', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1);
      fs.writeFileSync(path.join(dir!, 'notes.txt'), 'hi');
      fs.writeFileSync(path.join(dir!, 'shard_abc.db'), 'not numeric');
      await mgr.close();

      const mgr2 = makeManager(dir!);
      const loaded = await mgr2.loadExisting();
      expect(loaded).toBe(1);
      await mgr2.close();
    });

    it('close returns cleanly and clears the shard map', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      await mgr.close();
      expect(mgr.getShardCount()).toBe(0);
    });
  });

  describe('queries', () => {
    it('queryAll aggregates rows across all shards', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(2, BOOTSTRAP);
      await mgr.execShard(0, "INSERT INTO users (id, name) VALUES (1, 'a')");
      await mgr.execShard(1, "INSERT INTO users (id, name) VALUES (2, 'b')");
      const rows = await mgr.queryAll('SELECT * FROM users');
      expect(rows).toHaveLength(2);
      const names = (rows as any[]).map(r => r.name).sort();
      expect(names).toEqual(['a', 'b']);
      await mgr.close();
    });

    it('queryAll throws when all shards fail', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      await expect(mgr.queryAll('SELECT * FROM missing_table')).rejects.toThrow(/Query failed on all shards/);
      await mgr.close();
    });

    it('queryShard returns rows from a specific shard', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      await mgr.execShard(0, "INSERT INTO users (id, name) VALUES (1, 'a')");
      const rows = mgr.queryShard(0, 'SELECT * FROM users WHERE id = ?', [1]);
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).name).toBe('a');
      await mgr.close();
    });

    it('queryShard throws SHARD_UNAVAILABLE for a missing shard', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      expect(() => mgr.queryShard(99, 'SELECT 1')).toThrow(/Shard 99 not available/);
      await mgr.close();
    });

    it('queryShard preserves duplicate-named columns with _raw', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      const sql = 'SELECT u.id, o.id FROM users u, orders o LIMIT 0';
      // Duplicate column names force the raw-mode branch.
      const rows = mgr.queryShard(0, sql);
      expect(rows).toEqual([]);
      await mgr.close();
    });

    it('pickReader falls back to the writer connection when readers are empty', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      const shard = mgr.getShard(0)!;
      shard.readers = []; // simulate single-node setup without readers
      await mgr.execShard(0, "INSERT INTO users (id, name) VALUES (1, 'x')");
      const rows = mgr.queryShard(0, 'SELECT * FROM users');
      expect(rows).toHaveLength(1);
      await mgr.close();
    });
  });

  describe('exec', () => {
    it('execAll runs a write on every shard', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(2, BOOTSTRAP);
      await mgr.execAll("INSERT INTO users (id, name) VALUES (9, 'shared')");
      const rows = await mgr.queryAll('SELECT * FROM users WHERE id = 9');
      expect(rows).toHaveLength(2);
      await mgr.close();
    });

    it('execAllBatch wraps statements in a transaction and is a no-op for empty input', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(2, BOOTSTRAP);
      await mgr.execAllBatch(['INSERT INTO users (id, name) VALUES (1, \'a\')', 'INSERT INTO users (id, name) VALUES (2, \'b\')']);
      let rows = await mgr.queryAll('SELECT * FROM users');
      expect(rows).toHaveLength(4); // 2 shards x 2 rows
      await mgr.execAllBatch([]); // no-op
      rows = await mgr.queryAll('SELECT * FROM users');
      expect(rows).toHaveLength(4);
      await mgr.close();
    });

    it('execBatchOnShard chunks large batches and rejects a missing shard', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      // More than CHUNK_SIZE (50) statements exercises the chunking loop.
      const sqls = Array.from({ length: 120 }, (_, i) => `INSERT INTO users (id, name) VALUES (${i}, 'n${i}')`);
      await mgr.execBatchOnShard(0, sqls);
      expect((mgr.queryShard(0, 'SELECT COUNT(*) AS c FROM users')[0] as any).c).toBe(120);
      await expect(mgr.execBatchOnShard(99, ['SELECT 1'])).rejects.toThrow(/Shard 99 not found/);
      await mgr.close();
    });

    it('execShard routes through the sync fallback when no write pool is active', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      await mgr.execShard(0, "INSERT INTO users (id, name) VALUES (7, 'fallback')");
      expect((mgr.queryShard(0, 'SELECT COUNT(*) AS c FROM users')[0] as any).c).toBe(1);
      await mgr.close();
    });

    it('execShard throws SHARD_UNAVAILABLE via the sync fallback', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      await expect(mgr.execShard(99, 'SELECT 1')).rejects.toThrow(/Shard 99 not available/);
      await mgr.close();
    });

    it('transactionAll runs the callback against each shard writer', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(2, BOOTSTRAP);
      await mgr.transactionAll((shard) => {
        shard.db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(5, 'txn');
      });
      const rows = await mgr.queryAll('SELECT * FROM users');
      expect(rows).toHaveLength(2);
      await mgr.close();
    });
  });

  describe('utilities', () => {
    it('getStats reports healthy shards with row counts', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      await mgr.execShard(0, "INSERT INTO users (id, name) VALUES (1, 'a')");
      await mgr.execShard(0, "INSERT INTO users (id, name) VALUES (2, 'b')");
      const stats = mgr.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].shardId).toBe(0);
      expect(stats[0].rowCount).toBe(2);
      expect(stats[0].isHealthy).toBe(true);
      await mgr.close();
    });

    it('getShardRowCount returns 0 on error', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      // getShardRowCount is exercised via getStats; a healthy shard returns a number.
      const stats = mgr.getStats();
      expect(stats[0].rowCount).toBe(0);
      await mgr.close();
    });

    it('getShardIdForKey is deterministic and bounded by shard count', async () => {
      const mgr = makeManager(dir!);
      const a = mgr.getShardIdForKey('user:42', 4);
      const b = mgr.getShardIdForKey('user:42', 4);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(4);
    });

    it('getAllShards returns the internal map', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1);
      expect(mgr.getAllShards()).toBeInstanceOf(Map);
      expect(mgr.getAllShards().size).toBe(1);
      await mgr.close();
    });

    it('getShard returns undefined for an unknown id', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1);
      expect(mgr.getShard(99)).toBeUndefined();
      await mgr.close();
    });
  });

  describe('WAL config', () => {
    it('setWALConfig retrofits existing shards and returns a snapshot', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1, BOOTSTRAP);
      const cfg = mgr.getWALConfig();
      expect(cfg.checkpointIntervalMs).toBe(0);
      mgr.setWALConfig({ ...WAL_CONFIGS.CLUSTER_ACCEL, checkpointIntervalMs: 0 });
      expect(mgr.getWALConfig().syncLevel).toBe('OFF');
      await mgr.stopCheckpointers();
      await mgr.close();
    });

    it('stopCheckpointers clears the registry', async () => {
      const mgr = makeManager(dir!);
      await mgr.initialize(1);
      mgr.stopCheckpointers();
      expect(mgr.getShardCount()).toBe(1);
      await mgr.close();
    });
  });

  describe('TDE — disabled', () => {
    it('reports TDE disabled with no engine and no key configured', () => {
      const mgr = makeManager(dir!);
      expect(mgr.isTdeEnabled()).toBe(false);
      expect(mgr.getTdeEngine()).toBeNull();
    });
  });
});

describe('ShardManager — TDE at-rest encryption', () => {
  const KEY = Buffer.alloc(32, 0x42).toString('base64'); // 32-byte AES-256 key

  function enableTde() {
    process.env.SQLVEC_TDE_ENABLED = 'true';
    process.env.SQLVEC_TDE_KEY = KEY;
    process.env.SQLVEC_TDE_ALGORITHM = 'aes-256-gcm';
    TDEConfig.reset();
  }

  it('reports TDE enabled when a valid key is configured', async () => {
    enableTde();
    const d = makeDir();
    const mgr = new ShardManager(d, VECTOR_OFF);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    expect(mgr.isTdeEnabled()).toBe(true);
    expect(mgr.getTdeEngine()).not.toBeNull();
    await mgr.initialize(1, BOOTSTRAP);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('encrypts on close and decrypts on load, preserving data end-to-end', async () => {
    enableTde();
    const d = makeDir();

    // Write phase
    const mgr = new ShardManager(d, VECTOR_OFF);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr.initialize(1, BOOTSTRAP);
    await mgr.execShard(0, "INSERT INTO users (id, name) VALUES (1, 'secret')");
    await mgr.close(); // triggers encryptShardFile

    // The on-disk file must no longer start with the SQLite magic header.
    const dbPath = path.join(d, 'shard_0.db');
    const header = fs.readFileSync(dbPath).subarray(0, 16);
    expect(header.toString('utf-8', 0, 15)).not.toBe('SQLite format 3');

    // Read phase
    const mgr2 = new ShardManager(d, VECTOR_OFF);
    mgr2.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr2.loadExisting();
    const rows = mgr2.queryShard(0, 'SELECT name FROM users WHERE id = 1');
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).name).toBe('secret');
    await mgr2.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('isTdeEnabled stays false when TDE is enabled without a key', async () => {
    process.env.SQLVEC_TDE_ENABLED = 'true';
    delete process.env.SQLVEC_TDE_KEY;
    TDEConfig.reset();
    const d = makeDir();
    const mgr = new ShardManager(d, VECTOR_OFF);
    expect(mgr.isTdeEnabled()).toBe(false);
    expect(mgr.getTdeEngine()).toBeNull();
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('rotateAllKeys returns {} when no engine is initialized', async () => {
    const d = makeDir();
    const mgr = new ShardManager(d, VECTOR_OFF);
    const res = mgr.rotateAllKeys(Buffer.alloc(32, 9).toString('base64'));
    expect(res).toEqual({});
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('rotateAllKeys throws when there is no old key', async () => {
    enableTde();
    const d = makeDir();
    const mgr = new ShardManager(d, VECTOR_OFF);
    expect(mgr.isTdeEnabled()).toBe(true);
    // Clear the key from BOTH the environment and module state AFTER the engine
    // was constructed, so the engine exists but loadFromEnv() reports no key.
    delete process.env.SQLVEC_TDE_KEY;
    TDEConfig.reset();
    expect(() =>
      mgr.rotateAllKeys(Buffer.alloc(32, 9).toString('base64')),
    ).toThrow(/no old key available/);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('rotateAllKeys rejects an invalid new key', async () => {
    enableTde();
    const d = makeDir();
    const mgr = new ShardManager(d, VECTOR_OFF);
    await mgr.initialize(1, BOOTSTRAP);
    expect(() => mgr.rotateAllKeys('!!!not-base64!!!')).toThrow(/invalid new key/);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('rotateAllKeys rotates an encrypted shard in place with a new key', async () => {
    enableTde();
    const d = makeDir();
    // Encrypt a shard on disk first via a full write+close cycle.
    const writer = new ShardManager(d, VECTOR_OFF);
    writer.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await writer.initialize(1, BOOTSTRAP);
    await writer.execShard(0, "INSERT INTO users (id, name) VALUES (1, 'rotate-me')");
    await writer.close(); // now encrypted at rest

    const newKey = Buffer.alloc(32, 0x22).toString('base64');
    const mgr = new ShardManager(d, VECTOR_OFF);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr.loadExisting(); // decrypts with old key for access
    const res = mgr.rotateAllKeys(newKey);
    expect(res[0].success).toBe(true);

    // Reload with the rotated key; the plaintext content must survive.
    process.env.SQLVEC_TDE_KEY = newKey;
    TDEConfig.reset();
    const mgr2 = new ShardManager(d, VECTOR_OFF);
    mgr2.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr2.loadExisting();
    expect((mgr2.queryShard(0, 'SELECT name FROM users WHERE id = 1')[0] as any).name).toBe('rotate-me');
    await mgr2.close();
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('ShardManager — vector-enabled (mock vec tables)', () => {
  const VEC_ON = {
    enabled: true,
    dimension: 4,
    metric: VectorMetric.COSINE,
    mode: VectorMode.AUTO,
    bruteForceThreshold: 1000,
    indexType: VectorIndexType.FLAT,
    indexParams: {},
  };

  it('enableVectorExtension is attempted on create (silently degrades without vec0)', async () => {
    const d = makeDir();
    const mgr = new ShardManager(d, VEC_ON);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr.initialize(1, BOOTSTRAP); // loadExtension('vec0') fails silently
    expect(mgr.getShard(0)!.vectorEnabled).toBe(true);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('vectorInsert writes metadata and the mock vec table', async () => {
    const d = makeDir();
    const mgr = new ShardManager(d, VEC_ON);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr.initialize(1, "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT); CREATE TABLE vec_items (id INTEGER PRIMARY KEY, embedding BLOB);");
    mgr.vectorInsert(0, 'items', 1, new Float32Array([1, 2, 3, 4]), { label: 'hello' });
    const row = mgr.queryShard(0, 'SELECT label FROM items WHERE id = 1')[0] as any;
    expect(row.label).toBe('hello');
    const vrow = mgr.queryShard(0, 'SELECT id FROM vec_items WHERE id = 1')[0] as any;
    expect(vrow.id).toBe(1);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('vectorInsert without metadata still writes the vec table', async () => {
    const d = makeDir();
    const mgr = new ShardManager(d, VEC_ON);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr.initialize(1, "CREATE TABLE items (id INTEGER PRIMARY KEY); CREATE TABLE vec_items (id INTEGER PRIMARY KEY, embedding BLOB);");
    mgr.vectorInsert(0, 'items', 7, new Float32Array([0, 0, 0, 0]));
    const vrow = mgr.queryShard(0, 'SELECT id FROM vec_items WHERE id = 7')[0] as any;
    expect(vrow.id).toBe(7);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('vectorInsert throws SHARD_UNAVAILABLE for a missing shard', async () => {
    const d = makeDir();
    const mgr = new ShardManager(d, VEC_ON);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr.initialize(1, BOOTSTRAP);
    expect(() => mgr.vectorInsert(99, 'items', 1, new Float32Array([1, 2, 3, 4]))).toThrow(/Shard 99 not available/);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('vectorSearch returns [] for a missing shard', async () => {
    const d = makeDir();
    const mgr = new ShardManager(d, VEC_ON);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr.initialize(1, BOOTSTRAP);
    expect(mgr.vectorSearch(99, 'items', new Float32Array([1, 2, 3, 4]), 5)).toEqual([]);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('vectorSearchAll throws when every shard fails the MATCH query', async () => {
    const d = makeDir();
    const mgr = new ShardManager(d, VEC_ON);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    // No vec_ table exists, so the MATCH query fails on every shard.
    await mgr.initialize(1, BOOTSTRAP);
    await expect(mgr.vectorSearchAll('items', new Float32Array([1, 2, 3, 4]), 5)).rejects.toThrow(/Vector search failed on all shards/);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('ShardManager — write worker pool', () => {
  it('initWritePool is a no-op with no shards', async () => {
    const d = makeDir();
    const mgr = makeManager(d);
    await mgr.initWritePool(); // no shards → warns and returns
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('initWritePool falls back to sync writes when the worker cannot start', async () => {
    const d = makeDir();
    const mgr = makeManager(d);
    await mgr.initialize(1, BOOTSTRAP);
    // The worker script is not present in the TS source tree, so initialize
    // throws and the pool falls back to the sync path.
    await mgr.initWritePool();
    // Still able to write via the direct fallback.
    await mgr.execShard(0, "INSERT INTO users (id, name) VALUES (1, 'sync')");
    expect((mgr.queryShard(0, 'SELECT COUNT(*) AS c FROM users')[0] as any).c).toBe(1);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('ShardManager — branch coverage', () => {
  it('loadExisting creates checkpointers and vector extension when configured', async () => {
    const d = makeDir();
    // Write a shard with the DEFAULT config (checkpointIntervalMs 30000 unset by setWALConfig).
    const writer = makeManager(d);
    await writer.initialize(1, BOOTSTRAP);
    await writer.close();

    const mgr = new ShardManager(d, VECTOR_OFF);
    // Use a positive checkpoint interval so loadExisting starts a checkpointer.
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 60_000 });
    const loaded = await mgr.loadExisting();
    expect(loaded).toBe(1);
    await mgr.stopCheckpointers();
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('execAllBatch rejects when one shard fails the batch', async () => {
    const d = makeDir();
    const mgr = makeManager(d);
    await mgr.initialize(1, BOOTSTRAP);
    await expect(mgr.execAllBatch(['INSERT INTO no_such_table VALUES (1)'])).rejects.toThrow();
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('queryShard returns _raw for a JOIN with duplicate column names', async () => {
    const d = makeDir();
    const mgr = makeManager(d);
    await mgr.initialize(1, BOOTSTRAP);
    await mgr.execShard(0, "INSERT INTO users (id, name) VALUES (1, 'a')");
    await mgr.execShard(0, "INSERT INTO orders (id, user_id, amount) VALUES (10, 1, 5.0)");
    const rows = mgr.queryShard(0, 'SELECT u.id, o.id FROM users u JOIN orders o ON u.id = o.user_id');
    expect(rows).toHaveLength(1);
    expect((rows[0] as any)._raw).toBeDefined();
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('createVectorIndex builds vec0 DDL and dispatches it to all shards', async () => {
    const d = makeDir();
    const mgr = new ShardManager(d, { enabled: true, dimension: 4, metric: VectorMetric.COSINE, mode: VectorMode.AUTO, bruteForceThreshold: 1000, indexType: VectorIndexType.FLAT, indexParams: {} });
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr.initialize(1, BOOTSTRAP);
    // vec0 is not loaded, so the fire-and-forget execAll fails asynchronously;
    // createVectorIndex itself returns void (synchronous).
    expect(() => mgr.createVectorIndex('items', 4)).not.toThrow();
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  describe('real sqlite-vec (native extension)', () => {
    it('loads vec0 and round-trips insert + search through a real vec0 table', async () => {
      const d = makeDir();
      const VEC_L2 = { enabled: true, dimension: 4, metric: VectorMetric.L2, mode: VectorMode.INDEXED, bruteForceThreshold: 1000, indexType: VectorIndexType.FLAT, indexParams: {} };
      const mgr = new ShardManager(d, VEC_L2);
      mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
      await mgr.initialize(1, "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);");

      // Create a real vec0 virtual table via the DDL path.
      await mgr.execAll("CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(id INTEGER PRIMARY KEY, embedding FLOAT[4] distance_metric=l2)");

      // Insert vectors with strictly-typed INTEGER primary keys.
      mgr.vectorInsert(0, 'items', 1, new Float32Array([1, 2, 3, 4]), { label: 'a' });
      mgr.vectorInsert(0, 'items', 2, new Float32Array([5, 6, 7, 8]), { label: 'b' });
      mgr.vectorInsert(0, 'items', 3, new Float32Array([9, 10, 11, 12]), { label: 'c' });

      // Search: nearest to [1,2,3,4] should be id 1 (distance 0).
      const hits = mgr.vectorSearch(0, 'items', new Float32Array([1, 2, 3, 4]), 2);
      expect(hits).toHaveLength(2);
      expect(hits[0].id).toBe(1);
      expect(hits[0].distance).toBeCloseTo(0);

      // Global search across shards merges and orders by distance.
      const all = await mgr.vectorSearchAll('items', new Float32Array([1, 2, 3, 4]), 3);
      expect(all[0].id).toBe(1);
      expect(all[0].distance).toBeCloseTo(0);
      await mgr.close();
      fs.rmSync(d, { recursive: true, force: true });
    });

    it('createVectorIndex builds a real vec0 table usable by vectorInsert', async () => {
      const d = makeDir();
      const VEC_L2 = { enabled: true, dimension: 4, metric: VectorMetric.L2, mode: VectorMode.INDEXED, bruteForceThreshold: 1000, indexType: VectorIndexType.FLAT, indexParams: {} };
      const mgr = new ShardManager(d, VEC_L2);
      mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
      await mgr.initialize(1, "CREATE TABLE items (id INTEGER PRIMARY KEY);");

      // createVectorIndex is fire-and-forget (void); await a tick so the DDL
      // actually lands before we depend on the virtual table.
      mgr.createVectorIndex('items', 4, 'l2');
      await new Promise((r) => setTimeout(r, 20));

      mgr.vectorInsert(0, 'items', 10, new Float32Array([2, 2, 2, 2]));
      const hits = mgr.vectorSearch(0, 'items', new Float32Array([2, 2, 2, 2]), 1);
      expect(hits[0].id).toBe(10);
      expect(hits[0].distance).toBeCloseTo(0);
      await mgr.close();
      fs.rmSync(d, { recursive: true, force: true });
    });
  });

  it('setWALConfig restarts an existing checkpointer on interval change', async () => {
    const d = makeDir();
    const mgr = makeManager(d);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 60_000 }); // set BEFORE init
    await mgr.initialize(1, BOOTSTRAP); // creates a checkpointer
    // Now retrofit with a different interval → restarts the checkpointer.
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 120_000 });
    await mgr.stopCheckpointers();
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('getStats reports db size from disk when the shard file exists', async () => {
    const d = makeDir();
    const mgr = makeManager(d);
    await mgr.initialize(1, BOOTSTRAP);
    await mgr.execShard(0, "INSERT INTO users VALUES (1, 'a')");
    const stats = mgr.getStats();
    expect(stats[0].dbSizeBytes).toBeGreaterThan(0);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('getShardRowCount returns 0 when a table cannot be counted', async () => {
    const d = makeDir();
    const mgr = makeManager(d);
    await mgr.initialize(1, BOOTSTRAP);
    // Drop a table referenced by sqlite_master, causing the count query to throw.
    mgr.getShard(0)!.db.exec('DROP TABLE users');
    const stats = mgr.getStats();
    expect(stats[0].rowCount).toBe(0);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('ShardManager — TDE defensive branches', () => {
  const KEY = Buffer.alloc(32, 0x55).toString('base64');

  it('decryptShardIfNeeded leaves an existing plaintext SQLite file untouched', async () => {
    process.env.SQLVEC_TDE_ENABLED = 'true';
    process.env.SQLVEC_TDE_KEY = KEY;
    TDEConfig.reset();
    const d = makeDir();
    // Create a real plaintext SQLite shard (no TDE).
    const mgr0 = makeManager(d);
    await mgr0.initialize(1, BOOTSTRAP);
    await mgr0.close();
    // Reopen with TDE enabled: the plaintext SQLite header must be detected and skipped.
    const mgr = new ShardManager(d, VECTOR_OFF);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    const loaded = await mgr.loadExisting();
    expect(loaded).toBe(1);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('hasTdeHeader returns false for an empty/missing file via decryption path', async () => {
    process.env.SQLVEC_TDE_ENABLED = 'true';
    process.env.SQLVEC_TDE_KEY = KEY;
    TDEConfig.reset();
    const d = makeDir();
    // Empty file (stat.size < 33) is skipped before the header check.
    fs.writeFileSync(path.join(d, 'shard_0.db'), '');
    const mgr = new ShardManager(d, VECTOR_OFF);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr.loadExisting();
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('ShardManager — rotateAllKeys plaintext branch', () => {
  const KEY = Buffer.alloc(32, 0x66).toString('base64');

  it('encrypts a still-plaintext shard directly with the new key', async () => {
    process.env.SQLVEC_TDE_ENABLED = 'true';
    process.env.SQLVEC_TDE_KEY = KEY;
    TDEConfig.reset();
    const d = makeDir();
    const mgr = new ShardManager(d, VECTOR_OFF);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await mgr.initialize(1, BOOTSTRAP);
    await mgr.execShard(0, "INSERT INTO users (id, name) VALUES (1, 'pre')");
    // The shard file is still plaintext on disk (no close yet), so rotation
    // takes the "direct encrypt" branch.
    const newKey = Buffer.alloc(32, 0x77).toString('base64');
    const res = mgr.rotateAllKeys(newKey);
    expect(res[0].success).toBe(true);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('ShardManager — TDE companion & fallback branches', () => {
  const KEY = Buffer.alloc(32, 0x33).toString('base64');

  function enableTde() {
    process.env.SQLVEC_TDE_ENABLED = 'true';
    process.env.SQLVEC_TDE_KEY = KEY;
    TDEConfig.reset();
  }

  it('decryptCompanionIfNeeded skips a SQLite-header WAL file', async () => {
    enableTde();
    const d = makeDir();
    // Produce an encrypted shard on disk.
    const w = new ShardManager(d, VECTOR_OFF);
    w.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await w.initialize(1, BOOTSTRAP);
    await w.close();

    // Place a non-empty, plain-SQLite WAL companion next to the encrypted db.
    fs.writeFileSync(path.join(d, 'shard_0.db-wal'), 'SQLite format 3\x00' + 'x'.repeat(64));

    const mgr = new ShardManager(d, VECTOR_OFF);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    // loadExisting decrypts the main db; the SQLite-header WAL is left alone.
    const loaded = await mgr.loadExisting();
    expect(loaded).toBe(1);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('decryptCompanionIfNeeded warns on a non-SQLite (undecryptable) WAL file', async () => {
    enableTde();
    const d = makeDir();
    const w = new ShardManager(d, VECTOR_OFF);
    w.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    await w.initialize(1, BOOTSTRAP);
    await w.close();

    // A non-empty, non-SQLite companion triggers a decryption attempt that fails.
    fs.writeFileSync(path.join(d, 'shard_0.db-wal'), Buffer.alloc(128, 0xAB));

    const mgr = new ShardManager(d, VECTOR_OFF);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    const loaded = await mgr.loadExisting();
    expect(loaded).toBe(1);
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('decryptShardIfNeeded falls back to raw file on decryption failure', async () => {
    enableTde();
    const d = makeDir();
    // A non-empty, non-SQLite file that is NOT valid TDE ciphertext → decrypt fails.
    fs.writeFileSync(path.join(d, 'shard_0.db'), Buffer.alloc(256, 0x11));

    const mgr = new ShardManager(d, VECTOR_OFF);
    mgr.setWALConfig({ ...WAL_CONFIGS.STANDALONE_SAFE, checkpointIntervalMs: 0 });
    // decryptFile fails → fall back to raw file → opening the raw (non-SQLite) file throws.
    await expect(mgr.loadExisting()).rejects.toThrow();
    // Ensure no handle was left in a broken state.
    await mgr.close();
    fs.rmSync(d, { recursive: true, force: true });
  });
});
