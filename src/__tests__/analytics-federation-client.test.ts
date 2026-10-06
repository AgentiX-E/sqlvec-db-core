import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the concrete strategies to control availability/execution precisely.
vi.mock('../analytics/strategies/LocalColumnarStrategy', () => {
  return {
    LocalColumnarStrategy: vi.fn().mockImplementation(function (duckDB) {
      this.name = 'local';
      this.priority = 0;
      this.duckDB = duckDB;
      this.available = vi.fn(async () => true);
      this.execute = vi.fn(async (sql: string) => ({ __local: true, sql }));
      this.registerTable = vi.fn();
    }),
  };
});

vi.mock('../analytics/strategies/HttpfsStrategy', () => {
  return {
    HttpfsStrategy: vi.fn().mockImplementation(function (duckDB, config) {
      this.name = 'httpfs';
      this.priority = 20;
      this.duckDB = duckDB;
      this.config = config;
      this.available = vi.fn(async () => true);
      this.execute = vi.fn(async (sql: string) => ({ __httpfs: true, sql }));
      this.registerTable = vi.fn(function (t) {
        (this.tables ??= []).push(t);
      });
    }),
  };
});

vi.mock('../analytics/strategies/NodeTransportStrategy', () => {
  return {
    NodeTransportStrategy: vi.fn().mockImplementation(function (duckDB, config) {
      this.name = 'node_transport';
      this.priority = 30;
      this.duckDB = duckDB;
      this.config = config;
      this.available = vi.fn(async () => true);
      this.execute = vi.fn(async (sql: string) => ({ __node: true, sql }));
      this.registerTable = vi.fn();
    }),
  };
});

import { AnalyticsFederationClient } from '../analytics/AnalyticsFederationClient';
import { LocalColumnarStrategy } from '../analytics/strategies/LocalColumnarStrategy';
import { HttpfsStrategy } from '../analytics/strategies/HttpfsStrategy';
import { NodeTransportStrategy } from '../analytics/strategies/NodeTransportStrategy';

const fakeDuck = { isAvailable: true, execute: async () => ({}) } as any;

function makeClient(config?: any) {
  return new AnalyticsFederationClient(fakeDuck, config);
}

describe('AnalyticsFederationClient constructor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers local strategy with no config', () => {
    const c = makeClient();
    expect(c.getStrategies()).toEqual([{ name: 'local', priority: 0 }]);
  });

  it('registers local strategy when localColumnar is not false', () => {
    expect(makeClient({}).getStrategies()).toEqual([{ name: 'local', priority: 0 }]);
    expect(makeClient({ localColumnar: true }).getStrategies()).toEqual([
      { name: 'local', priority: 0 },
    ]);
  });

  it('registers httpfs when enabled (strips enabled flag from config)', () => {
    const c = makeClient({
      httpfs: { enabled: true, endpoint: 's3://b/p', region: 'us', accessKey: 'a', secretKey: 's' },
    });
    expect(c.getStrategies()).toEqual([
      { name: 'local', priority: 0 },
      { name: 'httpfs', priority: 20 },
    ]);
    // enabled flag must not be forwarded to the strategy config
    expect(HttpfsStrategy).toHaveBeenCalledTimes(1);
    const cfg = (HttpfsStrategy as any).mock.calls[0][1];
    expect(cfg).not.toHaveProperty('enabled');
    expect(cfg).toHaveProperty('endpoint', 's3://b/p');
  });

  it('registers node transport when enabled (strips enabled flag)', () => {
    const c = makeClient({
      nodeTransport: { enabled: true, peers: ['1.2.3.4:6543'] },
    });
    expect(c.getStrategies()).toEqual([
      { name: 'local', priority: 0 },
      { name: 'node_transport', priority: 30 },
    ]);
    const cfg = (NodeTransportStrategy as any).mock.calls[0][1];
    expect(cfg).not.toHaveProperty('enabled');
    expect(cfg).toEqual({ peers: ['1.2.3.4:6543'] });
  });

  it('produces an empty pool when localColumnar is explicitly disabled and no other strategy enabled', () => {
    const c = makeClient({ localColumnar: false });
    expect(c.getStrategies()).toEqual([]);
  });

  it('sorts strategies by ascending priority regardless of registration order', () => {
    const c = makeClient({
      localColumnar: true,
      httpfs: { enabled: true, endpoint: 's3://b/p', region: 'us', accessKey: 'a', secretKey: 's' },
      nodeTransport: { enabled: true, peers: ['1.2.3.4:6543'] },
    });
    expect(c.getStrategies().map((s) => s.priority)).toEqual([0, 20, 30]);
  });
});

describe('executeDistributed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('executes via the best available strategy', async () => {
    const c = makeClient();
    const r = await c.executeDistributed('SELECT 1');
    expect(r).toEqual({ __local: true, sql: 'SELECT 1' });
  });

  it('throws when no strategy is available', async () => {
    const c = makeClient({ localColumnar: false });
    await expect(c.executeDistributed('SELECT 1')).rejects.toThrow(
      'No analytics federation strategy available',
    );
  });

  it('skips an unavailable higher-priority strategy and uses the next', async () => {
    const c = makeClient({
      httpfs: { enabled: true, endpoint: 's3://b/p', region: 'us', accessKey: 'a', secretKey: 's' },
    });
    const local = (LocalColumnarStrategy as any).mock.instances[0];
    local.available = vi.fn(async () => false);
    const r = await c.executeDistributed('SELECT 1');
    expect(r).toEqual({ __httpfs: true, sql: 'SELECT 1' });
  });
});

