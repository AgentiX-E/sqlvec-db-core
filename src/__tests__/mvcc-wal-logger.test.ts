import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MvccWalLogger,
  encodeTableName,
  decodeTableName,
  TABLE_NAME_PREFIX_SIZE,
  type LogInsertParams,
  type LogDeleteParams,
  type LogUpdateParams,
} from '../query/MvccWalLogger';
import { HEAP_RECORD_TYPES, XACT_RECORD_TYPES } from '../storage/PgWalWriter';

// Minimal PgWalWriter stub exposing only the methods MvccWalLogger calls.
function makeWriter() {
  return {
    writeRecord: vi.fn(),
    writeCommit: vi.fn(),
    writeAbort: vi.fn(),
  } as any;
}

describe('encodeTableName / decodeTableName', () => {
  it('round-trips a table name', () => {
    const encoded = encodeTableName('users');
    expect(encoded.length).toBe(TABLE_NAME_PREFIX_SIZE + 'users'.length);
    expect(encoded.readUInt16BE(0)).toBe('users'.length);
    const [name, offset] = decodeTableName(encoded);
    expect(name).toBe('users');
    expect(offset).toBe(encoded.length);
  });

  it('round-trips a multibyte (utf-8) table name', () => {
    const encoded = encodeTableName('用户表');
    const len = Buffer.byteLength('用户表', 'utf-8');
    expect(encoded.readUInt16BE(0)).toBe(len);
    const [name, offset] = decodeTableName(encoded);
    expect(name).toBe('用户表');
    expect(offset).toBe(TABLE_NAME_PREFIX_SIZE + len);
  });

  it('round-trips an empty table name', () => {
    const encoded = encodeTableName('');
    expect(encoded.length).toBe(TABLE_NAME_PREFIX_SIZE);
    expect(encoded.readUInt16BE(0)).toBe(0);
    const [name, offset] = decodeTableName(encoded);
    expect(name).toBe('');
    expect(offset).toBe(TABLE_NAME_PREFIX_SIZE);
  });

  it('decodeTableName honors an explicit offset', () => {
    const a = encodeTableName('aaa');
    const b = encodeTableName('bbbb');
    const combined = Buffer.concat([a, b]);
    // first decode at offset 0
    const [n1, o1] = decodeTableName(combined, 0);
    expect(n1).toBe('aaa');
    // second decode resumes after the first
    const [n2, o2] = decodeTableName(combined, o1);
    expect(n2).toBe('bbbb');
    expect(o2).toBe(combined.length);
  });
});

describe('MvccWalLogger.logInsert', () => {
  let writer: any;
  let lo: MvccWalLogger;

  beforeEach(() => {
    writer = makeWriter();
    lo = new MvccWalLogger(writer);
  });

  it('writes a HEAP_INSERT record with table prefix + offnum + flags + xmin + xmax + json', () => {
    const params: LogInsertParams = { sessionId: 's1', table: 't', data: { a: 1 }, xmin: 42 };
    lo.logInsert(params);

    expect(writer.writeRecord).toHaveBeenCalledTimes(1);
    const call = writer.writeRecord.mock.calls[0][0];
    expect(call.resourceManager).toBe('Heap');
    expect(call.recordType).toBe(HEAP_RECORD_TYPES.HEAP_INSERT);
    expect(call.xid).toBe(42);
    expect(call.table).toBe('t');

    // Binary layout: [tableLen:2][tableName][offnum:4][flags:4][xmin:4][xmax:4][json:N]
    const buf: Buffer = call.data;
    const [tableName, off] = decodeTableName(buf, 0);
    expect(tableName).toBe('t');
    expect(off).toBe(TABLE_NAME_PREFIX_SIZE + 1);
    const offnum = buf.readUInt32BE(off); off;
    // offnum + flags + xmin + xmax are the next four 32-bit words
    expect(offnum).toBe(0);
    const flags = buf.readUInt32BE(TABLE_NAME_PREFIX_SIZE + 1 + 4);
    expect(flags).toBe(0);
    const xmin = buf.readUInt32BE(TABLE_NAME_PREFIX_SIZE + 1 + 8);
    expect(xmin).toBe(42);
    const xmax = buf.readUInt32BE(TABLE_NAME_PREFIX_SIZE + 1 + 12);
    expect(xmax).toBe(0);
    const json = buf.toString('utf-8', TABLE_NAME_PREFIX_SIZE + 1 + 16);
    expect(json).toBe('{"a":1}');
  });
});

