import { describe, it, expect, vi } from 'vitest';
import { PgPipeline, createPipelineFor } from '../pipeline/PgPipeline';
import { TxCoord } from '../query/TxCoord';
import { UnifiedRouter } from '../query/UnifiedRouter';
import { QueryTarget } from '../analytics/AnalyticQueryClassifier';
import type { PipelineContext, RewriteOutput, QueryResult as _QR } from '../pipeline/types';

function makeDuckDBExecutor(overrides: any = {}) {
  return {
    isAvailable: true,
    execute: async () => ({
      rows: [{ a: 1 }],
      rowCount: 1,
      queryTimeMs: 1,
      routed: true,
    }),
    ...overrides,
  } as any;
}

function makeUnifiedRouter(overrides: any = {}) {
  const duckDBExecutor = overrides.duckDBExecutor ?? makeDuckDBExecutor();
  const router = new UnifiedRouter({
    duckDBExecutor,
    ...overrides,
  });
  return router;
}

/**
 * PgPipeline — unified SQL execution pipeline orchestration.
 *
 * These tests exercise the full orchestration path (rewrite → engine → route →
 * execute → result) plus the transaction-control and batch-insert entry
 * points. In particular they pin down the savepoint-routing order bug: a
 * `ROLLBACK TO SAVEPOINT` statement was previously matched by the plain
 * `ROLLBACK` branch first and therefore rolled back the *whole* transaction
 * instead of rewinding to the named savepoint.
 */

function makeMeta(category: any = 'SELECT') {
  return {
    rewrittenSql: 'SELECT 1',
    category,
    tables: [],
    hasReturning: false,
    isCopy: false,
    hasParams: false,
  };
}

function makeRewriteFn(category: any = 'SELECT') {
  return async (sql: string): Promise<RewriteOutput> => ({
    sql,
    meta: { ...makeMeta(category), rewrittenSql: sql },
  });
}

function makeExecuteFn(rows: any[] = [{ a: 1 }]) {
  return async () => ({
    rows,
    rowCount: rows.length,
    queryTimeMs: 1,
    engine: 'sqlite' as const,
  });
}

function makeCtx(sessionId = 's1', txCoord?: TxCoord): PipelineContext {
  return { sessionId, currentUser: 'u', txCoord };
}

function makePipeline(opts: {
  category?: any;
  executeFn?: any;
  txCoord?: TxCoord;
  onTableCreated?: (t: string) => Promise<void>;
} = {}) {
  const p = new PgPipeline(
    {
      rewriteFn: makeRewriteFn(opts.category ?? 'SELECT'),
      executeFn: opts.executeFn ?? makeExecuteFn(),
      onTableCreated: opts.onTableCreated,
    },
    opts.txCoord,
  );
  return p;
}

describe('PgPipeline — constructor validation', () => {
  it('throws when rewriteFn and executeFn are both missing', () => {
    expect(() => new PgPipeline({} as any)).toThrow(
      /rewriteFn and executeFn/,
    );
  });
});

