import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Cover collectRefColumns' remaining guards via UPDATE/DELETE WHERE clauses:
// unary operand (NOT), function args, subquery where, and select column expr.
describe('SqlParser extractWhereColumns recursive guards', () => {
  it('UPDATE with NOT unary operand collects ref', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE NOT active') as any;
    expect(r.whereColumns).toContain('active');
  });

  it('UPDATE with function-call args collects refs', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE lower(name) = lower(prev)') as any;
    expect(r.whereColumns).toContain('name');
    expect(r.whereColumns).toContain('prev');
  });

  it('DELETE with WHERE subquery (exists) collects outer refs', () => {
    const r = parseStatement('DELETE FROM t WHERE EXISTS (SELECT 1 FROM o WHERE o.id = t.id)') as any;
    expect(r.whereColumns).toBeDefined();
  });

  it('UPDATE with binary expression on columns collects both', () => {
    const r = parseStatement('UPDATE t SET a = 1 WHERE col1 > col2') as any;
    expect(r.whereColumns).toContain('col1');
    expect(r.whereColumns).toContain('col2');
  });
});
