/**
 * UuidShim — PostgreSQL UUID type & function compatibility shim for SQLite.
 *
 * SQLite has no native UUID type; UUID values are stored as TEXT. PostgreSQL's
 * UUID-generation functions are replaced with SQLite-compatible equivalents.
 *
 * Strategy:
 *   1. `UUID` / `uuid` as column type         → `TEXT`
 *   2. `gen_random_uuid()`                     → `hex(randomblob(16))` (runtime-random 32-hex, no hyphens)
 *   3. `uuid_generate_v4()`                    → `'…'` literal (crypto.randomUUID, Node 19+)
 *   4. `uuid_generate_v1()`                    → `'…'` literal (time-based UUID v1)
 *   5. `::uuid` / `::UUID` type cast           → stripped (removed)
 *   6. `uuid_nil()`                            → '00000000-0000-0000-0000-000000000000'
 *   7. `uuid_ns_dns()` / `uuid_ns_url()` /     → namespace UUID constants
 *      `uuid_ns_oid()` / `uuid_ns_x500()`
 *
 * @module UuidShim
 */

import * as crypto from 'crypto';
import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('UuidShim');

// ── Types ────────────────────────────────────────────────────────

export interface UuidResult {
  /** Rewritten SQL (original if no UUID constructs found) */
  sql: string;
  /** Whether any UUID-related rewrite was applied */
  rewritten: boolean;
}

// ── Constants ────────────────────────────────────────────────────

/** UUID v1: 100-nanosecond intervals between 15 Oct 1582 and Unix epoch */
const UUID_EPOCH_OFFSET = 122192928000000000;

// ── UUID v1 generator ────────────────────────────────────────────

/** Clock sequence counter for UUID v1 (ensures uniqueness within same tick) */
let _clockSeq = 0;
let _lastTimestamp = 0n;

/** Cached MAC address (generated once per process) */
let _macBytes: Buffer | null = null;

/**
 * Get a 6-byte MAC address for UUID v1 node field.
 * Uses a random MAC (locally administered) since we don't have real HW MAC in Node.
 */
function getMacBytes(): Buffer {
  if (_macBytes) return _macBytes;
  // Generate a random MAC with locally-administered bit set
  _macBytes = crypto.randomBytes(6);
  // Set the locally-administered bit (bit 1 of first byte)
  _macBytes[0] = (_macBytes[0] | 0x02) & 0xFE; // clear multicast, set local
  return _macBytes;
}

/**
 * Generate a UUID v1 string (time-based).
 *
 * Format: `tttttttt-tttt-1ccc-yxxx-xxxxxxxxxxxx`
 *   - t: 60-bit timestamp (100-ns intervals since 1582-10-15)
 *   - c: 14-bit clock sequence
 *   - y: variant (10xx = RFC 4122)
 *   - x: 48-bit node (MAC address)
 *
 * @returns UUID v1 string in 8-4-4-4-12 format.
 */
export function uuidGenerateV1(): string {
  // Current time as 100-ns intervals since UUID epoch
  const now = BigInt(Date.now());
  const timestamp100ns = (now * 10000n) + BigInt(UUID_EPOCH_OFFSET);

  // Increment clock sequence if timestamp hasn't advanced
  if (timestamp100ns <= _lastTimestamp) {
    _clockSeq = (_clockSeq + 1) & 0x3FFF; // 14 bits
  } else {
    _clockSeq = crypto.randomInt(0, 16384);
  }
  _lastTimestamp = timestamp100ns;

  // Extract timestamp fields
  const timeLow = Number(timestamp100ns & 0xFFFFFFFFn);
  const timeMid = Number((timestamp100ns >> 32n) & 0xFFFFn);
  const timeHiAndVersion = Number(((timestamp100ns >> 48n) & 0x0FFFn) | 0x1000n); // version 1

  // Clock sequence with variant (RFC 4122)
  const clockSeqHi = ((_clockSeq >> 8) & 0x3F) | 0x80; // 10xx xxxx (variant)
  const clockSeqLo = _clockSeq & 0xFF;

  const mac = getMacBytes();

  // Format as 8-4-4-4-12 hex
  const hex = [
    timeLow.toString(16).padStart(8, '0'),
    timeMid.toString(16).padStart(4, '0'),
    timeHiAndVersion.toString(16).padStart(4, '0'),
    clockSeqHi.toString(16).padStart(2, '0') + clockSeqLo.toString(16).padStart(2, '0'),
    mac.toString('hex'),
  ].join('-');

  return hex;
}

