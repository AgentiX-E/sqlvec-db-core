/**
 * WalRecordReader — reads PostgreSQL-compatible WAL segment files back into
 * logical records for crash recovery and inspection.
 *
 * A WAL segment is a flat sequence of binary records laid out as:
 *
 * ```
 * [8 bytes] LSN       (uint64, big-endian)
 * [8 bytes] Prev-LSN  (uint64, big-endian)
 * [4 bytes] XID       (uint32, big-endian)
 * [4 bytes] ResourceManager (uint32, big-endian)
 * [2 bytes] RecordType      (uint16, big-endian)
 * [4 bytes] DataLength      (uint32, big-endian)
 * [N bytes] Data
 * ```
 *
 * The on-disk format is defined authoritatively by {@link PgWalWriter}; this
 * reader re-declares the structural constants so the recovery module stays
 * self-contained and free of a dependency on the writer (which would couple
 * recovery to the write path and risk an import cycle via WALStateManager).
 *
 * Reads are synchronous: crash recovery runs at startup as a blocking
 * bootstrap step, which both `QueryRouter.runCrashRecovery` and
 * `WALStateManager.recoverFromCrash` call without `await`.  A synchronous
 * contract keeps those call sites correct by construction.
 *
 * @module recovery/WalRecordReader
 */

import * as fs from 'fs';
import * as path from 'path';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('WalRecordReader');

/** Size in bytes of the fixed record header (8 + 8 + 4 + 4 + 2 + 4 = 30). */
export const WAL_RECORD_HEADER_SIZE = 30;

/** Resource-manager enum values (PG-compatible; see PgWalWriter). */
export const RESOURCE_MANAGERS = {
  XLOG: 0,
  Transaction: 10,
  Heap2: 11,
  Heap: 12,
  Btree: 13,
} as const;

/** Human-readable name for a resource-manager enum value. */
export function resourceManagerName(value: number): string {
  const map: Record<number, string> = {
    [RESOURCE_MANAGERS.XLOG]: 'XLOG',
    [RESOURCE_MANAGERS.Transaction]: 'Transaction',
    [RESOURCE_MANAGERS.Heap2]: 'Heap2',
    [RESOURCE_MANAGERS.Heap]: 'Heap',
    [RESOURCE_MANAGERS.Btree]: 'Btree',
  };
  return map[value] ?? `UNKNOWN(${value})`;
}

/** A single logical WAL record recovered from a segment file. */
export interface WalRecord {
  /** LSN in PostgreSQL display format `XXXXXXXX/YYYYYYYY`. */
  lsn: string;
  /** Previous record LSN in PostgreSQL display format. */
  prevLsn: string;
  /** Transaction ID (0 for non-transactional records). */
  xid: number;
  /** Resource-manager name (e.g. `Transaction`, `Heap`). */
  resourceManager: string;
  /** Record subtype within its resource manager. */
  recordType: number;
  /** Raw binary payload. */
  data: Buffer;
  /** Epoch milliseconds when the record was parsed (not stored on disk). */
  timestamp: number;
}

/** A parsed WAL segment: its source filename plus all records it contained. */
export interface WalSegmentRead {
  /** Segment filename (not the full path). */
  filename: string;
  /** Records recovered from the segment, in on-disk order. */
  records: WalRecord[];
}

/**
 * Convert a byte-position LSN to PostgreSQL display format `X/Y`.
 */
function lsnBytesToString(lsnBytes: number): string {
  const upper = Math.floor(lsnBytes / 0x100000000);
  const lower = lsnBytes >>> 0;
  return `${upper.toString(16).toUpperCase()}/${lower.toString(16).toUpperCase()}`;
}

/**
 * Parse a binary WAL segment buffer into an ordered list of records.
 *
 * A malformed/truncated trailing record is skipped defensively: the reader
 * stops at the first record whose declared payload does not fit in the
 * remaining buffer, mirroring PostgreSQL's tolerance for a torn final record
 * after a crash.
 *
 * @param data - Raw binary segment contents.
 * @returns The records recovered from the buffer.
 */
export function parseWalSegment(data: Buffer): WalRecord[] {
  const records: WalRecord[] = [];
  let offset = 0;

  while (offset + WAL_RECORD_HEADER_SIZE <= data.length) {
    const lsn = Number(data.readBigUInt64BE(offset));
    const prevLsn = Number(data.readBigUInt64BE(offset + 8));
    const xid = data.readUInt32BE(offset + 16);
    const rm = data.readUInt32BE(offset + 20);
    const recordType = data.readUInt16BE(offset + 24);
    const dataLength = data.readUInt32BE(offset + 26);

    // The payload extends beyond the buffer — a torn partial record.
    if (offset + WAL_RECORD_HEADER_SIZE + dataLength > data.length) {
      logger.debug(
        {
          offset,
          declaredLength: dataLength,
          remaining: data.length - offset - WAL_RECORD_HEADER_SIZE,
        },
        'Truncated WAL record at end of segment — stopping parse',
      );
      break;
    }

    const payload = Buffer.alloc(dataLength);
    data.copy(payload, 0, offset + WAL_RECORD_HEADER_SIZE, offset + WAL_RECORD_HEADER_SIZE + dataLength);

    records.push({
      lsn: lsnBytesToString(lsn),
      prevLsn: lsnBytesToString(prevLsn),
      xid,
      resourceManager: resourceManagerName(rm),
      recordType,
      data: payload,
      timestamp: Date.now(),
    });

    offset += WAL_RECORD_HEADER_SIZE + dataLength;
  }

  return records;
}

/**
 * A reader for WAL segment files, decoupling segment discovery from the
 * parser so recovery logic can be exercised against in-memory data in tests.
 */
export class WalRecordReader {
  /**
   * Parse a single segment buffer into records.
   *
   * @param data - Raw binary segment contents.
   * @returns The records recovered from the buffer.
   */
  parse(data: Buffer): WalRecord[] {
    return parseWalSegment(data);
  }

  /**
   * Read and parse a single segment file from disk.
   *
   * @param filePath - Path to the segment file.
   * @returns The records recovered from the file; empty if the file is
   *          unreadable or does not exist.
   */
  readSegment(filePath: string): WalRecord[] {
    try {
      const data = fs.readFileSync(filePath);
      return parseWalSegment(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ filePath, err: message }, 'Failed to read WAL segment');
      return [];
    }
  }

  /**
   * Read and parse every segment file in a directory.
   *
   * Only files whose names are valid 24-hex-digit PostgreSQL segment names
   * are considered; other files in the directory are ignored.
   *
   * @param segmentDir - Directory containing WAL segment files.
   * @returns A list of parsed segments, sorted by segment filename so records
   *          are returned in logical append order.
   */
  readDirectory(segmentDir: string): WalSegmentRead[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(segmentDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ segmentDir, err: message }, 'Failed to list WAL segment directory');
      return [];
    }

    const segmentNames = entries.filter((name) => /^[0-9A-Fa-f]{24}$/.test(name)).sort();

    const results: WalSegmentRead[] = [];
    for (const name of segmentNames) {
      const filePath = path.join(segmentDir, name);
      results.push({ filename: name, records: this.readSegment(filePath) });
    }
    return results;
  }
}
