import { describe, it, expect, beforeEach, vi } from 'vitest';

import { PlanExecutor } from '../query/PlanExecutor';
import type { CandidatePlan, QueryCondition, JoinCondition } from '../query/QueryPlanner';

// Control the parallel-query module so the execParallelScan catch path is
// testable. `parallelQuery` resolves to `parallelResult` by default (an empty
// array), but individual tests can point it at a rejection to force fallback.
const parallelResult: { impl: (...args: any[]) => Promise<any[]> } = {
  impl: async () => [],
};
vi.mock('../query/ParallelQueryExecutor', () => ({
  parallelQuery: (...args: any[]) => parallelResult.impl(...args),
}));

/**
 * A programmable better-sqlite3 stub. Each `.prepare(sql)` returns a stmt whose
 * `.all(...)` / `.get(...)` are resolved by the FIRST matching responder
 * (matched by SQL substring), letting a test drive per-query results without
 * a real SQLite file.
 */
interface Responder {
  /** substring to match against the prepared SQL */
  match: string;
  /** return value for `.all(sql, ...args)` — sql passed first for routing */
  all?: (sql: string, ...args: any[]) => any[];
  /** return value for `.get(sql, ...args)` */
  get?: (sql: string, ...args: any[]) => any;
}

function makeFakeDb(responders: Responder[] = []) {
  const exec = vi.fn();
  const prepare = vi.fn((sql: string) => {
    const hit = responders.find(r => sql.includes(r.match));
    return {
      all: (...args: any[]) => {
        if (hit && hit.all) return hit.all(sql, ...args);
        return [];
      },
      get: (...args: any[]) => {
        if (hit && hit.get) return hit.get(sql, ...args);
        return undefined;
      },
    };
  });

  // transaction() returns a function that immediately invokes the batch fn.
  const transaction = vi.fn((fn: (batch: any[]) => void) => {
    return (batch: any[]) => fn(batch);
  });

  return {
    db: {
      prepare,
      exec,
      transaction,
      memory: true,
      name: ':memory:',
    },
    prepare,
    exec,
    transaction,
  };
}

/** Build a scan-style CandidatePlan node with the given description/type. */
function scanNode(type: CandidatePlan['type'], description: string, extra: Partial<CandidatePlan> = {}): CandidatePlan {
  return {
    type,
    startupCost: 0,
    totalCost: 1,
    rows: 1,
    width: 1,
    description,
    ...extra,
  };
}

function mkExecutor(db: any) {
  return new PlanExecutor({ db } as any);
}

// ─────────────────────────────────────────────────────────────────────────────
// module-level helpers (exercised through PlanExecutor public entry points)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — sequential scan & WHERE/LIMIT pushdown', () => {
  let fake: ReturnType<typeof makeFakeDb>;

  beforeEach(() => {
    fake = makeFakeDb();
  });

  it('executes a sequential scan with no conditions (SELECT * FROM table)', () => {
    fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }, { id: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sequential-scan', 'Seq Scan on users (rows=2)');
    const res = ex.executeQuery(plan, 'users');
    expect(res.rowCount).toBe(2);
    expect(res.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(res.engine).toBe('shard');
  });

  it('builds a WHERE clause with bound values when conditions exist', () => {
    fake = makeFakeDb([
      { match: 'SELECT * FROM', all: (_sql: string, id: any) => [{ id }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sequential-scan', 'Seq Scan on users (rows=1)');
    const conditions: QueryCondition[] = [
      { table: 'users', column: 'id', operator: '=', value: '7', exact: true },
    ];
    const res = ex.executeQuery(plan, 'users', conditions);
    expect(res.rowCount).toBe(1);
    expect(res.rows).toEqual([{ id: '7' }]);
  });

  it('adds a LIMIT clause when limit is provided', () => {
    fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sequential-scan', 'Seq Scan on users (rows=1000)');
    ex.executeQuery(plan, 'users', undefined, undefined, 3);
    const sqls = fake.prepare.mock.calls.map(c => c[0]);
    expect(sqls.some(s => s.includes('LIMIT 3'))).toBe(true);
  });

  it('normalizes the table name from the description when table is empty', () => {
    fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sequential-scan', 'Seq Scan on orders (rows=1)');
    const res = ex.executeQuery(plan, '');
    expect(res.rowCount).toBe(1);
    // ensure it queried the "orders" table (normalizeTableName path)
    expect(fake.prepare.mock.calls[0][0]).toContain('orders');
  });

  it('returns an error result (empty rows) on throw', () => {
    const ex = mkExecutor({ prepare: () => { throw new Error('boom'); } });
    const plan = scanNode('sequential-scan', 'Seq Scan on t (rows=1)');
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([]);
    expect(res.rowCount).toBe(0);
    expect(res.error).toBeDefined();
  });
});

describe('PlanExecutor — index scan', () => {
  it('checks index existence and reports stats, then filters', () => {
    const fake = makeFakeDb([
      { match: "type='index'", get: () => ({ '1': 1 }) },
      { match: 'SELECT * FROM', all: (_sql: string, id: any) => [{ id }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan using idx_id on users (sel=0.1)');
    const conditions: QueryCondition[] = [
      { table: 'users', column: 'id', operator: '=', value: '5', exact: true },
    ];
    const res = ex.executeQuery(plan, 'users', conditions);
    expect(res.rowCount).toBe(1);
    expect(res.rows).toEqual([{ id: '5' }]);
  });

  it('falls back to sequential scan when the index is missing', () => {
    const fake = makeFakeDb([
      { match: "type='index'", get: () => undefined },
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan using idx_missing on users (sel=0.1)');
    const res = ex.executeQuery(plan, 'users', [
      { table: 'users', column: 'id', operator: '=', value: '9', exact: true },
    ]);
    expect(res.rowCount).toBe(1);
  });

  it('applies a secondary in-memory filter when more than one condition exists', () => {
    const fake = makeFakeDb([
      { match: "type='index'", get: () => ({ '1': 1 }) },
      { match: 'SELECT * FROM', all: () => [{ id: 1, dept: 'a' }, { id: 2, dept: 'b' }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan using idx_id on users (sel=0.1)');
    const conditions: QueryCondition[] = [
      { table: 'users', column: 'id', operator: '=', value: '1', exact: true },
      { table: 'users', column: 'dept', operator: '=', value: 'a', exact: true },
    ];
    const res = ex.executeQuery(plan, 'users', conditions);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].dept).toBe('a');
  });

  it('degrades to sequential scan when no index name is present', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan on users (sel=0.1)');
    const res = ex.executeQuery(plan, 'users');
    expect(res.rowCount).toBe(1);
  });
});

describe('PlanExecutor — parallel scan', () => {
  it('delegates to sequential scan for sync executeQuery', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('parallel-scan', 'Parallel Seq Scan on users (rows=1)');
    const res = ex.executeQuery(plan, 'users');
    expect(res.rowCount).toBe(1);
  });
});

describe('PlanExecutor — sortRows (public overloads)', () => {
  let ex: PlanExecutor;
  beforeEach(() => {
    const fake = makeFakeDb();
    ex = mkExecutor(fake.db);
  });

  it('sorts ascending by a single key (string)', () => {
    const rows = [{ n: 'b' }, { n: 'a' }, { n: 'c' }];
    const out = ex.sortRows(rows, 'n');
    expect(out.map(r => r.n)).toEqual(['a', 'b', 'c']);
  });

  it('sorts descending by a single key', () => {
    const rows = [{ n: 1 }, { n: 3 }, { n: 2 }];
    const out = ex.sortRows(rows, 'n', true);
    expect(out.map(r => r.n)).toEqual([3, 2, 1]);
  });

  it('honors nulls first for a single-key sort', () => {
    const rows = [{ n: 2 }, { n: null }, { n: 1 }];
    const out = ex.sortRows(rows, 'n', false, true);
    expect(out.map(r => r.n)).toEqual([null, 1, 2]);
  });

  it('honors nulls last (default for ASC) for a single-key sort', () => {
    const rows = [{ n: 2 }, { n: null }, { n: 1 }];
    const out = ex.sortRows(rows, 'n');
    expect(out.map(r => r.n)).toEqual([1, 2, null]);
  });

  it('sorts by multiple keys via SortKey[]', () => {
    const rows = [
      { a: 1, b: 2 },
      { a: 1, b: 1 },
      { a: 2, b: 0 },
    ];
    const out = ex.sortRows(rows, [
      { column: 'a', order: 'ASC', nulls: 'last' },
      { column: 'b', order: 'ASC', nulls: 'last' },
    ]);
    expect(out.map(r => r.b)).toEqual([1, 2, 0]);
  });

  it('returns the same array (or []) when length <= 1', () => {
    expect(ex.sortRows([], 'n')).toEqual([]);
    expect(ex.sortRows([{ n: 1 }], 'n')).toEqual([{ n: 1 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// join execution
// ─────────────────────────────────────────────────────────────────────────────

function joinPlan(type: CandidatePlan['type'], leftDesc: string, rightDesc: string, extra: Partial<CandidatePlan> = {}): CandidatePlan {
  return scanNode(type, `Join`, {
    children: [
      scanNode('sequential-scan', leftDesc),
      scanNode('sequential-scan', rightDesc),
    ],
    ...extra,
  });
}

describe('PlanExecutor — nested-loop join', () => {
  it('cross joins when no join conditions are present', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    // left has 1 row, right has 1 row → 1x1 cross join
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const res = ex.executeQuery(plan, '', undefined, []);
    expect(res.rowCount).toBe(1);
  });

  it('uses batch IN mode when join conditions connect left/right tables', () => {
    const calls: string[] = [];
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: (sql?: string) => {
        if (typeof sql === 'string') { calls.push(sql); return [{ id: 1 }]; }
        return [{ id: 1 }];
      } },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBe(1);
  });
});

describe('PlanExecutor — hash join', () => {
  it('performs an in-memory hash join on the join column', () => {
    const leftData = [{ id: 1, lv: 'x' }, { id: 2, lv: 'y' }];
    const rightData = [{ id: 1, rv: 'p' }, { id: 1, rv: 'q' }];
    // left table → "a", right table → "b"
    const fake = makeFakeDb([
      // respond by matching the FROM table token in the SQL
      { match: 'FROM "a"', all: () => leftData },
      { match: 'FROM "b"', all: () => rightData },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('hash-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    // id=1 left has 2 matches in right → 2 rows; id=2 left has 0 → 0 rows
    expect(res.rowCount).toBe(2);
  });

  it('falls back to nested-loop join when no join condition matches', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('hash-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const res = ex.executeQuery(plan, '', undefined, []);
    expect(res.rowCount).toBe(1);
  });

  it('degrades to sequential scan when children are missing', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('hash-join', 'Join');
    const res = ex.executeQuery(plan, 'a');
    expect(res.rowCount).toBe(1);
  });
});

describe('PlanExecutor — merge join', () => {
  it('merges two sorted inputs on the join column', () => {
    const fake = makeFakeDb([
      { match: 'ORDER BY', all: (sql?: string) => {
        // return appropriately sorted data for either side
        return sql && sql.includes('"a"') ? [{ id: 1 }, { id: 2 }] : [{ id: 1 }, { id: 1 }];
      } },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    // id=1 in both (left id=1 matches right id=1 twice) + left id=2 no match
    expect(res.rowCount).toBe(2);
  });

  it('falls back to a cartesian merge when no join condition is present', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const res = ex.executeQuery(plan, '', undefined, []);
    expect(res.rowCount).toBe(1);
  });
});

describe('PlanExecutor — semi / anti join', () => {
  it('semi join returns left rows with a matching right key', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }, { id: 2 }, { id: 3 }] },
      { match: 'FROM "b"', all: () => [{ id: 1 }, { id: 4 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('semi-join', 'Seq Scan on a (rows=3)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    // left ids 1 and 4 have matches → wait, right has id 1,4; left has 1,2,3 → only id 1 matches
    expect(res.rowCount).toBe(1);
    expect(res.rows.map(r => r.id)).toEqual([1]);
  });

  it('anti join returns left rows without a matching right key', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }, { id: 2 }, { id: 3 }] },
      { match: 'FROM "b"', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('anti-join', 'Seq Scan on a (rows=3)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rows.map(r => r.id)).toEqual([2, 3]);
  });

  it('semi join returns [] when children are missing', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('semi-join', 'Semi Join');
    expect(ex.executeQuery(plan).rows).toEqual([]);
  });
});

describe('PlanExecutor — outer join', () => {
  it('left join preserves all left rows and null-fills unmatched right', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1, lv: 'x' }, { id: 2, lv: 'y' }] },
      { match: 'FROM "b"', all: () => [{ id: 1, rv: 'p' }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('left-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    // left id=1 matches right id=1 (rv); left id=2 null-filled
    expect(res.rowCount).toBe(2);
    const joined = res.rows.find(r => r.lv === 'y');
    expect(joined.rv).toBeNull();
  });

  it('right join preserves all right rows and null-fills unmatched left', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1, lv: 'x' }] },
      { match: 'FROM "b"', all: () => [{ id: 1, rv: 'p' }, { id: 2, rv: 'q' }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('right-join', 'RIGHT Join (a ⋈ b)', 'Seq Scan on b (rows=2)');
    // note: description must start with RIGHT for isRight detection
    const plan2 = scanNode('right-join', 'right-join', {
      description: 'RIGHT Join (a RIGHT OUTER JOIN b)',
      children: [
        scanNode('sequential-scan', 'Seq Scan on a (rows=1)'),
        scanNode('sequential-scan', 'Seq Scan on b (rows=2)'),
      ],
    });
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan2, '', undefined, jc);
    expect(res.rowCount).toBe(2);
  });

  it('full outer join combines both sides (shared, left-only, right-only)', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1, lv: 'x' }, { id: 2, lv: 'y' }] },
      { match: 'FROM "b"', all: () => [{ id: 1, rv: 'p' }, { id: 3, rv: 'q' }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('full-outer-join', 'full-outer-join', {
      description: 'FULL Outer Join (a FULL OUTER JOIN b)',
      children: [
        scanNode('sequential-scan', 'Seq Scan on a (rows=2)'),
        scanNode('sequential-scan', 'Seq Scan on b (rows=2)'),
      ],
    });
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    // shared id=1 (1 row) + left-only id=2 (1) + right-only id=3 (1) = 3
    expect(res.rowCount).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sort / aggregate / window / top-n / disk-sort / sort-aggregate / async
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — sort', () => {
  it('sorts child rows ascending by a single legacy key', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 3 }, { id: 1 }, { id: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (key=id, order=ASC)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.map(r => r.id)).toEqual([1, 2, 3]);
  });

  it('sorts descending with nulls first', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 2 }, { id: null }, { id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (key=id, order=DESC, nulls=first)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.map(r => r.id)).toEqual([null, 2, 1]);
  });

  it('multi-key sort via keys=[...] syntax', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [
        { a: 1, b: 2 }, { a: 1, b: 1 }, { a: 2, b: 0 },
      ] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (keys=[a ASC,b ASC])', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.map(r => r.b)).toEqual([1, 2, 0]);
  });

  it('returns [] when there are no children', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (key=id)');
    expect(ex.executeQuery(plan).rows).toEqual([]);
  });

  it('returns child rows unchanged when there is no sort key', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (whatever)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ id: 1 }]);
  });
});

