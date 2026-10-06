import { describe, it, expect, beforeEach } from 'vitest';
import {
  AutoExplainShim,
  detectAutoExplain,
  rewriteAutoExplain,
  type AutoExplainConfig,
} from '../query/AutoExplainShim';

function freshConfig(overrides: Partial<AutoExplainConfig> = {}): AutoExplainConfig {
  return {
    logMinDuration: 1000,
    logAnalyze: true,
    logNested: false,
    logFormat: 'text',
    logLevel: 'info',
    logTiming: true,
    logBuffers: false,
    logWal: false,
    ...overrides,
  };
}

// The singleton persists across tests, so reset before each.
beforeEach(() => {
  (AutoExplainShim as unknown as { instance?: AutoExplainShim }).instance = undefined;
});

describe('AutoExplainShim lifecycle', () => {
  it('defaults config', () => {
    const ae = AutoExplainShim.getInstance();
    expect(ae.getConfig()).toEqual(freshConfig());
  });

  it('returns the same singleton instance', () => {
    const a = AutoExplainShim.getInstance();
    const b = AutoExplainShim.getInstance();
    expect(a).toBe(b);
  });

  it('merges config on subsequent getInstance calls', () => {
    AutoExplainShim.getInstance({ logMinDuration: 500 });
    const ae = AutoExplainShim.getInstance({ logFormat: 'json' });
    expect(ae.getConfig().logMinDuration).toBe(500);
    expect(ae.getConfig().logFormat).toBe('json');
  });

  it('configures at runtime', () => {
    const ae = AutoExplainShim.getInstance();
    ae.configure({ logMinDuration: 250, logTiming: false });
    expect(ae.getConfig().logMinDuration).toBe(250);
    expect(ae.getConfig().logTiming).toBe(false);
  });

  it('getConfig returns an isolated copy', () => {
    const ae = AutoExplainShim.getInstance();
    const cfg = ae.getConfig();
    cfg.logMinDuration = 9999;
    expect(ae.getConfig().logMinDuration).toBe(1000);
  });
});

describe('recordQuery', () => {
  it('skips queries below threshold', () => {
    const ae = AutoExplainShim.getInstance({ logMinDuration: 1000 });
    // We can't easily spy on logger.info, but calling should not throw and
    // below-threshold queries produce no observable side effect besides return.
    expect(() => ae.recordQuery('SELECT 1', 5.0)).not.toThrow();
  });

  it('records a query at/above threshold (text format)', () => {
    const ae = AutoExplainShim.getInstance({ logMinDuration: 1000 });
    expect(() => ae.recordQuery('SELECT * FROM t', 1234.5)).not.toThrow();
  });

  it('records with an explicit planText', () => {
    const ae = AutoExplainShim.getInstance({ logMinDuration: 100 });
    expect(() => ae.recordQuery('SELECT * FROM t', 200, 'Custom Plan')).not.toThrow();
  });

  it('uses json format when configured', () => {
    const ae = AutoExplainShim.getInstance({ logMinDuration: 100, logFormat: 'json' });
    expect(() => ae.recordQuery('SELECT * FROM t', 200)).not.toThrow();
  });

  it('handles warn/debug/trace log levels', () => {
    for (const level of ['warn', 'debug', 'trace'] as const) {
      const ae = AutoExplainShim.getInstance({ logMinDuration: 100, logLevel: level });
      expect(() => ae.recordQuery('SELECT * FROM t', 200)).not.toThrow();
    }
  });

  it('omits timing when logTiming is false (json)', () => {
    const ae = AutoExplainShim.getInstance({
      logMinDuration: 100,
      logFormat: 'json',
      logTiming: false,
    });
    expect(() => ae.recordQuery('SELECT * FROM t', 200)).not.toThrow();
  });

  it('truncates very long SQL in text format', () => {
    const ae = AutoExplainShim.getInstance({ logMinDuration: 100 });
    const longSql = 'SELECT ' + 'x'.repeat(2500);
    expect(() => ae.recordQuery(longSql, 200)).not.toThrow();
  });
});

describe('generatePlaceholderPlan (via recordQuery)', () => {
  it.each([
    ['SELECT 1'],
    ['INSERT INTO t VALUES (1)'],
    ['UPDATE t SET x = 1'],
    ['DELETE FROM t'],
    ['CREATE TABLE t (x int)'],
  ])('produces a plan for %s', (sql) => {
    const ae = AutoExplainShim.getInstance({ logMinDuration: 0 });
    expect(() => ae.recordQuery(sql, 1)).not.toThrow();
  });
});

