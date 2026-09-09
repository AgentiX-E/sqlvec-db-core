import { describe, it, expect } from 'vitest';
import { extractWindowFunctions } from '../query/SqlParser';

// Cover extractPartitionBy / extractOverOrderBy fallback paths where the
// partition/order expression is not a simple ref (thus p.name / ob.by.name is
// falsy and toSql.expr serialization is used).
describe('SqlParser window partition/order complex expressions', () => {
  it('PARTITION BY binary expression uses toSql.expr fallback', () => {
    const wfs = extractWindowFunctions('SELECT SUM(x) OVER (PARTITION BY a + b) FROM t');
    expect(wfs.length).toBe(1);
    expect(wfs[0].partitionBy).toBeDefined();
    expect(wfs[0].partitionBy![0]).toContain('a');
  });

  it('ORDER BY binary expression in OVER uses toSql.expr fallback', () => {
    const wfs = extractWindowFunctions('SELECT SUM(x) OVER (ORDER BY a + b) FROM t');
    expect(wfs.length).toBe(1);
    expect(wfs[0].orderBy).toBeDefined();
    expect(wfs[0].orderBy![0].key).toContain('a');
  });

  it('PARTITION BY multiple refs + complex ORDER BY', () => {
    const wfs = extractWindowFunctions(
      'SELECT SUM(x) OVER (PARTITION BY a, b ORDER BY a + b) FROM t',
    );
    expect(wfs.length).toBe(1);
    expect(wfs[0].partitionBy).toEqual(['a', 'b']);
    expect(wfs[0].orderBy![0].key).toContain('a');
  });
});
