import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BloomFilterIndex,
  BloomFilterManager,
  getBloomFilterManager,
  detectBloomIndex,
  rewriteBloomIndex,
} from '../query/BloomIndexShim';

describe('BloomFilterIndex', () => {
  it('computes positive m and k from capacity/fpr', () => {
    const bf = new BloomFilterIndex(100, 0.001);
    expect(bf.getM()).toBeGreaterThan(0);
    expect(bf.getK()).toBeGreaterThanOrEqual(1);
    expect(bf.getM() % 8).toBe(0);
  });
  it('starts empty', () => {
    const bf = new BloomFilterIndex(100);
    expect(bf.size()).toBe(0);
    expect(bf.fillRatio()).toBe(0);
    expect(bf.getFpr()).toBe(0.001);
  });
  it('adds and tests membership', async () => {
    const bf = new BloomFilterIndex(100, 0.001);
    await bf.addValue('hello');
    expect(bf.size()).toBe(1);
    expect(await bf.maybeContains('hello')).toBe(true);
    expect(await bf.maybeContains('world')).toBe(false);
  });
  it('tracks fill ratio as n / capacity', async () => {
    const bf = new BloomFilterIndex(100);
    await bf.addValue('a');
    expect(bf.fillRatio()).toBeCloseTo(0.01, 5);
  });
  it('serializes and deserializes round-trip', async () => {
    const bf = new BloomFilterIndex(100, 0.001);
    await bf.addValue('hello');
    await bf.addValue('world');
    const ser = bf.serialize();
    expect(ser).toHaveProperty('m');
    expect(ser).toHaveProperty('k');
    expect(ser).toHaveProperty('n');
    expect(ser).toHaveProperty('capacity');
    expect(ser).toHaveProperty('fpr');
    expect(Array.isArray(ser.bits)).toBe(true);

    const restored = BloomFilterIndex.deserialize(ser);
    expect(restored.getM()).toBe(bf.getM());
    expect(restored.getK()).toBe(bf.getK());
    expect(restored.size()).toBe(bf.size());
    expect(await restored.maybeContains('hello')).toBe(true);
    expect(await restored.maybeContains('world')).toBe(true);
    expect(await restored.maybeContains('absent')).toBe(false);
  });
  it('uses k >= 1 even for tiny capacity', () => {
    const bf = new BloomFilterIndex(1, 0.5);
    expect(bf.getK()).toBeGreaterThanOrEqual(1);
  });
});

describe('BloomFilterManager', () => {
  it('getOrCreate returns the same instance for the same key', () => {
    const mgr = new BloomFilterManager();
    const a = mgr.getOrCreate('t', 'c1, c2');
    const b = mgr.getOrCreate('t', 'c1, c2');
    expect(a).toBe(b);
    expect(mgr.filterCount()).toBe(1);
  });
  it('get returns undefined for a missing key', () => {
    const mgr = new BloomFilterManager();
    expect(mgr.get('t', 'c1')).toBeUndefined();
  });
  it('clear empties the filter map', () => {
    const mgr = new BloomFilterManager();
    mgr.getOrCreate('t', 'c1');
    expect(mgr.filterCount()).toBe(1);
    mgr.clear();
    expect(mgr.filterCount()).toBe(0);
  });
  it('addValue / maybeContains flow', async () => {
    const mgr = new BloomFilterManager();
    await mgr.addValue('t', 'c1', 'v1');
    expect(mgr.filterCount()).toBe(1);
    expect(await mgr.maybeContains('t', 'c1', 'v1')).toBe(true);
  });
  it('maybeContains returns true when no filter exists (assume present)', async () => {
    const mgr = new BloomFilterManager();
    expect(await mgr.maybeContains('nope', 'c', 'x')).toBe(true);
  });
  it('saveAll writes filters via the db handle', () => {
    const mgr = new BloomFilterManager();
    mgr.getOrCreate('t', 'c1', 100, 0.001);
    const exec = vi.fn();
    const upsert = { run: vi.fn() };
    const prepare = vi.fn(() => upsert);
    const db = {
      exec,
      prepare,
      transaction: (fn: () => void) => fn,
    };
    mgr.saveAll(db);
    expect(exec).toHaveBeenCalled();
    expect(prepare).toHaveBeenCalled();
    expect(upsert.run).toHaveBeenCalled();
  });
  it('loadAll restores filters from rows', async () => {
    const src = new BloomFilterIndex(100, 0.001);
    await src.addValue('hello');
    const ser = src.serialize();

    const rows = [
      {
        filter_key: 't_c1',
        m: ser.m,
        k: ser.k,
        n: ser.n,
        capacity: ser.capacity,
        fpr: ser.fpr,
        bits: Buffer.from(ser.bits),
      },
    ];
    const db = {
      prepare: vi.fn(() => ({ all: vi.fn(() => rows) })),
    };
    const mgr = new BloomFilterManager();
    mgr.loadAll(db);
    expect(mgr.filterCount()).toBe(1);
    expect(await mgr.maybeContains('t', 'c1', 'hello')).toBe(true);
  });
  it('loadAll swallows a missing-table error', () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('no such table: __bloom_filters');
      }),
    };
    const mgr = new BloomFilterManager();
    expect(() => mgr.loadAll(db)).not.toThrow();
    expect(mgr.filterCount()).toBe(0);
  });
  it('loadAll logs other errors', () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('some other failure');
      }),
    };
    const mgr = new BloomFilterManager();
    expect(() => mgr.loadAll(db)).not.toThrow();
  });
});

