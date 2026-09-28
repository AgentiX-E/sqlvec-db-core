import { describe, it, expect } from 'vitest';
import {
  detectExclusionConstraint,
  rewriteExclusionConstraint,
} from '../query/ExclusionConstraintShim';

describe('detectExclusionConstraint', () => {
  it('returns false for empty or non-string input', () => {
    expect(detectExclusionConstraint('')).toBe(false);
    expect(detectExclusionConstraint(null as unknown as string)).toBe(false);
    expect(detectExclusionConstraint(undefined as unknown as string)).toBe(false);
    expect(detectExclusionConstraint(42 as unknown as string)).toBe(false);
  });

  it('returns false for whitespace-only input', () => {
    expect(detectExclusionConstraint('   ')).toBe(false);
  });

  it('detects EXCLUDE USING <method> (', () => {
    expect(detectExclusionConstraint('EXCLUDE USING gist (period WITH &&)')).toBe(true);
  });

  it('detects EXCLUDE directly followed by a column list', () => {
    expect(detectExclusionConstraint('EXCLUDE (a WITH =)')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectExclusionConstraint('exclude using btree (id WITH =)')).toBe(true);
  });

  it('returns false when no EXCLUDE is present', () => {
    expect(detectExclusionConstraint('CREATE TABLE t (id INT)')).toBe(false);
    expect(detectExclusionConstraint('SELECT 1')).toBe(false);
  });

  it('does not match EXCLUDE as part of a larger identifier', () => {
    expect(detectExclusionConstraint('SELECT exclude_count(x) FROM t')).toBe(false);
  });

  it('does not detect EXCLUDE inside a string literal', () => {
    expect(detectExclusionConstraint("SELECT 'EXCLUDE USING gist (' FROM t")).toBe(false);
    expect(detectExclusionConstraint("INSERT INTO t VALUES ('EXCLUDE (x)')")).toBe(false);
  });

  it('does not detect EXCLUDE inside a comment', () => {
    expect(detectExclusionConstraint('-- EXCLUDE (a)\nSELECT 1')).toBe(false);
  });
});

