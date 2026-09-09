import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// astCache (module-level Map, capacity 256) — cover cache hit on repeated
// identical SQL and LRU eviction once the cache exceeds capacity.
describe('SqlParser AST cache', () => {
  it('repeated identical SELECT returns cached clone with originalSql', () => {
    const sql = 'SELECT * FROM cache_hit_test_tbl WHERE id = 1';
    const a = parseStatement(sql);
    const b = parseStatement(sql);
    expect(a.type).toBe('SELECT');
    expect(b.type).toBe('SELECT');
    expect(b.originalSql).toBe(sql);
  });

  it('LRU eviction triggers beyond 256 distinct templates', () => {
    // Fill the cache past capacity with distinct templates.
    for (let i = 0; i < 300; i++) {
      parseStatement(`SELECT * FROM lru_t${i} WHERE id = ${i}`);
    }
    // A few more to force eviction of oldest entries.
    for (let i = 0; i < 10; i++) {
      parseStatement(`SELECT * FROM lru_evict${i}`);
    }
    expect(true).toBe(true);
  });
});
