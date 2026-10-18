/**
 * ssh-key-shim.test.ts — Coverage tests for SSHKeyShim (PostgreSQL SSH key
 * management compatibility shim).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectSSHKey, rewriteSSHKey } from '../query/SSHKeyShim';
import { SecurityNoticeCollector } from '../query/SecurityNoticeCollector';

describe('detectSSHKey', () => {
  it('returns false for non-string input', () => {
    expect(detectSSHKey(undefined as unknown as string)).toBe(false);
    expect(detectSSHKey(null as unknown as string)).toBe(false);
    expect(detectSSHKey(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectSSHKey('')).toBe(false);
    expect(detectSSHKey('   ')).toBe(false);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectSSHKey('SELECT 1')).toBe(false);
    expect(detectSSHKey('CREATE TABLE t (id int)')).toBe(false);
    expect(detectSSHKey('SELECT * FROM ssh_key')).toBe(false);
  });

  it('detects CREATE SSH KEY', () => {
    expect(detectSSHKey('CREATE SSH KEY my_key')).toBe(true);
    expect(detectSSHKey('CREATE SSH KEY IF NOT EXISTS my_key TYPE rsa')).toBe(true);
    expect(detectSSHKey('create ssh key my_key')).toBe(true);
  });

  it('detects ALTER ROLE SET ssh_public_key', () => {
    expect(detectSSHKey("ALTER ROLE alice SET ssh_public_key = 'key'")).toBe(true);
    expect(detectSSHKey('ALTER ROLE bob SET ssh_public_key TO current')).toBe(true);
  });

  it('detects DROP SSH KEY', () => {
    expect(detectSSHKey('DROP SSH KEY my_key')).toBe(true);
    expect(detectSSHKey('DROP SSH KEY IF EXISTS my_key CASCADE')).toBe(true);
  });

  it('detects SET ssh_key_provider', () => {
    expect(detectSSHKey("SET ssh_key_provider = 'file:///keys'")).toBe(true);
    expect(detectSSHKey("SET ssh_key_provider TO 'ldap://...'")).toBe(true);
    expect(detectSSHKey("SET SESSION ssh_key_provider = 'file:///keys'")).toBe(true);
  });

  it('detects SHOW ssh_key_provider and SHOW ssh_public_key', () => {
    expect(detectSSHKey('SHOW ssh_key_provider')).toBe(true);
    expect(detectSSHKey('SHOW ssh_public_key')).toBe(true);
  });
});

describe('rewriteSSHKey', () => {
  beforeEach(() => {
    SecurityNoticeCollector.clear();
  });

  it('returns passthrough for non-string input', () => {
    expect(rewriteSSHKey(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteSSHKey(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteSSHKey('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through unrelated SQL', () => {
    expect(rewriteSSHKey('SELECT * FROM users')).toEqual({ sql: 'SELECT * FROM users', rewritten: false });
  });

  it('rewrites SHOW ssh_key_provider', () => {
    expect(rewriteSSHKey('SHOW ssh_key_provider')).toEqual({
      sql: "SELECT '' AS ssh_key_provider",
      rewritten: true,
    });
  });

  it('rewrites SHOW ssh_public_key', () => {
    expect(rewriteSSHKey('SHOW ssh_public_key')).toEqual({
      sql: "SELECT '' AS ssh_public_key",
      rewritten: true,
    });
  });

  it('rewrites CREATE SSH KEY to SELECT 1', () => {
    expect(rewriteSSHKey('CREATE SSH KEY alice_key TYPE ed25519')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites DROP SSH KEY to SELECT 1', () => {
    expect(rewriteSSHKey('DROP SSH KEY IF EXISTS alice_key CASCADE')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites ALTER ROLE SET ssh_public_key to SELECT 1', () => {
    expect(rewriteSSHKey("ALTER ROLE alice SET ssh_public_key = 'ssh-rsa AAA'")).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SET ssh_key_provider to SELECT 1', () => {
    expect(rewriteSSHKey("SET ssh_key_provider = 'file:///keys'")).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('records a security notice on each rewrite', () => {
    rewriteSSHKey('CREATE SSH KEY my_key');
    expect(SecurityNoticeCollector.count).toBe(1);
    const notices = SecurityNoticeCollector.drain();
    expect(notices[0].message).toContain('[SSH_KEY]');
  });
});
