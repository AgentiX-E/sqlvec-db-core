/**
 * BottleneckRateLimiter — a lightweight, self-contained concurrency limiter
 * compatible with the core subset of the `bottleneck` scheduling contract.
 *
 * The limiter bounds how many asynchronous tasks may run concurrently via
 * {@link schedule}.  Tasks submitted beyond the concurrency limit are queued
 * in FIFO order and released as earlier tasks settle.  An optional minimum
 * spacing (`minTime`) throttles the *start* of successive tasks without
 * blocking already-queued work indefinitely.
 *
 * This limiter intentionally does not pull in the external `bottleneck`
 * package: the database core only needs concurrency bounding for query
 * execution, and a dependency-free implementation keeps the recovery/security
 * path self-contained and deterministic under test.
 *
 * @module security/BottleneckRateLimiter
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('BottleneckRateLimiter');

/** Configuration for {@link BottleneckRateLimiter}. */
export interface BottleneckRateLimiterOptions {
  /**
   * Maximum number of tasks allowed to run at the same time.
   * Values below 1 are coerced to 1.
   * @default 8
   */
  maxConcurrent?: number;
  /**
   * Minimum elapsed time (ms) between the *start* of successive tasks.
   * `0` or `undefined` disables spacing.
   * @default 0
   */
  minTime?: number;
  /**
   * Optional cap on the number of queued tasks.  When the queue length
   * reaches this value, {@link schedule} rejects immediately instead of
   * enqueueing.  `undefined` or `0` means unbounded.
   * @default undefined
   */
  highWater?: number;
}

interface Pending {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * A bounded-concurrency task scheduler.
 */
export class BottleneckRateLimiter {
  private readonly maxConcurrent: number;
  private readonly minTime: number;
  private readonly highWater: number;

  private active = 0;
  private started = 0;
  private readonly queue: Pending[] = [];
  private lastStart = 0;
  /** Used to resolve the spacing timer so `close()` can cancel a pending delay. */
  private spacingTimer: NodeJS.Timeout | null = null;

  constructor(opts: BottleneckRateLimiterOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? 8));
    this.minTime = Math.max(0, Math.floor(opts.minTime ?? 0));
    this.highWater = opts.highWater != null && opts.highWater > 0 ? Math.floor(opts.highWater) : Infinity;
  }

  /**
   * Schedule a task under the concurrency and spacing limits.
   *
   * @param fn - The asynchronous task to run.
   * @returns A promise resolving/rejecting with the task's own result.
   */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.queue.length >= this.highWater) {
        reject(new Error(`BottleneckRateLimiter queue overflow (highWater=${this.highWater})`));
        return;
      }

      const pending: Pending = {
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      this.queue.push(pending);
      this.drain();
    });
  }

  /** Number of tasks currently running (for introspection/tests). */
  get activeCount(): number {
    return this.active;
  }

  /** Number of tasks waiting to run (for introspection/tests). */
  get queueLength(): number {
    return this.queue.length;
  }

  /** Total number of tasks started since construction. */
  get startedCount(): number {
    return this.started;
  }

  /**
   * Release the next queued task if a concurrency slot is free and the
   * minimum spacing has elapsed.
   */
  private drain(): void {
    if (this.queue.length === 0) return;

    const waitMs = this.spacingDelayMs();
    if (waitMs > 0) {
      // A spacing delay is pending; it will re-invoke drain when it fires.
      if (this.spacingTimer === null) {
        this.spacingTimer = setTimeout(() => {
          this.spacingTimer = null;
          this.drain();
        }, waitMs);
      }
      return;
    }

    if (this.active >= this.maxConcurrent) return;

    // The queue is provably non-empty (checked at the top of `drain`, which is
    // fully synchronous up to this point), so the shifted entry is present.
    const next = this.queue.shift()!;

    this.active += 1;
    this.started += 1;
    this.lastStart = Date.now();

    logger.trace({ active: this.active, queued: this.queue.length }, 'Starting queued task');

    // Detach the async body so `schedule`-backed callers are not chained to
    // this internal microtask stack.
    Promise.resolve()
      .then(next.fn)
      .then(
        (value) => {
          this.active -= 1;
          next.resolve(value);
          this.drain();
        },
        (err) => {
          this.active -= 1;
          next.reject(err);
          this.drain();
        },
      );
  }

  /**
   * Milliseconds to wait before the next task may start, based on the
   * minimum-spacing configuration.
   */
  private spacingDelayMs(): number {
    if (this.minTime <= 0) return 0;
    if (this.lastStart === 0) return 0;
    const elapsed = Date.now() - this.lastStart;
    return Math.max(0, this.minTime - elapsed);
  }

  /**
   * Cancel the pending spacing timer (if any).  Queued tasks are left in
   * place; they will resume as soon as the next `drain` is triggered.
   */
  cancelSpacing(): void {
    if (this.spacingTimer !== null) {
      clearTimeout(this.spacingTimer);
      this.spacingTimer = null;
    }
  }

  /**
   * Stop scheduling new work and reject every queued task.  Already-running
   * tasks are allowed to finish.  Idempotent.
   *
   * @returns The number of queued tasks that were rejected.
   */
  clearQueue(): number {
    const dropped = this.queue.length;
    for (const pending of this.queue) {
      pending.reject(new Error('BottleneckRateLimiter queue cleared'));
    }
    this.queue.length = 0;
    this.cancelSpacing();
    return dropped;
  }
}
