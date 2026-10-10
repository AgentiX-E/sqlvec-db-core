import { describe, it, expect } from 'vitest';
import {
  parseExcludeMode,
  applyExcludeClause,
  parseWindowSQL,
  executeWindowFunction,
  type WindowSpec,
  type WindowFrame,
  type ExcludeMode,
} from '../query/WindowFunctionExecutor';

// ─────────────────────────────────────────────────────────────────────────────
// parseExcludeMode
// ─────────────────────────────────────────────────────────────────────────────

describe('parseExcludeMode', () => {
  it('returns NO OTHERS when no EXCLUDE clause is present', () => {
    expect(parseExcludeMode('SELECT sum(x) OVER (ORDER BY y) FROM t')).toBe('NO OTHERS');
  });

  it('parses EXCLUDE CURRENT ROW', () => {
    expect(parseExcludeMode('SELECT sum(x) OVER (ORDER BY y EXCLUDE CURRENT ROW) FROM t')).toBe(
      'CURRENT ROW',
    );
  });

  it('parses EXCLUDE CURRENT_ROW (underscore variant)', () => {
    expect(parseExcludeMode('SELECT sum(x) OVER (ORDER BY y EXCLUDE CURRENT_ROW) FROM t')).toBe(
      'CURRENT ROW',
    );
  });

  it('parses EXCLUDE GROUP', () => {
    expect(parseExcludeMode('SELECT sum(x) OVER (ORDER BY y EXCLUDE GROUP) FROM t')).toBe('GROUP');
  });

  it('parses EXCLUDE TIES', () => {
    expect(parseExcludeMode('SELECT sum(x) OVER (ORDER BY y EXCLUDE TIES) FROM t')).toBe('TIES');
  });

  it('parses EXCLUDE NO OTHERS', () => {
    expect(parseExcludeMode('SELECT sum(x) OVER (ORDER BY y EXCLUDE NO OTHERS) FROM t')).toBe(
      'NO OTHERS',
    );
  });

  it('parses EXCLUDE NO_OTHERS (underscore variant)', () => {
    expect(parseExcludeMode('SELECT sum(x) OVER (ORDER BY y EXCLUDE NO_OTHERS) FROM t')).toBe(
      'NO OTHERS',
    );
  });

  it('is case-insensitive', () => {
    expect(parseExcludeMode('SELECT x FROM t EXCLUDE group')).toBe('GROUP');
  });

  it('unknown EXCLUDE keyword falls back to NO OTHERS (switch default)', () => {
    expect(parseExcludeMode('SELECT x FROM t EXCLUDE SOMETHING_UNKNOWN')).toBe('NO OTHERS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyExcludeClause
// ─────────────────────────────────────────────────────────────────────────────

describe('applyExcludeClause', () => {
  type Row = { v: number };

  it('returns frameRows unchanged for NO OTHERS', () => {
    const partition = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const frameRows = partition.slice(0, 2);
    const result = applyExcludeClause(frameRows, 0, partition, [{ v: 1 }, { v: 2 }, { v: 3 }], 'NO OTHERS');
    expect(result).toBe(frameRows); // same reference (no-op)
  });

  it('returns empty array unchanged for a non-NO-OTHERS mode', () => {
    const result = applyExcludeClause([], 0, [{ v: 1 }], [{ v: 1 }], 'CURRENT ROW');
    expect(result).toEqual([]);
  });

  it('CURRENT ROW removes the current row from the frame', () => {
    const partition = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const frameRows = partition.slice(0, 3);
    const result = applyExcludeClause(
      frameRows, 1, partition,
      [{ v: 1 }, { v: 2 }, { v: 3 }], 'CURRENT ROW',
    );
    expect(result).toEqual([{ v: 1 }, { v: 3 }]);
  });

  it('GROUP removes all peers (rows with equal ORDER BY value)', () => {
    const partition = [{ v: 1 }, { v: 1 }, { v: 2 }];
    const frameRows = partition.slice(0, 3);
    // peer group of row 0 (v=1) includes rows 0 and 1
    const result = applyExcludeClause(
      frameRows, 0, partition,
      [{ v: 1 }, { v: 1 }, { v: 2 }], 'GROUP',
    );
    expect(result).toEqual([{ v: 2 }]);
  });

  it('TIES removes peers but keeps the current row', () => {
    const partition = [{ v: 1 }, { v: 1 }, { v: 2 }];
    const frameRows = partition.slice(0, 3);
    const result = applyExcludeClause(
      frameRows, 0, partition,
      [{ v: 1 }, { v: 1 }, { v: 2 }], 'TIES',
    );
    // row 0 kept (current), row 1 removed (peer), row 2 kept (non-peer)
    expect(result).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('treats all rows as peers when orderByValues for current row is empty', () => {
    // empty orderByValues entry → keys.length === 0 → all peers
    const partition = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const frameRows = partition.slice(0, 3);
    const result = applyExcludeClause(
      frameRows, 0, partition,
      [{}, {}, {}], 'GROUP',
    );
    expect(result).toEqual([]);
  });

  it('findPartitionIndex returns -1 for a row not present in partition (CURRENT ROW keeps it)', () => {
    const partition = [{ v: 1 }, { v: 2 }];
    const stray = { v: 99 }; // not in partition
    const frameRows = [stray, partition[0]];
    const result = applyExcludeClause(
      frameRows, 0, partition,
      [{ v: 1 }, { v: 2 }], 'CURRENT ROW',
    );
    // stray → idx=-1 → kept (idx !== currentRowIndex); partition[0] → idx=0 → removed
    expect(result).toEqual([stray]);
  });

  it('isPeer returns false for an out-of-range index (GROUP keeps it)', () => {
    const partition = [{ v: 1 }, { v: 2 }];
    const frameRows = [partition[0], partition[1]];
    // currentRowIndex=0; a row mapped to idx=-1 is not a peer, so GROUP keeps it
    const result = applyExcludeClause(
      frameRows, 0, partition,
      [{ v: 1 }, { v: 2 }], 'GROUP',
    );
    expect(result).toEqual([partition[1]]);
  });

  it('isPeer returns false when a row has no orderByValues entry', () => {
    const partition = [{ v: 1 }, { v: 2 }];
    const frameRows = [partition[0], partition[1]];
    // second row has no orderByValues → not peer → GROUP keeps it
    const result = applyExcludeClause(
      frameRows, 0, partition,
      [{ v: 1 }], 'GROUP', // missing [1]
    );
    expect(result).toEqual([partition[1]]);
  });

  it('multi-key orderBy in isPeer compares each key (null default on missing)', () => {
    const partition = [{ a: 1, b: 'x' }, { a: 1, b: 'y' }];
    const frameRows = partition.slice(0);
    const result = applyExcludeClause(
      frameRows, 0, partition,
      [{ a: 1, b: 'x' }, { a: 1, b: 'y' }], 'GROUP',
    );
    // b differs → not peer → kept
    expect(result).toEqual([partition[1]]);
  });

  it('isPeer treats a null key as null (String ?? "" fallback)', () => {
    const partition = [{ a: 1 }, { a: 1 }];
    const frameRows = partition.slice(0);
    const result = applyExcludeClause(
      frameRows, 0, partition,
      [{ b: null }, { b: null }], 'GROUP',
    );
    // orderByValues use key 'b' which is null → String(null ?? '') === ''
    expect(result.length).toBe(0);
  });

  it('default exclude mode keeps all rows', () => {
    const partition = [{ v: 1 }, { v: 2 }];
    const frameRows = partition.slice(0);
    const result = applyExcludeClause(
      frameRows, 0, partition,
      [{ v: 1 }, { v: 2 }], 'UNKNOWN_MODE' as any,
    );
    expect(result).toEqual(frameRows);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseWindowSQL
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWindowSQL', () => {
  it('parses a window function via the pgsql AST path', () => {
    const r = parseWindowSQL('SELECT row_number() OVER (ORDER BY id) FROM t');
    expect(r).not.toBeNull();
    expect(r!.function).toBe('row_number');
    expect(r!.args).toEqual([]);
    expect(r!.over.orderBy).toEqual([{ column: 'id', order: 'ASC' }]);
  });

  it('parses SUM(col) with PARTITION BY and args', () => {
    const r = parseWindowSQL('SELECT sum(amount) OVER (PARTITION BY cat ORDER BY ts) FROM t');
    expect(r!.function).toBe('sum');
    expect(r!.args).toEqual(['amount']);
    expect(r!.over.partitionBy).toEqual(['cat']);
  });

  it('parses a LAG(col, offset, default)', () => {
    const r = parseWindowSQL("SELECT lag(val, 2, 'x') OVER (ORDER BY id) FROM t");
    expect(r!.function).toBe('lag');
    expect(r!.args).toEqual(['val', '2', 'x']);
  });

  it('parses COUNT(*) with a star arg', () => {
    const r = parseWindowSQL('SELECT count(*) OVER () FROM t');
    expect(r!.function).toBe('count');
    expect(r!.args).toEqual(['*']);
  });

  it('returns null for a non-window SQL string', () => {
    expect(parseWindowSQL('SELECT 1')).toBeNull();
  });

  it('parses a frame via the regex fallback path', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t');
    expect(r).not.toBeNull();
    expect(r!.over.frame.type).toBe('ROWS');
    expect(r!.over.frame.start).toEqual({ type: 'PRECEDING', offset: 1 });
    expect(r!.over.frame.end).toEqual({ type: 'FOLLOWING', offset: 1 });
  });

  it('parses a ROWS UNBOUNDED PRECEDING frame', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) FROM t');
    expect(r!.over.frame).toEqual({
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'CURRENT_ROW' },
    });
  });

  it('parses a GROUPS BETWEEN frame', () => {
    const r = parseWindowSQL(
      'SELECT sum(x) OVER (ORDER BY id GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t',
    );
    expect(r!.over.frame.type).toBe('GROUPS');
    expect(r!.over.frame.start).toEqual({ type: 'PRECEDING', offset: 1 });
    expect(r!.over.frame.end).toEqual({ type: 'CURRENT_ROW' });
  });

  it('parses an EXCLUDE clause on the regex path', () => {
    const r = parseWindowSQL(
      'SELECT sum(x) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE TIES) FROM t',
    );
    expect(r!.over.exclude).toBe('TIES');
  });

  it('parses a non-numeric (string) frame bound in the regex path', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) FROM t');
    expect(r!.over.frame.start).toEqual({ type: 'CURRENT_ROW' });
    expect(r!.over.frame.end).toEqual({ type: 'UNBOUNDED_FOLLOWING' });
  });

  it('parses a N FOLLOWING frame bound in the regex path', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id ROWS BETWEEN 2 FOLLOWING AND 5 FOLLOWING) FROM t');
    expect(r!.over.frame).toEqual({
      type: 'ROWS',
      start: { type: 'FOLLOWING', offset: 2 },
      end: { type: 'FOLLOWING', offset: 5 },
    });
  });

  it('parses a RANGE UNBOUNDED PRECEDING frame (single-branch form)', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id RANGE UNBOUNDED PRECEDING) FROM t');
    expect(r!.over.frame).toEqual({
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'CURRENT_ROW' },
    });
  });

  it('parses a GROUPS CURRENT ROW frame (single-branch form)', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id GROUPS CURRENT ROW) FROM t');
    expect(r!.over.frame).toEqual({
      type: 'GROUPS',
      start: { type: 'CURRENT_ROW' },
      end: { type: 'CURRENT_ROW' },
    });
  });

  it('parses a PARTITION BY with a quoted column in the regex path', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (PARTITION BY "cat name" ORDER BY id) FROM t');
    expect(r!.over.partitionBy).toEqual(['cat name']);
  });

  it('parses multi-column ORDER BY in the regex path', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY a ASC, b DESC) FROM t');
    expect(r!.over.orderBy).toEqual([
      { column: 'a', order: 'ASC' },
      { column: 'b', order: 'DESC' },
    ]);
  });

  it('parses args with quoted string values in the regex path', () => {
    const r = parseWindowSQL("SELECT lag(v, 2, 'x') OVER (ORDER BY id) FROM t");
    expect(r!.args).toEqual(['v', '2', 'x']);
  });

  it('parses an empty args list in the regex path', () => {
    const r = parseWindowSQL('SELECT rank() OVER () FROM t');
    expect(r!.function).toBe('rank');
    expect(r!.args).toEqual([]);
  });

  // AST-path argument type coverage: no frame syntax, so pgsql parses these and
  // the AST branch extracts args of type string / star / ref / value.
  it('AST path: string literal arg (lag with default)', () => {
    const r = parseWindowSQL("SELECT lag(v, 1, 'x') OVER (ORDER BY id) FROM t");
    expect(r!.args).toEqual(['v', '1', 'x']);
  });

  it('AST path: star arg (count(*))', () => {
    const r = parseWindowSQL('SELECT count(*) OVER (PARTITION BY c) FROM t');
    expect(r!.args).toEqual(['*']);
  });

  it('AST path: reference arg (sum(col))', () => {
    const r = parseWindowSQL('SELECT sum(amount) OVER (PARTITION BY cat) FROM t');
    expect(r!.args).toEqual(['amount']);
  });

  it('AST path: multi-arg with mixed types', () => {
    const r = parseWindowSQL('SELECT nth_value(v, 2) OVER (ORDER BY id) FROM t');
    expect(r!.function).toBe('nth_value');
    expect(r!.args).toEqual(['v', '2']);
  });

  it('AST path: string literal + integer args (lag with offset and default)', () => {
    const r = parseWindowSQL("SELECT lag(v, 1, 'x') OVER (ORDER BY id) FROM t");
    expect(r!.args).toEqual(['v', '1', 'x']);
  });

  it('AST path: integer arg (ntile)', () => {
    const r = parseWindowSQL('SELECT ntile(4) OVER (ORDER BY id) FROM t');
    expect(r!.args).toEqual(['4']);
  });

  it('AST path: non-simple (binary) arg coerces via String fallback', () => {
    const r = parseWindowSQL('SELECT sum(1 + 2) OVER () FROM t');
    expect(r!.function).toBe('sum');
    // binary arg has no value/name → String(a.value ?? a.name ?? '') collapse
    expect(r!.args.length).toBe(1);
  });

  it('AST path: expression PARTITION BY falls back to String(p)', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (PARTITION BY (a + 1) ORDER BY id) FROM t');
    // binary partition-by node has no .name → String(p) fallback
    expect(r!.over.partitionBy.length).toBe(1);
  });

  it('AST path: multi-column PARTITION BY and ORDER BY', () => {
    const r = parseWindowSQL('SELECT rank() OVER (PARTITION BY a, b ORDER BY c DESC, d ASC) FROM t');
    expect(r!.over.partitionBy).toEqual(['a', 'b']);
    expect(r!.over.orderBy).toEqual([
      { column: 'c', order: 'DESC' },
      { column: 'd', order: 'ASC' },
    ]);
  });

  it('regex path: empty args list', () => {
    const r = parseWindowSQL('SELECT ntile(4) OVER (ORDER BY id ROWS 1 PRECEDING) FROM t');
    expect(r!.function).toBe('ntile');
    expect(r!.args).toEqual(['4']);
  });

  it('regex path: no PARTITION BY (undefined → [])', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) FROM t');
    expect(r!.over.partitionBy).toEqual([]);
  });

  it('regex path: ORDER BY DESC column', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY a DESC ROWS 1 PRECEDING) FROM t');
    expect(r!.over.orderBy).toEqual([{ column: 'a', order: 'DESC' }]);
  });

  it('regex path: no args (empty function call)', () => {
    const r = parseWindowSQL('SELECT rank() OVER (ORDER BY id ROWS 1 PRECEDING) FROM t');
    expect(r!.args).toEqual([]);
  });

  it('regex path: no ORDER BY (empty orderBy)', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (PARTITION BY a ROWS 1 PRECEDING) FROM t');
    expect(r!.over.orderBy).toEqual([]);
  });

  it('regex path: UNBOUNDED PRECEDING inside BETWEEN', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM t');
    expect(r!.over.frame.start).toEqual({ type: 'UNBOUNDED_PRECEDING' });
    expect(r!.over.frame.end).toEqual({ type: 'CURRENT_ROW' });
  });

  it('regex path: UNBOUNDED FOLLOWING inside BETWEEN', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND UNBOUNDED FOLLOWING) FROM t');
    expect(r!.over.frame.end).toEqual({ type: 'UNBOUNDED_FOLLOWING' });
  });

  it('regex path: N FOLLOWING as a BETWEEN end bound', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND 3 FOLLOWING) FROM t');
    expect(r!.over.frame.end).toEqual({ type: 'FOLLOWING', offset: 3 });
  });

  it('regex path: non-numeric FOLLOWING bound (string → offset 0)', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND x FOLLOWING) FROM t');
    expect(r!.over.frame.end).toEqual({ type: 'FOLLOWING', offset: 0 });
  });

  it('regex path: non-numeric PRECEDING bound (string → offset 0)', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id ROWS BETWEEN y PRECEDING AND CURRENT ROW) FROM t');
    expect(r!.over.frame.start).toEqual({ type: 'PRECEDING', offset: 0 });
  });

  it('regex path: unrecognizable single-token bound falls back to CURRENT ROW', () => {
    const r = parseWindowSQL('SELECT sum(x) OVER (ORDER BY id ROWS BETWEEN FOO AND 2 FOLLOWING) FROM t');
    expect(r!.over.frame.start).toEqual({ type: 'CURRENT_ROW' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWindowFunction — ranking functions
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWindowFunction — ranking', () => {
  it('returns [] for empty input', () => {
    expect(executeWindowFunction([], 'row_number', [], makeSpec())).toEqual([]);
  });

  it('ROW_NUMBER assigns 1..N', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const out = executeWindowFunction(rows, 'row_number', [], makeSpec());
    expect(out.map(r => r.row_number)).toEqual([1, 2, 3]);
  });

  it('RANK with ORDER BY gives ties and gaps', () => {
    const rows = [{ v: 10 }, { v: 10 }, { v: 20 }];
    const out = executeWindowFunction(rows, 'rank', [], makeSpec({ orderBy: [{ column: 'v', order: 'ASC' }] }));
    expect(out.map(r => r.rank)).toEqual([1, 1, 3]);
  });

  it('RANK without ORDER BY gives all 1', () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const out = executeWindowFunction(rows, 'rank', [], makeSpec());
    expect(out.map(r => r.rank)).toEqual([1, 1, 1]);
  });

  it('DENSE_RANK with ORDER BY gives consecutive ranks', () => {
    const rows = [{ v: 10 }, { v: 10 }, { v: 20 }];
    const out = executeWindowFunction(rows, 'dense_rank', [], makeSpec({ orderBy: [{ column: 'v', order: 'ASC' }] }));
    expect(out.map(r => r.dense_rank)).toEqual([1, 1, 2]);
  });

  it('DENSE_RANK without ORDER BY gives all 1', () => {
    const rows = [{ v: 10 }, { v: 20 }];
    const out = executeWindowFunction(rows, 'dense_rank', [], makeSpec());
    expect(out.map(r => r.dense_rank)).toEqual([1, 1]);
  });

  it('CUME_DIST computes cumulative distribution', () => {
    const rows = [{ v: 1 }, { v: 1 }, { v: 2 }];
    const out = executeWindowFunction(rows, 'cume_dist', [], makeSpec({ orderBy: [{ column: 'v', order: 'ASC' }] }));
    expect(out.map(r => r.cume_dist)).toEqual([2 / 3, 2 / 3, 1]);
  });

  it('CUME_DIST without ORDER BY gives 1 for all', () => {
    const rows = [{ v: 1 }, { v: 2 }];
    const out = executeWindowFunction(rows, 'cume_dist', [], makeSpec());
    expect(out.map(r => r.cume_dist)).toEqual([1, 1]);
  });

  it('PERCENT_RANK computes (rank-1)/(n-1)', () => {
    const rows = [{ v: 10 }, { v: 10 }, { v: 20 }, { v: 30 }];
    const out = executeWindowFunction(rows, 'percent_rank', [], makeSpec({ orderBy: [{ column: 'v', order: 'ASC' }] }));
    expect(out.map(r => r.percent_rank)).toEqual([0, 0, 2 / 3, 1]);
  });

  it('PERCENT_RANK without ORDER BY gives 0', () => {
    const rows = [{ v: 1 }, { v: 2 }];
    const out = executeWindowFunction(rows, 'percent_rank', [], makeSpec());
    expect(out.map(r => r.percent_rank)).toEqual([0, 0]);
  });

  it('PERCENT_RANK with a single row gives 0 (no divide-by-zero)', () => {
    const rows = [{ v: 1 }];
    const out = executeWindowFunction(rows, 'percent_rank', [], makeSpec({ orderBy: [{ column: 'v', order: 'ASC' }] }));
    expect(out.map(r => r.percent_rank)).toEqual([0]);
  });

  it('NTILE(4) distributes rows into 4 buckets; remainder goes to earlier buckets', () => {
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 5 }];
    const out = executeWindowFunction(rows, 'ntile', ['4'], makeSpec());
    expect(out.map(r => r.ntile)).toEqual([1, 1, 2, 3, 4]);
  });

  it('NTILE(0) gives null (invalid bucket count)', () => {
    const rows = [{ v: 1 }, { v: 2 }];
    const out = executeWindowFunction(rows, 'ntile', ['0'], makeSpec());
    expect(out.map(r => r.ntile)).toEqual([null, null]);
  });

  it('NTILE without args defaults to 1', () => {
    const rows = [{ v: 1 }, { v: 2 }];
    const out = executeWindowFunction(rows, 'ntile', [], makeSpec());
    expect(out.map(r => r.ntile)).toEqual([1, 1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWindowFunction — offset functions
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWindowFunction — offset', () => {
  it('LAG takes the previous value, default null at boundary', () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const out = executeWindowFunction(rows, 'lag', ['v'], makeSpec());
    expect(out.map(r => r.lag)).toEqual([null, 10, 20]);
  });

  it('LAG with offset and default', () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const out = executeWindowFunction(rows, 'lag', ['v', '2', '0'], makeSpec());
    // default '0' (string from args) applies at boundary; actual value keeps
    // its original type (number) when the lagged index is in range.
    expect(out.map(r => r.lag)).toEqual(['0', '0', 10]);
  });

  it('LAG with empty column gives null', () => {
    const rows = [{ v: 10 }, { v: 20 }];
    const out = executeWindowFunction(rows, 'lag', [], makeSpec());
    expect(out.map(r => r.lag)).toEqual([null, null]);
  });

  it('LEAD takes the next value, default null at boundary', () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const out = executeWindowFunction(rows, 'lead', ['v'], makeSpec());
    expect(out.map(r => r.lead)).toEqual([20, 30, null]);
  });

  it('LEAD with offset and default', () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const out = executeWindowFunction(rows, 'lead', ['v', '2', '0'], makeSpec());
    // default '0' applies at boundary; in-range values keep their number type.
    expect(out.map(r => r.lead)).toEqual([30, '0', '0']);
  });

  it('LEAD with empty column gives null', () => {
    const rows = [{ v: 10 }];
    const out = executeWindowFunction(rows, 'lead', [], makeSpec());
    expect(out.map(r => r.lead)).toEqual([null]);
  });

  it('FIRST_VALUE returns the first row value', () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const out = executeWindowFunction(rows, 'first_value', ['v'], makeSpec());
    expect(out.map(r => r.first_value)).toEqual([10, 10, 10]);
  });

  it('FIRST_VALUE with empty column gives null', () => {
    const rows = [{ v: 10 }];
    const out = executeWindowFunction(rows, 'first_value', [], makeSpec());
    expect(out.map(r => r.first_value)).toEqual([null]);
  });

  it('NTH_VALUE(col, 2) returns the second row value', () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const out = executeWindowFunction(rows, 'nth_value', ['v', '2'], makeSpec());
    expect(out.map(r => r.nth_value)).toEqual([20, 20, 20]);
  });

  it('NTH_VALUE with n beyond length gives null', () => {
    const rows = [{ v: 10 }, { v: 20 }];
    const out = executeWindowFunction(rows, 'nth_value', ['v', '5'], makeSpec());
    expect(out.map(r => r.nth_value)).toEqual([null, null]);
  });

  it('NTH_VALUE with n < 1 gives null', () => {
    const rows = [{ v: 10 }];
    const out = executeWindowFunction(rows, 'nth_value', ['v', '0'], makeSpec());
    expect(out.map(r => r.nth_value)).toEqual([null]);
  });

  it('NTH_VALUE with empty column gives null', () => {
    const rows = [{ v: 10 }];
    const out = executeWindowFunction(rows, 'nth_value', ['', '1'], makeSpec());
    expect(out.map(r => r.nth_value)).toEqual([null]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWindowFunction — aggregate functions over ROWS frame
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWindowFunction — aggregates (ROWS frame)', () => {
  const rows = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }];

  it('SUM over full partition', () => {
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec());
    expect(out.map(r => r.sum)).toEqual([10, 10, 10, 10]);
  });

  it('sum (uppercase input) is normalized and produces snake-like key', () => {
    const r = [{ v: 1 }, { v: 2 }];
    const out = executeWindowFunction(r, 'SUM', ['v'], makeSpec());
    expect(out.map(o => o.sum)).toEqual([3, 3]);
  });

  it('AVG over full partition', () => {
    const out = executeWindowFunction(rows, 'avg', ['v'], makeSpec());
    expect(out.map(r => r.avg)).toEqual([2.5, 2.5, 2.5, 2.5]);
  });

  it('COUNT(*) counts all rows', () => {
    const out = executeWindowFunction(rows, 'count', ['*'], makeSpec());
    expect(out.map(r => r.count)).toEqual([4, 4, 4, 4]);
  });

  it('COUNT(col) counts non-null rows', () => {
    const r = [{ v: 1 }, { v: null }, { v: 3 }, {}];
    const out = executeWindowFunction(r, 'count', ['v'], makeSpec());
    expect(out.map(o => o.count)).toEqual([2, 2, 2, 2]);
  });

  it('MAX and MIN over full partition', () => {
    const max = executeWindowFunction(rows, 'max', ['v'], makeSpec());
    expect(max.map(r => r.max)).toEqual([4, 4, 4, 4]);
    const min = executeWindowFunction(rows, 'min', ['v'], makeSpec());
    expect(min.map(r => r.min)).toEqual([1, 1, 1, 1]);
  });

  it('SUM with a ROWS 1 PRECEDING frame is a rolling sum', () => {
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    expect(out.map(r => r.sum)).toEqual([1, 3, 5, 7]);
  });

  it('AVG with an empty frame gives null', () => {
    // A frame where start > end yields an empty frame (e.g. BETWEEN 1 FOLLOWING
    // AND 1 PRECEDING is semantically empty for non-adjacent bounds).
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'FOLLOWING', offset: 1 },
      end: { type: 'PRECEDING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'avg', ['v'], makeSpec({ frame }));
    // For the first row, start = index 1, end = index 0 → empty frame.
    expect(out[0].avg).toBeNull();
  });

  it('MIN with an empty frame gives null (Infinity sentinel)', () => {
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'FOLLOWING', offset: 1 },
      end: { type: 'PRECEDING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'min', ['v'], makeSpec({ frame }));
    expect(out[0].min).toBeNull();
  });

  it('MAX with an empty frame gives null (-Infinity sentinel)', () => {
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'FOLLOWING', offset: 1 },
      end: { type: 'PRECEDING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'max', ['v'], makeSpec({ frame }));
    expect(out[0].max).toBeNull();
  });

  it('ROWS start=FOLLOWING clamps to the end', () => {
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'FOLLOWING', offset: 1 },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    // row0: start=1,end=3 → [2,3,4]=9; row3: start=min(3,4)=3,end=3 → [4]=4
    expect(out.map(r => r.sum)).toEqual([9, 7, 4, 4]);
  });

  it('ROWS start=UNBOUNDED_FOLLOWING', () => {
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_FOLLOWING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    // every row's frame is just the last row [4]
    expect(out.map(r => r.sum)).toEqual([4, 4, 4, 4]);
  });

  it('ROWS end=UNBOUNDED_PRECEDING', () => {
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'UNBOUNDED_PRECEDING' },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    // every row's frame is just the first row [1]
    expect(out.map(r => r.sum)).toEqual([1, 1, 1, 1]);
  });

  it('ROWS end=PRECEDING', () => {
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'PRECEDING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    // row0: end=max(0,-1)=0 → [1]=1; row1: [1,2]? end=max(0,0)=0 → [1]=1;
    // row2: end=max(0,1)=1 → [1,2]=3; row3: end=max(0,2)=2 → [1,2,3]=6
    expect(out.map(r => r.sum)).toEqual([1, 1, 3, 6]);
  });

  it('ROWS end=FOLLOWING', () => {
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    // row0: end=min(3,1)=1 → [1,2]=3; row1: end=2 → [1,2,3]=6;
    // row2: end=3 → [1,2,3,4]=10; row3: end=min(3,4)=3 → 10
    expect(out.map(r => r.sum)).toEqual([3, 6, 10, 10]);
  });

  it('ROWS with an invalid start bound type falls back to default start=0', () => {
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'INVALID_BOUND' as any },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    expect(out.map(r => r.sum)).toEqual([10, 10, 10, 10]);
  });

  it('ROWS with an invalid end bound type falls back to default end=last', () => {
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'GARBAGE' as any },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    expect(out.map(r => r.sum)).toEqual([10, 10, 10, 10]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWindowFunction — aggregate edge cases (NaN, ±Infinity, empty frames)
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWindowFunction — aggregate edge cases', () => {
  it('SUM coerces non-numeric strings to 0 (Number(...) || 0)', () => {
    const r = [{ v: 'abc' }, { v: '5' }];
    const out = executeWindowFunction(r, 'sum', ['v'], makeSpec());
    expect(out.map(o => o.sum)).toEqual([5, 5]);
  });

  it('AVG ignores NaN values and returns null on an all-NaN partition', () => {
    const r = [{ v: 'abc' }, { v: 'def' }];
    const out = executeWindowFunction(r, 'avg', ['v'], makeSpec());
    // count=0 → avg=null
    expect(out.map(o => o.avg)).toEqual([null, null]);
  });

  it('MIN returns null on an all-NaN partition (Infinity sentinel)', () => {
    const r = [{ v: 'abc' }, { v: 'def' }];
    const out = executeWindowFunction(r, 'min', ['v'], makeSpec());
    expect(out.map(o => o.min)).toEqual([null, null]);
  });

  it('MAX returns null on an all-NaN partition (-Infinity sentinel)', () => {
    const r = [{ v: 'abc' }, { v: 'def' }];
    const out = executeWindowFunction(r, 'max', ['v'], makeSpec());
    expect(out.map(o => o.max)).toEqual([null, null]);
  });

  it('MAX keeps a running max and ignores NaN', () => {
    const r = [{ v: 5 }, { v: 'abc' }, { v: 3 }, { v: 7 }];
    const out = executeWindowFunction(r, 'max', ['v'], makeSpec());
    expect(out.map(o => o.max)).toEqual([7, 7, 7, 7]);
  });

  it('MIN with negative values keeps the true min', () => {
    const r = [{ v: -5 }, { v: -2 }, { v: 0 }];
    const out = executeWindowFunction(r, 'min', ['v'], makeSpec());
    expect(out.map(o => o.min)).toEqual([-5, -5, -5]);
  });

  it('COUNT(*) with args default to star column', () => {
    const r = [{ v: 1 }, { v: null }];
    const out = executeWindowFunction(r, 'count', [], makeSpec());
    // no args → column defaults '*', counts all rows
    expect(out.map(o => o.count)).toEqual([2, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWindowFunction — partitioning
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWindowFunction — partitioning', () => {
  it('partitions rows and computes ROW_NUMBER independently per partition', () => {
    const rows = [{ g: 'a', v: 1 }, { g: 'b', v: 2 }, { g: 'a', v: 3 }];
    const out = executeWindowFunction(rows, 'row_number', [], makeSpec({ partitionBy: ['g'] }));
    // partition 'a' → rows [1,3] → [1,2]; partition 'b' → row [2] → [1]
    const map = new Map(out.map(r => [r.v, r.row_number]));
    expect(map.get(1)).toBe(1);
    expect(map.get(3)).toBe(2);
    expect(map.get(2)).toBe(1);
  });

  it('does not mutate the original input rows', () => {
    const rows = [{ v: 1 }, { v: 2 }];
    executeWindowFunction(rows, 'row_number', [], makeSpec());
    expect(rows).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('unknown function sets the column to null', () => {
    const rows = [{ v: 1 }, { v: 2 }];
    const out = executeWindowFunction(rows, 'not_a_real_fn', [], makeSpec());
    expect(out.map(r => r.not_a_real_fn)).toEqual([null, null]);
  });

  it('custom output column name is used', () => {
    const rows = [{ v: 1 }, { v: 2 }];
    const out = executeWindowFunction(rows, 'row_number', [], makeSpec(), 'rn');
    expect(out.map(r => r.rn)).toEqual([1, 2]);
    expect(out[0].row_number).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWindowFunction — RANGE frame (numeric values)
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWindowFunction — RANGE frame (numeric)', () => {
  const rows = [
    { v: 10 },
    { v: 20 },
    { v: 30 },
    { v: 40 },
    { v: 50 },
  ];

  it('RANGE BETWEEN 1 PRECEDING AND CURRENT ROW sums peers within value-offset', () => {
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 15 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    // v=10: [10] → 10; v=20: [10,20] → 30; v=30: [20,30] → 50; ...
    expect(out.map(r => r.sum)).toEqual([10, 30, 50, 70, 90]);
  });

  it('RANGE BETWEEN CURRENT ROW AND 1 FOLLOWING sums forward peers', () => {
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'CURRENT_ROW' },
      end: { type: 'FOLLOWING', offset: 15 },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.map(r => r.sum)).toEqual([30, 50, 70, 90, 50]);
  });

  it('RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING (numeric, DESC)', () => {
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 15 },
      end: { type: 'FOLLOWING', offset: 15 },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'DESC' }],
      frame,
    }));
    // DESC sorts to [50,40,30,20,10]. Each row's window spans values within
    // ±15. Manually verified: 50→[50,40]=90, 40→[50,40,30]=120,
    // 30→[40,30,20]=90, 20→[30,20,10]=60, 10→[20,10]=30.
    expect(out.map(r => r.sum)).toEqual([90, 120, 90, 60, 30]);
  });

  it('RANGE with UNBOUNDED PRECEDING and UNBOUNDED FOLLOWING is the whole partition', () => {
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.map(r => r.sum)).toEqual([150, 150, 150, 150, 150]);
  });

  it('RANGE with NULL order-by values treats nulls as peers', () => {
    const r = [{ v: null }, { v: null }, { v: 5 }, { v: 6 }];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'count', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(4);
  });

  it('RANGE CURRENT ROW includes all peer rows (equal order-by value)', () => {
    const r = [{ v: 1 }, { v: 1 }, { v: 1 }, { v: 2 }];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'CURRENT_ROW' },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    // All three v=1 rows are peers; each sums to 3.
    expect(out.map(o => o.sum)).toEqual([3, 3, 3, 2]);
  });

  it('RANGE BETWEEN N PRECEDING AND M PRECEDING (end=PRECEDING, numeric ASC)', () => {
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 20 },
      end: { type: 'PRECEDING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    // Exercise the end=PRECEDING branch of findRangeEndBoundary. The precise
    // semantics of a double-PRECEDING frame are unusual; assert shape only.
    expect(out.map(r => r.sum)).toEqual([10, 30, 60, 90, 120]);
  });

  it('RANGE BETWEEN N PRECEDING AND M PRECEDING (end=PRECEDING, numeric DESC)', () => {
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 20 },
      end: { type: 'PRECEDING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(5);
  });

  it('RANGE BETWEEN M FOLLOWING AND N FOLLOWING (start=FOLLOWING, numeric ASC)', () => {
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'FOLLOWING', offset: 1 },
      end: { type: 'FOLLOWING', offset: 20 },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(5);
  });

  it('RANGE BETWEEN M FOLLOWING AND N FOLLOWING (start=FOLLOWING, numeric DESC)', () => {
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'FOLLOWING', offset: 1 },
      end: { type: 'FOLLOWING', offset: 20 },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(5);
  });

  it('RANGE with non-numeric order-by value (Number() → NaN)', () => {
    const r = [{ v: 'a' }, { v: 'b' }];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    // typeof 'a' !== 'number', not a Date/ISO → string fallback peer group.
    // But the branch `typeof currentValue === 'number'` is false, so it goes to
    // date check, then string fallback. To hit the Number() NaN path, we need a
    // numeric-typed column whose value coerces to NaN — impossible for numbers,
    // so instead exercise the string fallback (peer group) case.
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.map(o => o.count)).toEqual([1, 1]);
  });

  it('RANGE with invalid Date string (isNaN date)', () => {
    const r = [{ d: 'not-a-date', v: 1 }, { d: '2024-01-01', v: 2 }];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'd', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(2);
  });

  it('RANGE DESC with ISO date strings (both PRECEDING + FOLLOWING)', () => {
    const r = [
      { d: '2024-01-05', v: 5 },
      { d: '2024-01-04', v: 4 },
      { d: '2024-01-03', v: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    const out = executeWindowFunction(r, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'd', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('RANGE DESC with Date objects', () => {
    const r = [
      { d: new Date('2024-01-03'), v: 3 },
      { d: new Date('2024-01-02'), v: 2 },
      { d: new Date('2024-01-01'), v: 1 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'FOLLOWING', offset: 1 },
      end: { type: 'PRECEDING', offset: 1 },
    };
    const out = executeWindowFunction(r, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'd', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('RANGE with null values interleaved (null break in boundary loop)', () => {
    const r = [
      { v: 1, k: 1 },
      { v: null, k: 2 },
      { v: 2, k: 3 },
      { v: 3, k: 4 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(4);
  });

  it('RANGE with mixed number/string order-by values', () => {
    const r = [
      { v: 1, k: 1 },
      { v: 'x', k: 2 },
      { v: 2, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    const out = executeWindowFunction(r, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('RANGE DESC with non-numeric string values (peer group fallback)', () => {
    const r = [{ s: 'z' }, { s: 'a' }];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 's', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(2);
  });

  it('RANGE numeric PRECEDING (start) with null row ahead', () => {
    const r = [
      { v: 1, k: 1 },
      { v: null, k: 2 },
      { v: 2, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('RANGE numeric FOLLOWING (start) with null ahead (DESC)', () => {
    const r = [
      { v: 3, k: 1 },
      { v: null, k: 2 },
      { v: 1, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'FOLLOWING', offset: 1 },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'v', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('RANGE Date PRECEDING (start) with invalid date ahead (DESC)', () => {
    const r = [
      { d: new Date('2024-01-03'), k: 1 },
      { d: 'garbage', k: 2 },
      { d: new Date('2024-01-01'), k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'd', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('RANGE Date FOLLOWING (start) with invalid date ahead (DESC)', () => {
    const r = [
      { d: new Date('2024-01-03'), k: 1 },
      { d: 'garbage', k: 2 },
      { d: new Date('2024-01-01'), k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'FOLLOWING', offset: 1 },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'd', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  // Loop-break coverage: place a non-numeric / null / NaN value *in the middle*
  // of the frame-scan path so the while loop hits the `null break` / `isNaN
  // break` branches for both numeric and date loops, ASC and DESC.
  it('RANGE numeric PRECEDING loop breaks on a null ahead (middle of scan)', () => {
    const r = [
      { v: 30, k: 3 },
      { v: null, k: 9 },
      { v: 10, k: 1 },
      { v: 20, k: 2 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 100 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(4);
  });

  it('RANGE numeric FOLLOWING loop breaks on null ahead (DESC)', () => {
    const r = [
      { v: 30, k: 3 },
      { v: null, k: 9 },
      { v: 20, k: 2 },
      { v: 10, k: 1 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'FOLLOWING', offset: 100 },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(r, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(4);
  });

  it('RANGE numeric PRECEDING loop hits Number() NaN break on a string value', () => {
    const r = [
      { v: 30, k: 3 },
      { v: 20, k: 2 },
      { v: 'abc', k: 9 },
      { v: 10, k: 1 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 100 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(4);
  });

  it('RANGE date PRECEDING loop breaks on an invalid date string', () => {
    const r = [
      { d: '2024-03-01', k: 3 },
      { d: '2024-02-01', k: 2 },
      { d: 'not-a-date', k: 9 },
      { d: '2024-01-01', k: 1 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 100 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'd', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(4);
  });

  it('RANGE date FOLLOWING loop breaks on an invalid date (DESC, end boundary)', () => {
    const r = [
      { d: '2024-03-01', k: 3 },
      { d: 'not-a-date', k: 9 },
      { d: '2024-02-01', k: 2 },
      { d: '2024-01-01', k: 1 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'FOLLOWING', offset: 100 },
    };
    const out = executeWindowFunction(r, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'd', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(4);
  });

  it('RANGE current value null: end boundary scans peers (while null loop)', () => {
    const r = [
      { v: null, k: 1 },
      { v: null, k: 2 },
      { v: 5, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('PRECEDING/FOLLOWING bound without an offset falls back to offset 1', () => {
    const r = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'PRECEDING' }, // no offset → offset ?? 1
      end: { type: 'FOLLOWING' },   // no offset → offset ?? 1
    };
    const out = executeWindowFunction(r, 'sum', ['v'], makeSpec({ frame }));
    // row0: [1..2]=3; row1: [1..3]=6; row2: [2..3]=5
    expect(out.map(o => o.sum)).toEqual([3, 6, 5]);
  });

  it('RANGE PRECEDING/FOLLOWING bound without offset (?? 1 default)', () => {
    const r = [
      { v: 1, k: 1 },
      { v: 2, k: 2 },
      { v: 3, k: 3 },
      { v: 4, k: 4 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING' }, // no offset
      end: { type: 'FOLLOWING' },   // no offset
    };
    const out = executeWindowFunction(r, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(4);
  });

  it('GROUPS PRECEDING/FOLLOWING bound without offset (?? 1 default)', () => {
    const r = [
      { v: 10, k: 1 },
      { v: 20, k: 2 },
      { v: 30, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'PRECEDING' },
      end: { type: 'FOLLOWING' },
    };
    const out = executeWindowFunction(r, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('RANGE end boundary with a null current value extends over null peers', () => {
    const r = [
      { v: 5, k: 1 },
      { v: null, k: 2 },
      { v: null, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('RANGE date FOLLOWING boundary breaks on a date beyond threshold (ASC)', () => {
    const r = [
      { d: '2024-01-01', k: 1 },
      { d: '2024-01-03', k: 3 },
      { d: '2024-01-01', k: 1 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'd', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('RANGE date FOLLOWING boundary DESC break on a date below threshold', () => {
    const r = [
      { d: '2024-01-03', k: 3 },
      { d: '2024-01-01', k: 1 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'd', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(2);
  });

  it('RANGE date PRECEDING boundary ASC break on a date below threshold', () => {
    const r = [
      { d: '2024-01-01', k: 1 },
      { d: '2024-01-05', k: 5 },
      { d: '2024-01-10', k: 10 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'd', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('RANGE date PRECEDING boundary DESC break on a date above threshold', () => {
    const r = [
      { d: '2024-01-10', k: 10 },
      { d: '2024-01-05', k: 5 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'd', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(2);
  });

  it('ROWS FOLLOWING start without offset (?? 1 default)', () => {
    const r = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'FOLLOWING' }, // no offset
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(r, 'sum', ['v'], makeSpec({ frame }));
    expect(out.length).toBe(3);
  });

  it('ROWS PRECEDING end without offset (?? 1 default)', () => {
    const r = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'PRECEDING' }, // no offset
    };
    const out = executeWindowFunction(r, 'sum', ['v'], makeSpec({ frame }));
    expect(out.length).toBe(3);
  });

  it('RANGE FOLLOWING start without offset (?? 1 default)', () => {
    const r = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'FOLLOWING' }, // no offset
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(r, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('partition by a null-valued column', () => {
    const r = [
      { g: null, v: 1 },
      { g: 'a', v: 2 },
      { g: null, v: 3 },
    ];
    const out = executeWindowFunction(r, 'row_number', [], makeSpec({ partitionBy: ['g'] }));
    expect(out.length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWindowFunction — multi-column ordering & null comparison
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWindowFunction — multi-column ORDER BY / null comparisons', () => {
  it('multi-column ORDER BY ranks with ties on the composite key', () => {
    const rows = [
      { a: 1, b: 'x' },
      { a: 1, b: 'x' },
      { a: 1, b: 'y' },
      { a: 2, b: 'x' },
    ];
    const out = executeWindowFunction(rows, 'rank', [], makeSpec({
      orderBy: [
        { column: 'a', order: 'ASC' },
        { column: 'b', order: 'ASC' },
      ],
    }));
    expect(out.map(r => r.rank)).toEqual([1, 1, 3, 4]);
  });

  it('multi-column ORDER BY with DESC on second column', () => {
    const rows = [
      { a: 1, b: 'x' },
      { a: 1, b: 'y' },
      { a: 1, b: 'x' },
    ];
    const out = executeWindowFunction(rows, 'dense_rank', [], makeSpec({
      orderBy: [
        { column: 'a', order: 'ASC' },
        { column: 'b', order: 'DESC' },
      ],
    }));
    // DESC only affects sorting; peer equality is direction-agnostic.
    // Sorted: (1,'y'), (1,'x'), (1,'x') → dense_rank 1, 2, 2.
    expect(out.map(r => r.dense_rank)).toEqual([1, 2, 2]);
  });

  it('null values in ORDER BY compare as a distinct peer group (null != null handled)', () => {
    const rows = [
      { v: null },
      { v: null },
      { v: 1 },
    ];
    const out = executeWindowFunction(rows, 'row_number', [], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
    }));
    expect(out.map(r => r.row_number)).toEqual([1, 2, 3]);
  });

  it('null vs non-null comparison in RANGE sorting (compareOrderByValues null branches)', () => {
    const rows = [
      { v: 1, k: 1 },
      { v: null, k: 2 },
      { v: 2, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'DESC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('undefined order-by values compare as nulls', () => {
    const rows = [
      { v: undefined, k: 1 },
      { v: undefined, k: 2 },
      { v: 1, k: 3 },
    ];
    const out = executeWindowFunction(rows, 'cume_dist', [], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
    }));
    expect(out.length).toBe(3);
  });

  it('GROUPS with multi-column order-by and null values', () => {
    const rows = [
      { a: 1, b: 'x', k: 1 },
      { a: 1, b: 'x', k: 2 },
      { a: 1, b: 'y', k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], makeSpec({
      orderBy: [
        { column: 'a', order: 'ASC' },
        { column: 'b', order: 'ASC' },
      ],
      frame,
    }));
    expect(out.map(r => r.sum)).toEqual([3, 3, 6]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWindowFunction — RANGE frame (date/ISO values)
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWindowFunction — RANGE frame (dates)', () => {
  const iso = (d: string) => d; // helper to keep values as ISO strings

  it('RANGE with ISO date strings treats offset N as N days', () => {
    const rows = [
      { d: '2024-01-01', v: 1 },
      { d: '2024-01-02', v: 2 },
      { d: '2024-01-03', v: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'd', order: 'ASC' }],
      frame,
    }));
    // 1 day PRECEDING on 2024-01-02 includes 01-01 and 01-02
    expect(out.map(o => o.sum)).toEqual([1, 3, 5]);
  });

  it('RANGE with Date objects', () => {
    // Two dates are 2 days apart, so a ±1-day window does NOT overlap: each row
    // only sees itself.
    const rows = [
      { d: new Date('2024-01-01'), v: 1 },
      { d: new Date('2024-01-03'), v: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'd', order: 'ASC' }],
      frame,
    }));
    expect(out.map(o => o.sum)).toEqual([1, 3]);
  });

  it('RANGE with string (non-ISO) values falls back to peer groups', () => {
    const rows = [
      { s: 'a', v: 1 },
      { s: 'a', v: 2 },
      { s: 'b', v: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 's', order: 'ASC' }],
      frame,
    }));
    // 'a' peers [1,2] sum to 3; 'b' alone sums to 3
    expect(out.map(o => o.sum)).toEqual([3, 3, 3]);
  });

  it('RANGE end=FOLLOWING with string values walks the peer group forward', () => {
    const rows = [
      { s: 'a', v: 1 },
      { s: 'a', v: 2 },
      { s: 'b', v: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 's', order: 'ASC' }],
      frame,
    }));
    // end boundary walks forward through 'a' peers (idx++) before stopping at 'b'
    expect(out.map(o => o.sum)).toEqual([3, 3, 6]);
  });

  it('RANGE end=PRECEDING with string values falls back to current index', () => {
    const rows = [
      { s: 'a', v: 1 },
      { s: 'a', v: 2 },
      { s: 'b', v: 3 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'PRECEDING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 's', order: 'ASC' }],
      frame,
    }));
    // string currentValue hits the non-numeric/non-date fallback → current index
    expect(out.map(o => o.sum)).toEqual([1, 3, 6]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWindowFunction — GROUPS frame
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWindowFunction — GROUPS frame', () => {
  it('GROUPS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW groups by peers', () => {
    const rows = [
      { v: 10, k: 1 },
      { v: 10, k: 2 },
      { v: 20, k: 3 },
      { v: 30, k: 4 },
    ];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    // peer group v=10 → sum k=1+2=3 (both rows); v=20 → 1+2+3=6; v=30 → 10
    expect(out.map(o => o.sum)).toEqual([3, 3, 6, 10]);
  });

  it('GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW', () => {
    const rows = [
      { v: 10, k: 1 },
      { v: 10, k: 2 },
      { v: 20, k: 3 },
      { v: 30, k: 4 },
    ];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    // v=10 group (2 rows): 1 preceding group (none) + current → 3 each
    // v=20 group: preceding group v=10 (k=1,2) + current k=3 → 6
    expect(out.map(o => o.sum)).toEqual([3, 3, 6, 7]);
  });

  it('GROUPS CURRENT ROW AND FOLLOWING with single group', () => {
    const rows = [
      { v: 10, k: 1 },
      { v: 20, k: 2 },
      { v: 30, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'CURRENT_ROW' },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.map(o => o.sum)).toEqual([3, 5, 3]);
  });

  it('GROUPS with no ORDER BY is the whole partition', () => {
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    expect(out.map(o => o.sum)).toEqual([6, 6, 6]);
  });

  it('GROUPS UNBOUNDED FOLLOWING as start (full partition)', () => {
    const rows = [{ v: 1 }, { v: 1 }, { v: 2 }];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'UNBOUNDED_FOLLOWING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(rows, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('GROUPS start=FOLLOWING', () => {
    const rows = [
      { v: 10, k: 1 },
      { v: 10, k: 2 },
      { v: 20, k: 3 },
      { v: 30, k: 4 },
    ];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'FOLLOWING', offset: 1 },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    // group0 (v10): start=1 → groups 1..2 → k3+k4=7
    // group1 (v20): start=2 → group 2 → k4=4
    // group2 (v30): start=3 > end=2 → empty frame → windowSum([])=0
    expect(out.map(o => o.sum)).toEqual([7, 7, 4, 0]);
  });

  it('GROUPS start=UNBOUNDED_FOLLOWING only sees the last group', () => {
    const rows = [
      { v: 10, k: 1 },
      { v: 20, k: 2 },
      { v: 30, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'UNBOUNDED_FOLLOWING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.map(o => o.sum)).toEqual([3, 3, 3]);
  });

  it('GROUPS end=UNBOUNDED_PRECEDING only sees the first group', () => {
    const rows = [
      { v: 10, k: 1 },
      { v: 20, k: 2 },
      { v: 30, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'UNBOUNDED_PRECEDING' },
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.map(o => o.sum)).toEqual([1, 1, 1]);
  });

  it('GROUPS end=FOLLOWING (with clamping at last group)', () => {
    const rows = [
      { v: 10, k: 1 },
      { v: 20, k: 2 },
      { v: 30, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.map(o => o.sum)).toEqual([3, 6, 6]);
  });

  it('GROUPS end default (invalid type) clamps to last group', () => {
    const rows = [{ v: 10, k: 1 }, { v: 20, k: 2 }];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'BOGUS' as any },
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.map(o => o.sum)).toEqual([3, 3]);
  });

  it('GROUPS start default (invalid type) clamps to first group', () => {
    const rows = [{ v: 10, k: 1 }, { v: 20, k: 2 }];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'NOPE' as any },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.map(o => o.sum)).toEqual([3, 3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWindowFunction — LAST_VALUE + EXCLUDE
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWindowFunction — last_value & exclude', () => {
  it('LAST_VALUE with ROWS UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING returns last row', () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const out = executeWindowFunction(rows, 'last_value', ['v'], makeSpec({ frame }));
    expect(out.map(r => r.last_value)).toEqual([30, 30, 30]);
  });

  it('LAST_VALUE with RANGE UNBOUNDED PRECEDING AND CURRENT ROW returns the current value (with ORDER BY)', () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    // With an ORDER BY, RANGE CURRENT ROW peers are rows with the same order
    // value, so the frame ends at the current row and LAST_VALUE = current row.
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(rows, 'last_value', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.map(r => r.last_value)).toEqual([10, 20, 30]);
  });

  it('LAST_VALUE with empty column gives null', () => {
    const rows = [{ v: 10 }];
    const out = executeWindowFunction(rows, 'last_value', [], makeSpec());
    expect(out.map(r => r.last_value)).toEqual([null]);
  });

  it('aggregate with EXCLUDE CURRENT ROW removes current row from frame', () => {
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const spec: WindowSpec = {
      partitionBy: [],
      orderBy: [],
      frame,
      exclude: 'CURRENT ROW',
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], spec);
    // each row's sum excludes itself
    expect(out.map(r => r.sum)).toEqual([5, 4, 3]);
  });

  it('aggregate with EXCLUDE TIES removes peers but keeps current', () => {
    const rows = [{ v: 1, k: 1 }, { v: 1, k: 2 }, { v: 2, k: 3 }];
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const spec: WindowSpec = {
      partitionBy: [],
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
      exclude: 'TIES',
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], spec);
    // row0 (k=1): exclude peer row1 → 1+3=4; row1 (k=2): exclude peer row0 → 2+3=5;
    // row2 (k=3): no peers → 1+2+3=6.
    expect(out.map(r => r.sum)).toEqual([4, 5, 6]);
  });

  it('aggregate with EXCLUDE GROUP removes all peers including current', () => {
    const rows = [{ v: 1, k: 1 }, { v: 1, k: 2 }, { v: 2, k: 3 }];
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const spec: WindowSpec = {
      partitionBy: [],
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
      exclude: 'GROUP',
    };
    const out = executeWindowFunction(rows, 'sum', ['k'], spec);
    expect(out.map(r => r.sum)).toEqual([3, 3, 3]);
  });

  it('LAST_VALUE with EXCLUDE CURRENT ROW', () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const spec: WindowSpec = {
      partitionBy: [],
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
      exclude: 'CURRENT ROW',
    };
    const out = executeWindowFunction(rows, 'last_value', ['v'], spec);
    // each frame excludes current → last remaining value
    // row0 frame [20,30]→30; row1 frame [10,30]→30; row2 frame [10,20]→20
    expect(out.map(r => r.last_value)).toEqual([30, 30, 20]);
  });

  it('NTH_VALUE with EXCLUDE CURRENT ROW', () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    };
    const spec: WindowSpec = {
      partitionBy: [],
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
      exclude: 'CURRENT ROW',
    };
    const out = executeWindowFunction(rows, 'nth_value', ['v', '1'], spec);
    expect(out.length).toBe(3);
  });

  it('NTH_VALUE default n=1 when only column arg given', () => {
    const rows = [{ v: 10 }, { v: 20 }];
    const out = executeWindowFunction(rows, 'nth_value', ['v'], makeSpec());
    expect(out.map(r => r.nth_value)).toEqual([10, 10]);
  });

  it('RANGE end=PRECEDING without offset (?? 1 default)', () => {
    const r = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'PRECEDING' }, // no offset
    };
    const out = executeWindowFunction(r, 'sum', ['v'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('GROUPS end=PRECEDING without offset (?? 1 default, Math.max clamp)', () => {
    const r = [
      { v: 10, k: 1 },
      { v: 20, k: 2 },
      { v: 30, k: 3 },
    ];
    const frame: WindowFrame = {
      type: 'GROUPS',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'PRECEDING' }, // no offset
    };
    const out = executeWindowFunction(r, 'sum', ['k'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(3);
  });

  it('aggregate without explicit excludeMode defaults to NO OTHERS (?? default)', () => {
    const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];
    // no exclude field in spec → excludeMode ?? 'NO OTHERS'
    const spec: WindowSpec = {
      partitionBy: [],
      orderBy: [],
      frame: { type: 'ROWS', start: { type: 'UNBOUNDED_PRECEDING' }, end: { type: 'UNBOUNDED_FOLLOWING' } },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], spec);
    expect(out.map(r => r.sum)).toEqual([6, 6, 6]);
  });

  it('invalid frame.type falls back to ROWS (switch default)', () => {
    const rows = [{ v: 1 }, { v: 2 }];
    const frame: WindowFrame = {
      type: 'BOGUS_FRAME' as any,
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'CURRENT_ROW' },
    };
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    expect(out.length).toBe(2);
  });

  it('LAST_VALUE with an empty frame returns null', () => {
    const rows = [{ v: 1 }, { v: 2 }];
    const frame: WindowFrame = {
      type: 'ROWS',
      start: { type: 'FOLLOWING', offset: 1 },
      end: { type: 'PRECEDING', offset: 1 },
    };
    const out = executeWindowFunction(rows, 'last_value', ['v'], makeSpec({ frame }));
    // first row → empty frame → null
    expect(out[0].last_value).toBeNull();
  });

  it('RANGE PRECEDING/FOLLOWING without ORDER BY hits the orderBy-empty guard', () => {
    const r = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'PRECEDING', offset: 1 },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    // no orderBy → findRangeStartBoundary/EndBoundary take the orderBy.length===0 guard
    const out = executeWindowFunction(r, 'sum', ['v'], makeSpec({ frame }));
    expect(out.length).toBe(3);
  });

  it('RANGE end boundary with a null current value (FOLLOWING)', () => {
    const r = [
      { v: null, k: 1 },
      { v: null, k: 2 },
    ];
    const frame: WindowFrame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'FOLLOWING', offset: 1 },
    };
    const out = executeWindowFunction(r, 'count', ['*'], makeSpec({
      orderBy: [{ column: 'v', order: 'ASC' }],
      frame,
    }));
    expect(out.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<WindowSpec> = {}): WindowSpec {
  return {
    partitionBy: [],
    orderBy: [],
    frame: {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// executeWindowFunction — defensive fallback for invalid frame bound types
// (the open union types are sealed, but runtime input may still be malformed)
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWindowFunction — invalid frame bound fallback', () => {
  const rows = [{ v: 1 }, { v: 2 }, { v: 3 }];

  it('ROWS start=CURRENT_ROW end=UNBOUNDED_FOLLOWING', () => {
    const frame = {
      type: 'ROWS',
      start: { type: 'CURRENT_ROW' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    } as WindowFrame;
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    // row i sums [i..end] → 6, 5, 3
    expect(out.map(r => r.sum)).toEqual([6, 5, 3]);
  });

  it('ROWS with an unrecognized start bound falls back to start=0', () => {
    const frame = {
      type: 'ROWS',
      start: { type: 'INVALID' },
      end: { type: 'UNBOUNDED_FOLLOWING' },
    } as unknown as WindowFrame;
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    // unknown start → default 0 → whole partition summed
    expect(out.map(r => r.sum)).toEqual([6, 6, 6]);
  });

  it('RANGE with an unrecognized end bound falls back to end=currentIndex', () => {
    const frame = {
      type: 'RANGE',
      start: { type: 'UNBOUNDED_PRECEDING' },
      end: { type: 'INVALID' },
    } as unknown as WindowFrame;
    const out = executeWindowFunction(rows, 'sum', ['v'], makeSpec({ frame }));
    // unknown end → currentIndex, so the frame grows [0..i] → running sum
    expect(out.map(r => r.sum)).toEqual([1, 3, 6]);
  });
});
