/**
 * QueryTimeout — statement timeout control tests.
 *
 * Covers the QueryCanceledError shape, direct execution with no limit, timeout
 * enforcement via fake timers, AbortError normalization, external cancel,
 * running-state tracking, stats, config mutation, and the withTimeout helper.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  QueryTimeout,
  QueryCanceledError,
  withTimeout,
  DEFAULT_TIMEOUT_CONFIG,
} from '../query/QueryTimeout';

describe('QueryCanceledError', () => {
  it('has the PG query_canceled shape', () => {
    const e = new QueryCanceledError();
    expect(e.message).toBe('query canceled due to statement timeout');
    expect(e.name).toBe('QueryCanceledError');
    expect(e.code).toBe('QUERY_CANCELED');
    expect(e.severity).toBe('ERROR');
    expect(e.sqlState).toBe('57014');
  });

  it('accepts a custom message', () => {
    const e = new QueryCanceledError('custom');
    expect(e.message).toBe('custom');
  });

  it('is an instance of Error', () => {
    expect(new QueryCanceledError()).toBeInstanceOf(Error);
  });
});

describe('QueryTimeout.execute (no limit)', () => {
  it('runs fn directly without a timeout when statementTimeoutMs is 0', async () => {
    const q = new QueryTimeout();
    const result = await q.execute(async () => 'ok');
    expect(result).toBe('ok');
    expect(q.getStats().totalExecutions).toBe(1);
    expect(q.isRunning()).toBe(false);
  });

  it('passes undefined as the signal when no timeout is set', async () => {
    const q = new QueryTimeout();
    let received: AbortSignal | undefined = undefined as any;
    await q.execute(async (signal) => {
      received = signal;
    });
    expect(received).toBeUndefined();
  });
});

describe('QueryTimeout.execute (timeout)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves when fn completes before the timeout', async () => {
    const q = new QueryTimeout({ statementTimeoutMs: 1000 });
    const result = await q.execute(async () => 'done');
    expect(result).toBe('done');
    expect(q.getStats().timedOutCount).toBe(0);
  });

  it('rejects with QueryCanceledError when fn exceeds the timeout', async () => {
    const q = new QueryTimeout({ statementTimeoutMs: 1000 });
    const p = q.execute(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return 'late';
    });
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toThrow(QueryCanceledError);
    expect(q.getStats().timedOutCount).toBe(1);
    expect(q.getStats().lastTimeoutAt).not.toBeNull();
  });

  it('passes an AbortSignal to fn when a timeout is set', async () => {
    const q = new QueryTimeout({ statementTimeoutMs: 1000 });
    let received: AbortSignal | undefined;
    await q.execute(async (signal) => {
      received = signal;
    });
    expect(received).toBeInstanceOf(AbortSignal);
  });

  it('normalizes an AbortError thrown by fn into QueryCanceledError', async () => {
    const q = new QueryTimeout({ statementTimeoutMs: 1000 });
    const abortErr = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    await expect(
      q.execute(async () => { throw abortErr; }),
    ).rejects.toThrow(QueryCanceledError);
  });

  it('normalizes an ABORT_ERR code into QueryCanceledError', async () => {
    const q = new QueryTimeout({ statementTimeoutMs: 1000 });
    const err = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
    await expect(q.execute(async () => { throw err; })).rejects.toThrow(
      QueryCanceledError,
    );
  });

  it('normalizes an err whose message contains "abort"', async () => {
    const q = new QueryTimeout({ statementTimeoutMs: 1000 });
    const err = new Error('request was aborted by user');
    await expect(q.execute(async () => { throw err; })).rejects.toThrow(
      QueryCanceledError,
    );
  });

  it('re-throws a non-abort error unchanged', async () => {
    const q = new QueryTimeout({ statementTimeoutMs: 1000 });
    await expect(
      q.execute(async () => { throw new Error('syntax error'); }),
    ).rejects.toThrow('syntax error');
    expect(q.getStats().timedOutCount).toBe(0);
  });
});

describe('QueryTimeout.cancel and state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('cancel aborts an in-flight query and counts a timeout', async () => {
    const q = new QueryTimeout({ statementTimeoutMs: 1000 });
    let signal: AbortSignal | undefined;
    const p = q.execute(
      (s) =>
        new Promise((_resolve, reject) => {
          signal = s;
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(q.isRunning()).toBe(true);
    q.cancel();
    expect(signal?.aborted).toBe(true);
    await p.catch(() => {});
    expect(q.getStats().timedOutCount).toBe(1);
    expect(q.isRunning()).toBe(false);
  });

  it('cancel is a no-op when nothing is running', () => {
    const q = new QueryTimeout({ statementTimeoutMs: 1000 });
    q.cancel();
    expect(q.getStats().timedOutCount).toBe(0);
    expect(q.isRunning()).toBe(false);
  });
});

describe('QueryTimeout stats and config', () => {
  it('resetStats clears counters', () => {
    const q = new QueryTimeout({ statementTimeoutMs: 0 });
    q.resetStats();
    expect(q.getStats().totalExecutions).toBe(0);
    expect(q.getStats().timedOutCount).toBe(0);
    expect(q.getStats().lastTimeoutAt).toBeNull();
  });

  it('updateConfig changes the timeout at runtime', () => {
    const q = new QueryTimeout({ statementTimeoutMs: 100 });
    q.updateConfig({ statementTimeoutMs: 5000 });
    expect(q.getConfig().statementTimeoutMs).toBe(5000);
  });

  it('getConfig returns a defensive copy', () => {
    const q = new QueryTimeout({ statementTimeoutMs: 100 });
    const cfg = q.getConfig() as any;
    cfg.statementTimeoutMs = 9999;
    expect(q.getConfig().statementTimeoutMs).toBe(100);
  });

  it('DEFAULT_TIMEOUT_CONFIG has zero limit', () => {
    expect(DEFAULT_TIMEOUT_CONFIG.statementTimeoutMs).toBe(0);
  });
});

describe('withTimeout', () => {
  it('resolves for a fast fn', async () => {
    await expect(withTimeout(async () => 42, 1000)).resolves.toBe(42);
  });

  it('rejects after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const p = withTimeout(
        async () => { await new Promise(() => {}); },
        1000,
      );
      vi.advanceTimersByTime(1001);
      await expect(p).rejects.toThrow(QueryCanceledError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('QueryTimeout overlapping executions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not cross-talk between two overlapping executions', async () => {
    const q = new QueryTimeout({ statementTimeoutMs: 1000 });

    let firstResolve!: () => void;
    let firstSignal: AbortSignal | undefined;
    const first = q.execute(
      (s) =>
        new Promise<void>((res) => {
          firstSignal = s;
          firstResolve = res;
        }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Start a second execution that resolves quickly.
    const second = q.execute(async () => 'second');
    await vi.advanceTimersByTimeAsync(0);
    await expect(second).resolves.toBe('second');

    // The first execution still owns its own signal and has not been aborted
    // by the second execution's lifecycle.
    expect(firstSignal?.aborted).toBe(false);

    // Complete the first execution explicitly and confirm no timer leak.
    firstResolve();
    await expect(first).resolves.toBeUndefined();
    expect(q.isRunning()).toBe(false);
  });

  it('canceling the latest execution does not count twice', async () => {
    const q = new QueryTimeout({ statementTimeoutMs: 1000 });
    const p = q.execute(
      (s) =>
        new Promise((_res, rej) => {
          s?.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    q.cancel();
    await p.catch(() => {});
    expect(q.getStats().timedOutCount).toBe(1);
  });

  it('timeout path does not double count when fn honors the signal', async () => {
    const q = new QueryTimeout({ statementTimeoutMs: 100 });
    const p = q.execute(
      (s) =>
        new Promise((_res, rej) => {
          s?.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    vi.advanceTimersByTime(101);
    await expect(p).rejects.toThrow(QueryCanceledError);
    expect(q.getStats().timedOutCount).toBe(1);
  });
});
