/**
 * periodic-checkpointer.test.ts — Coverage for the PeriodicCheckpointer
 * background WAL-checkpoint timer.
 *
 * The class is a thin wrapper around setInterval/clearInterval that issues
 * `PRAGMA wal_checkpoint(TRUNCATE)` on a cadence and tolerates concurrent-write
 * failures. Previously the start()/stop() guards (`already started`, `unref`,
 * `stop when no timer`) were uncovered. These tests drive them with fake
 * timers and a minimal in-memory SQLite database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PeriodicCheckpointer } from '../storage/PeriodicCheckpointer';

describe('PeriodicCheckpointer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    try { db.close(); } catch {}
  });

  it('issues a checkpoint once started and a tick elapses', () => {
    const pragmaSpy = vi.spyOn(db, 'pragma');
    const cp = new PeriodicCheckpointer(db, 500);
    cp.start();
    vi.advanceTimersByTime(500);
    expect(pragmaSpy).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
    cp.stop();
  });

  it('start() is idempotent — a second start does not add a second timer', () => {
    const cp = new PeriodicCheckpointer(db, 500);
    cp.start();
    // A second start must return early (the `already started` guard); the
    // interval is still ticking once, so advancing one period fires once.
    cp.start();
    const pragmaSpy = vi.spyOn(db, 'pragma');
    vi.advanceTimersByTime(500);
    expect(pragmaSpy).toHaveBeenCalledTimes(1);
    cp.stop();
  });

  it('stop() is safe when no timer is active', () => {
    const cp = new PeriodicCheckpointer(db, 500);
    // stop() before start() must not throw.
    expect(() => cp.stop()).not.toThrow();
  });

  it('suppresses checkpoint failures caused by concurrent writes', () => {
    // A checkpoint that throws (simulating a busy writer) must be swallowed.
    vi.spyOn(db, 'pragma').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const cp = new PeriodicCheckpointer(db, 500);
    cp.start();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    cp.stop();
  });

  it('tolerates a timer handle without an unref method', () => {
    // Node's setInterval return value always has unref(), but a different
    // runtime may return a plain numeric/string handle. start() must not
    // throw when `unref` is absent (the defensive `'unref' in timer` check).
    const realSetInterval = globalThis.setInterval.bind(globalThis);
    const fakeTimer = { _fake: true } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(fakeTimer as any);
    const cp = new PeriodicCheckpointer(db, 500);
    expect(() => cp.start()).not.toThrow();
    // Clear the fake timer without relying on its (absent) unref semantics.
    vi.restoreAllMocks();
    cp.stop();
  });
});
