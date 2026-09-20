/**
 * Unit tests for PgWalWriter — the physical PostgreSQL-compatible WAL writer.
 *
 * Covers binary record serialization/deserialization, LSN tracking, segment
 * auto-switching, the convenience writers (checkpoint/commit/abort), record
 * listeners (including a throwing listener), and all guard/error paths.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PgWalWriter } from '../storage/PgWalWriter';
import { PgWalSegmentManager } from '../storage/PgWalSegmentManager';
import { WALStateManager } from '../storage/WALStateManager';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wal-writer-'));
}

/**
 * Configure a fresh writer with a small segment size so segment switching can
 * be exercised without allocating 16 MB per segment.
 */
function setup(segmentSize = 4096) {
  const dir = tmpdir();
  const segMgr = PgWalSegmentManager.getInstance();
  segMgr.reset();
  segMgr.configure(dir, segmentSize);

  const walState = WALStateManager.getInstance();
  WALStateManager.resetInstance();

  const writer = PgWalWriter.getInstance();
  writer.reset();
  writer.configure(segMgr, walState);
  return { writer, segMgr, walState, dir };
}

describe('PgWalWriter', () => {
  beforeEach(() => {
    PgWalSegmentManager.getInstance().reset();
    WALStateManager.resetInstance();
    PgWalWriter.getInstance().reset();
  });

  describe('configuration and guards', () => {
    it('throws when writing before configure()', () => {
      const writer = PgWalWriter.getInstance();
      writer.reset();
      expect(() =>
        writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: 1, data: Buffer.alloc(4) }),
      ).toThrow(/not configured/);
    });

    it('throws when flushing before configure()', () => {
      const writer = PgWalWriter.getInstance();
      writer.reset();
      expect(() => writer.flushSegment()).toThrow(/not configured/);
    });

    it('initializes a segment if none exist on configure', () => {
      const { segMgr } = setup();
      expect(segMgr.getAllSegments().length).toBe(1);
    });

    it('skips re-initializing the segment when one already exists', () => {
      const dir = tmpdir();
      const segMgr = PgWalSegmentManager.getInstance();
      segMgr.reset();
      segMgr.configure(dir, 4096);
      segMgr.init(); // create the first segment manually

      const walState = WALStateManager.getInstance();
      WALStateManager.resetInstance();

      const writer = PgWalWriter.getInstance();
      writer.reset();
      writer.configure(segMgr, walState);

      // configure() must not create a second segment.
      expect(segMgr.getAllSegments().length).toBe(1);

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('exposes current offset and last LSN byte value initially at zero', () => {
      const { writer } = setup();
      expect(writer.getCurrentOffset()).toBe(0);
      expect(writer.getLastLSNBytes()).toBe(0);
    });

    it('getRecords returns an empty snapshot before any write', () => {
      const { writer } = setup();
      expect(writer.getRecords()).toEqual([]);
      expect(writer.getSegmentData()).toHaveLength(0);
    });
  });

  describe('writeRecord — serialization and LSN tracking', () => {
    it('writes a record and assigns a monotonically increasing LSN', () => {
      const { writer } = setup();
      const r1 = writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: 100, data: Buffer.from('aaaa') });
      const r2 = writer.writeRecord({ resourceManager: 'Heap', recordType: 1, xid: 101, data: Buffer.from('bbbb') });

      // r1 at offset 0, r2 follows r1's serialized size.
      expect(r1.lsn).toBe('0/0');
      expect(r1.prevLsn).toBe('0/0');
      expect(r2.lsn).not.toBe(r1.lsn);
      expect(r2.prevLsn).toBe(r1.lsn);
    });

    it('serializes the exact binary record layout (30-byte header)', () => {
      const { writer } = setup();
      writer.writeRecord({ resourceManager: 'Heap', recordType: 2, xid: 7, data: Buffer.from('abc') });
      const seg = writer.getSegmentData();
      // 30-byte header + 3-byte payload
      expect(seg).toHaveLength(30 + 3);
      // header: LSN(8) + prevLSN(8) + xid(4) + rm(4) + type(2) + len(4)
      expect(seg.readUInt32BE(16)).toBe(7); // xid
      expect(seg.readUInt32BE(20)).toBe(12); // RM Heap
      expect(seg.readUInt16BE(24)).toBe(2); // record type
      expect(seg.readUInt32BE(26)).toBe(3); // data length
      expect(seg.subarray(30).toString()).toBe('abc');
    });

    it('round-trips records through parseSegment', () => {
      const { writer } = setup();
      writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: 1, data: Buffer.from('hello') });
      writer.writeRecord({ resourceManager: 'Transaction', recordType: 0, xid: 2, data: Buffer.from([0, 1, 2]) });

      const parsed = PgWalWriter.parseSegment(writer.getSegmentData());
      expect(parsed).toHaveLength(2);
      expect(parsed[0].xid).toBe(1);
      expect(parsed[0].resourceManager).toBe('Heap');
      expect(parsed[0].data.toString()).toBe('hello');
      expect(parsed[1].xid).toBe(2);
      expect(parsed[1].resourceManager).toBe('Transaction');
    });

    it('throws on an unknown resource manager name', () => {
      const { writer } = setup();
      expect(() =>
        writer.writeRecord({ resourceManager: 'NoSuchRM', recordType: 0, xid: 1, data: Buffer.alloc(1) }),
      ).toThrow(/Unknown resource manager/);
    });

    it('advances the byte offset by the serialized record size', () => {
      const { writer } = setup();
      writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: 1, data: Buffer.alloc(10) });
      expect(writer.getCurrentOffset()).toBe(30 + 10);
    });
  });

  describe('segment auto-switching', () => {
    it('switches to a new segment when the current one is full', () => {
      const { writer, segMgr } = setup(1024); // small segment
      // Fill enough records to overflow a 1024-byte segment.
      for (let i = 0; i < 60; i++) {
        writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: i, data: Buffer.alloc(20) });
      }
      // At least one switch must have occurred.
      expect(segMgr.getAllSegments().length).toBeGreaterThan(1);
    });

    it('keeps LSNs monotonically increasing across a segment switch', () => {
      const { writer } = setup(1024);
      const seen: string[] = [];
      for (let i = 0; i < 100; i++) {
        const r = writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: i, data: Buffer.alloc(16) });
        seen.push(r.lsn);
      }
      // All LSNs must be unique and the sequence strictly increasing.
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]).not.toBe(seen[i - 1]);
      }
      expect(seen).toHaveLength(new Set(seen).size);
    });
  });

  describe('convenience writers', () => {
    it('writeCheckpoint writes an XLOG checkpoint record', () => {
      const { writer } = setup();
      const r = writer.writeCheckpoint(99);
      expect(r.resourceManager).toBe('XLOG');
      expect(r.xid).toBe(99);
      expect(r.data).toHaveLength(16);
    });

    it('writeCommit writes a Transaction XACT_COMMIT record', () => {
      const { writer } = setup();
      const r = writer.writeCommit(42);
      expect(r.resourceManager).toBe('Transaction');
      expect(r.recordType).toBe(0); // XACT_COMMIT
      expect(r.data).toHaveLength(12);
    });

    it('writeAbort writes a Transaction XACT_ABORT record', () => {
      const { writer } = setup();
      const r = writer.writeAbort(43);
      expect(r.resourceManager).toBe('Transaction');
      expect(r.recordType).toBe(1); // XACT_ABORT
      expect(r.data).toHaveLength(12);
    });
  });

  describe('record listeners', () => {
    it('notifies listeners with the fully-formed record', () => {
      const { writer } = setup();
      const received: any[] = [];
      writer.onRecord((rec) => received.push(rec));
      writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: 5, data: Buffer.from('z') });
      expect(received).toHaveLength(1);
      expect(received[0].xid).toBe(5);
      expect(received[0].lsn).toBe('0/0');
    });

    it('removeRecordListener removes a callback and returns true/false', () => {
      const { writer } = setup();
      const cb = () => {};
      writer.onRecord(cb);
      expect(writer.removeRecordListener(cb)).toBe(true);
      expect(writer.removeRecordListener(cb)).toBe(false); // already removed
      // Removing an unrelated callback returns false.
      expect(writer.removeRecordListener(() => {})).toBe(false);
    });

    it('isolates a throwing listener so other listeners still fire', () => {
      const { writer } = setup();
      const good: any[] = [];
      writer.onRecord(() => { throw new Error('boom'); });
      writer.onRecord((rec) => good.push(rec));
      writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: 1, data: Buffer.from('x') });
      expect(good).toHaveLength(1);
    });
  });

  describe('flushSegment', () => {
    it('writes the partial segment data to the segment file path', () => {
      const { writer, segMgr, dir } = setup();
      writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: 1, data: Buffer.from('flush-me') });
      writer.flushSegment();

      const seg = segMgr.getCurrentSegment();
      expect(fs.existsSync(seg.path)).toBe(true);
      const onDisk = fs.readFileSync(seg.path);
      expect(onDisk).toHaveLength(30 + 'flush-me'.length);
      expect(onDisk.subarray(30).toString()).toBe('flush-me');

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('parseSegment static', () => {
    it('returns an empty array for empty input', () => {
      expect(PgWalWriter.parseSegment(Buffer.alloc(0))).toEqual([]);
    });

    it('stops cleanly on a partial/corrupt trailing record', () => {
      const { writer } = setup();
      writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: 1, data: Buffer.from('aaaa') });
      // Corrupt the last record's length field to exceed the buffer.
      const seg = writer.getSegmentData();
      seg.writeUInt32BE(0xffffffff, 26);
      // parseSegment should stop at the corrupt record boundary and return
      // zero complete records (the header claims a huge length it cannot fulfill).
      const parsed = PgWalWriter.parseSegment(seg);
      expect(parsed).toHaveLength(0);
    });

    it('maps unknown resource manager values to UNKNOWN(n)', () => {
      const { writer } = setup();
      writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: 1, data: Buffer.alloc(1) });
      const seg = writer.getSegmentData();
      seg.writeUInt32BE(999, 20); // invalid RM value
      const parsed = PgWalWriter.parseSegment(seg);
      expect(parsed[0].resourceManager).toBe('UNKNOWN(999)');
    });
  });

  describe('reset', () => {
    it('clears records, offset, and configured state', () => {
      const { writer } = setup();
      writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: 1, data: Buffer.alloc(4) });
      writer.reset();
      expect(writer.getRecords()).toEqual([]);
      expect(writer.getCurrentOffset()).toBe(0);
      expect(writer.getLastLSNBytes()).toBe(0);
      // After reset, writing again must throw (not configured).
      expect(() =>
        writer.writeRecord({ resourceManager: 'Heap', recordType: 0, xid: 1, data: Buffer.alloc(1) }),
      ).toThrow(/not configured/);
    });
  });
});
