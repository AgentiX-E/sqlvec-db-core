/**
 * MvccCrashRecovery — reconstructs MVCC XID state from WAL segments after a
 * crash, mirroring PostgreSQL's recovery of the transaction (XACT) log.
 *
 * PostgreSQL's crash recovery replays WAL to rebuild the CLOG (commit log)
 * so that the set of committed / aborted / still-in-progress transactions is
 * known exactly.  This class performs the equivalent scan over the WAL
 * records produced by {@link WalRecordReader}: every `Transaction` record
 * carries an XID and a subtype that marks its fate.
 *
 *   - `XACT_COMMIT` (0)   → committed
 *   - `XACT_ABORT`  (1)   → aborted
 *   - `XACT_PREPARE` (2)  → prepared (in-progress until resolved)
 *
 * A transaction that appears only under `XACT_PREPARE` is treated as
 * in-progress.  Once a commit or abort record is seen for an XID, that
 * definitive disposition wins over any earlier prepare marker.
 *
 * The result is consumed by `QueryRouter.runCrashRecovery` to advance the
 * MVCC XID watermark past the highest recovered XID, preventing XID reuse.
 *
 * @module recovery/MvccCrashRecovery
 */

import { PinoLogger } from '../logger/PinoLogger';
import { WalRecordReader, type WalRecord } from './WalRecordReader';

const logger = PinoLogger.forComponent('MvccCrashRecovery');

/** Resource-manager value for the transaction (XACT) group. */
const RM_TRANSACTION = 10;

/** Transaction record subtypes (PG-compatible). */
export const XACT_RECORD_TYPES = {
  XACT_COMMIT: 0,
  XACT_ABORT: 1,
  XACT_PREPARE: 2,
  XACT_COMMIT_PREPARED: 3,
  XACT_ABORT_PREPARED: 4,
} as const;

/** The reconstructed transaction-state result of a recovery scan. */
export interface RecoveryResult {
  /** Whether the scan found any usable recovery information. */
  recovered: boolean;
  /** XIDs whose commit record was observed. */
  committedXids: number[];
  /** XIDs whose abort record was observed. */
  abortedXids: number[];
  /** XIDs seen only under a prepare marker (no terminal record). */
  inProgressXids: number[];
  /** LSN of the first replayed record, or `0/0` if none. */
  replayStartLSN: string;
  /** LSN of the last replayed record, or `0/0` if none. */
  replayEndLSN: string;
  /** Total number of records replayed across all segments. */
  recordsReplayed: number;
  /** Wall-clock duration of the scan, in milliseconds. */
  durationMs: number;
}

/**
 * Classify a single WAL record's XID into one of the recovery buckets, using
 * the transaction resource-manager value and subtype.
 *
 * Only records belonging to the `Transaction` resource manager contribute to
 * XID state; all other records (Heap, Btree, XLOG, …) are ignored here.
 */
function classifyRecord(record: WalRecord): 'commit' | 'abort' | 'prepare' | 'ignore' {
  if (record.resourceManager !== 'Transaction') return 'ignore';

  switch (record.recordType) {
    case XACT_RECORD_TYPES.XACT_COMMIT:
    case XACT_RECORD_TYPES.XACT_COMMIT_PREPARED:
      return 'commit';
    case XACT_RECORD_TYPES.XACT_ABORT:
    case XACT_RECORD_TYPES.XACT_ABORT_PREPARED:
      return 'abort';
    case XACT_RECORD_TYPES.XACT_PREPARE:
      return 'prepare';
    default:
      return 'ignore';
  }
}

/**
 * Reconstruct MVCC transaction state from WAL segments.
 */
export class MvccCrashRecovery {
  private readonly reader: WalRecordReader;

  /**
   * @param reader - Reader used to discover and parse WAL segments.
   */
  constructor(reader: WalRecordReader) {
    this.reader = reader;
  }

  /**
   * Scan a WAL segment directory and reconstruct the committed / aborted /
   * in-progress XID sets.
   *
   * Runs synchronously: crash recovery is a blocking startup bootstrap step,
   * and both `QueryRouter.runCrashRecovery` and `WALStateManager.recoverFromCrash`
   * call this without `await`.
   *
   * @param segmentDir - Directory containing WAL segment files.
   * @returns A {@link RecoveryResult} describing the reconstructed state.
   */
  recover(segmentDir: string): RecoveryResult {
    const startedAt = Date.now();

    const segments = this.reader.readDirectory(segmentDir);

    const committed = new Set<number>();
    const aborted = new Set<number>();
    const prepared = new Set<number>();
    let recordsReplayed = 0;
    let replayStartLSN = '0/0';
    let replayEndLSN = '0/0';

    for (const segment of segments) {
      for (const record of segment.records) {
        recordsReplayed += 1;

        // Track the replayed LSN range for consumers that need it.
        if (recordsReplayed === 1) replayStartLSN = record.lsn;
        replayEndLSN = record.lsn;

        // Records with XID 0 are non-transactional (e.g. XLOG self-ops).
        if (record.xid === 0) continue;

        const disposition = classifyRecord(record);
        switch (disposition) {
          case 'commit':
            committed.add(record.xid);
            prepared.delete(record.xid);
            break;
          case 'abort':
            aborted.add(record.xid);
            prepared.delete(record.xid);
            break;
          case 'prepare':
            // A prepare marker only matters if no terminal record follows.
            if (!committed.has(record.xid) && !aborted.has(record.xid)) {
              prepared.add(record.xid);
            }
            break;
          case 'ignore':
            break;
        }
      }
    }

    const inProgressXids = [...prepared].sort((a, b) => a - b);
    const committedXids = [...committed].sort((a, b) => a - b);
    const abortedXids = [...aborted].sort((a, b) => a - b);

    const durationMs = Date.now() - startedAt;

    const recovered = recordsReplayed > 0;

    logger.info(
      {
        segmentDir,
        segments: segments.length,
        recordsReplayed,
        committed: committedXids.length,
        aborted: abortedXids.length,
        inProgress: inProgressXids.length,
        durationMs,
      },
      'WAL crash recovery scan complete',
    );

    return {
      recovered,
      committedXids,
      abortedXids,
      inProgressXids,
      replayStartLSN,
      replayEndLSN,
      recordsReplayed,
      durationMs,
    };
  }
}
