import { describe, it, expect } from 'vitest';
import { createCipheriv } from 'node:crypto';
import { ColumnEncryption } from '../tde/ColumnEncryption';

describe('ColumnEncryption', () => {
  const MASTER = Buffer.alloc(32, 0x42);

  it('initializes with a provided master key', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(ce.keyCount).toBe(0);
  });

  it('generates a random master key when none is provided', () => {
    const ce = new ColumnEncryption();
    expect(ce.keyCount).toBe(0);
  });

  it('returns the CREATE TABLE DDL', () => {
    expect(ColumnEncryption.getCreateKeysTableSql()).toContain('__column_encryption_keys');
  });

  it('creates a key with the default algorithm', () => {
    const ce = new ColumnEncryption(MASTER);
    const r = ce.createColumnEncryptionKey('ssn_cek');
    expect(r.created).toBe(true);
    expect(r.keyName).toBe('ssn_cek');
    expect(r.algorithm).toBe('aes-256-gcm');
    expect(r.version).toBe(1);
    expect(ce.hasKey('ssn_cek')).toBe(true);
    const k = ce.getKey('ssn_cek')!;
    expect(k.key.length).toBe(32);
  });

  it('creates a key with aes-256-cbc', () => {
    const ce = new ColumnEncryption(MASTER);
    const r = ce.createColumnEncryptionKey('k', 'aes-256-cbc');
    expect(r.algorithm).toBe('aes-256-cbc');
    expect(ce.getKey('k')!.key.length).toBe(32);
  });

  it('rejects an unsupported algorithm', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(() => ce.createColumnEncryptionKey('k', 'aes-128-gcm' as any)).toThrow(/Unsupported CEK algorithm/);
  });

  it('returns the existing key when creating a duplicate', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k', 'aes-256-gcm');
    const r = ce.createColumnEncryptionKey('k', 'aes-256-cbc');
    expect(r.created).toBe(false);
    expect(r.algorithm).toBe('aes-256-gcm'); // keeps original algorithm
  });

  it('drops an existing key', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k');
    expect(ce.dropColumnEncryptionKey('k')).toBe(true);
    expect(ce.hasKey('k')).toBe(false);
  });

  it('returns false when dropping a missing key', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(ce.dropColumnEncryptionKey('nope')).toBe(false);
  });

  it('rotates a key, incrementing version and changing key material', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k');
    const before = ce.getKey('k')!.key;
    const v = ce.rotateKey('k');
    expect(v).toBe(2);
    const after = ce.getKey('k')!;
    expect(after.version).toBe(2);
    expect(after.key.equals(before)).toBe(false);
  });

  it('returns -1 when rotating a missing key', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(ce.rotateKey('nope')).toBe(-1);
  });

  it('lists all keys', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('a');
    ce.createColumnEncryptionKey('b');
    expect(ce.getAllKeys().map((k) => k.name).sort()).toEqual(['a', 'b']);
  });

  it('encrypts and decrypts a GCM value', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k', 'aes-256-gcm');
    const enc = ce.encryptValue('k', 'hello world');
    expect(enc.length).toBeGreaterThan(12 + 16);
    expect(ce.decryptValue('k', enc)).toBe('hello world');
  });

  it('encrypts and decrypts a CBC value', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k', 'aes-256-cbc');
    const enc = ce.encryptValue('k', 'hello world');
    expect(ce.decryptValue('k', enc)).toBe('hello world');
  });

  it('throws when encrypting with a missing key', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(() => ce.encryptValue('nope', 'x')).toThrow(/not found/);
  });

  it('throws when decrypting with a missing key', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(() => ce.decryptValue('nope', Buffer.alloc(0))).toThrow(/not found/);
  });

  it('throws when GCM ciphertext is too short', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k', 'aes-256-gcm');
    expect(() => ce.decryptValue('k', Buffer.alloc(5))).toThrow(/too short/);
  });

  it('throws when GCM authentication fails (tampered tag)', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k', 'aes-256-gcm');
    const enc = ce.encryptValue('k', 'secret');
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => ce.decryptValue('k', tampered)).toThrow();
  });

  it('round-trips the empty string', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k');
    const enc = ce.encryptValue('k', '');
    expect(ce.decryptValue('k', enc)).toBe('');
  });

  // ── Column mapping ──────────────────────────────────────────────────────────

  it('registers and retrieves a column mapping', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.registerColumnMapping('users', 'ssn', 'ssn_cek');
    expect(ce.getColumnKey('users', 'ssn')).toBe('ssn_cek');
  });

  it('unregisters a column mapping', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.registerColumnMapping('users', 'ssn', 'ssn_cek');
    expect(ce.unregisterColumnMapping('users', 'ssn')).toBe(true);
    expect(ce.getColumnKey('users', 'ssn')).toBeUndefined();
  });

  it('returns false when unregistering a missing mapping', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(ce.unregisterColumnMapping('a', 'b')).toBe(false);
  });

  it('lists all column mappings', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.registerColumnMapping('users', 'ssn', 'ssn_cek');
    ce.registerColumnMapping('users', 'email', 'email_cek');
    const mappings = ce.getAllColumnMappings();
    expect(mappings).toHaveLength(2);
    const ssn = mappings.find((m) => m.columnName === 'ssn')!;
    expect(ssn.tableName).toBe('users');
    expect(ssn.keyName).toBe('ssn_cek');
  });

  it('encrypts/decrypts a column using its mapping', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.setupColumnEncryption('users', 'ssn', 'ssn_cek');
    const enc = ce.encryptColumn('users', 'ssn', '123-45-6789');
    expect(enc).toBeInstanceOf(Buffer);
    expect(ce.decryptColumn('users', 'ssn', enc)).toBe('123-45-6789');
  });

  it('throws when encrypting an unmapped column', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(() => ce.encryptColumn('users', 'nope', 'x')).toThrow(/No encryption key mapped/);
  });

  it('throws when decrypting an unmapped column', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(() => ce.decryptColumn('users', 'nope', Buffer.alloc(0))).toThrow(/No encryption key mapped/);
  });

  it('setupColumnEncryption creates the key if missing and reuses if present', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.setupColumnEncryption('t', 'c', 'k');
    expect(ce.hasKey('k')).toBe(true);
    const v = ce.getKey('k')!.version;
    ce.setupColumnEncryption('t', 'c', 'k'); // key exists now, no re-create
    expect(ce.getKey('k')!.version).toBe(v);
  });

  // ── Master-key wrapping ─────────────────────────────────────────────────────

  it('wraps and unwraps a key round-trip', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k', 'aes-256-gcm');
    const wrapped = ce.wrapKey('k');
    // iv(12) + [algorithm(11) + null(1) + version(1) + key(32)] + tag(16)
    expect(wrapped.length).toBe(12 + 11 + 1 + 1 + 32 + 16);

    const ce2 = new ColumnEncryption(MASTER); // same master key
    const unwrapped = ce2.unwrapKey('k', wrapped);
    expect(unwrapped.name).toBe('k');
    expect(unwrapped.algorithm).toBe('aes-256-gcm');
    expect(unwrapped.version).toBe(1);
    expect(unwrapped.key.equals(ce.getKey('k')!.key)).toBe(true);
  });

  it('throws when wrapping a missing key', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(() => ce.wrapKey('nope')).toThrow(/not found/);
  });

  it('throws when unwrapping a blob with an invalid format', () => {
    const ce = new ColumnEncryption(MASTER);
    // Corrupt so decryption produces garbage with no null delimiter at a sane index.
    const bogus = Buffer.concat([Buffer.alloc(12), Buffer.alloc(16)]);
    expect(() => ce.unwrapKey('k', bogus)).toThrow();
  });

  it('throws when unwrapping a blob whose key length is not 32', () => {
    // Build a valid GCM blob whose plaintext parses to a non-32 key length.
    const ce = new ColumnEncryption(MASTER);
    const iv = Buffer.alloc(12);
    const cipher = createCipheriv('aes-256-gcm', MASTER, iv);
    // algorithm "aes" (3), null, version 1 -> key length = 1 byte
    const plaintext = Buffer.concat([Buffer.from('aes', 'utf8'), Buffer.from([0, 1, 0xAB])]);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, enc, tag]);
    expect(() => ce.unwrapKey('k', blob)).toThrow(/Invalid key length/);
  });

  it('throws when unwrapping a blob whose algorithm is empty (nullIdx < 1)', () => {
    // Valid GCM blob whose plaintext begins with a null byte (empty algorithm).
    const ce = new ColumnEncryption(MASTER);
    const iv = Buffer.alloc(12);
    const cipher = createCipheriv('aes-256-gcm', MASTER, iv);
    const plaintext = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(32)]);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, enc, tag]);
    expect(() => ce.unwrapKey('k', blob)).toThrow(/could not parse algorithm/);
  });

  // ── Persistence ─────────────────────────────────────────────────────────────

  it('persists keys using db.exec path', async () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k1');
    const execSqls: string[] = [];
    const db = { exec: (sql: string, ...params: any[]) => { execSqls.push(sql); return null; } };
    await ce.persistKeys(db);
    expect(execSqls.length).toBeGreaterThan(0);
    expect(execSqls[0]).toContain('CREATE TABLE');
  });

  it('persists keys using the prepare path', async () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k1');
    let inserted = 0;
    const db = {
      exec: (sql: string) => null,
      prepare: () => ({ run: async () => { inserted++; return null; } }),
    };
    await ce.persistKeys(db);
    expect(inserted).toBe(1);
  });

  it('persists keys to a db without an exec method (skips table DDL)', async () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k1');
    let inserted = 0;
    const db = {
      prepare: () => ({ run: async () => { inserted++; return null; } }),
    };
    await ce.persistKeys(db);
    expect(inserted).toBe(1);
  });

  it('swallows persist errors per-key', async () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k1');
    const db = {
      exec: (sql: string) => null,
      prepare: () => ({ run: async () => { throw new Error('boom'); } }),
    };
    await expect(ce.persistKeys(db)).resolves.toBeUndefined();
  });

  it('loads keys using prepare/all path', async () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k1', 'aes-256-gcm');
    const wrapped = ce.wrapKey('k1');

    // Build a fresh instance and load from a fake db that returns the wrapped row.
    const ce2 = new ColumnEncryption(MASTER);
    const db = {
      prepare: () => ({
        all: async () => [{ key_name: 'k1', algorithm: 'aes-256-gcm', encrypted_key: wrapped, version: 1 }],
      }),
    };
    const n = await ce2.loadKeys(db);
    expect(n).toBe(1);
    expect(ce2.hasKey('k1')).toBe(true);
  });

  it('loads keys using the query path', async () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k1');
    const wrapped = ce.wrapKey('k1');
    const ce2 = new ColumnEncryption(MASTER);
    const db = { query: async () => [{ key_name: 'k1', algorithm: 'aes-256-gcm', encrypted_key: wrapped, version: 1 }] };
    const n = await ce2.loadKeys(db);
    expect(n).toBe(1);
  });

  it('returns 0 when the db is missing query and prepare', async () => {
    const ce = new ColumnEncryption(MASTER);
    // loadKeys throws internally (no query/prepare) but returns 0.
    const n = await ce.loadKeys({});
    expect(n).toBe(0);
  });

  it('returns 0 when loading from a db whose table is missing', async () => {
    const ce = new ColumnEncryption(MASTER);
    const db = { prepare: () => ({ all: async () => { throw new Error('no such table'); } }) };
    const n = await ce.loadKeys(db);
    expect(n).toBe(0);
  });

  it('skips a row that fails to unwrap during load', async () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('good');
    const goodWrapped = ce.wrapKey('good');
    const ce2 = new ColumnEncryption(MASTER);
    const db = {
      prepare: () => ({
        all: async () => [
          { key_name: 'bad', algorithm: 'aes-256-gcm', encrypted_key: Buffer.alloc(12 + 16), version: 1 },
          { key_name: 'good', algorithm: 'aes-256-gcm', encrypted_key: goodWrapped, version: 1 },
        ],
      }),
    };
    const n = await ce2.loadKeys(db);
    expect(n).toBe(1);
    expect(ce2.hasKey('good')).toBe(true);
    expect(ce2.hasKey('bad')).toBe(false);
  });

  // ── DDL parsing ─────────────────────────────────────────────────────────────

  it('parses a CREATE COLUMN ENCRYPTION KEY statement with algorithm', () => {
    const ce = new ColumnEncryption(MASTER);
    const r = ce.parseAndCreateKey("CREATE COLUMN ENCRYPTION KEY ssn_cek WITH ALGORITHM = 'aes-256-gcm'");
    expect(r!.created).toBe(true);
    expect(r!.keyName).toBe('ssn_cek');
    expect(r!.algorithm).toBe('aes-256-gcm');
  });

  it('parses a statement with default algorithm and trailing semicolon', () => {
    const ce = new ColumnEncryption(MASTER);
    const r = ce.parseAndCreateKey('CREATE COLUMN ENCRYPTION KEY k;');
    expect(r!.algorithm).toBe('aes-256-gcm');
  });

  it('parses a quoted key name and quoted algorithm', () => {
    const ce = new ColumnEncryption(MASTER);
    const r = ce.parseAndCreateKey('CREATE COLUMN ENCRYPTION KEY "k" WITH ALGORITHM = "aes-256-cbc"');
    expect(r!.algorithm).toBe('aes-256-cbc');
  });

  it('returns null for a non-CEK statement', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(ce.parseAndCreateKey('CREATE TABLE foo (a INT)')).toBeNull();
  });

  it('parses ENCRYPTED WITH with and without quotes', () => {
    expect(ColumnEncryption.parseEncryptedWith('ssn TEXT ENCRYPTED WITH (ssn_cek)')).toBe('ssn_cek');
    expect(ColumnEncryption.parseEncryptedWith('ssn TEXT ENCRYPTED WITH ("ssn_cek")')).toBe('ssn_cek');
    expect(ColumnEncryption.parseEncryptedWith('ssn TEXT')).toBeNull();
  });

  it('parseAndCreateKey rejects an unsupported algorithm in DDL', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(() => ce.parseAndCreateKey("CREATE COLUMN ENCRYPTION KEY k WITH ALGORITHM = 'aes-128'")).toThrow(/Unsupported/);
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  it('resets state, clearing keys and mappings', () => {
    const ce = new ColumnEncryption(MASTER);
    ce.createColumnEncryptionKey('k');
    ce.registerColumnMapping('t', 'c', 'k');
    ce.reset();
    expect(ce.keyCount).toBe(0);
    expect(ce.getAllColumnMappings()).toEqual([]);
  });

  it('reports key count via the accessor', () => {
    const ce = new ColumnEncryption(MASTER);
    expect(ce.keyCount).toBe(0);
    ce.createColumnEncryptionKey('k');
    expect(ce.keyCount).toBe(1);
  });
});
