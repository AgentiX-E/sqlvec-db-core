/**
 * RouteStep tests — pure-function SQL → shard routing.
 *
 * Covers RouteStep.process delegation, createShardRouter decision matrix
 * (single-shard short-circuit, category routing, scatter), and the internal
 * inferShardFromSql shard-key extraction for SELECT/UPDATE/DELETE/INSERT,
 * plus edge cases (quoted keys, negative numbers, multi-column inserts,
 * fallback VALUES extraction, string literals without shard keys).
 */
import { describe, it, expect, vi } from 'vitest';
import { RouteStep, createShardRouter } from '../pipeline/RouteStep';
import { ShardManager } from '../storage/ShardManager';
import type { RewriteOutput, PipelineContext } from '../pipeline/types';

// A lightweight fake ShardManager exercising the real hash path.
function makeShardManager(shardCount: number): ShardManager {
  const shards = new Map<number, any>();
  for (let i = 0; i < shardCount; i++) {
    shards.set(i, { shardId: i });
  }
  return {
    shards,
    getShardCount: () => shardCount,
    getShardIdForKey: (key: string, count: number) => {
      // Replicate the real polynomial hash + modulo used by ShardManager.
      let hash = BigInt(0);
      for (let i = 0; i < key.length; i++) {
        hash = (hash * BigInt(31) + BigInt(key.charCodeAt(i))) % BigInt(2 ** 53);
      }
      return Number(hash % BigInt(count));
    },
  } as any;
}

const SQLITE_OLTP_CATEGORIES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
type Cat = (typeof SQLITE_OLTP_CATEGORIES)[number];

function routeWith(
  shardManager: ShardManager,
  sql: string,
  category: Cat,
): Promise<{ shardId: number; scatter: boolean; sql: string }> {
  const router = createShardRouter(shardManager);
  return router(sql, [], category) as any;
}

describe('RouteStep.process', () => {
  it('delegates to the injected route fn with sql/tables/category', async () => {
    const route = vi.fn(async () => ({ shardId: 3, scatter: false, sql: 'x' }));
    const step = new RouteStep({ route });
    const output: RewriteOutput = {
      sql: 'SELECT * FROM t WHERE id = 1',
      meta: {
        rewrittenSql: '',
        category: 'SELECT',
        tables: ['t'],
        hasReturning: false,
        isCopy: false,
        hasParams: false,
      },
    };
    const result = await step.process(output, {} as PipelineContext);
    expect(route).toHaveBeenCalledWith('SELECT * FROM t WHERE id = 1', ['t'], 'SELECT');
    expect(result.shardId).toBe(3);
  });
});

describe('createShardRouter — single shard short-circuit', () => {
  it('returns shard 0 without scatter when shardCount <= 1', async () => {
    for (const n of [0, 1]) {
      const r = await routeWith(makeShardManager(n), 'SELECT * FROM t', 'SELECT');
      expect(r).toEqual({ shardId: 0, scatter: false, sql: 'SELECT * FROM t' });
    }
  });
});

describe('createShardRouter — category routing', () => {
  it('routes DDL/TCL/COPY/SET/SHOW/OTHER to shard 0 without scatter', async () => {
    const mgr = makeShardManager(4);
    for (const cat of ['DDL', 'TCL', 'COPY', 'SET', 'SHOW', 'OTHER'] as const) {
      const r = await routeWith(mgr, 'SOMETHING', cat);
      expect(r.shardId).toBe(0);
      expect(r.scatter).toBe(false);
    }
  });

  it('routes SELECT with shard-key WHERE to a single shard', async () => {
    const mgr = makeShardManager(8);
    const r = await routeWith(mgr, 'SELECT * FROM t WHERE id = 42', 'SELECT');
    expect(r.scatter).toBe(false);
    expect(r.shardId).toBe(mgr.getShardIdForKey('42', 8));
    expect(r.shardId).toBeGreaterThanOrEqual(0);
    expect(r.shardId).toBeLessThan(8);
  });

  it('routes SELECT without shard key to scatter (-1)', async () => {
    const mgr = makeShardManager(8);
    const r = await routeWith(mgr, 'SELECT * FROM t ORDER BY created_at LIMIT 10', 'SELECT');
    expect(r.shardId).toBe(-1);
    expect(r.scatter).toBe(true);
  });

  it('routes INSERT without shard-key column via first-VALUES fallback', async () => {
    const mgr = makeShardManager(8);
    const r = await routeWith(mgr, 'INSERT INTO t (a, b) VALUES (1, 2)', 'INSERT');
    // No shard-key column (a/b are not *_id), so fallback routes on the first
    // tuple value ("1").
    expect(r.shardId).toBe(mgr.getShardIdForKey('1', 8));
    expect(r.scatter).toBe(false);
  });

  it('strips double quotes in the fallback first value (consistency bug)', async () => {
    const mgr = makeShardManager(8);
    const r = await routeWith(mgr, 'INSERT INTO t VALUES ("42", "x")', 'INSERT');
    // The double-quoted first value must be unquoted to "42" before hashing.
    expect(r.shardId).toBe(mgr.getShardIdForKey('42', 8));
    expect(r.scatter).toBe(false);
  });
});

