/**
 * HLCClockCompensator — tracks peer clock drift for HLC comparison.
 *
 * HLC relies on wall clocks across nodes being roughly synchronized.  When a
 * node observes a peer timestamp, it records the delta between the peer wall
 * clock and its own local clock; the running estimate is used to compensate
 * for drift and to surface clock-skew diagnostics.
 *
 * The single-node default records samples but reports zero drift (there are
 * no peers), which is the honest baseline; a cluster deployment may attach a
 * richer compensator with calibration logic.
 *
 * @module consensus/HLCClockCompensator
 */

import type { ClockErrorStats } from '../types/types-raw';

export class HLCClockCompensator {
  /** Expected maximum clock drift tolerance in milliseconds. */
  private readonly maxDriftMs: number;
  /** Running sum of observed (peerWall - localWall) deltas. */
  private driftSum = 0;
  /** Number of samples collected. */
  private sampleCount = 0;
  /** Epoch milliseconds of the last recorded sample. */
  private lastSyncTime = 0;

  /**
   * @param maxDriftMs Expected maximum clock drift in milliseconds.
   */
  constructor(maxDriftMs: number = 200) {
    this.maxDriftMs = Math.max(0, maxDriftMs);
  }

  /**
   * Record a peer HLC timestamp observation.
   *
   * @param nodeId     Peer node identifier (informational).
   * @param peerWall   Peer wall-clock component (epoch milliseconds).
   * @param localWall  Local wall-clock reading at observation time.
   */
  recordPeerTimestamp(nodeId: number, peerWall: number, localWall: number): void {
    void nodeId;
    if (typeof peerWall !== 'number' || typeof localWall !== 'number') {
      return;
    }
    if (Number.isNaN(peerWall) || Number.isNaN(localWall)) {
      return;
    }
    this.driftSum += peerWall - localWall;
    this.sampleCount++;
    this.lastSyncTime = Date.now();
  }

  /** Current drift estimate in milliseconds (positive = peers ahead). */
  get estimatedDriftMs(): number {
    if (this.sampleCount === 0) return 0;
    return this.driftSum / this.sampleCount;
  }

  /** Snapshot of the compensator state. */
  getClockErrorStats(): ClockErrorStats {
    return {
      maxDriftMs: this.maxDriftMs,
      estimatedDriftMs: this.estimatedDriftMs,
      samples: this.sampleCount,
      lastSync: this.lastSyncTime,
    };
  }
}
