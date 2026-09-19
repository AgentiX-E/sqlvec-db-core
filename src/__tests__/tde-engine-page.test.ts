/**
 * Unit tests for TDEEngine (page-level AES-256-GCM transparent data encryption).
 *
 * Covers initialisation, page encrypt/decrypt with AAD binding, general-purpose
 * buffer encrypt/decrypt with context binding, KEK wrapping/unwrapping, key
 * rotation, and the global singleton.
 *
 * `setTestKey` is used to inject a known master key so tests avoid the scrypt
 * key-derivation cost (N=2^14); the wrap/unwrap and init paths are exercised
 * separately.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TDEEngine,
  getTDEEngine,
  resetTDEEngine,
} from '../tde/TDEEngine-page';

const TEST_KEY = Buffer.alloc(32, 0x42);
const SQLITE_PAGE = Buffer.alloc(4096);
for (let i = 0; i < SQLITE_PAGE.length; i++) SQLITE_PAGE[i] = i % 251;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tde-page-'));
}

/** Create an engine initialised with a deterministic test key (no scrypt). */
function makeEngine(): TDEEngine {
  const engine = new TDEEngine();
  engine.setTestKey(TEST_KEY);
  return engine;
}

describe('TDEEngine (page)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    resetTDEEngine();
  });

  describe('initialisation state', () => {
    it('is not initialized before init()', () => {
      const engine = new TDEEngine();
      expect(engine.isInitialized).toBe(false);
      expect(engine.isEnabled).toBe(false);
    });

    it('setTestKey marks the engine initialized', () => {
      const engine = new TDEEngine();
      engine.setTestKey(TEST_KEY);
      expect(engine.isInitialized).toBe(true);
      expect(engine.keyVersion).toBe(1);
    });

    it('constructs with defaults', () => {
      const engine = new TDEEngine();
      expect(engine.algorithm).toBe('aes-256-gcm');
      expect(engine.isEnabled).toBe(false);
    });

    it('respects config overrides', () => {
      const engine = new TDEEngine({ enabled: true, algorithm: 'aes-128-gcm' });
      expect(engine.algorithm).toBe('aes-128-gcm');
    });

    it('setEnabled toggles the enabled flag', () => {
      const engine = makeEngine();
      expect(engine.isEnabled).toBe(false); // config.enabled false by default
      engine.setEnabled(true);
      expect(engine.isEnabled).toBe(true);
    });
  });

  describe('page encryption with AAD binding', () => {
    it('round-trips a page for the same page number', () => {
      const engine = makeEngine();
      const enc = engine.encryptPage(SQLITE_PAGE, 0);
      expect(enc).toHaveLength(12 + 16 + SQLITE_PAGE.length);
      expect(engine.decryptPage(enc, 0)).toEqual(SQLITE_PAGE);
    });

    it('binds ciphertext to the page number (cross-page substitution rejected)', () => {
      const engine = makeEngine();
      const enc = engine.encryptPage(SQLITE_PAGE, 1);
      // Decrypting with a different page number must fail GCM authentication.
      expect(() => engine.decryptPage(enc, 2)).toThrow(/decryption failed/i);
    });

    it('throws when encrypting before initialization', () => {
      const engine = new TDEEngine();
      expect(() => engine.encryptPage(SQLITE_PAGE, 0)).toThrow(/not initialised/);
    });

    it('throws when decrypting before initialization', () => {
      const engine = new TDEEngine();
      expect(() => engine.decryptPage(Buffer.alloc(28), 0)).toThrow(/not initialised/);
    });

    it('rejects a ciphertext too short to hold IV + tag', () => {
      const engine = makeEngine();
      expect(() => engine.decryptPage(Buffer.alloc(10), 0)).toThrow(/too short/);
    });
  });

  describe('general-purpose buffer encryption with context', () => {
    it('round-trips with a context string', () => {
      const engine = makeEngine();
      const data = Buffer.from('hello world');
      const enc = engine.encrypt(data, 'ctx-abc');
      expect(engine.decrypt(enc, 'ctx-abc')).toEqual(data);
    });

    it('binds to the context (wrong context fails auth)', () => {
      const engine = makeEngine();
      const data = Buffer.from('secret');
      const enc = engine.encrypt(data, 'ctx-a');
      expect(() => engine.decrypt(enc, 'ctx-b')).toThrow(/decrypt failed/i);
    });

    it('round-trips without a context (empty AAD)', () => {
      const engine = makeEngine();
      const data = Buffer.from('no-context');
      const enc = engine.encrypt(data); // no context
      expect(engine.decrypt(enc)).toEqual(data);
    });

    it('throws on encrypt/decrypt before initialization', () => {
      const engine = new TDEEngine();
      expect(() => engine.encrypt(Buffer.from('x'))).toThrow(/not initialised/);
      expect(() => engine.decrypt(Buffer.alloc(28))).toThrow(/not initialised/);
    });

    it('rejects too-short encrypted data', () => {
      const engine = makeEngine();
      expect(() => engine.decrypt(Buffer.alloc(5))).toThrow(/too short/);
    });
  });

  describe('KEK wrapping and unwrapping', () => {
    it('round-trips a master key through wrap/unwrap', () => {
      const engine = new TDEEngine();
      const master = Buffer.alloc(32, 0x7f);
      const wrapped = engine.wrapMasterKey(master, 'password');
      const unwrapped = engine.unwrapMasterKey(wrapped, 'password');
      expect(unwrapped).toEqual(master);
    });

    it('fails to unwrap with the wrong password (GCM auth)', () => {
      const engine = new TDEEngine();
      const wrapped = engine.wrapMasterKey(Buffer.alloc(32, 1), 'right');
      expect(() => engine.unwrapMasterKey(wrapped, 'wrong')).toThrow();
    });

    it('rejects an unsupported wrapped-key version', () => {
      const engine = new TDEEngine();
      const bad = Buffer.alloc(77);
      bad.writeUInt8(99, 0); // WRAPPED_KEY_VERSION is 1
      expect(() => engine.unwrapMasterKey(bad, 'pw')).toThrow(/version/);
    });

    it('rejects wrapped key data that is too short', () => {
      const engine = new TDEEngine();
      expect(() => engine.unwrapMasterKey(Buffer.alloc(10), 'pw')).toThrow(/too short/);
    });
  });

  describe('key rotation', () => {
    it('rotates the key and increments the version', () => {
      const keyPath = path.join(tmp, 'master.wrapped');
      const engine = new TDEEngine({ keyPath });
      engine.setTestKey(TEST_KEY);
      expect(engine.keyVersion).toBe(1);

      engine.rotateKey('password');
      expect(engine.keyVersion).toBe(2);
    });

    it('throws when rotating before initialization', () => {
      const engine = new TDEEngine({ keyPath: path.join(tmp, 'k.wrapped') });
      expect(() => engine.rotateKey('pw')).toThrow(/not initialised/);
    });
  });

  describe('init() with a wrapped key file', () => {
    it('generates and persists a wrapped key on first init', async () => {
      const keyPath = path.join(tmp, 'master.wrapped');
      const engine = new TDEEngine({ keyPath });
      await engine.init('strong-password');
      expect(engine.isInitialized).toBe(true);
      expect(fs.existsSync(keyPath)).toBe(true);
    });

    it('loads an existing wrapped key on subsequent init', async () => {
      const keyPath = path.join(tmp, 'master.wrapped');
      const e1 = new TDEEngine({ keyPath });
      await e1.init('password');

      const e2 = new TDEEngine({ keyPath });
      await e2.init('password');
      expect(e2.isInitialized).toBe(true);
    });

    it('is idempotent across repeated init calls', async () => {
      const keyPath = path.join(tmp, 'master.wrapped');
      const engine = new TDEEngine({ keyPath });
      await engine.init('pw');
      await engine.init('pw'); // no-op second time
      expect(engine.isInitialized).toBe(true);
    });

    it('creates the key directory when it does not exist', async () => {
      const keyPath = path.join(tmp, 'nested', 'deep', 'master.wrapped');
      const engine = new TDEEngine({ keyPath });
      await engine.init('pw');
      expect(engine.isInitialized).toBe(true);
      expect(fs.existsSync(keyPath)).toBe(true);
    });
  });

  describe('singleton', () => {
    it('returns the same instance across calls', () => {
      const a = getTDEEngine();
      const b = getTDEEngine();
      expect(a).toBe(b);
    });

    it('reset clears the singleton', () => {
      const a = getTDEEngine();
      resetTDEEngine();
      const b = getTDEEngine();
      expect(b).not.toBe(a);
    });
  });
});
