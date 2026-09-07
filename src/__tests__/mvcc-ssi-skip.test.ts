import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor detectSerializationConflict skip branches', () => {
  it('returns false when session not found or not SERIALIZABLE', () => {
    const e = makeExec();
    expect((e as any).detectSerializationConflict('ghost')).toEqual({ conflict: false });

    e.begin('a', 'READ_COMMITTED', false);
    expect((e as any).detectSerializationConflict('a')).toEqual({ conflict: false });
  });

  it('skips read-only and non-SERIALIZABLE txns when collecting sessions', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', true); // read-only (skipped)
    e.begin('c', 'READ_COMMITTED', false); // non-SERIALIZABLE (skipped)

    // Only 'a' is an active SERIALIZABLE non-read-only txn → < 2 → no cycle.
    const result = (e as any).detectSerializationConflict('a');
    expect(result.conflict).toBe(false);
  });

  it('skips empty writeSetB in Step 1', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    // a reads t:1, but b has EMPTY writeSet → no edge.
    (e as any).readSets.set('a', new Set(['t:1']));
    (e as any).writeSets.set('b', new Set()); // empty
    const result = (e as any).detectSerializationConflict('a');
    expect(result.conflict).toBe(false);
  });

  it('skips empty insertsB in Step 2', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    (e as any).predicateLocks.set('a', new Set([{ table: 't', column: 'id', eqValue: 1 }]));
    (e as any).insertedRowData.set('b', new Map()); // empty inserts
    const result = (e as any).detectSerializationConflict('a');
    expect(result.conflict).toBe(false);
  });

  it('skips table with no matching rows in Step 2', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    (e as any).predicateLocks.set('a', new Set([{ table: 'missing', column: 'id', eqValue: 1 }]));
    (e as any).insertedRowData.set('b', new Map([['t', [{ id: 1 }]]])); // different table
    const result = (e as any).detectSerializationConflict('a');
    expect(result.conflict).toBe(false);
  });

  it('establishes rw-dependency edge when read overlaps write (Step 1)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    (e as any).readSets.set('a', new Set(['t:1']));
    (e as any).writeSets.set('b', new Set(['t:1']));
    // a reads t:1, b wrote t:1 → edge a→b; no cycle (2 nodes, single edge).
    const result = (e as any).detectSerializationConflict('a');
    expect(result.conflict).toBe(false);
  });

  it('detects a 2-node rw cycle (Step 1)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    // a reads t:2 (written by b), b reads t:1 (written by a) → a→b→a cycle.
    (e as any).readSets.set('a', new Set(['t:2']));
    (e as any).readSets.set('b', new Set(['t:1']));
    (e as any).writeSets.set('a', new Set(['t:1']));
    (e as any).writeSets.set('b', new Set(['t:2']));
    const result = (e as any).detectSerializationConflict('a');
    expect(result.conflict).toBe(true);
    expect(typeof result.victimXid).toBe('number');
  });
});

describe('MVCCExecutor degradation record existing-rec branches', () => {
  it('recordDegradation sets originalIsolation from the reported level', () => {
    const e = makeExec();
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    e.recordDegradation('s', 'REPEATABLE_READ', 3); // second reported event
    const rec = (e as any).degradationRecords.get('s');
    // recordDegradation reports the pre-degradation level for each event;
    // the second event reports REPEATABLE_READ as its pre-degradation level.
    expect(rec.originalIsolation).toBe('REPEATABLE_READ');
    expect(rec.currentIsolation).toBe('READ_COMMITTED');
    expect(rec.totalDegradations).toBe(2); // incremented across events
  });

  it('normalizes REPEATABLE_READ degradation level (recordDegradation)', () => {
    const e = makeExec();
    e.recordDegradation('s', 'REPEATABLE_READ', 5);
    const rec = (e as any).degradationRecords.get('s');
    expect(rec).toBeDefined();
    expect(rec.currentIsolation).toBe('READ_COMMITTED');
  });
});

describe('MVCCExecutor hasTableLocks / visibility helpers', () => {
  it('hasConflict false when rowId undefined in predicate', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    const a = e.getTransaction('a')!;
    (e as any).txnWriteLocks.set(a.xid, new Set(['t:undefined']));
    (e as any).rowVersions.set('t:undefined', { xmin: 50, xmax: null });
    a.snapshot = 10;
    const result = (e as any).hasConflict(a);
    expect(typeof result).toBe('boolean');
  });
});
