import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalColumnarStrategy } from '../analytics/strategies/LocalColumnarStrategy';
import { HttpfsStrategy } from '../analytics/strategies/HttpfsStrategy';
import { NodeTransportStrategy } from '../analytics/strategies/NodeTransportStrategy';
import type { DuckDBAnalyticsManager, DuckDBResult } from '../analytics/DuckDBAnalyticsManager';

/**
 * Unit tests for the analytics federation strategies. The strategies depend on
 * a `DuckDBAnalyticsManager` only as a `type` (never instantiated), so a mock
 * object is enough to drive every code path without a native DuckDB binary.
 */

const mockResult = (rows: any[], columns?: Array<{ name: string; type: string }>): DuckDBResult => ({
  columns: columns ?? Object.keys(rows[0] ?? {}).map((n) => ({ name: n, type: 'VARCHAR' })),
  rows,
  rowCount: rows.length,
});

function makeDuckDB(overrides: Record<string, any> = {}) {
  return {
    isAvailable: true,
    execute: vi.fn(async (_sql: string) => mockResult([])),
    execSQL: vi.fn(async (_sql: string) => {}),
    ...overrides,
  } as unknown as DuckDBAnalyticsManager;
}

describe('LocalColumnarStrategy', () => {
  it('reports available when duckDB.isAvailable is true', async () => {
    const s = new LocalColumnarStrategy(makeDuckDB({ isAvailable: true }));
    expect(await s.available()).toBe(true);
    expect(s.name).toBe('local');
    expect(s.priority).toBe(0);
  });

  it('returns false when duckDB.isAvailable throws', async () => {
    // Construct a duckDB whose isAvailable getter throws, bypassing makeDuckDB's
    // spread (which would eagerly evaluate the getter).
    const throwing = {
      get isAvailable() {
        throw new Error('no scanner');
      },
      execute: async () => mockResult([]),
      execSQL: async () => {},
    } as unknown as DuckDBAnalyticsManager;
    const s = new LocalColumnarStrategy(throwing);
    expect(await s.available()).toBe(false);
  });

  it('delegates execute to duckDB.execute', async () => {
    const db = makeDuckDB();
    const s = new LocalColumnarStrategy(db);
    await s.execute('SELECT 1');
    expect(db.execute).toHaveBeenCalledWith('SELECT 1');
  });
});

