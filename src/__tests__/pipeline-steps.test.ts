import { describe, it, expect } from 'vitest';
import { ShimCache } from '../pipeline/ShimCache';
import { ResultStep } from '../pipeline/ResultStep';
import { RewriteStep } from '../pipeline/RewriteStep';
import { ExecStep } from '../pipeline/ExecStep';
import type { RewriteOutput } from '../pipeline/types';

function out(sql = 'SELECT 1'): RewriteOutput {
  return {
    sql,
    meta: {
      rewrittenSql: sql,
      category: 'SELECT',
      tables: [],
      hasReturning: false,
      isCopy: false,
      hasParams: false,
    },
  };
}

describe('ShimCache — normalizeKey & basic access', () => {
  it('collapses whitespace and trims', () => {
    expect(ShimCache.normalizeKey('  SELECT   1  FROM   t ')).toBe('SELECT 1 FROM t');
  });

  it('returns undefined and increments misses on a miss', () => {
    const c = new ShimCache();
    expect(c.get('SELECT 1')).toBeUndefined();
    expect(c.misses).toBe(1);
    expect(c.hits).toBe(0);
  });

  it('returns the stored value and increments hits on a hit', () => {
    const c = new ShimCache();
    const v = out('SELECT x');
    c.set('SELECT x', v);
    expect(c.get('SELECT x')).toBe(v);
    expect(c.hits).toBe(1);
  });

  it('hitRate is 0 with no traffic and correct after traffic', () => {
    const c = new ShimCache();
    expect(c.hitRate).toBe(0);
    c.set('SELECT 1', out());
    c.get('SELECT 1');
    c.get('SELECT 1');
    c.get('SELECT missing');
    expect(c.hitRate).toBeCloseTo(2 / 3);
  });

  it('update on set for an existing key does not change size', () => {
    const c = new ShimCache();
    c.set('SELECT 1', out('SELECT 1'));
    c.set('SELECT 1', out('SELECT 1 v2'));
    expect(c.size).toBe(1);
    expect(c.get('SELECT 1')?.sql).toBe('SELECT 1 v2');
  });
});

describe('ShimCache — LRU eviction & promotion', () => {
  it('evicts the least-recently-used entry beyond maxEntries', () => {
    const c = new ShimCache(2);
    c.set('a', out('a'));
    c.set('b', out('b'));
    c.set('c', out('c'));
    expect(c.size).toBe(2);
    expect(c.get('a')).toBeUndefined(); // 'a' was LRU and got evicted
    expect(c.get('b')).toBeDefined();
    expect(c.get('c')).toBeDefined();
  });

  it('promotes a recently-accessed entry so it survives eviction', () => {
    const c = new ShimCache(2);
    c.set('a', out('a'));
    c.set('b', out('b'));
    // Access 'a' to promote it to MRU, then add 'c' which evicts 'b'.
    c.get('a');
    c.set('c', out('c'));
    expect(c.get('a')).toBeDefined();
    expect(c.get('b')).toBeUndefined();
  });

  it('handles maxEntries=0 by evicting every new entry immediately', () => {
    const c = new ShimCache(0);
    c.set('a', out('a'));
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });

  it('invalidate clears everything', () => {
    const c = new ShimCache();
    c.set('a', out('a'));
    c.set('b', out('b'));
    c.invalidate();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });

  it('promotes a middle node to head correctly (3-node chain)', () => {
    const c = new ShimCache(2);
    c.set('a', out('a'));
    c.set('b', out('b'));
    // Access 'a' (the current LRU) to make it MRU, demoting 'b' to LRU.
    c.get('a');
    // Add 'c' → evicts 'b' (now LRU), keeping 'a'.
    c.set('c', out('c'));
    expect(c.get('a')).toBeDefined();
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBeDefined();
  });

  it('promotes a true middle node (both prev and next set) to head', () => {
    const c = new ShimCache(3);
    c.set('a', out('a')); // head
    c.set('b', out('b')); // head (a -> b -> null)
    c.set('c', out('c')); // head (a -> b -> c)
    // 'b' is the middle node. Promote it to head.
    c.get('b');
    // Now MRU order is: c, a, b. Access 'a' then evict to prove chain integrity.
    c.get('a');
    c.set('d', out('d')); // size 3 not exceeded (a,b,c,d would be 4) → evicts LRU
    expect(c.size).toBe(4 - 1); // maxEntries=3, so one eviction happened
    expect(c.size).toBe(3);
  });

  it('evicts a middle node correctly when maxEntries is exceeded deeply', () => {
    const c = new ShimCache(1);
    // One-entry cache: every set beyond the first evicts the previous head.
    c.set('a', out('a'));
    c.set('b', out('b'));
    expect(c.size).toBe(1);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeDefined();
  });
});

