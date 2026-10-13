import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WaitSamplingShim,
  type WaitEventSample,
  type LockManagerLike,
  type SessionManagerLike,
} from '../query/WaitSamplingShim';

function lockManager(overrides: Partial<LockManagerLike> = {}): LockManagerLike {
  return { ...overrides };
}

function sessionManager(overrides: Partial<SessionManagerLike> = {}): SessionManagerLike {
  return { ...overrides };
}

describe('WaitSamplingShim basic tracking', () => {
  let shim: WaitSamplingShim;
  beforeEach(() => { shim = new WaitSamplingShim(); });

  it('records and retrieves an activity entry', () => {
    shim.recordActivity(100, { pid: 100, state: 'active', query: 'SELECT 1' });
    const w = shim.getWaitEvent(100);
    expect(w?.state).toBe('active');
    expect(shim.getActivityCount()).toBe(1);
  });

  it('merges partial updates via recordActivity', () => {
    shim.recordActivity(100, { pid: 100, state: 'idle' });
    shim.recordActivity(100, { query: 'SELECT 2' });
    const w = shim.getWaitEvent(100);
    expect(w?.state).toBe('idle'); // unchanged
    // query is not part of getWaitEvent, but activity retains it
    const samples = shim.sample();
    expect(samples[0].query).toBe('SELECT 2');
  });

  it('removes an activity', () => {
    shim.recordActivity(100, { pid: 100 });
    shim.removeActivity(100);
    expect(shim.getWaitEvent(100)).toBeNull();
    expect(shim.getActivityCount()).toBe(0);
  });

  it('records and clears lock wait', () => {
    shim.recordLockWait(1, 'relation');
    let w = shim.getWaitEvent(1);
    expect(w?.wait_event_type).toBe('Lock');
    expect(w?.wait_event).toBe('relation');
    expect(w?.wait_start).not.toBeNull();
    shim.clearWait(1);
    w = shim.getWaitEvent(1);
    expect(w?.wait_event_type).toBeNull();
    expect(w?.wait_event).toBeNull();
  });

  it('records I/O wait', () => {
    shim.recordIOWait(2, 'WALWrite');
    const w = shim.getWaitEvent(2);
    expect(w?.wait_event_type).toBe('IO');
    expect(w?.wait_event).toBe('WALWrite');
  });

  it('clearWait is a no-op on unknown pid', () => {
    expect(() => shim.clearWait(999)).not.toThrow();
  });

  it('defaults state to active in getWaitEvent', () => {
    shim.recordActivity(3, { pid: 3, query: 'x' }); // no state
    expect(shim.getWaitEvent(3)?.state).toBe('active');
  });

  it('clear resets everything', () => {
    shim.recordLockWait(1, 'tuple');
    shim.sample();
    shim.clear();
    expect(shim.getActivityCount()).toBe(0);
    expect(shim.getActivity()).toEqual([]);
  });
});