// ── UUID v4 generator ────────────────────────────────────────────

/**
 * Generate a UUID v4 string using Node.js crypto.randomUUID().
 *
 * @returns UUID v4 string in 8-4-4-4-12 format with hyphens.
 */
export function uuidGenerateV4(): string {
  return crypto.randomUUID();
}

// ── Namespace UUIDs ──────────────────────────────────────────────

/** Nil UUID: all zeros */
export function uuidNil(): string {
  return '00000000-0000-0000-0000-000000000000';
}

/** DNS namespace UUID (from RFC 4122 Appendix C) */
export function uuidNsDns(): string {
  return '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
}

/** URL namespace UUID (from RFC 4122 Appendix C) */
export function uuidNsUrl(): string {
  return '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
}

/** OID namespace UUID (from RFC 4122 Appendix C) */
export function uuidNsOid(): string {
  return '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
}

/** X.500 namespace UUID (from RFC 4122 Appendix C) */
export function uuidNsX500(): string {
  return '6ba7b814-9dad-11d1-80b4-00c04fd430c8';
}

// ── Validation ───────────────────────────────────────────────────

/**
 * Check if a string is a valid UUID (any version).
 *
 * @param s - String to validate.
 * @returns true if the string matches UUID format.
 */
export function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// ── Regex (non‑shared instances to avoid lastIndex issues) ───────

/** function gen_random_uuid() */
const RE_GEN_RANDOM_UUID = (): RegExp => /\bgen_random_uuid\s*\(\s*\)/gi;
/** function uuid_generate_v4() */
const RE_UUID_GENERATE_V4 = (): RegExp => /\buuid_generate_v4\s*\(\s*\)/gi;
/** function uuid_generate_v1() */
const RE_UUID_GENERATE_V1 = (): RegExp => /\buuid_generate_v1\s*\(\s*\)/gi;
/** function uuid_nil() */
const RE_UUID_NIL = (): RegExp => /\buuid_nil\s*\(\s*\)/gi;
/** function uuid_ns_dns() */
const RE_UUID_NS_DNS = (): RegExp => /\buuid_ns_dns\s*\(\s*\)/gi;
/** function uuid_ns_url() */
const RE_UUID_NS_URL = (): RegExp => /\buuid_ns_url\s*\(\s*\)/gi;
/** function uuid_ns_oid() */
const RE_UUID_NS_OID = (): RegExp => /\buuid_ns_oid\s*\(\s*\)/gi;
/** function uuid_ns_x500() */
const RE_UUID_NS_X500 = (): RegExp => /\buuid_ns_x500\s*\(\s*\)/gi;
/** ::uuid type cast */
const RE_UUID_CAST = (): RegExp => /::\s*uuid\b/gi;
/**
 * Standalone `UUID` type keyword, matched only in type position.
 *
 * A bare word `uuid` is ambiguous: it may denote the UUID *type* (as in
 * `id UUID` or `CAST(x AS uuid)`) or an ordinary *identifier/column* (as in
 * `SELECT uuid FROM t`, `WHERE uuid = 1`, or `ORDER BY uuid`). Blindly
 * rewriting every `uuid` to `TEXT` would corrupt column references.
 *
 * We guard against the identifier reading with two lookarounds:
 *   - a negative lookbehind rejects `uuid` preceded by an identifier-leading
 *     keyword or punctuation (`SELECT`, `WHERE`, `FROM`, `ORDER`, `GROUP`,
 *     `ON`, `BY`, `SET`, `AND`, `OR`, `NOT`, `JOIN`, `UNION`, `,`, `.`);
 *   - a negative lookahead rejects `uuid` followed by an operator/column
 *     continuation (`=`, comparisons, `.`, `FROM`, `AS`, `AND`, …).
 *
 * `AS uuid` (CAST) and a DDL column definition `id UUID` are deliberately
 * NOT rejected in either direction, so both still rewrite to `TEXT`.
 */