describe('getBloomFilterManager', () => {
  it('returns a stable singleton', () => {
    expect(getBloomFilterManager()).toBe(getBloomFilterManager());
  });
});

describe('detectBloomIndex', () => {
  it('detects USING bloom in CREATE INDEX', () => {
    expect(detectBloomIndex('CREATE INDEX i ON t USING bloom (c1, c2);')).toBe(true);
    expect(detectBloomIndex('CREATE UNIQUE INDEX i ON t USING bloom (c1);')).toBe(true);
    expect(detectBloomIndex('CREATE INDEX IF NOT EXISTS i ON t USING bloom (c1);')).toBe(true);
    expect(detectBloomIndex('CREATE INDEX i ON t USING BLOOM (c1);')).toBe(true);
    expect(detectBloomIndex('Create index i on t using bloom (c1);')).toBe(true);
  });
  it('is deterministic across repeated calls', () => {
    const s = 'CREATE INDEX i ON t USING bloom (c1);';
    const results = [0, 1, 2, 3, 4].map(() => detectBloomIndex(s));
    expect(results).toEqual([true, true, true, true, true]);
  });
  it('rejects a plain btree index', () => {
    expect(detectBloomIndex('CREATE INDEX i ON t (c1);')).toBe(false);
  });
  it('rejects non-bloom methods', () => {
    expect(detectBloomIndex('CREATE INDEX i ON t USING btree (c1);')).toBe(false);
    expect(detectBloomIndex('CREATE INDEX i ON t USING bloom_a (c1);')).toBe(false);
  });
  it('rejects a string literal containing a bloom clause', () => {
    expect(detectBloomIndex("SELECT 'CREATE INDEX i ON t USING bloom (x)' FROM t;")).toBe(false);
  });
  it('rejects a line comment', () => {
    expect(detectBloomIndex('-- CREATE INDEX i ON t USING bloom (x)\nSELECT 1;')).toBe(false);
  });
  it('rejects a block comment', () => {
    expect(detectBloomIndex('/* CREATE INDEX i ON t USING bloom */ SELECT 1;')).toBe(false);
  });
  it('rejects null / undefined / blank', () => {
    expect(detectBloomIndex(null as unknown as string)).toBe(false);
    expect(detectBloomIndex(undefined as unknown as string)).toBe(false);
    expect(detectBloomIndex('   ')).toBe(false);
  });
  it('handles a comment between index name and USING', () => {
    expect(detectBloomIndex('CREATE INDEX i ON t -- c\nUSING bloom (c1);')).toBe(true);
  });
  it('rejects USING with no method identifier', () => {
    expect(detectBloomIndex('CREATE INDEX i ON t USING (c1);')).toBe(false);
  });
});

describe('rewriteBloomIndex', () => {
  it('rewrites USING bloom to USING btree', () => {
    expect(rewriteBloomIndex('CREATE INDEX i ON t USING bloom (c1, c2);')).toEqual({
      sql: 'CREATE INDEX i ON t USING btree (c1, c2);',
      rewritten: true,
    });
  });
  it('rewrites a UNIQUE index', () => {
    expect(rewriteBloomIndex('CREATE UNIQUE INDEX i ON t USING bloom (c1);')).toEqual({
      sql: 'CREATE UNIQUE INDEX i ON t USING btree (c1);',
      rewritten: true,
    });
  });
  it('rewrites an IF NOT EXISTS index', () => {
    expect(rewriteBloomIndex('CREATE INDEX IF NOT EXISTS i ON t USING bloom (c1);')).toEqual({
      sql: 'CREATE INDEX IF NOT EXISTS i ON t USING btree (c1);',
      rewritten: true,
    });
  });
  it('preserves lowercase USING casing', () => {
    expect(rewriteBloomIndex('Create index i on t using bloom (c1);')).toEqual({
      sql: 'Create index i on t using btree (c1);',
      rewritten: true,
    });
  });
  it('preserves WITH parameters', () => {
    expect(
      rewriteBloomIndex('CREATE INDEX i ON t USING bloom (c1) WITH (length=80);'),
    ).toEqual({
      sql: 'CREATE INDEX i ON t USING btree (c1) WITH (length=80);',
      rewritten: true,
    });
  });
  it('rewrites a bloom method without a column list', () => {
    expect(rewriteBloomIndex('CREATE INDEX i ON t USING bloom;')).toEqual({
      sql: 'CREATE INDEX i ON t USING btree;',
      rewritten: true,
    });
  });
  it('passes through a plain index', () => {
    expect(rewriteBloomIndex('CREATE INDEX i ON t (c1);')).toEqual({
      sql: 'CREATE INDEX i ON t (c1);',
      rewritten: false,
    });
  });
  it('passes through a non-bloom statement unchanged', () => {
    expect(rewriteBloomIndex('SELECT 1;')).toEqual({ sql: 'SELECT 1;', rewritten: false });
  });
  it('does not rewrite a string literal', () => {
    expect(rewriteBloomIndex("SELECT 'CREATE INDEX i ON t USING bloom (x)' FROM t;")).toEqual({
      sql: "SELECT 'CREATE INDEX i ON t USING bloom (x)' FROM t;",
      rewritten: false,
    });
  });
  it('handles null / undefined / blank', () => {
    expect(rewriteBloomIndex(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteBloomIndex(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteBloomIndex('   ')).toEqual({ sql: '   ', rewritten: false });
  });
});
