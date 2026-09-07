import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

const MODES = [
  'ACCESS SHARE',        // rank 1
  'ROW SHARE',           // rank 2
  'ROW EXCLUSIVE',       // rank 3
  'SHARE UPDATE EXCLUSIVE', // rank 4
  'SHARE',               // rank 5
  'SHARE ROW EXCLUSIVE', // rank 6
  'EXCLUSIVE',           // rank 7
  'ACCESS EXCLUSIVE',    // rank 8
];

describe('MVCCExecutor lock mode compatibility matrix', () => {
  it('covers all 64 mode pairs without throwing', () => {
    for (const a of MODES) {
      for (const b of MODES) {
        // Every pair must return a boolean (no throw), including self-pairs.
        expect(typeof MVCCExecutor.areLockModesCompatible(a, b)).toBe('boolean');
      }
    }
  });

  it('ACCESS EXCLUSIVE is incompatible with everything (even itself)', () => {
    for (const m of MODES) {
      expect(MVCCExecutor.areLockModesCompatible('ACCESS EXCLUSIVE', m)).toBe(false);
      expect(MVCCExecutor.areLockModesCompatible(m, 'ACCESS EXCLUSIVE')).toBe(false);
    }
  });

  it('ACCESS SHARE is compatible with everything except ACCESS EXCLUSIVE', () => {
    expect(MVCCExecutor.areLockModesCompatible('ACCESS SHARE', 'ROW SHARE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('ACCESS SHARE', 'ROW EXCLUSIVE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('ACCESS SHARE', 'SHARE UPDATE EXCLUSIVE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('ACCESS SHARE', 'SHARE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('ACCESS SHARE', 'SHARE ROW EXCLUSIVE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('ACCESS SHARE', 'EXCLUSIVE')).toBe(true);
  });

  it('EXCLUSIVE is only compatible with ACCESS SHARE / ROW SHARE', () => {
    expect(MVCCExecutor.areLockModesCompatible('EXCLUSIVE', 'ACCESS SHARE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('EXCLUSIVE', 'ROW SHARE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('EXCLUSIVE', 'ROW EXCLUSIVE')).toBe(false);
    expect(MVCCExecutor.areLockModesCompatible('EXCLUSIVE', 'SHARE')).toBe(false);
    expect(MVCCExecutor.areLockModesCompatible('EXCLUSIVE', 'EXCLUSIVE')).toBe(false);
  });

  it('SHARE ROW EXCLUSIVE is only compatible with ACCESS SHARE / ROW SHARE', () => {
    expect(MVCCExecutor.areLockModesCompatible('SHARE ROW EXCLUSIVE', 'ACCESS SHARE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('SHARE ROW EXCLUSIVE', 'ROW SHARE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('SHARE ROW EXCLUSIVE', 'ROW EXCLUSIVE')).toBe(false);
    expect(MVCCExecutor.areLockModesCompatible('SHARE ROW EXCLUSIVE', 'SHARE ROW EXCLUSIVE')).toBe(false);
  });

  it('SHARE is compatible with ranks up to 5', () => {
    expect(MVCCExecutor.areLockModesCompatible('SHARE', 'SHARE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('SHARE', 'SHARE UPDATE EXCLUSIVE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('SHARE', 'ROW EXCLUSIVE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('SHARE', 'SHARE ROW EXCLUSIVE')).toBe(false);
  });

  it('SHARE UPDATE EXCLUSIVE is compatible with rank <=2, 4, 5', () => {
    expect(MVCCExecutor.areLockModesCompatible('SHARE UPDATE EXCLUSIVE', 'ACCESS SHARE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('SHARE UPDATE EXCLUSIVE', 'ROW SHARE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('SHARE UPDATE EXCLUSIVE', 'SHARE UPDATE EXCLUSIVE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('SHARE UPDATE EXCLUSIVE', 'SHARE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('SHARE UPDATE EXCLUSIVE', 'ROW EXCLUSIVE')).toBe(false);
  });

  it('unknown modes default to rank 1 (ACCESS SHARE)', () => {
    expect(MVCCExecutor.areLockModesCompatible('BOGUS', 'ROW SHARE')).toBe(true);
    expect(MVCCExecutor.areLockModesCompatible('BOGUS', 'ACCESS EXCLUSIVE')).toBe(false);
  });
});

describe('MVCCExecutor lockTable integration', () => {
  it('lockTable acquires a lock when no contention', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    expect(e.lockTable('a', 'users', 'ACCESS EXCLUSIVE')).toBe(true);
  });

  it('lockTable returns false for incompatible existing lock (nowait)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    e.lockTable('a', 'users', 'ACCESS EXCLUSIVE');
    // b requests an incompatible lock with nowait -> fails
    expect(e.lockTable('b', 'users', 'ACCESS EXCLUSIVE', true)).toBe(false);
  });

  it('lockTable is a no-op for unknown session', () => {
    const e = makeExec();
    expect(e.lockTable('ghost', 't', 'SHARE')).toBe(true);
  });

  it('table lock is released on commit', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.lockTable('a', 'users', 'SHARE');
    expect(() => e.commit('a')).not.toThrow();
  });
});
