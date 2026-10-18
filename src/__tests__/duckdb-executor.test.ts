/**
 * duckdb-executor.test.ts — Coverage tests for DuckDBExecutor (analytic query
 * execution backend wrapping DuckDBRouter.tryRouteDuckDB).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const tryRouteDuckDBMock = vi.fn();

vi.mock('../query/DuckDBRouter', () => ({
  tryRouteDuckDB: (...args: unknown[]) => tryRouteDuckDBMock(...args),
}));

import { DuckDBExecutor } from '../query/DuckDBExecutor';
import type { DuckDBAnalyticsManager } from '../analytics/DuckDBAnalyticsManager';
import type { AnalyticsFederationClient } from '../analytics/AnalyticsFederationClient';

function makeManager(isAvailable: boolean): DuckDBAnalyticsManager {
  return { isAvailable } as unknown as DuckDBAnalyticsManager;
}

function makeFederation(): AnalyticsFederationClient {
  return {} as unknown as AnalyticsFederationClient;
}

describe('DuckDBExecutor.execute', () => {
  beforeEach(() => {
    tryRouteDuckDBMock.mockReset();
  });

  it('returns unrouted when tryRouteDuckDB reports not routed', async () => {
    tryRouteDuckDBMock.mockResolvedValue({ routed: false, reason: 'not analytic' });

    const exec = new DuckDBExecutor({ duckDBAnalytics: makeManager(true) });
    const res = await exec.execute('SELECT 1', 1000);

    expect(res.routed).toBe(false);
    expect(res.rows).toEqual([]);
    expect(res.rowCount).toBe(0);
    expect(res.engine).toBe('duckdb');
    expect(res.reason).toBe('not analytic');
    expect(tryRouteDuckDBMock).toHaveBeenCalledTimes(1);
  });

  it('returns routed result with duckdb engine when no federation client', async () => {
    tryRouteDuckDBMock.mockResolvedValue({
      routed: true,
      result: { rows: [{ a: 1 }], rowCount: 1, queryTimeMs: 5 },
    });

    const exec = new DuckDBExecutor({ duckDBAnalytics: makeManager(true) });
    const res = await exec.execute('SELECT q', 1000);

    expect(res.routed).toBe(true);
    expect(res.rows).toEqual([{ a: 1 }]);
    expect(res.rowCount).toBe(1);
    expect(res.queryTimeMs).toBe(5);
    expect(res.engine).toBe('duckdb');
    expect(res.federated).toBe(false);
  });

  it('uses duckdb_federated engine when federation client present', async () => {
    tryRouteDuckDBMock.mockResolvedValue({
      routed: true,
      result: { rows: [], rowCount: 0, queryTimeMs: 3 },
    });

    const exec = new DuckDBExecutor({
      duckDBAnalytics: makeManager(true),
      analyticsFederation: makeFederation(),
    });
    const res = await exec.execute('SELECT q', 1000);

    expect(res.routed).toBe(true);
    expect(res.engine).toBe('duckdb_federated');
    expect(res.federated).toBe(true);
  });

  it('returns missing-result fallback when routed but no result', async () => {
    tryRouteDuckDBMock.mockResolvedValue({ routed: true });

    const exec = new DuckDBExecutor({ duckDBAnalytics: makeManager(true) });
    const res = await exec.execute('SELECT q', 1000);

    expect(res.routed).toBe(false);
    expect(res.rows).toEqual([]);
    expect(res.engine).toBe('duckdb');
    expect(res.reason).toBe('Route result missing');
  });

  it('passes classifier, parsed and ctx through to tryRouteDuckDB', async () => {
    tryRouteDuckDBMock.mockResolvedValue({ routed: false });

    const classifier = { classify: vi.fn() } as unknown as Parameters<
      DuckDBExecutor['execute']
    >[4];
    const parsed = { text: 'SELECT 1' } as never;
    const ctx = { someContext: true } as never;

    const exec = new DuckDBExecutor({
      duckDBAnalytics: makeManager(true),
      analyticClassifier: classifier as never,
    });
    await exec.execute('SELECT 1', 1000, parsed, ctx);

    expect(tryRouteDuckDBMock).toHaveBeenCalledWith(
      'SELECT 1',
      expect.anything(),
      1000,
      classifier,
      parsed,
      ctx,
      undefined,
    );
  });
});

describe('DuckDBExecutor getters', () => {
  it('exposes isAvailable from the analytics manager', () => {
    expect(new DuckDBExecutor({ duckDBAnalytics: makeManager(true) }).isAvailable).toBe(true);
    expect(new DuckDBExecutor({ duckDBAnalytics: makeManager(false) }).isAvailable).toBe(false);
  });

  it('exposes the underlying manager', () => {
    const mgr = makeManager(true);
    expect(new DuckDBExecutor({ duckDBAnalytics: mgr }).manager).toBe(mgr);
  });
});
