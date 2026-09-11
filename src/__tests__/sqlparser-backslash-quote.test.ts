import { describe, it, expect, beforeEach } from 'vitest';
import { BackslashQuoteShim } from '../query/BackslashQuoteShim';

// BackslashQuoteShim models the standard_conforming_strings and
// escape_string_warning GUCs and their effect on backslash handling in string
// literals. Per PG semantics, a backslash inside a literal only triggers a
// warning when standard_conforming_strings is ON (backslashes are then literals);
// with OFF they are legitimate escapes and no "non-standard" warning is emitted.
describe('BackslashQuoteShim', () => {
  let shim: BackslashQuoteShim;
  beforeEach(() => {
    shim = new BackslashQuoteShim();
  });

  describe('handleSet', () => {
    it('sets standard_conforming_strings on/off', () => {
      expect(shim.show('standard_conforming_strings')).toBe('on');
      expect(shim.handleSet('SET standard_conforming_strings = off')).toBe(true);
      expect(shim.show('standard_conforming_strings')).toBe('off');
    });

    it('accepts boolean/numeric truthy forms', () => {
      expect(shim.handleSet('SET standard_conforming_strings = 0')).toBe(true);
      expect(shim.show('standard_conforming_strings')).toBe('off');
      expect(shim.handleSet('SET standard_conforming_strings = TRUE')).toBe(true);
      expect(shim.show('standard_conforming_strings')).toBe('on');
    });

    it('sets escape_string_warning on/off', () => {
      expect(shim.handleSet('SET escape_string_warning = off')).toBe(true);
      expect(shim.show('escape_string_warning')).toBe('off');
    });

    it('returns false for an unrelated SET', () => {
      expect(shim.handleSet('SET work_mem = 4MB')).toBe(false);
    });

    it('handles a trailing semicolon', () => {
      expect(shim.handleSet('SET standard_conforming_strings = off;')).toBe(true);
      expect(shim.show('standard_conforming_strings')).toBe('off');
    });

    it('returns false for non-SET statements', () => {
      expect(shim.handleSet('SELECT 1')).toBe(false);
    });
  });

  describe('show', () => {
    it('returns on/off for both known GUCs (case-insensitive)', () => {
      expect(shim.show('STANDARD_CONFORMING_STRINGS')).toBe('on');
      expect(shim.show('escape_string_warning')).toBe('on');
    });

    it('returns undefined for an unknown parameter', () => {
      expect(shim.show('work_mem')).toBeUndefined();
    });
  });

  describe('checkEscapes', () => {
    it('warns on a backslash in a literal when standard_conforming_strings is on', () => {
      const warnings = shim.checkEscapes("SELECT 'O\\'Brien'");
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('non-standard escape sequence');
    });

    it('emits no non-standard warning when standard_conforming_strings is off', () => {
      shim.handleSet('SET standard_conforming_strings = off');
      const warnings = shim.checkEscapes("SELECT 'O\\'Brien'");
      expect(warnings.some((w) => w.includes('non-standard'))).toBe(false);
      expect(warnings.some((w) => w.startsWith('HINT:'))).toBe(true);
    });

    it('returns no warnings when escape_string_warning is off', () => {
      shim.handleSet('SET escape_string_warning = off');
      expect(shim.checkEscapes("SELECT 'O\\'Brien'")).toEqual([]);
    });

    it('returns no warnings when the literal has no backslash', () => {
      expect(shim.checkEscapes("SELECT 'hello'")).toEqual([]);
    });
  });

  describe('getAllSettings / reset', () => {
    it('tracks settings per session', () => {
      shim.handleSet('SET standard_conforming_strings = off', 's1');
      shim.handleSet('SET standard_conforming_strings = on', 's2');
      const all = shim.getAllSettings();
      expect(all['s1'].standardConformingStrings).toBe(false);
      expect(all['s2'].standardConformingStrings).toBe(true);
    });

    it('resets all sessions to defaults', () => {
      shim.handleSet('SET standard_conforming_strings = off', 's1');
      shim.reset();
      expect(shim.getAllSettings()).toEqual({});
      expect(shim.show('standard_conforming_strings', 's1')).toBe('on');
    });
  });
});
