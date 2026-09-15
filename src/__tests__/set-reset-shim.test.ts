import { describe, it, expect } from 'vitest';
import {
  detectSetReset,
  handleSetReset,
  extractSetParameter,
  parsePgTimeInterval,
  detectAlterSystemSet,
  handleAlterSystemSet,
  detectAlterDefaultPrivileges,
  handleAlterDefaultPrivileges,
  _isSetOrResetStart,
} from '../query/SetResetShim';

describe('detectSetReset', () => {
  it('detects a basic SET assignment', () => {
    expect(detectSetReset("SET statement_timeout = '5min'")).toBe(true);
  });

  it('detects RESET ALL', () => {
    expect(detectSetReset('RESET ALL;')).toBe(true);
  });

  it('detects lowercase set', () => {
    expect(detectSetReset('set search_path to a, b')).toBe(true);
  });

  it('detects SET SESSION / SET LOCAL prefixes', () => {
    expect(detectSetReset("SET SESSION statement_timeout = '10s'")).toBe(true);
    expect(detectSetReset("SET LOCAL timezone = 'UTC'")).toBe(true);
  });

  it('returns false for non-SET statements', () => {
    expect(detectSetReset('SELECT * FROM t')).toBe(false);
    expect(detectSetReset('UPDATE t SET x = 1')).toBe(false);
  });

  it('returns false for SET token inside a string/comment', () => {
    expect(detectSetReset("SELECT 'SET foo'")).toBe(false);
    expect(detectSetReset('SELECT 1 -- SET bar')).toBe(false);
  });

  it('returns false for non-string input and blank input', () => {
    expect(detectSetReset(undefined as unknown as string)).toBe(false);
    expect(detectSetReset('   ')).toBe(false);
  });
});

describe('handleSetReset', () => {
  it('handles SET statement_timeout (noop:false via GucSystem)', () => {
    const r = handleSetReset("SET statement_timeout = '5min'");
    expect(r.rewritten).toBe(true);
    expect(r.noop).toBe(false);
    expect(r.parameter).toBe('statement_timeout');
    expect(r.value).toBe("'5min'");
  });

  it('handles SET statement_timeout via TO keyword', () => {
    const r = handleSetReset("SET statement_timeout TO '10s'");
    expect(r.rewritten).toBe(true);
    expect(r.parameter).toBe('statement_timeout');
  });

  it('handles RESET statement_timeout', () => {
    const r = handleSetReset('RESET statement_timeout');
    expect(r.rewritten).toBe(true);
    expect(r.noop).toBe(false);
    expect(r.parameter).toBe('statement_timeout');
  });

  it('handles RESET ALL as no-op', () => {
    const r = handleSetReset('RESET ALL;');
    expect(r.rewritten).toBe(true);
    expect(r.noop).toBe(true);
    expect(r.parameter).toBe('ALL');
  });

  it('handles SET TIME ZONE', () => {
    const r = handleSetReset("SET TIME ZONE 'UTC'");
    expect(r.rewritten).toBe(true);
    expect(r.noop).toBe(true);
    expect(r.parameter).toBe('timezone');
    expect(r.value).toBe("'UTC'");
  });

  it('handles SET TIME ZONE LOCAL', () => {
    const r = handleSetReset('SET TIME ZONE LOCAL');
    expect(r.rewritten).toBe(true);
    expect(r.parameter).toBe('timezone');
    expect(r.value).toBe('LOCAL');
  });

  it('handles SET NAMES with quote stripping', () => {
    const r = handleSetReset("SET NAMES 'UTF8'");
    expect(r.rewritten).toBe(true);
    expect(r.parameter).toBe('client_encoding');
    expect(r.value).toBe('UTF8');
  });

  it('handles SET boolean param (no value)', () => {
    const r = handleSetReset('SET enable_seqscan');
    expect(r.rewritten).toBe(true);
    expect(r.noop).toBe(true);
    expect(r.parameter).toBe('enable_seqscan');
    expect(r.value).toBe('on');
  });

  it('handles a generic no-op SET', () => {
    const r = handleSetReset('SET search_path TO my_schema, public');
    expect(r.rewritten).toBe(true);
    expect(r.noop).toBe(true);
    expect(r.parameter).toBe('search_path');
  });

  it('returns original for non-SET statements', () => {
    const r = handleSetReset('SELECT * FROM t');
    expect(r).toEqual({ sql: 'SELECT * FROM t', rewritten: false, noop: false });
  });

  it('handles empty/blank input', () => {
    expect(handleSetReset('')).toMatchObject({ rewritten: false });
    expect(handleSetReset(undefined as unknown as string)).toMatchObject({ rewritten: false });
  });

  it('handles RESET of an arbitrary parameter as a no-op', () => {
    const r = handleSetReset('RESET search_path');
    expect(r.rewritten).toBe(true);
    expect(r.noop).toBe(true);
    expect(r.parameter).toBe('search_path');
  });

  it('handles RESET client_encoding (wired reset)', () => {
    const r = handleSetReset('RESET client_encoding');
    expect(r.rewritten).toBe(true);
    expect(r.noop).toBe(true);
    expect(r.parameter).toBe('client_encoding');
  });

  it('handles SET client_encoding (stored)', () => {
    const r = handleSetReset("SET client_encoding = 'UTF8'");
    expect(r.rewritten).toBe(true);
    expect(r.parameter).toBe('client_encoding');
    expect(r.value).toBe("'UTF8'");
  });

  it('handles an unparseable statement_timeout value without throwing', () => {
    const r = handleSetReset("SET statement_timeout = 'invalid'");
    expect(r.rewritten).toBe(true);
    expect(r.noop).toBe(false);
  });

  it('strips a line comment from the value', () => {
    const r = handleSetReset("SET search_path = 'x' -- note");
    expect(r.rewritten).toBe(true);
    expect(r.value).toBe("'x'");
  });

  it('strips a block comment from the value', () => {
    const r = handleSetReset("SET search_path = 'x' /* note */");
    expect(r.rewritten).toBe(true);
    expect(r.value).toBe("'x'");
  });

  it('preserves an escaped quote inside the value', () => {
    const r = handleSetReset("SET a = 'it''s'");
    expect(r.rewritten).toBe(true);
    expect(r.value).toBe("'it''s'");
  });

  it('does not treat an empty SET value as a literal semicolon', () => {
    const r = handleSetReset('SET a = ;');
    expect(r.rewritten).toBe(true);
    expect(r.parameter).toBe('a');
  });
});

