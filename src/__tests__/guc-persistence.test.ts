/**
 * GucPersistence unit tests.
 *
 * Verifies PostgreSQL postgresql.conf parsing/formatting semantics: key/value
 * extraction, quoted-string handling, inline comments, unit suffixes, file I/O,
 * and the `pg_reload_conf()` simulation. These tests target real wire-level
 * behavior, including the doubled-single-quote escape rule (`''` → `'`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GucPersistence, pgReloadConf } from '../config/GucPersistence';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guc-'));
  tmpDirs.push(dir);
  return dir;
}

describe('GucPersistence.parseLine', () => {
  let guc: GucPersistence;
  beforeEach(() => { guc = new GucPersistence(makeTmpDir()); });

  it('parses a simple key = value pair', () => {
    expect(guc.parseLine('shared_buffers = 128MB')).toEqual({ key: 'shared_buffers', value: '128MB' });
  });

  it('lowercases the key', () => {
    expect(guc.parseLine('MaxConnections = 100')).toEqual({ key: 'maxconnections', value: '100' });
  });

  it('returns null for empty and whitespace-only lines', () => {
    expect(guc.parseLine('')).toBeNull();
    expect(guc.parseLine('   ')).toBeNull();
    expect(guc.parseLine('\n')).toBeNull();
  });

  it('returns null for full-line comments', () => {
    expect(guc.parseLine('# this is a comment')).toBeNull();
    expect(guc.parseLine('  # indented comment')).toBeNull();
  });

  it('returns null for lines without an equals sign', () => {
    expect(guc.parseLine('just some text')).toBeNull();
  });

  it('returns null for empty keys (e.g. "= value")', () => {
    expect(guc.parseLine('= value')).toBeNull();
  });

  it('strips inline comments respecting the equals position', () => {
    expect(guc.parseLine('port = 5432 # the main port')).toEqual({ key: 'port', value: '5432' });
  });

  it('strips surrounding single quotes from a string value', () => {
    expect(guc.parseLine("log_line_prefix = '%m [%p]'")).toEqual({ key: 'log_line_prefix', value: '%m [%p]' });
  });

  it('keeps a value without quotes as-is', () => {
    expect(guc.parseLine('work_mem = 4MB')).toEqual({ key: 'work_mem', value: '4MB' });
  });

  it('does not strip a lone leading quote (length < 2)', () => {
    // A single quote with length 1 should not be treated as a quoted pair.
    expect(guc.parseLine("x = '")).toEqual({ key: 'x', value: "'" });
  });

  it('unescapes doubled single quotes (PostgreSQL SQL escaping)', () => {
    // The raw value between quotes is `it''s`; must become `it's`.
    expect(guc.parseLine(`search_path = 'it''s value'`)).toEqual({ key: 'search_path', value: "it's value" });
  });

  it('preserves a hash inside single quotes (not treated as comment)', () => {
    expect(guc.parseLine("password = 'pa#ss'")).toEqual({ key: 'password', value: 'pa#ss' });
  });

  it('handles whitespace around the equals sign', () => {
    expect(guc.parseLine('  key   =   value  ')).toEqual({ key: 'key', value: 'value' });
  });

  it('returns an empty value when the remainder is only a comment', () => {
    // `key = # no value` strips to `key = `, yielding an empty value.
    expect(guc.parseLine('key = # no value')).toEqual({ key: 'key', value: '' });
  });
});

describe('GucPersistence.parseConfigFile', () => {
  let guc: GucPersistence;
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); guc = new GucPersistence(dir); });

  it('parses multiple lines and returns a key/value record', () => {
    const file = join(dir, 'postgresql.conf');
    writeFileSync(file, 'max_connections = 100\nwork_mem = 4MB\n# comment\nshared_buffers = 128MB\n');
    expect(guc.parseConfigFile(file)).toEqual({
      max_connections: '100',
      work_mem: '4MB',
      shared_buffers: '128MB',
    });
  });

  it('returns an empty object when the file does not exist', () => {
    expect(guc.parseConfigFile(join(dir, 'missing.conf'))).toEqual({});
  });

  it('last duplicate key wins', () => {
    const file = join(dir, 'dup.conf');
    writeFileSync(file, 'work_mem = 1MB\nwork_mem = 2MB\n');
    expect(guc.parseConfigFile(file)).toEqual({ work_mem: '2MB' });
  });
});

describe('GucPersistence auto.conf I/O', () => {
  let guc: GucPersistence;
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); guc = new GucPersistence(dir); });

  it('readAutoConf returns empty object when no file exists', () => {
    expect(guc.readAutoConf()).toEqual({});
  });

  it('writeAutoConf writes settings and readAutoConf reads them back', () => {
    guc.writeAutoConf({ max_connections: '200', work_mem: '8MB' });
    expect(existsSync(join(dir, 'postgresql.auto.conf'))).toBe(true);
    expect(guc.readAutoConf()).toEqual({ max_connections: '200', work_mem: '8MB' });
  });

  it('writeAutoConf overwrites existing content', () => {
    guc.writeAutoConf({ a: '1' });
    guc.writeAutoConf({ b: '2' });
    expect(guc.readAutoConf()).toEqual({ b: '2' });
  });

  it('updateAutoConf merges new settings (overwrite=true replaces)', () => {
    guc.writeAutoConf({ keep: 'old', shared: 'x' });
    guc.updateAutoConf({ keep: 'new' }, true);
    expect(guc.readAutoConf()).toEqual({ keep: 'new', shared: 'x' });
  });

  it('updateAutoConf with overwrite=false only adds missing keys', () => {
    guc.writeAutoConf({ keep: 'old' });
    guc.updateAutoConf({ keep: 'ignored', added: 'yes' }, false);
    const read = guc.readAutoConf();
    expect(read.keep).toBe('old');
    expect(read.added).toBe('yes');
  });

  it('writeAutoConf creates the parent directory when missing', () => {
    const nested = new GucPersistence(join(dir, 'deep', 'nested', 'data'));
    nested.writeAutoConf({ a: '1' });
    expect(existsSync(join(dir, 'deep', 'nested', 'data', 'postgresql.auto.conf'))).toBe(true);
  });

  it('writeAutoConf throws when the path cannot be written', () => {
    // Point the baseDir at a *file* so that postgresql.auto.conf resolves to a
    // path whose parent is a regular file, making writeFileSync fail.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const bad = new GucPersistence(join(blocker, 'sub'));
    expect(() => bad.writeAutoConf({ a: '1' })).toThrow(/Cannot write/);
  });
});

describe('GucPersistence.formatAsConfig', () => {
  let guc: GucPersistence;
  beforeEach(() => { guc = new GucPersistence(makeTmpDir()); });

  it('writes a header and one `key = value` per line', () => {
    const text = guc.formatAsConfig({ a: '1', b: '2' });
    expect(text).toContain('# Generated by SqlVec DB GucPersistence');
    expect(text).toContain('a = 1');
    expect(text).toContain('b = 2');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('quotes string values with spaces', () => {
    const text = guc.formatAsConfig({ log_line_prefix: '%m [%p]' });
    expect(text).toContain("log_line_prefix = '%m [%p]'");
  });

  it('escapes single quotes inside quoted values', () => {
    const text = guc.formatAsConfig({ pwd: "it's" });
    expect(text).toContain("pwd = 'it''s'");
  });

  it('does not quote numeric, boolean, or unit-suffixed values', () => {
    const text = guc.formatAsConfig({ a: '128MB', b: 'true', c: '42', d: 'on' });
    expect(text).toContain('a = 128MB');
    expect(text).toContain('b = true');
    expect(text).toContain('c = 42');
    expect(text).toContain('d = on');
  });

  it('quotes empty values', () => {
    const text = guc.formatAsConfig({ empty: '' });
    expect(text).toContain("empty = ''");
  });

  it('leaves already-quoted values untouched', () => {
    const text = guc.formatAsConfig({ pre: "'already quoted'" });
    expect(text).toContain("pre = 'already quoted'");
  });

  it('quotes values with spaces and special characters as needed', () => {
    const text = guc.formatAsConfig({ with_space: 'a b' });
    expect(text).toContain("with_space = 'a b'");
  });
});

describe('pgReloadConf', () => {
  it('applies settings via gucSystem.handleSet (counting applied/skipped)', async () => {
    const handleSet = (name: string, value: string) => {
      // Return null to signal "applied" for known keys, string otherwise.
      return name === 'known' ? null : 'unrecognized';
    };
    const db = { gucSystem: { handleSet } };
    const ok = await pgReloadConf(db, { known: '1', unknown: '2' });
    expect(ok).toBe(true);
  });

  it('applies settings via exec when no gucSystem is present', async () => {
    const calls: string[] = [];
    const db = { exec: async (sql: string) => { calls.push(sql); } };
    const ok = await pgReloadConf(db, { work_mem: '4MB' });
    expect(ok).toBe(true);
    expect(calls).toContain("SET work_mem = '4MB'");
  });

  it('escapes single quotes in the SET path', async () => {
    const calls: string[] = [];
    const db = { exec: async (sql: string) => { calls.push(sql); } };
    await pgReloadConf(db, { pwd: "it's" });
    expect(calls).toContain("SET pwd = 'it''s'");
  });

  it('counts failures in the exec path as skipped but still returns true', async () => {
    const db = { exec: async () => { throw new Error('SET failed'); } };
    const ok = await pgReloadConf(db, { bad: '1' });
    expect(ok).toBe(true);
  });

  it('returns false when neither gucSystem nor exec is available', async () => {
    const ok = await pgReloadConf({}, { a: '1' });
    expect(ok).toBe(false);
  });
});

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});
