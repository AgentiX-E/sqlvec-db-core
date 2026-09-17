/**
 * FencingManager — write-fencing (STONITH) contract.
 *
 * Defines the *contract* for fencing: blocking writes on a node that has lost
 * leadership of a Raft group (to prevent split-brain).  The full
 * lease/heartbeat-based implementation lives in the cluster layer
 * (`db-cluster/src/consensus/fencing/FencingManager.ts`); this core module
 * only owns the shared result type and a single-node null-object default.
 *
 * In single-node operation there is no Raft group to be fenced from, so the
 * null-object default always allows writes.  A cluster deployment injects the
 * real implementation, which rejects writes with SQLSTATE `55P03`
 * (`lock_not_available`) once the leader lease expires.
 *
 * @module consensus/FencingManager
 */

/** Result of a write-fencing check. */
export interface FenceCheckResult {
  /** Whether the write is permitted. */
  allowed: boolean;
  /** Human-readable reason when the write is blocked. */
  reason?: string;
}

export class FencingManager {
  private static _instance?: FencingManager;

  static getInstance(): FencingManager {
    if (!FencingManager._instance) {
      FencingManager._instance = new FencingManager();
    }
    return FencingManager._instance;
  }

  /**
   * Check whether a write to the given shard is permitted.
   *
   * The single-node default always allows writes (no fencing applies).  A
   * cluster implementation overrides this to reject writes once the node has
   * been fenced for loss of leadership.
   *
   * @param shardId Shard identifier (string or number).
   */
  checkWriteAllowed(shardId: string | number): FenceCheckResult {
    void shardId;
    return { allowed: true };
  }
}