describe('extractSetParameter', () => {
  it('extracts statement_timeout from SET', () => {
    expect(extractSetParameter("SET statement_timeout = '5min'")).toBe('statement_timeout');
  });

  it('extracts ALL from RESET ALL', () => {
    expect(extractSetParameter('RESET ALL')).toBe('ALL');
  });

  it('extracts timezone from SET TIME ZONE', () => {
    expect(extractSetParameter("SET TIME ZONE 'UTC'")).toBe('timezone');
  });

  it('extracts client_encoding from SET NAMES', () => {
    expect(extractSetParameter("SET NAMES 'UTF8'")).toBe('client_encoding');
  });

  it('extracts parameter name from RESET', () => {
    expect(extractSetParameter('RESET statement_timeout')).toBe('statement_timeout');
  });

  it('extracts boolean SET parameter without a value', () => {
    expect(extractSetParameter('SET enable_seqscan')).toBe('enable_seqscan');
  });

  it('returns null for non-SET statements', () => {
    expect(extractSetParameter('SELECT 1')).toBe(null);
  });

  it('returns null for blank input', () => {
    expect(extractSetParameter('')).toBe(null);
    expect(extractSetParameter(undefined as unknown as string)).toBe(null);
  });
});

describe('parsePgTimeInterval', () => {
  it('parses bare integers as raw ms', () => {
    expect(parsePgTimeInterval('5000')).toBe(5000);
    expect(parsePgTimeInterval('0')).toBe(0);
  });

  it('parses suffixed durations', () => {
    expect(parsePgTimeInterval('5min')).toBe(300000);
    expect(parsePgTimeInterval('10s')).toBe(10000);
    expect(parsePgTimeInterval('1h')).toBe(3600000);
    expect(parsePgTimeInterval('100ms')).toBe(100);
    expect(parsePgTimeInterval('1.5min')).toBe(90000);
  });

  it('parses quoted values', () => {
    expect(parsePgTimeInterval("'5min'")).toBe(300000);
    expect(parsePgTimeInterval('"10s"')).toBe(10000);
  });

  it('does not drop units when the value carries a suffix', () => {
    expect(parsePgTimeInterval('1s')).toBe(1000);
    expect(parsePgTimeInterval('2min')).toBe(120000);
  });

  it('returns NaN for unparseable values', () => {
    expect(parsePgTimeInterval('invalid')).toBeNaN();
  });
});

describe('_isSetOrResetStart', () => {
  it('matches SET/RESET followed by whitespace', () => {
    expect(_isSetOrResetStart('SET x = 1')).toBe(true);
    expect(_isSetOrResetStart('RESET ALL')).toBe(true);
    expect(_isSetOrResetStart('SELECT 1')).toBe(false);
  });
});

describe('ALTER DEFAULT PRIVILEGES', () => {
  it('detects ALTER DEFAULT PRIVILEGES', () => {
    expect(detectAlterDefaultPrivileges('ALTER DEFAULT PRIVILEGES FOR ROLE r GRANT SELECT ON TABLES TO g')).toBe(true);
    expect(detectAlterDefaultPrivileges('SELECT 1')).toBe(false);
    expect(detectAlterDefaultPrivileges('')).toBe(false);
    expect(detectAlterDefaultPrivileges(undefined as unknown as string)).toBe(false);
  });

  it('handles ALTER DEFAULT PRIVILEGES as deferred no-op', () => {
    const r = handleAlterDefaultPrivileges('ALTER DEFAULT PRIVILEGES FOR ROLE r GRANT SELECT ON TABLES TO g');
    expect(r.rewritten).toBe(false);
    expect(r.noop).toBe(true);
    expect(r.parameter).toBe('default_privileges');
  });

  it('returns original for non ALTER DEFAULT PRIVILEGES', () => {
    const r = handleAlterDefaultPrivileges('SELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.noop).toBe(false);
  });
});

describe('ALTER SYSTEM SET', () => {
  it('detects a generic ALTER SYSTEM SET', () => {
    expect(detectAlterSystemSet("ALTER SYSTEM SET work_mem = '64MB'")).toBe(true);
  });

  it('rejects MFA and encryption shims', () => {
    expect(detectAlterSystemSet('ALTER SYSTEM SET mfa.enabled = on')).toBe(false);
    expect(detectAlterSystemSet('ALTER SYSTEM SET encryption.foo = bar')).toBe(false);
  });

  it('returns false for non-string input', () => {
    expect(detectAlterSystemSet(undefined as unknown as string)).toBe(false);
  });

  it('handles a generic ALTER SYSTEM SET as a GUC no-op', () => {
    const r = handleAlterSystemSet("ALTER SYSTEM SET work_mem = '64MB'");
    expect(r.rewritten).toBe(true);
    expect(r.noop).toBe(true);
    expect(r.parameter).toBe('work_mem');
  });

  it('returns original for non ALTER SYSTEM SET', () => {
    const r = handleAlterSystemSet('SELECT 1');
    expect(r.rewritten).toBe(false);
  });
});
