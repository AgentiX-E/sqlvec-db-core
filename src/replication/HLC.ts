/**
 * HLC — Hybrid Logical Clock comparison for last-writer-wins conflict
 * resolution.
 *
 * An HLC timestamp combines a physical wall-clock component with a logical
 * counter and a node id, giving a total order that respects causality while
 * tolerating non-synchronized node clocks.  Comparison is lexicographic:
 * `wall` first, then `logical`, then `nodeId` as the tie-breaker.
 *
 * The timestamp shape intentionally mirrors {@link HLCTimestamp} from
 * `src/types/types-raw` (`wall`/`logical`/`nodeId` as numbers), which is the
 * contract consumed by `ShardReplica` for LWW conflict checks.
 *
 * @module replication/HLC
 */

/** HLC timestamp used by the LWW conflict-resolution path. */
export interface HLCTimestamp {
  /** Physical wall-clock component (epoch milliseconds). */
  wall: number;
  /** Logical counter to break ties when `wall` is identical. */
  logical: number;
  /** Node identifier used as the final tie-breaker. */
  nodeId: number;
}

/**
 * Compare two HLC timestamps.
 *
 * Returns a negative number if `a < b`, zero if equal, and a positive number
 * if `a > b`.  Ordering is (wall, logical, nodeId) lexicographic.
 */
export function compareHLT(a: HLCTimestamp, b: HLCTimestamp): number {
  if (a.wall < b.wall) return -1;
  if (a.wall > b.wall) return 1;
  if (a.logical < b.logical) return -1;
  if (a.logical > b.logical) return 1;
  if (a.nodeId < b.nodeId) return -1;
  if (a.nodeId > b.nodeId) return 1;
  return 0;
}

/**
 * Check if timestamp `a` happened before `b` (causally prior).
 */
export function happenedBefore(a: HLCTimestamp, b: HLCTimestamp): boolean {
  return compareHLT(a, b) < 0;
}
