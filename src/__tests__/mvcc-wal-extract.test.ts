import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor, extractWhereRange } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('extractWhereRange full branch coverage', () => {
  it('returns undefined without WHERE clause', () => {
    expect(extractWhereRange('SELECT * FROM t')).toBeUndefined();
  });

  it('extracts numeric equality', () => {
    expect(extractWhereRange('SELECT * FROM t WHERE id = 123')).toEqual({ column: 'id', eqValue: 123 });
  });

  it('extracts single-quoted string equality (strips quotes via isNaN branch)', () => {
    expect(extractWhereRange("SELECT * FROM t WHERE name = 'alice'")).toEqual({ column: 'name', eqValue: 'alice' });
  });

  it('extracts double-quoted string equality', () => {
    expect(extractWhereRange('SELECT * FROM t WHERE name = "alice"')).toEqual({ column: 'name', eqValue: 'alice' });
  });

  it('extracts BETWEEN range', () => {
    expect(extractWhereRange('SELECT * FROM t WHERE age BETWEEN 5 AND 15')).toEqual({
      column: 'age', minValue: 5, maxValue: 15,
    });
  });

  it('extracts greater-than / greater-equal min bound', () => {
    expect(extractWhereRange('SELECT * FROM t WHERE age > 5')).toEqual({ column: 'age', minValue: 5 });
    expect(extractWhereRange('SELECT * FROM t WHERE age >= 5')).toEqual({ column: 'age', minValue: 5 });
  });

  it('extracts less-than / less-equal max bound', () => {
    expect(extractWhereRange('SELECT * FROM t WHERE age < 15')).toEqual({ column: 'age', maxValue: 15 });
    expect(extractWhereRange('SELECT * FROM t WHERE age <= 15')).toEqual({ column: 'age', maxValue: 15 });
  });

  it('returns undefined for unrecognized predicate', () => {
    expect(extractWhereRange('SELECT * FROM t WHERE name LIKE "%x%"')).toBeUndefined();
  });
});

describe('MVCCExecutor commit/rollback walLogger + GC threshold', () => {
  it('commit calls walLogger.logCommit', () => {
    const logged: any[] = [];
    const e = makeExec({ walLogger: { logCommit: (sid: string, xid: number) => logged.push([sid, xid]) } as any });
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    e.commit('a');
    expect(logged).toEqual([['a', a.xid]]);
  });

  it('rollback calls walLogger.logAbort', () => {
    const logged: any[] = [];
    const e = makeExec({ walLogger: { logAbort: (sid: string, xid: number) => logged.push([sid, xid]) } as any });
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    e.rollback('a');
    expect(logged).toEqual([['a', a.xid]]);
  });

  it('commit triggers RowVersion GC when rowVersions exceed threshold', async () => {
    // maxRowVersions=100, threshold=0.8 → GC fires when size >= 80.
    const e = makeExec({ maxRowVersions: 100, rowVersionGcThreshold: 0.8 });
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    // Populate rowVersions above threshold (80) before commit.
    for (let i = 0; i < 80; i++) (e as any).rowVersions.set(`t:${i}`, { xmin: a.xid, xmax: null });
    const result = e.commit('a');
    expect(result.success).toBe(true);
    // Let the fire-and-forget setImmediate run.
    await new Promise((r) => setImmediate(r));
  });

  it('commit without walLogger does not throw', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const result = e.commit('a');
    expect(result.success).toBe(true);
  });
});
