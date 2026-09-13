import { describe, it, expect } from 'vitest';
import { BlockingPidsShim } from '../query/BlockingPidsShim';

// BlockingPidsShim is a pure in-memory lock-contention registry (no SQL
// rewriting), so the tests lock its state-management contract exactly.
describe('BlockingPidsShim', () => {
  it('registers a blocking relationship and reports it', () => {
    const s = new BlockingPidsShim();
    s.registerBlocking(2, 1);
    expect(s.getBlockingPids(1)).toEqual([2]);
  });

  it('accumulates multiple holders for the same waiter (sorted)', () => {
    const s = new BlockingPidsShim();
    s.registerBlocking(5, 1);
    s.registerBlocking(3, 1);
    s.registerBlocking(4, 1);
    expect(s.getBlockingPids(1)).toEqual([3, 4, 5]);
  });

  it('returns an empty list for an unknown or unblocked PID', () => {
    const s = new BlockingPidsShim();
    expect(s.getBlockingPids(999)).toEqual([]);
  });

  it('unregisters a relationship and drops the waiter when empty', () => {
    const s = new BlockingPidsShim();
    s.registerBlocking(2, 1);
    s.unregisterBlocking(2, 1);
    expect(s.getBlockingPids(1)).toEqual([]);
    expect(s.getAllBlockingRelationships()).toEqual([]);
  });

  it('keeps the waiter entry when other holders remain', () => {
    const s = new BlockingPidsShim();
    s.registerBlocking(2, 1);
    s.registerBlocking(3, 1);
    s.unregisterBlocking(2, 1);
    // Size still > 0 → waiter entry is preserved with holder 3.
    expect(s.getBlockingPids(1)).toEqual([3]);
  });

  it('unregistering an unknown waiter is a no-op', () => {
    const s = new BlockingPidsShim();
    expect(() => s.unregisterBlocking(2, 999)).not.toThrow();
  });

  it('removeSession clears the PID as waiter and as holder', () => {
    const s = new BlockingPidsShim();
    s.registerBlocking(2, 1); // 2 blocks 1
    s.registerBlocking(3, 2); // 3 blocks 2
    s.removeSession(2);
    // 2 is gone as a waiter, and no longer appears as a holder for 1.
    expect(s.getBlockingPids(2)).toEqual([]);
    expect(s.getBlockingPids(1)).toEqual([]);
    // 3 → 2 relationship was removed because 2 (waiter) was removed.
    expect(s.getAllBlockingRelationships()).toEqual([]);
  });

  it('lists all blocking relationships with non-empty holders', () => {
    const s = new BlockingPidsShim();
    s.registerBlocking(2, 1);
    s.registerBlocking(3, 2);
    expect(s.getAllBlockingRelationships()).toEqual([
      { waiterPid: 1, holderPids: [2] },
      { waiterPid: 2, holderPids: [3] },
    ]);
  });

  it('detects a two-node deadlock cycle', () => {
    const s = new BlockingPidsShim();
    s.registerBlocking(2, 1); // 2 blocks 1
    s.registerBlocking(1, 2); // 1 blocks 2
    const cycles = s.detectDeadlocks();
    // Same cycle reported from both starting PIDs (simple detector contract).
    expect(cycles).toHaveLength(2);
    expect(cycles).toContainEqual([1, 2, 1]);
    expect(cycles).toContainEqual([2, 1, 2]);
  });

  it('detects no deadlock in a linear chain', () => {
    const s = new BlockingPidsShim();
    s.registerBlocking(3, 2);
    s.registerBlocking(2, 1);
    expect(s.detectDeadlocks()).toEqual([]);
  });

  it('does not re-walk a shared blocker (diamond) as a cycle', () => {
    const s = new BlockingPidsShim();
    // 2 and 3 both block 1; 4 blocks both 2 and 3 (diamond, no cycle).
    s.registerBlocking(2, 1);
    s.registerBlocking(3, 1);
    s.registerBlocking(4, 2);
    s.registerBlocking(4, 3);
    expect(s.detectDeadlocks()).toEqual([]);
  });

  it('clears all state', () => {
    const s = new BlockingPidsShim();
    s.registerBlocking(2, 1);
    s.clear();
    expect(s.getAllBlockingRelationships()).toEqual([]);
    expect(s.getBlockingPids(1)).toEqual([]);
  });
});
