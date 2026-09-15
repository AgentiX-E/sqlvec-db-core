import { describe, it, expect, beforeEach } from 'vitest';
import { GucSystem } from '../core/GucSystem';
import { DatabaseError } from '../errors/DatabaseError';
import {
  detectSerializable,
  rewriteSerializable,
  setDefaultIsolation,
  checkWriteSkew,
} from '../query/SerializableShim';

describe('detectSerializable', () => {
  it('detects SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', () => {
    expect(detectSerializable('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toBe(true);
  });

  it('detects SESSION and LOCAL transaction variants', () => {
    expect(detectSerializable('SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toBe(true);
    expect(detectSerializable('SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toBe(true);
  });

  it('detects SESSION CHARACTERISTICS form', () => {
    expect(
      detectSerializable('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE'),
    ).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectSerializable('set transaction isolation level serializable')).toBe(true);
  });

  it('returns false for non-SERIALIZABLE isolation', () => {
    expect(detectSerializable('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')).toBe(false);
    expect(detectSerializable('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')).toBe(false);
  });

  it('returns false for string-literal and identifier false positives', () => {
    expect(detectSerializable("SELECT 'SERIALIZABLE'")).toBe(false);
    expect(detectSerializable('SELECT serializable FROM t')).toBe(false);
  });

  it('returns false for empty and non-string input', () => {
    expect(detectSerializable('')).toBe(false);
    expect(detectSerializable('   ')).toBe(false);
    expect(detectSerializable(undefined as unknown as string)).toBe(false);
  });
});

describe('rewriteSerializable', () => {
  let guc: GucSystem;

  beforeEach(() => {
    guc = GucSystem.getInstance();
    guc.registry.resetAllToDefaults();
  });

  it('preserves transaction-level SERIALIZABLE unchanged', () => {
    const r = rewriteSerializable('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    expect(r).toEqual({
      sql: 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      rewritten: false,
    });
    expect(guc.registry.get('transaction_isolation')?.value).toBe('serializable');
  });

  it('preserves SESSION/LOCAL transaction variants', () => {
    expect(rewriteSerializable('SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toEqual({
      sql: 'SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      rewritten: false,
    });
    expect(rewriteSerializable('SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toEqual({
      sql: 'SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      rewritten: false,
    });
  });

  it('strips SESSION CHARACTERISTICS form and stores isolation', () => {
    const r = rewriteSerializable(
      'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    );
    expect(r).toEqual({ sql: '', rewritten: true });
    expect(guc.registry.get('default_transaction_isolation')?.value).toBe('serializable');
    expect(guc.registry.get('transaction_isolation')?.value).toBe('serializable');
  });

  it('passes through non-SERIALIZABLE isolation', () => {
    const r = rewriteSerializable('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    expect(r).toEqual({
      sql: 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      rewritten: false,
    });
  });

  it('passes through unrelated SQL', () => {
    const r = rewriteSerializable('SELECT * FROM t');
    expect(r).toEqual({ sql: 'SELECT * FROM t', rewritten: false });
  });

  it('returns empty sql for empty/non-string input', () => {
    expect(rewriteSerializable('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteSerializable('   ')).toEqual({ sql: '   ', rewritten: false });
    expect(rewriteSerializable(undefined as unknown as string)).toEqual({
      sql: '',
      rewritten: false,
    });
  });
});

describe('setDefaultIsolation', () => {
  it('returns SERIALIZABLE', () => {
    expect(setDefaultIsolation()).toBe('SERIALIZABLE');
  });
});

describe('checkWriteSkew', () => {
  it('returns false for an empty read set', () => {
    expect(checkWriteSkew(new Map(), new Set(), 1, 0, new Set(), new Set())).toBe(false);
  });

  it('skips keys this txn also wrote', () => {
    const rv = new Map<string, { xmin: number; xmax: number | null }>();
    rv.set('t:1', { xmin: 5, xmax: null });
    // readKeys contains t:1, but writeKeys also has it → skipped, no anomaly
    expect(checkWriteSkew(rv, new Set([5]), 9, 4, new Set(['t:1']), new Set(['t:1']))).toBe(false);
  });

  it('skips keys with no current row version', () => {
    const rv = new Map<string, { xmin: number; xmax: number | null }>();
    // readKeys references t:missing, not present in rowVersions → skipped
    expect(checkWriteSkew(rv, new Set(), 9, 4, new Set(['t:missing']), new Set())).toBe(false);
  });

  it('skips rows written by this txn (xmin === txnXid)', () => {
    const rv = new Map<string, { xmin: number; xmax: number | null }>();
    rv.set('t:1', { xmin: 9, xmax: null });
    expect(checkWriteSkew(rv, new Set(), 9, 4, new Set(['t:1']), new Set())).toBe(false);
  });

  it('returns false when concurrent modifications are not by active txns', () => {
    const rv = new Map<string, { xmin: number; xmax: number | null }>();
    // xmin 5 > snapshot 4 but 5 is NOT in activeXidSet → no anomaly
    rv.set('t:1', { xmin: 5, xmax: null });
    expect(checkWriteSkew(rv, new Set(), 9, 4, new Set(['t:1']), new Set())).toBe(false);
  });

  it('throws on a row modified by an active concurrent txn', () => {
    const rv = new Map<string, { xmin: number; xmax: number | null }>();
    rv.set('t:1', { xmin: 5, xmax: null });
    expect(() =>
      checkWriteSkew(rv, new Set([5]), 9, 4, new Set(['t:1']), new Set()),
    ).toThrow(DatabaseError);
  });

  it('throws on a row deleted by an active concurrent txn', () => {
    const rv = new Map<string, { xmin: number; xmax: number | null }>();
    rv.set('t:1', { xmin: 1, xmax: 7 });
    expect(() =>
      checkWriteSkew(rv, new Set([7]), 9, 4, new Set(['t:1']), new Set()),
    ).toThrowError(/serialization_anomaly/);
  });

  it('throws with SQLSTATE 40001', () => {
    const rv = new Map<string, { xmin: number; xmax: number | null }>();
    rv.set('t:1', { xmin: 5, xmax: null });
    try {
      checkWriteSkew(rv, new Set([5]), 9, 4, new Set(['t:1']), new Set());
    } catch (e) {
      expect((e as DatabaseError).sqlstate).toBe('40001');
    }
  });
});
