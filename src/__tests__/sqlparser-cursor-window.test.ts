import { describe, it, expect } from 'vitest';
import { parseStatement, extractWindowFunctions } from '../query/SqlParser';

describe('SqlParser cursor FETCH/MOVE direction variants', () => {
  it('parses FETCH PRIOR / FIRST / LAST', () => {
    expect((parseStatement('FETCH PRIOR FROM c') as any).direction).toBe('PRIOR');
    expect((parseStatement('FETCH FIRST FROM c') as any).direction).toBe('FIRST');
    expect((parseStatement('FETCH LAST FROM c') as any).direction).toBe('LAST');
  });

  it('parses FETCH RELATIVE 3 FROM cursor (count)', () => {
    const r = parseStatement('FETCH RELATIVE 3 FROM c');
    expect((r as any).direction).toBe('RELATIVE');
    expect((r as any).fetchCount).toBe(3);
  });

  it('parses MOVE ABSOLUTE / RELATIVE with count', () => {
    expect((parseStatement('MOVE ABSOLUTE 10 FROM c') as any).direction).toBe('ABSOLUTE');
    expect((parseStatement('MOVE RELATIVE 2 FROM c') as any).fetchCount).toBe(2);
  });

  it('parses FETCH FROM cursor (default NEXT, count 1)', () => {
    const r = parseStatement('FETCH FROM c');
    expect((r as any).direction).toBe('NEXT');
    expect((r as any).fetchCount).toBe(1);
  });

  it('parses CLOSE cursor', () => {
    expect((parseStatement('CLOSE c') as any).cursorName).toBe('c');
  });
});

describe('SqlParser window fallback regex (ROWS BETWEEN → AST failure)', () => {
  it('falls back to regex and extracts partitionBy/orderBy', () => {
    // pgsql-ast-parser rejects ROWS BETWEEN → extractWindowFunctions catch →
    // fallbackExtractWindowFunctions regex picks up partition/order.
    const wfs = extractWindowFunctions(
      'SELECT SUM(x) OVER (PARTITION BY dept ORDER BY sal DESC) FROM emp',
    );
    expect(wfs.length).toBe(1);
    expect(wfs[0].fn).toBe('SUM');
    expect(wfs[0].partitionBy).toEqual(['dept']);
    expect(wfs[0].orderBy).toEqual([{ key: 'sal', dir: 'DESC' }]);
  });

  it('fallback regex extracts multiple args', () => {
    const wfs = extractWindowFunctions('SELECT COALESCE(x, y) OVER () FROM t');
    expect(wfs.length).toBe(1);
  });
});
