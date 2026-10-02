import { describe, it, expect } from 'vitest';
import {
  rewriteViewSql,
  detectPgViewSyntax,
  detectCheckOption,
  isSimpleView,
  extractSimpleViewInfo,
  prefixWhereWithNew,
  buildCheckOptionTriggers,
  buildDropCheckTriggerSql,
  expandViewInSql,
} from '../query/ViewShim';

describe('ViewShim', () => {
  describe('detectPgViewSyntax', () => {
    it('detects OR REPLACE', () => {
      expect(detectPgViewSyntax('CREATE OR REPLACE VIEW v AS SELECT 1')).toBe(true);
    });
    it('detects RECURSIVE', () => {
      expect(detectPgViewSyntax('CREATE RECURSIVE VIEW v AS SELECT 1')).toBe(true);
    });
    it('returns false for plain CREATE VIEW', () => {
      expect(detectPgViewSyntax('CREATE VIEW v AS SELECT 1')).toBe(false);
    });
    it('returns false for non-string / empty', () => {
      expect(detectPgViewSyntax('')).toBe(false);
      expect(detectPgViewSyntax(undefined as unknown as string)).toBe(false);
    });
  });

  describe('rewriteViewSql', () => {
    it('rewrites OR REPLACE to IF NOT EXISTS', () => {
      expect(rewriteViewSql('CREATE OR REPLACE VIEW v AS SELECT 1')).toEqual({
        sql: 'CREATE VIEW IF NOT EXISTS v AS SELECT 1',
        rewritten: true,
      });
    });
    it('preserves the column list in OR REPLACE', () => {
      const r = rewriteViewSql('CREATE OR REPLACE VIEW v (a,b) AS SELECT a,b FROM t');
      expect(r.sql).toBe('CREATE VIEW IF NOT EXISTS v (a,b) AS SELECT a,b FROM t');
    });
    it('removes RECURSIVE', () => {
      expect(rewriteViewSql('CREATE RECURSIVE VIEW v AS SELECT 1').sql).toBe(
        'CREATE VIEW v AS SELECT 1',
      );
    });
    it('removes RECURSIVE with a column list', () => {
      expect(rewriteViewSql('CREATE RECURSIVE VIEW v (a,b) AS SELECT 1,2').sql).toBe(
        'CREATE VIEW v (a,b) AS SELECT 1,2',
      );
    });
    it('strips CHECK OPTION from TEMP VIEW', () => {
      const r = rewriteViewSql('CREATE TEMP VIEW v AS SELECT * FROM t WHERE x>0 WITH CHECK OPTION');
      expect(r.sql).toContain('CREATE TEMP VIEW v');
      expect(r.sql).not.toContain('CHECK OPTION');
    });
    it('strips CHECK OPTION from TEMPORARY VIEW', () => {
      const r = rewriteViewSql(
        'CREATE TEMPORARY VIEW v AS SELECT * FROM t WHERE x>0 WITH CHECK OPTION',
      );
      expect(r.sql).toContain('CREATE TEMPORARY VIEW v');
      expect(r.sql).not.toContain('CHECK OPTION');
    });
    it('passes through plain CREATE VIEW', () => {
      expect(rewriteViewSql('CREATE VIEW v AS SELECT 1')).toEqual({
        sql: 'CREATE VIEW v AS SELECT 1',
        rewritten: false,
      });
    });
    it('passes through TEMP VIEW unchanged', () => {
      expect(rewriteViewSql('CREATE TEMP VIEW v AS SELECT 1').rewritten).toBe(false);
    });
    it('handles null / non-string', () => {
      expect(rewriteViewSql('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteViewSql(undefined as unknown as string).rewritten).toBe(false);
    });
    it('passes through an incomplete CREATE VIEW', () => {
      expect(rewriteViewSql('CREATE VIEW').rewritten).toBe(false);
      expect(rewriteViewSql('CREATE VIEW v AS').rewritten).toBe(false);
    });
    it('passes through a non-view statement', () => {
      expect(rewriteViewSql('SELECT 1').rewritten).toBe(false);
    });

    describe('quoted identifiers (BUG #441)', () => {
      it('rewrites OR REPLACE with a quoted view name', () => {
        expect(rewriteViewSql('CREATE OR REPLACE VIEW "My View" AS SELECT 1').sql).toBe(
          'CREATE VIEW IF NOT EXISTS "My View" AS SELECT 1',
        );
      });
      it('rewrites RECURSIVE with a quoted view name', () => {
        expect(rewriteViewSql('CREATE RECURSIVE VIEW "my v" AS SELECT 1').sql).toBe(
          'CREATE VIEW "my v" AS SELECT 1',
        );
      });
      it('handles the "" escape inside a quoted name', () => {
        expect(rewriteViewSql('CREATE OR REPLACE VIEW "weird""name" AS SELECT 1').sql).toBe(
          'CREATE VIEW IF NOT EXISTS "weird""name" AS SELECT 1',
        );
      });
      it('handles schema-qualified quoted names', () => {
        expect(rewriteViewSql('CREATE OR REPLACE VIEW s."My View" AS SELECT 1').sql).toBe(
          'CREATE VIEW IF NOT EXISTS s."My View" AS SELECT 1',
        );
        expect(rewriteViewSql('CREATE OR REPLACE VIEW "sch"."my v" AS SELECT 1').sql).toBe(
          'CREATE VIEW IF NOT EXISTS "sch"."my v" AS SELECT 1',
        );
      });
    });
  });

  describe('CHECK OPTION', () => {
    it('detects and strips CHECK OPTION with triggers', () => {
      const r = rewriteViewSql('CREATE VIEW v AS SELECT * FROM t WHERE x > 0 WITH CHECK OPTION');
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe('CREATE VIEW v AS SELECT * FROM t WHERE x > 0');
      expect(r.checkOptionTriggers).toHaveLength(2);
    });
    it('strips LOCAL CHECK OPTION', () => {
      const r = rewriteViewSql(
        'CREATE VIEW v AS SELECT * FROM t WHERE x > 0 WITH LOCAL CHECK OPTION',
      );
      expect(r.sql).toContain('WHERE x > 0');
      expect(r.sql).not.toContain('CHECK OPTION');
    });
    it('throws for CHECK OPTION on a non-simple view', () => {
      expect(() =>
        rewriteViewSql('CREATE VIEW v AS SELECT 1 WITH CHECK OPTION'),
      ).toThrow(/CHECK OPTION only supported/);
    });
    it('strips CHECK OPTION without triggers when there is no WHERE clause', () => {
      const r = rewriteViewSql('CREATE VIEW v AS SELECT * FROM t WITH CHECK OPTION');
      expect(r.sql).toBe('CREATE VIEW v AS SELECT * FROM t');
      expect(r.checkOptionTriggers).toBeUndefined();
    });
    it('strips CHECK OPTION from RECURSIVE view with triggers', () => {
      const r = rewriteViewSql(
        'CREATE RECURSIVE VIEW v AS SELECT * FROM t WHERE x>0 WITH CHECK OPTION',
      );
      expect(r.sql).toBe('CREATE VIEW v AS SELECT * FROM t WHERE x>0');
      expect(r.checkOptionTriggers).toHaveLength(2);
    });
    it('strips CHECK OPTION from OR REPLACE without triggers when no WHERE', () => {
      const r = rewriteViewSql('CREATE OR REPLACE VIEW v AS SELECT * FROM t WITH CHECK OPTION');
      expect(r.sql).toBe('CREATE VIEW IF NOT EXISTS v AS SELECT * FROM t');
      expect(r.checkOptionTriggers).toBeUndefined();
    });
    it('strips CHECK OPTION from OR REPLACE with triggers when WHERE present', () => {
      const r = rewriteViewSql(
        'CREATE OR REPLACE VIEW v AS SELECT * FROM t WHERE x>0 WITH CHECK OPTION',
      );
      expect(r.sql).toBe('CREATE VIEW IF NOT EXISTS v AS SELECT * FROM t WHERE x>0');
      expect(r.checkOptionTriggers).toHaveLength(2);
    });
    it('does not mistake a string literal for CHECK OPTION (BUG #440)', () => {
      const r = rewriteViewSql("CREATE VIEW v AS SELECT 'WITH CHECK OPTION'");
      expect(r.rewritten).toBe(false);
      expect(r.sql).toContain("'WITH CHECK OPTION'");
    });
    it('does not mistake a comment for CHECK OPTION (BUG #440)', () => {
      const r = rewriteViewSql('CREATE VIEW v AS SELECT 1 -- WITH CHECK OPTION\n');
      expect(r.sql).toContain('-- WITH CHECK OPTION');
    });
  });

  describe('detectCheckOption', () => {
    it('returns false for a string literal containing CHECK OPTION', () => {
      expect(detectCheckOption("CREATE VIEW v AS SELECT 'WITH CHECK OPTION'").hasCheckOption).toBe(
        false,
      );
    });
    it('returns false for a comment containing CHECK OPTION', () => {
      expect(
        detectCheckOption('CREATE VIEW v AS SELECT 1 -- WITH CHECK OPTION\n').hasCheckOption,
      ).toBe(false);
    });
    it('returns true for real CHECK OPTION', () => {
      expect(
        detectCheckOption('CREATE VIEW v AS SELECT * FROM t WHERE x > 0 WITH CHECK OPTION')
          .hasCheckOption,
      ).toBe(true);
    });
    it('returns empty info for non-string', () => {
      const r = detectCheckOption('');
      expect(r.hasCheckOption).toBe(false);
    });
    it('returns empty info for non-CREATE-VIEW input', () => {
      const r = detectCheckOption('SELECT 1');
      expect(r.hasCheckOption).toBe(false);
      expect(r.viewName).toBe('');
    });
  });

  describe('isSimpleView', () => {
    it('accepts a simple single-table SELECT', () => {
      expect(isSimpleView('SELECT * FROM t WHERE x > 0')).toBe(true);
    });
    it('accepts SELECT with ORDER BY and LIMIT', () => {
      expect(isSimpleView('SELECT a FROM t WHERE x > 0 ORDER BY b LIMIT 5')).toBe(true);
    });
    it('rejects JOIN', () => {
      expect(isSimpleView('SELECT * FROM t JOIN u ON t.id = u.id')).toBe(false);
    });
    it('rejects GROUP BY / HAVING', () => {
      expect(isSimpleView('SELECT a, COUNT(*) FROM t GROUP BY a')).toBe(false);
      expect(isSimpleView('SELECT a FROM t HAVING a > 0')).toBe(false);
    });
    it('rejects subqueries / set ops / DISTINCT', () => {
      expect(isSimpleView('SELECT * FROM t WHERE a IN (SELECT x FROM y)')).toBe(false);
      expect(isSimpleView('SELECT a FROM t UNION SELECT a FROM u')).toBe(false);
      expect(isSimpleView('SELECT DISTINCT a FROM t')).toBe(false);
    });
    it('rejects INTERSECT / EXCEPT', () => {
      expect(isSimpleView('SELECT a FROM t INTERSECT SELECT a FROM u')).toBe(false);
      expect(isSimpleView('SELECT a FROM t EXCEPT SELECT a FROM u')).toBe(false);
    });
    it('rejects a non-SELECT body', () => {
      expect(isSimpleView('DELETE FROM t')).toBe(false);
      expect(isSimpleView('VALUES (1)')).toBe(false);
    });
    it('does not mistake a keyword in a comment for a structural clause (BUG #442)', () => {
      expect(isSimpleView('SELECT * FROM t -- JOIN u\n')).toBe(true);
      expect(isSimpleView("SELECT * FROM t WHERE x = 'JOIN'")).toBe(true);
    });
  });

  describe('extractSimpleViewInfo', () => {
    it('extracts table and WHERE', () => {
      expect(extractSimpleViewInfo("SELECT * FROM users WHERE status = 'active'")).toEqual({
        tableName: 'users',
        whereCondition: "status = 'active'",
      });
    });
    it('extracts a schema-qualified table', () => {
      expect(extractSimpleViewInfo('SELECT * FROM s.t WHERE a > 0')).toEqual({
        tableName: 's.t',
        whereCondition: 'a > 0',
      });
    });
    it('stops WHERE at ORDER BY', () => {
      expect(extractSimpleViewInfo('SELECT * FROM t WHERE a > 0 ORDER BY b')).toEqual({
        tableName: 't',
        whereCondition: 'a > 0',
      });
    });
    it('returns empty where when no WHERE clause', () => {
      expect(extractSimpleViewInfo('SELECT * FROM t')).toEqual({
        tableName: 't',
        whereCondition: '',
      });
    });
    it('returns null when no FROM', () => {
      expect(extractSimpleViewInfo('SELECT 1')).toBeNull();
    });
  });

  describe('prefixWhereWithNew', () => {
    it('prefixes plain columns and leaves keywords', () => {
      expect(prefixWhereWithNew('x > 0 AND y IS NOT NULL')).toBe(
        'NEW.x > 0 AND NEW.y IS NOT NULL',
      );
    });
    it('does not prefix function call names (BUG #437)', () => {
      expect(prefixWhereWithNew("upper(a) = 'CHECK'")).toBe("upper(NEW.a) = 'CHECK'");
      expect(prefixWhereWithNew('length(trim(x)) > 0')).toBe('length(trim(NEW.x)) > 0');
      expect(prefixWhereWithNew('coalesce(a, b) > 0')).toBe('coalesce(NEW.a, NEW.b) > 0');
    });
    it('does not prefix CAST type names (BUG #439)', () => {
      expect(prefixWhereWithNew("CAST(x AS TEXT) = 'foo'")).toBe("CAST(NEW.x AS TEXT) = 'foo'");
    });
    it('handles IN lists', () => {
      expect(prefixWhereWithNew('x IN (1,2,3) AND y = 5')).toBe('NEW.x IN (1,2,3) AND NEW.y = 5');
    });
    it('skips qualified names', () => {
      expect(prefixWhereWithNew('t.x > 0')).toBe('t.x > 0');
    });
    it('handles numeric literals', () => {
      expect(prefixWhereWithNew('x > 10.5')).toBe('NEW.x > 10.5');
    });
    it('handles an unterminated string literal', () => {
      expect(prefixWhereWithNew("x = 'unterminated")).toBe("NEW.x = 'unterminated");
    });
    it('returns empty for empty input', () => {
      expect(prefixWhereWithNew('')).toBe('');
      expect(prefixWhereWithNew('   ')).toBe('');
    });
  });

  describe('buildCheckOptionTriggers / buildDropCheckTriggerSql', () => {
    it('builds INSERT and UPDATE triggers', () => {
      const tr = buildCheckOptionTriggers('v', 't', 'x > 0');
      expect(tr).toHaveLength(2);
      expect(tr[0]).toContain('AFTER INSERT ON t');
      expect(tr[0]).toContain('WHERE NOT (NEW.x > 0)');
      expect(tr[1]).toContain('AFTER UPDATE ON t');
    });
    it('builds drop trigger SQL', () => {
      const d = buildDropCheckTriggerSql('my view');
      expect(d).toHaveLength(2);
      expect(d[0]).toContain('_sqlvec_check_my_view_insert');
    });
    it('builds no triggers for an empty condition', () => {
      expect(buildCheckOptionTriggers('v', 't', '')).toHaveLength(0);
    });
    it('builds no triggers for a blank condition', () => {
      expect(buildCheckOptionTriggers('v', 't', '   ')).toHaveLength(0);
    });
  });

  describe('expandViewInSql', () => {
    it('expands a registered view in FROM', () => {
      const r = expandViewInSql('SELECT * FROM users', (n) =>
        n === 'users' ? 'SELECT * FROM u WHERE a=1' : null,
      );
      expect(r).toBe('SELECT * FROM (SELECT * FROM u WHERE a=1) AS users');
    });
    it('expands a registered view in JOIN', () => {
      const r = expandViewInSql('SELECT * FROM a JOIN users ON 1', (n) =>
        n === 'users' ? 'SELECT 1' : null,
      );
      expect(r).toBe('SELECT * FROM a JOIN (SELECT 1) AS users ON 1');
    });
    it('leaves unregistered names intact', () => {
      expect(expandViewInSql('SELECT * FROM t', () => null)).toBe('SELECT * FROM t');
    });
    it('passes through DDL statements', () => {
      expect(expandViewInSql('CREATE TABLE t (a INT)', () => 'SELECT 1')).toBe(
        'CREATE TABLE t (a INT)',
      );
    });
    it('passes through non-SELECT statements', () => {
      expect(expandViewInSql('INSERT INTO t VALUES (1)', () => 'SELECT 1')).toBe(
        'INSERT INTO t VALUES (1)',
      );
    });
    it('does not rewrite FROM inside a string literal (BUG #438)', () => {
      const r = expandViewInSql("SELECT * FROM t WHERE x = 'FROM users'", (n) =>
        n === 'users' ? 'SELECT 1' : null,
      );
      expect(r).toBe("SELECT * FROM t WHERE x = 'FROM users'");
    });
    it('does not rewrite JOIN inside a string literal (BUG #438)', () => {
      const r = expandViewInSql("SELECT ' JOIN users '", (n) =>
        n === 'users' ? 'SELECT 1' : null,
      );
      expect(r).toBe("SELECT ' JOIN users '");
    });
    it('handles null / non-string', () => {
      expect(expandViewInSql('', () => null)).toBe('');
      expect(expandViewInSql(undefined as unknown as string, () => null)).toBe('');
      expect(expandViewInSql(null as unknown as string, () => null)).toBe('');
    });
    it('does not expand a FROM subquery (no identifier follows)', () => {
      const r = expandViewInSql('SELECT * FROM (SELECT 1)', () => 'SELECT 1');
      expect(r).toBe('SELECT * FROM (SELECT 1)');
    });
    it('does not expand FROM immediately followed by a paren', () => {
      // No whitespace between FROM and the paren: `FROM(users)` is not a bare
      // table reference, so it is left as-is.
      const r = expandViewInSql('SELECT * FROM(users)', (n) => (n === 'users' ? 'SELECT 1' : null));
      expect(r).toBe('SELECT * FROM(users)');
    });
  });
});
