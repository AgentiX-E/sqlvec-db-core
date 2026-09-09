import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Drive collectRefColumns through UPDATE/DELETE WHERE — the AST parser path
// (not fallback) extracts referenced columns via walk of binary/unary/args/
// subquery/columns.

describe('SqlParser collectRefColumns deep walk (UPDATE/DELETE WHERE)', () => {
  it('collects columns from binary expression', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE a = 5 AND b > 3');
    expect((r as any).whereColumns).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('collects column from unary NOT operand', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE NOT flag');
    expect((r as any).whereColumns).toEqual(expect.arrayContaining(['flag']));
  });

  it('collects columns from function call args', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE COALESCE(a, b) IS NULL');
    expect((r as any).whereColumns).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('collects columns from IN subquery', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE id IN (SELECT id FROM other)');
    expect((r as any).whereColumns).toEqual(expect.arrayContaining(['id']));
  });

  it('DELETE collects where columns', () => {
    const r = parseStatement('DELETE FROM t WHERE status = 1 OR type = 2');
    expect((r as any).whereColumns).toEqual(expect.arrayContaining(['status', 'type']));
  });
});

describe('SqlParser collectRefColumns no-where / no-cols', () => {
  it('UPDATE without WHERE → whereColumns undefined', () => {
    const r = parseStatement('UPDATE t SET x = 1');
    expect((r as any).whereColumns).toBeUndefined();
  });
});
