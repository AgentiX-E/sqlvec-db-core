import { describe, it, expect } from 'vitest';
import { extractWindowFunctions } from '../query/SqlParser';

// Drive fallbackExtractWindowFunctions' falsy branches (no args / no
// partitionBy / no orderBy → undefined fields). MySQL-specific clauses
// (USE INDEX, FOR UPDATE OF) make pgsql-ast-parser throw, routing to the
// regex fallback whose windowPattern still matches `fn() OVER ()`.

describe('SqlParser window fallback falsy fields', () => {
  it('bare OVER () → args/partitionBy/orderBy undefined', () => {
    const wfs = extractWindowFunctions(
      'SELECT ROW_NUMBER() OVER () FROM t USE INDEX (i)',
    );
    expect(wfs.length).toBe(1);
    expect(wfs[0].fn).toBe('ROW_NUMBER');
    expect(wfs[0].partitionBy).toBeUndefined();
    expect(wfs[0].orderBy).toBeUndefined();
  });

  it('window with only ORDER BY → partitionBy undefined', () => {
    const wfs = extractWindowFunctions(
      'SELECT RANK() OVER (ORDER BY x) FROM t LOCK IN SHARE MODE',
    );
    expect(wfs.length).toBe(1);
    expect(wfs[0].orderBy).toEqual([{ key: 'x', dir: 'ASC' }]);
    expect(wfs[0].partitionBy).toBeUndefined();
  });

  it('window with only PARTITION BY → orderBy undefined', () => {
    const wfs = extractWindowFunctions(
      'SELECT SUM(x) OVER (PARTITION BY dept) FROM t FOR UPDATE OF t',
    );
    expect(wfs.length).toBe(1);
    expect(wfs[0].partitionBy).toEqual(['dept']);
    expect(wfs[0].orderBy).toBeUndefined();
  });

  it('no window functions → empty result', () => {
    const wfs = extractWindowFunctions('SELECT x FROM t USE INDEX (i)');
    expect(wfs).toEqual([]);
  });
});
