import { describe, it, expect } from 'vitest';
import {
  hasGroupsFrame,
  detectGroupsFrame,
  rewriteGroupsFrame,
} from '../query/GroupsWindowShim';

describe('hasGroupsFrame / detectGroupsFrame', () => {
  it('returns false for empty / non-string / blank', () => {
    expect(hasGroupsFrame('')).toBe(false);
    expect(hasGroupsFrame('   ')).toBe(false);
    expect(hasGroupsFrame(null as unknown as string)).toBe(false);
    expect(detectGroupsFrame('SELECT 1')).toBe(false);
  });

  it('detects a GROUPS frame', () => {
    expect(hasGroupsFrame('SELECT SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW) FROM t')).toBe(true);
    expect(detectGroupsFrame('SELECT SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW) FROM t')).toBe(true);
  });

  it('does not detect GROUPS outside a frame context', () => {
    expect(hasGroupsFrame("SELECT 'GROUPS' FROM t")).toBe(false);
    expect(hasGroupsFrame('SELECT 1 -- GROUPS')).toBe(false);
  });

  it('does not detect GROUPS inside a string literal', () => {
    expect(hasGroupsFrame("SELECT 'SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW)' AS s FROM t")).toBe(false);
  });

  it('does not detect GROUPS inside comments', () => {
    expect(hasGroupsFrame('-- SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW)\nSELECT 1')).toBe(false);
    expect(hasGroupsFrame('/* SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW) */ SELECT 1')).toBe(false);
  });
});

