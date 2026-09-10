import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// collectRefColumns (used by extractWhereColumns for UPDATE/DELETE routing)
// walked left/right/operand/args/where/columns but skipped a CASE expression's
// whens/else and top-level `value`, so columns referenced inside a WHERE CASE
// were dropped from the shard-routing key. Lock the fix.
describe('SqlParser WHERE CASE column extraction', () => {
  it('collects columns from CASE when/else arms', () => {
    const r = parseStatement(
      'UPDATE t SET x = 1 WHERE id = CASE WHEN a > 0 THEN b ELSE c END',
    ) as any;
    expect([...r.whereColumns].sort()).toEqual(['a', 'b', 'c', 'id']);
  });

  it('collects a column referenced only inside a WHERE CASE condition', () => {
    const r = parseStatement(
      'UPDATE t SET x = 1 WHERE CASE WHEN score > 10 THEN 1 ELSE 0 END = 1',
    ) as any;
    expect(r.whereColumns).toEqual(['score']);
  });

  it('collects the scrutinee of a simple WHERE CASE', () => {
    const r = parseStatement(
      'UPDATE t SET x = 1 WHERE CASE status WHEN 1 THEN 2 ELSE 3 END = 2',
    ) as any;
    expect([...r.whereColumns].sort()).toEqual(['status']);
  });

  it('still collects plain WHERE columns', () => {
    const r = parseStatement('DELETE FROM t WHERE id = 1') as any;
    expect(r.whereColumns).toEqual(['id']);
  });
});
