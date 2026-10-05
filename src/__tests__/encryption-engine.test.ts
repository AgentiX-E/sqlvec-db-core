import { describe, it, expect, beforeEach } from 'vitest';
import { EncryptionEngine } from '../query/EncryptionEngine';

/**
 * EncryptionEngine — column-level AES-256-GCM encryption.
 *
 * These tests pin down the transparent round-trip contract, the policy lookup
 * fallback (bare vs qualified column names), GCM tamper detection, SQL
 * rewriting, and master-key rotation. They include regressions for two defects:
 *   (1) policies registered under a bare column name were matched during
 *       rewrite/decrypt but looked up again under the qualified name inside
 *       encrypt/decrypt, throwing `No active encryption policy`;
 *   (2) the `aes-256-cbc` algorithm was declared but never implementable
 *       (GCM-only tag API + 12-byte IV) and is now removed.
 */

let engine: EncryptionEngine;

beforeEach(() => {
  engine = new EncryptionEngine();
});

describe('policy management', () => {
  it('creates a policy with a random salt and derived key', () => {
    engine.createPolicy('ssn', 'employees.ssn', 'aes-256-gcm');
    const p = engine.getPolicy('employees.ssn')!;
    expect(p).toBeDefined();
    expect(p.name).toBe('ssn');
    expect(p.enabled).toBe(true);
    expect(p.key).toHaveLength(32);
    expect(p.salt).toHaveLength(16);
  });

  it('uses a 16-byte key for aes-128-gcm', () => {
    engine.createPolicy('short', 't.c', 'aes-128-gcm');
    expect(engine.getPolicy('t.c')!.key).toHaveLength(16);
  });

  it('defaults to aes-256-gcm', () => {
    engine.createPolicy('d', 't.c');
    expect(engine.getPolicy('t.c')!.algorithm).toBe('aes-256-gcm');
  });

  it('overwrites an existing policy for the same column', () => {
    engine.createPolicy('a', 't.c');
    engine.createPolicy('b', 't.c');
    expect(engine.getPolicy('t.c')!.name).toBe('b');
    expect(engine.getAllPolicies()).toHaveLength(1);
  });

  it('drops a policy by name', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    engine.dropPolicy('ssn');
    expect(engine.getPolicy('employees.ssn')).toBeUndefined();
  });

  it('logs a warning for a non-existent drop (no throw)', () => {
    expect(() => engine.dropPolicy('ghost')).not.toThrow();
  });

  it('drops a policy by column', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    engine.dropPolicyByColumn('employees.ssn');
    expect(engine.getPolicy('employees.ssn')).toBeUndefined();
  });

  it('dropPolicyByColumn is a no-op for an unknown column', () => {
    expect(() => engine.dropPolicyByColumn('nope.missing')).not.toThrow();
  });

  it('toggles policy enabled state', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    engine.setPolicyEnabled('employees.ssn', false);
    expect(engine.isProtected('employees.ssn')).toBe(false);
    engine.setPolicyEnabled('employees.ssn', true);
    expect(engine.isProtected('employees.ssn')).toBe(true);
  });

  it('setPolicyEnabled ignores unknown columns', () => {
    expect(() => engine.setPolicyEnabled('unknown.c', false)).not.toThrow();
  });

  it('isProtected returns false for unknown columns', () => {
    expect(engine.isProtected('employees.ssn')).toBe(false);
  });

  it('isProtected returns false for a disabled policy', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    engine.setPolicyEnabled('employees.ssn', false);
    expect(engine.isProtected('employees.ssn')).toBe(false);
  });
});

