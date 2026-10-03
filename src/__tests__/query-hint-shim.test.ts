import { describe, it, expect } from 'vitest';
import {
  detectQueryHint,
  rewriteQueryHint,
  detectQueryHintGuc,
  executeQueryHintGuc,
  getQueryHintGucValue,
  isPlannerMethodEnabled,
  QUERY_HINT_GUCS,
} from '../query/QueryHintShim';

describe('detectQueryHint', () => {
  it('detects a real hint comment', () => {
    expect(detectQueryHint('SELECT /*+ SeqScan(t) */ * FROM t')).toBe(true);
  });

  it('does not detect a hint inside a string literal (BUG #447)', () => {
    expect(detectQueryHint("SELECT '/*+ SeqScan(t) */' FROM t")).toBe(false);
  });

  it('does not detect a hint inside a line comment (BUG #448)', () => {
    expect(detectQueryHint('-- /*+ SeqScan(t) */\nSELECT 1')).toBe(false);
  });

  it('does not detect a hint inside an ordinary block comment (BUG #450)', () => {
    expect(detectQueryHint('SELECT /* /*+ SeqScan(t) */ */ 1')).toBe(false);
  });

  it('does not detect a hint inside a dollar-quoted string', () => {
    expect(detectQueryHint('SELECT $$ /*+ x */ $$ FROM t')).toBe(false);
  });

  it('returns false for non-string / empty', () => {
    expect(detectQueryHint('')).toBe(false);
    expect(detectQueryHint(undefined as unknown as string)).toBe(false);
  });
});

describe('rewriteQueryHint', () => {
  it('strips a single hint', () => {
    const r = rewriteQueryHint('SELECT /*+ SeqScan(t) */ * FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT  * FROM t');
  });

  it('strips multiple hints', () => {
    const r = rewriteQueryHint('SELECT /*+ SeqScan(t) */ * /*+ IndexScan(t) */ FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT  *  FROM t');
  });

  it('strips a multi-line hint', () => {
    const r = rewriteQueryHint('SELECT /*+ SeqScan(t)\n  IndexScan(u) */ * FROM t');
    expect(r.rewritten).toBe(true);
  });

  it('leaves a string literal untouched (BUG #447)', () => {
    const r = rewriteQueryHint("SELECT '/*+ SeqScan(t) */' FROM t");
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe("SELECT '/*+ SeqScan(t) */' FROM t");
  });

  it('leaves a line comment untouched (BUG #448)', () => {
    const r = rewriteQueryHint('-- /*+ SeqScan(t) */\nSELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('-- /*+ SeqScan(t) */\nSELECT 1');
  });

  it('leaves an ordinary block comment untouched (BUG #450)', () => {
    const r = rewriteQueryHint('SELECT /* /*+ SeqScan(t) */ */ 1');
    expect(r.rewritten).toBe(false);
  });

  it('leaves an ordinary (non-hint) comment untouched', () => {
    expect(rewriteQueryHint('SELECT /* regular */ * FROM t').rewritten).toBe(false);
  });

  it('leaves an unterminated hint untouched', () => {
    const r = rewriteQueryHint('SELECT /*+ SeqScan(t) FROM t');
    expect(r.rewritten).toBe(false);
  });

  it('returns unchanged for empty', () => {
    expect(rewriteQueryHint('')).toEqual({ sql: '', rewritten: false });
  });
});

describe('detectQueryHintGuc', () => {
  it('detects a supported SET', () => {
    expect(detectQueryHintGuc('SET enable_hashjoin = off')).toBe(true);
  });

  it('detects a supported SHOW', () => {
    expect(detectQueryHintGuc('SHOW enable_hashjoin')).toBe(true);
  });

  it('rejects non-GUC SET / SHOW / random SQL', () => {
    expect(detectQueryHintGuc('SET foo = bar')).toBe(false);
    expect(detectQueryHintGuc('SHOW foo')).toBe(false);
    expect(detectQueryHintGuc('SELECT 1')).toBe(false);
    expect(detectQueryHintGuc('')).toBe(false);
  });

  it('rejects a regex-matching but unknown GUC name', () => {
    expect(detectQueryHintGuc('SET enable_nonexistent = off')).toBe(false);
    expect(detectQueryHintGuc('SHOW enable_nonexistent')).toBe(false);
  });
});

describe('executeQueryHintGuc', () => {
  it('applies a SET and returns rewritten SELECT 1', () => {
    const r = executeQueryHintGuc('SET enable_hashjoin = off');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
    expect(r.gucName).toBe('enable_hashjoin');
    expect(r.gucValue).toBe('off');
  });

  it('applies a SHOW and returns the stored value', () => {
    executeQueryHintGuc('SET enable_seqscan = off');
    const r = executeQueryHintGuc('SHOW enable_seqscan');
    expect(r.rewritten).toBe(true);
    expect(r.gucValue).toBe('off');
  });

  it('returns unchanged for a non-GUC SET', () => {
    const r = executeQueryHintGuc('SET foo = bar');
    expect(r.rewritten).toBe(false);
  });

  it('returns unchanged for a SET that matches the regex but is not a known GUC', () => {
    const r = executeQueryHintGuc('SET enable_nonexistent = off');
    expect(r.rewritten).toBe(false);
  });

  it('returns unchanged for a SHOW of an unknown GUC', () => {
    const r = executeQueryHintGuc('SHOW enable_nonexistent');
    expect(r.rewritten).toBe(false);
  });

  it('SHOW returns the PG default "on" when the GUC was never SET', () => {
    const r = executeQueryHintGuc('SHOW enable_indexscan');
    expect(r.rewritten).toBe(true);
    expect(r.gucValue).toBe('on');
    expect(r.sql).toBe("SELECT 'on' as enable_indexscan");
  });

  it('returns unchanged for random SQL', () => {
    const r = executeQueryHintGuc('SELECT 1');
    expect(r.rewritten).toBe(false);
  });

  it('returns unchanged for empty / non-string', () => {
    expect(executeQueryHintGuc('').rewritten).toBe(false);
    expect(executeQueryHintGuc(undefined as unknown as string).rewritten).toBe(false);
  });
});

describe('getQueryHintGucValue / isPlannerMethodEnabled', () => {
  it('returns the stored value, or default on', () => {
    executeQueryHintGuc('SET enable_hashjoin = off');
    expect(getQueryHintGucValue('enable_hashjoin')).toBe('off');
    expect(getQueryHintGucValue('enable_indexscan')).toBe('on');
    expect(getQueryHintGucValue('not_a_guc')).toBe('on');
  });

  it('reports planner method enabled/disabled', () => {
    executeQueryHintGuc('SET enable_hashjoin = off');
    expect(isPlannerMethodEnabled('enable_hashjoin')).toBe(false);
    expect(isPlannerMethodEnabled('enable_indexscan')).toBe(true);
    expect(isPlannerMethodEnabled('enable_foo')).toBe(true);
  });
});

describe('QUERY_HINT_GUCS', () => {
  it('contains the documented planner GUCs', () => {
    for (const n of ['enable_hashjoin', 'enable_seqscan', 'enable_nestloop', 'max_parallel_workers']) {
      expect(QUERY_HINT_GUCS).toContain(n);
    }
    expect(QUERY_HINT_GUCS.length).toBeGreaterThan(15);
  });
});