describe('rewriteGroupsFrame', () => {
  it('returns unchanged when no GROUPS frame present', () => {
    expect(rewriteGroupsFrame('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    expect(rewriteGroupsFrame('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteGroupsFrame(null as unknown as string)).toEqual({ sql: null, rewritten: false });
  });

  it('rewrites GROUPS BETWEEN ... PRECEDING AND ... FOLLOWING', () => {
    const r = rewriteGroupsFrame(
      'SELECT SUM(x) OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('DENSE_RANK() OVER ( ORDER BY y)');
    expect(r.sql).toContain('BETWEEN __gws_cte_0.__gws_grp_0 - 1 AND __gws_cte_0.__gws_grp_0 + 1');
  });

  it('rewrites GROUPS UNBOUNDED PRECEDING', () => {
    const r = rewriteGroupsFrame('SELECT SUM(x) OVER (ORDER BY y GROUPS UNBOUNDED PRECEDING) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('sub.__gws_grp_0 <= __gws_cte_0.__gws_grp_0');
  });

  it('rewrites GROUPS CURRENT ROW', () => {
    const r = rewriteGroupsFrame('SELECT SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('sub.__gws_grp_0 = __gws_cte_0.__gws_grp_0');
  });

  it('rewrites GROUPS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING', () => {
    const r = rewriteGroupsFrame(
      'SELECT SUM(x) OVER (ORDER BY y GROUPS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('1=1');
  });

  it('rewrites a one-sided unbounded lower bound (regression #365)', () => {
    // BETWEEN UNBOUNDED PRECEDING AND 2 FOLLOWING must keep the upper bound.
    const r = rewriteGroupsFrame(
      'SELECT SUM(x) OVER (ORDER BY y GROUPS BETWEEN UNBOUNDED PRECEDING AND 2 FOLLOWING) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('BETWEEN -999999999 AND __gws_cte_0.__gws_grp_0 + 2');
  });

  it('rewrites a one-sided unbounded upper bound (regression #365)', () => {
    // BETWEEN 1 PRECEDING AND UNBOUNDED FOLLOWING must keep the lower bound.
    const r = rewriteGroupsFrame(
      'SELECT SUM(x) OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND UNBOUNDED FOLLOWING) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('BETWEEN __gws_cte_0.__gws_grp_0 - 1 AND 999999999');
  });

  it('falls back to ROWS when a GROUPS SELECT has no FROM clause', () => {
    const r = rewriteGroupsFrame('SELECT SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ROWS CURRENT ROW');
    expect(r.sql).toContain('peer-group semantics lost');
  });

  it('rewrites GROUPS with PARTITION BY', () => {
    const r = rewriteGroupsFrame(
      'SELECT SUM(x) OVER (PARTITION BY a ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('PARTITION BY a ORDER BY y');
    expect(r.sql).toContain('AND sub.a = __gws_cte_0.a');
  });

  it('rewrites AVG window function', () => {
    const r = rewriteGroupsFrame('SELECT AVG(x) OVER (ORDER BY y GROUPS CURRENT ROW) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('COUNT(sub.x) = 0');
  });

  it('rewrites COUNT(*) as COUNT(*)', () => {
    const r = rewriteGroupsFrame('SELECT COUNT(*) OVER (ORDER BY y GROUPS CURRENT ROW) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('COUNT(*)');
    expect(r.sql).not.toContain('COUNT(sub.');
  });

  it('rewrites COUNT(col)', () => {
    const r = rewriteGroupsFrame('SELECT COUNT(x) OVER (ORDER BY y GROUPS CURRENT ROW) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('COUNT(sub.x)');
  });

  it('rewrites MIN and MAX window functions', () => {
    expect(rewriteGroupsFrame('SELECT MIN(x) OVER (ORDER BY y GROUPS CURRENT ROW) FROM t').sql).toContain('MIN(sub.x)');
    expect(rewriteGroupsFrame('SELECT MAX(x) OVER (ORDER BY y GROUPS CURRENT ROW) FROM t').sql).toContain('MAX(sub.x)');
  });

  it('shares a single CTE across multiple window functions', () => {
    const r = rewriteGroupsFrame(
      'SELECT id, SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW), AVG(z) OVER (ORDER BY w GROUPS CURRENT ROW) FROM t',
    );
    expect(r.rewritten).toBe(true);
    // Two DENSE_RANK columns in the SAME CTE, not two separate CTEs.
    expect(r.sql).toContain('__gws_grp_0');
    expect(r.sql).toContain('__gws_grp_1');
    expect((r.sql.match(/__gws_cte_0 AS \(SELECT \*/g) || []).length).toBe(1);
    expect(r.sql).not.toContain('__gws_cte_1');
  });

  it('preserves a GROUPS frame inside a string literal', () => {
    const r = rewriteGroupsFrame(
      "SELECT 'SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW)' AS s FROM t",
    );
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe("SELECT 'SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW)' AS s FROM t");
  });

  it('preserves GROUPS inside comments', () => {
    expect(rewriteGroupsFrame('-- SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW)\nSELECT 1').rewritten).toBe(false);
    expect(rewriteGroupsFrame('/* SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW) */ SELECT 1').rewritten).toBe(false);
  });

  it('falls back to ROWS for a non-simple SELECT', () => {
    const r = rewriteGroupsFrame('INSERT INTO t VALUES (1)');
    expect(r.rewritten).toBe(false); // no GROUPS frame at all
  });

  it('falls back to ROWS when CTE rewrite is not feasible (nested args)', () => {
    const r = rewriteGroupsFrame(
      'SELECT SUM(nested(a,b)) OVER (ORDER BY y GROUPS CURRENT ROW) FROM t',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ROWS CURRENT ROW');
    expect(r.sql).toContain('peer-group semantics lost');
  });

  it('falls back to ROWS for a non-SELECT statement containing GROUPS', () => {
    const r = rewriteGroupsFrame(
      'UPDATE t SET x = SUM(y) OVER (ORDER BY z GROUPS CURRENT ROW)',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ROWS CURRENT ROW');
    expect(r.sql).toContain('peer-group semantics lost');
  });

  it('keeps trailing ORDER BY / LIMIT on the outer query', () => {
    const r = rewriteGroupsFrame(
      'SELECT SUM(x) OVER (ORDER BY y GROUPS CURRENT ROW) FROM t ORDER BY y LIMIT 10',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('FROM __gws_cte_0 ORDER BY y LIMIT 10');
    expect(r.sql).toContain('DENSE_RANK() OVER ( ORDER BY y) AS __gws_grp_0 FROM t');
  });

  it('handles a GROUPS frame without an explicit ORDER BY', () => {
    // With only PARTITION BY and no ORDER BY, extractOrderBy returns '' and the
    // DENSE_RANK clause uses an empty ORDER BY (degenerate but must not throw).
    const r = rewriteGroupsFrame('SELECT SUM(x) OVER (PARTITION BY a GROUPS CURRENT ROW) FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ORDER BY )');
    expect(r.sql).toContain('PARTITION BY a');
  });
});
