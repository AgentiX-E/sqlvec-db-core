import { describe, it, expect } from 'vitest';
import { detectFTS, rewriteFTS } from '../query/SqlParser';

// Cover the bare-column `@@` FTS form and its rewrite. Previously detectFTS only
// extracted column from inside to_tsvector(...), so `col @@ plainto_tsquery(...)`
// produced a broken `col MATCH plainto_tsquery(...)` rewrite (leaving the
// tsquery call intact). Now the bare column is detected and the full MATCH
// rewrite is produced.
describe('SqlParser FTS bare-column @@ rewrite', () => {
  it('detects bare column on the left of @@', () => {
    const f = detectFTS("SELECT * FROM t WHERE title @@ plainto_tsquery('hello')");
    expect(f.column).toBe('title');
    expect(f.queryText).toBe('hello');
  });

  it('rewrites bare-column @@ plainto_tsquery to MATCH', () => {
    const r = rewriteFTS("SELECT * FROM t WHERE title @@ plainto_tsquery('hello')");
    expect(r).toBe("SELECT * FROM t WHERE title MATCH 'hello'");
  });

  it('rewrites bare-column @@ phraseto_tsquery to MATCH', () => {
    const r = rewriteFTS("SELECT * FROM t WHERE body @@ phraseto_tsquery('big data')");
    expect(r).toBe("SELECT * FROM t WHERE body MATCH 'big data'");
  });

  it('rewrites bare-column @@ to_tsquery to MATCH', () => {
    const r = rewriteFTS("SELECT * FROM t WHERE name @@ to_tsquery('xyz')");
    expect(r).toBe("SELECT * FROM t WHERE name MATCH 'xyz'");
  });

  it('still rewrites to_tsvector(col) @@ form', () => {
    const r = rewriteFTS("SELECT * FROM t WHERE to_tsvector('english', title) @@ plainto_tsquery('hello world')");
    expect(r).toBe("SELECT * FROM t WHERE title MATCH 'hello world'");
  });
});
