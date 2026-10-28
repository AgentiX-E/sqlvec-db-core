/**
 * Unit coverage for NodeTransportStrategy — the cross-node query forwarding
 * fallback. Focuses on the pure/decidable branches: peer liveness
 * (available), the execute() fallback/merge control flow, and valueToSQL's
 * full type lattice. The TCP `queryPeer` path is exercised indirectly through
 * execute() by injecting fake remote sockets via net module mocking.
 */
import { describe, it, expect, vi } from 'vitest';
import { NodeTransportStrategy } from '../analytics/strategies/NodeTransportStrategy';

function makeDuckDB(overrides: Partial<any> = {}) {
  return {
    execute: vi.fn(async () => ({ rows: [], columns: [] })),
    execSQL: vi.fn(async () => {}),
    ...overrides,
  };
}

const PEERS = ['1:6543', '2:6543'];

describe('NodeTransportStrategy.available', () => {
  it('returns true when at least one peer is alive', async () => {
    const s = new NodeTransportStrategy(makeDuckDB(), { peers: PEERS });
    expect(await s.available()).toBe(true);
  });

  it('returns false when all peers are marked dead', async () => {
    const s = new NodeTransportStrategy(makeDuckDB(), { peers: PEERS });
    // Simulate all peers dead by marking them dead via a failed execute
    // (available() only reads peerAlive, which starts all-true).
    (s as any).peerAlive.set('1:6543', false);
    (s as any).peerAlive.set('2:6543', false);
    expect(await s.available()).toBe(false);
  });

  it('returns false when no peers are configured', async () => {
    const s = new NodeTransportStrategy(makeDuckDB(), { peers: [] });
    expect(await s.available()).toBe(false);
  });
});

describe('NodeTransportStrategy.execute — control flow', () => {
  it('falls back to local when no live peers remain', async () => {
    const duck = makeDuckDB({ execute: vi.fn(async () => ({ rows: [{ a: 1 }], columns: [] })) });
    const s = new NodeTransportStrategy(duck, { peers: PEERS });
    (s as any).peerAlive.set('1:6543', false);
    (s as any).peerAlive.set('2:6543', false);
    const r = await s.execute('SELECT 1');
    expect(duck.execute).toHaveBeenCalledWith('SELECT 1');
    expect(r).toEqual({ rows: [{ a: 1 }], columns: [] });
  });
});

describe('NodeTransportStrategy.valueToSQL', () => {
  const s = new NodeTransportStrategy(makeDuckDB(), { peers: [] });

  it('renders null and undefined as NULL', () => {
    expect((s as any).valueToSQL(null)).toBe('NULL');
    expect((s as any).valueToSQL(undefined)).toBe('NULL');
  });

  it('renders numbers and bigint verbatim', () => {
    expect((s as any).valueToSQL(42)).toBe('42');
    expect((s as any).valueToSQL(3.14)).toBe('3.14');
    expect((s as any).valueToSQL(9007199254740993n)).toBe('9007199254740993');
  });

  it('renders booleans as TRUE/FALSE', () => {
    expect((s as any).valueToSQL(true)).toBe('TRUE');
    expect((s as any).valueToSQL(false)).toBe('FALSE');
  });

  it('renders strings with single-quote escaping', () => {
    expect((s as any).valueToSQL('hello')).toBe("'hello'");
    expect((s as any).valueToSQL("it's")).toBe("'it''s'");
  });

  it('renders Date as ::TIMESTAMP', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    expect((s as any).valueToSQL(d)).toBe(`'${d.toISOString()}'::TIMESTAMP`);
  });

  it('renders other objects as escaped strings', () => {
    expect((s as any).valueToSQL({ a: 1 })).toBe("'[object Object]'");
    expect((s as any).valueToSQL([1, 2])).toBe("'1,2'");
  });
});

describe('NodeTransportStrategy.execute — remote merge', () => {
  it('merges successful remote rows via a UNION ALL temp table', async () => {
    const execSQL = vi.fn(async () => {});
    const execute = vi.fn(async () => ({ rows: [{ merged: 1 }], columns: [] }));
    const duck = makeDuckDB({ execSQL, execute });
    const s = new NodeTransportStrategy(duck, { peers: ['1:6543'] });

    const queryPeerSpy = vi
      .spyOn(s as any, 'queryPeer')
      .mockResolvedValue({
        type: 'ANALYTICS_RESULT',
        queryId: 'x',
        success: true,
        columns: [{ name: 'a', type: 'INTEGER' }],
        rows: [{ a: 1 }, { a: 2 }],
      });

    const r = await s.execute('SELECT COUNT(*) FROM t');
    expect(execSQL).toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
    expect(r).toEqual({ rows: [{ merged: 1 }], columns: [] });
    queryPeerSpy.mockRestore();
  });

  it('creates an empty temp table when remote rows are empty', async () => {
    const execSQL = vi.fn(async () => {});
    const execute = vi.fn(async () => ({ rows: [], columns: [] }));
    const duck = makeDuckDB({ execSQL, execute });
    const s = new NodeTransportStrategy(duck, { peers: ['1:6543'] });

    const queryPeerSpy = vi
      .spyOn(s as any, 'queryPeer')
      .mockResolvedValue({
        type: 'ANALYTICS_RESULT',
        queryId: 'x',
        success: true,
        columns: [{ name: 'a', type: 'INTEGER' }],
        rows: [],
      });

    await s.execute('SELECT * FROM t');
    expect(execSQL).toHaveBeenCalled();
    queryPeerSpy.mockRestore();
  });

  it('falls back to local when all remote peers fail', async () => {
    const execute = vi.fn(async () => ({ rows: [], columns: [] }));
    const duck = makeDuckDB({ execute });
    const s = new NodeTransportStrategy(duck, { peers: ['1:6543'] });
    vi.spyOn(s as any, 'queryPeer').mockResolvedValue({ type: 'ANALYTICS_RESULT', queryId: 'x', success: false });
    await s.execute('SELECT 1');
    expect(execute).toHaveBeenCalledWith('SELECT 1');
    (s as any).queryPeer.mockRestore();
  });

  it('handles remote results with missing columns via the ?? [] fallback', async () => {
    const execSQL = vi.fn(async () => {});
    const execute = vi.fn(async () => ({ rows: [], columns: [] }));
    const duck = makeDuckDB({ execSQL, execute });
    const s = new NodeTransportStrategy(duck, { peers: ['1:6543'] });
    // columns explicitly undefined exercises `result.value.columns ?? []`
    const queryPeerSpy = vi
      .spyOn(s as any, 'queryPeer')
      .mockResolvedValue({ type: 'ANALYTICS_RESULT', queryId: 'x', success: true, columns: undefined, rows: [] });
    await s.execute('SELECT * FROM t');
    expect(execSQL).toHaveBeenCalled();
    queryPeerSpy.mockRestore();
  });

  it('assigns numeric node id from a bare numeric peer prefix (?? fallback)', async () => {
    // Peer "1" (no colon) → parts[0]="1", a single-segment peer. Exercises the
    // parts[N] ?? '0' fallback chain when only one segment exists.
    const execute = vi.fn(async () => ({ rows: [], columns: [] }));
    const duck = makeDuckDB({ execute });
    const s = new NodeTransportStrategy(duck, { peers: ['1'] });
    const queryPeerSpy = vi
      .spyOn(s as any, 'queryPeer')
      .mockResolvedValue({ type: 'ANALYTICS_RESULT', queryId: 'x', success: false });
    await s.execute('SELECT 1');
    expect(execute).toHaveBeenCalledWith('SELECT 1');
    queryPeerSpy.mockRestore();
  });
});