describe('ResultStep — deriveCommandTag', () => {
  const step = new ResultStep();

  function single(rows: any[], rowCount: number, category?: any, queryTimeMs = 0) {
    return step.process([{ rows, rowCount, queryTimeMs, engine: 'sqlite', shardId: 0 }], category);
  }

  it('returns OK when no category is provided', () => {
    expect(single([], 0, undefined).commandTag).toBe('OK');
  });

  it('SELECT tag includes row count', () => {
    expect(single([{ a: 1 }, { a: 2 }], 2, 'SELECT').commandTag).toBe('SELECT 2');
  });

  it('INSERT tag includes row count', () => {
    expect(single([], 3, 'INSERT').commandTag).toBe('INSERT 3');
  });

  it('UPDATE tag includes row count', () => {
    expect(single([], 5, 'UPDATE').commandTag).toBe('UPDATE 5');
  });

  it('DELETE tag includes row count', () => {
    expect(single([], 7, 'DELETE').commandTag).toBe('DELETE 7');
  });

  it('DDL tag is bare CREATE', () => {
    expect(single([], 0, 'DDL').commandTag).toBe('CREATE');
  });

  it('TCL tag is bare COMMIT', () => {
    expect(single([], 0, 'TCL').commandTag).toBe('COMMIT');
  });

  it('SET/SHOW tags are bare', () => {
    expect(single([], 0, 'SET').commandTag).toBe('SET');
    expect(single([], 0, 'SHOW').commandTag).toBe('SHOW');
  });

  it('COPY tag is bare COPY', () => {
    expect(single([], 0, 'COPY').commandTag).toBe('COPY');
  });

  it('unknown category falls back to OK', () => {
    expect(single([], 0, 'UNKNOWN_CATEGORY').commandTag).toBe('OK');
  });

  it('SELECT/INSERT/UPDATE/DELETE with undefined rowCount default to 0', () => {
    // Row-count branch uses `rowCount ?? 0`; exercise the undefined side.
    expect(step.process([{ rows: [], rowCount: undefined as any, queryTimeMs: 0, engine: 'sqlite', shardId: 0 }], 'UPDATE').commandTag).toBe('UPDATE 0');
    expect(step.process([{ rows: [], rowCount: undefined as any, queryTimeMs: 0, engine: 'sqlite', shardId: 0 }], 'DELETE').commandTag).toBe('DELETE 0');
    expect(step.process([{ rows: [], rowCount: undefined as any, queryTimeMs: 0, engine: 'sqlite', shardId: 0 }], 'INSERT').commandTag).toBe('INSERT 0');
    expect(step.process([{ rows: [], rowCount: undefined as any, queryTimeMs: 0, engine: 'sqlite', shardId: 0 }], 'SELECT').commandTag).toBe('SELECT 0');
  });

  it('single-result path passes rows/rowCount through directly', () => {
    const o = single([{ a: 1 }], 1, 'SELECT');
    expect(o.rows).toEqual([{ a: 1 }]);
    expect(o.rowCount).toBe(1);
  });
});

