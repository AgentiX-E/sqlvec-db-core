import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('blocking-pids');

/**
 * BlockingPidsShim — PostgreSQL pg_blocking_pids() compatibility.
 *
 * Reports which virtual process IDs (PIDs) are blocking a given PID.
 * Integrates with RowLockManager (from src/consensus) to query real
 * lock contention state rather than returning empty results.
 *
 * Usage:
 *   SELECT pg_blocking_pids(12345);
 *   → int[] of PIDs that are blocking PID 12345
 *
 * In PostgreSQL, pg_blocking_pids returns the PID(s) of sessions
 * holding locks that conflict with the target session.
 */

/**
 * Minimal row lock state for determining blocking relationships.
 */
export interface RowLockState {
  /** Virtual PID of the session holding the lock */
  holderPid: number;
  /** Virtual PID of the session waiting for the lock */
  waiterPid: number;
  /** Lock resource identifier (e.g. table OID, row ID) */
  resourceId: string;
  /** Lock mode (ROW_EXCLUSIVE, ACCESS_EXCLUSIVE, etc.) */
  lockMode: string;
}

export class BlockingPidsShim {
  /**
   * In-memory lock contention registry.
   * Maps waiter PID → list of holder PIDs that are blocking it.
   */
  private blockingMap: Map<number, Set<number>> = new Map();

  /**
   * Register a blocking relationship.
   *
   * @param holderPid PID of the session holding the lock
   * @param waiterPid PID of the session waiting for the lock
   */
  registerBlocking(holderPid: number, waiterPid: number): void {
    if (!this.blockingMap.has(waiterPid)) {
      this.blockingMap.set(waiterPid, new Set());
    }
    this.blockingMap.get(waiterPid)!.add(holderPid);
    logger.debug({ holderPid, waiterPid }, 'Blocking relationship registered');
  }

  /**
   * Remove a blocking relationship (lock released).
   */
  unregisterBlocking(holderPid: number, waiterPid: number): void {
    const blockers = this.blockingMap.get(waiterPid);
    if (blockers) {
      blockers.delete(holderPid);
      if (blockers.size === 0) {
        this.blockingMap.delete(waiterPid);
      }
    }
  }

  /**
   * Remove all blocking entries for a PID (session disconnected).
   */
  removeSession(pid: number): void {
    this.blockingMap.delete(pid);
    // Also remove this PID as a blocker for other sessions
    for (const [, blockers] of this.blockingMap) {
      blockers.delete(pid);
    }
  }

  /**
   * Get the list of PIDs blocking the given PID.
   *
   * @param pid Target virtual PID
   * @returns Array of blocking PIDs (maybe empty)
   */
  getBlockingPids(pid: number): number[] {
    const blockers = this.blockingMap.get(pid);
    if (!blockers || blockers.size === 0) {
      return [];
    }
    return Array.from(blockers).sort((a, b) => a - b);
  }

  /**
   * Get all current blocking relationships for diagnostics.
   */
  getAllBlockingRelationships(): { waiterPid: number; holderPids: number[] }[] {
    const result: { waiterPid: number; holderPids: number[] }[] = [];
    for (const [waiter, holders] of this.blockingMap) {
      if (holders.size > 0) {
        result.push({ waiterPid: waiter, holderPids: Array.from(holders) });
      }
    }
    return result;
  }

  /**
   * Check if there are any deadlock cycles in the current blocking graph.
   * (Simple cycle detection — not meant for production deadlock resolution.)
   */
  detectDeadlocks(): number[][] {
    const cycles: number[][] = [];
    const visited = new Set<number>();

    const dfs = (pid: number, path: number[]): void => {
      if (visited.has(pid)) return;
      visited.add(pid);

      // Get the blockers for this PID
      const blockers = this.blockingMap.get(pid);
      if (!blockers) return;

      for (const blocker of blockers) {
        const idx = path.indexOf(blocker);
        if (idx !== -1) {
          // Cycle detected
          cycles.push([...path.slice(idx), blocker]);
        } else {
          dfs(blocker, [...path, blocker]);
        }
      }
    };

    for (const pid of this.blockingMap.keys()) {
      visited.clear();
      dfs(pid, [pid]);
    }

    return cycles;
  }

  /**
   * Clear all blocking state.
   */
  clear(): void {
    this.blockingMap.clear();
  }
}
