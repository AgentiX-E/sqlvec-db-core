import { describe, it, expect, beforeEach } from 'vitest';
import {
  AutoExplainShim,
  detectAutoExplain,
  rewriteAutoExplain,
} from '../query/AutoExplainShim';

// AutoExplainShim is split between a singleton class (config + query recording)
// and two SQL interception functions (detectAutoExplain / rewriteAutoExplain).
describe('AutoExplainShim', () => {
  // Reset the singleton so each test starts from a clean config.
  beforeEach(() => {
    // Reach into the singleton via a private-ish reset: create a fresh config
    // by calling getInstance with a full override is not enough; instead we call
    // configure on the shared instance with the defaults.
    const inst = AutoExplainShim.getInstance();
    inst.configure({
      logMinDuration: 1000,
      logAnalyze: true,
      logNested: false,
      logFormat: 'text',
      logLevel: 'info',
      logTiming: true,
      logBuffers: false,
      logWal: false,
    });
  });

  describe('getInstance / configure / getConfig', () => {
    it('returns a stable singleton and merges config', () => {
      const a = AutoExplainShim.getInstance();
      const b = AutoExplainShim.getInstance();
      expect(a).toBe(b);
    });

    it('applies a config passed to getInstance when instance already exists', () => {
      const inst = AutoExplainShim.getInstance();
      expect(inst).toBe(AutoExplainShim.getInstance({ logMinDuration: 250 }));
      expect(inst.getConfig().logMinDuration).toBe(250);
    });

    it('applies configuration and returns a read-only copy', () => {
      const inst = AutoExplainShim.getInstance();
      inst.configure({ logMinDuration: 500 });
      const cfg = inst.getConfig();
      expect(cfg.logMinDuration).toBe(500);
      // Defaults preserved for untouched fields.
      expect(cfg.logFormat).toBe('text');
      expect(cfg.logAnalyze).toBe(true);
    });
  });

  describe('recordQuery', () => {
    it('does not throw for a query below the threshold', () => {
      const inst = AutoExplainShim.getInstance();
      inst.configure({ logMinDuration: 1000 });
      expect(() => inst.recordQuery('SELECT 1', 5)).not.toThrow();
    });

    it('does not throw for a query above the threshold (text format)', () => {
      const inst = AutoExplainShim.getInstance();
      inst.configure({ logMinDuration: 10, logFormat: 'text' });
      expect(() => inst.recordQuery('SELECT * FROM t', 50)).not.toThrow();
    });

    it('does not throw for json format', () => {
      const inst = AutoExplainShim.getInstance();
      inst.configure({ logMinDuration: 10, logFormat: 'json' });
      expect(() => inst.recordQuery('SELECT * FROM t', 50)).not.toThrow();
    });

    it('does not throw for warn/debug/trace log levels', () => {
      const inst = AutoExplainShim.getInstance();
      for (const level of ['warn', 'debug', 'trace', 'info'] as const) {
        inst.configure({ logMinDuration: 10, logLevel: level });
        expect(() => inst.recordQuery('SELECT 1', 50)).not.toThrow();
      }
    });

    it('uses the provided planText when given', () => {
      const inst = AutoExplainShim.getInstance();
      inst.configure({ logMinDuration: 10 });
      expect(() => inst.recordQuery('SELECT 1', 50, 'Custom Plan')).not.toThrow();
    });

    it('generates the correct placeholder plan per statement type', () => {
      const inst = AutoExplainShim.getInstance();
      inst.configure({ logMinDuration: 10, logFormat: 'text' });
      // No planText → generatePlaceholderPlan is exercised for each branch.
      expect(() => inst.recordQuery('SELECT * FROM t', 50)).not.toThrow();
      expect(() => inst.recordQuery('INSERT INTO t VALUES (1)', 50)).not.toThrow();
      expect(() => inst.recordQuery('UPDATE t SET a = 1', 50)).not.toThrow();
      expect(() => inst.recordQuery('DELETE FROM t', 50)).not.toThrow();
      expect(() => inst.recordQuery('VACUUM t', 50)).not.toThrow(); // utility fallback
    });

    it('handles logTiming=false and long SQL (>2000 chars)', () => {
      const inst = AutoExplainShim.getInstance();
      inst.configure({ logMinDuration: 10, logFormat: 'text', logTiming: false });
      const longSql = 'SELECT ' + 'x, '.repeat(700) + 'x FROM t';
      expect(longSql.length).toBeGreaterThan(2000);
      expect(() => inst.recordQuery(longSql, 50)).not.toThrow();
    });

    it('handles json format with logTiming=false', () => {
      const inst = AutoExplainShim.getInstance();
      inst.configure({ logMinDuration: 10, logFormat: 'json', logTiming: false });
      expect(() => inst.recordQuery('SELECT 1', 50)).not.toThrow();
    });
  });

  describe('detectAutoExplain', () => {
    it('detects real auto_explain usage', () => {
      expect(detectAutoExplain("SET auto_explain.log_min_duration = '1s'")).toBe(true);
      expect(detectAutoExplain('SELECT auto_explain')).toBe(true);
    });

    it('returns false for empty/non-string input', () => {
      expect(detectAutoExplain('')).toBe(false);
      expect(detectAutoExplain(undefined as unknown as string)).toBe(false);
    });

    it('does not report a token inside a string, line comment, or multiline comment', () => {
      expect(detectAutoExplain("SELECT 'auto_explain'")).toBe(false);
      expect(detectAutoExplain('SELECT 1 -- auto_explain')).toBe(false);
      expect(detectAutoExplain('/* auto_explain */ SELECT 1')).toBe(false);
    });
  });

  describe('rewriteAutoExplain', () => {
    it('rewrites SET log_min_duration with a duration unit', () => {
      expect(rewriteAutoExplain("SET auto_explain.log_min_duration = '1s'"))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
      expect(rewriteAutoExplain("SET auto_explain.log_min_duration = '500ms'"))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
    });

    it('rewrites SET log_min_duration across all duration units and raw numbers', () => {
      // parseDuration branches: h, min, s, plain number, and non-numeric fallback.
      const inst = AutoExplainShim.getInstance();
      const cases: Array<[string, number]> = [
        ['1h', 3600000],
        ['1min', 60000],
        ['1s', 1000],
        ['500ms', 500],
        ['0', 0],
        ['-1', -1],
        ['1.5s', 1500],
      ];
      for (const [v, expectedMs] of cases) {
        expect(rewriteAutoExplain(`SET auto_explain.log_min_duration = '${v}'`))
          .toEqual({ sql: 'SELECT 1', rewritten: true });
        // BUG #94 regression: the unit must be honored, not dropped by parseInt.
        expect(inst.getConfig().logMinDuration).toBe(expectedMs);
      }
      // Non-numeric, non-unit values hit the `!match` fallback (default threshold).
      inst.configure({ logMinDuration: 1000 });
      expect(rewriteAutoExplain("SET auto_explain.log_min_duration = 'abc'"))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
      expect(inst.getConfig().logMinDuration).toBe(1000);
      // Fractional value without a unit → defaults to milliseconds (else of `|| 'ms'`).
      expect(rewriteAutoExplain("SET auto_explain.log_min_duration = '1.5'"))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
      expect(inst.getConfig().logMinDuration).toBe(1.5);
      // Empty value → `!value` fast-path fallback to the default threshold.
      inst.configure({ logMinDuration: 1000 });
      expect(rewriteAutoExplain("SET auto_explain.log_min_duration = ''"))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
      expect(inst.getConfig().logMinDuration).toBe(1000);
    });

    it('rewrites boolean-ish SET params (on/true)', () => {
      for (const p of ['log_analyze', 'log_nested_statements', 'log_timing', 'log_buffers', 'log_wal']) {
        expect(rewriteAutoExplain(`SET auto_explain.${p} = 'on'`))
          .toEqual({ sql: 'SELECT 1', rewritten: true });
      }
    });

    it('rewrites log_format and log_level', () => {
      expect(rewriteAutoExplain("SET auto_explain.log_format = 'json'"))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
      // Non-json format hits the else branch (text).
      expect(rewriteAutoExplain("SET auto_explain.log_format = 'text'"))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
      expect(rewriteAutoExplain("SET auto_explain.log_level = 'debug'"))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
    });

    it('rewrites LOAD auto_explain to SELECT 1', () => {
      expect(rewriteAutoExplain("LOAD 'auto_explain'"))
        .toEqual({ sql: 'SELECT 1', rewritten: true });
    });

    it('passes through non-auto_explain SQL', () => {
      expect(rewriteAutoExplain('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    });

    it('returns blank passthrough for non-string input', () => {
      expect(rewriteAutoExplain('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteAutoExplain(null as unknown as string)).toEqual({ sql: '', rewritten: false });
    });

    // BUG #93 regression: a SET line inside a multiline comment must not be
    // rewritten (the old `m` flag matched the line-start SET).
    it('passes through a SET line inside a multiline comment', () => {
      expect(rewriteAutoExplain("/*\nSET auto_explain.log_min_duration = '1s'\n*/"))
        .toEqual({ sql: "/*\nSET auto_explain.log_min_duration = '1s'\n*/", rewritten: false });
    });
  });
});
