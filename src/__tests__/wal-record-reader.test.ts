/**
 * Unit tests for WalRecordReader and MvccCrashRecovery.
 *
 * These tests exercise the full WAL round-trip path: building binary records
 * in the on-disk layout, parsing them back through WalRecordReader, and
 * reconstructing committed/aborted/in-progress XID sets via
 * MvccCrashRecovery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import * as os from 'os';

// Spyable sync fs functions so tests can simulate non-Error throws.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});
import * as path from 'path';
import {
  WalRecordReader,
  parseWalSegment,
  resourceManagerName,
  RESOURCE_MANAGERS,
  WAL_RECORD_HEADER_SIZE,
} from '../recovery/WalRecordReader';
import { MvccCrashRecovery, XACT_RECORD_TYPES } from '../recovery/MvccCrashRecovery';

const RM_TRANSACTION = RESOURCE_MANAGERS.Transaction;
const RM_HEAP = RESOURCE_MANAGERS.Heap;

/** Serialize a single WAL record into the on-disk binary layout. */
function encodeRecord(opts: {
  lsn: number;
  prevLsn: number;
  xid: number;
  rm: number;
  type: number;
  data?: Buffer;
}): Buffer {
  const data = opts.data ?? Buffer.alloc(0);
  const buf = Buffer.alloc(WAL_RECORD_HEADER_SIZE + data.length);
  buf.writeBigUInt64BE(BigInt(opts.lsn), 0);
  buf.writeBigUInt64BE(BigInt(opts.prevLsn), 8);
  buf.writeUInt32BE(opts.xid >>> 0, 16);
  buf.writeUInt32BE(opts.rm, 20);
  buf.writeUInt16BE(opts.type & 0xffff, 24);
  buf.writeUInt32BE(data.length, 26);
  data.copy(buf, WAL_RECORD_HEADER_SIZE);
  return buf;
}

describe('parseWalSegment', () => {
  it('parses a single transaction commit record', () => {
    const buf = encodeRecord({
      lsn: 0x1000,
      prevLsn: 0,
      xid: 42,
      rm: RM_TRANSACTION,
      type: XACT_RECORD_TYPES.XACT_COMMIT,
      data: Buffer.from([1, 2, 3]),
    });
    const records = parseWalSegment(buf);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      xid: 42,
      resourceManager: 'Transaction',
      recordType: XACT_RECORD_TYPES.XACT_COMMIT,
    });
    expect(records[0].data).toEqual(Buffer.from([1, 2, 3]));
    expect(records[0].lsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
  });

  it('parses multiple records in on-disk order', () => {
    const a = encodeRecord({ lsn: 1, prevLsn: 0, xid: 1, rm: RM_TRANSACTION, type: 0 });
    const b = encodeRecord({ lsn: 2, prevLsn: 1, xid: 2, rm: RM_HEAP, type: 0 });
    const records = parseWalSegment(Buffer.concat([a, b]));
    expect(records.map((r) => r.xid)).toEqual([1, 2]);
    expect(records[1].resourceManager).toBe('Heap');
  });

  it('returns an empty list for an empty buffer', () => {
    expect(parseWalSegment(Buffer.alloc(0))).toEqual([]);
  });

  it('returns an empty list for a buffer shorter than a header', () => {
    expect(parseWalSegment(Buffer.from([1, 2, 3]))).toEqual([]);
  });

  it('stops at a torn trailing record', () => {
    // A record declaring a 100-byte payload but with no payload following.
    const header = Buffer.alloc(WAL_RECORD_HEADER_SIZE);
    header.writeBigUInt64BE(1n, 0);
    header.writeUInt32BE(RM_TRANSACTION, 20);
    header.writeUInt32BE(100, 26); // declares 100-byte payload
    const records = parseWalSegment(header);
    expect(records).toHaveLength(0);
  });

  it('still returns intact records before a torn tail', () => {
    const good = encodeRecord({ lsn: 1, prevLsn: 0, xid: 9, rm: RM_TRANSACTION, type: 0, data: Buffer.from([0]) });
    const torn = Buffer.alloc(WAL_RECORD_HEADER_SIZE);
    torn.writeUInt32BE(RM_TRANSACTION, 20);
    torn.writeUInt32BE(9999, 26);
    const records = parseWalSegment(Buffer.concat([good, torn]));
    expect(records.map((r) => r.xid)).toEqual([9]);
  });
});

describe('resourceManagerName', () => {
  it('maps known resource managers', () => {
    expect(resourceManagerName(0)).toBe('XLOG');
    expect(resourceManagerName(10)).toBe('Transaction');
  });

  it('returns UNKNOWN for unmapped values', () => {
    expect(resourceManagerName(99)).toBe('UNKNOWN(99)');
  });
});

