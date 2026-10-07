import { describe, it, expect } from 'vitest';
import { detectVectorIndex, rewriteVectorIndex } from '../index/VectorIndexShim';

describe('detectVectorIndex', () => {
  it('detects HNSW vector indexes', () => {
    expect(detectVectorIndex('CREATE INDEX idx ON t USING HNSW (embedding)')).toBe(true);
  });

  it('detects IVFPQ vector indexes', () => {
    expect(detectVectorIndex('CREATE INDEX idx ON t USING IVFPQ (embedding)')).toBe(true);
  });

  it('detects case-insensitively', () => {
    expect(detectVectorIndex('create index idx on t using hnsw (embedding)')).toBe(true);
    expect(detectVectorIndex('CREATE INDEX idx ON t USING ivfpq (vec)')).toBe(true);
  });

  it('detects UNIQUE / IF NOT EXISTS variants', () => {
    expect(detectVectorIndex('CREATE UNIQUE INDEX idx ON t USING HNSW (embedding)')).toBe(true);
    expect(detectVectorIndex('CREATE INDEX IF NOT EXISTS idx ON t USING HNSW (embedding)')).toBe(true);
  });

  it('returns false for non-vector indexes', () => {
    expect(detectVectorIndex('CREATE INDEX idx ON t (col)')).toBe(false);
    expect(detectVectorIndex('SELECT * FROM t')).toBe(false);
    expect(detectVectorIndex('CREATE INDEX idx ON t USING BTREE (col)')).toBe(false);
  });
});

describe('rewriteVectorIndex', () => {
  it('returns original SQL unchanged for non-vector statements', () => {
    expect(rewriteVectorIndex('CREATE INDEX idx ON t (col)')).toEqual({
      sql: 'CREATE INDEX idx ON t (col)',
      rewritten: false,
    });
  });

  it('extracts metadata for a simple HNSW index', () => {
    const r = rewriteVectorIndex('CREATE INDEX idx ON t USING HNSW (embedding) WITH (metric = l2sq)');
    expect(r.rewritten).toBe(true);
    expect(r.meta).toEqual({
      indexName: 'idx',
      tableName: 't',
      columnName: 'embedding',
      indexType: 'hnsw',
      metric: 'l2',
      params: { metric: 'l2sq' },
    });
  });

  it('normalizes l2sq metric to l2 (default when omitted)', () => {
    const r = rewriteVectorIndex('CREATE INDEX idx ON t USING HNSW (embedding)');
    expect(r.meta?.metric).toBe('l2');
  });

  it('normalizes cosine metric to ip', () => {
    const r = rewriteVectorIndex('CREATE INDEX idx ON t USING HNSW (embedding) WITH (metric = cosine)');
    expect(r.meta?.metric).toBe('ip');
  });

  it('reads metric from the distance alias', () => {
    const r = rewriteVectorIndex('CREATE INDEX idx ON t USING HNSW (embedding) WITH (distance = l2sq)');
    expect(r.meta?.metric).toBe('l2');
  });

  it('passes through an unrecognized metric unchanged', () => {
    const r = rewriteVectorIndex('CREATE INDEX idx ON t USING HNSW (embedding) WITH (metric = hamming)');
    expect(r.meta?.metric).toBe('hamming');
  });

  it('keeps the table schema separate from the index name', () => {
    const r = rewriteVectorIndex('CREATE INDEX idx ON public.t USING HNSW (embedding)');
    expect(r.meta?.tableName).toBe('public.t');
    expect(r.meta?.indexName).toBe('idx');
  });

  it('qualifies the index name with its own schema, not the table schema', () => {
    const r = rewriteVectorIndex('CREATE INDEX my_schema.idx ON t USING HNSW (embedding)');
    expect(r.meta?.indexName).toBe('my_schema.idx');
    expect(r.meta?.tableName).toBe('t');
  });

  it('handles distinct index and table schemas independently', () => {
    const r = rewriteVectorIndex('CREATE INDEX s1.idx ON s2.t USING IVFPQ (embedding) WITH (K=64, M=8)');
    expect(r.meta?.indexName).toBe('s1.idx');
    expect(r.meta?.tableName).toBe('s2.t');
  });

  it('parses multiple WITH parameters', () => {
    const r = rewriteVectorIndex('CREATE INDEX idx ON t USING IVFPQ (embedding) WITH (K=64, M=8)');
    expect(r.meta?.indexType).toBe('ivfpq');
    expect(r.meta?.params).toEqual({ k: '64', m: '8' });
  });

  it('lowercases parameter keys', () => {
    const r = rewriteVectorIndex('CREATE INDEX idx ON t USING HNSW (embedding) WITH (Metric = L2SQ)');
    expect(r.meta?.params).toEqual({ metric: 'L2SQ' });
  });

  it('ignores malformed WITH pairs without =', () => {
    const r = rewriteVectorIndex('CREATE INDEX idx ON t USING HNSW (embedding) WITH (nokey)');
    expect(r.meta?.params).toEqual({});
  });

  it('emits a no-op SQL comment for rewritten indexes', () => {
    const r = rewriteVectorIndex('CREATE INDEX idx ON t USING HNSW (embedding)');
    expect(r.sql).toContain('-- Vector index');
    expect(r.sql).toContain('managed by VectorEngine');
  });
});
