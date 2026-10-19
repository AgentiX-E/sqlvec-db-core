/**
 * oauth2-shim.test.ts — Coverage tests for OAuth2Shim
 * (PostgreSQL OAuth2 configuration compatibility shim).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectOAuth2,
  rewriteOAuth2,
  _isOAuth2Parameter,
  _getOAuth2Parameters,
  _getShowMockValues,
} from '../query/OAuth2Shim';
import { SecurityNoticeCollector } from '../query/SecurityNoticeCollector';

beforeEach(() => {
  SecurityNoticeCollector.clear();
});

describe('detectOAuth2', () => {
  it('returns false for non-string input', () => {
    expect(detectOAuth2(undefined as unknown as string)).toBe(false);
    expect(detectOAuth2(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectOAuth2('')).toBe(false);
    expect(detectOAuth2('   ')).toBe(false);
  });

  it('returns false when fast prefix does not match', () => {
    expect(detectOAuth2('SELECT 1')).toBe(false);
    expect(detectOAuth2('CREATE TABLE t (id INT)')).toBe(false);
  });

  it('returns false when prefix matches but no oauth2 reference', () => {
    expect(detectOAuth2('SET some_var = 1')).toBe(false);
  });

  it('detects SET oauth2 statement', () => {
    expect(detectOAuth2('SET oauth2.enabled = on')).toBe(true);
  });

  it('detects ALTER ROLE ... SET oauth2_id statement', () => {
    expect(detectOAuth2("ALTER ROLE app SET oauth2_id = 'x'")).toBe(true);
  });

  it('detects SHOW oauth2 statement', () => {
    expect(detectOAuth2('SHOW oauth2.provider')).toBe(true);
  });

  it('returns false for prefix match with non-oauth2 reference', () => {
    expect(detectOAuth2('SHOW oauth2_something_else')).toBe(false);
  });
});

describe('rewriteOAuth2', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteOAuth2(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteOAuth2('')).toEqual({ sql: '', rewritten: false });
  });

  it('rewrites SET oauth2 statement to SELECT 1', () => {
    const r = rewriteOAuth2('SET oauth2.enabled = on');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites SET oauth2 with LOCAL prefix and TO assignment', () => {
    expect(rewriteOAuth2("SET LOCAL oauth2.client_id TO 'abc'")).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites ALTER ROLE ... SET oauth2_id to SELECT 1', () => {
    const r = rewriteOAuth2("ALTER ROLE app SET oauth2_id = 'x'");
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites ALTER ROLE with quoted role and IN DATABASE', () => {
    const r = rewriteOAuth2('ALTER ROLE "My Role" IN DATABASE mydb SET oauth2_id TO \'abc\'');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SHOW oauth2.* to all mock columns', () => {
    const r = rewriteOAuth2('SHOW oauth2.*');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("SELECT 'off' AS \"oauth2.enabled\"");
    expect(r.sql).toContain("'http://mock-issuer' AS \"oauth2.issuer\"");
    expect(r.sql).toContain("'http://mock-redirect' AS \"oauth2.redirect_uri\"");
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('rewrites SHOW oauth2.enabled to mock value', () => {
    expect(rewriteOAuth2('SHOW oauth2.enabled')).toEqual({
      sql: 'SELECT \'off\' AS "oauth2.enabled"',
      rewritten: true,
    });
  });

  it('rewrites SHOW oauth2.issuer to mock value', () => {
    expect(rewriteOAuth2('SHOW oauth2.issuer')).toEqual({
      sql: 'SELECT \'http://mock-issuer\' AS "oauth2.issuer"',
      rewritten: true,
    });
  });

  it('rewrites unknown oauth2 parameter to SELECT NULL', () => {
    const r = rewriteOAuth2('SHOW oauth2.unknown_param');
    expect(r).toEqual({ sql: 'SELECT NULL AS "oauth2.unknown_param"', rewritten: true });
    expect(SecurityNoticeCollector.count).toBe(1);
  });

  it('passes through unrelated SQL unchanged', () => {
    expect(rewriteOAuth2('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });
});

describe('internal helpers', () => {
  it('_isOAuth2Parameter returns true for known params', () => {
    expect(_isOAuth2Parameter('enabled')).toBe(true);
    expect(_isOAuth2Parameter('redirect_uri')).toBe(true);
  });

  it('_isOAuth2Parameter returns false for unknown params', () => {
    expect(_isOAuth2Parameter('unknown')).toBe(false);
    expect(_isOAuth2Parameter('')).toBe(false);
  });

  it('_getOAuth2Parameters returns the full list', () => {
    expect(_getOAuth2Parameters()).toEqual([
      'enabled',
      'provider',
      'client_id',
      'client_secret',
      'issuer',
      'redirect_uri',
    ]);
  });

  it('_getShowMockValues returns a copy with all entries', () => {
    const v = _getShowMockValues();
    expect(v).toEqual({
      enabled: 'off',
      provider: 'mock',
      client_id: 'mock',
      client_secret: 'mock',
      issuer: 'http://mock-issuer',
      redirect_uri: 'http://mock-redirect',
    });
  });
});
