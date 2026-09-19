/**
 * Unit tests for TDEEngine (full-file AES-GCM transparent data encryption).
 *
 * Covers key derivation (env/file/direct + caching + error paths), encrypt/decrypt
 * round-trips, GCM authentication failures, key rotation (success/rollback), and
 * integrity verification (valid/tampered/too-small).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TDEEngine } from '../tde/TDEEngine-file';

/** Create a fresh temp directory for each test. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tde-file-'));
}

/** Write a small deterministic SQLite-shaped payload to a path. */
function writeFile(p: string, bytes: number = 4096): Buffer {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = i % 251;
  fs.writeFileSync(p, buf);
  return buf;
}

/** A valid 32-byte key as base64 (direct derivation). */
const KEY32_B64 = Buffer.alloc(32, 0x42).toString('base64');

describe('TDEEngine (file)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
    delete process.env.SQLVEC_TDE_KEY;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.SQLVEC_TDE_KEY;
  });

  describe('deriveKey', () => {
    it('derives from a direct base64 key and caches the result', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const k1 = engine.deriveKey();
      const k2 = engine.deriveKey();
      expect(k1).toHaveLength(32);
      expect(k2).toEqual(k1); // cached
    });

    it('derives from an env var', () => {
      process.env.SQLVEC_TDE_KEY = KEY32_B64;
      const engine = new TDEEngine({ keyDerivation: 'env', keySource: 'SQLVEC_TDE_KEY' });
      expect(engine.deriveKey()).toHaveLength(32);
    });

    it('derives from a hex file', () => {
      const keyFile = path.join(tmp, 'key.hex');
      fs.writeFileSync(keyFile, Buffer.alloc(32, 0x7f).toString('hex'));
      const engine = new TDEEngine({ keyDerivation: 'file', keySource: keyFile });
      expect(engine.deriveKey()).toHaveLength(32);
    });

    it('throws when the env var is unset', () => {
      const engine = new TDEEngine({ keyDerivation: 'env', keySource: 'MISSING_TDE_KEY' });
      expect(() => engine.deriveKey()).toThrow(/not set/);
    });

    it('throws when the key file is missing', () => {
      const engine = new TDEEngine({ keyDerivation: 'file', keySource: path.join(tmp, 'nope.hex') });
      expect(() => engine.deriveKey()).toThrow(/not found/);
    });

    it('derives via scrypt when the raw key length does not match', () => {
      // A base64 key that is NOT 32 bytes forces the scrypt path.
      const shortKey = Buffer.from('short', 'utf-8').toString('base64');
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: shortKey, algorithm: 'aes-256-gcm' });
      expect(engine.deriveKey()).toHaveLength(32);
    });

    it('derives 16-byte keys for aes-128-gcm', () => {
      const key16 = Buffer.alloc(16, 0x11).toString('base64');
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: key16, algorithm: 'aes-128-gcm' });
      expect(engine.deriveKey()).toHaveLength(16);
    });

    it('throws on unknown derivation strategy', () => {
      const engine = new TDEEngine({ keyDerivation: 'env', keySource: 'X' });
      // Force an invalid strategy through a raw cast to exercise the default branch.
      (engine as unknown as { options: { keyDerivation: string } }).options.keyDerivation = 'bogus';
      expect(() => engine.deriveKey()).toThrow(/unknown key derivation/);
    });
  });

  describe('encryptFile / decryptFile', () => {
    it('round-trips a file', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const src = path.join(tmp, 'db.sqlite');
      const enc = path.join(tmp, 'db.enc');
      const dec = path.join(tmp, 'db.dec');
      const original = writeFile(src);

      const e = engine.encryptFile(src, enc);
      expect(e.success).toBe(true);
      expect(e.iv).toMatch(/^[0-9a-f]{32}$/);
      expect(e.keyVersion).toBe(1);

      const d = engine.decryptFile(enc, dec);
      expect(d.success).toBe(true);
      expect(fs.readFileSync(dec)).toEqual(original);
    });

    it('rejects empty input files', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const src = path.join(tmp, 'empty.sqlite');
      fs.writeFileSync(src, '');
      const e = engine.encryptFile(src, path.join(tmp, 'out.enc'));
      expect(e.success).toBe(false);
      expect(e.error).toMatch(/empty file/i);
    });

    it('rejects files too small to be a valid TDE container', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const bad = path.join(tmp, 'small.enc');
      fs.writeFileSync(bad, Buffer.alloc(2));
      const d = engine.decryptFile(bad, path.join(tmp, 'out.sqlite'));
      expect(d.success).toBe(false);
      expect(d.keyVersion).toBe(0);
    });

    it('fails to decrypt with the wrong key (GCM auth failure)', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const src = path.join(tmp, 'db.sqlite');
      const enc = path.join(tmp, 'db.enc');
      writeFile(src);
      expect(engine.encryptFile(src, enc).success).toBe(true);

      // Wrong key.
      const wrongKey = Buffer.alloc(32, 0x99);
      const d = engine.decryptFile(enc, path.join(tmp, 'out.sqlite'), wrongKey);
      expect(d.success).toBe(false);
      expect(d.error).toMatch(/incorrect key|authentication/i);
    });

    it('supports an explicit key argument (bypassing deriveKey)', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const key = Buffer.alloc(32, 0x33);
      const src = path.join(tmp, 'db.sqlite');
      const enc = path.join(tmp, 'db.enc');
      const dec = path.join(tmp, 'db.dec');
      const original = writeFile(src);

      expect(engine.encryptFile(src, enc, key).success).toBe(true);
      expect(engine.decryptFile(enc, dec, key).success).toBe(true);
      expect(fs.readFileSync(dec)).toEqual(original);
    });

    it('supports in-place encryption (input = output)', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const p = path.join(tmp, 'db.sqlite');
      const original = writeFile(p);
      expect(engine.encryptFile(p, p).success).toBe(true);
      expect(fs.readFileSync(p)).not.toEqual(original);
      // Round-trip decrypt in-place back.
      expect(engine.decryptFile(p, p).success).toBe(true);
      expect(fs.readFileSync(p)).toEqual(original);
    });

    it('returns failure (not throw) when the input file is missing', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const e = engine.encryptFile(path.join(tmp, 'missing.sqlite'), path.join(tmp, 'out.enc'));
      expect(e.success).toBe(false);
      expect(e.error).toBeTruthy();
    });

    it('returns failure (not throw) when the encrypted input is missing', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const d = engine.decryptFile(path.join(tmp, 'missing.enc'), path.join(tmp, 'out.sqlite'));
      expect(d.success).toBe(false);
      expect(d.keyVersion).toBe(0);
      // ENOENT does not match the GCM-auth error classifier, so the raw message is used.
      expect(d.error).toMatch(/ENOENT|no such file/i);
    });
  });

  describe('verifyFile', () => {
    it('verifies an intact file', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const src = path.join(tmp, 'db.sqlite');
      const enc = path.join(tmp, 'db.enc');
      writeFile(src);
      engine.encryptFile(src, enc);
      expect(engine.verifyFile(enc)).toBe(true);
    });

    it('reports false for a tampered file', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const src = path.join(tmp, 'db.sqlite');
      const enc = path.join(tmp, 'db.enc');
      writeFile(src);
      engine.encryptFile(src, enc);

      // Flip a byte in the ciphertext region.
      const buf = fs.readFileSync(enc);
      buf[buf.length - 1] ^= 0xff;
      fs.writeFileSync(enc, buf);

      expect(engine.verifyFile(enc)).toBe(false);
    });

    it('reports false for a too-small file', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const bad = path.join(tmp, 'small.enc');
      fs.writeFileSync(bad, Buffer.alloc(8));
      expect(engine.verifyFile(bad)).toBe(false);
    });

    it('reports false for the wrong key', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const src = path.join(tmp, 'db.sqlite');
      const enc = path.join(tmp, 'db.enc');
      writeFile(src);
      engine.encryptFile(src, enc);
      expect(engine.verifyFile(enc, Buffer.alloc(32, 0xab))).toBe(false);
    });
  });

  describe('rotateKey', () => {
    it('rotates the key in place and increments the version', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const src = path.join(tmp, 'db.sqlite');
      const enc = path.join(tmp, 'db.enc');
      const original = writeFile(src);
      engine.encryptFile(src, enc);

      const oldKey = engine.deriveKey();
      const newKey = Buffer.alloc(32, 0x5a);

      expect(engine.rotateKey(enc, oldKey, newKey)).toBe(true);
      expect(engine.getConfig().keyVersion).toBe(2);

      // New key should decrypt cleanly.
      expect(engine.decryptFile(enc, path.join(tmp, 'dec.sqlite'), newKey).success).toBe(true);
      expect(fs.readFileSync(path.join(tmp, 'dec.sqlite'))).toEqual(original);
    });

    it('returns false when the old key cannot decrypt', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const src = path.join(tmp, 'db.sqlite');
      const enc = path.join(tmp, 'db.enc');
      writeFile(src);
      engine.encryptFile(src, enc);

      const wrongOldKey = Buffer.alloc(32, 0x01);
      const newKey = Buffer.alloc(32, 0x02);
      expect(engine.rotateKey(enc, wrongOldKey, newKey)).toBe(false);
      // Version is not advanced on failed rotation.
      expect(engine.getConfig().keyVersion).toBe(1);
    });

    it('rolls back the key version when re-encrypt fails', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const src = path.join(tmp, 'db.sqlite');
      const enc = path.join(tmp, 'db.enc');
      writeFile(src);
      engine.encryptFile(src, enc);

      const oldKey = engine.deriveKey();
      // An invalid-length key causes createCipheriv to throw, so encryptFile
      // returns success:false and the rotation rolls back the version.
      const invalidNewKey = Buffer.alloc(5, 0x5a);
      expect(engine.rotateKey(enc, oldKey, invalidNewKey)).toBe(false);
      expect(engine.getConfig().keyVersion).toBe(1);
    });

    it('returns false when an unexpected synchronous error escapes', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const src = path.join(tmp, 'db.sqlite');
      const enc = path.join(tmp, 'db.enc');
      writeFile(src);
      engine.encryptFile(src, enc);

      // Force decryptFile to throw synchronously (rather than returning a result)
      // to exercise the outer defensive catch in rotateKey.
      const spy = vi.spyOn(engine, 'decryptFile').mockImplementation(() => {
        throw new Error('boom');
      });

      expect(engine.rotateKey(enc, Buffer.alloc(32), Buffer.alloc(32))).toBe(false);
      spy.mockRestore();
    });
  });

  describe('config / state', () => {
    it('returns a defensive copy of config', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      const cfg = engine.getConfig();
      cfg.keyVersion = 999;
      expect(engine.getConfig().keyVersion).toBe(1);
    });

    it('reset clears the cached derived key', () => {
      const engine = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      engine.deriveKey();
      engine.reset();
      // After reset, deriveKey re-derives (still succeeds).
      expect(engine.deriveKey()).toHaveLength(32);
    });

    it('isEnabled reflects key derivability', () => {
      const ok = new TDEEngine({ keyDerivation: 'direct', keySource: KEY32_B64 });
      expect(ok.isEnabled()).toBe(true);

      const bad = new TDEEngine({ keyDerivation: 'env', keySource: 'MISSING_TDE_KEY' });
      expect(bad.isEnabled()).toBe(false);
    });

    it('defaults to env derivation with SQLVEC_TDE_KEY', () => {
      const engine = new TDEEngine();
      expect(engine.getConfig().keyDerivation).toBe('env');
      expect(engine.getConfig().keySource).toBe('SQLVEC_TDE_KEY');
      expect(engine.getConfig().algorithm).toBe('aes-256-gcm');
    });
  });
});
