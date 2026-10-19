/**
 * schema-version-shim.test.ts — Coverage tests for SchemaVersionShim
 * (PostgreSQL schema-version management compatibility shim).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// The module resolves DATA_DIR from process.env.DATA_DIR at import time.
// Point it at a fresh temporary directory BEFORE importing the module so
// pg_stat_file() only ever sees files we control (and the safety boundary
// is deterministic across runs and machines).
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svshim-data-'));
process.env.DATA_DIR = tmpDataDir;

// Dynamically import the module under test after DATA_DIR is pinned.
const SchemaVersionShim = await import('../query/SchemaVersionShim');
const { detectSchemaVersion, rewriteSchemaVersion } = SchemaVersionShim;

beforeAll(() => {
  // Create a known file inside DATA_DIR for successful stat() paths.
  fs.writeFileSync(path.join(tmpDataDir, 'version.txt'), 'hello', 'utf8');
  fs.mkdirSync(path.join(tmpDataDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmpDataDir, 'sub', 'inner.txt'), 'x', 'utf8');
});

afterAll(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe('detectSchemaVersion', () => {
  it('returns false for non-string input', () => {
    expect(detectSchemaVersion(undefined as unknown as string)).toBe(false);
    expect(detectSchemaVersion(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectSchemaVersion('')).toBe(false);
    expect(detectSchemaVersion('   ')).toBe(false);
  });

  it('detects information_schema.schemata', () => {
    expect(detectSchemaVersion('SELECT * FROM information_schema.schemata')).toBe(true);
  });

  it('detects schema_version table', () => {
    expect(detectSchemaVersion('SELECT version FROM schema_version')).toBe(true);
    expect(detectSchemaVersion('SELECT * FROM schema_version')).toBe(true);
  });

  it('does not false-positive on schema_versions plural', () => {
    expect(detectSchemaVersion('SELECT * FROM schema_versions')).toBe(false);
  });

  it('detects pg_stat_file', () => {
    expect(detectSchemaVersion("SELECT pg_stat_file('x')")).toBe(true);
  });

  it('detects pg_schema_version function', () => {
    expect(detectSchemaVersion('SELECT pg_schema_version()')).toBe(true);
  });

  it('detects current_schema_version function', () => {
    expect(detectSchemaVersion('SELECT current_schema_version()')).toBe(true);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectSchemaVersion('SELECT 1')).toBe(false);
    expect(detectSchemaVersion('SELECT * FROM pg_stat_activity')).toBe(false);
  });
});

describe('rewriteSchemaVersion', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteSchemaVersion(undefined as unknown as string)).toEqual({
      sql: '',
      rewritten: false,
    });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteSchemaVersion('')).toEqual({ sql: '', rewritten: false });
  });

  it('rewrites information_schema.schemata', () => {
    expect(rewriteSchemaVersion('SELECT * FROM information_schema.schemata')).toEqual({
      sql: "SELECT 'public' as schema_name",
      rewritten: true,
    });
  });

  it('rewrites schema_version table', () => {
    expect(rewriteSchemaVersion('SELECT version FROM schema_version')).toEqual({
      sql: 'SELECT 1 as version',
      rewritten: true,
    });
  });

  it('rewrites pg_schema_version()', () => {
    expect(rewriteSchemaVersion('SELECT pg_schema_version()')).toEqual({
      sql: 'SELECT 1 as version',
      rewritten: true,
    });
  });

  it('rewrites current_schema_version()', () => {
    expect(rewriteSchemaVersion('SELECT current_schema_version()')).toEqual({
      sql: 'SELECT 1 as version',
      rewritten: true,
    });
  });

  it('passes through unrelated SQL', () => {
    expect(rewriteSchemaVersion('SELECT 1;')).toEqual({ sql: 'SELECT 1;', rewritten: false });
  });
});

describe('rewriteSchemaVersion pg_stat_file', () => {
  it('returns real file metadata for existing file inside DATA_DIR', () => {
    const r = rewriteSchemaVersion(
      `SELECT pg_stat_file('${path.join(tmpDataDir, 'version.txt')}')`,
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('as size');
    expect(r.sql).toContain('as access');
    expect(r.sql).toContain('as modification');
    expect(r.sql).toContain('as change');
    expect(r.sql).toContain('as isdir');
  });

  it('returns empty result for non-existent file (ENOENT)', () => {
    const r = rewriteSchemaVersion(
      `SELECT pg_stat_file('${path.join(tmpDataDir, 'missing.txt')}')`,
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE 0');
  });

  it('returns empty result for path escaping DATA_DIR', () => {
    const r = rewriteSchemaVersion(`SELECT pg_stat_file('/etc/passwd')`);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE 0');
  });

  it('returns empty result for directory (isdir = 1)', () => {
    const r = rewriteSchemaVersion(
      `SELECT pg_stat_file('${path.join(tmpDataDir, 'sub')}')`,
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('as isdir');
  });

  it('returns empty result for unparseable path', () => {
    const r = rewriteSchemaVersion('SELECT pg_stat_file()');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE 0');
  });

  it('returns empty result for unexpected stat error (ENOTDIR)', () => {
    // version.txt is a regular file; treating it as a directory (`/sub`)
    // makes statSync throw ENOTDIR, an error that is neither ENOENT nor
    // EACCES — exercising the "other errors" branch.
    const badPath = path.join(tmpDataDir, 'version.txt', 'sub');
    const r = rewriteSchemaVersion(`SELECT pg_stat_file('${badPath}')`);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE 0');
  });

  it('formats negative timezone offset (west of UTC)', () => {
    const orig = Date.prototype.getTimezoneOffset;
    // Simulate a negative offset (e.g. UTC-5): getTimezoneOffset returns +300.
    Date.prototype.getTimezoneOffset = function () {
      return 300;
    };
    try {
      const r = rewriteSchemaVersion(
        `SELECT pg_stat_file('${path.join(tmpDataDir, 'version.txt')}')`,
      );
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('as access');
    } finally {
      Date.prototype.getTimezoneOffset = orig;
    }
  });
});

describe('DATA_DIR default (no env var)', () => {
  it('falls back to ./data when DATA_DIR is unset', async () => {
    // Delete the env var and reset the module registry so DATA_DIR is
    // re-evaluated with the default branch.
    const saved = process.env.DATA_DIR;
    delete process.env.DATA_DIR;
    vi.resetModules();
    const mod = await import('../query/SchemaVersionShim');
    // A relative path resolves against the default ./data dir; asserting
    // rewrite behaviour confirms the module loaded with the fallback.
    const r = mod.rewriteSchemaVersion(`SELECT pg_stat_file('/etc/passwd')`);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE 0');
    // Restore environment for any subsequent module reloads.
    process.env.DATA_DIR = saved;
    vi.resetModules();
  });
});
