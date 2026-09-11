import { describe, it, expect } from 'vitest';
import { detectTopN, rewriteTopN } from '../query/TopNHeuristicShim';

// PostgreSQL's enable_top_n_heuristic GUC controls Top-N heap-sort optimization;
// SQLite has no equivalent. TopNHeuristicShim rewrites SET/SHOW of this GUC into
// a no-op SELECT 1 (SET) or a literal SELECT 'off' (SHOW).
describe('TopNHeuristicShim', () => {
  describe('detectTopN', () => {
    it('rejects non-string / empty / whitespace input', () => {
      expect(detectTopN(null as any)).toBe(false);
      expect(detectTopN('' as any)).toBe(false);
      expect(detectTopN('   ')).toBe(false);
    });

    it('rejects SQL that does not start with SET/SHOW', () => {
      expect(detectTopN('SELECT * FROM users')).toBe(false);
      expect(detectTopN('RESET enable_top_n_heuristic')).toBe(false);
    });

    it('detects SET enable_top_n_heuristic with = and = off', () => {
      expect(detectTopN('SET enable_top_n_heuristic = on')).toBe(true);
      expect(detectTopN('SET enable_top_n_heuristic = off')).toBe(true);
    });

    it('detects SET SESSION / SET LOCAL variants', () => {
      expect(detectTopN('SET SESSION enable_top_n_heuristic = on')).toBe(true);
      expect(detectTopN('SET LOCAL enable_top_n_heuristic = off')).toBe(true);
    });

    it('detects TO syntax and boolean/numeric literals', () => {
      expect(detectTopN('SET enable_top_n_heuristic TO on')).toBe(true);
      expect(detectTopN('SET enable_top_n_heuristic = true')).toBe(true);
      expect(detectTopN('SET enable_top_n_heuristic = 0')).toBe(true);
    });

    it('detects the DEFAULT reset value', () => {
      expect(detectTopN('SET enable_top_n_heuristic = DEFAULT')).toBe(true);
    });

    it('detects a trailing semicolon and case-insensitive input', () => {
      expect(detectTopN('SET enable_top_n_heuristic = on;')).toBe(true);
      expect(detectTopN('set enable_top_n_heuristic = off')).toBe(true);
    });

    it('detects SHOW enable_top_n_heuristic', () => {
      expect(detectTopN('SHOW enable_top_n_heuristic')).toBe(true);
      expect(detectTopN('SHOW enable_top_n_heuristic;')).toBe(true);
    });

    it('does not detect another SETTING name', () => {
      expect(detectTopN('SHOW work_mem')).toBe(false);
      expect(detectTopN('SET work_mem = 4MB')).toBe(false);
    });
  });

  describe('rewriteTopN', () => {
    it('returns passthrough for non-string / empty input', () => {
      expect(rewriteTopN(null as any)).toEqual({ sql: '', rewritten: false });
      expect(rewriteTopN('' as any)).toEqual({ sql: '', rewritten: false });
    });

    it('rewrites SET to a no-op SELECT 1', () => {
      expect(rewriteTopN('SET enable_top_n_heuristic = on')).toEqual({
        sql: 'SELECT 1', rewritten: true,
      });
    });

    it('rewrites all SET value forms (on/off/true/false/0/1/default) to SELECT 1', () => {
      for (const v of ['on', 'off', 'true', 'false', '0', '1', 'DEFAULT']) {
        expect(rewriteTopN(`SET enable_top_n_heuristic = ${v}`)).toEqual({
          sql: 'SELECT 1', rewritten: true,
        });
      }
    });

    it('rewrites SET SESSION and SET LOCAL to SELECT 1', () => {
      expect(rewriteTopN('SET SESSION enable_top_n_heuristic = on').sql).toBe('SELECT 1');
      expect(rewriteTopN('SET LOCAL enable_top_n_heuristic = off').sql).toBe('SELECT 1');
    });

    it('rewrites SHOW to the literal off projection', () => {
      expect(rewriteTopN('SHOW enable_top_n_heuristic')).toEqual({
        sql: "SELECT 'off' as enable_top_n_heuristic", rewritten: true,
      });
    });

    it('passes through non-Top-N SQL unchanged (trimmed)', () => {
      expect(rewriteTopN('SELECT * FROM users')).toEqual({
        sql: 'SELECT * FROM users', rewritten: false,
      });
      expect(rewriteTopN('  SHOW work_mem  ')).toEqual({
        sql: 'SHOW work_mem', rewritten: false,
      });
    });
  });
});
