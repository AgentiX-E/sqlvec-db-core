/**
 * PITRManager — Point-in-Time Recovery manager contract.
 *
 * This module defines the shape of the PITR manager reference that
 * `SystemFunctions` exposes through `setPitrManager`/`getPitrManager`.  The
 * concrete PITR implementation (WAL replay / base-backup orchestration) is
 * owned elsewhere; callers only need a lightweight handle to query recovery
 * state.
 *
 * @module pitr/PITRManager
 */

/** Observable state of the PITR manager. */
export interface PitrMgrType {
  /** Whether point-in-time recovery is currently active. */
  isActive: boolean;
  /** The last replayed WAL LSN, as a string (e.g. "0/16B3748"). */
  lastWalLsn: string;
}
