import { describe, it, expect } from 'vitest';
import { detectPartialIndex, rewritePartialIndex } from '../index/PartialIndexShim';

describe('PartialIndexShim — detectPartialIndex', () => {
  it('returns true for a plain partial index with a WHERE clause', () => {
    expect(detectPartialIndex('CREATE INDEX idx ON t (a) WHERE active = 1')).toBe(true);
  });

  it('returns true for UNIQUE partial index', () => {
    expect(detectPartialIndex('CREATE UNIQUE INDEX idx ON t (a) WHERE active = 1')).toBe(true);
  });

  it('returns true for lowercase CREATE INDEX with WHERE', () => {
    expect(detectPartialIndex('create index idx on t (a) where a > 0')).toBe(true);
  });

  it('handles leading whitespace', () => {
    expect(detectPartialIndex('  CREATE INDEX idx ON t (a) WHERE a=1')).toBe(true);
  });

  it('handles trailing semicolon after WHERE', () => {
    expect(detectPartialIndex('CREATE INDEX idx ON t (a) WHERE a=1;')).toBe(true);
  });

  it('detects a quoted index name containing "where" without false-positive', () => {
    expect(detectPartialIndex('CREATE INDEX "my where" ON t (a) WHERE a=1')).toBe(true);
  });

  it('returns false for a full index without WHERE', () => {
    expect(detectPartialIndex('CREATE INDEX idx ON t (a)')).toBe(false);
  });

  it('returns false for NULLS NOT DISTINCT only (no WHERE)', () => {
    expect(detectPartialIndex('CREATE INDEX idx ON t (a) NULLS NOT DISTINCT')).toBe(false);
  });

  it('returns false for a WHERE-less column named where_col', () => {
    expect(detectPartialIndex('CREATE INDEX idx ON t (where_col)')).toBe(false);
  });

  it('returns false for non-CREATE-INDEX statements', () => {
    expect(detectPartialIndex('SELECT * FROM t WHERE x=1')).toBe(false);
    expect(detectPartialIndex('DROP INDEX idx')).toBe(false);
  });

  it('returns false for trailing WHERE with no predicate', () => {
    expect(detectPartialIndex('CREATE INDEX idx ON t (a) WHERE')).toBe(false);
  });

  it('returns false for empty and whitespace-only input', () => {
    expect(detectPartialIndex('')).toBe(false);
    expect(detectPartialIndex('   ')).toBe(false);
  });
});

describe('PartialIndexShim — rewritePartialIndex', () => {
  it('strips CONCURRENTLY from a partial index', () => {
    const r = rewritePartialIndex('CREATE INDEX CONCURRENTLY idx ON t (a) WHERE active = 1');
    expect(r.sql).toBe('CREATE INDEX idx ON t (a) WHERE active = 1');
    expect(r.rewritten).toBe(true);
  });

  it('strips CONCURRENTLY from a UNIQUE partial index', () => {
    const r = rewritePartialIndex('CREATE UNIQUE INDEX CONCURRENTLY idx ON t (a) WHERE active = 1');
    expect(r.sql).toBe('CREATE UNIQUE INDEX idx ON t (a) WHERE active = 1');
    expect(r.rewritten).toBe(true);
  });

  it('strips NULLS NOT DISTINCT while preserving WHERE', () => {
    const r = rewritePartialIndex('CREATE INDEX idx ON t (a) NULLS NOT DISTINCT WHERE active = 1');
    expect(r.sql).toBe('CREATE INDEX idx ON t (a) WHERE active = 1');
    expect(r.rewritten).toBe(true);
  });

  it('strips both CONCURRENTLY and NULLS NOT DISTINCT together', () => {
    const r = rewritePartialIndex(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx ON t (a) NULLS NOT DISTINCT WHERE active = 1',
    );
    expect(r.sql).toBe('CREATE UNIQUE INDEX IF NOT EXISTS idx ON t (a) WHERE active = 1');
    expect(r.rewritten).toBe(true);
  });

  it('preserves IF NOT EXISTS (SQLite passthrough)', () => {
    const r = rewritePartialIndex('CREATE INDEX IF NOT EXISTS idx ON t (a) WHERE active = 1');
    expect(r.sql).toBe('CREATE INDEX IF NOT EXISTS idx ON t (a) WHERE active = 1');
    expect(r.rewritten).toBe(false);
  });

  it('leaves a plain partial index unchanged and reports rewritten=false', () => {
    const r = rewritePartialIndex('CREATE INDEX idx ON t (a) WHERE active = 1');
    expect(r.sql).toBe('CREATE INDEX idx ON t (a) WHERE active = 1');
    expect(r.rewritten).toBe(false);
  });

  it('strips NULLS NOT DISTINCT even without WHERE (rewritten=true)', () => {
    const r = rewritePartialIndex('CREATE INDEX idx ON t (a) NULLS NOT DISTINCT');
    expect(r.sql).toBe('CREATE INDEX idx ON t (a)');
    expect(r.rewritten).toBe(true);
  });

  it('returns non-CREATE-INDEX statements unchanged with rewritten=false', () => {
    const r = rewritePartialIndex('DROP INDEX idx');
    expect(r.sql).toBe('DROP INDEX idx');
    expect(r.rewritten).toBe(false);
  });

  it('returns non-CREATE-INDEX statements (SELECT) unchanged', () => {
    const r = rewritePartialIndex('SELECT * FROM t WHERE x=1');
    expect(r.sql).toBe('SELECT * FROM t WHERE x=1');
    expect(r.rewritten).toBe(false);
  });

  it('returns empty and whitespace-only input unchanged', () => {
    expect(rewritePartialIndex('').sql).toBe('');
    expect(rewritePartialIndex('').rewritten).toBe(false);
    expect(rewritePartialIndex('   ').sql).toBe('');
    expect(rewritePartialIndex('   ').rewritten).toBe(false);
  });

  it('collapses multiple whitespace caused by token removal (leading spaces)', () => {
    const r = rewritePartialIndex('  CREATE INDEX   CONCURRENTLY   idx   ON t (a) WHERE a = 1');
    expect(r.sql).toBe('CREATE INDEX idx ON t (a) WHERE a = 1');
    expect(r.rewritten).toBe(true);
  });

  it('strips lowercase CONCURRENTLY and NULLS NOT DISTINCT', () => {
    const r = rewritePartialIndex(
      'create index concurrently idx on t (a) nulls not distinct where a > 0',
    );
    expect(r.sql).toBe('create index idx on t (a) where a > 0');
    expect(r.rewritten).toBe(true);
  });
});
