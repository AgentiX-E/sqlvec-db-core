import { describe, it, expect } from 'vitest';
import { hasForUpdate, parseForUpdate, stripForUpdate } from '../query/ForUpdateShim';

describe('hasForUpdate', () => {
  it('returns false for non-string or empty input', () => {
    expect(hasForUpdate('')).toBe(false);
    expect(hasForUpdate('   ')).toBe(false);
    expect(hasForUpdate(null as any)).toBe(false);
    expect(hasForUpdate(undefined as any)).toBe(false);
    expect(hasForUpdate(0 as any)).toBe(false);
  });

  it('detects all four lock strengths', () => {
    expect(hasForUpdate('SELECT * FROM users FOR UPDATE')).toBe(true);
    expect(hasForUpdate('SELECT * FROM users FOR NO KEY UPDATE')).toBe(true);
    expect(hasForUpdate('SELECT * FROM users FOR SHARE')).toBe(true);
    expect(hasForUpdate('SELECT * FROM users FOR KEY SHARE')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(hasForUpdate('select * from users for update')).toBe(true);
  });

  it('does not accept the nonexistent NO KEY SHARE', () => {
    expect(hasForUpdate('SELECT * FROM users FOR NO KEY SHARE')).toBe(false);
  });

  it('returns false for ordinary SELECT', () => {
    expect(hasForUpdate('SELECT * FROM users')).toBe(false);
  });
});

describe('parseForUpdate', () => {
  it('returns null for non-string or empty input', () => {
    expect(parseForUpdate('')).toBe(null);
    expect(parseForUpdate(null as any)).toBe(null);
    expect(parseForUpdate(undefined as any)).toBe(null);
  });

  it('parses plain FOR UPDATE', () => {
    const r = parseForUpdate('SELECT * FROM users FOR UPDATE');
    expect(r).toEqual({
      hasForUpdate: true,
      hasForShare: false,
      hasForNoKeyUpdate: false,
      hasForKeyShare: false,
      lockStrength: 'UPDATE',
      nowait: false,
      skipLocked: false,
      tables: undefined,
    });
  });

  it('parses FOR NO KEY UPDATE', () => {
    const r = parseForUpdate('SELECT * FROM users FOR NO KEY UPDATE');
    expect(r?.lockStrength).toBe('NO_KEY_UPDATE');
    expect(r?.hasForNoKeyUpdate).toBe(true);
    expect(r?.hasForUpdate).toBe(false);
  });

  it('parses FOR SHARE', () => {
    const r = parseForUpdate('SELECT * FROM users FOR SHARE');
    expect(r?.lockStrength).toBe('SHARE');
    expect(r?.hasForShare).toBe(true);
  });

  it('parses FOR KEY SHARE', () => {
    const r = parseForUpdate('SELECT * FROM users FOR KEY SHARE');
    expect(r?.lockStrength).toBe('KEY_SHARE');
    expect(r?.hasForKeyShare).toBe(true);
  });

  it('parses NOWAIT', () => {
    const r = parseForUpdate('SELECT * FROM users FOR UPDATE NOWAIT');
    expect(r?.nowait).toBe(true);
    expect(r?.skipLocked).toBe(false);
  });

  it('parses SKIP LOCKED', () => {
    const r = parseForUpdate('SELECT * FROM users FOR SHARE SKIP LOCKED');
    expect(r?.skipLocked).toBe(true);
    expect(r?.nowait).toBe(false);
  });

  it('parses OF table list', () => {
    const r = parseForUpdate('SELECT * FROM users FOR UPDATE OF t1, t2');
    expect(r?.tables).toEqual(['t1', 't2']);
  });

  it('parses single OF table', () => {
    const r = parseForUpdate('SELECT * FROM users FOR UPDATE OF t1');
    expect(r?.tables).toEqual(['t1']);
  });

  it('is case-insensitive', () => {
    const r = parseForUpdate('select * from users for update nowait');
    expect(r?.lockStrength).toBe('UPDATE');
    expect(r?.nowait).toBe(true);
  });

  it('handles trailing semicolon', () => {
    const r = parseForUpdate('SELECT * FROM users FOR UPDATE;');
    expect(r?.lockStrength).toBe('UPDATE');
  });

  it('handles trailing whitespace', () => {
    const r = parseForUpdate('SELECT * FROM users FOR UPDATE  ');
    expect(r?.lockStrength).toBe('UPDATE');
  });

  it('returns null for ordinary SELECT', () => {
    expect(parseForUpdate('SELECT * FROM users')).toBe(null);
  });

  it('returns null for a non-terminal FOR clause (subquery)', () => {
    expect(parseForUpdate('SELECT * FROM (SELECT * FROM t FOR UPDATE) x')).toBe(null);
  });

  it('returns null for invalid NO KEY SHARE', () => {
    expect(parseForUpdate('SELECT * FROM users FOR NO KEY SHARE')).toBe(null);
  });
});

describe('stripForUpdate', () => {
  it('returns empty string for non-string input', () => {
    expect(stripForUpdate(null as any)).toBe('');
    expect(stripForUpdate(undefined as any)).toBe('');
    expect(stripForUpdate(0 as any)).toBe('');
  });

  it('returns the original string for empty/whitespace input', () => {
    expect(stripForUpdate('')).toBe('');
    expect(stripForUpdate('   ')).toBe('   ');
  });

  it('strips FOR UPDATE', () => {
    expect(stripForUpdate('SELECT * FROM users FOR UPDATE')).toBe('SELECT * FROM users');
  });

  it('strips FOR UPDATE NOWAIT', () => {
    expect(stripForUpdate('SELECT * FROM users FOR UPDATE NOWAIT')).toBe('SELECT * FROM users');
  });

  it('strips FOR UPDATE OF tables', () => {
    expect(stripForUpdate('SELECT * FROM users FOR UPDATE OF t1, t2 NOWAIT')).toBe(
      'SELECT * FROM users',
    );
  });

  it('strips trailing semicolon together with the clause', () => {
    expect(stripForUpdate('SELECT * FROM users FOR UPDATE;')).toBe('SELECT * FROM users');
  });

  it('returns unchanged SQL when no clause present', () => {
    expect(stripForUpdate('SELECT * FROM users')).toBe('SELECT * FROM users');
  });
});
