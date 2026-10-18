/**
 * mfa-shim.test.ts — Coverage tests for MFAShim
 * (PostgreSQL Multi-Factor Authentication compatibility shim).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectMFA, rewriteMFA } from '../query/MFAShim';
import { SecurityNoticeCollector } from '../query/SecurityNoticeCollector';

beforeEach(() => {
  SecurityNoticeCollector.clear();
});

describe('detectMFA', () => {
  it('returns false for non-string input', () => {
    expect(detectMFA(undefined as unknown as string)).toBe(false);
    expect(detectMFA(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectMFA('')).toBe(false);
    expect(detectMFA('   ')).toBe(false);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectMFA('SELECT 1')).toBe(false);
    expect(detectMFA('CREATE TABLE t (id INT)')).toBe(false);
  });

  it('detects ALTER ROLE SET mfa_required', () => {
    expect(detectMFA('ALTER ROLE bob SET mfa_required = true')).toBe(true);
    expect(detectMFA('ALTER ROLE "alice" SET mfa_required = false')).toBe(true);
  });

  it('detects SET mfa.enabled', () => {
    expect(detectMFA('SET mfa.enabled = on')).toBe(true);
    expect(detectMFA('SET SESSION mfa.enabled = off')).toBe(true);
  });

  it('detects SET mfa.require_entity', () => {
    expect(detectMFA("SET mfa.require_entity = 'totp'")).toBe(true);
    expect(detectMFA("SET LOCAL mfa.require_entity TO 'email'")).toBe(true);
  });

  it('detects SHOW mfa.enabled', () => {
    expect(detectMFA('SHOW mfa.enabled')).toBe(true);
  });

  it('detects SHOW mfa.require_entity', () => {
    expect(detectMFA('SHOW mfa.require_entity')).toBe(true);
  });

  it('detects ALTER SYSTEM SET mfa.*', () => {
    expect(detectMFA("ALTER SYSTEM SET mfa.foo = 'bar'")).toBe(true);
  });
});

describe('rewriteMFA', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteMFA(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteMFA('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through unrelated SQL', () => {
    expect(rewriteMFA('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    expect(SecurityNoticeCollector.count).toBe(0);
  });

  it('rewrites ALTER ROLE SET mfa_required to SELECT 1 with notice', () => {
    const r = rewriteMFA('ALTER ROLE bob SET mfa_required = true');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites SET mfa.enabled to SELECT 1 with notice', () => {
    const r = rewriteMFA('SET mfa.enabled = on');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites SET mfa.require_entity to SELECT 1 with notice', () => {
    const r = rewriteMFA("SET mfa.require_entity = 'totp'");
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites SHOW mfa.enabled to off placeholder with notice', () => {
    const r = rewriteMFA('SHOW mfa.enabled');
    expect(r).toEqual({ sql: "SELECT 'off' AS mfa_enabled", rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites SHOW mfa.require_entity to empty placeholder with notice', () => {
    const r = rewriteMFA('SHOW mfa.require_entity');
    expect(r).toEqual({ sql: "SELECT '' AS mfa_require_entity", rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites ALTER SYSTEM SET mfa.* to SELECT 1 with notice', () => {
    const r = rewriteMFA("ALTER SYSTEM SET mfa.enabled = on");
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('notice message is well-formed with feature uppercased', () => {
    rewriteMFA('SET mfa.enabled = on');
    const notices = SecurityNoticeCollector.drain();
    expect(notices).toHaveLength(1);
    expect(notices[0].severity).toBe('WARNING');
    expect(notices[0].message).toBe('[MFA] MFA is not implemented by this database vendor');
  });
});