describe('encrypt / decrypt round-trip', () => {
  it('encrypts plaintext into IV + ciphertext + tag', () => {
    engine.createPolicy('ssn', 't.c');
    const buf = engine.encrypt('t.c', 'secret');
    // 12-byte IV + at least 1 ciphertext byte + 16-byte tag
    expect(buf.length).toBeGreaterThanOrEqual(12 + 1 + 16);
    // AES-GCM ciphertext length === plaintext length (13 === 6 hex... actually utf8 length)
    const plaintextLen = Buffer.byteLength('secret', 'utf-8');
    expect(buf.length).toBe(12 + plaintextLen + 16);
  });

  it('decrypts back to the original plaintext', () => {
    engine.createPolicy('ssn', 't.c');
    const buf = engine.encrypt('t.c', 'hello world');
    expect(engine.decrypt('t.c', buf)).toBe('hello world');
  });

  it('produces different ciphertext each call (random IV)', () => {
    engine.createPolicy('ssn', 't.c');
    const a = engine.encrypt('t.c', 'same');
    const b = engine.encrypt('t.c', 'same');
    expect(a.equals(b)).toBe(false);
  });

  it('throws when encrypting without a policy', () => {
    expect(() => engine.encrypt('no.policy', 'x')).toThrow(/No active encryption policy/);
  });

  it('throws when encrypting against a disabled policy', () => {
    engine.createPolicy('ssn', 't.c');
    engine.setPolicyEnabled('t.c', false);
    expect(() => engine.encrypt('t.c', 'x')).toThrow(/No active encryption policy/);
  });

  it('rejects tampered ciphertext (GCM authentication)', () => {
    engine.createPolicy('ssn', 't.c');
    const buf = engine.encrypt('t.c', 'secret');
    const tampered = Buffer.from(buf);
    tampered[12] ^= 0xff; // flip a ciphertext byte
    expect(() => engine.decrypt('t.c', tampered)).toThrow();
  });

  it('rejects ciphertext shorter than IV + tag', () => {
    engine.createPolicy('ssn', 't.c');
    expect(() => engine.decrypt('t.c', Buffer.from([1, 2, 3]))).toThrow(/too short/);
  });

  it('throws when decrypting without a policy', () => {
    expect(() => engine.decrypt('no.policy', Buffer.alloc(28))).toThrow(/No active encryption policy/);
  });
});

describe('encryptColumn / decryptColumn convenience', () => {
  it('round-trips via the table.column helpers (qualified policy)', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    const buf = engine.encryptColumn('employees', 'ssn', '123-45-6789');
    expect(engine.decryptColumn('employees', 'ssn', buf)).toBe('123-45-6789');
  });

  it('REGRESSION: handles a bare-column policy via the convenience helpers', () => {
    engine.createPolicy('ssn', 'ssn');
    const buf = engine.encryptColumn('employees', 'ssn', '123-45-6789');
    expect(engine.decryptColumn('employees', 'ssn', buf)).toBe('123-45-6789');
  });

  it('encrypts null/undefined as empty string', () => {
    engine.createPolicy('c', 't.c');
    expect(() => engine.encryptColumn('t', 'c', null)).not.toThrow();
    expect(() => engine.encryptColumn('t', 'c', undefined)).not.toThrow();
  });

  it('throws for an unprotected column', () => {
    expect(() => engine.encryptColumn('t', 'nope', 'x')).toThrow(/No active encryption policy/);
  });
});

describe('SQL rewriting — rewriteInsert', () => {
  it('encrypts a protected column and leaves others untouched', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    const out = engine.rewriteInsert(
      "INSERT INTO employees (name, ssn) VALUES ('John', '123-45-6789')",
    );
    expect(out).toContain("X'");
    expect(out).toContain("'John'");
    expect(out).not.toContain('123-45-6789');
  });

  it('returns the SQL unchanged when no column is protected', () => {
    const sql = "INSERT INTO employees (name) VALUES ('John')";
    expect(engine.rewriteInsert(sql)).toBe(sql);
  });

  it('returns non-INSERT statements unchanged', () => {
    const sql = "SELECT * FROM employees";
    expect(engine.rewriteInsert(sql)).toBe(sql);
  });

  it('REGRESSION: encrypts when the policy is registered under a bare column name', () => {
    engine.createPolicy('ssn', 'ssn');
    const out = engine.rewriteInsert(
      "INSERT INTO employees (name, ssn) VALUES ('John', '123-45-6789')",
    );
    expect(out).toContain("X'");
    expect(out).not.toContain('123-45-6789');
  });

  it('does not encrypt a disabled policy column', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    engine.setPolicyEnabled('employees.ssn', false);
    const sql = "INSERT INTO employees (name, ssn) VALUES ('John', '123-45-6789')";
    expect(engine.rewriteInsert(sql)).toBe(sql);
  });
});