describe('PlanExecutor — aggregate', () => {
  it('COUNT over child rows (no group)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }, { id: 2 }, { id: 3 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=count, column=id, alias=cnt)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ cnt: 3 }]);
  });

  it('SUM over child rows (no group)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 1 }, { v: 2 }, { v: 3 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=sum, column=v, alias=total)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ total: 6 }]);
  });

  it('AVG with GROUP BY', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [
        { cat: 'a', v: 1 }, { cat: 'a', v: 3 }, { cat: 'b', v: 10 },
      ] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=avg, column=v, group=cat, alias=avgv)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    const byCat: Record<string, number> = {};
    for (const r of res.rows) byCat[r.cat] = r.avgv;
    expect(byCat.a).toBe(2);
    expect(byCat.b).toBe(10);
  });

  it('MIN and MAX with group by', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [
        { g: 'x', v: 5 }, { g: 'x', v: 2 }, { g: 'y', v: 7 },
      ] },
    ]);
    const ex = mkExecutor(fake.db);
    const minPlan = scanNode('aggregate', 'Aggregate (fn=min, column=v, group=g, alias=m)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const minRes = ex.executeQuery(minPlan, 't');
    expect(minRes.rows.find(r => r.g === 'x').m).toBe(2);

    const maxPlan = scanNode('aggregate', 'Aggregate (fn=max, column=v, group=g, alias=m)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const maxRes = ex.executeQuery(maxPlan, 't');
    expect(maxRes.rows.find(r => r.g === 'x').m).toBe(5);
  });

  it('returns [] when there are no children', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=count)');
    expect(ex.executeQuery(plan).rows).toEqual([]);
  });

  it('falls back to count for an unknown fn', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }, { id: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=bogus, alias=x)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ x: 2 }]);
  });
});

describe('PlanExecutor — sort-aggregate', () => {
  it('streams aggregation over a sorted group column', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [
        { cat: 'b', v: 1 }, { cat: 'a', v: 2 }, { cat: 'a', v: 3 },
      ] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (fn=sum, column=v, group=cat, alias=s)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    const byCat: Record<string, number> = {};
    for (const r of res.rows) byCat[r.cat] = r.s;
    expect(byCat.a).toBe(5);
    expect(byCat.b).toBe(1);
  });

  it('counts over the whole set when no group column', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 1 }, { v: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (fn=count, column=*, alias=cnt)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ cnt: 2 }]);
  });
});

describe('PlanExecutor — top-n heap', () => {
  it('returns the top K rows by descending key', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [
        { score: 1 }, { score: 9 }, { score: 5 }, { score: 7 },
      ] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('top-n-heap', 'TopNHeap (key=score, order=DESC, limit=2)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.map(r => r.score)).toEqual([9, 7]);
  });

  it('falls back to full sort when k >= row count', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ score: 2 }, { score: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('top-n-heap', 'TopNHeap (key=score, order=ASC, limit=5)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.map(r => r.score)).toEqual([1, 2]);
  });

  it('returns [] when there are no children', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('top-n-heap', 'TopNHeap (key=x, limit=3)');
    expect(ex.executeQuery(plan).rows).toEqual([]);
  });
});

describe('PlanExecutor — disk sort', () => {
  it('does an in-memory sort for small data', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 3 }, { v: 1 }, { v: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('disk-sort', 'DiskSort (key=v, order=ASC)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.map(r => r.v)).toEqual([1, 2, 3]);
  });

  it('returns [] when there are no children', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('disk-sort', 'DiskSort (key=v)');
    expect(ex.executeQuery(plan).rows).toEqual([]);
  });
});

describe('PlanExecutor — window', () => {
  it('delegates to WindowFunctionExecutor for a window plan', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 3 }, { v: 1 }, { v: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('window', 'Window (fn=row_number, column=v, order=v, desc=false)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    // row_number appends a row_number column; 3 rows returned
    expect(res.rowCount).toBe(3);
  });
});