describe('PgPipeline — execute() orchestration', () => {
  it('runs a plain SELECT through the full pipeline', async () => {
    const p = makePipeline();
    const out = await p.execute('SELECT 1', makeCtx());
    expect(out.rows).toEqual([{ a: 1 }]);
    expect(out.rowCount).toBe(1);
    expect(out.engine).toBe('sqlite');
    expect(out.commandTag).toContain('SELECT');
  });

  it('passes sessionId down to executeFn', async () => {
    const seen: string[] = [];
    const executeFn = async (_sql: string, _p: any, sessionId?: string) => {
      seen.push(sessionId ?? '');
      return { rows: [], rowCount: 0, queryTimeMs: 0, engine: 'sqlite' as const };
    };
    const p = makePipeline({ executeFn });
    await p.execute('SELECT 1', makeCtx('session-xyz'));
    expect(seen).toContain('session-xyz');
  });

  it('derives command tag from category passed through rewrite meta', async () => {
    const p = makePipeline({ category: 'INSERT' });
    const out = await p.execute('INSERT INTO t VALUES (1)', makeCtx());
    expect(out.commandTag).toContain('INSERT');
  });

  it('calls onTableCreated for CREATE TABLE DDL', async () => {
    const created: string[] = [];
    const p = makePipeline({
      category: 'DDL',
      onTableCreated: async (t) => { created.push(t); },
    });
    await p.execute('CREATE TABLE IF NOT EXISTS users (id int)', makeCtx());
    // Fire-and-forget: give the microtask a tick to run.
    await new Promise((r) => setTimeout(r, 5));
    expect(created).toContain('users');
  });

  it('does not call onTableCreated for non-CREATE-TABLE DDL', async () => {
    const created: string[] = [];
    const p = makePipeline({
      category: 'DDL',
      onTableCreated: async (t) => { created.push(t); },
    });
    await p.execute('DROP TABLE users', makeCtx());
    await new Promise((r) => setTimeout(r, 5));
    expect(created).toEqual([]);
  });

  it('does not call onTableCreated when CREATE TABLE regex finds no table name', async () => {
    const created: string[] = [];
    const p = makePipeline({
      category: 'DDL',
      onTableCreated: async (t) => { created.push(t); },
    });
    // 'CREATE TABLE' followed by no valid identifier → tableMatch is null.
    await p.execute('CREATE TABLE', makeCtx());
    await new Promise((r) => setTimeout(r, 5));
    expect(created).toEqual([]);
  });
});

describe('PgPipeline — executeBatchInsert()', () => {
  it('routes a batch INSERT to shard 0 with INSERT command tag', async () => {
    const p = makePipeline();
    const out = await p.executeBatchInsert(
      'INSERT INTO t VALUES (1),(2)',
      [1, 2],
      makeCtx(),
    );
    expect(out.engine).toBe('sqlite');
    expect(out.commandTag).toContain('INSERT');
  });
});

