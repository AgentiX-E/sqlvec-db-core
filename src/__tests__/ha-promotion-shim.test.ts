/**
 * ha-promotion-shim.test.ts — Coverage tests for HAPromotionShim
 * (PostgreSQL HA / promotion orchestration compatibility shim).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectHAPromotion,
  rewriteHAPromotion,
  setConfigReloadCallback,
  clearConfigReloadCallback,
} from '../query/HAPromotionShim';
import { WALStateManager } from '../storage/WALStateManager';

beforeEach(() => {
  clearConfigReloadCallback();
  WALStateManager.resetInstance();
});

afterEach(() => {
  clearConfigReloadCallback();
});

describe('detectHAPromotion', () => {
  it('returns false for non-string input', () => {
    expect(detectHAPromotion(undefined as unknown as string)).toBe(false);
    expect(detectHAPromotion(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectHAPromotion('')).toBe(false);
    expect(detectHAPromotion('   ')).toBe(false);
  });

  it('detects pg_promote', () => {
    expect(detectHAPromotion('SELECT pg_promote()')).toBe(true);
    expect(detectHAPromotion('SELECT pg_catalog.pg_promote()')).toBe(true);
  });

  it('detects pg_ctl promote text form', () => {
    expect(detectHAPromotion('SELECT pg_ctl promote')).toBe(true);
  });

  it('detects pg_reload_conf', () => {
    expect(detectHAPromotion('SELECT pg_reload_conf()')).toBe(true);
  });

  it('detects pg_rotate_logfile', () => {
    expect(detectHAPromotion('SELECT pg_rotate_logfile()')).toBe(true);
  });

  it('detects pg_switch_wal', () => {
    expect(detectHAPromotion('SELECT pg_switch_wal()')).toBe(true);
  });

  it('detects pg_switch_xlog', () => {
    expect(detectHAPromotion('SELECT pg_switch_xlog()')).toBe(true);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectHAPromotion('SELECT 1')).toBe(false);
    expect(detectHAPromotion('SELECT * FROM t')).toBe(false);
  });
});

describe('rewriteHAPromotion', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteHAPromotion(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteHAPromotion('')).toEqual({ sql: '', rewritten: false });
  });

  it('rewrites pg_promote (no trailing semicolon)', () => {
    expect(rewriteHAPromotion('SELECT pg_promote()')).toEqual({ sql: 'SELECT 1 as promoted', rewritten: true });
  });

  it('rewrites pg_promote preserving trailing semicolon', () => {
    expect(rewriteHAPromotion('SELECT pg_promote();')).toEqual({ sql: 'SELECT 1 as promoted;', rewritten: true });
  });

  it('rewrites pg_ctl promote text form', () => {
    expect(rewriteHAPromotion('SELECT pg_ctl promote')).toEqual({ sql: 'SELECT 1 as promoted', rewritten: true });
  });

  it('rewrites pg_switch_wal using real WAL switch', () => {
    const before = WALStateManager.getInstance();
    const r = rewriteHAPromotion('SELECT pg_switch_wal()');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toMatch(/^SELECT '[0-9A-F]+\/[0-9A-F]+' as wal$/);
  });

  it('rewrites pg_switch_xlog with trailing semicolon', () => {
    const r = rewriteHAPromotion('SELECT pg_switch_xlog();');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toMatch(/^SELECT '[0-9A-F]+\/[0-9A-F]+' as wal;$/);
  });

  it('rewrites pg_reload_conf (no callback registered)', () => {
    expect(rewriteHAPromotion('SELECT pg_reload_conf()')).toEqual({ sql: 'SELECT true as reloaded', rewritten: true });
  });

  it('rewrites pg_reload_conf invoking callback', () => {
    let called = 0;
    setConfigReloadCallback(() => {
      called++;
    });
    expect(rewriteHAPromotion('SELECT pg_reload_conf()')).toEqual({ sql: 'SELECT true as reloaded', rewritten: true });
    expect(called).toBe(1);
  });

  it('rewrites pg_reload_conf swallowing callback error', () => {
    setConfigReloadCallback(() => {
      throw new Error('config reload boom');
    });
    expect(rewriteHAPromotion('SELECT pg_reload_conf()')).toEqual({ sql: 'SELECT true as reloaded', rewritten: true });
  });

  it('rewrites pg_rotate_logfile', () => {
    expect(rewriteHAPromotion('SELECT pg_rotate_logfile()')).toEqual({ sql: 'SELECT true as rotated', rewritten: true });
  });

  it('passes through unrelated SQL unchanged', () => {
    expect(rewriteHAPromotion('SELECT * FROM t')).toEqual({ sql: 'SELECT * FROM t', rewritten: false });
  });
});

describe('config reload callback lifecycle', () => {
  it('set then clear callback', () => {
    let called = 0;
    setConfigReloadCallback(() => {
      called++;
    });
    rewriteHAPromotion('SELECT pg_reload_conf()');
    expect(called).toBe(1);

    clearConfigReloadCallback();
    rewriteHAPromotion('SELECT pg_reload_conf()');
    expect(called).toBe(1); // not called again after clear
  });
});