describe('findBestStrategy caching', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the highest-priority available strategy', async () => {
    const c = makeClient();
    const avail = await c.isDistributedAvailable();
    expect(avail).toBe(true);
  });

  it('caches availability within the TTL window', async () => {
    const c = makeClient();
    const local = (LocalColumnarStrategy as any).mock.instances[0];
    local.available = vi.fn(async () => true);

    await c.isDistributedAvailable();
    await c.isDistributedAvailable();
    // available() should only be called once because the result is cached
    expect(local.available).toHaveBeenCalledTimes(1);
  });

  it('skips a strategy cached as unavailable within the TTL window', async () => {
    const c = makeClient({
      httpfs: { enabled: true, endpoint: 's3://b/p', region: 'us', accessKey: 'a', secretKey: 's' },
    });
    const local = (LocalColumnarStrategy as any).mock.instances[0];
    const httpfs = (HttpfsStrategy as any).mock.instances[0];

    const localAvailable = vi.fn(async () => false);
    local.available = localAvailable;
    httpfs.available = vi.fn(async () => true);

    // First call: local is unavailable, cached as unavailable, fall through to httpfs.
    const r1 = await c.executeDistributed('SELECT 1');
    expect(r1).toEqual({ __httpfs: true, sql: 'SELECT 1' });
    expect(localAvailable).toHaveBeenCalledTimes(1);

    // Second call within TTL: the cached "unavailable" result triggers
    // `continue` and local.available() is NOT re-invoked.
    const r2 = await c.executeDistributed('SELECT 2');
    expect(r2).toEqual({ __httpfs: true, sql: 'SELECT 2' });
    expect(localAvailable).toHaveBeenCalledTimes(1);
  });

  it('caches a throwing available() as unavailable and continues', async () => {
    const c = makeClient({
      httpfs: { enabled: true, endpoint: 's3://b/p', region: 'us', accessKey: 'a', secretKey: 's' },
    });
    const local = (LocalColumnarStrategy as any).mock.instances[0];
    local.available = vi.fn(async () => {
      throw new Error('boom');
    });
    const httpfs = (HttpfsStrategy as any).mock.instances[0];
    httpfs.available = vi.fn(async () => true);

    const r = await c.executeDistributed('SELECT 1');
    expect(r).toEqual({ __httpfs: true, sql: 'SELECT 1' });
  });

  it('re-checks availability after the cache expires', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const c = makeClient();
      const local = (LocalColumnarStrategy as any).mock.instances[0];
      local.available = vi.fn(async () => true);

      await c.isDistributedAvailable();
      expect(local.available).toHaveBeenCalledTimes(1);

      // Advance the mocked clock past the 30s TTL
      nowSpy.mockReturnValue(1_000_000 + 31_000);
      await c.isDistributedAvailable();
      expect(local.available).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns false when no strategy is available', async () => {
    const c = makeClient({ localColumnar: false });
    expect(await c.isDistributedAvailable()).toBe(false);
  });
});

describe('warmup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pre-checks all strategies and populates the cache', async () => {
    const c = makeClient({
      httpfs: { enabled: true, endpoint: 's3://b/p', region: 'us', accessKey: 'a', secretKey: 's' },
    });
    const local = (LocalColumnarStrategy as any).mock.instances[0];
    local.available = vi.fn(async () => true);

    await c.warmup();

    // After warmup, a subsequent availability check should not call available() again
    expect(local.available).toHaveBeenCalledTimes(1);
    await c.isDistributedAvailable();
    expect(local.available).toHaveBeenCalledTimes(1);
  });

  it('swallows availability errors during warmup', async () => {
    const c = makeClient();
    const local = (LocalColumnarStrategy as any).mock.instances[0];
    local.available = vi.fn(async () => {
      throw new Error('warmup boom');
    });

    await expect(c.warmup()).resolves.toBeUndefined();
  });
});

describe('invalidateCache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forces a re-check after invalidation', async () => {
    const c = makeClient();
    const local = (LocalColumnarStrategy as any).mock.instances[0];
    local.available = vi.fn(async () => true);

    await c.isDistributedAvailable();
    await c.isDistributedAvailable();
    expect(local.available).toHaveBeenCalledTimes(1);

    c.invalidateCache();
    await c.isDistributedAvailable();
    expect(local.available).toHaveBeenCalledTimes(2);
  });
});

describe('registerTable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards table registration only to HttpfsStrategy', () => {
    const c = makeClient({
      httpfs: { enabled: true, endpoint: 's3://b/p', region: 'us', accessKey: 'a', secretKey: 's' },
    });
    c.registerTable('orders');
    const httpfs = (HttpfsStrategy as any).mock.instances[0];
    expect(httpfs.registerTable).toHaveBeenCalledWith('orders');
  });

  it('does not forward table registration to the local strategy', () => {
    const c = makeClient();
    const local = (LocalColumnarStrategy as any).mock.instances[0];
    c.registerTable('orders');
    // LocalColumnarStrategy is not an HttpfsStrategy, so registerTable is skipped
    expect(local.registerTable).not.toHaveBeenCalled();
  });
});