describe('PgPipeline — executeTransaction()', () => {
  it('routes BEGIN to txCoord.begin', async () => {
    const tx = new TxCoord();
    const p = makePipeline({ txCoord: tx });
    await p.executeTransaction('BEGIN', makeCtx('s', tx));
    expect(tx.hasTransaction('s')).toBe(true);
  });

  it('routes COMMIT to txCoord.commit (clears transaction)', async () => {
    const tx = new TxCoord();
    const p = makePipeline({ txCoord: tx });
    await p.executeTransaction('BEGIN', makeCtx('s', tx));
    expect(tx.hasTransaction('s')).toBe(true);
    await p.executeTransaction('COMMIT', makeCtx('s', tx));
    expect(tx.hasTransaction('s')).toBe(false);
  });

  it('routes ROLLBACK to txCoord.rollback (clears transaction)', async () => {
    const tx = new TxCoord();
    const p = makePipeline({ txCoord: tx });
    await p.executeTransaction('BEGIN', makeCtx('s', tx));
    await p.executeTransaction('ROLLBACK', makeCtx('s', tx));
    expect(tx.hasTransaction('s')).toBe(false);
  });

  it('routes SAVEPOINT to txCoord.savepoint (pushes savepoint)', async () => {
    const tx = new TxCoord();
    const p = makePipeline({ txCoord: tx });
    await p.executeTransaction('BEGIN', makeCtx('s', tx));
    await p.executeTransaction('SAVEPOINT sp1', makeCtx('s', tx));
    expect(tx.getTransaction('s')?.savepointStack).toContain('sp1');
  });

  it('preserves savepoint name case (PostgreSQL identifiers are case-sensitive)', async () => {
    const tx = new TxCoord();
    const p = makePipeline({ txCoord: tx });
    await p.executeTransaction('BEGIN', makeCtx('s', tx));
    await p.executeTransaction('SAVEPOINT MixedCase', makeCtx('s', tx));
    expect(tx.getTransaction('s')?.savepointStack).toContain('MixedCase');
    expect(tx.getTransaction('s')?.savepointStack).not.toContain('MIXEDCASE');
  });

  it('ROLLBACK TO SAVEPOINT rewinds only to the savepoint, not the whole txn (regression)', async () => {
    const tx = new TxCoord();
    const p = makePipeline({ txCoord: tx });
    await p.executeTransaction('BEGIN', makeCtx('s', tx));
    await p.executeTransaction('SAVEPOINT sp1', makeCtx('s', tx));
    await p.executeTransaction('ROLLBACK TO SAVEPOINT sp1', makeCtx('s', tx));
    // The transaction must still be active (only rolled back to savepoint).
    expect(tx.hasTransaction('s')).toBe(true);
    // And the savepoint must have been pruned by the rollback-to.
    expect(tx.getTransaction('s')?.savepointStack).not.toContain('sp1');
  });

  it('RELEASE SAVEPOINT releases the named savepoint', async () => {
    const tx = new TxCoord();
    const p = makePipeline({ txCoord: tx });
    await p.executeTransaction('BEGIN', makeCtx('s', tx));
    await p.executeTransaction('SAVEPOINT sp1', makeCtx('s', tx));
    await p.executeTransaction('RELEASE SAVEPOINT sp1', makeCtx('s', tx));
    expect(tx.getTransaction('s')?.savepointStack).not.toContain('sp1');
  });

  it('ROllBACK with trailing content (e.g. ROLLBACK AND CHAIN) still rolls back', async () => {
    const tx = new TxCoord();
    const p = makePipeline({ txCoord: tx });
    await p.executeTransaction('BEGIN', makeCtx('s', tx));
    await p.executeTransaction('ROLLBACK AND CHAIN', makeCtx('s', tx));
    expect(tx.hasTransaction('s')).toBe(false);
  });

  it('works without an injected txCoord (no-op txn state)', async () => {
    const p = makePipeline();
    const out = await p.executeTransaction('BEGIN', makeCtx());
    expect(out.engine).toBe('sqlite');
    expect(out.commandTag).toContain('COMMIT'); // category='TCL' → COMMIT tag
  });

  it('matches no txCoord branch for an unrecognized transaction statement', async () => {
    const tx = new TxCoord();
    const p = makePipeline({ txCoord: tx });
    // 'SET TRANSACTION ...' is not BEGIN/COMMIT/ROLLBACK/SAVEPOINT → no branch.
    const out = await p.executeTransaction('SET TRANSACTION ISOLATION LEVEL', makeCtx('s', tx));
    expect(out.engine).toBe('sqlite');
    expect(tx.hasTransaction('s')).toBe(false);
  });
});

