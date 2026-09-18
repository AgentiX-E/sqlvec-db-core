/**
 * IdleTxnTimeoutManager — idle-in-transaction timeout for the transaction
 * coordinator.
 *
 * PostgreSQL exposes an `idle_in_transaction_session_timeout` GUC that aborts
 * a session whose transaction has been open (idle) for longer than the
 * configured duration.  This manager provides the same guarantee locally: it
 * arms a per-session timer that fires the supplied callback once the session
 * has been idle-in-transaction longer than the configured timeout.
 *
 * A timeout of `0` (the default) disables timers entirely.
 *
 * @module protocol/IdleTxnTimeout
 */

/** Default idle-in-transaction timeout: `0` disables the timeout. */
export const DEFAULT_IDLE_TXN_TIMEOUT_MS = 0;

/** Handle returned by {@link IdleTxnTimeoutManager.startTimer}. */
export interface IdleTimerHandle {
  /** Cancel the timer associated with this handle. */
  cancel: () => void;
}

/**
 * Manages per-session idle-in-transaction timers.
 *
 * Each armed timer is tracked in a `Map<string, NodeJS.Timeout>` keyed by
 * session id so a session can be cancelled by id or via its handle.  Timers
 * fire exactly once; after firing (or cancellation) the entry is removed.
 */
export class IdleTxnTimeoutManager {
  private static instance: IdleTxnTimeoutManager | null = null;

  private readonly timers = new Map<string, NodeJS.Timeout>();

  /**
   * @param timeoutMs - Idle timeout in milliseconds.  `0` disables timers.
   */
  constructor(private readonly timeoutMs: number = DEFAULT_IDLE_TXN_TIMEOUT_MS) {}

  /** Return the process-wide singleton (default timeout). */
  static getInstance(): IdleTxnTimeoutManager {
    if (!IdleTxnTimeoutManager.instance) {
      IdleTxnTimeoutManager.instance = new IdleTxnTimeoutManager();
    }
    return IdleTxnTimeoutManager.instance;
  }

  /**
   * Arm an idle-in-transaction timer for a session.
   *
   * When `timeoutMs <= 0` the manager is disabled and no timer is created; the
   * returned handle is a no-op `cancel`.
   *
   * @param sessionId - The session to arm.
   * @param _opts     - Reserved for future options (kept for caller symmetry).
   * @param onTimeout - Invoked with the session id when the timer fires.
   * @returns A handle whose `cancel()` cancels this session's timer.
   */
  startTimer(
    sessionId: string,
    _opts: unknown,
    onTimeout: (sessionId: string) => void,
  ): IdleTimerHandle {
    if (this.timeoutMs <= 0) {
      return { cancel: () => {} };
    }

    this.cancelTimer(sessionId);

    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      onTimeout(sessionId);
    }, this.timeoutMs);

    this.timers.set(sessionId, timer);

    return {
      cancel: () => this.cancelTimer(sessionId),
    };
  }

  /**
   * Cancel the idle timer for a session (removing it if present).
   *
   * @param sessionId - The session whose timer should be cancelled.
   */
  cancelTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
  }

  /** Number of currently-armed timers. */
  get activeTimers(): number {
    return this.timers.size;
  }

  /** Whether any timers are currently armed. */
  get hasActiveTimers(): boolean {
    return this.timers.size > 0;
  }

  /** Cancel every armed timer (e.g. on shutdown). */
  cancelAll(): void {
    for (const sessionId of this.timers.keys()) {
      this.cancelTimer(sessionId);
    }
  }
}