describe('HttpfsStrategy', () => {
  let db: ReturnType<typeof makeDuckDB>;

  beforeEach(() => {
    db = makeDuckDB();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  const cfg = {
    endpoint: 's3://bucket/prefix',
    region: 'us-east-1',
    accessKey: 'AK',
    secretKey: 'SK',
  };

  it('rewrites registered table refs to read_parquet()', async () => {
    const s = new HttpfsStrategy(db, cfg);
    s.registerTable('lineitem');
    await s.execute('SELECT * FROM lineitem');
    const rewritten = (db.execute as any).mock.calls[0][0];
    expect(rewritten).toContain("read_parquet('s3://bucket/prefix/lineitem/*.parquet') lineitem_p");
  });

  it('ensureInitialized runs LOAD + SET statements only once', async () => {
    const s = new HttpfsStrategy(db, cfg);
    await s.execute('SELECT 1');
    await s.execute('SELECT 2');
    const loads = (db.execSQL as any).mock.calls.map((c: any) => c[0]);
    expect(loads.filter((x: string) => x === 'LOAD httpfs')).toHaveLength(1);
    expect(loads.filter((x: string) => x === 'LOAD parquet')).toHaveLength(1);
  });

  it('available() probes the health parquet and returns true on success', async () => {
    const s = new HttpfsStrategy(db, cfg);
    expect(await s.available()).toBe(true);
    const probe = (db.execute as any).mock.calls[0][0];
    expect(probe).toContain('.analytics_health');
  });

  it('available() returns false when the probe throws', async () => {
    const failingDb = makeDuckDB({
      execute: vi.fn(async () => {
        throw new Error('s3 unreachable');
      }),
    });
    const s = new HttpfsStrategy(failingDb, cfg);
    expect(await s.available()).toBe(false);
  });

  it('sets s3_endpoint only when configured', async () => {
    const s = new HttpfsStrategy(db, { ...cfg, s3Endpoint: 'http://minio:9000' });
    await s.execute('SELECT 1');
    const sets = (db.execSQL as any).mock.calls.map((c: any) => c[0]).filter((x: string) => x.startsWith('SET '));
    expect(sets).toContain("SET s3_endpoint='http://minio:9000'");
    expect(sets).toContain("SET s3_region='us-east-1'");
  });
});

describe('NodeTransportStrategy', () => {
  const peers = ['node1:6543', 'node2:6543'];
  const cfg = { peers };

  it('available() is true when at least one peer is alive', async () => {
    const s = new NodeTransportStrategy(makeDuckDB(), cfg);
    expect(await s.available()).toBe(true);
  });

  it('valueToSQL converts values', () => {
    const s = new NodeTransportStrategy(makeDuckDB(), cfg) as any;
    expect(s.valueToSQL(null)).toBe('NULL');
    expect(s.valueToSQL(undefined)).toBe('NULL');
    expect(s.valueToSQL(42)).toBe('42');
    expect(s.valueToSQL(true)).toBe('TRUE');
    expect(s.valueToSQL(false)).toBe('FALSE');
    expect(s.valueToSQL("o'reilly")).toBe("'o''reilly'");
    expect(s.valueToSQL('plain')).toBe("'plain'");
    expect(s.valueToSQL(new Date('2024-01-01T00:00:00Z'))).toBe("'2024-01-01T00:00:00.000Z'::TIMESTAMP");
  });

  it('executes locally when no peers are alive', async () => {
    const db = makeDuckDB();
    const s = new NodeTransportStrategy(db, { peers: [] });
    await s.execute('SELECT 1');
    expect(db.execute).toHaveBeenCalledWith('SELECT 1');
  });

  it('falls back to local execution when all peers fail', async () => {
    const db = makeDuckDB();
    // connect() will fail synchronously-ish via error/close on the socket;
    // use an unreachable port and short timeout so the socket errors out.
    const s = new NodeTransportStrategy(db, { peers: ['127.0.0.1:1'], queryTimeoutMs: 200 });
    await s.execute('SELECT 1');
    // After the failed peer, execute() ultimately returns duckDB.execute(sql)
    expect(db.execute).toHaveBeenCalledWith('SELECT 1');
  });
});

describe('NodeTransportStrategy — successful remote merge', () => {
  it('returns the merged remote result instead of a local-only fallback', async () => {
    // Spin up a real loopback TCP server that answers ANALYTICS_QUERY with a
    // successful ANALYTICS_RESULT payload. This exercises queryPeer's real
    // socket path (connect → write → parse JSON response).
    const net = await import('node:net');
    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString();
        if (!buf.includes('\n')) return;
        const req = JSON.parse(buf.split('\n')[0]);
        const response = {
          type: 'ANALYTICS_RESULT',
          queryId: req.queryId,
          success: true,
          columns: [
            { name: 'region', type: 'VARCHAR' },
            { name: 'total', type: 'BIGINT' },
          ],
          rows: [{ region: 'east', total: 10 }],
        };
        socket.write(JSON.stringify(response) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    const rows = [{ region: 'east', total: 10 }];
    const db = makeDuckDB({
      // The merged query is the final execute() call; local fallback would be
      // a second execute(sql) call. Assert the merged result is what's returned.
      execute: vi.fn(async (sql: string) => {
        // The final merged execution returns the remote rows.
        return mockResult(rows, [
          { name: 'region', type: 'VARCHAR' },
          { name: 'total', type: 'BIGINT' },
        ]);
      }),
      execSQL: vi.fn(async () => {}),
    });

    const s = new NodeTransportStrategy(db, { peers: [`127.0.0.1:${port}`], queryTimeoutMs: 1000 });
    const result = await s.execute('SELECT region, SUM(total) AS total FROM sales GROUP BY region');

    server.close();

    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({ region: 'east', total: 10 });

    // The final call must NOT be the raw local fallback SQL, but a merged query
    // (SELECT * FROM (...) AS _merged or a reaggregation wrapper).
    const calls = (db.execute as any).mock.calls.map((c: any) => c[0]);
    const finalCall = calls[calls.length - 1];
    expect(finalCall).not.toBe('SELECT region, SUM(total) AS total FROM sales GROUP BY region');
  });
});