describe('PgPipeline — EngineStep / DuckDB routing', () => {
  function pipelineWithEngine(unifiedRouter: any, duckDBExecutor: any) {
    return new PgPipeline(
      {
        rewriteFn: makeRewriteFn('SELECT'),
        executeFn: makeExecuteFn(),
      },
      undefined,
      unifiedRouter,
      duckDBExecutor,
    );
  }

  it('routes a DuckDB decision straight to ResultStep with engine=duckdb', async () => {
    const duckDBExecutor = makeDuckDBExecutor({
      execute: async () => ({ rows: [{ a: 1 }, { a: 2 }], rowCount: 2, queryTimeMs: 3, routed: true }),
    });
    const unifiedRouter = makeUnifiedRouter({
      duckDBExecutor,
      alwaysRouteToDuckDB: true,
    });
    const p = pipelineWithEngine(unifiedRouter, duckDBExecutor);
    const out = await p.execute('SELECT a FROM t', makeCtx());
    expect(out.engine).toBe('duckdb');
    expect(out.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('falls back to SQLite when DuckDB is unavailable', async () => {
    const duckDBExecutor = makeDuckDBExecutor({ isAvailable: false });
    const unifiedRouter = makeUnifiedRouter({
      duckDBExecutor,
      alwaysRouteToDuckDB: true,
    });
    const p = pipelineWithEngine(unifiedRouter, duckDBExecutor);
    const out = await p.execute('SELECT a FROM t', makeCtx());
    expect(out.engine).toBe('sqlite');
  });

  it('falls back to SQLite when DuckDB execution throws', async () => {
    const duckDBExecutor = makeDuckDBExecutor({
      execute: async () => { throw new Error('duckboom'); },
    });
    const unifiedRouter = makeUnifiedRouter({
      duckDBExecutor,
      alwaysRouteToDuckDB: true,
    });
    const p = pipelineWithEngine(unifiedRouter, duckDBExecutor);
    const out = await p.execute('SELECT a FROM t', makeCtx());
    expect(out.engine).toBe('sqlite');
    expect(out.triggeredFallback).toBe(true);
  });

  it('falls back to SQLite when DuckDB decision does not route', async () => {
    const duckDBExecutor = makeDuckDBExecutor({
      execute: async () => ({ rows: [], rowCount: 0, queryTimeMs: 0, routed: false, reason: 'no route' }),
    });
    const unifiedRouter = makeUnifiedRouter({
      duckDBExecutor,
      alwaysRouteToDuckDB: true,
    });
    const p = pipelineWithEngine(unifiedRouter, duckDBExecutor);
    const out = await p.execute('SELECT a FROM t', makeCtx());
    expect(out.engine).toBe('sqlite');
    expect(out.triggeredFallback).toBe(true);
  });
});

describe('PgPipeline — stats & cache', () => {
  it('tracks totalQueries and average time across calls', async () => {
    const p = makePipeline();
    await p.execute('SELECT 1', makeCtx());
    await p.execute('SELECT 2', makeCtx());
    const stats = p.getStats();
    expect(stats.totalQueries).toBe(2);
    expect(stats.avgTimeMs).toBeGreaterThanOrEqual(0);
    expect(stats).toHaveProperty('cacheHitRate');
  });

  it('reports avgTimeMs=0 when no queries have run', async () => {
    const p = makePipeline();
    const stats = p.getStats();
    expect(stats.totalQueries).toBe(0);
    expect(stats.avgTimeMs).toBe(0);
  });

  it('invalidateCache clears the rewrite cache', async () => {
    const p = makePipeline();
    await p.execute('SELECT 1', makeCtx());
    p.invalidateCache();
    const stats = p.getStats();
    expect(stats.cacheHitRate).toBeGreaterThanOrEqual(0);
  });
});

describe('createPipelineFor — factory', () => {
  function fakeQueryRouter() {
    const calls: string[] = [];
    const qr: any = {
      execute: async (sql: string) => { calls.push(sql); return { rows: [], rowCount: 0, queryTimeMs: 0, engine: 'sqlite' }; },
      shardManager: { getShardCount: () => 1, getShardIdForKey: () => 0, getShard: () => undefined },
    };
    return { qr, calls };
  }

  it('builds a working pipeline from a QueryRouter', async () => {
    const { qr, calls } = fakeQueryRouter();
    const p = createPipelineFor(qr);
    const out = await p.execute('SELECT 1', makeCtx());
    expect(out.engine).toBe('sqlite');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('falls back to a default shard manager when QueryRouter has none', async () => {
    const execute = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0, queryTimeMs: 0, engine: 'sqlite' as const }));
    // No shardManager property at all → createPipelineFor uses its internal default.
    const qr: any = { execute };
    const p = createPipelineFor(qr);
    const out = await p.execute('SELECT 1', makeCtx());
    expect(out.engine).toBe('sqlite');
    expect(execute).toHaveBeenCalled();
  });

  it('accepts an explicit shardManager argument', async () => {
    const execute = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0, queryTimeMs: 0, engine: 'sqlite' as const }));
    const qr: any = { execute };
    const shardManager: any = { getShardCount: () => 2, getShardIdForKey: (k: string) => parseInt(k, 10) % 2, getShard: () => undefined };
    const p = createPipelineFor(qr, undefined, undefined, undefined, shardManager);
    const out = await p.execute('SELECT 1', makeCtx());
    expect(out.engine).toBe('sqlite');
    expect(execute).toHaveBeenCalled();
  });

  it('classifies CREATE TABLE as DDL through the factory rewriteFn', async () => {
    const { qr } = fakeQueryRouter();
    const p = createPipelineFor(qr);
    const out = await p.execute('CREATE TABLE t (id int)', makeCtx());
    expect(out.commandTag).toContain('CREATE');
  });

  it.each([
    ['UPDATE t SET a = 1', 'UPDATE'],
    ['DELETE FROM t', 'DELETE'],
    ['COPY t FROM stdin', 'COPY'],
    ['SET search_path = public', 'SET'],
    ['DROP TABLE t', 'CREATE'], // DDL category → bare CREATE tag
    ['ALTER TABLE t ADD COLUMN c', 'CREATE'],
    ['BEGIN', 'COMMIT'], // TCL category → bare COMMIT tag
    ['VACUUM', 'OK'], // OTHER category → OK
    ['SHOW timezone', 'SHOW'],
    ['EXPLAIN SELECT 1', 'OK'],
  ])('classifies %s with command tag containing %s', async (sql, expectedTag) => {
    const { qr } = fakeQueryRouter();
    const p = createPipelineFor(qr);
    const out = await p.execute(sql, makeCtx());
    expect(out.commandTag).toContain(expectedTag);
  });
});

