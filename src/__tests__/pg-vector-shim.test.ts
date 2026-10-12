import { describe, it, expect } from 'vitest';
import {
  detectPgVectorSyntax,
  parseVectorLiteral,
  l2DistanceSql,
  cosineDistanceSql,
  innerProductSql,
  rewriteDistanceOperators,
  rewriteIndexOpclass,
  rewriteVectorFunctions,
  rewriteVectorTypeCasts,
  rewriteCreateExtensionVector,
  rewritePgVectorSql,
} from '../query/PgVectorShim';

describe('PgVectorShim — detection', () => {
  it('detects L2 distance operator', () => {
    expect(detectPgVectorSyntax("SELECT * FROM t ORDER BY v <-> '[1,2,3]'")).toBe(true);
  });
  it('detects cosine distance operator', () => {
    expect(detectPgVectorSyntax("SELECT * FROM t ORDER BY v <=> '[1,2,3]'")).toBe(true);
  });
  it('detects inner product operator', () => {
    expect(detectPgVectorSyntax("SELECT * FROM t ORDER BY v <#> '[1,2,3]'")).toBe(true);
  });
  it('detects index opclass', () => {
    expect(detectPgVectorSyntax('CREATE INDEX ON t USING hnsw (v vector_l2_ops)')).toBe(true);
  });
  it('detects vector functions', () => {
    expect(detectPgVectorSyntax('SELECT l2_distance(v, \'[1,2]\')')).toBe(true);
  });
  it('detects vector type cast', () => {
    expect(detectPgVectorSyntax("SELECT '[1,2,3]'::vector")).toBe(true);
  });
  it('detects CREATE EXTENSION vector', () => {
    expect(detectPgVectorSyntax('CREATE EXTENSION vector')).toBe(true);
  });
  it('returns false for trivial / non-string input', () => {
    expect(detectPgVectorSyntax('')).toBe(false);
    expect(detectPgVectorSyntax(undefined as unknown as string)).toBe(false);
    expect(detectPgVectorSyntax('SELECT 1')).toBe(false);
  });
});

describe('parseVectorLiteral', () => {
  it('parses a comma-separated vector', () => {
    expect(parseVectorLiteral('[1,2,3]')).toEqual([1, 2, 3]);
  });
  it('returns [] for an empty vector', () => {
    expect(parseVectorLiteral('[]')).toEqual([]);
  });
  it('skips non-numeric entries and trims whitespace', () => {
    expect(parseVectorLiteral('[1, abc, 3]')).toEqual([1, 3]);
    expect(parseVectorLiteral('[ 1.5 , -2 , 3e2 ]')).toEqual([1.5, -2, 300]);
  });
});

describe('distance SQL builders', () => {
  it('builds L2 distance SQL', () => {
    expect(l2DistanceSql('emb', [1, 2]))
      .toBe('SQRT((emb_0 - 1) * (emb_0 - 1) + (emb_1 - 2) * (emb_1 - 2))');
  });
  it('builds cosine distance SQL', () => {
    const s = cosineDistanceSql('emb', [3, 4]);
    expect(s).toContain('(1 - (emb_0 * 3 + emb_1 * 4)');
    expect(s).toContain('SQRT(emb_0 * emb_0 + emb_1 * emb_1)');
  });
  it('builds inner product SQL', () => {
    expect(innerProductSql('emb', [1, 2])).toBe('(emb_0 * 1 + emb_1 * 2)');
  });

  // BUG regression: empty vectors previously produced invalid SQL —
  // `SQRT()`, a `0/0` cosine, and a dangling `()` inner product.
  it('builds a zero L2 distance for an empty vector', () => {
    expect(l2DistanceSql('emb', [])).toBe('0');
  });
  it('builds a zero cosine distance for an empty vector', () => {
    expect(cosineDistanceSql('emb', [])).toBe('0');
  });
  it('builds a zero inner product for an empty vector', () => {
    expect(innerProductSql('emb', [])).toBe('0');
  });
});

