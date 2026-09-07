import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor rowMatchesPredicate boundary cases', () => {
  it('conservative true for unknown column (eqValue path)', () => {
    const e = makeExec();
    const lock = { table: 't', column: 'id', eqValue: 10 } as any;
    expect((e as any).rowMatchesPredicate({ other: 1 }, lock)).toBe(true);
  });

  it('numeric equality via Number coercion', () => {
    const e = makeExec();
    const lock = { table: 't', column: 'id', eqValue: 10 } as any;
    expect((e as any).rowMatchesPredicate({ id: '10' }, lock)).toBe(true);
    expect((e as any).rowMatchesPredicate({ id: 11 }, lock)).toBe(false);
  });

  it('string equality when non-numeric', () => {
    const e = makeExec();
    const lock = { table: 't', column: 'name', eqValue: 'alice' } as any;
    expect((e as any).rowMatchesPredicate({ name: 'alice' }, lock)).toBe(true);
    expect((e as any).rowMatchesPredicate({ name: 'bob' }, lock)).toBe(false);
  });

  it('conservative true for range without column', () => {
    const e = makeExec();
    const lock = { table: 't', minValue: 5 } as any; // no column → conservative
    expect((e as any).rowMatchesPredicate({ id: 1 }, lock)).toBe(true);
  });

  it('conservative true for non-numeric range value', () => {
    const e = makeExec();
    const lock = { table: 't', column: 'id', minValue: 5 } as any;
    expect((e as any).rowMatchesPredicate({ id: 'abc' }, lock)).toBe(true);
  });

  it('range bounds: below min → false, within → true, above max → false', () => {
    const e = makeExec();
    const lock = { table: 't', column: 'id', minValue: 5, maxValue: 15 } as any;
    expect((e as any).rowMatchesPredicate({ id: 3 }, lock)).toBe(false);
    expect((e as any).rowMatchesPredicate({ id: 10 }, lock)).toBe(true);
    expect((e as any).rowMatchesPredicate({ id: 20 }, lock)).toBe(false);
  });

  it('table-level predicate (no column, no range) always matches', () => {
    const e = makeExec();
    const lock = { table: 't' } as any;
    expect((e as any).rowMatchesPredicate({ id: 1 }, lock)).toBe(true);
  });
});

describe('MVCCExecutor detectPredicateConflict skip branches', () => {
  it('returns false when txn not found or read-only', () => {
    const e = makeExec();
    expect((e as any).detectPredicateConflict('ghost')).toBe(false);

    e.begin('a', 'SERIALIZABLE', true); // read-only
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });

  it('returns false for non-SERIALIZABLE isolation', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    (e as any).predicateLocks.set('a', new Set([{ table: 't', column: 'id', eqValue: 1 }]));
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });

  it('returns false when no predicate locks', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });

  it('skips read-only other txns (Check 1)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', true); // read-only other txn
    (e as any).predicateLocks.set('a', new Set([{ table: 't', column: 'id', eqValue: 1 }]));
    (e as any).insertedRowData.set('b', new Map([['t', [{ id: 1 }]]]));
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });

  it('skips non-SERIALIZABLE other txns (Check 1)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'READ_COMMITTED', false);
    (e as any).predicateLocks.set('a', new Set([{ table: 't', column: 'id', eqValue: 1 }]));
    (e as any).insertedRowData.set('b', new Map([['t', [{ id: 1 }]]]));
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });

  it('skips other txn with empty inserts (Check 1)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    (e as any).predicateLocks.set('a', new Set([{ table: 't', column: 'id', eqValue: 1 }]));
    (e as any).insertedRowData.set('b', new Map()); // empty inserts
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });

  it('skips table with no matching rows (Check 1)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    (e as any).predicateLocks.set('a', new Set([{ table: 'missing', column: 'id', eqValue: 1 }]));
    (e as any).insertedRowData.set('b', new Map([['t', [{ id: 1 }]]])); // different table
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });

  it('detects conflict when INSERT matches predicate (Check 1)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    (e as any).predicateLocks.set('a', new Set([{ table: 't', column: 'id', eqValue: 1 }]));
    (e as any).insertedRowData.set('b', new Map([['t', [{ id: 1 }]]]));
    expect((e as any).detectPredicateConflict('a')).toBe(true);
  });

  it('skips committedPredicateWrites with non-matching table (Check 2)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    const a = e.getTransaction('a')!;
    (e as any).predicateLocks.set('a', new Set([{ table: 't', column: 'id', eqValue: 1 }]));
    (e as any).committedPredicateWrites.push({
      predLockTxnXid: a.xid,
      table: 'other', // different table
      rowData: { id: 1 },
    });
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });

  it('detects conflict for committed write matching predicate (Check 2)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    const a = e.getTransaction('a')!;
    (e as any).predicateLocks.set('a', new Set([{ table: 't', column: 'id', eqValue: 1 }]));
    (e as any).committedPredicateWrites.push({
      predLockTxnXid: a.xid,
      table: 't',
      rowData: { id: 1 },
    });
    expect((e as any).detectPredicateConflict('a')).toBe(true);
  });
});
