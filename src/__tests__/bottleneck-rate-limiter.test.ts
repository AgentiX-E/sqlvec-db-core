/**
 * Unit tests for BottleneckRateLimiter.
 *
 * These tests verify real concurrency semantics: tasks bounded to
 * `maxConcurrent`, FIFO queueing, minimum spacing between successive starts,
 * high-water overflow rejection, and queue clearing.
 */
import { describe, it, expect } from 'vitest';
import { BottleneckRateLimiter } from '../security/BottleneckRateLimiter';

/** A controllable async task whose start/completion can be driven manually. */
function makeDeferred() {
  let resolve!: (v: number) => void;
  let started = false;
  const startedAt: number[] = [];
  const promise = new Promise<number>((res) => {
    resolve = res;
  });
  const fn = () => {
    started = true;
    startedAt.push(Date.now());
    return promise;
  };
  return { fn, resolve, started: () => started, startedAt, promise };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('BottleneckRateLimiter — concurrency bounding', () => {
  it('runs a single task through the limiter', async () => {
    const limiter = new BottleneckRateLimiter();
    const result = await limiter.schedule(async () => 42);
    expect(result).toBe(42);
    expect(limiter.startedCount).toBe(1);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.queueLength).toBe(0);
  });

  it('coerces maxConcurrent below 1 to 1', async () => {
    expect(new BottleneckRateLimiter({ maxConcurrent: 0 }).activeCount).toBe(0);
    const limiter = new BottleneckRateLimiter({ maxConcurrent: 0 });
    // Start one task; a second must queue rather than run concurrently.
    const a = makeDeferred();
    const b = makeDeferred();
    void limiter.schedule(a.fn);
    void limiter.schedule(b.fn);
    await tick();
    expect(a.started()).toBe(true);
    expect(b.started()).toBe(false);
    a.resolve(1);
    await tick();
    expect(b.started()).toBe(true);
    b.resolve(2);
  });

  it('does not exceed maxConcurrent', async () => {
    const limiter = new BottleneckRateLimiter({ maxConcurrent: 2 });
    const tasks = [makeDeferred(), makeDeferred(), makeDeferred(), makeDeferred()];
    for (const t of tasks) void limiter.schedule(t.fn);

    await tick();
    expect(tasks[0].started()).toBe(true);
    expect(tasks[1].started()).toBe(true);
    expect(tasks[2].started()).toBe(false);
    expect(tasks[3].started()).toBe(false);
    expect(limiter.activeCount).toBe(2);
    expect(limiter.queueLength).toBe(2);

    tasks[0].resolve(1);
    await tick();
    expect(tasks[2].started()).toBe(true);
    expect(limiter.activeCount).toBe(2);
    expect(limiter.queueLength).toBe(1);

    tasks[1].resolve(2);
    tasks[2].resolve(3);
    await tick();
    expect(tasks[3].started()).toBe(true);
    tasks[3].resolve(4);
    await tick();
    expect(limiter.activeCount).toBe(0);
  });

  it('preserves FIFO order of queued tasks', async () => {
    const limiter = new BottleneckRateLimiter({ maxConcurrent: 1 });
    const order: number[] = [];
    const a = limiter.schedule(async () => { order.push(1); return 1; });
    const b = limiter.schedule(async () => { order.push(2); return 2; });
    const c = limiter.schedule(async () => { order.push(3); return 3; });
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('propagates task rejection without breaking the queue', async () => {
    const limiter = new BottleneckRateLimiter({ maxConcurrent: 1 });
    const boom = limiter.schedule(async () => { throw new Error('kaboom'); });
    const ok = limiter.schedule(async () => 7);
    await expect(boom).rejects.toThrow('kaboom');
    await expect(ok).resolves.toBe(7);
    expect(limiter.activeCount).toBe(0);
  });
});

describe('BottleneckRateLimiter — minimum spacing', () => {
  it('obeys minTime between successive starts', async () => {
    const limiter = new BottleneckRateLimiter({ maxConcurrent: 10, minTime: 30 });
    const a = makeDeferred();
    const b = makeDeferred();
    void limiter.schedule(a.fn);
    await tick();
    expect(a.started()).toBe(true);

    void limiter.schedule(b.fn);
    await tick();
    // b must not start before 30ms after a's start.
    expect(b.started()).toBe(false);

    await new Promise((r) => setTimeout(r, 40));
    expect(b.started()).toBe(true);

    a.resolve(1);
    b.resolve(2);
    await tick();
    expect(limiter.activeCount).toBe(0);
  });

  it('does not delay the first task (lastStart===0)', async () => {
    const limiter = new BottleneckRateLimiter({ minTime: 1000 });
    const a = makeDeferred();
    void limiter.schedule(a.fn);
    await tick();
    expect(a.started()).toBe(true);
    a.resolve(1);
  });

  it('does not schedule a second spacing timer while one is pending', async () => {
    // maxConcurrent is high so the only gate is minTime.
    const limiter = new BottleneckRateLimiter({ maxConcurrent: 10, minTime: 50 });
    const a = makeDeferred();
    void limiter.schedule(a.fn);
    await tick();
    expect(a.started()).toBe(true);
    a.resolve(1);
    await tick();

    // First queued task sets the spacing timer (waitMs > 0 for the second
    // task that follows immediately).
    const b = makeDeferred();
    void limiter.schedule(b.fn);
    const c = makeDeferred();
    void limiter.schedule(c.fn);
    await tick();

    // Neither b nor c should have started yet (spacing window still open),
    // and no duplicate timer should have been created.
    expect(b.started()).toBe(false);
    expect(c.started()).toBe(false);
    expect(limiter.queueLength).toBe(2);

    // Let the spacing window elapse; the first queued task then runs.
    await new Promise((r) => setTimeout(r, 60));
    expect(b.started()).toBe(true);
    b.resolve(2);
    await tick();

    // The second queued task needs another full spacing interval.
    await new Promise((r) => setTimeout(r, 60));
    expect(c.started()).toBe(true);
    c.resolve(3);
    await tick();
    expect(limiter.activeCount).toBe(0);
  });

  it('cancelSpacing clears a pending timer via clearQueue', async () => {
    const limiter = new BottleneckRateLimiter({ maxConcurrent: 10, minTime: 100 });
    const a = makeDeferred();
    void limiter.schedule(a.fn);
    await tick();
    a.resolve(1);
    await tick();

    // Queue a task that will be gated by the spacing timer. The returned
    // promise is kept so the rejection produced by `clearQueue` below is
    // observed rather than surfacing as an unhandled rejection.
    const b = makeDeferred();
    const queuedB = limiter.schedule(b.fn);
    await tick();
    expect(b.started()).toBe(false);

    // clearQueue cancels the pending spacing timer and rejects the queued task.
    const dropped = limiter.clearQueue();
    expect(dropped).toBe(1);
    expect(limiter.queueLength).toBe(0);
    await expect(queuedB).rejects.toThrow(/cleared/);
  });
});

describe('BottleneckRateLimiter — high water', () => {
  it('rejects when the queue reaches highWater', async () => {
    const limiter = new BottleneckRateLimiter({ maxConcurrent: 1, highWater: 1 });
    const blocker = makeDeferred();
    void limiter.schedule(blocker.fn);
    await tick();

    // One queued slot fills highWater.
    void limiter.schedule(async () => 1);
    await tick();
    expect(limiter.queueLength).toBe(1);

    // The next schedule overflows.
    await expect(limiter.schedule(async () => 2)).rejects.toThrow(/overflow/);
    expect(limiter.queueLength).toBe(1);

    blocker.resolve(0);
    await tick();
  });

  it('treats highWater of 0 as unbounded', async () => {
    const limiter = new BottleneckRateLimiter({ maxConcurrent: 1, highWater: 0 });
    const blocker = makeDeferred();
    void limiter.schedule(blocker.fn);
    await tick();
    void limiter.schedule(async () => 1);
    void limiter.schedule(async () => 2);
    expect(limiter.queueLength).toBe(2);
    blocker.resolve(0);
    await tick();
  });
});

describe('BottleneckRateLimiter — clearQueue', () => {
  it('rejects queued tasks and keeps running tasks alive', async () => {
    const limiter = new BottleneckRateLimiter({ maxConcurrent: 1 });
    const running = makeDeferred();
    void limiter.schedule(running.fn);
    await tick();

    const queued = limiter.schedule(async () => 99);
    await tick();
    expect(limiter.queueLength).toBe(1);

    const dropped = limiter.clearQueue();
    expect(dropped).toBe(1);
    expect(limiter.queueLength).toBe(0);
    await expect(queued).rejects.toThrow(/cleared/);

    // Running task is still active.
    expect(running.started()).toBe(true);
    running.resolve(1);
    await tick();
    expect(limiter.activeCount).toBe(0);
  });

  it('returns 0 when there is nothing queued', () => {
    const limiter = new BottleneckRateLimiter();
    expect(limiter.clearQueue()).toBe(0);
  });
});
