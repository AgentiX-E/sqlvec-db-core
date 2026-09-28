import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectDataMasking,
  rewriteDataMasking,
  isMaskingEnabled,
  getDefaultFunction,
  getMaskingPolicies,
  clearMaskingPolicies,
  maskPartial,
  maskFull,
  maskEmail,
  applyMask,
  selectHasMasking,
  getMaskedColumnSql,
} from '../query/DataMaskingShim';

describe('DataMaskingShim', () => {
  beforeEach(() => {
    // Reset module state to a deterministic baseline before each test.
    rewriteDataMasking('SET masking.enabled = off');
    rewriteDataMasking("SET masking.default_function = 'partial(1,***,1)'");
    clearMaskingPolicies();
  });

  describe('maskPartial', () => {
    it('masks the middle, revealing prefix and suffix', () => {
      expect(maskPartial('abcdef', 1, '***', 1)).toBe('a***f');
    });
    it('handles a prefix longer than the value', () => {
      expect(maskPartial('abc', 5, '***', 1)).toBe('abc***');
    });
    it('preserves empty and non-string input', () => {
      expect(maskPartial('', 1, '***', 1)).toBe('');
      expect(maskPartial(123 as any, 1, '***', 1)).toBe(123);
    });
  });

  describe('maskFull', () => {
    it('replaces every character with a star', () => {
      expect(maskFull('sensitive')).toBe('*********');
      expect(maskFull('ab')).toBe('**');
    });
    it('preserves empty and non-string input', () => {
      expect(maskFull('')).toBe('');
      expect(maskFull(123 as any)).toBe(123);
    });
  });

  describe('maskEmail', () => {
    it('reveals only the first local character and the domain', () => {
      expect(maskEmail('user@example.com')).toBe('u***@example.com');
    });
    it('handles a single-character local part', () => {
      expect(maskEmail('a@b.com')).toBe('a***@b.com');
    });
    it('handles an empty local part', () => {
      expect(maskEmail('@domain.com')).toBe('***@domain.com');
    });
    it('returns the value unchanged when there is no @', () => {
      expect(maskEmail('noemail')).toBe('noemail');
      expect(maskEmail(123 as any)).toBe(123);
    });
  });

  describe('applyMask', () => {
    const policy = (fn: any, params: string[]) => ({
      table: 't', column: 'c', function: fn as any, params,
    });
    it('applies partial masking with explicit prefix/suffix', () => {
      expect(applyMask('abcdef', policy('partial', ['2', '***', '1']))).toBe('ab***f');
    });
    it('uses defaults when params are missing', () => {
      expect(applyMask('abcdef', policy('partial', []))).toBe('a***f');
    });
    it('honours a zero prefix (no leading reveal)', () => {
      expect(applyMask('abcdef', policy('partial', ['0', '***', '1']))).toBe('***f');
    });
    it('honours a zero suffix (no trailing reveal)', () => {
      expect(applyMask('abcdef', policy('partial', ['1', '***', '0']))).toBe('a***');
    });
    it('applies full masking', () => {
      expect(applyMask('abc', policy('full', []))).toBe('***');
    });
    it('applies email masking', () => {
      expect(applyMask('a@b.com', policy('email', []))).toBe('a***@b.com');
    });
    it('falls back to full masking for custom and unknown functions', () => {
      expect(applyMask('abc', policy('custom', []))).toBe('***');
      expect(applyMask('abc', policy('weird', []))).toBe('***');
    });
  });

  describe('detectDataMasking', () => {
    it('detects each supported masking statement', () => {
      expect(detectDataMasking("ALTER TABLE t ALTER COLUMN c SET MASKED WITH (FUNCTION = 'partial(1,***,1)')")).toBe(true);
      expect(detectDataMasking('ALTER TABLE t ALTER COLUMN c DROP MASKED')).toBe(true);
      expect(detectDataMasking('SET masking.enabled = on')).toBe(true);
      expect(detectDataMasking('SET masking.default_function = \'full\'')).toBe(true);
      expect(detectDataMasking('SHOW masking.enabled')).toBe(true);
      expect(detectDataMasking('SHOW masking.default_function')).toBe(true);
      expect(detectDataMasking("CREATE MASKING POLICY p AS (c text) USING 'full'")).toBe(true);
      expect(detectDataMasking('DROP MASKING POLICY p')).toBe(true);
    });
    it('rejects non-masking SQL', () => {
      expect(detectDataMasking('SELECT * FROM users')).toBe(false);
      expect(detectDataMasking('CREATE INDEX i ON t (c)')).toBe(false);
      expect(detectDataMasking('SELECT \'MASKED\' FROM t')).toBe(false);
    });
    it('rejects empty and non-string input', () => {
      expect(detectDataMasking('')).toBe(false);
      expect(detectDataMasking('   ')).toBe(false);
      expect(detectDataMasking(null as any)).toBe(false);
      expect(detectDataMasking(42 as any)).toBe(false);
    });
  });

  describe('rewriteDataMasking — SET enabled', () => {
    it('updates state with = on / = off', () => {
      expect(rewriteDataMasking('SET masking.enabled = on')).toEqual({
        sql: 'SELECT 1', rewritten: true, category: 'SET masking.enabled',
      });
      expect(isMaskingEnabled()).toBe(true);
      rewriteDataMasking('SET masking.enabled = off');
      expect(isMaskingEnabled()).toBe(false);
    });
    it('updates state with TO on (bugfix)', () => {
      const r = rewriteDataMasking('SET masking.enabled TO on');
      expect(r.rewritten).toBe(true);
      expect(isMaskingEnabled()).toBe(true);
    });
    it('accepts true / 1 as truthy', () => {
      rewriteDataMasking('SET masking.enabled = true');
      expect(isMaskingEnabled()).toBe(true);
      rewriteDataMasking('SET masking.enabled = 1');
      expect(isMaskingEnabled()).toBe(true);
      rewriteDataMasking('SET masking.enabled = off');
      expect(isMaskingEnabled()).toBe(false);
    });
  });

  describe('rewriteDataMasking — SET default function', () => {
    it('stores a new default function', () => {
      const r = rewriteDataMasking("SET masking.default_function = 'full'");
      expect(r.rewritten).toBe(true);
      expect(getDefaultFunction()).toBe('full');
    });
    it('stores via TO syntax', () => {
      rewriteDataMasking("SET masking.default_function TO 'email'");
      expect(getDefaultFunction()).toBe('email');
    });
    it('stores via a double-quoted value (bugfix)', () => {
      const r = rewriteDataMasking('SET masking.default_function = "full"');
      expect(r.rewritten).toBe(true);
      expect(getDefaultFunction()).toBe('full');
    });
  });

  describe('rewriteDataMasking — SHOW', () => {
    it('returns the real enabled state', () => {
      rewriteDataMasking('SET masking.enabled = on');
      expect(rewriteDataMasking('SHOW masking.enabled').sql).toBe("SELECT 'on'");
      rewriteDataMasking('SET masking.enabled = off');
      expect(rewriteDataMasking('SHOW masking.enabled').sql).toBe("SELECT 'off'");
    });
    it('returns the stored default function', () => {
      rewriteDataMasking("SET masking.default_function = 'partial(1,***,1)'");
      expect(rewriteDataMasking('SHOW masking.default_function').sql).toBe("SELECT 'partial(1,***,1)'");
    });
    it('escapes quotes in the default function', () => {
      rewriteDataMasking("SET masking.default_function = 'it''s'");
      expect(getDefaultFunction()).toBe("it's");
      expect(rewriteDataMasking('SHOW masking.default_function').sql).toBe("SELECT 'it''s'");
    });
  });

  describe('rewriteDataMasking — CREATE / DROP policy', () => {
    it('stores a policy with parsed params (bugfix)', () => {
      rewriteDataMasking("CREATE MASKING POLICY p AS (c int) USING 'partial(2,###,3)'");
      const p = getMaskingPolicies().get('p');
      expect(p?.function).toBe('partial');
      expect(p?.params).toEqual(['2', '###', '3']);
    });
    it('stores a full policy', () => {
      rewriteDataMasking("CREATE MASKING POLICY p AS (c text) USING 'full'");
      expect(getMaskingPolicies().get('p')?.function).toBe('full');
    });
    it('classifies email and custom function types', () => {
      rewriteDataMasking("CREATE MASKING POLICY e AS (c text) USING 'email'");
      expect(getMaskingPolicies().get('e')?.function).toBe('email');
      rewriteDataMasking("CREATE MASKING POLICY x AS (c text) USING 'custom(1)'");
      expect(getMaskingPolicies().get('x')?.function).toBe('custom');
    });
    it('falls back to the default function on an empty USING expression', () => {
      // `USING ''` has no parseable function expression, so the parser falls
      // back to the stored default function.
      rewriteDataMasking("CREATE MASKING POLICY p AS (c int) USING ''");
      const p = getMaskingPolicies().get('p');
      expect(p?.function).toBe('partial');
      expect(p?.params).toEqual(['1', '***', '1']);
    });
    it('classifies ALTER SET MASKED email and custom types', () => {
      rewriteDataMasking("ALTER TABLE t ALTER COLUMN c SET MASKED WITH (FUNCTION = 'email')");
      expect(getMaskingPolicies().get('t.c')?.function).toBe('email');
      rewriteDataMasking("ALTER TABLE t ALTER COLUMN d SET MASKED WITH (FUNCTION = 'weird(1)')");
      expect(getMaskingPolicies().get('t.d')?.function).toBe('custom');
    });
    it('drops a stored policy', () => {
      rewriteDataMasking("CREATE MASKING POLICY p AS (c text) USING 'full'");
      expect(getMaskingPolicies().has('p')).toBe(true);
      rewriteDataMasking('DROP MASKING POLICY p');
      expect(getMaskingPolicies().has('p')).toBe(false);
    });
    it('drops with IF EXISTS', () => {
      rewriteDataMasking("CREATE MASKING POLICY p AS (c text) USING 'full'");
      rewriteDataMasking('DROP MASKING POLICY IF EXISTS p');
      expect(getMaskingPolicies().has('p')).toBe(false);
    });
  });

  describe('rewriteDataMasking — ALTER SET/DROP MASKED', () => {
    it('stores a column-level policy with params', () => {
      rewriteDataMasking("ALTER TABLE users ALTER COLUMN ssn SET MASKED WITH (FUNCTION = 'partial(1,***,1)')");
      const p = getMaskingPolicies().get('users.ssn');
      expect(p?.table).toBe('users');
      expect(p?.column).toBe('ssn');
      expect(p?.function).toBe('partial');
      expect(p?.params).toEqual(['1', '***', '1']);
    });
    it('removes a column-level policy on DROP MASKED', () => {
      rewriteDataMasking("ALTER TABLE users ALTER COLUMN ssn SET MASKED WITH (FUNCTION = 'full')");
      expect(getMaskingPolicies().has('users.ssn')).toBe(true);
      rewriteDataMasking('ALTER TABLE users ALTER COLUMN ssn DROP MASKED');
      expect(getMaskingPolicies().has('users.ssn')).toBe(false);
    });
    it('falls back to the default function when WITH clause omits FUNCTION', () => {
      // `WITH (FOO = ...)` matches the loose `\(.*?\)` pattern but has no
      // FUNCTION assignment, so the parser falls back to the stored default.
      rewriteDataMasking("ALTER TABLE t ALTER COLUMN c SET MASKED WITH (FOO = 'bar')");
      const p = getMaskingPolicies().get('t.c');
      expect(p?.function).toBe('partial');
      expect(p?.params).toEqual(['1', '***', '1']);
    });
    it('skips storage for an empty table identifier', () => {
      // `ALTER TABLE ""` yields an empty table name after quote stripping, so
      // the guarded `if (tbl && col)` should skip policy storage.
      rewriteDataMasking("ALTER TABLE \"\" ALTER COLUMN c SET MASKED WITH (FUNCTION = 'full')");
      expect(getMaskingPolicies().size).toBe(0);
    });
    it('skips DROP MASKED removal for an empty column identifier', () => {
      rewriteDataMasking("ALTER TABLE \"\" ALTER COLUMN c DROP MASKED");
      expect(getMaskingPolicies().size).toBe(0);
    });
  });

  describe('rewriteDataMasking — passthrough & rejection', () => {
    it('passthroughs non-masking SQL unchanged', () => {
      expect(rewriteDataMasking('SELECT * FROM users')).toEqual({
        sql: 'SELECT * FROM users', rewritten: false,
      });
    });
    it('handles empty / non-string input', () => {
      expect(rewriteDataMasking('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteDataMasking(null as any)).toEqual({ sql: '', rewritten: false });
    });
    it('warns on matched-prefix but unknown masking statement', () => {
      expect(rewriteDataMasking('SET masking.foo = 1')).toEqual({
        sql: 'SET masking.foo = 1', rewritten: false,
      });
    });
  });

  describe('selectHasMasking / getMaskedColumnSql', () => {
    it('returns false when masking is disabled', () => {
      rewriteDataMasking("ALTER TABLE users ALTER COLUMN ssn SET MASKED WITH (FUNCTION = 'full')");
      expect(selectHasMasking('users', 'ssn')).toBe(false);
      expect(getMaskedColumnSql('users', 'ssn')).toBeNull();
    });
    it('returns the mask wrapper when enabled and a policy exists', () => {
      rewriteDataMasking('SET masking.enabled = on');
      rewriteDataMasking("ALTER TABLE users ALTER COLUMN ssn SET MASKED WITH (FUNCTION = 'full')");
      expect(selectHasMasking('users', 'ssn')).toBe(true);
      expect(getMaskedColumnSql('users', 'ssn')).toBe('mask_full(ssn)');
    });
    it('returns partial wrapper with params', () => {
      rewriteDataMasking('SET masking.enabled = on');
      rewriteDataMasking("ALTER TABLE users ALTER COLUMN ssn SET MASKED WITH (FUNCTION = 'partial(2,***,3)')");
      expect(getMaskedColumnSql('users', 'ssn')).toBe("mask_partial(ssn, 2, '***', 3)");
    });
    it('returns null for unknown column', () => {
      rewriteDataMasking('SET masking.enabled = on');
      expect(getMaskedColumnSql('users', 'missing')).toBeNull();
    });
    it('returns email / custom wrappers', () => {
      rewriteDataMasking('SET masking.enabled = on');
      rewriteDataMasking("ALTER TABLE t ALTER COLUMN e SET MASKED WITH (FUNCTION = 'email')");
      expect(getMaskedColumnSql('t', 'e')).toBe('mask_email(e)');
      rewriteDataMasking("ALTER TABLE t ALTER COLUMN f SET MASKED WITH (FUNCTION = 'weird(1)')");
      expect(getMaskedColumnSql('t', 'f')).toBe('mask_full(f)');
    });
    it('uses default params when a partial policy has none', () => {
      rewriteDataMasking('SET masking.enabled = on');
      // A policy with function 'partial' but no parsed params falls back to defaults.
      getMaskingPolicies().set('t.g', { table: 't', column: 'g', function: 'partial', params: [] });
      expect(getMaskedColumnSql('t', 'g')).toBe("mask_partial(g, 1, '***', 1)");
    });
    it('returns null for an unrecognised function type', () => {
      rewriteDataMasking('SET masking.enabled = on');
      getMaskingPolicies().set('t.x', { table: 't', column: 'x', function: 'bogus' as any, params: [] });
      expect(getMaskedColumnSql('t', 'x')).toBeNull();
    });
  });
});
