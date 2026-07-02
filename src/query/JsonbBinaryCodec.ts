/**
 * JsonbBinaryCodec — PostgreSQL 16-compatible JSONB binary encoding/decoding.
 *
 * PG 16 JSONB binary format (simplified for embeddable use):
 *
 * Container Header (4 bytes, big-endian uint32):
 *   - Bit 31: Version flag (must be 1)
 *   - Bit 30: Raw scalar flag (value is a scalar, not container)
 *   - Bit 29: (NEW) Object flag — distinguishes object from array when bit 30 is 0
 *   - Bits 23-0: Element count (for arrays/objects) or 0 (for scalars)
 *
 * JEntry (JSON Entry) format (used for key/value elements):
 *   - 4 bytes: data length (big-endian uint32)
 *   - N bytes: data (for string/number = UTF-8 text; for object/array = full container)
 *   - 1 byte: type tag
 *
 * Type tags (1 byte):
 *   - 0x00: null     (no data)
 *   - 0x01: string   (data = UTF-8 text)
 *   - 0x02: number   (data = UTF-8 numeric text)
 *   - 0x03: false    (no data)
 *   - 0x04: true     (no data)
 *   - 0x05: object   (data = full container with object header)
 *   - 0x06: array    (data = full container with array header)
 *
 * Top-level layout:
 *   Scalar:  header(4) + JEntry(4+N+1)
 *   Array:   header(4) + JEntry[0] + ... + JEntry[N-1]
 *   Object:  header(4) + (key JEntries) + (value JEntries in same order)
 *
 * All keys are stored in sorted order (this is what makes JSONB special vs JSON).
 *
 * @module query/JsonbBinaryCodec
 */

// ── Binary format constants ───────────────────────────────────────────────

export const JSONB_VERSION_1 = 0x80000000;
export const JSONB_SCALAR    = 0x40000000;
export const JSONB_IS_OBJECT = 0x20000000;

export const JSONB_TAG_NULL   = 0x00;
export const JSONB_TAG_STRING = 0x01;
export const JSONB_TAG_NUMBER = 0x02;
export const JSONB_TAG_FALSE  = 0x03;
export const JSONB_TAG_TRUE   = 0x04;
export const JSONB_TAG_OBJECT = 0x05;
export const JSONB_TAG_ARRAY  = 0x06;

// ── Public API ────────────────────────────────────────────────────────────

export function encodeJsonb(value: unknown): Buffer {
  return encodeJsonbContainer(value);
}

export function decodeJsonb(buffer: Buffer): unknown {
  if (buffer.length < 4) {
    throw new Error(`decodeJsonb: buffer too short (${buffer.length} bytes, need >= 4)`);
  }
  const header = buffer.readUInt32BE(0);
  if (!(header & JSONB_VERSION_1)) {
    throw new Error(`decodeJsonb: invalid version header: 0x${header.toString(16)}`);
  }

  if (header & JSONB_SCALAR) {
    return decodeJentry(buffer, 4);
  }
  if (header & JSONB_IS_OBJECT) {
    return decodeObjectContainer(buffer, 0);
  }
  return decodeArrayContainer(buffer, 0);
}

export function jsonbTypeof(buffer: Buffer): string {
  if (buffer.length < 9) return 'null';
  const header = buffer.readUInt32BE(0);
  if (header & JSONB_SCALAR) {
    const entryDataLen = buffer.readUInt32BE(4);
    const tag = buffer[8 + entryDataLen];
    switch (tag) {
      case JSONB_TAG_NULL:   return 'null';
      case JSONB_TAG_TRUE:
      case JSONB_TAG_FALSE:  return 'boolean';
      case JSONB_TAG_NUMBER: return 'number';
      case JSONB_TAG_STRING: return 'string';
      case JSONB_TAG_OBJECT: return 'object';
      case JSONB_TAG_ARRAY:  return 'array';
      default:               return 'unknown';
    }
  }
  return (header & JSONB_IS_OBJECT) ? 'object' : 'array';
}

// ── Scalar encoding ──────────────────────────────────────────────────────

function makeHeader(scalar: boolean, isObject: boolean, count: number): number {
  let h = JSONB_VERSION_1;
  if (scalar) h |= JSONB_SCALAR;
  if (isObject) h |= JSONB_IS_OBJECT;
  h |= (count & 0x00FFFFFF);
  return h >>> 0;
}

function encodeJsonbContainer(value: unknown): Buffer {
  if (value === null) return encodeScalarNull();
  if (typeof value === 'boolean') return encodeScalarBool(value);
  if (typeof value === 'number') return encodeScalarNumber(value);
  if (typeof value === 'string') return encodeScalarString(value);
  if (Array.isArray(value)) return encodeArrayContainer(value);
  if (typeof value === 'object') return encodeObjectContainer(value as Record<string, unknown>);
  return encodeScalarNull();
}