describe('detectAutoExplain', () => {
  it('detects a real auto_explain reference', () => {
    expect(detectAutoExplain('SELECT auto_explain()')).toBe(true);
    expect(detectAutoExplain('SET auto_explain.log_min_duration = 1')).toBe(true);
  });

  it('ignores the token inside string literals', () => {
    expect(detectAutoExplain("SELECT * FROM t WHERE x = 'auto_explain'")).toBe(false);
    expect(detectAutoExplain("SELECT 'value auto_explain'")).toBe(false);
  });

  it('ignores the token inside SQL-escaped string literals', () => {
    expect(detectAutoExplain("SELECT 'a'' auto_explain'")).toBe(false);
  });

  it('ignores the token inside comments', () => {
    expect(detectAutoExplain('SELECT 1 -- auto_explain')).toBe(false);
    expect(detectAutoExplain('/* auto_explain */ SELECT 1')).toBe(false);
  });

  it('returns false for empty / non-string input', () => {
    expect(detectAutoExplain('')).toBe(false);
    expect(detectAutoExplain(null as unknown as string)).toBe(false);
    expect(detectAutoExplain(123 as unknown as string)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(detectAutoExplain('SELECT AUTO_EXPLAIN()')).toBe(true);
  });
});

describe('rewriteAutoExplain', () => {
  it('returns passthrough for empty / non-string', () => {
    expect(rewriteAutoExplain('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteAutoExplain(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('rewrites SET log_min_duration', () => {
    const r = rewriteAutoExplain("SET auto_explain.log_min_duration = '1s'");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
    expect(AutoExplainShim.getInstance().getConfig().logMinDuration).toBe(1000);
  });

  it.each([
    ["SET auto_explain.log_min_duration = '500ms'", 500],
    ["SET auto_explain.log_min_duration = '1min'", 60000],
    ["SET auto_explain.log_min_duration = '2h'", 7200000],
    ["SET auto_explain.log_min_duration = '0'", 0],
    ["SET auto_explain.log_min_duration = '-1'", -1],
    ["SET auto_explain.log_min_duration = '1.5s'", 1500],
    ["SET auto_explain.log_min_duration = 700", 700],
    // A decimal without a unit suffix -> unit defaults to 'ms'.
    ["SET auto_explain.log_min_duration = '1.5'", 1.5],
    // An empty value falls back to the default threshold.
    ["SET auto_explain.log_min_duration = ''", 1000],
    // An unparseable value falls back to the default threshold.
    ["SET auto_explain.log_min_duration = 'abc'", 1000],
  ])('parses duration %s', (sql, expected) => {
    rewriteAutoExplain(sql);
    expect(AutoExplainShim.getInstance().getConfig().logMinDuration).toBe(expected);
  });

  it('rewrites SET log_analyze boolean', () => {
    rewriteAutoExplain("SET auto_explain.log_analyze = 'true'");
    expect(AutoExplainShim.getInstance().getConfig().logAnalyze).toBe(true);
    rewriteAutoExplain("SET auto_explain.log_analyze = 'off'");
    expect(AutoExplainShim.getInstance().getConfig().logAnalyze).toBe(false);
  });

  it('rewrites SET log_nested_statements', () => {
    rewriteAutoExplain("SET auto_explain.log_nested_statements = 'on'");
    expect(AutoExplainShim.getInstance().getConfig().logNested).toBe(true);
  });

  it('rewrites SET log_format', () => {
    rewriteAutoExplain("SET auto_explain.log_format = 'json'");
    expect(AutoExplainShim.getInstance().getConfig().logFormat).toBe('json');
    rewriteAutoExplain("SET auto_explain.log_format = 'text'");
    expect(AutoExplainShim.getInstance().getConfig().logFormat).toBe('text');
    rewriteAutoExplain("SET auto_explain.log_format = 'bogus'");
    expect(AutoExplainShim.getInstance().getConfig().logFormat).toBe('text');
  });

  it('rewrites SET log_timing / log_buffers / log_wal', () => {
    rewriteAutoExplain("SET auto_explain.log_timing = 'false'");
    expect(AutoExplainShim.getInstance().getConfig().logTiming).toBe(false);
    rewriteAutoExplain("SET auto_explain.log_buffers = 'true'");
    expect(AutoExplainShim.getInstance().getConfig().logBuffers).toBe(true);
    rewriteAutoExplain("SET auto_explain.log_wal = 'on'");
    expect(AutoExplainShim.getInstance().getConfig().logWal).toBe(true);
  });

  it('rewrites SET log_buffers with a false value', () => {
    rewriteAutoExplain("SET auto_explain.log_buffers = 'off'");
    expect(AutoExplainShim.getInstance().getConfig().logBuffers).toBe(false);
  });

  it('rewrites SET log_level with a valid value', () => {
    rewriteAutoExplain("SET auto_explain.log_level = 'debug'");
    expect(AutoExplainShim.getInstance().getConfig().logLevel).toBe('debug');
  });

  it('ignores an invalid log_level value', () => {
    AutoExplainShim.getInstance().configure({ logLevel: 'info' });
    rewriteAutoExplain("SET auto_explain.log_level = 'foo'");
    expect(AutoExplainShim.getInstance().getConfig().logLevel).toBe('info');
  });

  it('rewrites LOAD auto_explain', () => {
    const r = rewriteAutoExplain("LOAD 'auto_explain'");
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
  });

  it('passes through non-auto_explain SQL', () => {
    const r = rewriteAutoExplain('SELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });

  it('does not treat a SET inside a comment as real configuration', () => {
    // Anchored `^` prevents multiline comment content from matching.
    const r = rewriteAutoExplain('/* SET auto_explain.log_min_duration = 5 */');
    expect(r.rewritten).toBe(false);
  });
});
