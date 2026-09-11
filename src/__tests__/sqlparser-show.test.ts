import { describe, it, expect } from 'vitest';
import { detectShow, rewriteShow } from '../query/ShowShim';

// SQLite does not understand PG-specific SHOW statements. ShowShim rewrites
// known SHOW parameters into SELECT literals returning PG-compatible values.
describe('ShowShim', () => {
  describe('detectShow', () => {
    it('rejects non-string input', () => {
      expect(detectShow(null as any)).toBe(false);
      expect(detectShow(42 as any)).toBe(false);
    });

    it('detects a plain SHOW statement (case-insensitive)', () => {
      expect(detectShow('SHOW server_version')).toBe(true);
      expect(detectShow('shOw server_version')).toBe(true);
      expect(detectShow('  SHOW server_version  ')).toBe(true);
    });

    it('rejects non-SHOW statements', () => {
      expect(detectShow('SELECT 1')).toBe(false);
      expect(detectShow('SET work_mem = 4MB')).toBe(false);
    });
  });

  describe('rewriteShow', () => {
    it('returns null for non-string input', () => {
      expect(rewriteShow(null as any)).toBeNull();
      expect(rewriteShow(undefined as any)).toBeNull();
    });

    it('rewrites a known scalar parameter to a SELECT literal', () => {
      expect(rewriteShow('SHOW server_version')).toBe(
        'SELECT \'16.4\' AS "server_version"',
      );
    });

    it('rewrites a numeric parameter', () => {
      expect(rewriteShow('SHOW server_version_num')).toBe(
        'SELECT \'160004\' AS "server_version_num"',
      );
    });

    it('rewrites with a trailing semicolon', () => {
      expect(rewriteShow('SHOW server_version;')).toBe(
        'SELECT \'16.4\' AS "server_version"',
      );
    });

    it('rewrites a mixed-case canonical parameter name', () => {
      expect(rewriteShow('SHOW TimeZone')).toBe('SELECT \'UTC\' AS "TimeZone"');
      expect(rewriteShow('SHOW DateStyle')).toBe('SELECT \'ISO, MDY\' AS "DateStyle"');
      expect(rewriteShow('SHOW IntervalStyle')).toBe('SELECT \'postgres\' AS "IntervalStyle"');
    });

    it('rewrites the lowercase form of a mixed-case parameter', () => {
      expect(rewriteShow('SHOW timezone')).toBe('SELECT \'UTC\' AS "timezone"');
    });

    it('returns null for an unknown parameter', () => {
      expect(rewriteShow('SHOW unknown_param')).toBeNull();
    });

    it('returns null when the statement does not match the SHOW param shape', () => {
      expect(rewriteShow('SELECT 1')).toBeNull();
    });
  });
});