function encodeScalarNull(): Buffer {
  const jentry = allocJentry(0);
  jentry.writeUInt32BE(0, 0);
  jentry[4] = JSONB_TAG_NULL;
  const buf = Buffer.alloc(4 + jentry.length);
  buf.writeUInt32BE(makeHeader(true, false, 0), 0);
  jentry.copy(buf, 4);
  return buf;
}

function encodeScalarBool(val: boolean): Buffer {
  const jentry = allocJentry(0);
  jentry.writeUInt32BE(0, 0);
  jentry[4] = val ? JSONB_TAG_TRUE : JSONB_TAG_FALSE;
  const buf = Buffer.alloc(4 + jentry.length);
  buf.writeUInt32BE(makeHeader(true, false, 0), 0);
  jentry.copy(buf, 4);
  return buf;
}

function encodeScalarNumber(val: number): Buffer {
  const raw = Buffer.from(String(val), 'utf-8');
  const jentry = allocJentry(raw.length + 1);
  jentry.writeUInt32BE(raw.length, 0);
  raw.copy(jentry, 4);
  jentry[4 + raw.length] = JSONB_TAG_NUMBER;
  const buf = Buffer.alloc(4 + jentry.length);
  buf.writeUInt32BE(makeHeader(true, false, 0), 0);
  jentry.copy(buf, 4);
  return buf;
}

function encodeScalarString(val: string): Buffer {
  const raw = Buffer.from(val, 'utf-8');
  const jentry = allocJentry(raw.length + 1);
  jentry.writeUInt32BE(raw.length, 0);
  raw.copy(jentry, 4);
  jentry[4 + raw.length] = JSONB_TAG_STRING;
  const buf = Buffer.alloc(4 + jentry.length);
  buf.writeUInt32BE(makeHeader(true, false, 0), 0);
  jentry.copy(buf, 4);
  return buf;
}

// ── Array encoding ──────────────────────────────────────────────────────

function encodeArrayContainer(arr: unknown[]): Buffer {
  const jentries: Buffer[] = arr.map(encodeJentry);
  const dataLen = jentries.reduce((s, j) => s + j.length, 0);
  const buf = Buffer.alloc(4 + dataLen);
  buf.writeUInt32BE(makeHeader(false, false, arr.length), 0);
  let off = 4;
  for (const j of jentries) { j.copy(buf, off); off += j.length; }
  return buf;
}

// ── Object encoding (sorted keys!) ─────────────────────────────────────

function encodeObjectContainer(obj: Record<string, unknown>): Buffer {
  const keys = Object.keys(obj).sort();
  // Key JEntries: each is len(4) + key text + tag(1)
  const keyJentries: Buffer[] = keys.map(k => {
    const raw = Buffer.from(k, 'utf-8');
    const j = allocJentry(raw.length + 1);
    j.writeUInt32BE(raw.length, 0);
    raw.copy(j, 4);
    j[4 + raw.length] = JSONB_TAG_STRING;
    return j;
  });
  // Value JEntries
  const valJentries: Buffer[] = keys.map(k => encodeJentry(obj[k]));
  const dataLen = keyJentries.reduce((s, j) => s + j.length, 0) +
                  valJentries.reduce((s, j) => s + j.length, 0);
  const buf = Buffer.alloc(4 + dataLen);
  buf.writeUInt32BE(makeHeader(false, true, keys.length), 0);
  let off = 4;
  for (const j of keyJentries) { j.copy(buf, off); off += j.length; }
  for (const j of valJentries) { j.copy(buf, off); off += j.length; }
  return buf;
}

// ── Generic JEntry encoding ────────────────────────────────────────────

function encodeJentry(value: unknown): Buffer {
  if (value === null) {
    const j = allocJentry(0);
    j.writeUInt32BE(0, 0);
    j[4] = JSONB_TAG_NULL;
    return j;
  }
  if (typeof value === 'boolean') {
    const j = allocJentry(0);
    j.writeUInt32BE(0, 0);
    j[4] = value ? JSONB_TAG_TRUE : JSONB_TAG_FALSE;
    return j;
  }
  if (typeof value === 'number') {
    const raw = Buffer.from(String(value), 'utf-8');
    const j = allocJentry(raw.length + 1);
    j.writeUInt32BE(raw.length, 0);
    raw.copy(j, 4);
    j[4 + raw.length] = JSONB_TAG_NUMBER;
    return j;
  }
  if (typeof value === 'string') {
    const raw = Buffer.from(value, 'utf-8');
    const j = allocJentry(raw.length + 1);
    j.writeUInt32BE(raw.length, 0);
    raw.copy(j, 4);
    j[4 + raw.length] = JSONB_TAG_STRING;
    return j;
  }
  if (Array.isArray(value)) {
    const sub = encodeArrayContainer(value);
    const j = allocJentry(sub.length + 1);
    j.writeUInt32BE(sub.length, 0);
    sub.copy(j, 4);
    j[4 + sub.length] = JSONB_TAG_ARRAY;
    return j;
  }
  if (typeof value === 'object') {
    const sub = encodeObjectContainer(value as Record<string, unknown>);
    const j = allocJentry(sub.length + 1);
    j.writeUInt32BE(sub.length, 0);
    sub.copy(j, 4);
    j[4 + sub.length] = JSONB_TAG_OBJECT;
    return j;
  }
  return encodeJentry(null);
}