describe('WaitSamplingShim.sample', () => {
  let shim: WaitSamplingShim;

  beforeEach(() => {
    shim = new WaitSamplingShim(1000);
  });

  it('returns empty array with no data', () => {
    expect(shim.sample()).toEqual([]);
  });

  it('builds a sample from a tracked activity with null waits', () => {
    shim.recordActivity(5, { pid: 5, state: 'idle in transaction', query: 'BEGIN' });
    const rows = shim.sample();
    expect(rows).toHaveLength(1);
    expect(rows[0].wait_event_type).toBeNull();
    expect(rows[0].wait_event).toBeNull();
    expect(rows[0].state).toBe('idle in transaction');
    expect(rows[0].query).toBe('BEGIN');
  });

  it('uses getWaitForGraph to surface lock waits', () => {
    const wfg = new Map<string, Set<string>>();
    wfg.set('s101', new Set(['s102']));
    const lm = lockManager({ getWaitForGraph: () => wfg });
    shim.sample(lm);
    const w = shim.getWaitEvent(101);
    expect(w?.wait_event_type).toBe('Lock');
    expect(w?.wait_event).toBe('tuple');
  });

  it('ignores non-numeric session ids in wait-for graph', () => {
    const wfg = new Map<string, Set<string>>();
    wfg.set('session_abc', new Set()); // no digits -> pid 0
    const lm = lockManager({ getWaitForGraph: () => wfg });
    shim.sample(lm);
    expect(shim.getActivityCount()).toBe(0);
  });

  it('falls back to getWaitInfo when getWaitForGraph is absent', () => {
    const lm = lockManager({
      getWaitInfo: () => [{ sessionId: 's42', waitingFor: 'x', lockKey: 'relation' }],
    });
    shim.sample(lm);
    const w = shim.getWaitEvent(42);
    expect(w?.wait_event).toBe('relation');
  });

  it('uses default "tuple" when getWaitInfo lockKey is empty', () => {
    const lm = lockManager({
      getWaitInfo: () => [{ sessionId: 's7', waitingFor: 'x', lockKey: '' }],
    });
    shim.sample(lm);
    expect(shim.getWaitEvent(7)?.wait_event).toBe('tuple');
  });

  it('uses getLockInfo to mark ungranted locks as waits', () => {
    const lm = lockManager({
      getLockInfo: () => [
        { sessionId: 's9', mode: 'AccessExclusiveLock', granted: false },
        { sessionId: 's10', mode: 'RowShareLock', granted: true }, // granted -> skip
      ],
    });
    shim.sample(lm);
    expect(shim.getWaitEvent(9)?.wait_event_type).toBe('Lock');
    expect(shim.getWaitEvent(9)?.wait_event).toBe('accessexclusivelock');
    expect(shim.getActivityCount()).toBe(1); // only ungranted one recorded
  });

  it('uses "tuple" when getLockInfo mode is undefined', () => {
    const lm = lockManager({
      getLockInfo: () => [{ sessionId: 's11', mode: undefined, granted: false }],
    });
    shim.sample(lm);
    expect(shim.getWaitEvent(11)?.wait_event).toBe('tuple');
  });

  it('collects sessions from a session manager', () => {
    const sm = sessionManager({
      getAllSessions: () => [
        { getPid: () => 200, isActive: () => true, getState: () => 'active' },
        { getPid: () => 201, isActive: () => false, getState: () => 'idle' },
      ],
    });
    shim.sample(undefined, sm);
    const samples = shim.sample(undefined, sm);
    // after first sample fills cache, force fresh via invalidate inside? call again is cached
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(shim.getWaitEvent(200)?.state).toBe('active');
    expect(shim.getWaitEvent(201)?.state).toBe('idle');
  });

  it('infers idle state from isActive when getState is absent', () => {
    const sm = sessionManager({
      getAllSessions: () => [{ getPid: () => 300, isActive: () => false }],
    });
    shim.sample(undefined, sm);
    expect(shim.getWaitEvent(300)?.state).toBe('idle');
  });

  it('does not overwrite a lock wait with a session entry', () => {
    // session pid already recorded as lock waiter -> skip in session loop
    const lm = lockManager({ getWaitForGraph: () => new Map([['s400', new Set()]]) });
    const sm = sessionManager({
      getAllSessions: () => [{ getPid: () => 400, isActive: () => true }],
    });
    shim.sample(lm, sm);
    expect(shim.getWaitEvent(400)?.wait_event_type).toBe('Lock');
  });

  it('returns cached samples within the sampling interval', () => {
    shim.recordActivity(1, { pid: 1, state: 'active' });
    const first = shim.sample();
    shim.recordActivity(2, { pid: 2, state: 'active' });
    const second = shim.sample(); // should be cached (same content as first)
    expect(second).toEqual(first);
  });

  it('refreshes after invalidateSampleCache', () => {
    shim.recordActivity(1, { pid: 1, state: 'active' });
    shim.sample();
    shim.recordActivity(2, { pid: 2, state: 'active' });
    shim.invalidateSampleCache();
    const rows = shim.sample();
    expect(rows).toHaveLength(2);
  });

  it('tracks lastSampleTime via getSamplingConfig', () => {
    expect(shim.getSamplingConfig().interval).toBe(1000);
    expect(shim.getSamplingConfig().lastSampleTime).toBe(0);
    shim.recordActivity(1, { pid: 1 });
    shim.sample();
    expect(shim.getSamplingConfig().lastSampleTime).toBeGreaterThan(0);
  });
});

