import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TDEConfig, type TDEAlgorithm } from '../tde/TDEConfig';

/** Base64-encode n zero bytes to form a valid key of a given length. */
function keyOf(bytes: number): string {
  return Buffer.alloc(bytes).toString('base64');
}

describe('TDEConfig', () => {
  beforeEach(() => TDEConfig.reset());
  afterEach(() => TDEConfig.reset());

  describe('validateKey', () => {
    it('accepts a base64-encoded 32-byte key (aes-256-gcm)', () => {
      expect(TDEConfig.validateKey(keyOf(32))).toBe(true);
    });

    it('accepts a base64-encoded 24-byte key (aes-192-gcm)', () => {
      expect(TDEConfig.validateKey(keyOf(24))).toBe(true);
    });

    it('accepts a base64-encoded 16-byte key (aes-128-gcm)', () => {
      expect(TDEConfig.validateKey(keyOf(16))).toBe(true);
    });

    it('rejects a key of a non-supported length', () => {
      expect(TDEConfig.validateKey(keyOf(20))).toBe(false);
      expect(TDEConfig.validateKey(keyOf(8))).toBe(false);
      expect(TDEConfig.validateKey(keyOf(64))).toBe(false);
    });

    it('rejects a non-string or empty value', () => {
      expect(TDEConfig.validateKey(undefined)).toBe(false);
      expect(TDEConfig.validateKey(null)).toBe(false);
      expect(TDEConfig.validateKey(12345)).toBe(false);
      expect(TDEConfig.validateKey('')).toBe(false);
    });

    it('rejects malformed / non-canonical base64', () => {
      expect(TDEConfig.validateKey('!!!! not base64 !!!!')).toBe(false);
      expect(TDEConfig.validateKey('abc')).toBe(false);
    });
  });

  describe('enabled / algorithm state', () => {
    it('is disabled with the default algorithm initially', () => {
      expect(TDEConfig.getEnabled()).toBe(false);
      expect(TDEConfig.getAlgorithm()).toBe('aes-256-gcm');
    });

    it('toggles enabled state', () => {
      TDEConfig.setEnabled(true);
      expect(TDEConfig.getEnabled()).toBe(true);
      TDEConfig.setEnabled(false);
      expect(TDEConfig.getEnabled()).toBe(false);
    });

    it('sets a valid algorithm', () => {
      TDEConfig.setAlgorithm('aes-128-gcm');
      expect(TDEConfig.getAlgorithm()).toBe('aes-128-gcm');
    });

    it('throws on an unsupported algorithm', () => {
      expect(() => TDEConfig.setAlgorithm('des')).toThrowError(/Unsupported TDE algorithm/);
    });
  });

  describe('named policies', () => {
    it('creates and retrieves a policy', () => {
      TDEConfig.createPolicy('pii', 'aes-256-gcm');
      expect(TDEConfig.getPolicy('pii')).toEqual({ name: 'pii', algorithm: 'aes-256-gcm' });
    });

    it('is case-insensitive for policy names', () => {
      TDEConfig.createPolicy('PII', 'aes-128-gcm');
      expect(TDEConfig.getPolicy('pii')).toBeDefined();
      expect(TDEConfig.getPolicy('pii')!.algorithm).toBe('aes-128-gcm');
    });

    it('normalizes algorithm aliases', () => {
      TDEConfig.createPolicy('p', 'AES256');
      expect(TDEConfig.getPolicy('p')!.algorithm).toBe('aes-256-gcm');
      TDEConfig.createPolicy('q', 'aes-192');
      expect(TDEConfig.getPolicy('q')!.algorithm).toBe('aes-192-gcm');
    });

    it('throws when creating a policy with an unsupported algorithm', () => {
      expect(() => TDEConfig.createPolicy('bad', 'rot13')).toThrowError(/Unsupported TDE algorithm/);
    });

    it('returns undefined for an unknown policy', () => {
      expect(TDEConfig.getPolicy('nope')).toBeUndefined();
    });

    it('drops an existing policy and reports the result', () => {
      TDEConfig.createPolicy('tmp', 'aes-256-gcm');
      expect(TDEConfig.dropPolicy('tmp')).toBe(true);
      expect(TDEConfig.getPolicy('tmp')).toBeUndefined();
      expect(TDEConfig.dropPolicy('tmp')).toBe(false);
    });

    it('lists all policies as a snapshot', () => {
      TDEConfig.createPolicy('a', 'aes-256-gcm');
      TDEConfig.createPolicy('b', 'aes-128-gcm');
      const list = TDEConfig.listPolicies();
      expect(list).toHaveLength(2);
      // Mutating the snapshot must not affect the store.
      list[0].algorithm = 'aes-192-gcm' as TDEAlgorithm;
      expect(TDEConfig.getPolicy('a')!.algorithm).toBe('aes-256-gcm');
    });
  });

  describe('environment bootstrapping', () => {
    it('loads enabled, key and algorithm from the environment', () => {
      TDEConfig.initFromEnv({
        SQLVEC_TDE_ENABLED: 'true',
        SQLVEC_TDE_KEY: keyOf(32),
        SQLVEC_TDE_ALGORITHM: 'aes-128-gcm',
      });
      const cfg = TDEConfig.loadFromEnv();
      expect(cfg.enabled).toBe(true);
      expect(cfg.algorithm).toBe('aes-128-gcm');
      expect(cfg.key).toBe(keyOf(32));
    });

    it('treats enabled=1 as true and respects falsy strings', () => {
      TDEConfig.initFromEnv({ SQLVEC_TDE_ENABLED: '1' });
      expect(TDEConfig.loadFromEnv().enabled).toBe(true);
      TDEConfig.initFromEnv({ SQLVEC_TDE_ENABLED: 'false' });
      expect(TDEConfig.loadFromEnv().enabled).toBe(false);
    });

    it('ignores an unknown algorithm from the environment', () => {
      TDEConfig.initFromEnv({ SQLVEC_TDE_ALGORITHM: 'rot13' });
      expect(TDEConfig.loadFromEnv().algorithm).toBe('aes-256-gcm');
    });

    it('leaves unset variables unchanged (idempotent)', () => {
      TDEConfig.initFromEnv({ SQLVEC_TDE_ENABLED: 'true' });
      TDEConfig.initFromEnv({});
      expect(TDEConfig.loadFromEnv().enabled).toBe(true);
    });

    it('treats an empty key string as unset', () => {
      TDEConfig.initFromEnv({ SQLVEC_TDE_KEY: keyOf(32) });
      expect(TDEConfig.loadFromEnv().key).toBe(keyOf(32));
      TDEConfig.initFromEnv({ SQLVEC_TDE_KEY: '' });
      expect(TDEConfig.loadFromEnv().key).toBeUndefined();
    });

    it('tracks the policies directory', () => {
      expect(TDEConfig.getPoliciesDir()).toBeUndefined();
      TDEConfig.setPoliciesDir('/tmp/tde');
      expect(TDEConfig.getPoliciesDir()).toBe('/tmp/tde');
    });
  });
});