function allocJentry(minSize: number): Buffer {
  return Buffer.alloc(Math.max(4 + minSize, 5));
}

// ── Decoding ─────────────────────────────────────────────────────────────

function decodeJentry(buf: Buffer, off: number): unknown {
  const dataLen = buf.readUInt32BE(off);
  const tag = buf[off + 4 + dataLen]; // tag is AFTER the data
  switch (tag) {
    case JSONB_TAG_NULL:         return null;
    case JSONB_TAG_TRUE:         return true;
    case JSONB_TAG_FALSE:        return false;
    case JSONB_TAG_NUMBER: {
      const s = buf.toString('utf-8', off + 4, off + 4 + dataLen);
      const n = Number(s);
      return Number.isNaN(n) ? 0 : n;
    }
    case JSONB_TAG_STRING:
      return buf.toString('utf-8', off + 4, off + 4 + dataLen);
    case JSONB_TAG_OBJECT:
      return decodeObjectContainer(buf, off + 4);
    case JSONB_TAG_ARRAY:
      return decodeArrayContainer(buf, off + 4);
    default:
      throw new Error(`decodeJentry: unknown tag 0x${tag.toString(16)}`);
  }
}

function decodeArrayContainer(buf: Buffer, off: number): unknown[] {
  const header = buf.readUInt32BE(off);
  const count = header & 0x00FFFFFF;
  const arr: unknown[] = [];
  let pos = off + 4;
  for (let i = 0; i < count && pos <= buf.length - 5; i++) {
    const dataLen = buf.readUInt32BE(pos);
    const totalJentrySize = 5 + dataLen; // len(4) + data(dataLen) + tag(1)
    arr.push(decodeJentry(buf, pos));
    pos += totalJentrySize;
  }
  return arr;
}

function decodeObjectContainer(buf: Buffer, off: number): Record<string, unknown> {
  const header = buf.readUInt32BE(off);
  const count = header & 0x00FFFFFF;
  let pos = off + 4;

  // Read keys
  const keys: string[] = [];
  for (let i = 0; i < count && pos <= buf.length - 5; i++) {
    const keyLen = buf.readUInt32BE(pos);
    const key = buf.toString('utf-8', pos + 4, pos + 4 + keyLen);
    keys.push(key);
    pos += 5 + keyLen; // len(4) + keyText + tag(1)
  }

  // Read values
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < count && pos <= buf.length - 5; i++) {
    const dataLen = buf.readUInt32BE(pos);
    obj[keys[i]] = decodeJentry(buf, pos);
    pos += 5 + dataLen; // len(4) + data + tag(1)
  }
  return obj;
}

function computeJentryPayloadSize(tag: number, dataLen: number): number {
  if (tag === JSONB_TAG_NULL || tag === JSONB_TAG_TRUE || tag === JSONB_TAG_FALSE) {
    return 0;
  }
  return dataLen;
}

// ── Query helpers ─────────────────────────────────────────────────────

export function jsonbExtractKey(buffer: Buffer, key: string): unknown {
  if (buffer.length < 9) return null;
  const header = buffer.readUInt32BE(0);
  if (header & JSONB_SCALAR) return null;
  if (!(header & JSONB_IS_OBJECT)) return null;

  const count = header & 0x00FFFFFF;
  let pos = 4; // past header, into key area

  // Read keys and record their offsets and names
  const keyEntries: Array<{ name: string; idx: number }> = [];
  for (let i = 0; i < count && pos <= buffer.length - 5; i++) {
    const kLen = buffer.readUInt32BE(pos);
    const k = buffer.toString('utf-8', pos + 4, pos + 4 + kLen);
    keyEntries.push({ name: k, idx: i });
    pos += 5 + kLen; // len(4) + text + tag(1)
  }

  // Find the target key
  let targetIdx = -1;
  for (const entry of keyEntries) {
    if (entry.name === key) { targetIdx = entry.idx; break; }
  }
  if (targetIdx < 0) return null;

  // Scan to the target value JEntry
  let vPos = pos; // pos is now at start of value area
  for (let i = 0; i < targetIdx && vPos <= buffer.length - 5; i++) {
    const vLen = buffer.readUInt32BE(vPos);
    vPos += 5 + vLen; // len(4) + data + tag(1)
  }
  if (vPos > buffer.length - 5) return null;

  return decodeJentry(buffer, vPos);
}