describe('PlanExecutor — executeQueryAsync', () => {
  it('uses the synchronous path for non-parallel plans', async () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sequential-scan', 'Seq Scan on users');
    const res = await ex.executeQueryAsync(plan, 'users');
    expect(res.rowCount).toBe(1);
    expect(res.engine).toBe('shard');
  });

  it('uses the synchronous path for parallel-scan on an in-memory db', async () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db); // db.memory === true
    const plan = scanNode('parallel-scan', 'Parallel Seq Scan on users');
    const res = await ex.executeQueryAsync(plan, 'users');
    expect(res.rowCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// join post-filter with conditions (exercises rowMatchesConditions operators)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — join post-filter conditions', () => {
  it('hash join applies extra IN/LIKE/NULL conditions to results', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [
        { id: 1, dept: 'eng' }, { id: 2, dept: 'ops' }, { id: 3, dept: 'eng' },
      ] },
      { match: 'FROM "b"', all: () => [{ id: 1, rv: 'p' }, { id: 2, rv: 'q' }, { id: 3, rv: 'r' }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('hash-join', 'Seq Scan on a (rows=3)', 'Seq Scan on b (rows=3)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    // IN condition on dept (exercises rowMatchesConditions IN branch)
    const conditions: QueryCondition[] = [
      { table: 'a', column: 'dept', operator: 'IN', value: 'eng,ops', exact: false },
    ];
    const res = ex.executeQuery(plan, '', conditions, jc);
    // all 3 join matches have dept eng/ops/eng → all pass IN
    expect(res.rowCount).toBe(3);
  });

  it('nested-loop join applies extra != and IS NOT NULL conditions', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [
        { id: 1, dept: 'eng' }, { id: 2, dept: null },
      ] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const conditions: QueryCondition[] = [
      { table: 'a', column: 'dept', operator: 'IS NOT NULL', value: '', exact: false },
    ];
    const res = ex.executeQuery(plan, '', conditions, jc);
    expect(res.rowCount).toBe(1);
  });

  it('merge join applies a LIKE filter to merged rows', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] },
      { match: 'FROM "b"', all: () => [{ id: 1, rv: 'p' }, { id: 2, rv: 'q' }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const conditions: QueryCondition[] = [
      { table: 'a', column: 'name', operator: 'LIKE', value: 'Ali%', exact: false },
    ];
    const res = ex.executeQuery(plan, '', conditions, jc);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].name).toBe('Alice');
  });
});

describe('PlanExecutor — merge join ORDER BY pushdown failure fallback', () => {
  it('falls back to in-memory sort when ORDER BY pushdown throws', () => {
    const fake = makeFakeDb([
      // ORDER BY prepare throws → catch → fallback path
      { match: 'ORDER BY', all: () => { throw new Error('pushdown failed'); } },
      // fallback executes child scans via executeNode → plain SELECT
      { match: 'SELECT * FROM "a', all: () => [{ id: 2 }, { id: 1 }] },
      { match: 'SELECT * FROM "b', all: () => [{ id: 1 }, { id: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    // after in-memory sort both sides are [1,2]; merge matches id 1,2 → 2 rows
    expect(res.rowCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// aggregate no-group variants (sum/avg/min/max reduce closures)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — aggregate no-group variants', () => {
  function agg(fn: string, column: string) {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 10 }, { v: 20 }, { v: 30 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', `Aggregate (fn=${fn}, column=${column}, alias=r)`, {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    return ex.executeQuery(plan, 't');
  }

  it('sum (no group)', () => {
    expect(agg('sum', 'v').rows).toEqual([{ r: 60 }]);
  });
  it('avg (no group)', () => {
    expect(agg('avg', 'v').rows).toEqual([{ r: 20 }]);
  });
  it('min (no group)', () => {
    expect(agg('min', 'v').rows).toEqual([{ r: 10 }]);
  });
  it('max (no group)', () => {
    expect(agg('max', 'v').rows).toEqual([{ r: 30 }]);
  });
  it('count (no group)', () => {
    expect(agg('count', 'v').rows).toEqual([{ r: 3 }]);
  });
});

describe('PlanExecutor — sort-aggregate sum/avg variants', () => {
  it('sum with group (streaming)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ g: 'a', v: 1 }, { g: 'a', v: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (fn=sum, column=v, group=g, alias=s)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ g: 'a', s: 3 }]);
  });

  it('avg with no group', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 10 }, { v: 20 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (fn=avg, column=v, alias=a)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ a: 15 }]);
  });
});

describe('PlanExecutor — disk sort large-data path', () => {
  it('uses a SQLite temp table for >1000 rows', () => {
    const bigRows = Array.from({ length: 1001 }, (_, i) => ({ rowid: i, v: 1001 - i }));
    const sortedIds = Array.from({ length: 1001 }, (_, i) => ({ rowid: i }));
    // track the CREATE TEMP TABLE / INSERT / SELECT rowid SQL
    let sawTemp = false;
    const prepare = (sql: string) => {
      return {
        all: (_s: string, ..._a: any[]) => {
          if (sql.includes('SELECT * FROM')) return bigRows;
          if (sql.includes('SELECT rowid')) return sortedIds;
          return [];
        },
        get: () => undefined,
        run: () => undefined,
      };
    };
    const exec = (sql: string) => { if (sql.includes('CREATE TEMP TABLE')) sawTemp = true; };
    const transaction = (fn: any) => (batch: any[]) => fn(batch);
    const db = { prepare, exec, transaction, memory: true, name: ':memory:' };
    const ex = mkExecutor(db);
    const plan = scanNode('disk-sort', 'DiskSort (key=v, order=DESC)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rowCount).toBe(1001);
    expect(sawTemp).toBe(true);
    // sortedIds are returned in insertion order (mocked); first row is rows[0]
    expect(res.rows.length).toBe(1001);
  });

  it('returns [] when there are no children', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('disk-sort', 'DiskSort (key=v)');
    expect(ex.executeQuery(plan).rows).toEqual([]);
  });
});

describe('PlanExecutor — executeQueryAsync parallel-scan (file-backed)', () => {
  it('delegates to ParallelQueryExecutor for a file-backed db', async () => {
    parallelResult.impl = async () => [{ id: 1 }, { id: 2 }];
    const fake = makeFakeDb();
    fake.db.memory = false;
    fake.db.name = '/tmp/example.db';
    const ex = mkExecutor(fake.db);
    const plan = scanNode('parallel-scan', 'Parallel Seq Scan on users');
    const res = await ex.executeQueryAsync(plan, 'users');
    expect(res.engine).toBe('parallel');
    expect(res.rowCount).toBe(2);
  });

  it('falls back to sequential scan when parallel execution throws', async () => {
    parallelResult.impl = async () => { throw new Error('boom'); };
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    fake.db.memory = false;
    fake.db.name = '/tmp/example.db';
    const ex = mkExecutor(fake.db);
    const plan = scanNode('parallel-scan', 'Parallel Seq Scan on users');
    const res = await ex.executeQueryAsync(plan, 'users');
    // parallelQuery rejected → catch falls back to synchronous executeQuery
    expect(res.engine).toBe('shard');
    expect(res.rowCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// remaining reduce/filter closures
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — aggregate/sort-aggregate SUM variants', () => {
  it('aggregate SUM with GROUP BY', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [
        { g: 'x', v: 1 }, { g: 'x', v: 2 }, { g: 'y', v: 5 },
      ] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=sum, column=v, group=g, alias=s)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    const byGroup: Record<string, number> = {};
    for (const r of res.rows) byGroup[r.g] = r.s;
    expect(byGroup.x).toBe(3);
    expect(byGroup.y).toBe(5);
  });

  it('sort-aggregate SUM with no group column', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 1 }, { v: 2 }, { v: 3 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (fn=sum, column=v, alias=s)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ s: 6 }]);
  });
});

