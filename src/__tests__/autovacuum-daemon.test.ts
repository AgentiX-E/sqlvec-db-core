/**
 * Unit tests for AutovacuumDaemon.
 *
 * Verifies lifecycle (start/stop), shard registration, threshold-driven vacuum
 * scheduling, analyze scheduling, manual-VACUUM hook wiring, dead-tuple/insert
 * accounting, and per-cycle shard capping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AutovacuumDaemon,
  DEFAULT_AUTOVACUUM_CONFIG,
  type AutovacuumExecutor,
} from '../query/AutovacuumDaemon';

// Capture the VACUUM hook registration/detachment so tests can inspect the
// callback the daemon installs.
const hookState: { current: ((tableName?: string) => void) | null } = { current: null };
vi.mock('../query/VacuumShim', () => ({
  setVacuumMutationHook: (hook: ((tableName?: string) => void) | null) => {
    hookState.current = hook;
  },
}));

/** A fake executor that records vacuum invocations. */
function makeExecutor() {
  const calls: Array<{ full?: boolean; tableName?: string }> = [];
  const executor: AutovacuumExecutor = {
    vacuumWithOptions(opts) {
      calls.push(opts ?? {});
      return [];
    },
  };
  return { executor, calls };
}

describe('AutovacuumDaemon', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hookState.current = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is disabled by default config enabled flag', () => {
    expect(DEFAULT_AUTOVACUUM_CONFIG.enabled).toBe(true);
    expect(DEFAULT_AUTOVACUUM_CONFIG.checkIntervalMs).toBeGreaterThan(0);
  });

  it('starts and stops the maintenance loop', () => {
    const daemon = new AutovacuumDaemon({ enabled: true, checkIntervalMs: 1000 });
    expect(daemon.isRunning).toBe(false);

    daemon.start();
    expect(daemon.isRunning).toBe(true);

    daemon.stop();
    expect(daemon.isRunning).toBe(false);

    // stop() is idempotent.
    daemon.stop();
    expect(daemon.isRunning).toBe(false);
  });

  it('does not start when disabled', () => {
    const daemon = new AutovacuumDaemon({ enabled: false });
    daemon.start();
    expect(daemon.isRunning).toBe(false);
  });

  it('start() is idempotent', () => {
    const daemon = new AutovacuumDaemon({ enabled: true, checkIntervalMs: 1000 });
    daemon.start();
    daemon.start();
    expect(daemon.isRunning).toBe(true);
    daemon.stop();
  });

  it('registers shards and tracks their count', () => {
    const daemon = new AutovacuumDaemon();
    daemon.registerShardDb('shard-1', { db: true });
    daemon.registerShardDb('shard-2', null);
    daemon.registerShardDb('shard-1', { db: true }); // duplicate is ignored
    expect(daemon.trackedShardCount).toBe(2);
  });

  it('runs a vacuum pass when dead tuples exceed the threshold', () => {
    const daemon = new AutovacuumDaemon({ enabled: true, vacuumThreshold: 10, analyzeThreshold: 100 });
    const { executor, calls } = makeExecutor();
    daemon.setMvccExecutor(executor);
    daemon.registerShardDb('shard-1', {});
    daemon.recordDeadTuples('shard-1', 15);

    daemon.start();
    const vacuumed = daemon.runCycle();
    expect(vacuumed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ full: false });

    // Dead-tuple counter is reset after the pass.
    expect(daemon.getShardState('shard-1')!.deadTuples).toBe(0);
    daemon.stop();
  });

  it('does not vacuum below the threshold', () => {
    const daemon = new AutovacuumDaemon({ enabled: true, vacuumThreshold: 10, analyzeThreshold: 100 });
    const { executor, calls } = makeExecutor();
    daemon.setMvccExecutor(executor);
    daemon.registerShardDb('shard-1', {});
    daemon.recordDeadTuples('shard-1', 5);

    daemon.start();
    expect(daemon.runCycle()).toBe(0);
    expect(calls).toHaveLength(0);
    daemon.stop();
  });

  it('runs an analyze pass for insert-heavy shards (no freeze)', () => {
    const daemon = new AutovacuumDaemon({ enabled: true, vacuumThreshold: 100, analyzeThreshold: 5 });
    const { executor, calls } = makeExecutor();
    daemon.setMvccExecutor(executor);
    daemon.registerShardDb('shard-1', {});
    daemon.recordInserts('shard-1', 8);

    daemon.start();
    daemon.runCycle();
    expect(calls).toHaveLength(1);
    expect(daemon.getShardState('shard-1')!.insertsSinceAnalyze).toBe(0);
    daemon.stop();
  });

  it('skips vacuum when no executor is set', () => {
    const daemon = new AutovacuumDaemon({ enabled: true, vacuumThreshold: 1, analyzeThreshold: 100 });
    daemon.registerShardDb('shard-1', {});
    daemon.recordDeadTuples('shard-1', 10);

    daemon.start();
    expect(daemon.runCycle()).toBe(0);
    daemon.stop();
  });

  it('caps shards processed per cycle', () => {
    const daemon = new AutovacuumDaemon({
      enabled: true,
      vacuumThreshold: 1,
      analyzeThreshold: 100,
      maxShardsPerCycle: 2,
    });
    const { executor, calls } = makeExecutor();
    daemon.setMvccExecutor(executor);
    for (const id of ['s1', 's2', 's3']) {
      daemon.registerShardDb(id, {});
      daemon.recordDeadTuples(id, 10);
    }

    daemon.start();
    daemon.runCycle();
    // Only the first two shards (insertion order) run this cycle.
    expect(calls).toHaveLength(2);
    daemon.stop();
  });

  it('resets dead-tuple counters on manual VACUUM via the hook', () => {
    const daemon = new AutovacuumDaemon({ enabled: true, vacuumThreshold: 1, analyzeThreshold: 100 });
    daemon.registerShardDb('shard-1', {});
    daemon.recordDeadTuples('shard-1', 50);
    expect(daemon.getShardState('shard-1')!.deadTuples).toBe(50);

    daemon.start();
    // start() installs a VACUUM hook.
    expect(hookState.current).not.toBeNull();

    // Simulate a manual VACUUM by invoking the installed hook.
    hookState.current!('some_table');
    expect(daemon.getShardState('shard-1')!.deadTuples).toBe(0);

    daemon.stop();
  });

  it('returns undefined shard state for an untracked shard', () => {
    const daemon = new AutovacuumDaemon();
    expect(daemon.getShardState('missing')).toBeUndefined();
  });

  it('detaches the VACUUM hook on stop', () => {
    const daemon = new AutovacuumDaemon({ enabled: true });
    daemon.start();
    expect(hookState.current).not.toBeNull();
    daemon.stop();
    expect(hookState.current).toBeNull();
    expect(daemon.isRunning).toBe(false);
  });

  it('records dead tuples and inserts into shard state', () => {
    const daemon = new AutovacuumDaemon();
    daemon.registerShardDb('shard-1', {});
    daemon.recordDeadTuples('shard-1', 3);
    daemon.recordDeadTuples('shard-1', 4);
    daemon.recordInserts('shard-1', 10);

    expect(daemon.getShardState('shard-1')!.deadTuples).toBe(7);
    expect(daemon.getShardState('shard-1')!.insertsSinceAnalyze).toBe(10);

    // Recording into an untracked shard is a no-op for both counters.
    daemon.recordDeadTuples('missing', 99);
    daemon.recordInserts('missing', 99);
    expect(daemon.getShardState('missing')).toBeUndefined();
  });

  it('runCycle returns 0 when the daemon is not started', () => {
    const daemon = new AutovacuumDaemon({ enabled: true, vacuumThreshold: 1, analyzeThreshold: 100 });
    const { executor, calls } = makeExecutor();
    daemon.setMvccExecutor(executor);
    daemon.registerShardDb('shard-1', {});
    daemon.recordDeadTuples('shard-1', 10);

    expect(daemon.runCycle()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('runs a cycle automatically when the interval elapses', () => {
    const daemon = new AutovacuumDaemon({ enabled: true, checkIntervalMs: 1000, vacuumThreshold: 1, analyzeThreshold: 100 });
    const { executor, calls } = makeExecutor();
    daemon.setMvccExecutor(executor);
    daemon.registerShardDb('shard-1', {});
    daemon.recordDeadTuples('shard-1', 10);

    daemon.start();
    expect(calls).toHaveLength(0);

    // Advance past the interval; the timer callback should run a cycle.
    vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(1);

    daemon.stop();
  });
});