describe('MvccWalLogger.logDelete', () => {
  let writer: any;
  let lo: MvccWalLogger;

  beforeEach(() => {
    writer = makeWriter();
    lo = new MvccWalLogger(writer);
  });

  it('writes a HEAP_DELETE record with table prefix + offnum + flags + xmax + json', () => {
    const params: LogDeleteParams = { sessionId: 's1', table: 't', oldData: { a: 1 }, xmin: 10, xmax: 99 };
    lo.logDelete(params);

    const call = writer.writeRecord.mock.calls[0][0];
    expect(call.recordType).toBe(HEAP_RECORD_TYPES.HEAP_DELETE);
    expect(call.xid).toBe(99);
    expect(call.table).toBe('t');

    const buf: Buffer = call.data;
    const [tableName, off] = decodeTableName(buf, 0);
    expect(tableName).toBe('t');
    // offnum:0 flags:0 xmax:99 + json
    expect(buf.readUInt32BE(off)).toBe(0); // offnum
    expect(buf.readUInt32BE(off + 4)).toBe(0); // flags
    expect(buf.readUInt32BE(off + 8)).toBe(99); // xmax
    expect(buf.toString('utf-8', off + 12)).toBe('{"a":1}');
  });
});

describe('MvccWalLogger.logUpdate', () => {
  let writer: any;
  let lo: MvccWalLogger;

  beforeEach(() => {
    writer = makeWriter();
    lo = new MvccWalLogger(writer);
  });

  it('writes a HEAP_UPDATE record with old and new tuple data', () => {
    const params: LogUpdateParams = { sessionId: 's1', table: 't', oldData: { a: 1 }, newData: { a: 2 }, xmin: 10, xmax: 99 };
    lo.logUpdate(params);

    const call = writer.writeRecord.mock.calls[0][0];
    expect(call.recordType).toBe(HEAP_RECORD_TYPES.HEAP_UPDATE);
    expect(call.xid).toBe(99);
    expect(call.table).toBe('t');

    const buf: Buffer = call.data;
    const [, off] = decodeTableName(buf, 0);
    // offnum(4) newOffnum(4) flags(4) newXmax(4) oldLen(4) oldData newLen(4) newData
    expect(buf.readUInt32BE(off)).toBe(0); // offnum
    expect(buf.readUInt32BE(off + 4)).toBe(1); // newOffnum
    expect(buf.readUInt32BE(off + 8)).toBe(0); // flags
    expect(buf.readUInt32BE(off + 12)).toBe(99); // newXmax
    const oldLen = buf.readUInt32BE(off + 16);
    expect(oldLen).toBe('{"a":1}'.length);
    const oldData = buf.toString('utf-8', off + 20, off + 20 + oldLen);
    expect(oldData).toBe('{"a":1}');
    const newLen = buf.readUInt32BE(off + 20 + oldLen);
    expect(newLen).toBe('{"a":2}'.length);
    const newData = buf.toString('utf-8', off + 20 + oldLen + 4);
    expect(newData).toBe('{"a":2}');
  });
});

describe('MvccWalLogger commit / abort / getWriter', () => {
  it('logCommit delegates to writer.writeCommit', () => {
    const writer = makeWriter();
    const lo = new MvccWalLogger(writer);
    lo.logCommit('s1', 123);
    expect(writer.writeCommit).toHaveBeenCalledWith(123);
  });

  it('logAbort delegates to writer.writeAbort', () => {
    const writer = makeWriter();
    const lo = new MvccWalLogger(writer);
    lo.logAbort('s1', 456);
    expect(writer.writeAbort).toHaveBeenCalledWith(456);
  });

  it('getWriter returns the underlying writer', () => {
    const writer = makeWriter();
    const lo = new MvccWalLogger(writer);
    expect(lo.getWriter()).toBe(writer);
  });
});

describe('MvccWalLogger — multibyte data payloads', () => {
  it('sizes JSON with byteLength (utf-8) not string length', () => {
    const writer = makeWriter();
    const lo = new MvccWalLogger(writer);
    // '中文' is 3 bytes per char in utf-8
    lo.logInsert({ sessionId: 's', table: 't', data: { v: '中文' }, xmin: 1 });
    const buf: Buffer = writer.writeRecord.mock.calls[0][0].data;
    const [, off] = decodeTableName(buf, 0);
    const json = buf.toString('utf-8', off + 16);
    expect(json).toBe(JSON.stringify({ v: '中文' }));
  });
});