describe('WalRecordReader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-reader-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('parses a buffer through the reader instance', () => {
    const reader = new WalRecordReader();
    const buf = encodeRecord({ lsn: 5, prevLsn: 0, xid: 7, rm: RM_TRANSACTION, type: 0 });
    expect(reader.parse(buf).map((r) => r.xid)).toEqual([7]);
  });

  it('reads a single segment file', async () => {
    const reader = new WalRecordReader();
    const buf = encodeRecord({ lsn: 5, prevLsn: 0, xid: 7, rm: RM_TRANSACTION, type: 0 });
    const file = path.join(dir, '000000010000000000000001');
    await fs.writeFile(file, buf);

    const records = reader.readSegment(file);
    expect(records.map((r) => r.xid)).toEqual([7]);
  });

  it('returns empty when the segment file does not exist', async () => {
    const reader = new WalRecordReader();
    expect(reader.readSegment(path.join(dir, 'missing'))).toEqual([]);
  });

  it('lists and sorts valid segment names, ignoring non-segment files', async () => {
    const reader = new WalRecordReader();
    const mk = (name: string, xid: number) => {
      const buf = encodeRecord({ lsn: xid, prevLsn: 0, xid, rm: RM_TRANSACTION, type: 0 });
      return fs.writeFile(path.join(dir, name), buf);
    };
    await mk('000000010000000000000002', 2);
    await mk('000000010000000000000001', 1);
    await fs.writeFile(path.join(dir, 'not-a-segment.txt'), 'junk');
    await fs.writeFile(path.join(dir, 'short'), 'junk');

    const segments = reader.readDirectory(dir);
    expect(segments.map((s) => s.filename)).toEqual([
      '000000010000000000000001',
      '000000010000000000000002',
    ]);
    expect(segments[0].records.map((r) => r.xid)).toEqual([1]);
  });

  it('returns empty when the directory does not exist', async () => {
    const reader = new WalRecordReader();
    expect(reader.readDirectory(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('MvccCrashRecovery.recover', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-recovery-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeSegment(name: string, records: Buffer[]) {
    const file = path.join(dir, name);
    await fs.writeFile(file, Buffer.concat(records));
  }

  function txn(xid: number, type: number) {
    return encodeRecord({ lsn: xid, prevLsn: xid - 1, xid, rm: RM_TRANSACTION, type });
  }

  it('classifies commit, abort, and prepare records', async () => {
    await writeSegment('000000010000000000000001', [
      txn(101, XACT_RECORD_TYPES.XACT_COMMIT),
      txn(102, XACT_RECORD_TYPES.XACT_ABORT),
      txn(103, XACT_RECORD_TYPES.XACT_PREPARE),
    ]);

    const reader = new WalRecordReader();
    const recovery = new MvccCrashRecovery(reader);
    const result = recovery.recover(dir);

    expect(result.recovered).toBe(true);
    expect(result.committedXids).toEqual([101]);
    expect(result.abortedXids).toEqual([102]);
    expect(result.inProgressXids).toEqual([103]);
    expect(result.recordsReplayed).toBe(3);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // The replayed LSN range spans the first to last record's LSN.
    expect(result.replayStartLSN).not.toBe('0/0');
    expect(result.replayEndLSN).not.toBe('0/0');
  });

  it('promotes a prepared XID to committed when a commit record follows', async () => {
    await writeSegment('000000010000000000000001', [
      txn(200, XACT_RECORD_TYPES.XACT_PREPARE),
      txn(200, XACT_RECORD_TYPES.XACT_COMMIT),
    ]);

    const result = new MvccCrashRecovery(new WalRecordReader()).recover(dir);
    expect(result.committedXids).toEqual([200]);
    expect(result.inProgressXids).toEqual([]);
    expect(result.abortedXids).toEqual([]);
  });

  it('handles commit-prepared and abort-prepared subtypes', async () => {
    await writeSegment('000000010000000000000001', [
      txn(301, XACT_RECORD_TYPES.XACT_COMMIT_PREPARED),
      txn(302, XACT_RECORD_TYPES.XACT_ABORT_PREPARED),
    ]);
    const result = new MvccCrashRecovery(new WalRecordReader()).recover(dir);
    expect(result.committedXids).toEqual([301]);
    expect(result.abortedXids).toEqual([302]);
  });

  it('ignores non-transaction records and XID 0', async () => {
    await writeSegment('000000010000000000000001', [
      encodeRecord({ lsn: 1, prevLsn: 0, xid: 0, rm: RM_TRANSACTION, type: XACT_RECORD_TYPES.XACT_COMMIT }),
      encodeRecord({ lsn: 2, prevLsn: 1, xid: 404, rm: RM_HEAP, type: 0 }),
      txn(405, XACT_RECORD_TYPES.XACT_COMMIT),
    ]);
    const result = new MvccCrashRecovery(new WalRecordReader()).recover(dir);
    // Only XID 405 (a real transaction commit) is classified.
    expect(result.committedXids).toEqual([405]);
    expect(result.abortedXids).toEqual([]);
    expect(result.inProgressXids).toEqual([]);
    expect(result.recordsReplayed).toBe(3);
  });

  it('returns recovered=false when no records are found', async () => {
    const result = new MvccCrashRecovery(new WalRecordReader()).recover(dir);
    expect(result.recovered).toBe(false);
    expect(result.recordsReplayed).toBe(0);
    expect(result.committedXids).toEqual([]);
    expect(result.inProgressXids).toEqual([]);
    expect(result.replayStartLSN).toBe('0/0');
    expect(result.replayEndLSN).toBe('0/0');
  });

  it('sorts each XID set ascending across multiple segments', async () => {
    await writeSegment('000000010000000000000001', [txn(3, XACT_RECORD_TYPES.XACT_COMMIT)]);
    await writeSegment('000000010000000000000002', [txn(1, XACT_RECORD_TYPES.XACT_COMMIT)]);
    const result = new MvccCrashRecovery(new WalRecordReader()).recover(dir);
    expect(result.committedXids).toEqual([1, 3]);
  });

  it('ignores an unknown transaction record subtype', async () => {
    await writeSegment('000000010000000000000001', [txn(500, 99)]);
    const result = new MvccCrashRecovery(new WalRecordReader()).recover(dir);
    expect(result.committedXids).toEqual([]);
    expect(result.abortedXids).toEqual([]);
    expect(result.inProgressXids).toEqual([]);
    expect(result.recordsReplayed).toBe(1);
  });
});

describe('MvccCrashRecovery — edge dispositions and ordering', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-recovery-edge-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeSegment(name: string, records: Buffer[]) {
    await fs.writeFile(path.join(dir, name), Buffer.concat(records));
  }

  function txn(xid: number, type: number) {
    return encodeRecord({ lsn: xid, prevLsn: xid - 1, xid, rm: RM_TRANSACTION, type });
  }

  it('ignores a prepare marker for an already-committed XID (out-of-order)', async () => {
    // Commit record arrives first, then a stray prepare for the same XID.
    await writeSegment('000000010000000000000001', [
      txn(600, XACT_RECORD_TYPES.XACT_COMMIT),
      txn(600, XACT_RECORD_TYPES.XACT_PREPARE),
    ]);
    const result = new MvccCrashRecovery(new WalRecordReader()).recover(dir);
    expect(result.committedXids).toEqual([600]);
    expect(result.inProgressXids).toEqual([]);
  });

  it('sorts every XID set ascending when each has multiple entries', async () => {
    await writeSegment('000000010000000000000001', [
      txn(30, XACT_RECORD_TYPES.XACT_COMMIT),
      txn(10, XACT_RECORD_TYPES.XACT_COMMIT),
      txn(40, XACT_RECORD_TYPES.XACT_ABORT),
      txn(20, XACT_RECORD_TYPES.XACT_ABORT),
      txn(50, XACT_RECORD_TYPES.XACT_PREPARE),
      txn(5, XACT_RECORD_TYPES.XACT_PREPARE),
    ]);
    const result = new MvccCrashRecovery(new WalRecordReader()).recover(dir);
    expect(result.committedXids).toEqual([10, 30]);
    expect(result.abortedXids).toEqual([20, 40]);
    expect(result.inProgressXids).toEqual([5, 50]);
  });
});

describe('WalRecordReader — non-Error throw values', () => {
  it('falls back to String(err) when readSegment throws a non-Error', () => {
    vi.spyOn(fsSync, 'readFileSync').mockImplementationOnce(() => {
      throw 'boom-plain-string';
    });
    try {
      const reader = new WalRecordReader();
      expect(reader.readSegment('/anywhere')).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('falls back to String(err) when readDirectory throws a non-Error', () => {
    vi.spyOn(fsSync, 'readdirSync').mockImplementationOnce(() => {
      throw 'boom-readdir';
    });
    try {
      const reader = new WalRecordReader();
      expect(reader.readDirectory('/anywhere')).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
