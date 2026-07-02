/**
 * WaitSamplingShim — PostgreSQL pg_stat_activity / wait event sampling.
 *
 * PostgreSQL provides wait event information via pg_stat_activity.wait_event
 * and pg_stat_activity.wait_event_type. Since SQLite does not have native
 * wait event tracking, this shim samples current activity and estimates
 * wait states based on lock contention and I/O state.
 *
 * ## Features
 *
 * - Manual activity recording (recordActivity, recordLockWait, recordIOWait)
 * - Interval-based sampling with configurable period (default: 1000ms)
 * - Integration with DeadlockDetector / RowLockManager wait-for graphs
 * - pg_stat_activity compatible output (getActivity)
 *
 * Wait event types (matching PostgreSQL):
 *   - Lock       Waiting for a lock
 *   - IO         Waiting for I/O (WAL write, read)
 *   - Activity   Currently active (CPU-bound)
 *   - Extension  Extension-specific wait
 *   - Client     Waiting for client input
 *   - Timeout    Timeout wait
 *
 * @module query/WaitSamplingShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('WaitSamplingShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export type WaitEventType = 'Lock' | 'IO' | 'Activity' | 'Extension' | 'Client' | 'Timeout' | null;
export type ActivityState = 'active' | 'idle' | 'idle in transaction' | 'fastpath function call' | 'disabled';

export interface WaitEventSample {
  pid: number;
  wait_event_type: WaitEventType;
  wait_event: string | null;
  state: ActivityState;
  query: string;
  query_start: number;  // epoch ms
  wait_start: number | null; // epoch ms, null if not waiting
}

export interface LockManagerLike {
  getWaitInfo?: () => Array<{ sessionId: string; waitingFor: string; lockKey: string }>;
  getLockInfo?: () => Array<{ sessionId: string; mode: string; granted: boolean }>;
  getWaitForGraph?: () => Map<string, Set<string>>;
}

export interface SessionManagerLike {
  getAllSessions?: () => Array<{
    getPid?: () => number;
    getRemoteAddress?: () => string;
    getDatabaseName?: () => string;
    getState?: () => string;
    isActive?: () => boolean;
  }>;
}

// ──────────────────────────────────────────────
//  WaitSamplingShim class
// ──────────────────────────────────────────────

export class WaitSamplingShim {
  private activities: Map<number, Partial<WaitEventSample>> = new Map();
  private samplingInterval: number = 1000; // ms
  private lastSampleTime: number = 0;
  private cachedSamples: WaitEventSample[] = [];

  constructor(samplingIntervalMs: number = 1000) {
    this.samplingInterval = samplingIntervalMs;
  }

  /**
   * Register or update an activity entry for a PID.
   */
  recordActivity(pid: number, sample: Partial<WaitEventSample>): void {
    const existing = this.activities.get(pid) || {};
    this.activities.set(pid, { ...existing, ...sample });
  }

  /**
   * Remove an activity (session disconnected).
   */
  removeActivity(pid: number): void {
    this.activities.delete(pid);
  }

  /**
   * Record that a PID is waiting for a lock.
   *
   * @param pid      Waiting session PID
   * @param lockName Lock resource name (e.g. 'tuple', 'relation', 'page')
   */
  recordLockWait(pid: number, lockName: string): void {
    this.activities.set(pid, {
      pid,
      wait_event_type: 'Lock',
      wait_event: lockName,
      state: 'active',
      wait_start: Date.now(),
    });
  }

  /**
   * Record that a PID is waiting for I/O.
   */
  recordIOWait(pid: number, ioEvent: string): void {
    this.activities.set(pid, {
      pid,
      wait_event_type: 'IO',
      wait_event: ioEvent,
      state: 'active',
      wait_start: Date.now(),
    });
  }

  /**
   * Clear wait state for a PID (resolved wait).
   */
  clearWait(pid: number): void {
    const existing = this.activities.get(pid);
    if (existing) {
      existing.wait_event_type = null;
      existing.wait_event = null;
      existing.wait_start = null;
    }
  }

  /**
   * Sample current wait events, using integration with external lock manager
   * and session manager for richer data.
   *
   * @returns Array of current wait event samples
   */
  sample(lockManager?: LockManagerLike, sessionManager?: SessionManagerLike): WaitEventSample[] {
    const now = Date.now();

    // Return cached samples if within sampling interval
    if (now - this.lastSampleTime < this.samplingInterval && this.cachedSamples.length > 0) {
      return this.cachedSamples;
    }

    this.cachedSamples = [];
    const seenPids = new Set<number>();

    // 1. Collect lock wait events from lock manager's wait-for graph
    if (lockManager) {
      if (typeof lockManager.getWaitForGraph === 'function') {
        const wfg = lockManager.getWaitForGraph();
        if (wfg && wfg.size > 0) {
          for (const [sessionId, waits] of wfg) {
            const pid = parseInt(sessionId.replace(/\D/g, ''), 10) || 0;
            if (pid > 0) {
              seenPids.add(pid);
              // Record if not already tracked or if resolving an existing record
              if (!this.activities.has(pid)) {
                this.recordLockWait(pid, 'tuple');
              }
            }
          }
        }
      } else if (typeof lockManager.getWaitInfo === 'function') {
        const waitInfo = lockManager.getWaitInfo();
        if (waitInfo && waitInfo.length > 0) {
          for (const wi of waitInfo) {
            const pid = parseInt(wi.sessionId.replace(/\D/g, ''), 10) || 0;
            if (pid > 0 && !seenPids.has(pid)) {
              seenPids.add(pid);
              if (!this.activities.has(pid)) {
                this.recordLockWait(pid, wi.lockKey || 'tuple');
              }
            }
          }
        }
      }

      // Update existing tracked lock activities with richer lock info
      if (typeof lockManager.getLockInfo === 'function') {
        const lockInfo = lockManager.getLockInfo();
        if (lockInfo) {
          for (const li of lockInfo) {
            if (!li.granted) {
              const pid = parseInt(li.sessionId.replace(/\D/g, ''), 10) || 0;
              if (pid > 0) {
                this.recordLockWait(pid, li.mode?.toLowerCase() || 'tuple');
                seenPids.add(pid);
              }
            }
          }
        }
      }
    }

    // 2. Collect session activity from session manager
    if (sessionManager && typeof sessionManager.getAllSessions === 'function') {
      const sessions = sessionManager.getAllSessions();
      if (sessions) {
        for (const session of sessions) {
          const pid = typeof session.getPid === 'function' ? session.getPid() : 0;
          if (pid > 0 && !seenPids.has(pid)) {
            seenPids.add(pid);
            const isActive = typeof session.isActive === 'function' ? session.isActive() : true;
            const state = typeof session.getState === 'function' ? session.getState() : (isActive ? 'active' : 'idle');
            if (!this.activities.has(pid)) {
              this.recordActivity(pid, {
                pid,
                state: state as ActivityState,
                query: '',
                query_start: now,
              });
            }
          }
        }
      }
    }

    // 3. Build samples from all tracked activities
    for (const [pid, activity] of this.activities) {
      this.cachedSamples.push({
        pid,
        wait_event_type: activity.wait_event_type ?? null,
        wait_event: activity.wait_event ?? null,
        state: activity.state || 'active',
        query: activity.query || '',
        query_start: activity.query_start || now,
        wait_start: activity.wait_start ?? null,
      });
    }

    this.lastSampleTime = now;
    return this.cachedSamples;
  }

  /**
   * Get current sampler configuration.
   */
  getSamplingConfig(): { interval: number; lastSampleTime: number } {
    return {
      interval: this.samplingInterval,
      lastSampleTime: this.lastSampleTime,
    };
  }

  /**
   * Force a fresh sample on the next call (clear cache).
   */
  invalidateSampleCache(): void {
    this.cachedSamples = [];
    this.lastSampleTime = 0;
  }

  /**
   * Get a specific PID's wait event.
   */
  getWaitEvent(pid: number): Pick<WaitEventSample, 'wait_event_type' | 'wait_event' | 'state'> | null {
    const activity = this.activities.get(pid);
    if (!activity) return null;

    return {
      wait_event_type: activity.wait_event_type ?? null,
      wait_event: activity.wait_event ?? null,
      state: activity.state || 'active',
    };
  }

  /**
   * Get pg_stat_activity compatible output — returns all current samples.
   */
  getActivity(): WaitEventSample[] {
    if (this.cachedSamples.length > 0) {
      return this.cachedSamples;
    }
    return this.sample();
  }

  /**
   * Clear all tracked activities and cached samples.
   */
  clear(): void {
    this.activities.clear();
    this.cachedSamples = [];
    this.lastSampleTime = 0;
  }

  /**
   * Get total count of tracked activities (for diagnostics).
   */
  getActivityCount(): number {
    return this.activities.size;
  }
}
