/**
 * encryption-policy-shim.test.ts — Coverage tests for EncryptionPolicyShim
 * (PG encryption policy SQL → TDEConfig engine mapping).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectEncryptionPolicy,
  rewriteEncryptionPolicy,
} from '../query/EncryptionPolicyShim';
import { TDEConfig } from '../storage/TDEConfig';

describe('detectEncryptionPolicy', () => {
  it('returns false for non-string / falsy input', () => {
    expect(detectEncryptionPolicy(undefined as unknown as string)).toBe(false);
    expect(detectEncryptionPolicy('')).toBe(false);
    expect(detectEncryptionPolicy(123 as unknown as string)).toBe(false);
    expect(detectEncryptionPolicy(null as unknown as string)).toBe(false);
  });

  it('detects CREATE ENCRYPTION POLICY (case-insensitive)', () => {
    expect(detectEncryptionPolicy('CREATE ENCRYPTION POLICY p AS (col text)')).toBe(true);
    expect(detectEncryptionPolicy('create encryption policy p')).toBe(true);
  });

  it('detects ALTER ENCRYPTION POLICY', () => {
    expect(detectEncryptionPolicy('ALTER ENCRYPTION POLICY p SET (encryption_algorithm = \'AES256\')')).toBe(true);
    expect(detectEncryptionPolicy('ALTER ENCRYPTION POLICY p OWNER TO x')).toBe(true);
  });

  it('detects DROP ENCRYPTION POLICY', () => {
    expect(detectEncryptionPolicy('DROP ENCRYPTION POLICY p')).toBe(true);
  });

  it('detects SET encryption_policy.default', () => {
    expect(detectEncryptionPolicy('SET encryption_policy.default = \'p\'')).toBe(true);
  });

  it('detects SHOW encryption_policy.default', () => {
    expect(detectEncryptionPolicy('SHOW encryption_policy.default')).toBe(true);
    expect(detectEncryptionPolicy('SHOW encryption_policy.default;')).toBe(true);
  });

  it('detects SET encryption_policy.auto_rotate', () => {
    expect(detectEncryptionPolicy('SET encryption_policy.auto_rotate = on')).toBe(true);
  });

  it('detects SHOW encryption_policy.auto_rotate', () => {
    expect(detectEncryptionPolicy('SHOW encryption_policy.auto_rotate')).toBe(true);
  });

  it('detects ALTER SYSTEM SET encryption.*', () => {
    expect(detectEncryptionPolicy('ALTER SYSTEM SET encryption.algorithm = \'aes256\'')).toBe(true);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectEncryptionPolicy('SELECT 1')).toBe(false);
    expect(detectEncryptionPolicy('CREATE TABLE t (id int)')).toBe(false);
  });
});

describe('rewriteEncryptionPolicy — guards & passthrough', () => {
  it('returns original for non-string / falsy', () => {
    expect(rewriteEncryptionPolicy(undefined as unknown as string)).toEqual({
      sql: undefined,
      rewritten: false,
    });
    expect(rewriteEncryptionPolicy('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through non-encryption SQL (strips + re-adds semicolon)', () => {
    expect(rewriteEncryptionPolicy('SELECT 1')).toEqual({
      sql: 'SELECT 1;',
      rewritten: false,
    });
    expect(rewriteEncryptionPolicy('SELECT 1;')).toEqual({
      sql: 'SELECT 1;',
      rewritten: false,
    });
    expect(rewriteEncryptionPolicy('  SELECT 1;;;  ')).toEqual({
      sql: 'SELECT 1;',
      rewritten: false,
    });
  });
});

describe('rewriteEncryptionPolicy — SHOW', () => {
  beforeEach(() => TDEConfig.reset());

  it('SHOW auto_rotate → SELECT off', () => {
    expect(rewriteEncryptionPolicy('SHOW encryption_policy.auto_rotate')).toEqual({
      sql: "SELECT 'off'",
      rewritten: true,
      category: 'show_auto_rotate',
    });
  });

  it('SHOW default → none when TDE disabled', () => {
    expect(rewriteEncryptionPolicy('SHOW encryption_policy.default')).toEqual({
      sql: "SELECT 'none' as encryption_policy_default",
      rewritten: true,
      category: 'show_default',
    });
  });

  it('SHOW default → current algorithm when TDE enabled', () => {
    TDEConfig.setEnabled(true);
    TDEConfig.setAlgorithm('aes-256-gcm');
    expect(rewriteEncryptionPolicy('SHOW encryption_policy.default')).toEqual({
      sql: "SELECT 'aes-256-gcm' as encryption_policy_default",
      rewritten: true,
      category: 'show_default',
    });
  });
});

describe('rewriteEncryptionPolicy — DROP', () => {
  beforeEach(() => TDEConfig.reset());

  it('drops an existing policy', () => {
    TDEConfig.createPolicy('p', 'aes-256-gcm');
    const r = rewriteEncryptionPolicy('DROP ENCRYPTION POLICY p');
    expect(r).toEqual({ sql: null, rewritten: true, category: 'drop' });
    expect(TDEConfig.getPolicy('p')).toBeUndefined();
  });

  it('drop of a missing policy is a no-op (dropPolicy returns false)', () => {
    const r = rewriteEncryptionPolicy('DROP ENCRYPTION POLICY ghost');
    expect(r.rewritten).toBe(true);
    expect(r.category).toBe('drop');
  });
});

describe('rewriteEncryptionPolicy — SET default', () => {
  beforeEach(() => TDEConfig.reset());

  it('sets default to existing policy algorithm', () => {
    TDEConfig.createPolicy('p', 'aes-128-gcm');
    const r = rewriteEncryptionPolicy('SET encryption_policy.default = \'p\'');
    expect(r).toEqual({ sql: null, rewritten: true, category: 'set' });
    expect(TDEConfig.getEnabled()).toBe(true);
    expect(TDEConfig.getAlgorithm()).toBe('aes-128-gcm');
  });

  it('enables TDE with current algorithm when policy missing', () => {
    const r = rewriteEncryptionPolicy('SET encryption_policy.default = \'ghost\'');
    expect(r).toEqual({ sql: null, rewritten: true, category: 'set' });
    expect(TDEConfig.getEnabled()).toBe(true);
    // algorithm unchanged (default)
    expect(TDEConfig.getAlgorithm()).toBe('aes-256-gcm');
  });
});

describe('rewriteEncryptionPolicy — SET auto_rotate', () => {
  beforeEach(() => TDEConfig.reset());

  it('SET auto_rotate → SELECT 1', () => {
    expect(rewriteEncryptionPolicy('SET encryption_policy.auto_rotate = on')).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
      category: 'set',
    });
    expect(rewriteEncryptionPolicy('SET encryption_policy.auto_rotate = off')).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
      category: 'set',
    });
  });
});

describe('rewriteEncryptionPolicy — ALTER SYSTEM', () => {
  beforeEach(() => TDEConfig.reset());

  it('sets algorithm for key=encryption_algorithm', () => {
    const r = rewriteEncryptionPolicy('ALTER SYSTEM SET encryption.algorithm = \'aes-256-gcm\'');
    expect(r).toEqual({ sql: null, rewritten: true, category: 'alter_system' });
    expect(TDEConfig.getEnabled()).toBe(true);
    expect(TDEConfig.getAlgorithm()).toBe('aes-256-gcm');
  });

  it('sets algorithm for key=algorithm', () => {
    const r = rewriteEncryptionPolicy('ALTER SYSTEM SET encryption.algorithm = \'aes-128-gcm\'');
    expect(r.rewritten).toBe(true);
    expect(TDEConfig.getAlgorithm()).toBe('aes-128-gcm');
  });

  it('falls back to SELECT 1 on invalid algorithm', () => {
    const r = rewriteEncryptionPolicy('ALTER SYSTEM SET encryption.encryption_algorithm = \'AES999\'');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true, category: 'alter_system' });
  });

  it('no-op for unknown key', () => {
    const r = rewriteEncryptionPolicy('ALTER SYSTEM SET encryption.other_key = \'val\'');
    expect(r).toEqual({ sql: null, rewritten: true, category: 'alter_system' });
    expect(TDEConfig.getEnabled()).toBe(false);
  });
});

describe('rewriteEncryptionPolicy — CREATE', () => {
  beforeEach(() => TDEConfig.reset());

  it('creates policy with WITH algorithm', () => {
    const r = rewriteEncryptionPolicy(
      "CREATE ENCRYPTION POLICY p WITH (encryption_algorithm = 'aes-256-gcm')",
    );
    expect(r).toEqual({ sql: null, rewritten: true, category: 'ddl' });
    expect(TDEConfig.getPolicy('p')?.algorithm).toBe('aes-256-gcm');
    expect(TDEConfig.getEnabled()).toBe(true);
  });

  it('creates policy with parenthesized algorithm', () => {
    const r = rewriteEncryptionPolicy(
      "CREATE ENCRYPTION POLICY p AS (ssn text) USING 'encrypt(ssn, key)'",
    );
    expect(r.rewritten).toBe(true);
    expect(TDEConfig.getPolicy('p')?.algorithm).toBe('aes-256-gcm');
  });

  it('creates policy with plain USING (defaults to aes-256-gcm)', () => {
    const r = rewriteEncryptionPolicy(
      "CREATE ENCRYPTION POLICY p (encryption_algorithm = 'aes-192-gcm')",
    );
    expect(r.rewritten).toBe(true);
    expect(TDEConfig.getPolicy('p')?.algorithm).toBe('aes-192-gcm');
  });

  it('falls back to SELECT 1 on invalid algorithm', () => {
    const r = rewriteEncryptionPolicy(
      "CREATE ENCRYPTION POLICY p WITH (encryption_algorithm = 'AES999')",
    );
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true, category: 'ddl' });
  });

  it('falls back to SELECT 1 on CREATE with no algorithm (extract returns undefined)', () => {
    // No WITH/paren/USING clause → extractAlgorithmFromCreate returns undefined,
    // createPolicy throws (normalizeAlgorithm trims undefined), catch → SELECT 1.
    const r = rewriteEncryptionPolicy('CREATE ENCRYPTION POLICY p');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true, category: 'ddl' });
  });
});

describe('rewriteEncryptionPolicy — ALTER policy', () => {
  beforeEach(() => TDEConfig.reset());

  it('recreates policy when existing (drop + create)', () => {
    TDEConfig.createPolicy('p', 'aes-256-gcm');
    const r = rewriteEncryptionPolicy(
      "ALTER ENCRYPTION POLICY p SET (encryption_algorithm = 'aes-128-gcm')",
    );
    expect(r).toEqual({ sql: null, rewritten: true, category: 'ddl' });
    expect(TDEConfig.getPolicy('p')?.algorithm).toBe('aes-128-gcm');
  });

  it('creates policy when not existing', () => {
    const r = rewriteEncryptionPolicy(
      "ALTER ENCRYPTION POLICY p2 SET (encryption_algorithm = 'aes-192-gcm')",
    );
    expect(r.rewritten).toBe(true);
    expect(TDEConfig.getPolicy('p2')?.algorithm).toBe('aes-192-gcm');
  });

  it('falls back to SELECT 1 on invalid algorithm in ALTER', () => {
    const r = rewriteEncryptionPolicy(
      "ALTER ENCRYPTION POLICY p SET (encryption_algorithm = 'AES999')",
    );
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true, category: 'ddl' });
  });

  it('generic ALTER without SET → SELECT 1', () => {
    const r = rewriteEncryptionPolicy('ALTER ENCRYPTION POLICY p OWNER TO other');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true, category: 'ddl' });
  });
});
