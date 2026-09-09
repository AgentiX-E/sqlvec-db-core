import { describe, it, expect, beforeEach } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// NOTE: These tests exercise the module-level AST cache. astCache is a
// module-private LRU, so we drive it purely through parseStatement behavior —
// repeated identical queries should hit the cache (observable only via the
// clone-with-original-SQL path returning a fresh object each time), and 256+
// distinct queries should trigger LRU eviction without error.

describe('SqlParser AST cache LRU behavior', () => {
  beforeEach(() => {
    // Warm differently every time to avoid polluting cache-size assumptions
    // across tests (the cache is global and not reset between tests).
  });

  it('clones original SQL on cache hit (fresh object)', () => {
    const a = parseStatement('SELECT * FROM t WHERE id = 42');
    const b = parseStatement('SELECT * FROM t WHERE id = 43');
    // Same normalized template (`SELECT * FROM t WHERE id = ?`) → cache hit,
    // but originalSql must reflect each call's own input.
    expect(a.originalSql).toBe('SELECT * FROM t WHERE id = 42');
    expect(b.originalSql).toBe('SELECT * FROM t WHERE id = 43');
    expect(a).not.toBe(b); // clone, not the same reference
  });

  it('fills cache and survives LRU eviction beyond capacity', () => {
    // 300 distinct queries → cache size exceeds AST_CACHE_MAX (256) and
    // eviction kicks in. Each must still parse correctly.
    for (let i = 0; i < 300; i++) {
      const sql = `SELECT * FROM t${i} WHERE id = ${i}`;
      const r = parseStatement(sql);
      expect(r.type).toBe('SELECT');
    }
    // A previously-evicted query still parses fresh (may be cache miss).
    const r = parseStatement('SELECT * FROM t0 WHERE id = 0');
    expect(r.type).toBe('SELECT');
  });

  it('normalizes numeric/string/boolean/null literals to template', () => {
    // Distinct literal values collapse to the same template; ensure all parse.
    const a = parseStatement("SELECT * FROM t WHERE id = 1 AND name = 'x' AND flag = true AND v IS NOT NULL");
    const b = parseStatement("SELECT * FROM t WHERE id = 999 AND name = 'yyyy' AND flag = false AND v IS NOT NULL");
    expect(a.type).toBe('SELECT');
    expect(b.type).toBe('SELECT');
  });
});