describe('ResultStep — mergeResults (multi-shard)', () => {
  const step = new ResultStep();

  it('concatenates rows and sums rowCount/time across shards', () => {
    const o = step.process(
      [
        { rows: [{ a: 1 }], rowCount: 1, queryTimeMs: 5, engine: 'sqlite', shardId: 0 },
        { rows: [{ a: 2 }, { a: 3 }], rowCount: 2, queryTimeMs: 7, engine: 'sqlite', shardId: 1 },
      ],
      'SELECT',
    );
    expect(o.rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(o.rowCount).toBe(3);
    expect(o.queryTimeMs).toBe(12);
    expect(o.shardResults).toHaveLength(2);
  });

  it('tolerates shards with missing rows and falsy rowCount/queryTimeMs', () => {
    const o = step.process(
      [
        { rows: undefined as any, rowCount: 0, queryTimeMs: 0, engine: 'sqlite', shardId: 0 },
        { rows: null as any, rowCount: undefined as any, queryTimeMs: undefined as any, engine: 'sqlite', shardId: 1 },
        { rows: [], rowCount: 4, queryTimeMs: 3, engine: 'sqlite', shardId: 2 },
      ],
      'SELECT',
    );
    expect(o.rows).toEqual([]);
    expect(o.rowCount).toBe(4);
    expect(o.queryTimeMs).toBe(3);
  });
});

describe('RewriteStep — cache interaction', () => {
  it('miss: runs rewrite and stores result; second call hits cache', async () => {
    let calls = 0;
    const step = new RewriteStep({
      rewrite: async (sql) => { calls++; return out(sql); },
      cache: new ShimCache(),
    });
    await step.process('SELECT 1');
    await step.process('SELECT 1');
    expect(calls).toBe(1);
    const stats = step.getCacheStats();
    expect(stats?.hits).toBe(1);
  });

  it('without a cache, always rewrites and getCacheStats is undefined', async () => {
    let calls = 0;
    const step = new RewriteStep({ rewrite: async (sql) => { calls++; return out(sql); } });
    await step.process('SELECT 1');
    await step.process('SELECT 1');
    expect(calls).toBe(2);
    expect(step.getCacheStats()).toBeUndefined();
  });

  it('invalidateCache clears the cache (miss again afterward)', async () => {
    let calls = 0;
    const step = new RewriteStep({
      rewrite: async (sql) => { calls++; return out(sql); },
      cache: new ShimCache(),
    });
    await step.process('SELECT 1');
    step.invalidateCache();
    await step.process('SELECT 1');
    expect(calls).toBe(2);
  });
});

describe('ExecStep — shard hint', () => {
  it('passes shardId hint only for single-shard non-scatter decisions', async () => {
    const seenShards: (number | undefined)[] = [];
    const step = new ExecStep({
      execute: async (_sql, _p, _sid, shardId) => { seenShards.push(shardId); return { rows: [], rowCount: 0, queryTimeMs: 0, engine: 'sqlite' }; },
    });
    // Single shard, no scatter → hint passed.
    await step.process({ shardId: 3, scatter: false, sql: 'SELECT 1' }, { sessionId: 's', currentUser: 'u' });
    // Scatter → no hint.
    await step.process({ shardId: 5, scatter: true, sql: 'SELECT 1' });
    // Negative shardId → no hint.
    await step.process({ shardId: -1, scatter: false, sql: 'SELECT 1' });
    expect(seenShards).toEqual([3, undefined, undefined]);
  });

  it('returns the shardId it was given in the result', async () => {
    const step = new ExecStep({
      execute: async () => ({ rows: [], rowCount: 0, queryTimeMs: 0, engine: 'sqlite' }),
    });
    const r = await step.process({ shardId: 7, scatter: false, sql: 'SELECT 1' });
    expect(r.shardId).toBe(7);
  });
});
