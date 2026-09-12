import { describe, it, expect } from 'vitest';
import {
  detectPgCrypto,
  rewritePgCrypto,
  pgp_sym_encrypt,
  pgp_sym_decrypt,
  isLegacyHexFormat,
} from '../query/PgCryptoShim';

// PgCryptoShim rewrites pgcrypto function calls to SQLite equivalents and
// provides a real AES-256-GCM symmetric cipher. It must not rewrite a function
// name inside a string literal, quoted identifier, or (single/multi-line) comment.
describe('PgCryptoShim', () => {
  describe('detectPgCrypto', () => {
    it('detects each pgcrypto function', () => {
      expect(detectPgCrypto('SELECT crypt(pwd, salt)')).toBe(true);
      expect(detectPgCrypto("SELECT gen_salt('bf')")).toBe(true);
      expect(detectPgCrypto('SELECT pgp_sym_encrypt(d, k)')).toBe(true);
      expect(detectPgCrypto('SELECT pgp_sym_decrypt(d, k)')).toBe(true);
      expect(detectPgCrypto('SELECT pgp_pub_encrypt(d, k)')).toBe(true);
      expect(detectPgCrypto('SELECT pgp_pub_decrypt(d, k)')).toBe(true);
      expect(detectPgCrypto('SELECT digest(d, "sha256")')).toBe(true);
      expect(detectPgCrypto('SELECT hmac(d, k, "sha256")')).toBe(true);
    });

    it('does not detect inside a string literal or comment', () => {
      expect(detectPgCrypto("SELECT 'digest(x,y)'")).toBe(false);
      expect(detectPgCrypto('-- crypt(a,b)\nSELECT 1')).toBe(false);
      expect(detectPgCrypto('/* digest(x,y) */ SELECT 1')).toBe(false);
    });

    it('returns false for unrelated SQL and non-string input', () => {
      expect(detectPgCrypto('SELECT 1')).toBe(false);
      expect(detectPgCrypto(null as any)).toBe(false);
    });
  });

  describe('rewritePgCrypto', () => {
    it('rewrites gen_salt to a literal salt', () => {
      expect(rewritePgCrypto("SELECT gen_salt('bf')")).toEqual({
        sql: "SELECT 'salt'", rewritten: true,
      });
    });

    it('rewrites crypt to hex(sha256(expr))', () => {
      expect(rewritePgCrypto('SELECT crypt(pwd, salt)')).toEqual({
        sql: 'SELECT hex(sha256(pwd))', rewritten: true,
      });
    });

    it('rewrites pgp_sym_encrypt keeping BOTH arguments', () => {
      expect(rewritePgCrypto('SELECT pgp_sym_encrypt(data, secret_key)')).toEqual({
        sql: 'SELECT _pgp_sym_encrypt_sc(data, secret_key)', rewritten: true,
      });
    });

    it('rewrites pgp_sym_decrypt keeping BOTH arguments', () => {
      expect(rewritePgCrypto('SELECT pgp_sym_decrypt(ct, secret_key)')).toEqual({
        sql: 'SELECT _pgp_sym_decrypt_sc(ct, secret_key)', rewritten: true,
      });
    });

    it('rewrites pgp_pub_encrypt and pgp_pub_decrypt', () => {
      expect(rewritePgCrypto('SELECT pgp_pub_encrypt(data, pubkey)').sql).toBe('SELECT hex(data)');
      expect(rewritePgCrypto('SELECT pgp_pub_decrypt(ct, privkey)').sql).toBe('SELECT ct');
    });

    it('rewrites digest and hmac', () => {
      expect(rewritePgCrypto('SELECT digest(d, "sha256")').sql).toBe('SELECT hex(sha256(d))');
      expect(rewritePgCrypto('SELECT hmac(d, k, "sha256")').sql).toBe(
        'SELECT hex(sha256(d || k))',
      );
    });

    it('crypt with a nested gen_salt resolves to the literal first', () => {
      expect(rewritePgCrypto('SELECT crypt(pwd, gen_salt("bf"))').sql).toBe(
        'SELECT hex(sha256(pwd))',
      );
    });

    it('does NOT rewrite inside a string literal', () => {
      expect(rewritePgCrypto("SELECT 'digest(x,y)' AS t")).toEqual({
        sql: "SELECT 'digest(x,y)' AS t", rewritten: false,
      });
    });

    it('does NOT rewrite inside a comment', () => {
      expect(rewritePgCrypto('-- crypt(a,b)\nSELECT 1')).toEqual({
        sql: '-- crypt(a,b)\nSELECT 1', rewritten: false,
      });
      expect(rewritePgCrypto('/* digest(x,y) */ SELECT 1')).toEqual({
        sql: '/* digest(x,y) */ SELECT 1', rewritten: false,
      });
    });

    it('returns passthrough for non-string input', () => {
      expect(rewritePgCrypto(null as any)).toEqual({ sql: '', rewritten: false });
    });
  });

  describe('pgp_sym_encrypt / pgp_sym_decrypt', () => {
    it('round-trips plaintext through AES-256-GCM', () => {
      const ct = pgp_sym_encrypt('hello world', 'p@ssw0rd');
      expect(ct).not.toBe('');
      expect(ct).not.toBe('hello world');
      expect(pgp_sym_decrypt(ct, 'p@ssw0rd')).toBe('hello world');
    });

    it('handles empty data and empty password', () => {
      expect(pgp_sym_encrypt('', 'pw')).toBe('');
      expect(pgp_sym_encrypt('data', '')).toBe('');
      expect(pgp_sym_decrypt('', 'pw')).toBe('');
      expect(pgp_sym_decrypt('data', '')).toBe('');
    });

    it('passes through legacy hex-only ciphertext', () => {
      expect(pgp_sym_decrypt('48656c6c6f', 'pw')).toBe('48656c6c6f');
    });

    it('throws on untampered/invalid base64 ciphertext', () => {
      expect(() => pgp_sym_decrypt('!!!not-base64!!!', 'pw')).toThrow();
    });

    it('throws on too-short ciphertext', () => {
      // base64 of a very short binary (shorter than salt+iv+tag+1)
      expect(() => pgp_sym_decrypt('YQ==', 'pw')).toThrow(/too short/);
    });

    it('throws on wrong password (GCM auth-tag mismatch)', () => {
      const ct = pgp_sym_encrypt('sensitive', 'correct-pw');
      expect(() => pgp_sym_decrypt(ct, 'wrong-pw')).toThrow(/decryption failed/);
    });
  });

  describe('isLegacyHexFormat', () => {
    it('detects even-length hex strings', () => {
      expect(isLegacyHexFormat('48656c6c6f6f')).toBe(true);
      expect(isLegacyHexFormat('aabbcc')).toBe(true);
      expect(isLegacyHexFormat('aabbccd')).toBe(false); // odd length
    });

    it('rejects non-hex and short inputs', () => {
      expect(isLegacyHexFormat('xyz')).toBe(false);
      expect(isLegacyHexFormat('a')).toBe(false);
      expect(isLegacyHexFormat('')).toBe(false);
    });
  });
});