describe('rewriteExclusionConstraint', () => {
  it('returns unchanged for empty/non-string input', () => {
    expect(rewriteExclusionConstraint('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteExclusionConstraint('   ')).toEqual({ sql: '', rewritten: false });
    expect(rewriteExclusionConstraint(null as unknown as string)).toEqual({
      sql: null,
      rewritten: false,
    });
  });

  it('returns unchanged when no EXCLUDE present', () => {
    expect(rewriteExclusionConstraint('CREATE TABLE t (id INT)')).toEqual({
      sql: 'CREATE TABLE t (id INT)',
      rewritten: false,
    });
    expect(rewriteExclusionConstraint('SELECT 1')).toEqual({
      sql: 'SELECT 1',
      rewritten: false,
    });
  });

  it('removes a trailing table-level EXCLUDE constraint without a dangling comma', () => {
    expect(
      rewriteExclusionConstraint(
        'CREATE TABLE t (id INT, period TSTZRANGE, EXCLUDE USING gist (period WITH &&))',
      ),
    ).toEqual({
      sql: 'CREATE TABLE t (id INT, period TSTZRANGE)',
      rewritten: true,
    });
  });

  it('removes an unnamed EXCLUDE that is the sole last element', () => {
    expect(rewriteExclusionConstraint('CREATE TABLE t (a INT, b INT, EXCLUDE (x WITH =))')).toEqual({
      sql: 'CREATE TABLE t (a INT, b INT)',
      rewritten: true,
    });
  });

  it('removes a named CONSTRAINT ... EXCLUDE', () => {
    expect(
      rewriteExclusionConstraint(
        'CREATE TABLE t (id INT, CONSTRAINT no_overlap EXCLUDE USING gist (period WITH &&))',
      ),
    ).toEqual({
      sql: 'CREATE TABLE t (id INT)',
      rewritten: true,
    });
  });

  it('removes an EXCLUDE in the middle of a comma list, keeping the separator', () => {
    const r = rewriteExclusionConstraint('CREATE TABLE t (a INT, EXCLUDE (a WITH =), b INT)');
    expect(r.rewritten).toBe(true);
    // Both surrounding columns survive.
    expect(r.sql).toContain('a INT');
    expect(r.sql).toContain('b INT');
    // No dangling or doubled comma.
    expect(r.sql).not.toContain(',,');
    expect(r.sql).not.toMatch(/,\s*\)/);
  });

  it('removes an EXCLUDE that is the first element', () => {
    expect(rewriteExclusionConstraint('CREATE TABLE t (EXCLUDE (a WITH =), b INT)')).toEqual({
      sql: 'CREATE TABLE t (b INT)',
      rewritten: true,
    });
  });

  it('removes multiple EXCLUDE constraints in one statement', () => {
    expect(
      rewriteExclusionConstraint('CREATE TABLE t (a INT, EXCLUDE (a WITH =), EXCLUDE (b WITH &&))'),
    ).toEqual({
      sql: 'CREATE TABLE t (a INT)',
      rewritten: true,
    });
  });

  it('removes a WHERE clause trailing an EXCLUDE', () => {
    expect(
      rewriteExclusionConstraint('CREATE TABLE t (EXCLUDE USING btree (id WITH =) WHERE (active))'),
    ).toEqual({
      sql: 'CREATE TABLE t ()',
      rewritten: true,
    });
  });

  it('removes WITH storage options trailing an EXCLUDE', () => {
    expect(
      rewriteExclusionConstraint('CREATE TABLE t (EXCLUDE USING gist (a WITH &&) WITH (fillfactor=70))'),
    ).toEqual({
      sql: 'CREATE TABLE t ()',
      rewritten: true,
    });
  });

  it('removes INCLUDE trailing an EXCLUDE', () => {
    expect(
      rewriteExclusionConstraint('CREATE TABLE t (id INT, EXCLUDE USING gist (p WITH &&) INCLUDE (id))'),
    ).toEqual({
      sql: 'CREATE TABLE t (id INT)',
      rewritten: true,
    });
  });

  it('removes USING INDEX TABLESPACE trailing an EXCLUDE', () => {
    expect(
      rewriteExclusionConstraint('CREATE TABLE t (EXCLUDE USING gist (p WITH &&) USING INDEX TABLESPACE ts)'),
    ).toEqual({
      sql: 'CREATE TABLE t ()',
      rewritten: true,
    });
  });

  it('removes DEFERRABLE / NOT DEFERRABLE trailing an EXCLUDE', () => {
    expect(rewriteExclusionConstraint('CREATE TABLE t (EXCLUDE (a WITH =) DEFERRABLE)')).toEqual({
      sql: 'CREATE TABLE t ()',
      rewritten: true,
    });
    expect(rewriteExclusionConstraint('CREATE TABLE t (EXCLUDE (a WITH =) NOT DEFERRABLE)')).toEqual({
      sql: 'CREATE TABLE t ()',
      rewritten: true,
    });
  });

  it('removes INITIALLY DEFERRED / IMMEDIATE trailing an EXCLUDE', () => {
    expect(rewriteExclusionConstraint('CREATE TABLE t (EXCLUDE (a WITH =) INITIALLY DEFERRED)')).toEqual({
      sql: 'CREATE TABLE t ()',
      rewritten: true,
    });
    expect(rewriteExclusionConstraint('CREATE TABLE t (EXCLUDE (a WITH =) INITIALLY IMMEDIATE)')).toEqual({
      sql: 'CREATE TABLE t ()',
      rewritten: true,
    });
  });

  it('removes stacked trailing modifiers', () => {
    expect(
      rewriteExclusionConstraint('CREATE TABLE t (EXCLUDE (a WITH =) DEFERRABLE INITIALLY IMMEDIATE)'),
    ).toEqual({
      sql: 'CREATE TABLE t ()',
      rewritten: true,
    });
  });

  it('handles nested parentheses inside the EXCLUDE column list', () => {
    expect(
      rewriteExclusionConstraint('CREATE TABLE t (EXCLUDE USING gist (a WITH func((1,2))))'),
    ).toEqual({
      sql: 'CREATE TABLE t ()',
      rewritten: true,
    });
  });

  it('does not touch a string literal that merely looks like EXCLUDE', () => {
    expect(rewriteExclusionConstraint("SELECT 'EXCLUDE USING gist (' FROM t")).toEqual({
      sql: "SELECT 'EXCLUDE USING gist (' FROM t",
      rewritten: false,
    });
    expect(rewriteExclusionConstraint("INSERT INTO t VALUES ('EXCLUDE (x)')")).toEqual({
      sql: "INSERT INTO t VALUES ('EXCLUDE (x)')",
      rewritten: false,
    });
  });

  it('does not touch a comment that mentions EXCLUDE', () => {
    expect(rewriteExclusionConstraint('-- EXCLUDE (a)\nSELECT 1')).toEqual({
      sql: '-- EXCLUDE (a)\nSELECT 1',
      rewritten: false,
    });
  });

  it('removes EXCLUDE while preserving a string literal containing a parenthesis', () => {
    expect(rewriteExclusionConstraint("CREATE TABLE t (c TEXT DEFAULT '(', EXCLUDE (a WITH =))")).toEqual({
      sql: "CREATE TABLE t (c TEXT DEFAULT '(')",
      rewritten: true,
    });
  });

  it('handles an unbalanced EXCLUDE column list by removing to end of input', () => {
    expect(rewriteExclusionConstraint('CREATE TABLE t (EXCLUDE (a WITH =')).toEqual({
      sql: 'CREATE TABLE t (',
      rewritten: true,
    });
    expect(rewriteExclusionConstraint('EXCLUDE (a WITH =')).toEqual({
      sql: '',
      rewritten: true,
    });
  });

  it('handles unbalanced trailing INCLUDE / WITH / WHERE parentheses gracefully', () => {
    // The trailing clause's parens never close; the scanner falls back to
    // "remove to end" rather than throwing.
    expect(rewriteExclusionConstraint('EXCLUDE (a WITH =) INCLUDE (x').rewritten).toBe(true);
    expect(rewriteExclusionConstraint('EXCLUDE (a WITH =) WITH (fillfactor').rewritten).toBe(true);
    expect(rewriteExclusionConstraint('EXCLUDE (a WITH =) WHERE (active').rewritten).toBe(true);
  });
});
