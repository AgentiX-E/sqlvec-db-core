/**
 * Unit tests for the idle-in-transaction timeout manager.
 *
 * Uses Vitest fake timers to deterministically verify that timers fire exactly
 * once, that `cancel`/`cancelTimer`/`cancelAll` disarm them, and that a
 * `timeoutMs <= 0` manager is disabled (the previous stub never armed or fired
 * a timer at all — BUG #160).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IdleTxnTimeoutManager,
  DEFAULT_IDLE_TXN_TIMEOUT_MS,
} from '../protocol/IdleTxnTimeout';

describe('IdleTxnTimeoutManager — constants & factory', () => {
  it('default timeout is 0 (disabled)', () => {
    expect(DEFAULT_IDLE_TXN_TIMEOUT_MS).toBe(0);
  });

  it('getInstance returns a singleton', () => {
    expect(IdleTxnTimeoutManager.getInstance()).toBe(
      IdleTxnTimeoutManager.getInstance(),
    );
  });
});

describe('IdleTxnTimeoutManager — disabled (timeoutMs <= 0)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not arm a timer when timeoutMs is 0', () => {
    const mgr = new IdleTxnTimeoutManager(0);
    const cb = vi.fn();
    mgr.startTimer('s1', undefined, cb);
    expect(mgr.activeTimers).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('returns a no-op cancel handle when disabled', () => {
    const mgr = new IdleTxnTimeoutManager(-1);
    const handle = mgr.startTimer('s1', undefined, vi.fn());
    expect(() => handle.cancel()).not.toThrow();
    expect(mgr.activeTimers).toBe(0);
  });
});

describe('IdleTxnTimeoutManager — arming & firing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires the callback once after the timeout elapses', () => {
    const mgr = new IdleTxnTimeoutManager(500);
    const cb = vi.fn();
    mgr.startTimer('s1', undefined, cb);
    expect(mgr.activeTimers).toBe(1);
    expect(mgr.hasActiveTimers).toBe(true);

    vi.advanceTimersByTime(499);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('s1');

    // Timer is removed after firing.
    expect(mgr.activeTimers).toBe(0);
  });

  it('does not fire before the timeout', () => {
    const mgr = new IdleTxnTimeoutManager(1000);
    const cb = vi.fn();
    mgr.startTimer('s1', undefined, cb);
    vi.advanceTimersByTime(999);
    expect(cb).not.toHaveBeenCalled();
  });

  it('calls the callback with the correct session id', () => {
    const mgr = new IdleTxnTimeoutManager(10);
    const cb = vi.fn();
    mgr.startTimer('alice', undefined, cb);
    vi.advanceTimersByTime(10);
    expect(cb).toHaveBeenCalledWith('alice');
  });
});

describe('IdleTxnTimeoutManager — cancellation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('cancelTimer disarms a session timer', () => {
    const mgr = new IdleTxnTimeoutManager(100);
    const cb = vi.fn();
    mgr.startTimer('s1', undefined, cb);
    mgr.cancelTimer('s1');
    expect(mgr.activeTimers).toBe(0);
    vi.advanceTimersByTime(200);
    expect(cb).not.toHaveBeenCalled();
  });

  it('cancelTimer is a no-op for an unknown session', () => {
    const mgr = new IdleTxnTimeoutManager(100);
    expect(() => mgr.cancelTimer('nope')).not.toThrow();
  });

  it('the returned handle.cancel disarms the timer', () => {
    const mgr = new IdleTxnTimeoutManager(100);
    const cb = vi.fn();
    const handle = mgr.startTimer('s1', undefined, cb);
    handle.cancel();
    vi.advanceTimersByTime(200);
    expect(cb).not.toHaveBeenCalled();
    expect(mgr.activeTimers).toBe(0);
  });

  it('re-arming the same session replaces the previous timer', () => {
    const mgr = new IdleTxnTimeoutManager(1000);
    const cb = vi.fn();
    mgr.startTimer('s1', undefined, cb);
    mgr.startTimer('s1', undefined, cb);
    expect(mgr.activeTimers).toBe(1); // not two timers
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('cancelAll disarms every timer', () => {
    const mgr = new IdleTxnTimeoutManager(100);
    const cb = vi.fn();
    mgr.startTimer('a', undefined, cb);
    mgr.startTimer('b', undefined, cb);
    expect(mgr.activeTimers).toBe(2);
    mgr.cancelAll();
    expect(mgr.activeTimers).toBe(0);
    vi.advanceTimersByTime(200);
    expect(cb).not.toHaveBeenCalled();
  });
});
