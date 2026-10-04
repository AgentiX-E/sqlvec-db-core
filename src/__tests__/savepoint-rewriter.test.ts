/**
 * SavepointRewriter tests.
 *
 * Covers SavepointManager state transitions (savepoint/release/rollbackTo/
 * recordChange/getters/reset) and the statement detection/rewrite functions,
 * with emphasis on nested-savepoint cleanup and index-map integrity.
 */
import { describe, it, expect } from 'vitest';
import {
  SavepointManager,
  detectSavepointStmt,
  rewriteSavepointStmt,
} from '../query/SavepointRewriter';

describe('detectSavepointStmt', () => {
  it('detects SAVEPOINT', () => {
    expect(detectSavepointStmt('SAVEPOINT sp1')).toBe(true);
    expect(detectSavepointStmt('  savepoint sp1;')).toBe(true);
  });

  it('detects RELEASE [SAVEPOINT]', () => {
    expect(detectSavepointStmt('RELEASE sp1')).toBe(true);
    expect(detectSavepointStmt('RELEASE SAVEPOINT sp1')).toBe(true);
  });

  it('detects ROLLBACK TO [SAVEPOINT]', () => {
    expect(detectSavepointStmt('ROLLBACK TO sp1')).toBe(true);
    expect(detectSavepointStmt('ROLLBACK TO SAVEPOINT sp1')).toBe(true);
  });

  it('detects ROLLBACK WORK [TO [SAVEPOINT]]', () => {
    expect(detectSavepointStmt('ROLLBACK WORK')).toBe(true);
    expect(detectSavepointStmt('ROLLBACK WORK TO sp1')).toBe(true);
    expect(detectSavepointStmt('ROLLBACK WORK TO SAVEPOINT sp1')).toBe(true);
  });

  it('returns false for non-savepoint statements', () => {
    expect(detectSavepointStmt('SELECT * FROM t')).toBe(false);
    expect(detectSavepointStmt('COMMIT')).toBe(false);
    expect(detectSavepointStmt('BEGIN')).toBe(false);
    expect(detectSavepointStmt('INSERT INTO t VALUES (1)')).toBe(false);
  });

  it('returns false for a bare ROLLBACK without WORK/TO', () => {
    // `ROLLBACK;` on its own is a full-transaction rollback, not a savepoint
    // statement, and the detector (correctly) does not mark it as savepoint.
    expect(detectSavepointStmt('ROLLBACK;')).toBe(false);
  });

  it('returns false when the statement has no leading word', () => {
    // No leading \w token — firstWord extraction falls back to '' binding.
    expect(detectSavepointStmt('; begin')).toBe(false);
    expect(detectSavepointStmt('   ')).toBe(false);
  });
});