const RE_UUID_TYPE = (): RegExp =>
  // eslint-disable-next-line regexp/no-unused-capturing-group
  /(?<!\b(?:SELECT|WHERE|FROM|ORDER|GROUP|ON|BY|SET|AND|OR|NOT|JOIN|UNION|,|\.)\s+)UUID\b(?!\s*(?:FROM|WHERE|ORDER|GROUP|ON|BY|SET|AND|OR|NOT|IN|JOIN|UNION|=|<>|!=|<=|>=|<|>|\.))/gi;

// ── Detect ───────────────────────────────────────────────────────

/**
 * Detect whether the given SQL contains any UUID-related constructs.
 */
export function detectUuidUsage(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  // Protect literals/identifiers/comments (including multi-line comments) so a
  // UUID function name inside them is not reported as real usage.
  const cleaned = protectSQL(sql).protectedSql;

  return (
    RE_GEN_RANDOM_UUID().test(cleaned) ||
    RE_UUID_GENERATE_V4().test(cleaned) ||
    RE_UUID_GENERATE_V1().test(cleaned) ||
    RE_UUID_NIL().test(cleaned) ||
    RE_UUID_NS_DNS().test(cleaned) ||
    RE_UUID_NS_URL().test(cleaned) ||
    RE_UUID_NS_OID().test(cleaned) ||
    RE_UUID_NS_X500().test(cleaned) ||
    RE_UUID_CAST().test(cleaned) ||
    RE_UUID_TYPE().test(cleaned)
  );
}

// ── Rewrite ──────────────────────────────────────────────────────

/**
 * Rewrite UUID-related SQL constructs for SQLite compatibility.
 *
 * Processing order:
 *   1. uuid_generate_v1()    → literal v1 UUID
 *   2. uuid_generate_v4()    → literal v4 UUID (via crypto.randomUUID)
 *   3. gen_random_uuid()     → literal v4 UUID (via crypto.randomUUID)
 *   4. uuid_nil()            → '00000000-0000-0000-0000-000000000000'
 *   5. uuid_ns_dns()/url/oid/x500 → their literal constants
 *   6. `::uuid` type cast    → stripped
 *   7. `UUID` type keyword   → `TEXT`
 *
 * @param sql - The SQL statement to rewrite.
 * @returns A UuidResult with the rewritten SQL.
 */
export function rewriteUuidSql(sql: string): UuidResult {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql ?? '', rewritten: false };
  }

  // Protect string literals, quoted identifiers, and comments so a UUID
  // construct inside them (e.g. `SELECT 'gen_random_uuid()'`) is never rewritten.
  const protectedSql = protectSQL(sql);
  let result = protectedSql.protectedSql;

  // 1. uuid_generate_v1() → literal UUID v1 string
  result = result.replace(RE_UUID_GENERATE_V1(), () => `'${uuidGenerateV1()}'`);

  // 2. uuid_generate_v4() → literal UUID v4 string
  result = result.replace(RE_UUID_GENERATE_V4(), () => `'${uuidGenerateV4()}'`);

  // 3. gen_random_uuid() → hex(randomblob(16)) for pure SQLite randomness
  result = result.replace(RE_GEN_RANDOM_UUID(), () => `hex(randomblob(16))`);

  // 4. uuid_nil() → constant
  result = result.replace(RE_UUID_NIL(), () => `'${uuidNil()}'`);

  // 5. uuid_ns_dns(), uuid_ns_url(), uuid_ns_oid(), uuid_ns_x500()
  result = result.replace(RE_UUID_NS_DNS(), () => `'${uuidNsDns()}'`);
  result = result.replace(RE_UUID_NS_URL(), () => `'${uuidNsUrl()}'`);
  result = result.replace(RE_UUID_NS_OID(), () => `'${uuidNsOid()}'`);
  result = result.replace(RE_UUID_NS_X500(), () => `'${uuidNsX500()}'`);

  // 6. Strip ::uuid type casts
  result = result.replace(RE_UUID_CAST(), '');

  // 7. Replace standalone UUID type keyword → TEXT
  result = result.replace(RE_UUID_TYPE(), 'TEXT');

  const restored = restoreSQL({ ...protectedSql, protectedSql: result });
  const rewritten = restored !== sql;

  if (rewritten) {
    logger.debug({ original: sql, rewritten: restored }, 'Rewrote UUID SQL for SQLite compatibility');
  }

  return { sql: restored, rewritten };
}