describe('inferShardFromSql — WHERE shard-key extraction', () => {
  it('extracts numeric literal after shard key', async () => {
    const mgr = makeShardManager(4);
    const r = await routeWith(mgr, 'SELECT * FROM t WHERE user_id = 7', 'SELECT');
    expect(r.shardId).toBe(mgr.getShardIdForKey('7', 4));
    expect(r.scatter).toBe(false);
  });

  it('extracts quoted string literal after shard key', async () => {
    const mgr = makeShardManager(4);
    const r = await routeWith(mgr, "SELECT * FROM t WHERE id = 'abc'", 'SELECT');
    expect(r.shardId).toBe(mgr.getShardIdForKey('abc', 4));
    expect(r.scatter).toBe(false);
  });

  it('does NOT route when WHERE column is not a shard-key name', async () => {
    const mgr = makeShardManager(4);
    const r = await routeWith(mgr, 'SELECT * FROM t WHERE name = 7', 'SELECT');
    expect(r.shardId).toBe(-1);
    expect(r.scatter).toBe(true);
  });

  it('routes UPDATE with shard-key WHERE to a single shard', async () => {
    const mgr = makeShardManager(4);
    const r = await routeWith(mgr, 'UPDATE t SET x = 1 WHERE id = 9', 'UPDATE');
    expect(r.shardId).toBe(mgr.getShardIdForKey('9', 4));
    expect(r.scatter).toBe(false);
  });

  it('routes DELETE with shard-key WHERE to a single shard', async () => {
    const mgr = makeShardManager(4);
    const r = await routeWith(mgr, 'DELETE FROM t WHERE id = 5', 'DELETE');
    expect(r.shardId).toBe(mgr.getShardIdForKey('5', 4));
    expect(r.scatter).toBe(false);
  });
});

describe('inferShardFromSql — INSERT shard-key extraction', () => {
  it('extracts shard-key value from INSERT columns/values', async () => {
    const mgr = makeShardManager(4);
    const r = await routeWith(mgr, 'INSERT INTO t (id, name) VALUES (10, \'alice\')', 'INSERT');
    expect(r.shardId).toBe(mgr.getShardIdForKey('10', 4));
    expect(r.scatter).toBe(false);
  });

  it('extracts quoted string shard-key value', async () => {
    const mgr = makeShardManager(4);
    const r = await routeWith(mgr, "INSERT INTO t (name, order_id) VALUES ('bob', 'x1')", 'INSERT');
    expect(r.shardId).toBe(mgr.getShardIdForKey('x1', 4));
    expect(r.scatter).toBe(false);
  });

  it('falls back to first VALUES value when no shard-key column', async () => {
    const mgr = makeShardManager(4);
    const r = await routeWith(mgr, "INSERT INTO t (name, age) VALUES ('carol', 30)", 'INSERT');
    // No shard-key column, so it falls back to first value 'carol'.
    expect(r.shardId).toBe(mgr.getShardIdForKey('carol', 4));
    expect(r.scatter).toBe(false);
  });
});

describe('inferShardFromSql — INSERT without VALUES tuple', () => {
  it('scatters INSERT ... SELECT (no VALUES pattern)', async () => {
    const mgr = makeShardManager(4);
    const r = await routeWith(mgr, 'INSERT INTO t (id, name) SELECT id, name FROM src', 'INSERT');
    expect(r.shardId).toBe(-1);
    expect(r.scatter).toBe(true);
  });
});
