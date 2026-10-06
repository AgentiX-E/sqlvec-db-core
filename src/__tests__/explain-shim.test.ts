import { describe, it, expect } from 'vitest';
import {
  detectExplain,
  rewriteExplain,
  parseDetail,
  parsePlanTree,
  formatPlanTree,
  formatAnalyze,
  runExplainShim,
  type SqliteExplainRow,
  type ExplainTiming,
} from '../query/ExplainShim';

describe('detectExplain', () => {
  it('detects EXPLAIN and EXPLAIN ANALYZE', () => {
    expect(detectExplain('EXPLAIN SELECT * FROM t')).toBe(true);
    expect(detectExplain('EXPLAIN ANALYZE SELECT * FROM t')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectExplain('explain select')).toBe(true);
  });

  it('rejects a bare EXPLAIN-only token prefix without boundary', () => {
    expect(detectExplain('EXPLAINING something')).toBe(false);
  });

  it('rejects non-EXPLAIN input', () => {
    expect(detectExplain('SELECT 1')).toBe(false);
    expect(detectExplain('')).toBe(false);
    expect(detectExplain('   ')).toBe(false);
  });
});

describe('rewriteExplain', () => {
  it('rewrites EXPLAIN', () => {
    const r = rewriteExplain('EXPLAIN SELECT * FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.analyze).toBe(false);
    expect(r.sql).toBe('EXPLAIN QUERY PLAN SELECT * FROM t');
  });

  it('rewrites EXPLAIN ANALYZE', () => {
    const r = rewriteExplain('EXPLAIN ANALYZE SELECT * FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.analyze).toBe(true);
    expect(r.sql).toBe('EXPLAIN QUERY PLAN SELECT * FROM t');
  });

  it('tolerates multiple whitespace between tokens', () => {
    const r = rewriteExplain('EXPLAIN   ANALYZE    SELECT * FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.analyze).toBe(true);
    expect(r.sql).toBe('EXPLAIN QUERY PLAN SELECT * FROM t');
  });

  it('handles lowercase input', () => {
    const r = rewriteExplain('explain analyze select * from t');
    expect(r.rewritten).toBe(true);
    expect(r.analyze).toBe(true);
    expect(r.sql).toBe('EXPLAIN QUERY PLAN select * from t');
  });

  it('passes through a standalone EXPLAIN with no inner SQL', () => {
    const r = rewriteExplain('EXPLAIN');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('EXPLAIN');
  });

  it('passes through a standalone EXPLAIN ANALYZE with no inner SQL', () => {
    const r = rewriteExplain(' EXPLAIN ANALYZE ');
    expect(r.rewritten).toBe(false);
    expect(r.analyze).toBe(true);
  });

  it('passes through non-EXPLAIN input', () => {
    const r = rewriteExplain('SELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });

  it('passes through EXPLAINING (not a real EXPLAIN)', () => {
    const r = rewriteExplain('EXPLAINING something');
    expect(r.rewritten).toBe(false);
  });
});

describe('parseDetail', () => {
  it('parses SCAN and SEARCH', () => {
    expect(parseDetail('SCAN t1')).toEqual({ type: 'SCAN', table: 't1', detail: '' });
    expect(parseDetail('SEARCH t1 USING INDEX idx (name=?)')).toEqual({
      type: 'SEARCH',
      table: 't1',
      detail: 'USING INDEX idx (name=?)',
    });
  });

  it('parses USE TEMP B-TREE / B-TABLE', () => {
    expect(parseDetail('USE TEMP B-TREE FOR ORDER BY')).toEqual({
      type: 'USE TEMP B-TREE',
      table: '',
      detail: 'FOR ORDER BY',
    });
    expect(parseDetail('USE TEMP B-TABLE FOR DISTINCT')).toEqual({
      type: 'USE TEMP B-TABLE',
      table: '',
      detail: 'FOR DISTINCT',
    });
  });

  it('parses LIST SUBQUERY and CO-ROUTINE', () => {
    expect(parseDetail('LIST SUBQUERY 1')).toEqual({ type: 'LIST SUBQUERY', table: '', detail: '1' });
    expect(parseDetail('CO-ROUTINE 2')).toEqual({ type: 'CO-ROUTINE', table: '', detail: '2' });
  });

  it('parses BLOOM FILTER variants', () => {
    expect(parseDetail('BLOOM FILTER ON t')).toEqual({ type: 'BLOOM FILTER', table: 't', detail: '' });
    expect(parseDetail('CREATE BLOOM FILTER')).toEqual({
      type: 'CREATE BLOOM FILTER',
      table: '',
      detail: '',
    });
  });

  it('parses MISC patterns', () => {
    expect(parseDetail('MERGE')).toEqual({ type: 'MERGE', table: '', detail: '' });
    expect(parseDetail('GROUP BY SORT')).toEqual({ type: 'GROUP BY SORT', table: '', detail: '' });
    expect(parseDetail('CORRELATED SCALAR SUBQUERY x')).toEqual({
      type: 'CORRELATED SCALAR SUBQUERY',
      table: '',
      detail: 'x',
    });
  });

  it('falls back to the whole string as type', () => {
    expect(parseDetail('SOMETHING ELSE')).toEqual({ type: 'SOMETHING ELSE', table: '', detail: '' });
  });
});

describe('parsePlanTree', () => {
  it('returns empty for empty input', () => {
    expect(parsePlanTree([])).toEqual([]);
    expect(parsePlanTree(null as unknown as SqliteExplainRow[])).toEqual([]);
  });

  it('builds root nodes for parent === 0', () => {
    const rows: SqliteExplainRow[] = [
      { id: 1, parent: 0, notused: 0, detail: 'SCAN t1' },
      { id: 2, parent: 0, notused: 0, detail: 'SCAN t2' },
    ];
    const trees = parsePlanTree(rows);
    expect(trees).toHaveLength(2);
    expect(trees[0].parentId).toBeNull();
    expect(trees[1].parentId).toBeNull();
  });

  it('attaches children to their parent node', () => {
    const rows: SqliteExplainRow[] = [
      { id: 1, parent: 0, notused: 0, detail: 'SCAN t1' },
      { id: 2, parent: 1, notused: 0, detail: 'SEARCH t1 USING INDEX idx' },
      { id: 3, parent: 1, notused: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
    ];
    const trees = parsePlanTree(rows);
    expect(trees).toHaveLength(1);
    expect(trees[0].children).toHaveLength(2);
    expect(trees[0].children[0].id).toBe(2);
    expect(trees[0].children[0].parentId).toBe(1);
  });

  it('treats orphan nodes (missing parent) as roots', () => {
    const rows: SqliteExplainRow[] = [
      { id: 5, parent: 99, notused: 0, detail: 'SCAN t' },
      { id: 6, parent: 0, notused: 0, detail: 'SCAN u' },
    ];
    const trees = parsePlanTree(rows);
    expect(trees).toHaveLength(2);
    const orphan = trees.find((n) => n.id === 5);
    expect(orphan).toBeDefined();
  });

  it('preserves detail and type from parseDetail', () => {
    const rows: SqliteExplainRow[] = [{ id: 1, parent: 0, notused: 0, detail: 'SEARCH t USING INDEX i' }];
    const trees = parsePlanTree(rows);
    expect(trees[0].type).toBe('SEARCH');
    expect(trees[0].table).toBe('t');
    expect(trees[0].estRows).toBe(0);
    expect(trees[0].estCost).toBe(0);
  });
});

describe('formatPlanTree', () => {
  const tree = () =>
    parsePlanTree([
      { id: 1, parent: 0, notused: 0, detail: 'SCAN t1' },
      { id: 2, parent: 1, notused: 0, detail: 'SEARCH t1 USING INDEX idx (a=?)' },
    ]);

  it('returns empty string / [] for empty input', () => {
    expect(formatPlanTree([], 'text')).toBe('');
    expect(formatPlanTree([], 'json')).toBe('[]');
    expect(formatPlanTree([], 'yaml')).toBe('');
    expect(formatPlanTree(null as unknown as [] , 'text')).toBe('');
  });

  it('renders text', () => {
    const out = formatPlanTree(tree(), 'text');
    expect(out).toContain('SCAN t1');
    expect(out).toContain('SEARCH t1');
  });

  it('renders json', () => {
    const out = formatPlanTree(tree(), 'json');
    expect(out.trim().startsWith('[')).toBe(true);
    expect(out).toContain('"id": 1');
    expect(out).toContain('"type": "SCAN"');
  });

  it('renders yaml', () => {
    const out = formatPlanTree(tree(), 'yaml');
    expect(out).toContain('- id: 1');
    expect(out).toContain('type: SCAN');
  });

  it('renders json for a node with no children', () => {
    const single = parsePlanTree([{ id: 1, parent: 0, notused: 0, detail: 'SCAN t' }]);
    const out = formatPlanTree(single, 'json');
    expect(out).toContain('"children": []');
  });

  it('renders json with multiple roots and multiple children (comma branches)', () => {
    const multi = parsePlanTree([
      { id: 1, parent: 0, notused: 0, detail: 'SCAN t1' },
      { id: 2, parent: 0, notused: 0, detail: 'SCAN t2' },
      { id: 3, parent: 1, notused: 0, detail: 'SCAN t3' },
      { id: 4, parent: 1, notused: 0, detail: 'SCAN t4' },
    ]);
    const out = formatPlanTree(multi, 'json');
    expect(out).toContain('"id": 1');
    expect(out).toContain('"id": 2');
    expect(out).toContain('"id": 3');
    expect(out).toContain('"id": 4');
  });

  it('renders text and yaml for nodes with empty table detail', () => {
    const empty = parsePlanTree([
      { id: 1, parent: 0, notused: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
    ]);
    expect(formatPlanTree(empty, 'text')).toContain('USE TEMP B-TREE');
    expect(formatPlanTree(empty, 'yaml')).toContain('table: null');
  });
});

describe('formatAnalyze', () => {
  it('returns empty for no timings', () => {
    expect(formatAnalyze('EXPLAIN ANALYZE SELECT * FROM t')).toBe('');
    expect(formatAnalyze('EXPLAIN ANALYZE SELECT * FROM t', new Map())).toBe('');
  });

  it('formats timing rows with EXPLAIN ANALYZE context', () => {
    const timings = new Map<number, ExplainTiming>();
    timings.set(1, { rows: 10, time: 1.5 });
    const out = formatAnalyze('EXPLAIN ANALYZE SELECT * FROM t', timings);
    expect(out).toContain('-- EXPLAIN ANALYZE');
    expect(out).toContain('-- Query: SELECT * FROM T');
    expect(out).toContain('Step 1');
    expect(out).toContain('rows=10');
    expect(out).toContain('time=1.500ms');
  });

  it('formats timing with EXPLAIN (non-analyze) context', () => {
    const timings = new Map<number, ExplainTiming>();
    timings.set(1, { rows: 0, time: 0 });
    const out = formatAnalyze('EXPLAIN SELECT * FROM t', timings);
    expect(out).toContain('-- Query: SELECT * FROM T');
  });

  it('omits missing rows/time descriptions', () => {
    const timings = new Map<number, ExplainTiming>();
    timings.set(1, { rows: 5, time: 0 });
    const out = formatAnalyze('EXPLAIN ANALYZE x', timings);
    expect(out).toContain('rows=5');
  });

  it('handles non-EXPLAIN sql (no context) and missing timing fields', () => {
    const timings = new Map<number, ExplainTiming>();
    // Force the `rows !== undefined` / `time !== undefined` guards to take the
    // false branch by injecting a partial timing object.
    timings.set(1, { rows: undefined, time: undefined } as unknown as ExplainTiming);
    const out = formatAnalyze('SELECT 1', timings);
    expect(out).toContain('-- EXPLAIN ANALYZE');
    expect(out).toContain('Step 1');
    // No context line because the SQL does not start with EXPLAIN.
    expect(out).not.toContain('-- Query:');
  });
});

describe('runExplainShim', () => {
  it('returns empty for non-EXPLAIN input without touching db', () => {
    const db = { prepare: () => ({ all: () => [] }) };
    const r = runExplainShim('SELECT 1', db as never);
    expect(r.analyze).toBe(false);
    expect(r.trees).toEqual([]);
    expect(r.json).toBe('[]');
    expect(r.text).toBe('');
  });

  it('runs the full pipeline for EXPLAIN', () => {
    const rows = [{ id: 1, parent: 0, notused: 0, detail: 'SCAN t1' }];
    const db = { prepare: () => ({ all: () => rows }) };
    const r = runExplainShim('EXPLAIN SELECT * FROM t1', db as never);
    expect(r.analyze).toBe(false);
    expect(r.trees).toHaveLength(1);
    expect(r.json).toContain('"id": 1');
    expect(r.text).toContain('SCAN t1');
    expect(r.yaml).toContain('- id: 1');
  });

  it('propagates db execution errors', () => {
    const db = {
      prepare: () => {
        throw new Error('prepare failed');
      },
    };
    expect(() => runExplainShim('EXPLAIN SELECT * FROM t', db as never)).toThrow('prepare failed');
  });
});