describe('WaitSamplingShim defensive branches', () => {
  let shim: WaitSamplingShim;
  beforeEach(() => { shim = new WaitSamplingShim(1000); });

  it('handles a null wait-for graph', () => {
    const lm = lockManager({ getWaitForGraph: () => null });
    expect(() => shim.sample(lm)).not.toThrow();
    expect(shim.getActivityCount()).toBe(0);
  });

  it('handles an empty wait-for graph', () => {
    const lm = lockManager({ getWaitForGraph: () => new Map() });
    shim.sample(lm);
    expect(shim.getActivityCount()).toBe(0);
  });

  it('updates an existing activity with a lock wait (preserves query)', () => {
    shim.recordActivity(101, { pid: 101, state: 'active', query: 'SELECT 1' });
    const wfg = new Map([['s101', new Set()]]);
    shim.sample(lockManager({ getWaitForGraph: () => wfg }));
    const w = shim.getWaitEvent(101);
    expect(w?.wait_event_type).toBe('Lock');
    expect(w?.wait_event).toBe('tuple');
    // query preserved via merge
    expect(shim.sample().find((r) => r.pid === 101)?.query).toBe('SELECT 1');
  });

  it('handles null/empty getWaitInfo', () => {
    expect(() => shim.sample(lockManager({ getWaitInfo: () => null }))).not.toThrow();
    expect(() => shim.sample(lockManager({ getWaitInfo: () => [] }))).not.toThrow();
  });

  it('falls back to 0 for a non-numeric getWaitInfo sessionId', () => {
    const lm = lockManager({
      getWaitInfo: () => [{ sessionId: 'no-digits-here', waitingFor: 'x', lockKey: 'relation' }],
    });
    shim.sample(lm);
    expect(shim.getActivityCount()).toBe(0);
  });

  it('skips an already-seen getWaitInfo pid', () => {
    const lm = lockManager({
      getWaitForGraph: () => new Map([['s55', new Set(['s56'])]]),
      getWaitInfo: () => [{ sessionId: 's55', waitingFor: 'x', lockKey: 'tuple' }],
    });
    shim.sample(lm);
    expect(shim.getWaitEvent(55)?.wait_event).toBe('tuple'); // from graph
  });

  it('updates an existing getWaitInfo pid with the reported lock key', () => {
    shim.recordActivity(60, { pid: 60, state: 'idle', query: 'BEGIN' });
    const lm = lockManager({
      getWaitInfo: () => [{ sessionId: 's60', waitingFor: 'x', lockKey: 'relation' }],
    });
    shim.sample(lm);
    expect(shim.getWaitEvent(60)?.wait_event_type).toBe('Lock');
    expect(shim.getWaitEvent(60)?.wait_event).toBe('relation');
  });

  it('handles a null getLockInfo', () => {
    const lm = lockManager({ getLockInfo: () => null });
    expect(() => shim.sample(lm)).not.toThrow();
  });

  it('ignores a non-numeric getLockInfo sessionId', () => {
    const lm = lockManager({
      getLockInfo: () => [{ sessionId: 'abc', mode: 'ExclusiveLock', granted: false }],
    });
    shim.sample(lm);
    expect(shim.getActivityCount()).toBe(0);
  });

  it('handles a null session list', () => {
    const sm = sessionManager({ getAllSessions: () => null });
    expect(() => shim.sample(undefined, sm)).not.toThrow();
  });

  it('skips sessions without getPid', () => {
    const sm = sessionManager({
      getAllSessions: () => [{ getPid: undefined, isActive: () => true }],
    });
    shim.sample(undefined, sm);
    expect(shim.getActivityCount()).toBe(0);
  });

  it('defaults isActive to true when absent', () => {
    const sm = sessionManager({
      getAllSessions: () => [{ getPid: () => 700 }], // no isActive
    });
    shim.sample(undefined, sm);
    const w = shim.getWaitEvent(700);
    expect(w?.state).toBe('active');
  });

  it('uses isActive fallback (active) when getState is absent and isActive true', () => {
    const sm = sessionManager({
      getAllSessions: () => [{ getPid: () => 701, isActive: () => true }],
    });
    shim.sample(undefined, sm);
    expect(shim.getWaitEvent(701)?.state).toBe('active');
  });

  it('skips sessions whose pid is already tracked', () => {
    shim.recordLockWait(800, 'tuple');
    const sm = sessionManager({
      getAllSessions: () => [{ getPid: () => 800, isActive: () => true }],
    });
    shim.sample(undefined, sm);
    expect(shim.getWaitEvent(800)?.wait_event_type).toBe('Lock');
  });
});

describe('WaitSamplingShim.getActivity', () => {
  it('returns cached samples when present', () => {
    const shim = new WaitSamplingShim(1000);
    shim.recordActivity(1, { pid: 1, state: 'active' });
    const a = shim.getActivity(); // triggers sample -> caches
    expect(a).toHaveLength(1);
    // adding data doesn't change cached result
    shim.recordActivity(2, { pid: 2 });
    expect(shim.getActivity()).toHaveLength(1);
  });

  it('samples when cache is empty', () => {
    const shim = new WaitSamplingShim(1000);
    const a = shim.getActivity();
    expect(Array.isArray(a)).toBe(true);
  });
});

describe('WaitSamplingShim constructor interval', () => {
  it('accepts a custom interval', () => {
    const shim = new WaitSamplingShim(5000);
    expect(shim.getSamplingConfig().interval).toBe(5000);
  });
});