describe('SQL rewriting — rewriteSelect', () => {
  it('wraps a protected column in a decrypt marker', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    const out = engine.rewriteSelect('SELECT name, ssn FROM employees');
    expect(out).toContain('_decrypt(ssn)');
  });

  it('does not double-wrap an already-marked column', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    const out = engine.rewriteSelect('SELECT _decrypt(ssn) AS ssn FROM employees');
    expect((out.match(/_decrypt/g) || []).length).toBe(1);
  });

  it('returns non-SELECT statements unchanged', () => {
    expect(engine.rewriteSelect("INSERT INTO t VALUES (1)")).toBe("INSERT INTO t VALUES (1)");
  });

  it('returns unchanged when no protected column matches', () => {
    const sql = 'SELECT name FROM employees';
    expect(engine.rewriteSelect(sql)).toBe(sql);
  });

  it('matches bare-column policies', () => {
    engine.createPolicy('ssn', 'ssn');
    const out = engine.rewriteSelect('SELECT ssn FROM employees');
    expect(out).toContain('_decrypt(ssn)');
  });
});

describe('decryptRow', () => {
  it('decrypts only protected Buffer columns in place', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    const enc = engine.encrypt('employees.ssn', 'secret');
    const row = { id: 1, ssn: enc, name: 'John' };
    const out = engine.decryptRow(row, 'employees');
    expect(out.ssn).toBe('secret');
    expect(out.name).toBe('John');
    expect(out.id).toBe(1);
  });

  it('leaves non-Buffer values untouched', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    const row = { ssn: 'plaintext-string', name: 'John' };
    const out = engine.decryptRow(row, 'employees');
    expect(out.ssn).toBe('plaintext-string');
  });

  it('leaves unprotected columns untouched', () => {
    const row = { id: 1, name: 'John' };
    expect(engine.decryptRow(row, 'employees')).toEqual(row);
  });

  it('returns the raw buffer on decryption failure', () => {
    engine.createPolicy('ssn', 'employees.ssn');
    const bogus = Buffer.from('not-encrypted');
    const row = { ssn: bogus };
    const out = engine.decryptRow(row, 'employees');
    expect(out.ssn).toBe(bogus);
  });
});

describe('constructor', () => {
  it('uses a provided master key', () => {
    const provided = Buffer.alloc(32, 1);
    const e = new EncryptionEngine(provided);
    e.createPolicy('ssn', 't.c');
    // Derivation must be reproducible from the provided key + random salt:
    // we just assert it does not throw and produces a valid policy.
    expect(e.getPolicy('t.c')!.key).toHaveLength(32);
  });
});

describe('dropPolicy with multiple policies', () => {
  it('drops the matching policy when it is not the first entry', () => {
    engine.createPolicy('first', 'a.c');
    engine.createPolicy('ssn', 'b.c');
    engine.createPolicy('last', 'c.c');
    engine.dropPolicy('ssn');
    expect(engine.getPolicy('a.c')).toBeDefined();
    expect(engine.getPolicy('b.c')).toBeUndefined();
    expect(engine.getPolicy('c.c')).toBeDefined();
  });
});

describe('resolvePolicy with empty table', () => {
  it('falls back to the bare column when table is empty', () => {
    engine.createPolicy('ssn', 'ssn');
    const buf = engine.encryptColumn('', 'ssn', 'secret');
    expect(engine.decrypt('ssn', buf)).toBe('secret');
  });
});