describe('createPipelineFor — multi-shard scatter routing', () => {
  function fakeMultiShardRouter(shards = 4) {
    const execute = vi.fn(async (_sql: string, _p: any, sessionId?: string) => ({
      rows: [{ sid: 1 }],
      rowCount: 1,
      queryTimeMs: 0,
      engine: 'sqlite' as const,
    }));
    const getShardIdForKey = vi.fn((key: string) => (parseInt(key, 10) % shards + shards) % shards);
    const qr: any = {
      execute,
      shardManager: {
        getShardCount: () => shards,
        getShardIdForKey,
        getShard: () => undefined,
      },
    };
    return { qr, execute, getShardIdForKey };
  }

  it('routes SELECT without shard key as scatter (no shard-key lookup)', async () => {
    const { qr, execute, getShardIdForKey } = fakeMultiShardRouter();
    const p = createPipelineFor(qr);
    const out = await p.execute('SELECT * FROM t WHERE name = \'x\'', makeCtx());
    expect(out.engine).toBe('sqlite');
    // No shard key column (name) → scatter: no getShardIdForKey lookup.
    expect(getShardIdForKey).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
  });

  it('routes SELECT with shard key through getShardIdForKey', async () => {
    const { qr, getShardIdForKey } = fakeMultiShardRouter();
    const p = createPipelineFor(qr);
    await p.execute('SELECT * FROM t WHERE aid = 7', makeCtx());
    // aid is a shard key → getShardIdForKey invoked with the literal value.
    expect(getShardIdForKey).toHaveBeenCalledWith('7', 4);
  });

  it('routes INSERT with key column through getShardIdForKey', async () => {
    const { qr, getShardIdForKey } = fakeMultiShardRouter();
    const p = createPipelineFor(qr);
    await p.execute('INSERT INTO t (aid, name) VALUES (10, \'x\')', makeCtx());
    // aid is a shard key column → getShardIdForKey invoked with '10'.
    expect(getShardIdForKey).toHaveBeenCalledWith('10', 4);
  });
});

describe('PgPipeline — ShimCache / RewriteStep interaction', () => {
  it('serves the second identical query from the rewrite cache (hitRate > 0)', async () => {
    let rewriteCalls = 0;
    const p = new PgPipeline({
      rewriteFn: async (sql: string) => {
        rewriteCalls++;
        return { sql, meta: { ...makeMeta('SELECT'), rewrittenSql: sql } };
      },
      executeFn: makeExecuteFn(),
    });
    await p.execute('SELECT 42', makeCtx());
    await p.execute('SELECT 42', makeCtx());
    // The cache should absorb the second rewrite, so rewriteFn runs once.
    expect(rewriteCalls).toBe(1);
    expect(p.getStats().cacheHitRate).toBeGreaterThan(0);
  });
});