describe('rewriteDistanceOperators', () => {
  it('rewrites L2 distance with LIMIT preserved', () => {
    const r = rewriteDistanceOperators("SELECT * FROM items ORDER BY emb <-> '[1,2,3]' LIMIT 5");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ORDER BY SQRT(');
    expect(r.sql).toContain('LIMIT 5');
  });
  it('defaults LIMIT to 10 when absent', () => {
    const r = rewriteDistanceOperators("SELECT * FROM items ORDER BY emb <-> '[1,2]'");
    expect(r.sql).toContain('LIMIT 10');
  });
  it('preserves a WHERE clause before ORDER BY', () => {
    const r = rewriteDistanceOperators("SELECT * FROM items WHERE active = 1 ORDER BY emb <-> '[1,2]' LIMIT 3");
    expect(r.sql).toContain('WHERE active = 1');
    expect(r.sql).toContain('LIMIT 3');
  });
  it('rewrites cosine distance', () => {
    const r = rewriteDistanceOperators("SELECT * FROM items ORDER BY emb <=> '[1,2,3]'");
    expect(r.rewritten).toBe(true);
  });
  it('rewrites inner product', () => {
    const r = rewriteDistanceOperators("SELECT * FROM items ORDER BY emb <#> '[1,2,3]'");
    expect(r.rewritten).toBe(true);
  });
  it('returns unchanged for no operator', () => {
    const r = rewriteDistanceOperators('SELECT * FROM items');
    expect(r).toEqual({ sql: 'SELECT * FROM items', rewritten: false });
  });
});

describe('rewriteIndexOpclass', () => {
  it('maps vector_l2_ops to l2', () => {
    const r = rewriteIndexOpclass('CREATE INDEX ON t USING hnsw (v vector_l2_ops)');
    expect(r.rewritten).toBe(true);
    expect(r.meta?.metric).toBe('l2');
    expect(r.sql).toContain('managed by VectorEngine');
  });
  it('maps vector_cosine_ops and parses WITH params', () => {
    const r = rewriteIndexOpclass('CREATE INDEX ON t USING ivfflat (v vector_cosine_ops) WITH (lists = 100)');
    expect(r.meta?.metric).toBe('cosine');
    expect((r.meta?.params as Record<string, string>).lists).toBe('100');
  });
  it('maps vector_ip_ops to ip', () => {
    const r = rewriteIndexOpclass('CREATE INDEX ON t USING hnsw (v vector_ip_ops)');
    expect(r.meta?.metric).toBe('ip');
  });
  it('returns unchanged for a non-opclass CREATE INDEX', () => {
    const r = rewriteIndexOpclass('CREATE INDEX ON t (a)');
    expect(r.rewritten).toBe(false);
  });
  it('ignores a WITH parameter that has no = sign', () => {
    const r = rewriteIndexOpclass('CREATE INDEX ON t USING ivfflat (v vector_l2_ops) WITH (lists)');
    expect(r.rewritten).toBe(true);
    expect(r.meta?.params).toEqual({});
  });
});

describe('rewriteVectorFunctions', () => {
  it('prefixes detected vector functions', () => {
    const r = rewriteVectorFunctions("SELECT l2_distance(v, '[1,2]'), vector_dims(v) FROM t");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('__pgvector_l2_distance');
    expect(r.sql).toContain('__pgvector_vector_dims');
  });
  it('returns unchanged when no vector function present', () => {
    const r = rewriteVectorFunctions('SELECT 1');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: false });
  });
});

describe('rewriteVectorTypeCasts', () => {
  it('rewrites a vector type cast to a bare literal', () => {
    const r = rewriteVectorTypeCasts("SELECT '[1,2,3]'::vector");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe("SELECT '[1,2,3]'");
  });
  it('returns unchanged when no cast present', () => {
    const r = rewriteVectorTypeCasts('SELECT 1');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: false });
  });
});

describe('rewriteCreateExtensionVector', () => {
  it('rewrites CREATE EXTENSION vector to SELECT 1', () => {
    expect(rewriteCreateExtensionVector('CREATE EXTENSION vector')).toEqual({
      sql: 'SELECT 1', rewritten: true, type: 'extension', meta: { extension: 'vector' },
    });
    expect(rewriteCreateExtensionVector('CREATE EXTENSION IF NOT EXISTS vector').rewritten).toBe(true);
  });
  it('returns unchanged for other extensions', () => {
    expect(rewriteCreateExtensionVector('CREATE EXTENSION hstore').rewritten).toBe(false);
  });
});

describe('rewritePgVectorSql (main entry)', () => {
  it('routes extension first', () => {
    const r = rewritePgVectorSql('CREATE EXTENSION vector');
    expect(r.type).toBe('extension');
  });
  it('routes index opclass', () => {
    const r = rewritePgVectorSql('CREATE INDEX ON t USING hnsw (v vector_l2_ops)');
    expect(r.type).toBe('index_opclass');
  });
  it('routes distance operator', () => {
    const r = rewritePgVectorSql("SELECT * FROM t ORDER BY emb <-> '[1,2]'");
    expect(r.type).toBe('distance_operator');
  });
  it('routes vector function', () => {
    const r = rewritePgVectorSql("SELECT l2_distance(v, '[1,2]')");
    expect(r.type).toBe('vector_function');
  });
  it('routes vector cast', () => {
    const r = rewritePgVectorSql("SELECT '[1,2]'::vector");
    expect(r.type).toBe('vector_cast');
  });
  it('returns unchanged for plain SQL', () => {
    const r = rewritePgVectorSql('SELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });

  // BUG regression: an empty vector must not yield invalid SQL / 0/0 division.
  it('rewrites an empty L2 vector to ORDER BY 0', () => {
    const r = rewritePgVectorSql("SELECT * FROM t ORDER BY v <-> '[]' LIMIT 5");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT * FROM t ORDER BY 0 ASC LIMIT 5');
  });
  it('now detects and rewrites an empty cosine vector', () => {
    const r = rewritePgVectorSql("SELECT * FROM t ORDER BY v <=> '[]' LIMIT 5");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ORDER BY 0');
  });
  it('now detects and rewrites an empty inner-product vector', () => {
    const r = rewritePgVectorSql("SELECT * FROM t ORDER BY v <#> '[]' LIMIT 5");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ORDER BY 0');
  });
});