describe('disabled policy errors via convenience helpers', () => {
  it('encryptColumn throws for a disabled policy', () => {
    engine.createPolicy('ssn', 't.c');
    engine.setPolicyEnabled('t.c', false);
    expect(() => engine.encryptColumn('t', 'c', 'x')).toThrow(/No active encryption policy/);
  });

  it('decryptColumn throws for a disabled policy', () => {
    engine.createPolicy('ssn', 't.c');
    engine.setPolicyEnabled('t.c', false);
    expect(() => engine.decryptColumn('t', 'c', Buffer.alloc(28))).toThrow(/No active encryption policy/);
  });

  it('encryptColumn throw message omits the table prefix when empty', () => {
    expect(() => engine.encryptColumn('', 'c', 'x')).toThrow(/column: c$/);
  });

  it('decryptColumn throw message omits the table prefix when empty', () => {
    expect(() => engine.decryptColumn('', 'c', Buffer.alloc(28))).toThrow(/column: c$/);
  });
});

describe('parseValueList edge cases (via rewriteInsert)', () => {
  it('handles more columns than values (missing trailing value)', () => {
    engine.createPolicy('x', 't.x');
    const sql = "INSERT INTO t (id, x) VALUES (1)";
    // fewer values than columns: the protected column has no value, so no rewrite
    expect(engine.rewriteInsert(sql)).toBe(sql);
  });

  it('handles more values than columns (extra value without a column)', () => {
    engine.createPolicy('x', 't.x');
    // columns = (id), values = (1, 2): the second value has no column, so it is kept as-is
    const sql = "INSERT INTO t (id) VALUES (1, 2)";
    expect(engine.rewriteInsert(sql)).toBe(sql);
  });

  it('handles a trailing comma / empty value list element', () => {
    engine.createPolicy('x', 't.x');
    const sql = "INSERT INTO t (id, x) VALUES (1,)";
    expect(() => engine.rewriteInsert(sql)).not.toThrow();
  });

  it('handles double-quoted string values', () => {
    engine.createPolicy('x', 't.x');
    const out = engine.rewriteInsert(
      'INSERT INTO t (id, x) VALUES (1, "secret")',
    );
    expect(out).toContain("X'");
  });
});

describe('rewriteSelect without FROM table', () => {
  it('returns unchanged when there is no FROM clause', () => {
    engine.createPolicy('x', 't.x');
    const sql = 'SELECT 1';
    expect(engine.rewriteSelect(sql)).toBe(sql);
  });

  it('handles a SELECT with FROM but no table name (empty fromTable)', () => {
    engine.createPolicy('x', 't.x');
    const sql = 'SELECT x FROM ';
    expect(engine.rewriteSelect(sql)).toBe(sql);
  });
});

describe('master key rotation & reset', () => {
  it('rotates the master key and re-derives policy keys', () => {
    engine.createPolicy('ssn', 't.c');
    const oldKey = engine.getPolicy('t.c')!.key;
    const before = engine.encrypt('t.c', 'secret');
    engine.rotateMasterKey(Buffer.alloc(32, 7));
    const newKey = engine.getPolicy('t.c')!.key;
    expect(oldKey.equals(newKey)).toBe(false);
    // old ciphertext can no longer be decrypted under the new key
    expect(() => engine.decrypt('t.c', before)).toThrow();
  });

  it('reset clears all policies', () => {
    engine.createPolicy('ssn', 't.c');
    engine.reset();
    expect(engine.getAllPolicies()).toHaveLength(0);
  });
});

describe('parseValueList robustness (via rewriteInsert)', () => {
  it('handles quoted strings containing commas', () => {
    engine.createPolicy('tag', 'posts.tag');
    const out = engine.rewriteInsert(
      "INSERT INTO posts (title, tag) VALUES ('a,b,c', 'secret')",
    );
    expect(out).toContain("X'");
    expect(out).toContain("'a,b,c'");
  });

  it('handles nested parentheses in values', () => {
    engine.createPolicy('payload', 'events.payload');
    const out = engine.rewriteInsert(
      "INSERT INTO events (id, payload) VALUES (1, 'func(1,2)')",
    );
    expect(out).toContain("X'");
  });
});