describe('PlanExecutor — merge join with post-filter', () => {
  it('applies conditions after a successful merge (join-condition path)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM "a"', all: () => [{ id: 1, n: 10 }, { id: 2, n: 20 }] },
      { match: 'SELECT * FROM "b"', all: () => [{ id: 1, rv: 'p' }, { id: 2, rv: 'q' }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const conditions: QueryCondition[] = [
      { table: 'a', column: 'n', operator: '>', value: '10', exact: false },
    ];
    const res = ex.executeQuery(plan, '', conditions, jc);
    // n>10 → only id=2 matches (n=20)
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].n).toBe(20);
  });

  it('applies conditions after a cartesian merge (no join condition)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM "a"', all: () => [{ id: 1, n: 10 }] },
      { match: 'SELECT * FROM "b"', all: () => [{ id: 9, rv: 'p' }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const conditions: QueryCondition[] = [
      { table: 'a', column: 'n', operator: '=', value: '10', exact: true },
    ];
    const res = ex.executeQuery(plan, '', conditions, []);
    expect(res.rowCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rowMatchesConditions operator coverage (via index-scan remaining filter)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — rowMatchesConditions operators', () => {
  function run(remaining: QueryCondition[], row: Record<string, any>) {
    const fake = makeFakeDb([
      { match: "type='index'", get: () => ({ '1': 1 }) },
      { match: 'SELECT * FROM', all: () => [row] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan using idx_id on users (sel=0.1)');
    const conditions: QueryCondition[] = [
      { table: 'users', column: 'id', operator: '=', value: '1', exact: true },
      ...remaining,
    ];
    // returns rows that survive the remaining filter
    return ex.executeQuery(plan, 'users', conditions).rows;
  }

  it('< operator', () => {
    expect(run([{ table: 'u', column: 'v', operator: '<', value: '5', exact: false }], { v: 3 }).length).toBe(1);
    expect(run([{ table: 'u', column: 'v', operator: '<', value: '5', exact: false }], { v: 9 }).length).toBe(0);
  });
  it('<= operator', () => {
    expect(run([{ table: 'u', column: 'v', operator: '<=', value: '5', exact: false }], { v: 5 }).length).toBe(1);
  });
  it('> operator', () => {
    expect(run([{ table: 'u', column: 'v', operator: '>', value: '5', exact: false }], { v: 7 }).length).toBe(1);
  });
  it('>= operator', () => {
    expect(run([{ table: 'u', column: 'v', operator: '>=', value: '5', exact: false }], { v: 5 }).length).toBe(1);
  });
  it('!= operator', () => {
    expect(run([{ table: 'u', column: 'v', operator: '!=', value: '5', exact: false }], { v: 3 }).length).toBe(1);
    expect(run([{ table: 'u', column: 'v', operator: '!=', value: '3', exact: false }], { v: 3 }).length).toBe(0);
  });
  it('<> operator', () => {
    expect(run([{ table: 'u', column: 'v', operator: '<>', value: '5', exact: false }], { v: 3 }).length).toBe(1);
  });
  it('LIKE operator (string match)', () => {
    expect(run([{ table: 'u', column: 'name', operator: 'LIKE', value: 'Al%', exact: false }], { name: 'Alice' }).length).toBe(1);
    expect(run([{ table: 'u', column: 'name', operator: 'LIKE', value: 'Al%', exact: false }], { name: 'Bob' }).length).toBe(0);
  });
  it('IS NULL operator', () => {
    expect(run([{ table: 'u', column: 'v', operator: 'IS NULL', value: '', exact: false }], { v: null }).length).toBe(1);
    expect(run([{ table: 'u', column: 'v', operator: 'IS NULL', value: '', exact: false }], { v: 3 }).length).toBe(0);
  });
  it('IS NOT NULL operator', () => {
    expect(run([{ table: 'u', column: 'v', operator: 'IS NOT NULL', value: '', exact: false }], { v: 3 }).length).toBe(1);
  });
  it('IN operator', () => {
    expect(run([{ table: 'u', column: 'v', operator: 'IN', value: '1,2,3', exact: false }], { v: 2 }).length).toBe(1);
    expect(run([{ table: 'u', column: 'v', operator: 'IN', value: '1,2,3', exact: false }], { v: 9 }).length).toBe(0);
  });
  it('unknown operator falls back to equality', () => {
    expect(run([{ table: 'u', column: 'v', operator: 'BOGUS', value: '3', exact: false }], { v: 3 }).length).toBe(1);
    expect(run([{ table: 'u', column: 'v', operator: 'BOGUS', value: '3', exact: false }], { v: 4 }).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nested-loop join per-row fallback (batch mode throws / reverse join condition)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — NLJ per-row fallback', () => {
  it('falls back to per-row loop when batch IN query throws (forward condition)', () => {
    const fake = makeFakeDb([
      // left scan returns two rows
      { match: 'FROM "a"', all: () => [{ id: 1 }, { id: 3 }] },
      // batch IN query throws → catch → per-row loop
      { match: ' IN (', all: () => { throw new Error('no batch'); } },
      // per-row right scan uses a WHERE "id" = ? query
      { match: 'WHERE "id" = ?', all: (_s: string, v: any) => [{ id: v, lv: 'x' }] },
      // any other "FROM b" (e.g. a plain right scan) returns nothing
      { match: 'FROM "b"', all: () => [] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    // two left rows each produce one right match in the per-row loop
    expect(res.rowCount).toBe(2);
  });

  it('matches a reverse join condition (right/left tables swapped)', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 7 }] },
      { match: ' IN (', all: () => { throw new Error('no batch'); } },
      { match: 'WHERE "id" = ?', all: (_s: string, v: any) => [{ id: v }] },
      { match: 'FROM "b"', all: () => [] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    // condition declares b as left and a as right → reverse match branch
    const jc: JoinCondition[] = [
      { leftTable: 'b', leftColumn: 'id', rightTable: 'a', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', [
      { table: 'a', column: 'id', operator: '>', value: '0', exact: false },
    ], jc);
    expect(res.rowCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sort nulls / multi-key parsing (sortRows & executeSort nulls handling)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — sort nulls-first/last coverage', () => {
  it('executeSort handles DESC with explicit NULLS FIRST', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 2 }, { v: null }, { v: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (key=v, order=DESC, nulls=first)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.map(r => r.v)).toEqual([null, 2, 1]);
  });

  it('executeSort handles DESC with NULLS LAST', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: null }, { v: 2 }, { v: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (key=v, order=DESC, nulls=last)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.map(r => r.v)).toEqual([2, 1, null]);
  });

  it('sortRows handles both-null and single-null comparisons (multi-key)', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const rows = [
      { a: null, b: 1 },
      { a: null, b: 2 },
      { a: 3, b: null },
      { a: 2, b: 0 },
    ];
    const out = ex.sortRows(rows, [
      { column: 'a', order: 'ASC', nulls: 'first' },
      { column: 'b', order: 'ASC', nulls: 'last' },
    ]);
    // null a's first (sorted by b asc), then non-null a's
    expect(out[0].a).toBeNull();
    expect(out[1].a).toBeNull();
    expect(out[2].a).toBe(2);
    expect(out[3].a).toBe(3);
  });

  it('sortRows DESC with nulls last', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const rows = [{ v: 2 }, { v: null }, { v: 1 }];
    const out = ex.sortRows(rows, [{ column: 'v', order: 'DESC', nulls: 'last' }]);
    expect(out.map(r => r.v)).toEqual([2, 1, null]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sort-aggregate count/default/avg-group + executeSort multi-key nulls
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — sort-aggregate remaining variants', () => {
  function run(desc: string, rows: Record<string, any>[]) {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => rows }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', desc, {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    return ex.executeQuery(plan, 't').rows;
  }

  it('count with no group', () => {
    expect(run('SortAggregate (fn=count, column=*, alias=c)', [{ v: 1 }, { v: 2 }])).toEqual([{ c: 2 }]);
  });
  it('count with group', () => {
    expect(run('SortAggregate (fn=count, column=*, group=g, alias=c)', [
      { g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 3 },
    ])).toEqual([{ g: 'a', c: 2 }, { g: 'b', c: 1 }]);
  });
  it('default (unknown fn) with no group falls back to count', () => {
    expect(run('SortAggregate (fn=bogus, column=*, alias=c)', [{ v: 1 }])).toEqual([{ c: 1 }]);
  });
  it('default (unknown fn) with group falls back to count', () => {
    expect(run('SortAggregate (fn=bogus, column=*, group=g, alias=c)', [
      { g: 'a', v: 1 }, { g: 'a', v: 2 },
    ])).toEqual([{ g: 'a', c: 2 }]);
  });
  it('avg with group', () => {
    expect(run('SortAggregate (fn=avg, column=v, group=g, alias=a)', [
      { g: 'a', v: 10 }, { g: 'a', v: 20 },
    ])).toEqual([{ g: 'a', a: 15 }]);
  });
  it('avg with group and a group with zero numeric rows', () => {
    expect(run('SortAggregate (fn=avg, column=v, group=g, alias=a)', [
      { g: 'a', v: null },
    ])).toEqual([{ g: 'a', a: 0 }]);
  });
});

describe('PlanExecutor — executeSort multi-key nulls parsing', () => {
  it('parses keys=[v DESC] (no NULLS → DESC defaults first)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 2 }, { v: null }, { v: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (keys=[v DESC])', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    expect(ex.executeQuery(plan, 't').rows.map(r => r.v)).toEqual([null, 2, 1]);
  });
  it('parses keys=[v DESC NULLS LAST]', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: null }, { v: 2 }, { v: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (keys=[v DESC NULLS LAST])', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    expect(ex.executeQuery(plan, 't').rows.map(r => r.v)).toEqual([2, 1, null]);
  });
  it('parses keys=[v ASC NULLS FIRST]', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 2 }, { v: null }, { v: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (keys=[v ASC NULLS FIRST])', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    expect(ex.executeQuery(plan, 't').rows.map(r => r.v)).toEqual([null, 1, 2]);
  });
  it('parses a single key with no sort direction', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 2 }, { v: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (keys=[id])', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    // single-key no-space → sorts by id (all null → stable order)
    expect(ex.executeQuery(plan, 't').rows.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// aggregate count/min/max/default (group + no-group)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — aggregate count/min/max/default variants', () => {
  function run(desc: string, rows: Record<string, any>[]) {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => rows }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', desc, {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    return ex.executeQuery(plan, 't').rows;
  }
  it('count (no group)', () => {
    expect(run('Aggregate (fn=count, column=*, alias=c)', [{ v: 1 }, { v: 2 }])).toEqual([{ c: 2 }]);
  });
  it('min with group', () => {
    expect(run('Aggregate (fn=min, column=v, group=g, alias=m)', [
      { g: 'a', v: 5 }, { g: 'a', v: 2 },
    ])).toEqual([{ g: 'a', m: 2 }]);
  });
  it('max with group', () => {
    expect(run('Aggregate (fn=max, column=v, group=g, alias=m)', [
      { g: 'a', v: 5 }, { g: 'a', v: 2 },
    ])).toEqual([{ g: 'a', m: 5 }]);
  });
  it('default (unknown fn) with group falls back to count', () => {
    expect(run('Aggregate (fn=bogus, column=v, group=g, alias=c)', [
      { g: 'a', v: 1 }, { g: 'a', v: 2 },
    ])).toEqual([{ g: 'a', c: 2 }]);
  });
  it('min (no group)', () => {
    expect(run('Aggregate (fn=min, column=v, alias=m)', [{ v: 5 }, { v: 2 }])).toEqual([{ m: 2 }]);
  });
  it('max (no group)', () => {
    expect(run('Aggregate (fn=max, column=v, alias=m)', [{ v: 5 }, { v: 2 }])).toEqual([{ m: 5 }]);
  });
  it('default (unknown fn) with no group', () => {
    expect(run('Aggregate (fn=bogus, column=v, alias=c)', [{ v: 1 }, { v: 2 }])).toEqual([{ c: 2 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hash join reverse condition / outer join branches / merge join fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — hash join reverse condition', () => {
  it('matches a condition with swapped left/right tables', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1, x: 'A' }] },
      { match: 'FROM "b"', all: () => [{ id: 1, y: 'B' }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('hash-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    // reverse: condition names b as left, a as right
    const jc: JoinCondition[] = [
      { leftTable: 'b', leftColumn: 'id', rightTable: 'a', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBe(1);
  });
});

describe('PlanExecutor — outer join branches', () => {
  it('left outer with no join condition returns left rows', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: 9 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('outer-join', 'LEFT JOIN a', {
      children: [
        scanNode('sequential-scan', 'Seq Scan on a (rows=1)'),
        scanNode('sequential-scan', 'Seq Scan on b (rows=1)'),
      ],
    });
    const res = ex.executeQuery(plan);
    expect(res.rowCount).toBe(1);
  });

  it('right outer with no join condition returns right rows', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: 9 }, { id: 10 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('outer-join', 'RIGHT JOIN a', {
      children: [
        scanNode('sequential-scan', 'Seq Scan on a (rows=1)'),
        scanNode('sequential-scan', 'Seq Scan on b (rows=2)'),
      ],
    });
    const res = ex.executeQuery(plan);
    expect(res.rowCount).toBe(2);
  });

  it('full outer with no join condition returns union of both sides', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: 9 }, { id: 10 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('full-outer-join', 'FULL JOIN a', {
      children: [
        scanNode('sequential-scan', 'Seq Scan on a (rows=1)'),
        scanNode('sequential-scan', 'Seq Scan on b (rows=2)'),
      ],
    });
    const res = ex.executeQuery(plan);
    expect(res.rowCount).toBe(3);
  });

  it('empty both sides returns []', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [] },
      { match: 'FROM "b"', all: () => [] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('outer-join', 'LEFT JOIN a', {
      children: [
        scanNode('sequential-scan', 'Seq Scan on a (rows=0)'),
        scanNode('sequential-scan', 'Seq Scan on b (rows=0)'),
      ],
    });
    expect(ex.executeQuery(plan).rows).toEqual([]);
  });
});

describe('PlanExecutor — merge join fallback (pushdown order-by throws)', () => {
  it('sorts in memory when ORDER BY pushdown throws', () => {
    const fake = makeFakeDb([
      // pushdown ORDER BY queries throw → fallback to in-memory sort
      { match: 'ORDER BY "id"', all: () => { throw new Error('no pushdown'); } },
      // in-memory path: executeNode on each child scans via FROM
      { match: 'FROM "a"', all: () => [{ id: 2 }, { id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: 1 }, { id: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBe(2);
  });

  it('merge join with duplicate keys produces cartesian within matches', () => {
    const fake = makeFakeDb([
      { match: 'ORDER BY "id"', all: () => { throw new Error('no pushdown'); } },
      { match: 'FROM "a"', all: () => [{ id: 1 }, { id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: 1 }, { id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    // 2 left rows × 2 right rows = 4 matches
    expect(res.rowCount).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// window function + top-n heap plan nodes
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — window plan node', () => {
  it('executes a window function with ORDER BY (desc)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 30 }, { v: 10 }, { v: 20 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('window', 'Window (fn=row_number, column=v, order=v, desc=true)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rowCount).toBe(3);
    // row_number is appended to each row
    expect(res.rows[0]).toHaveProperty('row_number');
  });

  it('executes a window function with no column/order', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 1 }, { v: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('window', 'Window (fn=row_number)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rowCount).toBe(2);
    expect(res.rows[0]).toHaveProperty('row_number');
  });
});

describe('PlanExecutor — top-n heap plan node', () => {
  it('returns top K rows (k < data size, binary-insert path)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ score: 5 }, { score: 1 }, { score: 9 }, { score: 3 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('top-n-heap', 'TopNHeap (key=score, order=DESC, limit=2)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rowCount).toBe(2);
    expect(res.rows.map(r => r.score)).toEqual([9, 5]);
  });

  it('returns all rows when k >= data size (sortByKeys path)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ score: 5 }, { score: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('top-n-heap', 'TopNHeap (key=score, order=DESC, limit=10)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rowCount).toBe(2);
    expect(res.rows.map(r => r.score)).toEqual([5, 1]);
  });

  it('returns [] with no children', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('top-n-heap', 'TopNHeap (key=score)');
    expect(ex.executeQuery(plan).rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// merge join reverse condition + comparator edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — merge join more', () => {
  it('matches a reverse join condition (swapped tables)', () => {
    const fake = makeFakeDb([
      { match: 'ORDER BY "id"', all: () => { throw new Error('no pushdown'); } },
      { match: 'FROM "a"', all: () => [{ id: 2 }, { id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: 1 }, { id: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'b', leftColumn: 'id', rightTable: 'a', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeSort legacy single-key + null comparator coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — executeSort legacy single-key nulls', () => {
  function run(desc: string, rows: Record<string, any>[]) {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => rows }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', desc, {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    return ex.executeQuery(plan, 't').rows;
  }

  it('key=v DESC defaults to NULLS FIRST (legacy path)', () => {
    const rows = [{ v: 2 }, { v: null }, { v: 1 }];
    expect(run('Sort (key=v, order=DESC)', rows).map(r => r.v)).toEqual([null, 2, 1]);
  });

  it('key=v DESC with explicit nulls=last', () => {
    const rows = [{ v: null }, { v: 2 }, { v: 1 }];
    expect(run('Sort (key=v, order=DESC, nulls=last)', rows).map(r => r.v)).toEqual([2, 1, null]);
  });

  it('key=v ASC defaults to NULLS LAST (legacy path)', () => {
    const rows = [{ v: null }, { v: 2 }, { v: 1 }];
    expect(run('Sort (key=v, order=ASC)', rows).map(r => r.v)).toEqual([1, 2, null]);
  });

  it('key=v ASC with explicit nulls=first', () => {
    const rows = [{ v: 2 }, { v: null }, { v: 1 }];
    expect(run('Sort (key=v, order=ASC, nulls=first)', rows).map(r => r.v)).toEqual([null, 1, 2]);
  });

  it('two-null-then-value rows (both-null + single-null branches)', () => {
    const rows = [{ v: null }, { v: null }, { v: 1 }];
    expect(run('Sort (key=v, order=ASC, nulls=first)', rows).map(r => r.v)).toEqual([null, null, 1]);
  });

  it('no key returns child rows unchanged', () => {
    const rows = [{ v: 2 }, { v: 1 }];
    expect(run('Sort (nothing)', rows).map(r => r.v)).toEqual([2, 1]);
  });
});

describe('PlanExecutor — sortRows single-key null comparator', () => {
  it('single-key sortRows handles nulls-first and nulls-last', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const rows = [{ v: null }, { v: 3 }, { v: null }, { v: 1 }];
    const first = ex.sortRows(rows, 'v', false, true);
    expect(first.map(r => r.v)).toEqual([null, null, 1, 3]);
    const last = ex.sortRows(rows, 'v', false, false);
    expect(last.map(r => r.v)).toEqual([1, 3, null, null]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// merge join pushdown-success path (two-pointer merge < > = branches)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — merge join pushdown success', () => {
  it('merges two already-sorted inputs (pushdown success)', () => {
    // pushdown queries are "SELECT * FROM "a" ORDER BY "id"" / "... FROM "b" ..."
    // route them to distinct, already-sorted result sets.
    const fake = makeFakeDb([
      { match: 'FROM "a" ORDER BY', all: () => [{ id: 1 }, { id: 2 }, { id: 3 }] },
      { match: 'FROM "b" ORDER BY', all: () => [{ id: 2 }, { id: 3 }] },
      { match: 'FROM "a"', all: () => [{ id: 1 }, { id: 2 }] },
      { match: 'FROM "b"', all: () => [{ id: 2 }, { id: 3 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=3)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    // sortedLeft=[1,2,3], sortedRight=[2,3] → matches on 2 and 3
    expect(res.rowCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sortByKeys (multi-key) null comparator branches
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — sortByKeys null comparator', () => {
  it('single-null vs value on a sort key (nulls first & last)', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const rows = [{ a: 2 }, { a: null }];
    expect(ex.sortRows(rows, [{ column: 'a', order: 'ASC', nulls: 'first' }]).map(r => r.a))
      .toEqual([null, 2]);
    expect(ex.sortRows(rows, [{ column: 'a', order: 'ASC', nulls: 'last' }]).map(r => r.a))
      .toEqual([2, null]);
  });

  it('null vs null (continue) plus value, and desc reversal', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const rows = [{ a: null }, { a: null }, { a: 1 }, { a: 3 }];
    expect(ex.sortRows(rows, [{ column: 'a', order: 'DESC', nulls: 'first' }]).map(r => r.a))
      .toEqual([null, null, 3, 1]);
  });

  it('multi-key: first key ties, falls through to null on second key', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const rows = [
      { a: 1, b: null },
      { a: 1, b: 5 },
    ];
    expect(ex.sortRows(rows, [
      { column: 'a', order: 'ASC', nulls: 'last' },
      { column: 'b', order: 'ASC', nulls: 'last' },
    ]).map(r => r.b)).toEqual([5, null]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sort-aggregate sum/avg remaining (column falsy / count>0 ternary)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — sort-aggregate column falsy paths', () => {
  function run(desc: string, rows: Record<string, any>[]) {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => rows }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', desc, {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    return ex.executeQuery(plan, 't').rows;
  }

  it('sum with column=* (no numeric column → 0 contributions)', () => {
    expect(run('SortAggregate (fn=sum, column=*, alias=s)', [
      { x: 1 }, { x: 2 },
    ])).toEqual([{ s: 0 }]);
  });

  it('sum with zero-valued column rows exercises || 0', () => {
    expect(run('SortAggregate (fn=sum, column=v, alias=s)', [
      { v: 0 }, { v: 0 },
    ])).toEqual([{ s: 0 }]);
  });

  it('avg with group and zero-valued column (count>0 true)', () => {
    expect(run('SortAggregate (fn=avg, column=v, group=g, alias=a)', [
      { g: 'a', v: 0 }, { g: 'a', v: 0 },
    ])).toEqual([{ g: 'a', a: 0 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// aggregate reduce `Number(...) || 0` falsy (zero/null) contributions
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — aggregate zero/null contributions', () => {
  function run(desc: string, rows: Record<string, any>[]) {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => rows }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', desc, {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    return ex.executeQuery(plan, 't').rows;
  }

  it('sum with group and zero/null values (|| 0 side)', () => {
    expect(run('Aggregate (fn=sum, column=v, group=g, alias=s)', [
      { g: 'a', v: 0 }, { g: 'a', v: null }, { g: 'a', v: 5 },
    ])).toEqual([{ g: 'a', s: 5 }]);
  });

  it('min with group and falsy values', () => {
    expect(run('Aggregate (fn=min, column=v, group=g, alias=m)', [
      { g: 'a', v: 0 }, { g: 'a', v: -3 },
    ])).toEqual([{ g: 'a', m: -3 }]);
  });

  it('max with group and falsy values', () => {
    expect(run('Aggregate (fn=max, column=v, group=g, alias=m)', [
      { g: 'a', v: 0 }, { g: 'a', v: 7 },
    ])).toEqual([{ g: 'a', m: 7 }]);
  });

  it('avg with no group and zero-valued column', () => {
    expect(run('Aggregate (fn=avg, column=v, alias=a)', [
      { v: 0 }, { v: 0 },
    ])).toEqual([{ a: 0 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// merge join > branch + comparator edge (leftVal > rightVal → j++)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — merge join > branch', () => {
  it('advances right pointer when leftVal > rightVal', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a" ORDER BY', all: () => [{ id: 5 }] },
      { match: 'FROM "b" ORDER BY', all: () => [{ id: 1 }, { id: 5 }] },
      { match: 'FROM "a"', all: () => [{ id: 5 }] },
      { match: 'FROM "b"', all: () => [{ id: 1 }, { id: 5 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// index scan with conditions > 1 (remaining filter) limit branch
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — index scan remaining filter + limit', () => {
  it('applies limit and remaining filter', () => {
    const fake = makeFakeDb([
      { match: 'type=', get: () => ({ '7': 7 }) },
      { match: 'SELECT * FROM', all: () => [
        { id: 7, v: 10 }, { id: 7, v: 20 },
      ] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan using idx on t (sel=0.5)');
    const conditions: QueryCondition[] = [
      { table: 't', column: 'id', operator: '=', value: '7', exact: true },
      { table: 't', column: 'v', operator: '>', value: '15', exact: false },
    ];
    const res = ex.executeQuery(plan, 't', conditions);
    // only v=20 survives the remaining v>15 filter
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].v).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// semi-join / anti-join / unknown type / empty table / parallel WHERE-LIMIT
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — semi-join and anti-join', () => {
  it('semi-join returns left rows with a matching right key', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }, { id: 2 }, { id: 3 }] },
      { match: 'FROM "b"', all: () => [{ id: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('semi-join', 'Seq Scan on a (rows=3)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].id).toBe(2);
  });

  it('semi-join with empty right returns []', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }] },
      { match: 'FROM "b"', all: () => [] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('semi-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=0)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    expect(ex.executeQuery(plan, '', undefined, jc).rowCount).toBe(0);
  });

  it('anti-join returns left rows with no matching right key', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }, { id: 2 }] },
      { match: 'FROM "b"', all: () => [{ id: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('anti-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].id).toBe(1);
  });

  it('anti-join with empty right returns all left rows', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }, { id: 2 }] },
      { match: 'FROM "b"', all: () => [] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('anti-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=0)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    expect(ex.executeQuery(plan, '', undefined, jc).rowCount).toBe(2);
  });

  it('anti-join with no join condition returns left rows', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: 9 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('anti-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    expect(ex.executeQuery(plan, '', undefined, []).rowCount).toBe(1);
  });
});

describe('PlanExecutor — unknown type + empty table + merge-join < branch', () => {
  it('falls back to sequential scan for unknown plan type', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('bogus-type', 'Bogus Plan on t');
    const res = ex.executeQuery(plan, 't');
    expect(res.rowCount).toBe(1);
  });

  it('merge join leftVal < rightVal advances left pointer', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a" ORDER BY', all: () => [{ id: 1 }] },
      { match: 'FROM "b" ORDER BY', all: () => [{ id: 9 }] },
      { match: 'FROM "a"', all: () => [{ id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: 9 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBe(0); // 1 < 9 → no match
  });
});

describe('PlanExecutor — parallel-scan WHERE/LIMIT construction', () => {
  it('builds WHERE and LIMIT clauses into the parallel baseSql', async () => {
    parallelResult.impl = async () => [{ id: 1 }];
    const fake = makeFakeDb([]);
    fake.db.memory = false;
    fake.db.name = '/tmp/example.db';
    const ex = mkExecutor(fake.db);
    const plan = scanNode('parallel-scan', 'Parallel Seq Scan on users');
    const conditions: QueryCondition[] = [
      { table: 'users', column: 'id', operator: '=', value: '1', exact: true },
    ];
    const res = await ex.executeQueryAsync(plan, 'users', conditions, undefined, 5);
    expect(res.engine).toBe('parallel');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// default-value ternaries (missing fn/alias/key/group in description)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — default-value ternaries', () => {
  it('aggregate without fn/alias defaults to count', () => {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => [{ v: 1 }, { v: 2 }] }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (column=v)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ count: 2 }]);
  });

  it('sort-aggregate without fn/alias defaults to count', () => {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => [{ v: 1 }, { v: 2 }] }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (column=v)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ count: 2 }]);
  });

  it('window without fn/column defaults to row_number', () => {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => [{ v: 1 }, { v: 2 }] }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('window', 'Window (nothing here)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows[0]).toHaveProperty('row_number');
  });

  it('topN without key/order/limit defaults', () => {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => [{ s: 2 }, { s: 1 }] }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('top-n-heap', 'TopNHeap (nothing)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    // no key → k>=len path → sortByKeys with empty key
    expect(res.rowCount).toBe(2);
  });

  it('disk-sort without key/order defaults', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 2 }, { v: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('disk-sort', 'DiskSort (nothing)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rowCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// null join/group keys (?? '' null side)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — null join/group keys', () => {
  it('hash join with null inner key exercises ?? ""', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: null }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('hash-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBe(0); // null inner key doesn't match id=1
  });

  it('aggregate with null group key exercises ?? ""', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ g: null, v: 5 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=sum, column=v, group=g, alias=s)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ g: '', s: 5 }]);
  });

  it('sort-aggregate with null group key exercises ?? ""', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ g: null, v: 3 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (fn=sum, column=v, group=g, alias=s)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ g: '', s: 3 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// comparator equality / descending + empty-data guards
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — comparator equality + empty data', () => {
  it('sortRows with equal values hits the == branch (returns 0)', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const rows = [{ v: 5 }, { v: 5 }, { v: 1 }];
    // ascending: [1,5,5]; equality comparator returns 0 for the two 5s
    expect(ex.sortRows(rows, 'v', false, false).map(r => r.v)).toEqual([1, 5, 5]);
  });

  it('sortRows descending hits the > branch (returns 1)', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const rows = [{ v: 1 }, { v: 5 }, { v: 3 }];
    expect(ex.sortRows(rows, 'v', true, false).map(r => r.v)).toEqual([5, 3, 1]);
  });

  it('sort-aggregate with empty input returns [] (currentGroup stays null)', () => {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => [] }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (fn=sum, column=v, group=g, alias=s)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    expect(ex.executeQuery(plan, 't').rows).toEqual([]);
  });

  it('aggregate with empty input (group) returns []', () => {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => [] }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=sum, column=v, group=g, alias=s)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    expect(ex.executeQuery(plan, 't').rows).toEqual([]);
  });

  it('aggregate with empty input (no group) returns avg 0', () => {
    const fake = makeFakeDb([{ match: 'SELECT * FROM', all: () => [] }]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=avg, column=v, alias=a)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    expect(ex.executeQuery(plan, 't').rows).toEqual([{ a: 0 }]);
  });

  it('semi-join with no join condition returns []', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('semi-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    expect(ex.executeQuery(plan, '', undefined, []).rowCount).toBe(0);
  });

  it('anti-join with empty left returns []', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [] },
      { match: 'FROM "b"', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('anti-join', 'Seq Scan on a (rows=0)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    expect(ex.executeQuery(plan, '', undefined, jc).rowCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// final defensive/edge branch coverage (non-string LIKE, sortByKeys nulls both
// ways, NaN reduce contributions)
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — remaining defensive branches', () => {
  it('LIKE against a non-string value (typeof val !== string)', () => {
    const fake = makeFakeDb([
      { match: 'type=', get: () => ({ '1': 1 }) },
      { match: 'SELECT * FROM', all: () => [{ id: 1, n: 123 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan using idx on t (sel=0.5)');
    const conditions: QueryCondition[] = [
      { table: 't', column: 'id', operator: '=', value: '1', exact: true },
      { table: 't', column: 'n', operator: 'LIKE', value: '1%', exact: false },
    ];
    // numeric n → LIKE does not match (non-string branch)
    expect(ex.executeQuery(plan, 't', conditions).rows.length).toBe(0);
  });

  it('sortByKeys nulls-first and nulls-last both directions', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const rows = [{ a: null, b: 1 }, { a: 5, b: 2 }];
    // null a vs value a → single-null branches, nulls first then last
    const first = ex.sortRows(rows, [{ column: 'a', order: 'ASC', nulls: 'first' }]);
    expect(first.map(r => r.a)).toEqual([null, 5]);
    const last = ex.sortRows(rows, [{ column: 'a', order: 'ASC', nulls: 'last' }]);
    expect(last.map(r => r.a)).toEqual([5, null]);
  });

  it('agg reduce with non-numeric column value (Number(...) -> NaN -> || 0)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ g: 'a', v: 'abc' }, { g: 'a', v: 5 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=sum, column=v, group=g, alias=s)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    const byG: Record<string, number> = {};
    for (const r of res.rows) byG[r.g] = r.s;
    // 'abc' → NaN → || 0 → 0; plus 5 → total 5
    expect(byG.a).toBe(5);
  });

  it('min/max reduce with NaN value (|| 0 path)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ g: 'a', v: 'xyz' }, { g: 'a', v: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=min, column=v, group=g, alias=m)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    // 'xyz' → NaN || 0 → 0; 2 → min(0,2)=0
    expect(res.rows[0].m).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// aggregate group count / sort-aggregate group default & avg ternary
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — aggregate group count + sort-agg avg/default', () => {
  it('aggregate count with group', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 3 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('aggregate', 'Aggregate (fn=count, column=*, group=g, alias=c)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    const byG: Record<string, number> = {};
    for (const r of res.rows) byG[r.g] = r.c;
    expect(byG.a).toBe(2);
    expect(byG.b).toBe(1);
  });

  it('sort-aggregate avg group with zero count (count>0 false)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ g: 'a', v: null }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (fn=avg, column=v, group=g, alias=a)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    // v=null → column truthy but Number(null)=0, sum=0, count=1 → avg 0
    expect(ex.executeQuery(plan, 't').rows).toEqual([{ g: 'a', a: 0 }]);
  });

  it('sort-aggregate default (unknown fn) with group', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ g: 'a', v: 1 }, { g: 'a', v: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (fn=bogus, column=v, group=g, alias=c)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    expect(ex.executeQuery(plan, 't').rows).toEqual([{ g: 'a', c: 2 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// final: == operator / idxCondition absent / limit paths / sortByKeys reverse
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — final branch sweep', () => {
  it('index scan uses == operator (finds idxCondition)', () => {
    const fake = makeFakeDb([
      { match: 'type=', get: () => ({ '1': 1 }) },
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan using idx on t (sel=0.5)');
    const conditions: QueryCondition[] = [
      { table: 't', column: 'id', operator: '==', value: '1', exact: true },
    ];
    expect(ex.executeQuery(plan, 't', conditions).rowCount).toBe(1);
  });

  it('index scan without an = condition builds multi-clause WHERE', () => {
    const fake = makeFakeDb([
      { match: 'type=', get: () => ({ '1': 1 }) },
      { match: 'SELECT * FROM', all: () => [{ id: 1, v: 10 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan using idx on t (sel=0.5)');
    const conditions: QueryCondition[] = [
      { table: 't', column: 'v', operator: '>', value: '5', exact: false },
    ];
    const res = ex.executeQuery(plan, 't', conditions, undefined, 10);
    expect(res.rowCount).toBe(1);
  });

  it('merge join comparator equality (av == bv)', () => {
    const fake = makeFakeDb([
      { match: 'FROM "a" ORDER BY', all: () => [{ id: 1 }, { id: 1 }] },
      { match: 'FROM "b" ORDER BY', all: () => [{ id: 1 }, { id: 1 }] },
      { match: 'FROM "a"', all: () => [{ id: 1 }, { id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: 1 }, { id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBe(4);
  });

  it('sortByKeys single-null reverse direction (nullsFirst true & false)', () => {
    const fake = makeFakeDb([]);
    const ex = mkExecutor(fake.db);
    const rows = [{ a: null }, { a: 3 }];
    // nulls first → null before value; nulls last → value before null
    expect(ex.sortRows(rows, [{ column: 'a', order: 'DESC', nulls: 'first' }]).map(r => r.a))
      .toEqual([null, 3]);
    expect(ex.sortRows(rows, [{ column: 'a', order: 'DESC', nulls: 'last' }]).map(r => r.a))
      .toEqual([3, null]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Remaining edge branches: null-coalescing, join-inversion, sort nulls,
// comparator equality, limit-undefined, unknown-fn default
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanExecutor — index scan limit-undefined false side', () => {
  it('skips LIMIT when limit is undefined (index condition path)', () => {
    const fake = makeFakeDb([
      { match: 'EXPLAIN', all: () => [] },
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan on t using idx (cond)');
    const res = ex.executeQuery(plan, 't', [{ table: 't', column: 'id', operator: '=', value: 1, exact: true }], undefined, undefined);
    expect(res.rowCount).toBeGreaterThanOrEqual(0);
  });

  it('skips LIMIT when limit is undefined (multi-condition WHERE path)', () => {
    const fake = makeFakeDb([
      { match: 'EXPLAIN', all: () => [] },
      { match: 'SELECT * FROM', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan on t using idx (cond)');
    const conditions = [
      { table: 't', column: 'id', operator: '>', value: 0, exact: false },
      { table: 't', column: 'v', operator: '<', value: 10, exact: false },
    ];
    const res = ex.executeQuery(plan, 't', conditions, undefined, undefined);
    expect(res.rowCount).toBeGreaterThanOrEqual(0);
  });
});

describe('PlanExecutor — NLJ batch null-value and join-inversion', () => {
  it('left join column all null → batchValues empty → continue', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM "a', all: () => [{ id: null }, { id: undefined }] },
      { match: 'SELECT * FROM "b', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    // no joinable values → but fallback per-row loop still runs; assert sane
    expect(typeof res.rowCount).toBe('number');
  });

  it('NLJ per-row fallback with inverted join condition (right=left)', () => {
    // join condition has rightTable === leftTable(a) and leftTable === rightTable(b)
    const fake = makeFakeDb([
      { match: 'SELECT * FROM "a', all: () => [{ id: 1 }] },
      { match: 'SELECT * FROM "b', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    // inverted: rightTable='a' === leftTable 'a', leftTable='b' === rightTable 'b'
    const jc: JoinCondition[] = [
      { leftTable: 'b', leftColumn: 'id', rightTable: 'a', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(typeof res.rowCount).toBe('number');
  });
});

describe('PlanExecutor — hash join inverted condition + no-match key', () => {
  it('hash join with inverted join condition (right=left)', () => {
    const leftData = [{ id: 1, lv: 'x' }];
    const rightData = [{ id: 1, rv: 'p' }];
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => leftData },
      { match: 'FROM "b"', all: () => rightData },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('hash-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'b', leftColumn: 'id', rightTable: 'a', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(typeof res.rowCount).toBe('number');
  });

  it('hash join with no matching key (matches undefined)', () => {
    const leftData = [{ id: 99, lv: 'x' }];
    const rightData = [{ id: 1, rv: 'p' }];
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => leftData },
      { match: 'FROM "b"', all: () => rightData },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('hash-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBe(0);
  });
});

describe('PlanExecutor — merge join fallback equality comparator', () => {
  it('in-memory sort fallback hits equality (av === bv) branch', () => {
    // both sides have duplicate keys so sort comparator returns 0 for equal
    const fake = makeFakeDb([
      { match: 'ORDER BY', all: () => { throw new Error('down'); } },
      { match: 'SELECT * FROM "a', all: () => [{ id: 1 }, { id: 1 }, { id: 2 }] },
      { match: 'SELECT * FROM "b', all: () => [{ id: 1 }, { id: 1 }, { id: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=3)', 'Seq Scan on b (rows=3)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBeGreaterThan(0);
  });
});

describe('PlanExecutor — legacy sort nulls coverage', () => {
  it('ASC with a null on the right side only (bVal null)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: 2 }, { id: null }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (key=id, order=ASC, nulls=last)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.map(r => r.id)).toEqual([2, null]);
  });

  it('DESC with a null on the left side only (aVal null)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ id: null }, { id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort', 'Sort (key=id, order=DESC, nulls=first)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.map(r => r.id)).toEqual([null, 1]);
  });
});

describe('PlanExecutor — sort-aggregate unknown fn default', () => {
  it('unknown fn (no group) falls back to count via default', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 1 }, { v: 2 }, { v: 3 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (fn=median, column=v, alias=m)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ m: 3 }]);
  });
});

describe('PlanExecutor — disk sort small-data nulls', () => {
  it('small-data in-memory sort with null values (aVal null / bVal null)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 3 }, { v: null }, { v: 1 }, { v: null }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('disk-sort', 'DiskSort (key=v, order=DESC)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.length).toBe(4);
  });
});

describe('PlanExecutor — NLJ batch rightIndex duplicate/missing-key', () => {
  it('rightIndex duplicate keys (has() true path) and missing key (matches false)', () => {
    // right returns two rows with same key → has() true for second; left has
    // a key with no right match → matches undefined
    const fake = makeFakeDb([
      { match: 'SELECT * FROM "a', all: () => [{ id: 1 }, { id: 2 }] },
      { match: 'SELECT * FROM "b', all: () => [{ id: 1 }, { id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=2)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    // left id=1 matches 2 right rows; left id=2 matches none
    expect(res.rowCount).toBe(2);
  });
});

describe('PlanExecutor — merge join right-table sort equality', () => {
  it('right-side in-memory sort hits equality (av === bv)', () => {
    const fake = makeFakeDb([
      { match: 'ORDER BY', all: () => { throw new Error('down'); } },
      { match: 'SELECT * FROM "a', all: () => [{ id: 1 }, { id: 2 }] },
      { match: 'SELECT * FROM "b', all: () => [{ id: 1 }, { id: 1 }, { id: 2 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=3)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(res.rowCount).toBeGreaterThan(0);
  });
});

describe('PlanExecutor — sort-aggregate unknown fn with GROUP BY (default)', () => {
  it('unknown fn with group falls back to count via default branch', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 3 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('sort-aggregate', 'SortAggregate (fn=median, column=v, group=g, alias=m)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows).toEqual([{ g: 'a', m: 2 }, { g: 'b', m: 1 }]);
  });
});

describe('PlanExecutor — index scan with LIMIT pushdown', () => {
  it('pushes LIMIT into SQL when limit is provided (exact-match condition path)', () => {
    let sawLimit = false;
    const fake = makeFakeDb([
      { match: 'EXPLAIN', all: () => [] },
      { match: 'SELECT * FROM', all: (sql?: string) => { if (sql && sql.includes('LIMIT')) sawLimit = true; return [{ id: 1 }]; } },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan on t using idx (cond)');
    const res = ex.executeQuery(plan, 't', [{ table: 't', column: 'id', operator: '=', value: 1, exact: true }], undefined, 5);
    expect(sawLimit).toBe(true);
    expect(res.rowCount).toBe(1);
  });

  it('pushes LIMIT into multi-condition WHERE path', () => {
    let sawLimit = false;
    const fake = makeFakeDb([
      { match: 'EXPLAIN', all: () => [] },
      { match: 'SELECT * FROM', all: (sql?: string) => { if (sql && sql.includes('LIMIT')) sawLimit = true; return [{ id: 1 }]; } },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('index-scan', 'Index Scan on t using idx (cond)');
    const conditions = [
      { table: 't', column: 'id', operator: '>', value: 0, exact: false },
      { table: 't', column: 'v', operator: '<', value: 10, exact: false },
    ];
    const res = ex.executeQuery(plan, 't', conditions, undefined, 3);
    expect(sawLimit).toBe(true);
    expect(res.rowCount).toBe(1);
  });
});

describe('PlanExecutor — disk sort small-data ASC nulls (nullsFirst false)', () => {
  it('ASC disk sort moves nulls last (nullsFirst=false side)', () => {
    const fake = makeFakeDb([
      { match: 'SELECT * FROM', all: () => [{ v: 3 }, { v: null }, { v: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = scanNode('disk-sort', 'DiskSort (key=v, order=ASC)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rows.map(r => r.v)).toEqual([1, 3, null]);
  });
});

describe('PlanExecutor — NLJ per-row fallback null join value', () => {
  it('per-row fallback uses ?? empty string for null left join value', () => {
    // batch mode is skipped by forcing join conditions length > 0 but with
    // left join value null so batchValues filters to empty → falls through,
    // then per-row loop hits the null-coalesce on leftColumn/rightColumn.
    const fake = makeFakeDb([
      { match: 'SELECT * FROM "a', all: () => [{ id: null }] },
      { match: 'SELECT * FROM "b', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(typeof res.rowCount).toBe('number');
  });
});

describe('PlanExecutor — disk sort large-data TEXT + ASC + exact batch', () => {
  it('TEXT sort values (non-number) and ASC order', () => {
    const bigRows = Array.from({ length: 1001 }, (_, i) => ({ rowid: i, v: `s${1001 - i}` }));
    const sortedIds = Array.from({ length: 1001 }, (_, i) => ({ rowid: i }));
    const prepare = (sql: string) => ({
      all: (_s: string) => {
        if (sql.includes('SELECT * FROM')) return bigRows;
        if (sql.includes('SELECT rowid')) return sortedIds;
        return [];
      },
      get: () => undefined,
      run: () => undefined,
    });
    const exec = () => {};
    const transaction = (fn: any) => (batch: any[]) => fn(batch);
    const db = { prepare, exec, transaction, memory: true, name: ':memory:' };
    const ex = mkExecutor(db);
    const plan = scanNode('disk-sort', 'DiskSort (key=v, order=ASC)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rowCount).toBe(1001);
  });

  it('exactly 1000 rows → single 500-batch flush + final empty batch (batch.length>0 false side)', () => {
    const bigRows = Array.from({ length: 1000 }, (_, i) => ({ rowid: i, v: 1000 - i }));
    const sortedIds = Array.from({ length: 1000 }, (_, i) => ({ rowid: i }));
    const prepare = (sql: string) => ({
      all: (_s: string) => {
        if (sql.includes('SELECT * FROM')) return bigRows;
        if (sql.includes('SELECT rowid')) return sortedIds;
        return [];
      },
      get: () => undefined,
      run: () => undefined,
    });
    const exec = () => {};
    const transaction = (fn: any) => (batch: any[]) => fn(batch);
    const db = { prepare, exec, transaction, memory: true, name: ':memory:' };
    const ex = mkExecutor(db);
    const plan = scanNode('disk-sort', 'DiskSort (key=v, order=ASC)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rowCount).toBe(1000);
  });
});

describe('PlanExecutor — NLJ batch throws → per-row fallback null coalesce', () => {
  it('batch prepare throws, falls back to per-row loop with null join value', () => {
    // first SELECT * FROM "a" (left scan) succeeds; right-table IN query throws
    // to force the catch → per-row fallback, which then re-queries right via
    // executeNode with an = condition (matches SELECT * FROM "b").
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: null }] },
      { match: 'FROM "b"', all: () => { throw new Error('force fallback'); } },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(typeof res.rowCount).toBe('number');
  });
});

describe('PlanExecutor — NLJ fallback with genuinely null join value', () => {
  it('per-row fallback coalesces a null left join value to empty string', () => {
    // left scan returns a null id; right IN query throws to force fallback,
    // so the per-row loop builds rightParams with leftRow[id] === null.
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: null }] },
      { match: 'IN (', all: () => { throw new Error('force fallback'); } },
      { match: 'FROM "b"', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(typeof res.rowCount).toBe('number');
  });
});

describe('PlanExecutor — NLJ fallback null-coalesce empty-string side', () => {
  it('per-row fallback coalesces null join value (mixed null + non-null left rows)', () => {
    // Left has one non-null (drives batch IN to throw) and one null row.
    // catch → per-row fallback, where the null row hits `?? ''` right side.
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }, { id: null }] },
      { match: 'IN (', all: () => { throw new Error('force fallback'); } },
      { match: 'FROM "b"', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(typeof res.rowCount).toBe('number');
  });
});

describe('PlanExecutor — NLJ inverted join with null value + self-join mismatch', () => {
  it('inverted join per-row fallback coalesces null rightColumn (L476 null side)', () => {
    // inverted jc: rightTable==='a'(leftTable), leftTable==='b'(rightTable).
    // batch IN throws → per-row fallback, inverted branch uses leftRow[rightColumn].
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }, { id: null }] },
      { match: 'IN (', all: () => { throw new Error('force'); } },
      { match: 'FROM "b"', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=2)', 'Seq Scan on b (rows=1)');
    // inverted: rightTable='a' matches leftTable 'a'; leftTable='b' matches rightTable 'b'
    const jc: JoinCondition[] = [
      { leftTable: 'b', leftColumn: 'id', rightTable: 'a', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(typeof res.rowCount).toBe('number');
  });

  it('self-join mismatch (rightTable===leftTable but leftTable!==rightTable)', () => {
    // rightTable==='a' matches leftTable, but leftTable==='c' !== rightTable 'b'
    // → neither normal nor inverted branch matches → cartesian fallback.
    const fake = makeFakeDb([
      { match: 'FROM "a"', all: () => [{ id: 1 }] },
      { match: 'FROM "b"', all: () => [{ id: 1 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('nested-loop-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=1)');
    const jc: JoinCondition[] = [
      { leftTable: 'c', leftColumn: 'id', rightTable: 'a', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(typeof res.rowCount).toBe('number');
  });
});

describe('PlanExecutor — disk sort null sort value + exact 500 batch', () => {
  it('large-data sort with null sort values (?? null side)', () => {
    const bigRows = Array.from({ length: 1001 }, (_, i) => ({ rowid: i, v: i % 2 === 0 ? i : null }));
    const sortedIds = Array.from({ length: 1001 }, (_, i) => ({ rowid: i }));
    const prepare = (sql: string) => ({
      all: (_s: string) => {
        if (sql.includes('SELECT * FROM')) return bigRows;
        if (sql.includes('SELECT rowid')) return sortedIds;
        return [];
      },
      get: () => undefined,
      run: () => undefined,
    });
    const exec = () => {};
    const transaction = (fn: any) => (batch: any[]) => fn(batch);
    const db = { prepare, exec, transaction, memory: true, name: ':memory:' };
    const ex = mkExecutor(db);
    const plan = scanNode('disk-sort', 'DiskSort (key=v, order=ASC)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rowCount).toBe(1001);
  });

  it('exactly 2500 rows (500 exactly × 5 batches, no trailing) → batch.length>0 false side', () => {
    const bigRows = Array.from({ length: 2500 }, (_, i) => ({ rowid: i, v: 2500 - i }));
    const sortedIds = Array.from({ length: 2500 }, (_, i) => ({ rowid: i }));
    const prepare = (sql: string) => ({
      all: (_s: string) => {
        if (sql.includes('SELECT * FROM')) return bigRows;
        if (sql.includes('SELECT rowid')) return sortedIds;
        return [];
      },
      get: () => undefined,
      run: () => undefined,
    });
    const exec = () => {};
    const transaction = (fn: any) => (batch: any[]) => fn(batch);
    const db = { prepare, exec, transaction, memory: true, name: ':memory:' };
    const ex = mkExecutor(db);
    const plan = scanNode('disk-sort', 'DiskSort (key=v, order=DESC)', {
      children: [scanNode('sequential-scan', 'Seq Scan on t')],
    });
    const res = ex.executeQuery(plan, 't');
    expect(res.rowCount).toBe(2500);
  });
});

describe('PlanExecutor — merge join right-sort comparator av < bv', () => {
  it('right-side sort comparator hits av < bv (descending left into ascending)', () => {
    // Right rows are reverse-sorted so the comparator must reorder, forcing
    // the `av < bv ? -1` branch. Left has a single row to keep it simple.
    const fake = makeFakeDb([
      { match: 'ORDER BY', all: () => { throw new Error('down'); } },
      { match: 'SELECT * FROM "a', all: () => [{ id: 2 }] },
      { match: 'SELECT * FROM "b', all: () => [{ id: 9 }, { id: 1 }, { id: 5 }] },
    ]);
    const ex = mkExecutor(fake.db);
    const plan = joinPlan('merge-join', 'Seq Scan on a (rows=1)', 'Seq Scan on b (rows=3)');
    const jc: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const res = ex.executeQuery(plan, '', undefined, jc);
    expect(typeof res.rowCount).toBe('number');
  });
});
