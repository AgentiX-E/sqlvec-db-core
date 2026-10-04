/**
 * DuckDBRouter — DuckDB routing tests.
 *
 * Covers pattern detection (legacy), classifier-based routing, availability
 * short-circuit, result mapping, federation client delegation, and error
 * degradation. Focus on the routing decision matrix and the execution paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectDuckDBPattern,
  DuckDBPattern,
  rewriteForDuckDB,
  mapDuckDBResult,
  tryRouteDuckDB,
  getPatternDebugInfo,
} from '../query/DuckDBRouter';
import { QueryTarget } from '../analytics/AnalyticQueryClassifier';
import { DuckDBResult } from '../analytics/DuckDBAnalyticsManager';

function makeDuckDB(opts?: { isAvailable?: boolean; execute?: (sql: string) => Promise<DuckDBResult> }) {
  return {
    isAvailable: opts?.isAvailable ?? true,
    execute:
      opts?.execute ??
      (async () => ({ rows: [], rowCount: 0, queryTimeMs: 0 })),
  } as any;
}

function makeClassifier(opts?: {
  target?: QueryTarget;
  reason?: string;
}) {
  return {
    classify: vi.fn(
      (): any => ({
        target: opts?.target ?? QueryTarget.DUCKDB_OLAP,
        reason: opts?.reason ?? 'test',
        confidence: 1,
      }),
    ),
    reportDuckDBSuccess: vi.fn(),
    reportDuckDBFailure: vi.fn(),
  };
}

const SELECT_PARSED = { type: 'SELECT' } as any;

describe('detectDuckDBPattern', () => {
  it('returns null for empty or non-string input', () => {
    expect(detectDuckDBPattern('')).toBeNull();
    expect(detectDuckDBPattern('   ')).toBeNull();
    expect(detectDuckDBPattern(null as any)).toBeNull();
    expect(detectDuckDBPattern(123 as any)).toBeNull();
  });

  it('detects PIVOT', () => {
    expect(detectDuckDBPattern('SELECT * FROM t PIVOT (sum(x) FOR y IN (1,2))')).toBe(
      DuckDBPattern.PIVOT,
    );
  });

  it('detects UNPIVOT', () => {
    expect(detectDuckDBPattern('SELECT * FROM t UNPIVOT (v FOR k IN (a,b))')).toBe(
      DuckDBPattern.UNPIVOT,
    );
  });

  it('detects QUALIFY', () => {
    expect(detectDuckDBPattern('SELECT * FROM t QUALIFY row_number() OVER (...) = 1')).toBe(
      DuckDBPattern.QUALIFY,
    );
  });

  it('detects SELECT * EXCLUDE', () => {
    expect(detectDuckDBPattern('SELECT * EXCLUDE (col) FROM t')).toBe(
      DuckDBPattern.EXCLUDE_COL,
    );
  });

  it('detects LISTAGG', () => {
    expect(detectDuckDBPattern('SELECT LISTAGG(x, \',\') FROM t')).toBe(
      DuckDBPattern.LISTAGG,
    );
  });

  it('detects GROUP BY ALL', () => {
    expect(detectDuckDBPattern('SELECT a, sum(b) FROM t GROUP BY ALL')).toBe(
      DuckDBPattern.GROUP_BY_ALL,
    );
  });

  it('detects LATERAL', () => {
    expect(detectDuckDBPattern('SELECT * FROM t, LATERAL (SELECT 1)')).toBe(
      DuckDBPattern.LATERAL,
    );
  });

  it('detects FILTER clause', () => {
    expect(
      detectDuckDBPattern('SELECT count(*) FILTER (WHERE x > 0) FROM t'),
    ).toBe(DuckDBPattern.FILTER_CLAUSE);
  });

  it('detects TABLESAMPLE', () => {
    expect(detectDuckDBPattern('SELECT * FROM t TABLESAMPLE BERNOULLI (10)')).toBe(
      DuckDBPattern.TABLESAMPLE,
    );
  });

  it('detects APPROX_AGG', () => {
    expect(detectDuckDBPattern('SELECT approx_count_distinct(x) FROM t')).toBe(
      DuckDBPattern.APPROX_AGG,
    );
  });

  it('returns null for a plain query', () => {
    expect(detectDuckDBPattern('SELECT * FROM users WHERE id = 1')).toBeNull();
  });
});

describe('getPatternDebugInfo', () => {
  it('exposes every registered pattern', () => {
    const infos = getPatternDebugInfo();
    expect(infos.length).toBeGreaterThan(0);
    for (const info of infos) {
      expect(Object.values(DuckDBPattern)).toContain(info.kind);
      expect(typeof info.pattern).toBe('string');
    }
  });
});

describe('rewriteForDuckDB', () => {
  it('passes SQL through unchanged (no-op)', () => {
    expect(rewriteForDuckDB('SELECT 1', DuckDBPattern.PIVOT)).toBe('SELECT 1');
  });
});

describe('mapDuckDBResult', () => {
  it('maps rows/rowCount/engine and zeroes queryTimeMs', () => {
    const mapped = mapDuckDBResult(
      { rows: [{ a: 1 }], rowCount: 1, queryTimeMs: 999 },
      'SELECT a FROM t',
    );
    expect(mapped.rows).toEqual([{ a: 1 }]);
    expect(mapped.rowCount).toBe(1);
    expect(mapped.queryTimeMs).toBe(0);
    expect(mapped.engine).toBe('duckdb');
  });
});

describe('tryRouteDuckDB — availability and classifier', () => {
  it('returns unavailable when isAvailable is false', async () => {
    const r = await tryRouteDuckDB(
      'SELECT * FROM t PIVOT (x FOR y IN (1))',
      makeDuckDB({ isAvailable: false }),
      0,
    );
    expect(r.routed).toBe(false);
    expect(r.reason).toBe('DuckDB unavailable');
  });

  it('routes to SQLite when classifier says non-DuckDB', async () => {
    const classifier = makeClassifier({ target: QueryTarget.SQLITE_OLTP, reason: 'non-select' });
    const r = await tryRouteDuckDB(
      'INSERT INTO t VALUES (1)',
      makeDuckDB(),
      0,
      classifier as any,
      SELECT_PARSED,
    );
    expect(r.routed).toBe(false);
    expect(r.reason).toContain('classifier:');
    expect(r.classification?.target).toBe(QueryTarget.SQLITE_OLTP);
  });

  it('executes on DuckDB when classifier says DuckDB', async () => {
    const execute = vi.fn(async () => ({ rows: [{ x: 1 }], rowCount: 1, queryTimeMs: 0 }));
    const classifier = makeClassifier({ target: QueryTarget.DUCKDB_OLAP });
    const r = await tryRouteDuckDB(
      'SELECT * FROM a JOIN b ON a.id = b.id',
      makeDuckDB({ execute }),
      100,
      classifier as any,
      SELECT_PARSED,
    );
    expect(r.routed).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(classifier.reportDuckDBSuccess).toHaveBeenCalledOnce();
  });

  it('passes default ctx when ctx is omitted (classifier mode)', async () => {
    const classifier = makeClassifier({ target: QueryTarget.SQLITE_OLTP, reason: 'tx' });
    await tryRouteDuckDB('SELECT 1', makeDuckDB(), 0, classifier as any, SELECT_PARSED);
    expect(classifier.classify).toHaveBeenCalledWith(
      'SELECT 1',
      SELECT_PARSED,
      { inTransaction: false },
    );
  });
});

describe('tryRouteDuckDB — legacy pattern path', () => {
  it('returns no pattern when SQL has no routable pattern', async () => {
    const r = await tryRouteDuckDB('SELECT * FROM users', makeDuckDB(), 0);
    expect(r.routed).toBe(false);
    expect(r.reason).toBe('No routable pattern detected');
  });

  it('executes via legacy pattern route when no classifier', async () => {
    const execute = vi.fn(async () => ({ rows: [], rowCount: 0, queryTimeMs: 0 }));
    const r = await tryRouteDuckDB(
      'SELECT * FROM t PIVOT (x FOR y IN (1))',
      makeDuckDB({ execute }),
      0,
    );
    expect(r.routed).toBe(true);
    expect(r.pattern).toBe(DuckDBPattern.PIVOT);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does NOT call classifier report when classifier absent in legacy mode', async () => {
    const r = await tryRouteDuckDB(
      'SELECT * FROM t PIVOT (x FOR y IN (1))',
      makeDuckDB(),
      0,
    );
    expect(r.routed).toBe(true);
  });
});

describe('tryRouteDuckDB — federation and error paths', () => {
  it('delegates to federation client when provided', async () => {
    const fedClient = {
      executeDistributed: vi.fn(async () => ({ rows: [{ ok: true }], rowCount: 1, queryTimeMs: 0 })),
    };
    const r = await tryRouteDuckDB(
      'SELECT * FROM t PIVOT (x FOR y IN (1))',
      makeDuckDB(),
      0,
      undefined,
      undefined,
      undefined,
      fedClient as any,
    );
    expect(r.routed).toBe(true);
    expect(fedClient.executeDistributed).toHaveBeenCalledOnce();
  });

  it('returns execution error reason when duckDB.execute throws', async () => {
    const execute = vi.fn(async () => {
      throw new Error('boom');
    });
    const r = await tryRouteDuckDB(
      'SELECT * FROM t PIVOT (x FOR y IN (1))',
      makeDuckDB({ execute }),
      0,
    );
    expect(r.routed).toBe(false);
    expect(r.reason).toContain('DuckDB execution error');
    expect(r.reason).toContain('boom');
  });

  it('reports DuckDB failure and still returns non-routed on error', async () => {
    const execute = vi.fn(async () => {
      throw new Error('fail');
    });
    const classifier = makeClassifier({ target: QueryTarget.DUCKDB_OLAP });
    const r = await tryRouteDuckDB(
      'SELECT * FROM a JOIN b ON a.id = b.id',
      makeDuckDB({ execute }),
      0,
      classifier as any,
      SELECT_PARSED,
    );
    expect(r.routed).toBe(false);
    expect(classifier.reportDuckDBFailure).toHaveBeenCalledOnce();
  });
});