describe('rewriteSavepointStmt', () => {
  it('passes through savepoint statements unchanged with rewritten=true', () => {
    expect(rewriteSavepointStmt('SAVEPOINT sp1')).toEqual({
      sql: 'SAVEPOINT sp1',
      rewritten: true,
    });
  });

  it('returns rewritten=false for non-savepoint statements', () => {
    expect(rewriteSavepointStmt('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });
});

describe('SavepointManager', () => {
  it('tracks nesting depth and stack', () => {
    const m = new SavepointManager();
    expect(m.depth).toBe(0);
    m.savepoint('a');
    m.savepoint('b');
    expect(m.depth).toBe(2);
    expect(m.stack).toEqual(['a', 'b']);
  });

  it('records changes with the current savepoint level', () => {
    const m = new SavepointManager();
    m.recordChange('ch0');
    m.savepoint('a');
    m.recordChange('ch1', [1]);
    expect(m.getPendingChanges()).toEqual([
      { sql: 'ch0', params: undefined, savepointLevel: 0 },
      { sql: 'ch1', params: [1], savepointLevel: 1 },
    ]);
    expect(m.pendingCount).toBe(2);
  });

  it('rollbackTo discards changes recorded after the savepoint', () => {
    const m = new SavepointManager();
    m.recordChange('ch0');
    m.savepoint('a');
    m.recordChange('ch1');
    m.recordChange('ch2');
    m.rollbackTo('a');
    expect(m.getPendingChanges().map(c => c.sql)).toEqual(['ch0']);
    expect(m.depth).toBe(0);
  });

  it('rollbackTo is a no-op for an unknown savepoint', () => {
    const m = new SavepointManager();
    m.recordChange('ch0');
    m.rollbackTo('missing');
    expect(m.pendingCount).toBe(1);
    expect(m.getPendingChanges().map(c => c.sql)).toEqual(['ch0']);
  });

  it('release keeps changes but removes the savepoint boundary', () => {
    const m = new SavepointManager();
    m.recordChange('ch0');
    m.savepoint('a');
    m.recordChange('ch1');
    m.release('a');
    expect(m.depth).toBe(0);
    expect(m.stack).toEqual([]);
    // Changes are preserved on release (not discarded).
    expect(m.pendingCount).toBe(2);
  });

  it('release cleans up nested savepoint index entries (no stale map leak)', () => {
    const m = new SavepointManager();
    m.recordChange('ch0');
    m.savepoint('sp1');
    m.recordChange('ch1');
    m.savepoint('sp2');
    m.recordChange('ch2');
    m.release('sp1');
    expect(m.depth).toBe(0);
    // After releasing sp1 (which also releases nested sp2), a rollback to a
    // nested savepoint must NOT find a stale entry.
    m.rollbackTo('sp2');
    expect(m.pendingCount).toBe(3); // unchanged — sp2 was already released
  });

  it('rollbackTo removes nested savepoint map entries', () => {
    const m = new SavepointManager();
    m.savepoint('sp1');
    m.savepoint('sp2');
    m.savepoint('sp3');
    m.rollbackTo('sp1');
    expect(m.depth).toBe(0);
    // Rollback to sp1 releases sp3+sp2+sp1; later rollback to sp2 is a no-op.
    m.recordChange('after');
    m.rollbackTo('sp2');
    expect(m.pendingCount).toBe(1); // 'after' survives, sp2 not found
  });

  it('supports partial commit via getChangesUpToLevel', () => {
    const m = new SavepointManager();
    m.recordChange('ch0');
    m.savepoint('a');
    m.recordChange('ch1');
    expect(m.getChangesUpToLevel(0).map(c => c.sql)).toEqual(['ch0']);
    expect(m.getChangesUpToLevel(1).map(c => c.sql)).toEqual(['ch0', 'ch1']);
  });

  it('supports getChangesOutsideLevel', () => {
    const m = new SavepointManager();
    m.recordChange('ch0');
    m.savepoint('a');
    m.recordChange('ch1');
    m.savepoint('b');
    m.recordChange('ch2');
    expect(m.getChangesOutsideLevel(1).map(c => c.sql)).toEqual(['ch0', 'ch2']);
  });

  it('clears changes', () => {
    const m = new SavepointManager();
    m.recordChange('ch0');
    m.clearChanges();
    expect(m.pendingCount).toBe(0);
  });

  it('reset clears stack, changes, and index map', () => {
    const m = new SavepointManager();
    m.savepoint('a');
    m.recordChange('ch0');
    m.reset();
    expect(m.depth).toBe(0);
    expect(m.pendingCount).toBe(0);
    expect(m.stack).toEqual([]);
  });
});

describe('SavepointManager edge coverage', () => {
  it('release of an unknown name is a safe no-op (else branch)', () => {
    const m = new SavepointManager();
    m.savepoint('a');
    m.release('nonexistent');
    expect(m.depth).toBe(1); // 'a' unaffected
    expect(m.stack).toEqual(['a']);
  });

  it('rollbackTo when savepoint has no subsequent changes (index >= length)', () => {
    const m = new SavepointManager();
    m.recordChange('ch0');
    m.savepoint('a');       // savepoint recorded with no pending changes after it
    m.rollbackTo('a');      // savedIndex == pendingChanges.length
    expect(m.depth).toBe(0);
    expect(m.pendingCount).toBe(1); // ch0 preserved (nothing to discard)
  });

  it('detectSavepointStmt handles SAVEPOINT as the first keyword (fast-path false)', () => {
    expect(detectSavepointStmt('SAVEPOINT x')).toBe(true);
    expect(detectSavepointStmt('SAVEPOINTX')).toBe(false); // not a real statement
  });
});

describe('SavepointManager invariants', () => {
  it('keeps stack and index map in lockstep across nested operations', () => {
    const m = new SavepointManager();
    const ops = [
      () => m.savepoint('sp1'),
      () => m.recordChange('c1'),
      () => m.savepoint('sp2'),
      () => m.recordChange('c2'),
      () => m.savepoint('sp3'),
      () => m.recordChange('c3'),
      () => m.release('sp3'),
      () => m.rollbackTo('sp1'),
      () => m.savepoint('sp4'),
      () => m.recordChange('c4'),
    ];
    ops.forEach(op => op());
    // Invariant: any name in the index map is also present in the stack.
    const map = (m as any).savepointIndexMap as Map<string, number>;
    const stack = (m as any).savepointStack as string[];
    for (const [name] of map) {
      expect(stack).toContain(name);
    }
    // And vice versa (stack has no name missing from the map).
    for (const name of stack) {
      expect(map.has(name)).toBe(true);
    }
  });
});
